/**
 * NoteRoom の暴走止め（課金の上限）。値の根拠は各定数のコメント。純粋な関数だけを置き、
 * room.ts（cloudflare:workers を読むので node で動かせない）はこれを呼ぶだけにする。
 */

/**
 * 1 ノートに同時に開ける WebSocket。ノートは所有者 1 人のものなので、つなぐのはその人の
 * タブとデバイスだけ。普段は数本で、32 は「タブを開きっぱなしにしがち」でも届かない余裕。
 * これを超えるのは接続を閉じずに作り直すループで、commit ごとの配信（接続数 × 1 通）が
 * 際限なく増えるのを止める。
 */
export const MAX_SOCKETS_PER_NOTE = 32;

/** もう 1 本受け付けてよいか（`open` = いま開いている数）。 */
export const acceptsSocket = (open: number) => open < MAX_SOCKETS_PER_NOTE;

/** WebSocket 1 通の上限（文字数）。commit の上限（parseCommit の 1 MB）と揃える。 */
export const MAX_MESSAGE_CHARS = 1_000_000;

/** commit として読む前に断るメッセージか（バイナリか大きすぎる）。 */
export const readableMessage = (raw: string | ArrayBuffer): raw is string => typeof raw === "string" && raw.length <= MAX_MESSAGE_CHARS;

/**
 * ノートごとの WebSocket commit のトークンバケット（全接続で共有）。commit 1 件 = D1 の
 * 書き込み 2 行 + 全接続への配信なので、ここが書き込み課金の蛇口になる。
 *
 * クライアント（NoteSyncClient）は ack を待って 1 件ずつ送るので、1 タブの送信は往復時間で
 * 決まる（数十 ms → 高々 20〜50 件/秒）。キーの押しっぱなし（30 件/秒前後）や再接続後の
 * 未確認操作の一括再送でも、容量 300 件が 6 秒分以上を吸収し、補充 50 件/秒は人の編集を
 * 複数タブ分足しても届かない。超えたら接続を 4429 で閉じる（未確認操作はクライアントに
 * 残り、再接続後に同じ id で再送されるので失われない）。バケットは DO のメモリにあり、
 * hibernation で消えるが、hibernation は 10 秒ほど無通信のあとなので、そのころには満タンに
 * 戻っている（容量 / 補充 = 6 秒）。
 */
export const COMMIT_BUCKET = { capacity: 300, refillPerSecond: 50 } as const;

export type Bucket = { tokens: number; at: number };

export const fullBucket = (now: number): Bucket => ({ tokens: COMMIT_BUCKET.capacity, at: now });

/** 1 件取れるか。取れなければ ok: false（バケットは補充だけ進める）。 */
export function takeToken(bucket: Bucket, now: number): { ok: boolean; bucket: Bucket } {
  const elapsed = Math.max(0, now - bucket.at) / 1000;
  const tokens = Math.min(COMMIT_BUCKET.capacity, bucket.tokens + elapsed * COMMIT_BUCKET.refillPerSecond);
  return tokens >= 1 ? { ok: true, bucket: { tokens: tokens - 1, at: now } } : { ok: false, bucket: { tokens, at: now } };
}

/** 超過で閉じるときのコード（4000〜4999 はアプリ用）。クライアントは通常のバックオフで再接続する。 */
export const CLOSE_RATE_LIMITED = 4429;

/**
 * 受領記録（note_commits）を残す版数。受領記録は「ack が届かなかった操作の再送」と MCP の
 * operationId の再試行を 1 回にまとめるためのもので、再送はふつう数版以内に来る。1000 版より
 * 古い id の再送は受領記録なしの新しい commit として扱われる（古い値からの変更なので、多くは
 * 競合として拒否され、画面の復元欄に残る）。
 */
export const RECEIPTS_KEPT = 1000;
/** 掃除は 100 版ごとに 1 回（毎回 DELETE を足さない）。 */
export const RECEIPT_PRUNE_EVERY = 100;

/** この版を書くときに消す受領記録の版の上限（これ以下を消す）。消さない版なら null。 */
export function receiptPruneBelow(version: number): number | null {
  if (version % RECEIPT_PRUNE_EVERY !== 0 || version <= RECEIPTS_KEPT) return null;
  return version - RECEIPTS_KEPT;
}
