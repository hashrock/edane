/**
 * OAuth 2.1 の判定だけを集めた純粋なモジュール（HTTP と DB に依存しない）。
 * edane 自身が認可サーバーになり、保護するリソースはリモート MCP（`/mcp`）の 1 つだけ。
 * 方針は docs/adr/0005-mcp-oauth.md。
 *
 * - クライアントは動的クライアント登録（RFC 7591）で作る。公開クライアント（PKCE のみ）が基本で、
 *   登録時に求められればクライアントシークレットも発行する。
 * - 認可コードは PKCE（S256）必須。
 * - スコープは `notes`（ノートの読み書き）の 1 つだけ。知らないスコープは無視して `notes` を与える。
 */

import { bytesToBase64Url, decodeBase64Utf8 } from "../utils/base64";

const OAUTH_SCOPE = "notes";

/** 認可コードの寿命。OAuth 2.1 が勧める上限の 10 分。 */
export const CODE_TTL_MS = 10 * 60 * 1000;
export const ACCESS_TOKEN_TTL_MS = 60 * 60 * 1000;
/** リフレッシュトークンの寿命。使うたびに入れ替わるので、使っている限り切れない。 */
export const REFRESH_TOKEN_TTL_MS = 90 * 24 * 60 * 60 * 1000;
/** 誰にも許可されなかったクライアントを残す期間。登録から同意までには十分で、放置された登録は溜めない。 */
export const UNAUTHORIZED_CLIENT_TTL_MS = 24 * 60 * 60 * 1000;

export const REFRESH_TOKEN_PREFIX = "edane_ort_";
export const CODE_PREFIX = "edane_oac_";
export const CLIENT_SECRET_PREFIX = "edane_ocs_";

const mcpResource = (origin: string) => `${origin}/mcp`;

/** RFC 9728: 保護リソースのメタデータ。401 の WWW-Authenticate からここへ辿らせる。 */
export function protectedResourceMetadata(origin: string) {
  return {
    resource: mcpResource(origin),
    authorization_servers: [origin],
    scopes_supported: [OAUTH_SCOPE],
    bearer_methods_supported: ["header"],
    resource_name: "edane",
  };
}

/** RFC 8414: 認可サーバーのメタデータ。issuer はパスなしのオリジン。 */
export function authorizationServerMetadata(origin: string) {
  return {
    issuer: origin,
    authorization_endpoint: `${origin}/oauth/authorize`,
    token_endpoint: `${origin}/oauth/token`,
    registration_endpoint: `${origin}/oauth/register`,
    scopes_supported: [OAUTH_SCOPE],
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    token_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
    code_challenge_methods_supported: ["S256"],
    authorization_response_iss_parameter_supported: true,
  };
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
/** ブラウザ内でスクリプトや別文書として解釈されるスキーム。リダイレクト先にしてはいけない。 */
const FORBIDDEN_SCHEMES = new Set(["javascript:", "data:", "file:", "vbscript:", "blob:", "about:", "ws:", "wss:"]);

function parseUrl(uri: string): URL | null {
  try {
    return new URL(uri);
  } catch {
    return null;
  }
}

function isLoopback(url: URL): boolean {
  return url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname);
}

/**
 * 登録してよいリダイレクト URI か。https、ループバックの http（ネイティブアプリ。RFC 8252）、
 * アプリ独自のスキーム（`cursor://…` など）を受け付ける。フラグメント付きは不可。
 */
export function isAllowedRedirectUri(uri: string): boolean {
  if (uri.length > 2000) return false;
  const url = parseUrl(uri);
  if (!url || uri.includes("#")) return false;
  if (url.protocol === "https:") return url.hostname !== "";
  if (url.protocol === "http:") return isLoopback(url);
  return !FORBIDDEN_SCHEMES.has(url.protocol);
}

/**
 * 要求されたリダイレクト URI が登録済みのどれかと一致するか。完全一致が原則で、
 * ループバックだけはポートを問わない（RFC 8252 §7.3: ネイティブアプリは空きポートで待つ）。
 */
export function redirectUriMatches(registered: readonly string[], requested: string): boolean {
  if (registered.includes(requested)) return true;
  const req = parseUrl(requested);
  if (!req || !isLoopback(req)) return false;
  return registered.some((r) => {
    const reg = parseUrl(r);
    return (
      !!reg &&
      isLoopback(reg) &&
      reg.hostname === req.hostname &&
      reg.pathname === req.pathname &&
      reg.search === req.search
    );
  });
}

type TokenEndpointAuthMethod = "none" | "client_secret_post" | "client_secret_basic";

interface Registration {
  name: string;
  redirectUris: string[];
  authMethod: TokenEndpointAuthMethod;
}

interface OAuthError {
  error: string;
  error_description: string;
}

const MAX_REDIRECT_URIS = 10;
const MAX_CLIENT_NAME = 100;

/** RFC 7591 の登録要求を検証する。応答に載せる値（既定値を埋めたもの）を返す。 */
export function parseRegistration(body: unknown): { ok: true; value: Registration } | { ok: false; error: OAuthError } {
  const fail = (error: string, error_description: string) => ({ ok: false as const, error: { error, error_description } });
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return fail("invalid_client_metadata", "Body must be a JSON object");
  }
  const b = body as Record<string, unknown>;

  const uris = b.redirect_uris;
  if (!Array.isArray(uris) || uris.length === 0 || uris.length > MAX_REDIRECT_URIS) {
    return fail("invalid_redirect_uri", `redirect_uris must be an array of 1-${MAX_REDIRECT_URIS} URIs`);
  }
  for (const u of uris) {
    if (typeof u !== "string" || !isAllowedRedirectUri(u)) {
      return fail("invalid_redirect_uri", `Redirect URI not allowed: ${String(u).slice(0, 200)}`);
    }
  }

  const method = b.token_endpoint_auth_method ?? "none";
  if (method !== "none" && method !== "client_secret_post" && method !== "client_secret_basic") {
    return fail("invalid_client_metadata", `Unsupported token_endpoint_auth_method: ${String(method)}`);
  }
  for (const [field, allowed] of [
    ["grant_types", ["authorization_code", "refresh_token"]],
    ["response_types", ["code"]],
  ] as const) {
    const v = b[field];
    if (v === undefined) continue;
    if (!Array.isArray(v) || v.some((x) => !(allowed as readonly unknown[]).includes(x))) {
      return fail("invalid_client_metadata", `Unsupported ${field}`);
    }
  }

  const rawName = typeof b.client_name === "string" ? b.client_name.trim() : "";
  const name = (rawName || new URL(uris[0] as string).host || "MCP client").slice(0, MAX_CLIENT_NAME);
  return { ok: true, value: { name, redirectUris: uris as string[], authMethod: method } };
}

export interface AuthorizeRequest {
  clientId: string;
  redirectUri: string;
  state: string | undefined;
  codeChallenge: string;
  scope: string;
}

type AuthorizeValidation<C> =
  /** クライアントかリダイレクト先が信用できない。リダイレクトせずエラー画面を出す（RFC 6749 §4.1.2.1）。 */
  | { kind: "fatal"; description: string }
  /** リダイレクト先は確かなので、エラーをそこへ返す。 */
  | { kind: "redirect-error"; redirectUri: string; state: string | undefined; error: OAuthError }
  | { kind: "ok"; request: AuthorizeRequest; client: C };

type Params = Record<string, string | undefined>;

/**
 * 認可要求（GET のクエリ、または同意画面の POST）を検証する。`client` は `client_id` で引いた結果。
 * 同意画面の POST でも同じ関数を通し直すので、隠しフィールドの改ざんも同じ規則で弾ける。
 */
export function validateAuthorizeRequest<C extends { redirectUris: readonly string[] }>(
  q: Params,
  client: C | null,
  origin: string
): AuthorizeValidation<C> {
  if (!q.client_id || !client) return { kind: "fatal", description: "Unknown client_id" };
  let redirectUri = q.redirect_uri;
  if (!redirectUri) {
    if (client.redirectUris.length !== 1) return { kind: "fatal", description: "redirect_uri is required" };
    redirectUri = client.redirectUris[0];
  }
  if (!redirectUriMatches(client.redirectUris, redirectUri)) {
    return { kind: "fatal", description: "redirect_uri does not match the registered client" };
  }

  const state = q.state;
  const err = (error: string, error_description: string): AuthorizeValidation<C> => ({
    kind: "redirect-error",
    redirectUri: redirectUri!,
    state,
    error: { error, error_description },
  });
  if (q.response_type !== "code") return err("unsupported_response_type", "response_type must be code");
  if (!q.code_challenge || !/^[A-Za-z0-9_-]{43}$/.test(q.code_challenge)) {
    return err("invalid_request", "PKCE code_challenge (S256) is required");
  }
  if (q.code_challenge_method !== "S256") return err("invalid_request", "code_challenge_method must be S256");
  if (q.resource !== undefined && !isValidResource(q.resource, origin)) {
    return err("invalid_target", "Unknown resource");
  }
  return {
    kind: "ok",
    request: { clientId: q.client_id, redirectUri, state, codeChallenge: q.code_challenge, scope: OAUTH_SCOPE },
    client,
  };
}

/** RFC 8707 の resource。守るリソースは `/mcp` だけなので、それ（末尾スラッシュ違いを含む）以外は断る。 */
function isValidResource(resource: string, origin: string): boolean {
  const mcp = mcpResource(origin);
  return resource === mcp || resource === `${mcp}/`;
}

/** リダイレクト先 URI に認可応答のパラメータを足す（既存のクエリは保つ）。 */
export function authorizeResponseUrl(redirectUri: string, params: Params): string {
  const url = new URL(redirectUri);
  for (const [k, v] of Object.entries(params)) if (v !== undefined) url.searchParams.set(k, v);
  return url.toString();
}

const encoder = new TextEncoder();

/** PKCE S256: base64url(SHA-256(verifier)) === challenge。verifier は RFC 7636 の文字集合と長さ。 */
export async function verifyPkce(verifier: string | undefined, challenge: string): Promise<boolean> {
  if (!verifier || !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) return false;
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(verifier)));
  return bytesToBase64Url(digest) === challenge;
}

/**
 * `Authorization: Basic` のクライアント認証（RFC 6749 §2.3.1: id と secret はそれぞれ URL エンコード）。
 * ヘッダーが無ければ undefined、壊れていれば null。
 */
export function parseBasicCredentials(header: string | undefined): { clientId: string; secret: string } | null | undefined {
  const basic = header?.match(/^Basic (.+)$/i)?.[1];
  if (!basic) return undefined;
  try {
    const decoded = decodeBase64Utf8(basic);
    const i = decoded.indexOf(":");
    if (i < 0) return null;
    return { clientId: decodeURIComponent(decoded.slice(0, i)), secret: decodeURIComponent(decoded.slice(i + 1)) };
  } catch {
    return null;
  }
}

/** 認可コードの交換を検証する。`code` は使い切りで取り出した行（無ければ null）。 */
export async function validateCodeExchange<T extends { clientId: string; redirectUri: string; codeChallenge: string; expiresAt: number }>(
  code: T | null,
  clientId: string,
  form: Params,
  now: number
): Promise<{ ok: true; code: T } | { ok: false; error: OAuthError }> {
  const invalid = (error_description: string) => ({ ok: false as const, error: { error: "invalid_grant", error_description } });
  if (!code || code.expiresAt <= now || code.clientId !== clientId) {
    return invalid("Invalid or expired authorization code");
  }
  if (form.redirect_uri !== undefined && form.redirect_uri !== code.redirectUri) {
    return invalid("redirect_uri does not match");
  }
  if (!(await verifyPkce(form.code_verifier, code.codeChallenge))) return invalid("PKCE verification failed");
  return { ok: true, code };
}

/** 推測できない不透明なトークン（32 バイトの乱数）。DB にはハッシュだけを置く。 */
export function randomToken(prefix: string): string {
  return prefix + bytesToBase64Url(crypto.getRandomValues(new Uint8Array(32)));
}
