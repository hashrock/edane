/**
 * AES-256-GCM encryption/decryption for note content.
 * Stored format: base64(iv + ciphertext + tag)
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
 * Read-side counterpart to the encrypt/store-plain decision a caller makes
 * before writing (older private notes may still be plaintext, hence the
 * isEncrypted check rather than trusting the mode alone). Returns null if
 * decryption fails so callers can pick their own fallback.
 */
export async function decodeStoredNoteContent(
  content: string,
  mode: NoteStorageMode,
  secret: string
): Promise<string | null> {
  if (mode === "plain" || !content || !isEncrypted(content)) return content;
  try {
    return await decrypt(content, secret);
  } catch {
    return null;
  }
}

/**
 * Write-side counterpart to decodeStoredNoteContent. Kept here (rather than
 * inlined at each call site) so the storage policy has one home instead of
 * drifting between a read-side helper and ad-hoc ternaries.
 */
export async function encodeNoteContentForStorage(
  content: string,
  mode: NoteStorageMode,
  secret: string
): Promise<string> {
  return mode === "plain" ? content : await encrypt(content, secret);
}
