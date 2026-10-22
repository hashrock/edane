import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NoteSyncClient, RECONNECT } from "./noteSyncClient";
import { parseContent } from "../application/persistence";

/** 開いたソケットを覚えておき、テストから閉じたり受信させたりする WebSocket の代役。 */
class FakeSocket {
  static OPEN = 1;
  static all: FakeSocket[] = [];
  readyState = FakeSocket.OPEN;
  sent: string[] = [];
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: ((e: { code: number }) => void) | null = null;
  constructor(public url: string) {
    FakeSocket.all.push(this);
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {}
  serverClose(code = 1006) {
    this.readyState = 3;
    this.onclose?.({ code });
  }
  deliver(message: unknown) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
}

const model = parseContent("a\n  b", "t");
const state = { type: "state", model, version: 1, isPublic: false };

beforeEach(() => {
  vi.useFakeTimers();
  FakeSocket.all = [];
  vi.stubGlobal("WebSocket", FakeSocket);
  vi.stubGlobal("location", { href: "http://localhost/notes/n1/edit" });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const latest = () => FakeSocket.all[FakeSocket.all.length - 1];

describe("NoteSyncClient reconnect", () => {
  it("backs off exponentially up to the cap while connections close at once, even after a state message", () => {
    const client = new NoteSyncClient("/api/notes/n1/sync", () => {}, () => {});
    client.connect();
    const delays: number[] = [];
    for (let i = 0; i < 10; i++) {
      // サーバーが受け付けて state を送り、すぐ閉じる（レート制限・再起動ループ）。
      latest().deliver(state);
      latest().serverClose(4429);
      const before = FakeSocket.all.length;
      let waited = 0;
      while (FakeSocket.all.length === before) {
        vi.advanceTimersByTime(100);
        waited += 100;
      }
      delays.push(waited);
    }
    expect(delays.slice(0, 7)).toEqual([500, 1000, 2000, 4000, 8000, 16000, 30000]);
    expect(Math.max(...delays)).toBe(RECONNECT.maxMs);
  });

  it("starts over at the first delay after a connection that stayed up", () => {
    const client = new NoteSyncClient("/api/notes/n1/sync", () => {}, () => {});
    client.connect();
    latest().serverClose();
    vi.advanceTimersByTime(500);
    latest().serverClose();
    vi.advanceTimersByTime(1000);
    expect(FakeSocket.all).toHaveLength(3);
    vi.advanceTimersByTime(RECONNECT.healthyMs);
    latest().serverClose();
    vi.advanceTimersByTime(RECONNECT.firstMs);
    expect(FakeSocket.all).toHaveLength(4);
  });

  it("stops reconnecting when the note became unavailable", () => {
    const errors: string[] = [];
    const client = new NoteSyncClient("/api/notes/n1/sync", () => {}, (m) => errors.push(m));
    client.connect();
    latest().serverClose(4404);
    vi.advanceTimersByTime(10 * RECONNECT.maxMs);
    expect(FakeSocket.all).toHaveLength(1);
    expect(errors).toHaveLength(1);
  });
});

describe("NoteSyncClient errors", () => {
  it("drops the in-flight commit on an error without an id instead of resending it forever", () => {
    const rejected: unknown[] = [];
    const client = new NoteSyncClient("/api/notes/n1/sync", () => {}, (_m, commit) => commit && rejected.push(commit));
    client.connect();
    latest().deliver(state);
    const after = { ...model, roots: [{ ...model.roots[0], text: "changed" }] };
    void client.commit(model, after);
    expect(latest().sent).toHaveLength(1);
    // 読めなかったメッセージへの返事（NoteRoom は id を取り出せない）。
    latest().deliver({ type: "error", message: "Invalid message size" });
    expect(rejected).toHaveLength(1);
    expect(client.isDirty()).toBe(false);
    expect(latest().sent).toHaveLength(1);
  });
});
