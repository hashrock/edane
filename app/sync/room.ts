import { DurableObject } from "cloudflare:workers";
import type { Env } from "../global.d";
import { parseContent, serializeDocument } from "../application/persistence";
import { decodeStoredNoteContent, encodeNoteContentForStorage, noteStorageMode } from "../utils/crypto";
import {
  applyPatch,
  Conflict,
  diffDocument,
  InvalidCommit,
  parseCommit,
  type CommitReceipt,
  type RoomRejection,
  type RoomResult,
  type RoomSnapshot,
} from "../application/syncOperations";

type Identity = { noteId: string; userId: string };
type Row = { id: string; user_id: string; title: string; content: string; is_public: number; version: number; updated_at: string; deleted_at: string | null };
type Loaded = { row: Row; snapshot: RoomSnapshot };

const reject = (rejection: RoomRejection): { ok: false } & RoomRejection => ({ ok: false, ...rejection });

/** The WebSocket client's wording (it shows the message as is). */
function rejectionMessage(r: RoomRejection): string {
  switch (r.code) {
    case "not-found": return "Note unavailable";
    case "decrypt-failed": return "Decryption failed";
    case "conflict": return r.detail;
    case "version-conflict": return "Version conflict; reload before replacing the note";
    case "invalid-commit": return r.detail;
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
    const row = await this.env.DB.prepare("SELECT * FROM notes WHERE id = ? AND user_id = ? AND deleted_at IS NULL")
      .bind(identity.noteId, identity.userId).first<Row>();
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
    let commit;
    try {
      commit = parseCommit(input);
    } catch (e) {
      if (!(e instanceof InvalidCommit)) throw e;
      return reject(e.tooLarge ? { code: "too-large" } : { code: "invalid-commit", detail: e.message });
    }
    const loaded = await this.load(identity);
    if (!loaded.ok) return loaded;
    const { row, snapshot } = loaded.value;
    const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(commit))))).map(b => b.toString(16).padStart(2, "0")).join("");
    const receipt = await this.env.DB.prepare("SELECT digest, version FROM note_commits WHERE note_id = ? AND operation_id = ?")
      .bind(row.id, commit.id).first<{ digest: string; version: number }>();
    if (receipt) {
      if (receipt.digest !== digest) return reject({ code: "operation-reused" });
      return { ok: true, value: { ...snapshot, ack: commit.id, committedVersion: receipt.version } };
    }
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
    const result = await this.env.DB.batch([
      this.env.DB.prepare("INSERT INTO note_commits (note_id, operation_id, digest, version) SELECT id, ?, ?, ? FROM notes WHERE id = ? AND version = ? AND deleted_at IS NULL")
        .bind(commit.id, digest, version, row.id, row.version),
      this.env.DB.prepare("UPDATE notes SET title = ?, content = ?, is_public = ?, version = ?, updated_at = ? WHERE id = ? AND version = ? AND deleted_at IS NULL")
        .bind(model.title, content, isPublic ? 1 : 0, version, updatedAt, row.id, row.version),
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
      return this.apply(identity, { id: crypto.randomUUID(), patch: diffDocument(snapshot.model, model), ...(body.isPublic !== undefined && { publicity: { before: snapshot.isPublic, after: body.isPublic } }) });
    });
  }
  async fetch(request: Request) {
    const identity: Identity = JSON.parse(request.headers.get("X-Note-Identity")!);
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
  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer) {
    let id: string | undefined;
    try {
      if (typeof raw !== "string" || raw.length > 1_000_000) throw new Error("Invalid message size");
      const input = JSON.parse(raw);
      id = typeof input.id === "string" ? input.id : undefined;
      const result = await this.commit(ws.deserializeAttachment() as Identity, input);
      // Also send duplicate receipts, which intentionally don't broadcast.
      ws.send(JSON.stringify(result.ok ? { type: "state", ...result.value } : { type: "error", id, message: rejectionMessage(result) }));
    } catch (error) {
      try { ws.send(JSON.stringify({ type: "error", id, message: (error as Error).message })); } catch { /* disconnected */ }
    }
  }
  async invalidate() {
    for (const ws of this.ctx.getWebSockets()) ws.close(4404, "Note unavailable; reconnect");
  }
  private broadcast(message: unknown) {
    const raw = JSON.stringify(message);
    for (const ws of this.ctx.getWebSockets()) {
      try { ws.send(raw); } catch { /* disconnected */ }
    }
  }
}
