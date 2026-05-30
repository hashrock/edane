/**
 * AES-256-GCM encryption/decryption for note content.
 * Stored format: base64(iv + ciphertext + tag)
 */

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

  return btoa(String.fromCharCode(...combined));
}

export async function decrypt(
  encoded: string,
  secret: string
): Promise<string> {
  const key = await deriveKey(secret);
  const combined = Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0));

  const iv = combined.slice(0, IV_LENGTH);
  const ciphertext = combined.slice(IV_LENGTH);

  const plaintext = await crypto.subtle.decrypt(
    { name: ALGO, iv },
    key,
    ciphertext
  );

  return new TextDecoder().decode(plaintext);
}

/** Check if a string looks like encrypted content (valid base64, starts with IV) */
export function isEncrypted(content: string): boolean {
  try {
    const decoded = atob(content);
    // Encrypted content will be at least IV_LENGTH bytes + some ciphertext
    return decoded.length > IV_LENGTH;
  } catch {
    return false;
  }
}
