/**
 * リモート MCP サーバー（`POST /mcp`、Streamable HTTP の stateless 版）。仕様は docs/mcp.md。
 *
 * 認証は `Authorization: Bearer <API トークン>`（設定画面で発行するもの）だけ。
 * セッション Cookie は読まないので、server.ts は認証ミドルウェアより前に mount する
 * （Cookie で通ると、別サイトからのフォーム送信でノートを書き換えられてしまう）。
 * Bearer はブラウザが勝手に付けないので、CORS はどのオリジンにも開けてよい。
 */
import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import type { Env } from "../global.d";
import { getUserIdByToken } from "../utils/apiToken";
import { handleMessage, PARSE_ERROR, INVALID_REQUEST } from "./protocol";
import { NOTE_TOOLS, type ToolContext } from "./tools";
import { d1NoteStore, type NoteStore } from "./noteStore";

export interface McpDeps {
  /** Bearer トークンの持ち主。null = 401。 */
  resolveUserId(c: Context<Env>): Promise<string | null>;
  store(env: Env["Bindings"]): NoteStore;
}

const defaultDeps: McpDeps = {
  resolveUserId: getUserIdByToken,
  store: d1NoteStore,
};

/** 1 リクエストに詰められる JSON-RPC メッセージの上限（旧版のバッチ用）。 */
const MAX_BATCH = 20;

export function mcpRoutes(deps: McpDeps = defaultDeps) {
  const r = new Hono<Env>();

  r.use(
    "*",
    cors({
      origin: "*",
      allowMethods: ["POST", "GET", "DELETE", "OPTIONS"],
      allowHeaders: ["Authorization", "Content-Type", "Accept", "Mcp-Protocol-Version", "Mcp-Session-Id"],
      exposeHeaders: ["WWW-Authenticate"],
    })
  );

  r.post("/", async (c) => {
    c.header("Cache-Control", "no-store");
    const userId = await deps.resolveUserId(c);
    if (!userId) {
      c.header("WWW-Authenticate", 'Bearer realm="edane"');
      return c.json({ error: "Unauthorized" }, 401);
    }

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ jsonrpc: "2.0", id: null, error: { code: PARSE_ERROR, message: "Parse error" } }, 400);
    }

    const ctx: ToolContext = { userId, store: deps.store(c.env), origin: new URL(c.req.url).origin };

    const batch = Array.isArray(body);
    const messages = batch ? (body as unknown[]) : [body];
    if (messages.length === 0 || messages.length > MAX_BATCH) {
      return c.json({ jsonrpc: "2.0", id: null, error: { code: INVALID_REQUEST, message: "Invalid Request" } }, 400);
    }
    // In order: a later message in a batch may edit what an earlier one made.
    const responses = [];
    for (const m of messages) {
      const res = await handleMessage(m, NOTE_TOOLS, ctx);
      if (res) responses.push(res);
    }
    if (responses.length === 0) return c.body(null, 202);
    return c.json(batch ? responses : responses[0]);
  });

  // サーバーから送るもの（SSE）もセッションも無い。
  const notAllowed = (c: Context<Env>) => {
    c.header("Allow", "POST");
    return c.json({ error: "Method Not Allowed" }, 405);
  };
  r.get("/", notAllowed);
  r.delete("/", notAllowed);

  return r;
}
