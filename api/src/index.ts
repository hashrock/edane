import { Hono } from "hono";
import { cors } from "hono/cors";
import { getSession } from "./utils/session";
import { getUserByToken } from "./utils/apiToken";
import { drizzle } from "drizzle-orm/d1";
import { users } from "./db/schema";
import { eq } from "drizzle-orm";
import { auth } from "./routes/auth";
import { notesApi } from "./routes/notes";
import { tokensApi } from "./routes/tokens";
import type { Env } from "./global.d";

const DEV_USER = {
  id: "dev-user",
  email: "dev@localhost",
  name: "Dev User",
  avatarUrl: "",
};

const app = new Hono<Env>();

// CORS for local dev
app.use(
  "/api/*",
  cors({ origin: "http://localhost:5173", credentials: true })
);
app.use(
  "/auth/*",
  cors({ origin: "http://localhost:5173", credentials: true })
);

// Session middleware
app.use("*", async (c, next) => {
  if (c.env.DEV_BYPASS_AUTH) {
    const db = drizzle(c.env.DB);
    const existing = await db
      .select()
      .from(users)
      .where(eq(users.id, DEV_USER.id))
      .get();
    if (!existing) {
      await db.insert(users).values({
        id: DEV_USER.id,
        email: DEV_USER.email,
        name: DEV_USER.name,
        avatarUrl: DEV_USER.avatarUrl,
      });
    }
    c.set("user", DEV_USER);
    await next();
    return;
  }

  // Try session cookie first, then Bearer token
  const user = (await getSession(c)) || (await getUserByToken(c));
  c.set("user", user);
  await next();
});

app.route("/auth", auth);
app.route("/api/notes", notesApi);
app.route("/api/tokens", tokensApi);

// Serve static assets, with SPA fallback to index.html
app.get("*", async (c) => {
  const path = new URL(c.req.url).pathname;
  // Paths with file extensions → serve as static asset
  if (path.includes(".")) {
    return c.env.ASSETS.fetch(c.req.raw);
  }
  // All other paths → SPA fallback
  return c.env.ASSETS.fetch(
    new URL("/index.html", c.req.url).toString()
  );
});

export default app;
