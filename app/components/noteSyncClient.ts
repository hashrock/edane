import { applyPatch, buildCommit, type Commit, type Snapshot } from "../application/syncOperations";
import type { MindMapDocument } from "../domain/model";

type Pending = { commit: Commit; resolve: () => void; reject: (e: Error) => void; done: Promise<void> };

/**
 * Reconnect backoff. It doubles from the first delay up to the cap, and starts over only
 * after a connection that stayed up for `healthyMs`: a server that accepts and then closes
 * at once (rate limit, deploy restart loop) mustn't turn into a reconnect every 500 ms.
 * No attempt limit: unconfirmed commits live only in this page, so giving up would lose
 * them. The cap bounds an open tab on a note gone elsewhere to 2 tries a minute.
 */
export const RECONNECT = { firstMs: 500, maxMs: 30_000, healthyMs: 30_000 } as const;
/** NoteRoom.invalidate: the note was trashed or deleted. Reconnecting can't succeed. */
const CLOSE_NOTE_UNAVAILABLE = 4404;

export class NoteSyncClient {
  snapshot: Snapshot | null = null;
  private pending: Pending[] = [];
  private socket: WebSocket | null = null;
  private sent: string | null = null;
  private stopped = false;
  private timer?: ReturnType<typeof setTimeout>;
  private retry: number = RECONNECT.firstMs;
  private ready = false;
  constructor(private path: string, private onState: (s: Snapshot) => void, private onError: (message: string, commit?: Commit) => void) {}
  connect() {
    this.stopped = false;
    this.open();
    return () => { this.stopped = true; clearTimeout(this.timer); this.socket?.close(); this.pending.forEach(p => p.reject(new Error("Editor closed"))); };
  }
  private open() {
    if (this.stopped) return;
    const socket = new WebSocket(new URL(this.path, location.href).href.replace(/^http/, "ws"));
    const openedAt = Date.now();
    this.socket = socket;
    this.ready = false;
    socket.onmessage = event => this.receive(JSON.parse(event.data));
    socket.onclose = event => {
      this.ready = false;
      this.sent = null;
      if (this.stopped) return;
      if (event.code === CLOSE_NOTE_UNAVAILABLE) {
        this.onError("このノートは開けなくなりました（ゴミ箱に移動または削除）。再読み込みしてください。");
        return;
      }
      this.onError("接続が切れました。未確認の操作を保持して再接続します。");
      if (Date.now() - openedAt >= RECONNECT.healthyMs) this.retry = RECONNECT.firstMs;
      this.timer = setTimeout(() => this.open(), this.retry);
      this.retry = Math.min(this.retry * 2, RECONNECT.maxMs);
    };
  }
  // Kept independent of the transport for deterministic multi-client tests.
  receive(message: Snapshot & { type: string; ack?: string; id?: string; message?: string }) {
    if (message.type === "error") {
      // An error without an id (unreadable message) is about the one commit in flight;
      // left pending it would be resent at once, forever.
      const id = message.id ?? this.sent;
      const p = this.pending.find(p => p.commit.id === id);
      if (p) {
        this.pending = this.pending.filter(x => x !== p);
        p.reject(new Error(message.message));
        this.onError(message.message ?? "Commit rejected", p.commit);
      }
      this.sent = null;
      this.rebuild(true);
      this.send();
      return;
    }
    if (message.type !== "state") return;
    if (this.snapshot && message.version < this.snapshot.version) return;
    this.snapshot = { model: message.model, version: message.version, isPublic: message.isPublic };
    const acknowledged = this.pending.find(p => p.commit.id === message.ack);
    if (acknowledged) {
      this.pending = this.pending.filter(p => p !== acknowledged);
      this.sent = null;
      acknowledged.resolve();
    }
    this.ready = true;
    // Reconnect can contain an applied operation whose ack was lost. Keep
    // the exact operation until its persisted receipt is obtained by resend.
    this.rebuild(false);
    this.send();
  }
  private rebuild(dropInvalid: boolean) {
    if (!this.snapshot) return;
    let model = this.snapshot.model;
    let isPublic = this.snapshot.isPublic;
    this.pending = this.pending.filter(p => {
      try {
        model = applyPatch(model, p.commit.patch);
        if (p.commit.publicity) isPublic = p.commit.publicity.after;
        return true;
      } catch (error) {
        if (!dropInvalid) return true;
        p.reject(error as Error);
        this.onError((error as Error).message, p.commit);
        return false;
      }
    });
    this.onState({ ...this.snapshot, model, isPublic });
  }
  private send() {
    if (!this.ready || this.sent || !this.pending.length || this.socket?.readyState !== WebSocket.OPEN) return;
    this.sent = this.pending[0].commit.id;
    this.socket.send(JSON.stringify(this.pending[0].commit));
  }
  commit(before: MindMapDocument, after: MindMapDocument, publicity?: Commit["publicity"]): Promise<void> {
    const commit = buildCommit(crypto.randomUUID(), before, after, publicity);
    if (!commit) return Promise.resolve();
    let resolve!: () => void, reject!: (e: Error) => void;
    const done = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
    done.catch(() => {});
    this.pending.push({ commit, resolve, reject, done });
    this.send();
    return done;
  }
  isDirty() { return this.pending.length > 0; }
  async flush(timeout = 10000) {
    const work = Promise.all(this.pending.map(p => p.done));
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Waiting for server confirmation")), timeout); })]); }
    finally { clearTimeout(timer); }
  }
}
