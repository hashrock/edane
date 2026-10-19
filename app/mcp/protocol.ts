/**
 * MCP の JSON-RPC 層（Streamable HTTP の stateless 版）。HTTP にも DB にも依存しない:
 * 1 メッセージ → 応答（通知なら null）を返すだけで、ツールの中身は {@link McpTool} として渡される。
 *
 * セッション（`Mcp-Session-Id`）も SSE も持たない。サーバーから能動的に送るものが無いので、
 * POST 1 回 = 応答 1 回で足りる。
 */

export const SERVER_INFO = { name: "edane", version: "1.0.0" } as const;

/** 新しい順。クライアントが送ってきた版が分かればそれ、分からなければ先頭で答える（仕様の版交渉）。 */
export const SUPPORTED_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"] as const;

export const INSTRUCTIONS = [
  "edane はマインドマップ / アウトラインのノートアプリ。ノートはノードの木（複数の木も可）。",
  "編集の前に read_note でアウトラインを読み、行末の {id=…} でノードを指定する。",
  "ノードの追加は Markdown（見出し・箇条書き・`- [ ]` タスク）で渡す。インデント 2 スペースで 1 段深くなる。",
].join("\n");

export type JsonSchema = { type: "object"; properties: Record<string, unknown>; required?: string[] };

export type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

export interface McpTool<Ctx> {
  name: string;
  title: string;
  description: string;
  inputSchema: JsonSchema;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean };
  call(args: Record<string, unknown>, ctx: Ctx): Promise<ToolResult>;
}

/** ツールが「呼び方が間違っている」を伝えるための例外。isError のツール結果になる。 */
export class ToolInputError extends Error {}

export const textResult = (text: string): ToolResult => ({ content: [{ type: "text", text }] });
export const errorResult = (text: string): ToolResult => ({ content: [{ type: "text", text }], isError: true });

type Id = string | number;
type JsonRpcResponse =
  | { jsonrpc: "2.0"; id: Id | null; result: unknown }
  | { jsonrpc: "2.0"; id: Id | null; error: { code: number; message: string } };

export const PARSE_ERROR = -32700;
export const INVALID_REQUEST = -32600;
export const METHOD_NOT_FOUND = -32601;
export const INVALID_PARAMS = -32602;
export const INTERNAL_ERROR = -32603;

const fail = (id: Id | null, code: number, message: string): JsonRpcResponse => ({
  jsonrpc: "2.0",
  id,
  error: { code, message },
});

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * JSON-RPC メッセージ 1 件を処理する。通知（id なし）とクライアントからの応答には null
 * （HTTP 層は 202 を返す）。ツールが投げた例外は内部エラーではなく isError の結果として返す
 * ので、エージェントは読んで呼び直せる。
 */
export async function handleMessage<Ctx>(
  message: unknown,
  tools: readonly McpTool<Ctx>[],
  ctx: Ctx
): Promise<JsonRpcResponse | null> {
  if (!isObject(message) || message.jsonrpc !== "2.0") return fail(null, INVALID_REQUEST, "Invalid Request");
  const hasId = "id" in message && (typeof message.id === "string" || typeof message.id === "number");
  if (typeof message.method !== "string") {
    // クライアントからの応答（result / error）。こちらから要求は出さないので捨てる。
    return hasId && ("result" in message || "error" in message) ? null : fail(null, INVALID_REQUEST, "Invalid Request");
  }
  if (!hasId) return null; // 通知（notifications/initialized など）は受け取るだけ
  const id = message.id as Id;
  const params = isObject(message.params) ? message.params : {};
  const ok = (result: unknown): JsonRpcResponse => ({ jsonrpc: "2.0", id, result });

  switch (message.method) {
    case "initialize": {
      const requested = params.protocolVersion;
      const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.find((v) => v === requested) ?? SUPPORTED_PROTOCOL_VERSIONS[0];
      return ok({
        protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: INSTRUCTIONS,
      });
    }
    case "ping":
      return ok({});
    case "tools/list":
      return ok({
        tools: tools.map(({ name, title, description, inputSchema, annotations }) => ({
          name,
          title,
          description,
          inputSchema,
          ...(annotations && { annotations }),
        })),
      });
    case "tools/call": {
      const tool = tools.find((t) => t.name === params.name);
      if (!tool) return fail(id, INVALID_PARAMS, `Unknown tool: ${String(params.name)}`);
      const args = isObject(params.arguments) ? params.arguments : {};
      try {
        return ok(await tool.call(args, ctx));
      } catch (e) {
        if (e instanceof ToolInputError) return ok(errorResult(e.message));
        return fail(id, INTERNAL_ERROR, "Internal error");
      }
    }
    default:
      return fail(id, METHOD_NOT_FOUND, `Method not found: ${message.method}`);
  }
}
