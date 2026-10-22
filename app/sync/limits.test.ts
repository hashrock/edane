import { describe, expect, it } from "vitest";
import { COMMIT_BUCKET, MAX_MESSAGE_CHARS, MAX_SOCKETS_PER_NOTE, acceptsSocket, readableMessage, RECEIPTS_KEPT, RECEIPT_PRUNE_EVERY, fullBucket, receiptPruneBelow, takeToken, type Bucket } from "./limits";

/** `count` 件を `intervalMs` おきに取り、断られた件数を返す。 */
function drive(count: number, intervalMs: number, start: Bucket = fullBucket(0)) {
  let bucket = start;
  let refused = 0;
  for (let i = 0; i < count; i++) {
    const r = takeToken(bucket, start.at + i * intervalMs);
    bucket = r.bucket;
    if (!r.ok) refused++;
  }
  return { refused, bucket };
}

describe("commit bucket", () => {
  it("passes normal editing: one commit per 30 ms round trip for a minute (key held down)", () => {
    expect(drive(2000, 30).refused).toBe(0);
  });

  it("passes a reconnect flush of the whole capacity at once", () => {
    expect(drive(COMMIT_BUCKET.capacity, 0).refused).toBe(0);
  });

  it("refuses a runaway loop past the capacity, and keeps refusing while it continues", () => {
    expect(drive(COMMIT_BUCKET.capacity + 1, 0).refused).toBe(1);
    // 1 ms おきの暴走 10 秒: 容量 + 補充（50 件/秒）を超えては通らない。
    const { refused } = drive(10_000, 1);
    expect(10_000 - refused).toBeLessThanOrEqual(COMMIT_BUCKET.capacity + 10 * COMMIT_BUCKET.refillPerSecond + 1);
  });

  it("refills after a pause, up to the capacity", () => {
    const { bucket } = drive(COMMIT_BUCKET.capacity + 5, 0);
    expect(takeToken(bucket, 0).ok).toBe(false);
    expect(takeToken(bucket, 1000 / COMMIT_BUCKET.refillPerSecond).ok).toBe(true);
    expect(takeToken(bucket, 3_600_000).bucket.tokens).toBe(COMMIT_BUCKET.capacity - 1);
  });
});

describe("receiptPruneBelow", () => {
  it("prunes only on every RECEIPT_PRUNE_EVERY-th version past RECEIPTS_KEPT", () => {
    expect(receiptPruneBelow(1)).toBeNull();
    expect(receiptPruneBelow(RECEIPTS_KEPT)).toBeNull();
    expect(receiptPruneBelow(RECEIPTS_KEPT + 1)).toBeNull();
    const v = RECEIPTS_KEPT + RECEIPT_PRUNE_EVERY;
    expect(receiptPruneBelow(v)).toBe(v - RECEIPTS_KEPT);
  });

  it("never removes a receipt within RECEIPTS_KEPT versions of the one being written", () => {
    for (let v = 1; v < 5000; v++) {
      const below = receiptPruneBelow(v);
      if (below !== null) expect(v - below).toBe(RECEIPTS_KEPT);
    }
  });
});

describe("connections per note", () => {
  it("accepts up to MAX_SOCKETS_PER_NOTE and refuses the next", () => {
    expect(acceptsSocket(0)).toBe(true);
    expect(acceptsSocket(MAX_SOCKETS_PER_NOTE - 1)).toBe(true);
    expect(acceptsSocket(MAX_SOCKETS_PER_NOTE)).toBe(false);
  });
});

describe("message size", () => {
  it("reads text up to the commit limit, and refuses binary or larger text", () => {
    expect(readableMessage("x".repeat(MAX_MESSAGE_CHARS))).toBe(true);
    expect(readableMessage("x".repeat(MAX_MESSAGE_CHARS + 1))).toBe(false);
    expect(readableMessage(new ArrayBuffer(4))).toBe(false);
  });
});
