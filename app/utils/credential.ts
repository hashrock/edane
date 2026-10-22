/**
 * "Is this credential still live?" as an SQL condition, for callers that
 * re-check a credential inside a query they already run (NoteRoom's load), so
 * revocation costs no extra round trip. The auth tables' names and expiry
 * rule live here, not in the sync layer.
 */
import type { Credential } from "../user";

/** The only strings ever spliced into the SQL below. */
const CREDENTIAL_TABLE = { sessions: "sessions", api_tokens: "api_tokens" } as const satisfies Record<
  Credential["table"],
  string
>;

/** ` AND EXISTS (...)` for a live (present, unexpired) credential row, and its bindings. */
export function credentialLiveClause(credential: Credential, now: number): { sql: string; bindings: unknown[] } {
  return {
    sql: ` AND EXISTS (SELECT 1 FROM ${CREDENTIAL_TABLE[credential.table]} WHERE id = ? AND expires_at > ?)`,
    bindings: [credential.id, now],
  };
}
