import { DurableObject } from "cloudflare:workers";
import type { Env } from "../global.d";
import { parseContent, serializeDocument } from "../application/persistence";
import { decodeStoredNoteContent, encodeNoteContentForStorage, noteStorageMode } from "../utils/crypto";
import { applyPatch, diffDocument, parseCommit, type Snapshot } from "../application/syncOperations";

type Identity = { noteId: string; userId: string };
type Row = { id: string; user_id: string; title: string; content: string; is_public: number; version: number; deleted_at: string | null };

/** One note per object. D1 is the durable source of truth (including receipts),
 * so private content keeps the existing encryption policy and public readers
 * see an acknowledged commit immediately. No eventually-consistent mirror. */
export class NoteRoom extends DurableObject<Env["Bindings"]> {
  private tail: Promise<unknown> = Promise.resolve();
  private ordered<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(fn);
    this.tail = result.catch(() => {});
    return result;
  }
  private async load(identity: Identity): Promise<{ row: Row; snapshot: Snapshot }> {
    const row = await this.env.DB.prepare("SELECT * FROM notes WHERE id = ? AND user_id = ? AND deleted_at IS NULL")
      .bind(identity.noteId, identity.userId).first<Row>();
    if (!row) throw new Error("Note unavailable");
    const content = await decodeStoredNoteContent(row.content, noteStorageMode(!!row.is_public), this.env.ENCRYPTION_KEY);
    if (content === null) throw new Error("Decryption failed");
    // Legacy text had no IDs. Stable IDs make the first snapshots identical
    // even across object eviction, before the first v2 write.
    let seq = 0;
    const model = parseContent(content, row.title, () => `legacy-${row.id}-${++seq}`);
    return { row, snapshot: { model, version: row.version, isPublic: !!row.is_public } };
  }
  snapshot(identity: Identity) { return this.ordered(async () => (await this.load(identity)).snapshot); }
  commit(identity: Identity, input: unknown) {
    return this.ordered(() => this.apply(identity, input));
  }
  private async apply(identity: Identity, input: unknown) {
    const commit = parseCommit(input);
    const { row, snapshot } = await this.load(identity);
    const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(commit))))).map(b => b.toString(16).padStart(2, "0")).join("");
    const receipt = await this.env.DB.prepare("SELECT digest, version FROM note_commits WHERE note_id = ? AND operation_id = ?")
      .bind(row.id, commit.id).first<{ digest: string; version: number }>();
    if (receipt) {
      if (receipt.digest !== digest) throw new Error("Operation ID reused with different content");
      return { ...snapshot, ack: commit.id, committedVersion: receipt.version };
    }
    const model = applyPatch(snapshot.model, commit.patch);
    if (commit.publicity && commit.publicity.before !== snapshot.isPublic) throw new Error("Concurrent change: publicity");
    const isPublic = commit.publicity?.after ?? snapshot.isPublic;
    const content = await encodeNoteContentForStorage(serializeDocument(model), noteStorageMode(isPublic), this.env.ENCRYPTION_KEY);
    const version = row.version + 1;
    // The receipt and content change commit atomically. The predicate also
    // handles trash/delete racing an already authenticated open socket.
    const result = await this.env.DB.batch([
      this.env.DB.prepare("INSERT INTO note_commits (note_id, operation_id, digest, version) SELECT id, ?, ?, ? FROM notes WHERE id = ? AND version = ? AND deleted_at IS NULL")
        .bind(commit.id, digest, version, row.id, row.version),
      this.env.DB.prepare("UPDATE notes SET title = ?, content = ?, is_public = ?, version = ?, updated_at = ? WHERE id = ? AND version = ? AND deleted_at IS NULL")
        .bind(model.title, content, isPublic ? 1 : 0, version, new Date().toISOString(), row.id, row.version),
    ]);
    if (result[1].meta.changes !== 1) throw new Error("Note changed or was deleted; reconnect");
    const next = { model, version, isPublic, ack: commit.id, committedVersion: version };
    this.broadcast({ type: "state", ...next });
    return next;
  }
  /** Legacy full-document API must supply a version. Never blind overwrite. */
  replace(identity: Identity, body: { title?: string; content?: string; isPublic?: boolean; version?: number }) {
    return this.ordered(async () => {
      const { snapshot } = await this.load(identity);
      if (body.version !== snapshot.version) throw new Error("Version conflict; reload before replacing the note");
      const model = body.content === undefined ? { ...snapshot.model, title: body.title ?? snapshot.model.title } : parseContent(body.content, body.title ?? snapshot.model.title);
      return this.apply(identity, { id: crypto.randomUUID(), patch: diffDocument(snapshot.model, model), ...(body.isPublic !== undefined && { publicity: { before: snapshot.isPublic, after: body.isPublic } }) });
    });
  }
  async fetch(request: Request) {
    const identity: Identity = JSON.parse(request.headers.get("X-Note-Identity")!);
    return this.ordered(async () => {
      const { snapshot } = await this.load(identity);
      const { 0: client, 1: server } = new WebSocketPair();
      this.ctx.acceptWebSocket(server);
      server.serializeAttachment(identity);
      server.send(JSON.stringify({ type: "state", ...snapshot }));
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
      ws.send(JSON.stringify({ type: "state", ...result }));
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
