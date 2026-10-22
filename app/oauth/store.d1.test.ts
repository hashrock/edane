/** d1OAuthStore's SQL against the migrated schema: refresh rotation and reuse revocation. */
import { describe, it, expect } from "vitest";
import { drizzle } from "drizzle-orm/d1";
import type { Env } from "../global.d";
import { sqliteD1 } from "../../vitest.d1";
import { insertUser } from "../utils/userRepository";
import { d1OAuthStore } from "./store";

const pair = (n: number) => ({
  accessTokenHash: `a${n}`,
  accessExpiresAt: 10_000,
  refreshTokenHash: `r${n}`,
  refreshExpiresAt: 10_000,
});

describe("d1OAuthStore refresh rotation", () => {
  it("rotates once, then treats the replaced refresh token as leaked and revokes the grant", async () => {
    const env = { DB: sqliteD1() } as Env["Bindings"];
    await insertUser(drizzle(env.DB), { id: "u", email: "u@example.com", name: "U", avatarUrl: "" });
    const store = d1OAuthStore(env);
    await store.createClient({ id: "c", name: "C", redirectUris: ["https://c.example/cb"], secretHash: null }, { now: 0, unauthorizedClientsBefore: 0 });
    await store.createGrant({ id: "g", clientId: "c", userId: "u", scope: "notes", ...pair(1) }, 0);

    expect(await store.rotateGrant("r1", "c", pair(2), 0)).toEqual({ scope: "notes" });
    // r1 is spent: rotating with it fails, and presenting it revokes the grant (r2 dies with it).
    expect(await store.rotateGrant("r1", "c", pair(3), 0)).toBeNull();
    expect(await store.revokeOnRefreshReuse("r1", "other-client")).toBe(false);
    expect(await store.revokeOnRefreshReuse("r1", "c")).toBe(true);
    expect(await store.rotateGrant("r2", "c", pair(3), 0)).toBeNull();
    expect(await store.listGrants("u", 0)).toEqual([]);
  });
});
