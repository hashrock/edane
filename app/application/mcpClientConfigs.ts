/**
 * Remote MCP (POST /mcp) の接続設定例を、クライアントごとの書式で作る。
 * 設定画面がトークン発行直後にそのまま貼れる形で表示し、docs/mcp.md も同じ書式を載せる。
 * どのクライアントも「URL + Authorization: Bearer <token> ヘッダー」を登録するだけで、
 * 違うのはキー名（url / serverUrl / httpUrl）と置き場所だけ。
 */

export type McpClientId =
  | "claude-code"
  | "claude-desktop"
  | "cursor"
  | "vscode"
  | "windsurf"
  | "codex"
  | "gemini";

export interface McpClientConfig {
  id: McpClientId;
  label: string;
  /** 設定を書くファイル。コマンドで登録するクライアントは null。 */
  file: string | null;
  snippet: string;
}

const json = (value: unknown) => JSON.stringify(value, null, 2);

export function mcpClientConfigs(url: string, token: string): McpClientConfig[] {
  const authorization = `Bearer ${token}`;
  const headers = { Authorization: authorization };
  return [
    {
      id: "claude-code",
      label: "Claude Code",
      file: null,
      snippet: `claude mcp add --transport http edane ${url} --header "Authorization: ${authorization}"`,
    },
    {
      // Claude Desktop のカスタムコネクタはヘッダーを付けられないので、
      // stdio ↔ HTTP の橋渡し（mcp-remote）を挟む。ヘッダー値は空白を含むので env で渡す。
      id: "claude-desktop",
      label: "Claude Desktop",
      file: "claude_desktop_config.json",
      snippet: json({
        mcpServers: {
          edane: {
            command: "npx",
            args: ["-y", "mcp-remote", url, "--header", "Authorization:${EDANE_AUTH}"],
            env: { EDANE_AUTH: authorization },
          },
        },
      }),
    },
    {
      id: "cursor",
      label: "Cursor",
      file: "~/.cursor/mcp.json",
      snippet: json({ mcpServers: { edane: { url, headers } } }),
    },
    {
      id: "vscode",
      label: "VS Code",
      file: ".vscode/mcp.json",
      snippet: json({ servers: { edane: { type: "http", url, headers } } }),
    },
    {
      id: "windsurf",
      label: "Windsurf",
      file: "~/.codeium/windsurf/mcp_config.json",
      snippet: json({ mcpServers: { edane: { serverUrl: url, headers } } }),
    },
    {
      id: "codex",
      label: "Codex CLI",
      file: "~/.codex/config.toml",
      snippet: [
        "[mcp_servers.edane]",
        `url = ${JSON.stringify(url)}`,
        `http_headers = { Authorization = ${JSON.stringify(authorization)} }`,
      ].join("\n"),
    },
    {
      id: "gemini",
      label: "Gemini CLI",
      file: "~/.gemini/settings.json",
      snippet: json({ mcpServers: { edane: { httpUrl: url, headers } } }),
    },
  ];
}
