import { DurableObject } from "cloudflare:workers";
import type { Env } from "../global.d";
import type { Credential } from "../user";
import { parseContent, serializeDocument } from "../application/persistence";
import { decodeStoredNoteContent, encodeNoteContentForStorage, noteStorageMode } from "../utils/crypto";
import {
  applyPatch,
  buildCommit,
  Conflict,
  InvalidCommit,
  parseCommit,
  type Commit,
  type CommitReceipt,
  type EditReceipt,
  type RoomRejection,
  type RoomResult,
  type RoomSnapshot,
} from "../application/syncOperations";
import { applyNoteEditRequest, requestedNodeIds, type NoteEditRequest } from "../application/noteEdits";
import { generateId, type IdSource } from "../domain/model";
import { CLOSE_RATE_LIMITED, acceptsSocket, fullBucket, readableMessage, receiptPruneBelow, takeToken, type Bucket } from "./limits";

/**
 * Who is asking. `credential` (a socket's, from when it connected) is re-checked
 * on every load, so signing out or deleting the token stops an open socket's
 * writes with no extra query.
 */
type Identity = { noteId: string; userId: string; credential?: Credential };
/** Credential tables by name: the only strings ever spliced into the SQL below. */
const CREDENTIAL_TABLE = { sessions: "sessions", api_tokens: "api_tokens" } as const satisfies Record<Credential["table"], string>;
type Row = { id: string; user_id: string; title: string; content: string; is_public: number; version: number; updated_at: string; deleted_at: string | null };
type Loaded = { row: Row; snapshot: RoomSnapshot };

const sha256 = async (value: unknown) =>
  Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(value))))).map(b => b.toString(16).padStart(2, "0")).join("");

/**
 * Ids for the nodes an edit makes. With an operation id they're derived from it, so
 * a retried request names the same nodes; without one they're random as usual.
 */
const idsFor = (operationId: string | undefined): IdSource => {
  if (!operationId) return generateId;
  let n = 0;
  return () => `op-${operationId}-${++n}`;
};

/** Close code for a socket whose note (or sign-in) is gone; the client stops reconnecting. */
const CLOSE_UNAVAILABLE = 4404;

const reject = (rejection: RoomRejection): { ok: false } & RoomRejection => ({ ok: false, ...rejection });

/** The wire boundary: a commit as sent, or why it can't be one. */
function validated(input: unknown): RoomResult<Commit> {
  try {
    return { ok: true, value: parseCommit(input) };
  } catch (e) {
    if (!(e instanceof InvalidCommit)) throw e;
    return reject(e.tooLarge ? { code: "too-large" } : { code: "invalid-commit", detail: e.message });
  }
}

/** The WebSocket client's wording (it shows the message as is). */
function rejectionMessage(r: RoomRejection): string {
  switch (r.code) {
    case "not-found": return "Note unavailable";
    case "decrypt-failed": return "Decryption failed";
    case "conflict": return r.detail;
    case "version-conflict": return "Version conflict; reload before replacing the note";
    case "invalid-commit": return r.detail;
    case "invalid-edit": return r.detail;
    case "too-large": return "Commit exceeds 1 MB";
    case "operation-reused": return "Operation ID reused with different content";
  }
}

/** One note per object. D1 is the durable source of truth (including receipts),
 * so private content keeps the existing encryption policy and public readers
 * see an acknowledged commit immediately. No eventually-consistent mirror.
 * Owner and trash checks live in `load`, so callers don't pre-check the row.
 * Expected refusals are returned as {@link RoomRejection}; only real failures throw. */
export class NoteRoom extends DurableObject<Env["Bindings"]> {
  private tail: Promise<unknown> = Promise.resolve();
  private ordered<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(fn);
    this.tail = result.catch(() => {});
    return result;
  }
  private async load(identity: Identity): Promise<RoomResult<Loaded>> {
    const base = "SELECT * FROM notes WHERE id = ? AND user_id = ? AND deleted_at IS NULL";
    const cred = identity.credential;
    const row = await (cred
      ? this.env.DB.prepare(`${base} AND EXISTS (SELECT 1 FROM ${CREDENTIAL_TABLE[cred.table]} WHERE id = ? AND expires_at > ?)`)
          .bind(identity.noteId, identity.userId, cred.id, Date.now())
      : this.env.DB.prepare(base).bind(identity.noteId, identity.userId)
    ).first<Row>();
    if (!row) return reject({ code: "not-found" });
    const content = await decodeStoredNoteContent(row.content, noteStorageMode(!!row.is_public), this.env.ENCRYPTION_KEY);
    if (content === null) return reject({ code: "decrypt-failed" });
    // Legacy text had no IDs. Stable IDs make the first snapshots identical
    // even across object eviction, before the first v2 write.
    let seq = 0;
    const model = parseContent(content, row.title, () => `legacy-${row.id}-${++seq}`);
    return { ok: true, value: { row, snapshot: { model, version: row.version, isPublic: !!row.is_public, updatedAt: row.updated_at } } };
  }
  snapshot(identity: Identity): Promise<RoomResult<RoomSnapshot>> {
    return this.ordered(async () => {
      const loaded = await this.load(identity);
      return loaded.ok ? { ok: true, value: loaded.value.snapshot } : loaded;
    });
  }
  commit(identity: Identity, input: unknown): Promise<RoomResult<CommitReceipt>> {
    return this.ordered(() => this.apply(identity, input));
  }
  private async apply(identity: Identity, input: unknown): Promise<RoomResult<CommitReceipt>> {
    const parsed = validated(input);
    if (!parsed.ok) return parsed;
    const commit = parsed.value;
    const loaded = await this.load(identity);
    if (!loaded.ok) return loaded;
    const digest = await sha256(commit);
    const seen = await this.receipt(loaded.value, commit.id, digest);
    if (seen) return seen;
    return this.persist(loaded.value, commit, digest);
  }
  /**
   * An agent's edit, applied to the note as it is now, in one turn: no other commit
   * can land between reading and writing, and the answer is the snapshot as committed.
   * `operationId` (optional) makes a retry safe: the same request under the same id
   * is applied once; the receipt's digest is of the request, not of the minted ids.
   */
  applyEdit(identity: Identity, input: { request: NoteEditRequest; operationId?: string }): Promise<RoomResult<EditReceipt>> {
    return this.ordered(async () => {
      const { request, operationId } = input;
      const loaded = await this.load(identity);
      if (!loaded.ok) return loaded;
      const { snapshot } = loaded.value;
      const digest = await sha256({ edit: request });
      if (operationId) {
        const seen = await this.receipt(loaded.value, operationId, digest);
        if (seen) return seen.ok ? { ok: true, value: { ...seen.value, nodeIds: requestedNodeIds(request, idsFor(operationId)) } } : seen;
      }
      const ids = idsFor(operationId);
      const edited = applyNoteEditRequest(snapshot.model, request, ids);
      if (!edited.ok) return reject({ code: "invalid-edit", detail: edited.error });
      const commit = buildCommit(operationId ?? crypto.randomUUID(), snapshot.model, edited.document);
      if (!commit) return { ok: true, value: { ...snapshot, ack: operationId ?? "", committedVersion: snapshot.version, nodeIds: edited.nodeIds } };
      const persisted = await this.persist(loaded.value, commit, digest);
      return persisted.ok ? { ok: true, value: { ...persisted.value, nodeIds: edited.nodeIds } } : persisted;
    });
  }
  /** A known operation id: its original receipt (same digest), a rejection (different), or null (new). */
  private async receipt({ row, snapshot }: Loaded, operationId: string, digest: string): Promise<RoomResult<CommitReceipt> | null> {
    const receipt = await this.env.DB.prepare("SELECT digest, version FROM note_commits WHERE note_id = ? AND operation_id = ?")
      .bind(row.id, operationId).first<{ digest: string; version: number }>();
    if (!receipt) return null;
    if (receipt.digest !== digest) return reject({ code: "operation-reused" });
    return { ok: true, value: { ...snapshot, ack: operationId, committedVersion: receipt.version } };
  }
  /** Merge, encrypt and store the commit with its receipt, then tell every open editor. */
  private async persist({ row, snapshot }: Loaded, commit: Commit, digest: string): Promise<RoomResult<CommitReceipt>> {
    let model;
    try {
      model = applyPatch(snapshot.model, commit.patch);
    } catch (e) {
      if (!(e instanceof Conflict)) throw e;
      return reject({ code: "conflict", detail: e.message });
    }
    if (commit.publicity && commit.publicity.before !== snapshot.isPublic) {
      return reject({ code: "conflict", detail: "Concurrent change: publicity. Read the latest note and retry." });
    }
    const isPublic = commit.publicity?.after ?? snapshot.isPublic;
    const content = await encodeNoteContentForStorage(serializeDocument(model), noteStorageMode(isPublic), this.env.ENCRYPTION_KEY);
    const version = row.version + 1;
    // One timestamp: what's stored is what the receipt reports.
    const updatedAt = new Date().toISOString();
    // The receipt and content change commit atomically. The predicate also
    // handles trash/delete racing an already authenticated open socket.
    const pruneBelow = receiptPruneBelow(version);
    const result = await this.env.DB.batch([
      this.env.DB.prepare("INSERT INTO note_commits (note_id, operation_id, digest, version) SELECT id, ?, ?, ? FROM notes WHERE id = ? AND version = ? AND deleted_at IS NULL")
        .bind(commit.id, digest, version, row.id, row.version),
      this.env.DB.prepare("UPDATE notes SET title = ?, content = ?, is_public = ?, version = ?, updated_at = ? WHERE id = ? AND version = ? AND deleted_at IS NULL")
        .bind(model.title, content, isPublic ? 1 : 0, version, updatedAt, row.id, row.version),
      // Receipts only dedupe resends, which come within a few versions (limits.ts).
      ...(pruneBelow === null ? [] : [this.env.DB.prepare("DELETE FROM note_commits WHERE note_id = ? AND version <= ?").bind(row.id, pruneBelow)]),
    ]);
    if (result[1].meta.changes !== 1) {
      return reject({ code: "conflict", detail: "The note changed or was deleted during the commit. Read the latest note and retry." });
    }
    const next: CommitReceipt = { model, version, isPublic, updatedAt, ack: commit.id, committedVersion: version };
    this.broadcast({ type: "state", ...next });
    return { ok: true, value: next };
  }
  /** Legacy full-document API must supply a version. Never blind overwrite. */
  replace(identity: Identity, body: { title?: string; content?: string; isPublic?: boolean; version?: number }): Promise<RoomResult<CommitReceipt>> {
    return this.ordered(async () => {
      const loaded = await this.load(identity);
      if (!loaded.ok) return loaded;
      const { snapshot } = loaded.value;
      if (body.version !== snapshot.version) return reject({ code: "version-conflict" });
      const model = body.content === undefined ? { ...snapshot.model, title: body.title ?? snapshot.model.title } : parseContent(body.content, body.title ?? snapshot.model.title);
      const id = crypto.randomUUID();
      const commit = buildCommit(id, snapshot.model, model, body.isPublic === undefined ? undefined : { before: snapshot.isPublic, after: body.isPublic });
      // Nothing to change: answer with the current state, version untouched.
      if (!commit) return { ok: true, value: { ...snapshot, ack: id, committedVersion: snapshot.version } };
      // Same wire validation as a socket commit, without reading the row again.
      const parsed = validated(commit);
      if (!parsed.ok) return parsed;
      return this.persist(loaded.value, parsed.value, await sha256(parsed.value));
    });
  }
  async fetch(request: Request) {
    const identity: Identity = JSON.parse(request.headers.get("X-Note-Identity")!);
    // Checked before the D1 read: a reconnect loop shouldn't cost a query each time.
    if (!acceptsSocket(this.ctx.getWebSockets().length)) return new Response("Too many connections", { status: 429 });
    return this.ordered(async () => {
      const loaded = await this.load(identity);
      if (!loaded.ok) return new Response(rejectionMessage(loaded), { status: loaded.code === "not-found" ? 404 : 500 });
      const { 0: client, 1: server } = new WebSocketPair();
      this.ctx.acceptWebSocket(server);
      server.serializeAttachment(identity);
      server.send(JSON.stringify({ type: "state", ...loaded.value.snapshot }));
      return new Response(null, { status: 101, webSocket: client });
    });
  }
  /** Socket commits, shared by every connection to this note (limits.ts). In memory: hibernation only follows idle time, by which it has refilled. */
  private bucket: Bucket = fullBucket(Date.now());
  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer) {
    const taken = takeToken(this.bucket, Date.now());
    this.bucket = taken.bucket;
    // Dropped, not rejected: the client keeps the commit and resends it after reconnecting.
    if (!taken.ok) return ws.close(CLOSE_RATE_LIMITED, "Too many commits; reconnecting");
    let id: string | undefined;
    try {
      if (!readableMessage(raw)) return ws.send(JSON.stringify({ type: "error", message: "Invalid message size" }));
      const input = JSON.parse(raw);
      id = typeof input.id === "string" ? input.id : undefined;
      const result = await this.commit(ws.deserializeAttachment() as Identity, input);
      // Note trashed or gone, or the socket's sign-in revoked: same as invalidate().
      if (!result.ok && result.code === "not-found") return ws.close(CLOSE_UNAVAILABLE, "Note unavailable; reconnect");
      // Also send duplicate receipts, which intentionally don't broadcast.
      ws.send(JSON.stringify(result.ok ? { type: "state", ...result.value } : { type: "error", id, message: rejectionMessage(result) }));
    } catch (error) {
      // Bad JSON is the client's; anything else (D1, ...) stays in the log, not on the wire.
      if (!(error instanceof SyntaxError)) console.error("NoteRoom commit failed", error);
      const message = error instanceof SyntaxError ? "Invalid JSON" : "Internal error";
      try { ws.send(JSON.stringify({ type: "error", id, message })); } catch { /* disconnected */ }
    }
  }
  async invalidate() {
    for (const ws of this.ctx.getWebSockets()) ws.close(CLOSE_UNAVAILABLE, "Note unavailable; reconnect");
  }
  private broadcast(message: unknown) {
    const raw = JSON.stringify(message);
    for (const ws of this.ctx.getWebSockets()) {
      try { ws.send(raw); } catch { /* disconnected */ }
    }
  }
}
