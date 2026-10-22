/**
 * リモート MCP サーバー（`POST /mcp`、Streamable HTTP の stateless 版）。仕様は docs/mcp.md。
 *
 * 認証は `Authorization: Bearer <トークン>` だけ。トークンは設定画面で発行する API トークンか、
 * OAuth（app/oauth/、ChatGPT や claude.ai のコネクタ用）で発行したアクセストークン。
 * トークンが無い・無効なときの 401 は resource_metadata を示し、OAuth クライアントに認可サーバーを見つけさせる。
 * セッション Cookie は読まないので、server.ts は認証ミドルウェアより前に mount する
 * （Cookie で通ると、別サイトからのフォーム送信でノートを書き換えられてしまう）。
 * Bearer はブラウザが勝手に付けないので、CORS はどのオリジンにも開けてよい。
 */
import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import { bodyLimit } from "hono/body-limit";
import type { Env } from "../global.d";
import { getUserIdByToken } from "../utils/apiToken";
import { getUserIdByOAuthAccessToken } from "../utils/oauthToken";
import { ACCESS_TOKEN_PREFIX, mcpChallenge } from "../oauth/protocol";
import { handleMessage, PARSE_ERROR, INVALID_REQUEST } from "./protocol";
import { NOTE_TOOLS, type ToolContext } from "./tools";
import { d1NoteStore, type NoteStore } from "./noteStore";

export interface McpDeps {
  /** Bearer トークンの持ち主。null = 401。 */
  resolveUserId(c: Context<Env>): Promise<string | null>;
  store(env: Env["Bindings"]): NoteStore;
}

/** 接頭辞で API トークンか OAuth のアクセストークンかを分け、どちらも 1 回の検索で済ませる。 */
async function resolveBearer(c: Context<Env>): Promise<string | null> {
  const token = c.req.header("Authorization")?.match(/^Bearer (.+)$/)?.[1];
  if (token?.startsWith(ACCESS_TOKEN_PREFIX)) return getUserIdByOAuthAccessToken(c, token);
  return getUserIdByToken(c);
}

const defaultDeps: McpDeps = {
  resolveUserId: resolveBearer,
  store: d1NoteStore,
};

/** 1 リクエストに詰められる JSON-RPC メッセージの上限（旧版のバッチ用）。 */
const MAX_BATCH = 20;
/**
 * 要求本文の上限（バイト）。Bearer 必須でも、誤動作したクライアントや漏れたトークンが
 * Worker のメモリを食い潰さないように、読む前に切る。ツールごとの文字数の上限は tools.ts。
 */
export const MAX_BODY_BYTES = 1024 * 1024;

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

  r.post(
    "/",
    bodyLimit({ maxSize: MAX_BODY_BYTES, onError: (c) => c.json({ error: "Payload Too Large" }, 413) }),
    async (c) => {
      c.header("Cache-Control", "no-store");
      const userId = await deps.resolveUserId(c);
      if (!userId) {
        const origin = new URL(c.req.url).origin;
        c.header("WWW-Authenticate", mcpChallenge(origin, !!c.req.header("Authorization")));
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
    }
  );

  // サーバーから送るもの（SSE）もセッションも無い。
  const notAllowed = (c: Context<Env>) => {
    c.header("Allow", "POST");
    return c.json({ error: "Method Not Allowed" }, 405);
  };
  r.get("/", notAllowed);
  r.delete("/", notAllowed);

  return r;
}
