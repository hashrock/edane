import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { securityHeaders, BASELINE_CSP } from "./securityHeaders";

describe("securityHeaders", () => {
  const app = new Hono();
  app.use("*", securityHeaders);
  app.get("/page", (c) => c.html("<p>hi</p>"));
  app.get("/sandboxed", (c) => {
    c.header("Content-Security-Policy", "sandbox");
    return c.text("x");
  });
  app.get("/passthrough", () => Response.redirect("https://example.com/", 302));

  it("adds the baseline to a page", async () => {
    const res = await app.request("/page");
    expect(res.headers.get("Content-Security-Policy")).toBe(BASELINE_CSP);
    expect(BASELINE_CSP).toContain("frame-ancestors 'self'");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });

  it("keeps a route's own stricter CSP", async () => {
    const res = await app.request("/sandboxed");
    expect(res.headers.get("Content-Security-Policy")).toBe("sandbox");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });

  it("copies a response whose headers are immutable", async () => {
    const res = await app.request("/passthrough");
    expect(res.status).toBe(302);
    expect(res.headers.get("Content-Security-Policy")).toBe(BASELINE_CSP);
  });
});
