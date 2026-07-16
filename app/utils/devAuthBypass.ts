/**
 * Dev-only auth bypass: resolves the `?guest=` / `dev_guest` cookie toggle
 * used to preview the logged-out landing page (and its embedded /guest
 * iframe) while DEV_BYPASS_AUTH is on. Pulled out of the session middleware
 * so this dev-tooling context stays separate from real session resolution
 * and stays independently testable without a Hono request/DB.
 */
export function resolveDevGuestPreference(
  cookieHeader: string,
  queryGuestParam: string | null
): { guest: boolean; setCookieHeader?: string } {
  let guest = /(?:^|;\s*)dev_guest=1(?:;|$)/.test(cookieHeader);
  let setCookieHeader: string | undefined;
  if (queryGuestParam !== null) {
    guest = queryGuestParam !== "0";
    setCookieHeader = guest
      ? "dev_guest=1; Path=/; SameSite=Lax"
      : "dev_guest=; Path=/; Max-Age=0; SameSite=Lax";
  }
  return { guest, setCookieHeader };
}
