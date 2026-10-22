import { describe, expect, it } from "vitest";
import { mcpClientConfigs } from "./mcpClientConfigs";

const URL = "https://edane.example/mcp";
const TOKEN = "edane_abc";

describe("mcpClientConfigs", () => {
  const configs = mcpClientConfigs(URL, TOKEN);

  it("ids are unique", () => {
    const ids = configs.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("every snippet carries the URL and the bearer token", () => {
    for (const c of configs) {
      expect(c.snippet, c.id).toContain(URL);
      expect(c.snippet, c.id).toContain(`Bearer ${TOKEN}`);
    }
  });

  it("JSON snippets parse", () => {
    for (const c of configs) {
      if (c.file?.endsWith(".json")) expect(() => JSON.parse(c.snippet), c.id).not.toThrow();
    }
  });

  it("Claude Code is a one-line command", () => {
    expect(configs[0]).toMatchObject({ id: "claude-code", file: null });
    expect(configs[0].snippet).toBe(
      `claude mcp add --transport http edane ${URL} --header "Authorization: Bearer ${TOKEN}"`
    );
  });

  it("VS Code uses the servers key with type http", () => {
    const vscode = configs.find((c) => c.id === "vscode")!;
    expect(JSON.parse(vscode.snippet)).toEqual({
      servers: { edane: { type: "http", url: URL, headers: { Authorization: `Bearer ${TOKEN}` } } },
    });
  });
});
