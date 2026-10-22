/**
 * リモート MCP（`/mcp`）用の OAuth 2.1 認可サーバー。ChatGPT や claude.ai のコネクタのように、
 * ヘッダーを手で設定できず OAuth でしか接続しないクライアントのためにある。方針は
 * docs/adr/0005-mcp-oauth.md、判定の規則は ./protocol.ts。
 *
 * 2 つに分けて mount する（server.ts）:
 * - {@link oauthServerRoutes}: メタデータ・クライアント登録・トークン。Cookie を一切読まないので
 *   セッションミドルウェアより前（`/mcp` と同じ理由: Cookie で通るものを作らない）。
 * - {@link oauthSessionRoutes}: 同意画面と「接続中のアプリ」API。ログイン中のユーザーが要るので
 *   セッション・Inertia ミドルウェアより後。
 */
import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import { bodyLimit } from "hono/body-limit";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import type { Env } from "../global.d";
import { hashToken } from "../utils/tokenHash";
import { ACCESS_TOKEN_PREFIX } from "../utils/oauthToken";
import { d1OAuthStore, type OAuthClient, type OAuthStore, type TokenPair } from "./store";
import {
  ACCESS_TOKEN_TTL_MS,
  CLIENT_SECRET_PREFIX,
  CODE_PREFIX,
  CODE_TTL_MS,
  REFRESH_TOKEN_PREFIX,
  REFRESH_TOKEN_TTL_MS,
  UNAUTHORIZED_CLIENT_TTL_MS,
  authorizationServerMetadata,
  authorizeResponseUrl,
  parseBasicCredentials,
  parseRegistration,
  protectedResourceMetadata,
  randomToken,
  validateAuthorizeRequest,
  validateCodeExchange,
  type AuthorizeRequest,
} from "./protocol";

export interface OAuthDeps {
  store(env: Env["Bindings"]): OAuthStore;
  now(): number;
  /** 動的クライアント登録を受けてよいか（IP ごとのレート制限）。false = 429。 */
  allowRegistration(c: Context<Env>): Promise<boolean>;
}

const defaultDeps: OAuthDeps = {
  store: d1OAuthStore,
  now: () => Date.now(),
  async allowRegistration(c) {
    const key = c.req.header("CF-Connecting-IP") ?? "unknown";
    return (await c.env.OAUTH_REGISTER_LIMITER.limit({ key })).success;
  },
};

const originOf = (c: Context) => new URL(c.req.url).origin;

/** RFC 6749 §5.2 のエラー応答。 */
function oauthError(c: Context, status: 400 | 401 | 429, error: string, error_description: string) {
  c.header("Cache-Control", "no-store");
  if (status === 401) c.header("WWW-Authenticate", 'Basic realm="edane"');
  return c.json({ error, error_description }, status);
}

async function issueTokens(now: number) {
  const accessToken = randomToken(ACCESS_TOKEN_PREFIX);
  const refreshToken = randomToken(REFRESH_TOKEN_PREFIX);
  const [accessTokenHash, refreshTokenHash] = await Promise.all([hashToken(accessToken), hashToken(refreshToken)]);
  const pair: TokenPair = {
    accessTokenHash,
    accessExpiresAt: now + ACCESS_TOKEN_TTL_MS,
    refreshTokenHash,
    refreshExpiresAt: now + REFRESH_TOKEN_TTL_MS,
  };
  return { accessToken, refreshToken, pair };
}

function tokenResponse(c: Context, t: { accessToken: string; refreshToken: string }, scope: string) {
  c.header("Cache-Control", "no-store");
  c.header("Pragma", "no-cache");
  return c.json({
    access_token: t.accessToken,
    token_type: "Bearer",
    expires_in: ACCESS_TOKEN_TTL_MS / 1000,
    refresh_token: t.refreshToken,
    scope,
  });
}

/**
 * トークン要求のクライアントを認証する。Basic ヘッダー、または本文の client_id（+ client_secret）。
 * シークレット付きで登録したクライアントはシークレット必須。公開クライアントは client_id だけ。
 */
async function authenticateClient(
  c: Context,
  store: OAuthStore,
  form: Record<string, string>
): Promise<OAuthClient | null> {
  const basic = parseBasicCredentials(c.req.header("Authorization"));
  if (basic === null) return null;
  const clientId = basic ? basic.clientId : form.client_id;
  const secret = basic ? basic.secret : form.client_secret;
  if (!clientId) return null;
  const client = await store.findClient(clientId);
  if (!client) return null;
  if (client.secretHash && (!secret || (await hashToken(secret)) !== client.secretHash)) return null;
  return client;
}

async function readForm(c: Context): Promise<Record<string, string>> {
  const type = c.req.header("Content-Type") ?? "";
  const raw: Record<string, unknown> = type.includes("application/json")
    ? await c.req.json().catch(() => ({}))
    : await c.req.parseBody().catch(() => ({}));
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw ?? {})) if (typeof v === "string") out[k] = v;
  return out;
}

export function oauthServerRoutes(deps: OAuthDeps = defaultDeps) {
  const r = new Hono<Env>();
  // Bearer / PKCE だけで守られ Cookie を使わないので、ブラウザ上のクライアント（MCP Inspector など）にも開ける。
  const openCors = cors({ origin: "*", allowMethods: ["GET", "POST", "OPTIONS"], allowHeaders: ["Authorization", "Content-Type", "Mcp-Protocol-Version"] });
  r.use("/.well-known/*", openCors);
  r.use("/oauth/register", openCors);
  r.use("/oauth/token", openCors);

  // RFC 9728。パス付き（/mcp の分）が本来の場所で、ルートはそれを探さないクライアント向け。
  const prm = (c: Context) => c.json(protectedResourceMetadata(originOf(c)));
  r.get("/.well-known/oauth-protected-resource/mcp", prm);
  r.get("/.well-known/oauth-protected-resource", prm);
  r.get("/.well-known/oauth-authorization-server", (c) => c.json(authorizationServerMetadata(originOf(c))));

  // RFC 7591 動的クライアント登録。誰でも登録できるが、アクセスはユーザーが同意画面で許可するまで得られない。
  r.post(
    "/oauth/register",
    bodyLimit({ maxSize: 16 * 1024, onError: (c) => oauthError(c, 400, "invalid_client_metadata", "Too large") }),
    async (c) => {
      if (!(await deps.allowRegistration(c))) {
        c.header("Retry-After", "60");
        return oauthError(c, 429, "too_many_requests", "Too many registrations; retry later");
      }
      const now = deps.now();
      const body = await c.req.json().catch(() => null);
      const parsed = parseRegistration(body);
      if (!parsed.ok) return c.json(parsed.error, 400);
      const { name, redirectUris, authMethod } = parsed.value;
      const id = crypto.randomUUID();
      const secret = authMethod === "none" ? null : randomToken(CLIENT_SECRET_PREFIX);
      await deps.store(c.env).createClient(
        { id, name, redirectUris, secretHash: secret ? await hashToken(secret) : null },
        { now, unauthorizedClientsBefore: now - UNAUTHORIZED_CLIENT_TTL_MS }
      );
      c.header("Cache-Control", "no-store");
      return c.json(
        {
          client_id: id,
          ...(secret ? { client_secret: secret, client_secret_expires_at: 0 } : {}),
          client_id_issued_at: Math.floor(now / 1000),
          client_name: name,
          redirect_uris: redirectUris,
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          token_endpoint_auth_method: authMethod,
        },
        201
      );
    }
  );

  r.post(
    "/oauth/token",
    bodyLimit({ maxSize: 16 * 1024, onError: (c) => oauthError(c, 400, "invalid_request", "Too large") }),
    async (c) => {
      const form = await readForm(c);
      const store = deps.store(c.env);
      const client = await authenticateClient(c, store, form);
      if (!client) return oauthError(c, 401, "invalid_client", "Client authentication failed");
      const now = deps.now();

      if (form.grant_type === "authorization_code") {
        if (!form.code) return oauthError(c, 400, "invalid_request", "code is required");
        // 先に消す: 失敗した交換でもコードは使い切り（盗まれたコードの再試行を許さない）。
        const exchange = await validateCodeExchange(await store.takeCode(await hashToken(form.code)), client.id, form, now);
        if (!exchange.ok) return oauthError(c, 400, exchange.error.error, exchange.error.error_description);
        const { code } = exchange;
        const tokens = await issueTokens(now);
        await store.createGrant({ id: crypto.randomUUID(), clientId: client.id, userId: code.userId, scope: code.scope, ...tokens.pair }, now);
        return tokenResponse(c, tokens, code.scope);
      }

      if (form.grant_type === "refresh_token") {
        if (!form.refresh_token) return oauthError(c, 400, "invalid_request", "refresh_token is required");
        const tokens = await issueTokens(now);
        const rotated = await store.rotateGrant(await hashToken(form.refresh_token), client.id, tokens.pair, now);
        if (!rotated) return oauthError(c, 400, "invalid_grant", "Invalid or expired refresh token");
        return tokenResponse(c, tokens, rotated.scope);
      }

      return oauthError(c, 400, "unsupported_grant_type", "grant_type must be authorization_code or refresh_token");
    }
  );

  return r;
}

/** ログイン後に同意画面へ戻るための Cookie（Google ログインの callback が読む）。 */
const RETURN_COOKIE = "oauth_return";
const AUTHORIZE_PATH = "/oauth/authorize";

/** Google ログインの callback 用: 同意画面から来たならそこへ戻す URL（無ければ null）。1 回で消える。 */
export function takeOAuthReturn(c: Context): string | null {
  const path = getCookie(c, RETURN_COOKIE);
  if (!path) return null;
  deleteCookie(c, RETURN_COOKIE, { path: "/" });
  return path.startsWith(`${AUTHORIZE_PATH}?`) ? path : null;
}

/** 同意画面に渡す、検証済みの要求（隠しフィールドとしてそのまま POST に戻ってくる）。 */
function authorizeFields(req: AuthorizeRequest, resource: string | undefined) {
  return {
    response_type: "code",
    client_id: req.clientId,
    redirect_uri: req.redirectUri,
    code_challenge: req.codeChallenge,
    code_challenge_method: "S256",
    scope: req.scope,
    ...(req.state !== undefined ? { state: req.state } : {}),
    ...(resource !== undefined ? { resource } : {}),
  };
}

function fatalPage(c: Context, description: string) {
  return c.text(`OAuth error: ${description}`, 400);
}

export function oauthSessionRoutes(deps: OAuthDeps = defaultDeps) {
  const r = new Hono<Env>();

  const validate = async (c: Context<Env>, q: Record<string, string | undefined>) => {
    const client = q.client_id ? await deps.store(c.env).findClient(q.client_id) : null;
    return validateAuthorizeRequest(q, client, originOf(c));
  };
  /** 認可応答をクライアントへ返す。state と iss（RFC 9207）はどの応答にも付ける。 */
  const respond = (c: Context, redirectUri: string, state: string | undefined, params: Record<string, string>) =>
    c.redirect(authorizeResponseUrl(redirectUri, { ...params, state, iss: originOf(c) }));

  r.get(AUTHORIZE_PATH, async (c) => {
    const q = c.req.query();
    const result = await validate(c, q);
    if (result.kind === "fatal") return fatalPage(c, result.description);
    if (result.kind === "redirect-error") return respond(c, result.redirectUri, result.state, { ...result.error });

    const user = c.get("user");
    if (!user) {
      const url = new URL(c.req.url);
      setCookie(c, RETURN_COOKIE, url.pathname + url.search, {
        path: "/",
        httpOnly: true,
        secure: url.hostname !== "localhost",
        sameSite: "Lax",
        maxAge: 600,
      });
      return c.redirect("/auth/google");
    }

    // 同意画面を他サイトの iframe に入れて「許可」を押させる攻撃（クリックジャッキング）を防ぐ。
    c.header("X-Frame-Options", "DENY");
    c.header("Content-Security-Policy", "frame-ancestors 'none'");
    c.header("Cache-Control", "no-store");
    return c.render("OAuth/Authorize", {
      user,
      clientName: result.client.name,
      redirectTo: displayRedirect(result.request.redirectUri),
      fields: authorizeFields(result.request, q.resource),
    });
  });

  r.post(AUTHORIZE_PATH, async (c) => {
    // SameSite=Lax の Cookie は他サイトからの POST に付かないが、念のため送信元も確かめる。
    if (c.req.header("Origin") !== originOf(c)) return c.text("Invalid origin", 403);
    const user = c.get("user");
    if (!user) return c.text("Unauthorized", 401);

    const form = await readForm(c);
    const result = await validate(c, form);
    if (result.kind === "fatal") return fatalPage(c, result.description);
    if (result.kind === "redirect-error") return respond(c, result.redirectUri, result.state, { ...result.error });
    const req = result.request;
    if (form.decision !== "approve") {
      return respond(c, req.redirectUri, req.state, { error: "access_denied", error_description: "The user denied access" });
    }

    const code = randomToken(CODE_PREFIX);
    await deps.store(c.env).saveCode({
      codeHash: await hashToken(code),
      clientId: req.clientId,
      userId: user.id,
      redirectUri: req.redirectUri,
      codeChallenge: req.codeChallenge,
      scope: req.scope,
      expiresAt: deps.now() + CODE_TTL_MS,
    });
    return respond(c, req.redirectUri, req.state, { code });
  });

  // 設定画面の「接続中のアプリ」。
  r.get("/api/oauth/grants", async (c) => {
    const user = c.get("user");
    if (!user) return c.json({ error: "Unauthorized" }, 401);
    return c.json(await deps.store(c.env).listGrants(user.id, deps.now()));
  });
  r.delete("/api/oauth/grants/:id", async (c) => {
    const user = c.get("user");
    if (!user) return c.json({ error: "Unauthorized" }, 401);
    const ok = await deps.store(c.env).deleteGrant(user.id, c.req.param("id"));
    return ok ? c.json({ ok: true }) : c.json({ error: "Not found" }, 404);
  });

  return r;
}

/** 同意画面に出す「どこへ戻るか」。クライアント名は自己申告なので、確かな手がかりはこちら。 */
function displayRedirect(uri: string): string {
  const url = new URL(uri);
  return url.host ? `${url.protocol}//${url.host}` : url.protocol;
}
