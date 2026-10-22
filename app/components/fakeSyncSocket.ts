/**
 * ブラウザe2e用の同期サーバー（/api/notes/:id/sync）の代役。
 *
 * noteId 付きのエディタは初回の state を受けるまで閲覧専用なので、WebSocket を
 * 差し替えて、接続したら初期ドキュメントを送り、届いた commit を適用して ack を
 * 返す（app/sync/room.ts と同じ応答の形）。戻り値で元の WebSocket に戻す。
 */
import { applyPatch, parseCommit, type Snapshot } from "../application/syncOperations";
import { parseContent } from "../application/persistence";

export function stubSyncSocket(init: {
  content: string;
  title: string;
  isPublic: boolean;
}): () => void {
  let snapshot: Snapshot = {
    model: parseContent(init.content, init.title),
    version: 1,
    isPublic: init.isPublic,
  };
  const Real = window.WebSocket;

  class FakeSocket extends EventTarget {
    readyState: number = Real.CONNECTING;
    onmessage: ((e: MessageEvent) => void) | null = null;
    onclose: ((e: CloseEvent) => void) | null = null;
    constructor(public url: string) {
      super();
      setTimeout(() => {
        if (this.readyState !== Real.CONNECTING) return;
        this.readyState = Real.OPEN;
        this.deliver({ type: "state", ...snapshot });
      });
    }
    send(data: string) {
      const commit = parseCommit(JSON.parse(data));
      snapshot = {
        model: applyPatch(snapshot.model, commit.patch),
        version: snapshot.version + 1,
        isPublic: commit.publicity?.after ?? snapshot.isPublic,
      };
      setTimeout(() => this.deliver({ type: "state", ...snapshot, ack: commit.id }));
    }
    close() {
      if (this.readyState === Real.CLOSED) return;
      this.readyState = Real.CLOSED;
      this.onclose?.(new CloseEvent("close"));
    }
    private deliver(message: unknown) {
      if (this.readyState !== Real.OPEN) return;
      this.onmessage?.(new MessageEvent("message", { data: JSON.stringify(message) }));
    }
  }

  window.WebSocket = Object.assign(FakeSocket, {
    CONNECTING: Real.CONNECTING,
    OPEN: Real.OPEN,
    CLOSING: Real.CLOSING,
    CLOSED: Real.CLOSED,
  }) as unknown as typeof WebSocket;
  return () => {
    window.WebSocket = Real;
  };
}
