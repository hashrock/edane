import { describe, expect, it } from "vitest";
import type { Env } from "../global.d";
import { aiSuggestAllowed } from "./aiQuota";

/** wrangler の simple ratelimit（期間内の回数）を真似た、キーごとのカウンタ。 */
function fakeEnv(limit: number) {
  const counts = new Map<string, number>();
  const AI_SUGGEST_LIMITER = {
    async limit({ key }: { key: string }) {
      const n = (counts.get(key) ?? 0) + 1;
      counts.set(key, n);
      return { success: n <= limit };
    },
  };
  return { AI_SUGGEST_LIMITER } as unknown as Env["Bindings"];
}

describe("aiSuggestAllowed", () => {
  it("allows up to the limit per user, then refuses that user only", async () => {
    const env = fakeEnv(10);
    for (let i = 0; i < 10; i++) expect(await aiSuggestAllowed(env, "alice")).toBe(true);
    expect(await aiSuggestAllowed(env, "alice")).toBe(false);
    expect(await aiSuggestAllowed(env, "bob")).toBe(true);
  });
});
