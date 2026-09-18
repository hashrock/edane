import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import type { Env } from "../global.d";
import { resolveStatsAccess, statsRoutes, type StatsDeps } from "./index";

const TOKEN = "dev-stats-token";
const NOW = new Date("2026-09-18T12:00:00.000Z");

function request(env: Partial<Env["Bindings"]>, headers: Record<string, string> = {}) {
  const count = vi.fn<StatsDeps["count"]>(async () => ({ total: 3, new_7d: 1, new_30d: 2 }));
  const app = new Hono<Env>().route("/api/stats", statsRoutes({ now: () => NOW, count }));
  const res = app.request("/api/stats", { headers }, env as Env["Bindings"]);
  return { res, count };
}

describe("resolveStatsAccess", () => {
  it("is disabled when STATS_TOKEN is unset or empty, whatever the header", async () => {
    expect(await resolveStatsAccess(undefined, `Bearer ${TOKEN}`)).toBe("disabled");
    expect(await resolveStatsAccess("", "Bearer ")).toBe("disabled");
  });

  it("accepts only the exact Bearer token", async () => {
    expect(await resolveStatsAccess(TOKEN, `Bearer ${TOKEN}`)).toBe("ok");
    expect(await resolveStatsAccess(TOKEN, `Bearer ${TOKEN}x`)).toBe("unauthorized");
    expect(await resolveStatsAccess(TOKEN, `Bearer ${TOKEN.slice(0, -1)}`)).toBe("unauthorized");
    expect(await resolveStatsAccess(TOKEN, TOKEN)).toBe("unauthorized");
    expect(await resolveStatsAccess(TOKEN, `Basic ${TOKEN}`)).toBe("unauthorized");
    expect(await resolveStatsAccess(TOKEN, undefined)).toBe("unauthorized");
  });
});

describe("GET /api/stats", () => {
  it("404s when STATS_TOKEN is not configured, without touching the DB", async () => {
    const { res, count } = request({}, { Authorization: `Bearer ${TOKEN}` });
    expect((await res).status).toBe(404);
    expect(count).not.toHaveBeenCalled();
  });

  it("401s on a mismatched or missing token, without touching the DB", async () => {
    for (const headers of [{ Authorization: "Bearer wrong" }, {}] as Record<string, string>[]) {
      const { res, count } = request({ STATS_TOKEN: TOKEN }, headers);
      const r = await res;
      expect(r.status).toBe(401);
      expect(r.headers.get("Cache-Control")).toBe("no-store");
      expect(count).not.toHaveBeenCalled();
    }
  });

  it("returns the counts as of the injected now, uncached", async () => {
    const { res, count } = request({ STATS_TOKEN: TOKEN }, { Authorization: `Bearer ${TOKEN}` });
    const r = await res;
    expect(r.status).toBe(200);
    expect(r.headers.get("Cache-Control")).toBe("no-store");
    expect(await r.json()).toEqual({
      service: "edane",
      generated_at: "2026-09-18T12:00:00.000Z",
      users: { total: 3, new_7d: 1, new_30d: 2 },
    });
    expect(count.mock.calls[0][1]).toBe(NOW);
  });
});
