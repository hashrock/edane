import { applyPatch, diffDocument, hasChanges, type Commit, type Snapshot } from "../application/syncOperations";
import type { MindMapDocument } from "../domain/model";

type Pending = { commit: Commit; resolve: () => void; reject: (e: Error) => void; done: Promise<void> };
export class NoteSyncClient {
  snapshot: Snapshot | null = null;
  private pending: Pending[] = [];
  private socket: WebSocket | null = null;
  private sent: string | null = null;
  private stopped = false;
  private timer?: ReturnType<typeof setTimeout>;
  private retry = 500;
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
    this.socket = socket;
    this.ready = false;
    socket.onmessage = event => this.receive(JSON.parse(event.data));
    socket.onclose = () => {
      this.ready = false;
      this.sent = null;
      if (this.stopped) return;
      this.onError("接続が切れました。未確認の操作を保持して再接続します。");
      this.timer = setTimeout(() => this.open(), this.retry);
      this.retry = Math.min(this.retry * 2, 10000);
    };
  }
  // Kept independent of the transport for deterministic multi-client tests.
  receive(message: Snapshot & { type: string; ack?: string; id?: string; message?: string }) {
    if (message.type === "error") {
      const p = this.pending.find(p => p.commit.id === message.id);
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
    this.retry = 500;
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
    const patch = diffDocument(before, after);
    if (!hasChanges(patch) && !publicity) return Promise.resolve();
    let resolve!: () => void, reject!: (e: Error) => void;
    const done = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
    done.catch(() => {});
    this.pending.push({ commit: { id: crypto.randomUUID(), patch, ...(publicity && { publicity }) }, resolve, reject, done });
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
