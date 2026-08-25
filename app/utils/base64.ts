/**
 * UTF-8 / binary safe base64 helpers.
 *
 * btoa() only accepts Latin1 code points, so btoa(JSON.stringify(user)) throws
 * InvalidCharacterError as soon as a value holds a non-Latin1 character (a
 * Japanese Google account name, an emoji in a display name, ...). Text has to
 * be encoded to UTF-8 bytes first, and btoa fed one byte per char.
 *
 * Byte input is chunked because String.fromCharCode(...bytes) blows the call
 * stack on large buffers (note contents can be megabytes).
 */

const CHUNK_SIZE = 0x8000;

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK_SIZE) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK_SIZE));
  }
  return btoa(binary);
}

export function base64ToBytes(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/** base64 of the UTF-8 encoding of `text`. ASCII-only input matches btoa(text). */
export function encodeBase64Utf8(text: string): string {
  return bytesToBase64(new TextEncoder().encode(text));
}

/** Inverse of encodeBase64Utf8. ASCII-only input matches atob(base64). */
export function decodeBase64Utf8(base64: string): string {
  return new TextDecoder().decode(base64ToBytes(base64));
}
