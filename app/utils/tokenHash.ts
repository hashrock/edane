/**
 * Pure token hashing, split out of apiToken.ts so it stays independently
 * testable without pulling in drizzle-orm/d1 and the DB schema — a module
 * meant to be used for hashing shouldn't force a DB dependency onto callers.
 */

/** SHA-256 hash of a token string, returned as hex. */
export async function hashToken(token: string): Promise<string> {
  const buf = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(token)
  );
  return [...new Uint8Array(buf)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
