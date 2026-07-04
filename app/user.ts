/** Authenticated user shape shared by server session/auth code and client pages. */
export type SessionUser = {
  id: string;
  email: string;
  name: string;
  avatarUrl: string;
};
