/**
 * edane の MCP ツール。ノートの読み書きは application/noteEdits.ts（reducer 経由の純粋な
 * 変換）に任せ、ここは「引数を検証 → ノートを読む → 変換 → 保存 → 結果を文章で返す」だけ。
 */
import { CONTENT_FORMAT_VERSION, parseContent, serializeDocument } from "../application/persistence";
import { absoluteUrl } from "../lib/url";
import {
  applyNoteEdit,
  documentFromMarkdown,
  documentToOutline,
  nodesFromMarkdown,
  type NoteEdit,
} from "../application/noteEdits";
import { textResult, ToolInputError, type McpTool, type ToolResult } from "./protocol";
import type { NoteStore, StoredNote } from "./noteStore";

export interface ToolContext {
  userId: string;
  store: NoteStore;
  /** ノートの URL を組み立てる基点（例: https://edane.hashrock.info）。 */
  origin: string;
}

type Args = Record<string, unknown>;

function optionalString(args: Args, key: string): string | undefined {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") throw new ToolInputError(`${key} must be a string`);
  return v;
}

function requiredString(args: Args, key: string): string {
  const v = optionalString(args, key);
  if (v === undefined || v.trim() === "") throw new ToolInputError(`${key} is required`);
  return v;
}

const noteUrl = (ctx: ToolContext, id: string) => absoluteUrl(ctx.origin, `/notes/${id}/edit`);

/** 見つからない・復号できないは ToolInputError（isError の結果になる）。 */
async function loadNote(ctx: ToolContext, args: Args): Promise<StoredNote> {
  const noteId = requiredString(args, "noteId");
  const note = await ctx.store.load(ctx.userId, noteId);
  if (note === null) throw new ToolInputError(`Note not found: ${noteId}`);
  if (note === "decrypt-failed") throw new ToolInputError(`Note could not be decrypted: ${noteId}`);
  return note;
}

/** 読んで、編集を当てて、保存して、編集後のアウトラインを返す。 */
async function editNote(ctx: ToolContext, args: Args, edit: NoteEdit): Promise<ToolResult> {
  const note = await loadNote(ctx, args);
  const result = applyNoteEdit(parseContent(note.content, note.title), edit);
  if (!result.ok) throw new ToolInputError(result.error);
  await ctx.store.saveContent(ctx.userId, note, serializeDocument(result.document));
  const created = result.nodeIds ? `Added node ids: ${result.nodeIds.join(", ")}\n\n` : "";
  return textResult(`${created}${documentToOutline(result.document)}`);
}

const NOTE_ID = { type: "string", description: "list_notes で得たノートの id" };
const NODE_ID = { type: "string", description: "read_note のアウトラインで {id=…} に書かれたノードの id" };
const MARKDOWN = {
  type: "string",
  description:
    "追加するノード。Markdown の見出し / 箇条書き（2 スペースで 1 段深く）/ `- [ ] タスク` / 段落。1 行 = 1 ノード、コードブロックは 1 ノード。",
};

export const NOTE_TOOLS: McpTool<ToolContext>[] = [
  {
    name: "list_notes",
    title: "ノート一覧",
    description: "自分のノート（ゴミ箱を除く）を、ピン留め → 更新が新しい順に返す。query を渡すとタイトルの部分一致で絞り込む。",
    inputSchema: { type: "object", properties: { query: { type: "string", description: "タイトルの検索語（大文字小文字を区別しない）" } } },
    annotations: { readOnlyHint: true },
    async call(args, ctx) {
      const query = optionalString(args, "query")?.trim().toLowerCase();
      const all = await ctx.store.list(ctx.userId);
      const hits = query ? all.filter((n) => n.title.toLowerCase().includes(query)) : all;
      return textResult(JSON.stringify(hits.map((n) => ({ ...n, url: noteUrl(ctx, n.id) })), null, 2));
    },
  },
  {
    name: "read_note",
    title: "ノートを読む",
    description:
      "ノートの内容を返す。outline（既定）は 1 行 1 ノードの Markdown アウトラインで、各行末の {id=…} を編集ツールに渡す。json は保存形式（v2）そのもので、複数行の本文も省略しない。",
    inputSchema: {
      type: "object",
      properties: { noteId: NOTE_ID, format: { type: "string", enum: ["outline", "json"] } },
      required: ["noteId"],
    },
    annotations: { readOnlyHint: true },
    async call(args, ctx) {
      const format = optionalString(args, "format") ?? "outline";
      if (format !== "outline" && format !== "json") throw new ToolInputError("format must be outline or json");
      const note = await loadNote(ctx, args);
      const doc = parseContent(note.content, note.title);
      if (format === "json") {
        return textResult(JSON.stringify({ title: doc.title, version: CONTENT_FORMAT_VERSION, roots: doc.roots }, null, 2));
      }
      return textResult(`${documentToOutline(doc)}\n\n(updatedAt: ${note.updatedAt}, url: ${noteUrl(ctx, note.id)})`);
    },
  },
  {
    name: "create_note",
    title: "ノートを作る",
    description:
      "新しい非公開ノートを作る。markdown の最上位が 1 項目ならそれが木の根、複数ならタイトルを根にしてその下に並べる。",
    inputSchema: {
      type: "object",
      properties: { title: { type: "string" }, markdown: MARKDOWN },
      required: ["title"],
    },
    async call(args, ctx) {
      const title = requiredString(args, "title").trim();
      const doc = documentFromMarkdown(title, optionalString(args, "markdown") ?? "");
      const { id } = await ctx.store.create(ctx.userId, { title, content: serializeDocument(doc) });
      return textResult(`Created note ${id}\nurl: ${noteUrl(ctx, id)}\n\n${documentToOutline(doc)}`);
    },
  },
  {
    name: "rename_note",
    title: "ノートの名前を変える",
    description: "ノートのタイトルを変える。",
    inputSchema: { type: "object", properties: { noteId: NOTE_ID, title: { type: "string" } }, required: ["noteId", "title"] },
    annotations: { idempotentHint: true },
    async call(args, ctx) {
      const title = requiredString(args, "title").trim();
      const noteId = requiredString(args, "noteId");
      if (!(await ctx.store.rename(ctx.userId, noteId, title))) throw new ToolInputError(`Note not found: ${noteId}`);
      return textResult(`Renamed to "${title}"`);
    },
  },
  {
    name: "add_nodes",
    title: "ノードを追加",
    description:
      "ノードを追加する。parentId を渡すとその子の末尾に、afterId を渡すとそのノードの直後の兄弟に（ルートの直後なら子に）入る。どちらも無ければ最初の木の根の子の末尾。編集後のアウトラインを返す。",
    inputSchema: {
      type: "object",
      properties: { noteId: NOTE_ID, markdown: MARKDOWN, parentId: NODE_ID, afterId: NODE_ID },
      required: ["noteId", "markdown"],
    },
    async call(args, ctx) {
      const nodes = nodesFromMarkdown(requiredString(args, "markdown"));
      const parentId = optionalString(args, "parentId");
      const afterId = optionalString(args, "afterId");
      return editNote(ctx, args, { kind: "addNodes", nodes, parentId, afterId });
    },
  },
  {
    name: "update_node",
    title: "ノードを書き換え",
    description:
      "ノードの本文とチェックボックスを書き換える。checked: true = 完了、false = 未完了、null = チェックボックスを外す。省略した項目は変えない。",
    inputSchema: {
      type: "object",
      properties: {
        noteId: NOTE_ID,
        nodeId: NODE_ID,
        text: { type: "string" },
        checked: { type: ["boolean", "null"] },
      },
      required: ["noteId", "nodeId"],
    },
    annotations: { idempotentHint: true },
    async call(args, ctx) {
      const nodeId = requiredString(args, "nodeId");
      const text = optionalString(args, "text");
      const raw = args.checked;
      if (raw !== undefined && raw !== null && typeof raw !== "boolean") {
        throw new ToolInputError("checked must be true, false or null");
      }
      const checked = raw as boolean | null | undefined;
      if (text === undefined && checked === undefined) throw new ToolInputError("Give text and/or checked");
      return editNote(ctx, args, { kind: "updateNode", nodeId, text, checked });
    },
  },
  {
    name: "delete_node",
    title: "ノードを削除",
    description: "ノードをサブツリーごと削除する。最後の木の根を消すと空の根が 1 つ残る。",
    inputSchema: { type: "object", properties: { noteId: NOTE_ID, nodeId: NODE_ID }, required: ["noteId", "nodeId"] },
    annotations: { destructiveHint: true },
    async call(args, ctx) {
      const nodeId = requiredString(args, "nodeId");
      return editNote(ctx, args, { kind: "deleteNode", nodeId });
    },
  },
];
