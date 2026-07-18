import { describe, expect, it } from "vitest";
import { hashToken } from "./tokenHash";

describe("hashToken", () => {
  it("returns the SHA-256 hex digest of the input", async () => {
    // sha256("hello") — verified against a reference implementation.
    expect(await hashToken("hello")).toBe(
      "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"
    );
  });

  it("is deterministic for the same input", async () => {
    expect(await hashToken("my-secret-token")).toBe(
      await hashToken("my-secret-token")
    );
  });

  it("produces different hashes for different inputs", async () => {
    expect(await hashToken("token-a")).not.toBe(await hashToken("token-b"));
  });
});
