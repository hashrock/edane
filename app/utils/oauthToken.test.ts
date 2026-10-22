import { it, expect } from "vitest";
import { mcpChallenge } from "./oauthToken";

const ORIGIN = "https://edane.example";

it("mcpChallenge points at the resource metadata", () => {
  expect(mcpChallenge(ORIGIN, true)).toBe(
    `Bearer realm="edane", resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/mcp", error="invalid_token"`
  );
});
