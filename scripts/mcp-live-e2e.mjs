#!/usr/bin/env node
/**
 * リモート MCP（POST /mcp）と開いているエディタの同期を、実通信で確かめる。
 * Claude Code（`claude -p`）が MCP ツールでノートを編集し、それがリロードなしで
 * エディタに届くこと、エディタの編集と併合されることを見る。
 *
 * 前提: ローカルの dev サーバー（DEV_BYPASS_AUTH=1 の .dev.vars、`pnpm migrate` 済み）と
 * PATH 上の `claude`。
 *
 *   pnpm dev --port 5199 --strictPort &
 *   node scripts/mcp-live-e2e.mjs            # EDANE_BASE_URL で接続先を変えられる
 *
 * MCP の設定は一時ファイルを --mcp-config で渡すだけで、Claude Code の設定には書かない。
 * 実行のたびにテスト用のノートと API トークンがローカルの D1 に1つずつ増える。
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";

const base = process.env.EDANE_BASE_URL ?? "http://localhost:5199";
const failures = [];
function check(label, ok, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures.push(label);
}

// dev の認証バイパスでログイン済みとして扱われるので、そのままトークンを発行できる。
const tokenRes = await fetch(`${base}/api/tokens`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Origin: base },
  body: JSON.stringify({ name: "mcp-live-e2e" }),
});
if (!tokenRes.ok) throw new Error(`token issue failed: ${tokenRes.status} (is the dev server running at ${base}?)`);
const { token } = await tokenRes.json();

const postMcp = (body) =>
  fetch(`${base}/mcp`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
const callMcp = async (name, args) =>
  (await postMcp({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } })).json();
async function mcp(name, args) {
  const { result, error } = await callMcp(name, args);
  if (error || result.isError) throw new Error(`${name}: ${error?.message ?? result.content[0].text}`);
  return result.content[0].text;
}
const nodeId = (outline, text) => outline.match(new RegExp(`- ${text} \\{id=([^}]+)\\}`))[1];
const createNote = async (title, markdown) => {
  const text = await mcp("create_note", { title, markdown });
  return { noteId: text.match(/Created note (\S+)/)[1], text };
};

const dir = mkdtempSync(join(tmpdir(), "edane-mcp-e2e-"));
const mcpConfig = join(dir, "mcp.json");
writeFileSync(
  mcpConfig,
  JSON.stringify({ mcpServers: { edane: { type: "http", url: `${base}/mcp`, headers: { Authorization: `Bearer ${token}` } } } })
);
function runClaude(prompt, tools) {
  const child = spawn(
    "claude",
    ["-p", prompt, "--mcp-config", mcpConfig, "--strict-mcp-config", "--allowedTools", tools.map((t) => `mcp__edane__${t}`).join(",")],
    { stdio: ["ignore", "pipe", "inherit"] }
  );
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  return new Promise((resolve) => child.on("close", (code) => resolve({ code, out: out.trim() })));
}

const browser = await chromium.launch();
// 狭いビューポートはアウトライン表示になり、本文が DOM のテキストとして読める。
const page = await browser.newPage({ viewport: { width: 600, height: 900 } });
const bodyHas = (texts, timeout = 10000) =>
  page
    .waitForFunction((ts) => ts.every((t) => document.body.innerText.includes(t)), texts, { timeout })
    .then(() => true, () => false);
const outlineText = async () => (await page.innerText('[data-testid="outline-view"]')).replace(/\n+/g, " | ");

try {
  // 0) 入力の上限: 大きすぎる本文は読まずに 413、長すぎる・未知の引数はツールのエラー。
  //    どれも後続の通常の呼び出しを妨げない。
  {
    const { noteId, text } = await createNote("上限テスト", "- 根\n  - 子");
    const huge = await postMcp(`{"jsonrpc":"2.0","id":1,"method":"ping","pad":"${"x".repeat(2 * 1024 * 1024)}"}`);
    check("an over-limit body is refused with 413", huge.status === 413, String(huge.status));
    const long = await callMcp("update_node", { noteId, nodeId: nodeId(text, "子"), text: "x".repeat(100_001) });
    check("an over-long field is a tool error", long.result?.isError === true, long.result?.content[0].text);
    const unknown = await callMcp("update_node", { noteId, nodeId: nodeId(text, "子"), text: "y", colour: "red" });
    check("an unknown argument is a tool error", unknown.result?.isError === true, unknown.result?.content[0].text);
    const read = await mcp("read_note", { noteId });
    check("the note is unchanged and the server still answers", read.includes("- 子 {id="), read.split("\n")[2]);
  }

  // 0b) NoteRoom が読み取りの正本: read_note の updatedAt は同期 API の snapshot と同じ行のもの。
  //     編集で version と updatedAt が進み、ゴミ箱に入れたノートは見つからない扱いになる。
  {
    const { noteId, text } = await createNote("正本テスト", "- 根\n  - 子");
    const syncSnapshot = async () => {
      const res = await fetch(`${base}/api/notes/${noteId}/sync`);
      return res.ok ? res.json() : { status: res.status };
    };
    const updatedAtOf = (outline) => outline.match(/updatedAt: ([^,]+),/)[1];
    const before = await syncSnapshot();
    check("read_note reports the snapshot's updatedAt", updatedAtOf(await mcp("read_note", { noteId })) === before.updatedAt, before.updatedAt);
    await mcp("update_node", { noteId, nodeId: nodeId(text, "子"), text: "子（更新）" });
    const after = await syncSnapshot();
    check(
      "an edit advances version and updatedAt together",
      after.version === before.version + 1 && after.updatedAt > before.updatedAt && updatedAtOf(await mcp("read_note", { noteId })) === after.updatedAt,
      `v${before.version}→v${after.version}`
    );
    await fetch(`${base}/notes/${noteId}/trash`, { method: "POST", headers: { Origin: base }, redirect: "manual" });
    const trashed = await callMcp("update_node", { noteId, nodeId: nodeId(text, "子"), text: "x" });
    check("a trashed note is not found by MCP", trashed.result?.content[0].text === `Note not found: ${noteId}`, trashed.result?.content[0].text);
    check("a trashed note is 404 on the sync API", (await syncSnapshot()).status === 404);
  }

  // 1) Claude Code → MCP → 開いているエディタ（リロードしない）
  {
    const { noteId } = await createNote("MCP同期テスト", "- 買い物\n  - 牛乳");
    await page.goto(`${base}/notes/${noteId}/edit`);
    await bodyHas(["牛乳"]);
    const { code, out } = await runClaude(
      `edane MCP のノート ${noteId} を read_note で読み、「買い物」の子の末尾に「卵」と「パン」を add_nodes で追加し、` +
        `「牛乳」の本文を update_node で「低脂肪乳」に変えてください。終わったら最終的なアウトラインだけを出力してください。`,
      ["read_note", "add_nodes", "update_node"]
    );
    check("claude -p exits 0", code === 0, out.replace(/\n/g, " | "));
    check("Claude's edits reach the open editor without reload", await bodyHas(["低脂肪乳", "卵", "パン"]), await outlineText());
  }

  // 2) エディタ → MCP、3) 編集中に MCP が別ノードを書き換えても入力が途切れない
  {
    const { noteId, text } = await createNote("同時編集テスト", "- 根\n  - アルファ\n  - ベータ");
    await page.goto(`${base}/notes/${noteId}/edit`);
    await bodyHas(["ベータ"]);

    await page.getByText("アルファ", { exact: true }).click();
    await page.keyboard.press("End");
    await page.keyboard.type("を編集中");
    await mcp("update_node", { noteId, nodeId: nodeId(text, "ベータ"), text: "ベータ（MCPで更新）" });
    check("MCP edit appears while the browser is editing", await bodyHas(["ベータ（MCPで更新）"]));
    const focused = await page.evaluate(() => document.activeElement?.value ?? null);
    check("the in-progress text survives the remote edit", focused === "アルファを編集中", JSON.stringify(focused));

    await page.keyboard.type("、続けて入力");
    await page.keyboard.press("Escape");
    await page.waitForTimeout(1000);
    const read = await mcp("read_note", { noteId });
    check(
      "read_note sees both the browser's and MCP's edits",
      read.includes("アルファを編集中、続けて入力") && read.includes("ベータ（MCPで更新）"),
      read.split("\n").slice(0, 4).join(" | ")
    );

    await page.reload();
    await page.waitForSelector('[data-testid="outline-view"]');
    check("both edits persist across reload", await bodyHas(["アルファを編集中、続けて入力", "ベータ（MCPで更新）"]), await outlineText());
  }
} finally {
  await browser.close();
  rmSync(dir, { recursive: true, force: true });
}

if (failures.length) {
  console.error(`\n${failures.length} check(s) failed`);
  process.exit(1);
}
console.log("\nall checks passed");
