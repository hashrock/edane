/** Authenticated user shape shared by server session/auth code and client pages. */
export type SessionUser = {
  id: string;
  email: string;
  name: string;
  avatarUrl: string;
};

/**
 * The server-side row a request was authenticated with: a browser session or
 * an API token. Revoking (deleting / expiring) the row ends access, including
 * for a WebSocket opened with it (NoteRoom re-checks per commit).
 */
export type Credential = { table: "sessions" | "api_tokens"; id: string };
