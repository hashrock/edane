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

const ALGO = "AES-GCM";
const IV_LENGTH = 12; // 96-bit IV for AES-GCM

async function deriveKey(secret: string): Promise<CryptoKey> {
  const raw = new TextEncoder().encode(secret);
  const hash = await crypto.subtle.digest("SHA-256", raw);
  return crypto.subtle.importKey("raw", hash, { name: ALGO }, false, [
    "encrypt",
    "decrypt",
  ]);
}

export async function encrypt(
  plaintext: string,
  secret: string
): Promise<string> {
  const key = await deriveKey(secret);
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const encoded = new TextEncoder().encode(plaintext);

  const ciphertext = await crypto.subtle.encrypt(
    { name: ALGO, iv },
    key,
    encoded
  );

  // Concatenate iv + ciphertext into a single buffer
  const combined = new Uint8Array(iv.length + ciphertext.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(ciphertext), iv.length);

  return bytesToBase64(combined);
}

export async function decrypt(
  encoded: string,
  secret: string
): Promise<string> {
  const key = await deriveKey(secret);
  const combined = base64ToBytes(encoded);

  const iv = combined.slice(0, IV_LENGTH);
  const ciphertext = combined.slice(IV_LENGTH);

  const plaintext = await crypto.subtle.decrypt(
    { name: ALGO, iv },
    key,
    ciphertext
  );

  return new TextDecoder().decode(plaintext);
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
 * The secrets note content is encrypted with: `current` for writing, and
 * `previous` (optional) still accepted for reading while a rotation is under
 * way. A plain string means just a current key.
 */
export type NoteKeys = string | { current: string; previous?: string };

/** The note keys from the Worker's env (ENCRYPTION_KEY, ENCRYPTION_KEY_PREVIOUS). */
export function noteKeys(env: { ENCRYPTION_KEY: string; ENCRYPTION_KEY_PREVIOUS?: string }): NoteKeys {
  return { current: env.ENCRYPTION_KEY, previous: env.ENCRYPTION_KEY_PREVIOUS || undefined };
}

const keyList = (keys: NoteKeys) =>
  typeof keys === "string" ? [keys] : [keys.current, ...(keys.previous ? [keys.previous] : [])];

const V2 = "v2:";
const encoder = new TextEncoder();

/** A short public name for a secret (not the key): which secret a v2 ciphertext needs. */
async function keyIdOf(secret: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(`edane key id\0${secret}`)));
  return Array.from(digest.slice(0, 4), (b) => b.toString(16).padStart(2, "0")).join("");
}

async function deriveKeyV2(secret: string): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey("raw", encoder.encode(secret), "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(32), info: encoder.encode("edane note content v2") },
    material,
    { name: ALGO, length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

const aadFor = (noteId: string) => encoder.encode(`edane note\0${noteId}`);

async function encryptV2(plaintext: string, secret: string, noteId: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const ciphertext = await crypto.subtle.encrypt(
    { name: ALGO, iv, additionalData: aadFor(noteId) },
    await deriveKeyV2(secret),
    encoder.encode(plaintext)
  );
  const combined = new Uint8Array(iv.length + ciphertext.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(ciphertext), iv.length);
  return `${V2}${await keyIdOf(secret)}:${bytesToBase64(combined)}`;
}

async function decryptV2(stored: string, keys: NoteKeys, noteId: string): Promise<string> {
  const [keyId, body] = stored.slice(V2.length).split(":");
  for (const secret of keyList(keys)) {
    if ((await keyIdOf(secret)) !== keyId) continue;
    const combined = base64ToBytes(body);
    const plaintext = await crypto.subtle.decrypt(
      { name: ALGO, iv: combined.slice(0, IV_LENGTH), additionalData: aadFor(noteId) },
      await deriveKeyV2(secret),
      combined.slice(IV_LENGTH)
    );
    return new TextDecoder().decode(plaintext);
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
  return mode === "plain" ? content : await encryptV2(content, keyList(keys)[0], noteId);
}
