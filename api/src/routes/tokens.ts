import { Hono } from "hono";
import { drizzle } from "drizzle-orm/d1";
import { apiTokens } from "../db/schema";
import { eq } from "drizzle-orm";
import { hashToken } from "../utils/apiToken";
import type { Env } from "../global.d";

const tokensApi = new Hono<Env>();

// POST /api/tokens — create a new API token
tokensApi.post("/", async (c) => {
  const user = c.get("user");
  if (!user) return c.json({ error: "Unauthorized" }, 401);

  const body = await c.req.json<{ name?: string }>().catch(() => ({}));
  const rawToken = `edane_${crypto.randomUUID().replace(/-/g, "")}`;
  const hash = await hashToken(rawToken);
  const id = crypto.randomUUID();

  const db = drizzle(c.env.DB);
  await db.insert(apiTokens).values({
    id,
    userId: user.id,
    name: body.name || "default",
    tokenHash: hash,
    createdAt: new Date().toISOString(),
  });

  // Return the raw token only once — it cannot be retrieved later
  return c.json({ id, token: rawToken, name: body.name || "default" }, 201);
});

// GET /api/tokens — list user's tokens (without the raw token)
tokensApi.get("/", async (c) => {
  const user = c.get("user");
  if (!user) return c.json({ error: "Unauthorized" }, 401);

  const db = drizzle(c.env.DB);
  const tokens = await db
    .select({ id: apiTokens.id, name: apiTokens.name, createdAt: apiTokens.createdAt })
    .from(apiTokens)
    .where(eq(apiTokens.userId, user.id));

  return c.json(tokens);
});

// DELETE /api/tokens/:id — revoke a token
tokensApi.delete("/:id", async (c) => {
  const user = c.get("user");
  if (!user) return c.json({ error: "Unauthorized" }, 401);

  const id = c.req.param("id");
  const db = drizzle(c.env.DB);

  const token = await db
    .select()
    .from(apiTokens)
    .where(eq(apiTokens.id, id))
    .get();
  if (!token || token.userId !== user.id) {
    return c.json({ error: "Not found" }, 404);
  }

  await db.delete(apiTokens).where(eq(apiTokens.id, id));
  return c.json({ ok: true });
});

export { tokensApi };
