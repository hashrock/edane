/**
 * AES-256-GCM encryption/decryption for note content.
 *
 * Stored formats (docs/adr/0006-credentials.md):
 * - v2 (written today): `v2:<keyId>:<base64(iv + ciphertext + tag)>`. The key
 *   comes from HKDF over ENCRYPTION_KEY, `keyId` names which secret it came
 *   from (so ENCRYPTION_KEY can rotate with the old one kept as
 *   ENCRYPTION_KEY_PREVIOUS), and the note id is the AAD, so ciphertext moved
 *   to another note's row fails to decrypt instead of showing up there.
 * - v1 (legacy, read only): `base64(iv + ciphertext + tag)`, key = SHA-256 of
 *   the secret, no AAD. Rewritten as v2 on the note's next save.
 */

import { base64ToBytes, bytesToBase64 } from "./base64";
import { hashToken } from "./tokenHash";

const ALGO = "AES-GCM";
const IV_LENGTH = 12; // 96-bit IV for AES-GCM

/** AES-GCM with a fresh random IV; stored as base64(iv + ciphertext + tag). Shared by v1 and v2. */
async function seal(key: CryptoKey, plaintext: string, additionalData?: Uint8Array): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const ciphertext = await crypto.subtle.encrypt(
    { name: ALGO, iv, ...(additionalData ? { additionalData } : {}) },
    key,
    new TextEncoder().encode(plaintext)
  );
  const combined = new Uint8Array(iv.length + ciphertext.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(ciphertext), iv.length);
  return bytesToBase64(combined);
}

/** Inverse of {@link seal}; throws if the key or the additional data don't match. */
async function open(key: CryptoKey, sealed: string, additionalData?: Uint8Array): Promise<string> {
  const combined = base64ToBytes(sealed);
  const plaintext = await crypto.subtle.decrypt(
    { name: ALGO, iv: combined.slice(0, IV_LENGTH), ...(additionalData ? { additionalData } : {}) },
    key,
    combined.slice(IV_LENGTH)
  );
  return new TextDecoder().decode(plaintext);
}

/** v1 key: SHA-256 of the secret (legacy; kept for reading). */
async function deriveKey(secret: string): Promise<CryptoKey> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return crypto.subtle.importKey("raw", hash, { name: ALGO }, false, ["encrypt", "decrypt"]);
}

/** v1 format. Only tests and legacy reads use it; storage writes v2 (encodeNoteContentForStorage). */
export async function encrypt(plaintext: string, secret: string): Promise<string> {
  return seal(await deriveKey(secret), plaintext);
}

export async function decrypt(encoded: string, secret: string): Promise<string> {
  return open(await deriveKey(secret), encoded);
}

const GCM_TAG_LENGTH = 16;
// Canonical base64 as bytesToBase64 emits it: no whitespace, no exotic
// alphabet, padded to a multiple of 4.
const STRICT_BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * Does a stored string look like our ciphertext (base64 of iv + ciphertext +
 * tag, so at least IV_LENGTH + GCM_TAG_LENGTH bytes even for an empty
 * plaintext)? The check is strict on purpose: `atob` alone ignores ASCII
 * whitespace, so a legacy plaintext note such as "hello world of mindmaps"
 * would decode to enough bytes to pass — and then fail to decrypt, losing the
 * note. Requiring canonical base64 makes any text with whitespace or
 * punctuation fail fast; only a single unbroken run of ≥ 40 base64 characters
 * can still be mistaken, which no real note consists of.
 */
export function isEncrypted(content: string): boolean {
  if (content.length % 4 !== 0 || !STRICT_BASE64.test(content)) return false;
  // Canonical base64 decodes to 3 bytes per 4 chars (minus padding).
  const padding = content.endsWith("==") ? 2 : content.endsWith("=") ? 1 : 0;
  return (content.length / 4) * 3 - padding >= IV_LENGTH + GCM_TAG_LENGTH;
}

/**
 * Whether a note's content is stored plaintext or encrypted-at-rest. Today
 * this is a straight mirror of `isPublic` (see noteStorageMode below), but
 * it's a distinct concept from "is this note publicly viewable" — publicity
 * is access control, storage mode is a persistence detail. Naming it
 * explicitly at the crypto boundary keeps the two from being silently
 * assumed identical if publishing ever moves off the single `isPublic` flag
 * (e.g. per-node publishing, see TODO.md).
 */
export type NoteStorageMode = "plain" | "encrypted";

/** Today's storage policy: public notes are stored plaintext, private notes encrypted. */
export function noteStorageMode(isPublic: boolean): NoteStorageMode {
  return isPublic ? "plain" : "encrypted";
}

/**
 * Backups (note_backups) are always encrypted, whatever the note's publicity:
 * a public note's history must not stay readable in the clear after the note
 * goes private. They are bound to the backup's own id, not the note's.
 */
export const BACKUP_STORAGE_MODE: NoteStorageMode = "encrypted";

/**
 * The secrets note content is encrypted with: `current` for writing, and
 * `previous` (optional) still accepted for reading while a rotation is under way.
 */
export type NoteKeys = { current: string; previous?: string };

/** The note keys from the Worker's env (ENCRYPTION_KEY, ENCRYPTION_KEY_PREVIOUS). */
export function noteKeys(env: { ENCRYPTION_KEY: string; ENCRYPTION_KEY_PREVIOUS?: string }): NoteKeys {
  return { current: env.ENCRYPTION_KEY, previous: env.ENCRYPTION_KEY_PREVIOUS || undefined };
}

const keyList = (keys: NoteKeys) => [keys.current, ...(keys.previous ? [keys.previous] : [])];

const V2 = "v2:";
const encoder = new TextEncoder();

/**
 * A secret's v2 key and its public id (which secret a ciphertext needs). Both
 * depend only on the secret, so each is derived once per isolate: every commit
 * decrypts and encrypts.
 */
const v2Keys = new Map<string, Promise<{ keyId: string; key: CryptoKey }>>();
function v2Key(secret: string): Promise<{ keyId: string; key: CryptoKey }> {
  let entry = v2Keys.get(secret);
  if (!entry) {
    entry = (async () => {
      const material = await crypto.subtle.importKey("raw", encoder.encode(secret), "HKDF", false, ["deriveKey"]);
      const key = await crypto.subtle.deriveKey(
        { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(32), info: encoder.encode("edane note content v2") },
        material,
        { name: ALGO, length: 256 },
        false,
        ["encrypt", "decrypt"]
      );
      return { keyId: (await hashToken(`edane key id\0${secret}`)).slice(0, 8), key };
    })();
    v2Keys.set(secret, entry);
  }
  return entry;
}

const aadFor = (noteId: string) => encoder.encode(`edane note\0${noteId}`);

async function encryptV2(plaintext: string, secret: string, noteId: string): Promise<string> {
  const { keyId, key } = await v2Key(secret);
  return `${V2}${keyId}:${await seal(key, plaintext, aadFor(noteId))}`;
}

async function decryptV2(stored: string, keys: NoteKeys, noteId: string): Promise<string> {
  const [keyId, body] = stored.slice(V2.length).split(":");
  for (const secret of keyList(keys)) {
    const k = await v2Key(secret);
    if (k.keyId === keyId) return open(k.key, body, aadFor(noteId));
  }
  throw new Error("No key for this ciphertext");
}

async function decryptV1(stored: string, keys: NoteKeys): Promise<string> {
  for (const secret of keyList(keys)) {
    try {
      return await decrypt(stored, secret);
    } catch {
      // try the next key
    }
  }
  throw new Error("No key decrypts this ciphertext");
}

/**
 * Read-side counterpart to the encrypt/store-plain decision a caller makes
 * before writing (older private notes may still be plaintext, hence the
 * isEncrypted check rather than trusting the mode alone). `noteId` is the
 * AAD the content was bound to. Returns null if decryption fails so callers
 * can pick their own fallback.
 */
export async function decodeStoredNoteContent(
  content: string,
  mode: NoteStorageMode,
  keys: NoteKeys,
  noteId: string
): Promise<string | null> {
  if (mode === "plain" || !content) return content;
  try {
    if (content.startsWith(V2)) return await decryptV2(content, keys, noteId);
    return isEncrypted(content) ? await decryptV1(content, keys) : content;
  } catch {
    return null;
  }
}

/**
 * Write-side counterpart to decodeStoredNoteContent. Kept here (rather than
 * inlined at each call site) so the storage policy has one home instead of
 * drifting between a read-side helper and ad-hoc ternaries. Always writes v2
 * with the current key, bound to `noteId`.
 */
export async function encodeNoteContentForStorage(
  content: string,
  mode: NoteStorageMode,
  keys: NoteKeys,
  noteId: string
): Promise<string> {
  return mode === "plain" ? content : await encryptV2(content, keys.current, noteId);
}
