import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import {
  authorizeResponseUrl,
  isAllowedRedirectUri,
  parseBasicCredentials,
  parseRegistration,
  redirectUriMatches,
  validateAuthorizeRequest,
  validateCodeExchange,
  verifyPkce,
} from "./protocol";

const ORIGIN = "https://edane.example";
const VERIFIER = "verifier-0123456789-0123456789-0123456789-~._";
// node:crypto as an independent implementation of S256.
const CHALLENGE = createHash("sha256").update(VERIFIER).digest("base64url");

describe("isAllowedRedirectUri", () => {
  it.each([
    "https://chatgpt.com/connector_platform_oauth_redirect",
    "https://claude.ai/api/mcp/auth_callback",
    "http://localhost:33418/callback",
    "http://127.0.0.1/cb",
    "cursor://anysphere.cursor-mcp/oauth/callback",
    "com.example.app:/oauth",
  ])("allows %s", (uri) => expect(isAllowedRedirectUri(uri)).toBe(true));

  it.each([
    "http://evil.example/cb",
    "javascript:alert(1)",
    "data:text/html,hi",
    "https://ok.example/cb#frag",
    "not a url",
    "intent://scan/#Intent;scheme=zxing;end",
    "ms-settings:privacy",
    "myapp://cb",
    "blob:https://ok.example/1",
  ])("rejects %s", (uri) => expect(isAllowedRedirectUri(uri)).toBe(false));
});

describe("redirectUriMatches", () => {
  it("matches exactly", () => {
    expect(redirectUriMatches(["https://a.example/cb"], "https://a.example/cb")).toBe(true);
    expect(redirectUriMatches(["https://a.example/cb"], "https://a.example/cb2")).toBe(false);
    expect(redirectUriMatches(["https://a.example/cb"], "https://a.example:444/cb")).toBe(false);
  });
  it("ignores the port for loopback only", () => {
    expect(redirectUriMatches(["http://localhost:1000/cb"], "http://localhost:2000/cb")).toBe(true);
    expect(redirectUriMatches(["http://localhost:1000/cb"], "http://localhost:2000/other")).toBe(false);
    expect(redirectUriMatches(["http://localhost:1000/cb"], "http://127.0.0.1:1000/cb")).toBe(false);
  });
});

describe("parseRegistration", () => {
  it("defaults to a public client", () => {
    const r = parseRegistration({ redirect_uris: ["https://a.example/cb"], client_name: "ChatGPT" });
    expect(r).toEqual({ ok: true, value: { name: "ChatGPT", redirectUris: ["https://a.example/cb"], authMethod: "none" } });
  });
  it("names a nameless client after its redirect host", () => {
    const r = parseRegistration({ redirect_uris: ["https://a.example/cb"] });
    expect(r.ok && r.value.name).toBe("a.example");
  });
  it("accepts confidential methods", () => {
    const r = parseRegistration({ redirect_uris: ["https://a.example/cb"], token_endpoint_auth_method: "client_secret_basic" });
    expect(r.ok && r.value.authMethod).toBe("client_secret_basic");
  });
  it.each([
    [{}, "invalid_redirect_uri"],
    [{ redirect_uris: [] }, "invalid_redirect_uri"],
    [{ redirect_uris: ["http://evil.example/cb"] }, "invalid_redirect_uri"],
    [{ redirect_uris: ["https://a.example/cb"], token_endpoint_auth_method: "private_key_jwt" }, "invalid_client_metadata"],
    [{ redirect_uris: ["https://a.example/cb"], grant_types: ["client_credentials"] }, "invalid_client_metadata"],
    [null, "invalid_client_metadata"],
  ])("rejects %o", (body, error) => {
    const r = parseRegistration(body);
    expect(!r.ok && r.error.error).toBe(error);
  });
});

describe("validateAuthorizeRequest", () => {
  const client = { redirectUris: ["https://a.example/cb"] };
  const good = {
    response_type: "code",
    client_id: "c1",
    redirect_uri: "https://a.example/cb",
    code_challenge: CHALLENGE,
    code_challenge_method: "S256",
    state: "xyz",
  };

  it("accepts a PKCE request and grants the notes scope", () => {
    expect(validateAuthorizeRequest({ ...good, scope: "openid whatever" }, client, ORIGIN)).toEqual({
      kind: "ok",
      request: { clientId: "c1", redirectUri: "https://a.example/cb", state: "xyz", codeChallenge: CHALLENGE, scope: "notes" },
      client,
    });
  });
  it("uses the only registered redirect when none is given", () => {
    const r = validateAuthorizeRequest({ ...good, redirect_uri: undefined }, client, ORIGIN);
    expect(r.kind === "ok" && r.request.redirectUri).toBe("https://a.example/cb");
  });
  it("never redirects to an unregistered URI or for an unknown client", () => {
    expect(validateAuthorizeRequest({ ...good, redirect_uri: "https://evil.example/cb" }, client, ORIGIN).kind).toBe("fatal");
    expect(validateAuthorizeRequest(good, null, ORIGIN).kind).toBe("fatal");
  });
  it.each([
    [{ response_type: "token" }, "unsupported_response_type"],
    [{ code_challenge: undefined }, "invalid_request"],
    [{ code_challenge_method: "plain" }, "invalid_request"],
    [{ resource: "https://other.example/mcp" }, "invalid_target"],
  ])("returns %o to the client as an error", (patch, error) => {
    const r = validateAuthorizeRequest({ ...good, ...patch }, client, ORIGIN);
    expect(r.kind === "redirect-error" && r.error.error).toBe(error);
  });
  it("accepts the MCP resource", () => {
    expect(validateAuthorizeRequest({ ...good, resource: `${ORIGIN}/mcp` }, client, ORIGIN).kind).toBe("ok");
  });
});

describe("verifyPkce", () => {
  it("checks base64url(SHA-256(verifier))", async () => {
    expect(await verifyPkce(VERIFIER, CHALLENGE)).toBe(true);
    expect(await verifyPkce(VERIFIER.replace(/.$/, "x"), CHALLENGE)).toBe(false);
    expect(await verifyPkce(undefined, CHALLENGE)).toBe(false);
    expect(await verifyPkce("short", CHALLENGE)).toBe(false);
  });
});

it("authorizeResponseUrl keeps the client's own query", () => {
  expect(authorizeResponseUrl("https://a.example/cb?x=1", { code: "c", state: undefined })).toBe("https://a.example/cb?x=1&code=c");
});

describe("parseBasicCredentials", () => {
  it("decodes the URL-encoded id and secret", () => {
    expect(parseBasicCredentials(`Basic ${btoa("my%20id:s%3Acret")}`)).toEqual({ clientId: "my id", secret: "s:cret" });
  });
  it("is undefined without a Basic header and null when malformed", () => {
    expect(parseBasicCredentials(undefined)).toBeUndefined();
    expect(parseBasicCredentials("Bearer x")).toBeUndefined();
    expect(parseBasicCredentials(`Basic ${btoa("no-colon")}`)).toBeNull();
    expect(parseBasicCredentials("Basic %%%")).toBeNull();
  });
});

describe("validateCodeExchange", () => {
  const code = { clientId: "c1", redirectUri: "https://a.example/cb", codeChallenge: CHALLENGE, expiresAt: 1000 };
  const form = { code_verifier: VERIFIER, redirect_uri: "https://a.example/cb" };

  it("accepts a matching, unexpired code", async () => {
    expect(await validateCodeExchange(code, "c1", form, 999)).toEqual({ ok: true, code });
  });
  it.each([
    ["missing code", null, "c1", form, 999],
    ["expired", code, "c1", form, 1000],
    ["other client", code, "c2", form, 999],
    ["redirect_uri mismatch", code, "c1", { ...form, redirect_uri: "https://a.example/other" }, 999],
    ["wrong verifier", code, "c1", { ...form, code_verifier: VERIFIER.replace(/.$/, "x") }, 999],
  ] as const)("rejects %s as invalid_grant", async (_, c, clientId, f, now) => {
    const r = await validateCodeExchange(c, clientId, f, now);
    expect(r.ok ? null : r.error.error).toBe("invalid_grant");
  });
});
