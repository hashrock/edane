/**
 * POST /mcp の契約: Bearer 必須、JSON-RPC の initialize / tools/list / tools/call、
 * 通知は 202、ツールの誤用は isError の結果。ノートはメモリ上の NoteStore に置く
 * （D1 も暗号化も通らない — そこは noteStore.ts と crypto のテストの担当）。
 */
import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import type { Env } from "../global.d";
import { serializeDocument, parseContent } from "../application/persistence";
import { mcpRoutes } from "./index";
import type { NoteStore, StoredNote } from "./noteStore";
import { SUPPORTED_PROTOCOL_VERSIONS } from "./protocol";

const TOKEN = "edane_test";

function memoryStore(): NoteStore & { notes: Map<string, StoredNote & { userId: string }> } {
  const notes = new Map<string, StoredNote & { userId: string }>();
  let seq = 0;
  return {
    notes,
    async list(userId) {
      return [...notes.values()]
        .filter((n) => n.userId === userId)
        .map(({ id, title, isPublic, updatedAt }) => ({ id, title, isPublic, pinned: false, updatedAt }));
    },
    async load(userId, noteId) {
      const n = notes.get(noteId);
      return n && n.userId === userId ? n : null;
    },
    async create(userId, { title, content }) {
      const id = `note${seq++}`;
      notes.set(id, { id, userId, title, content, isPublic: false, updatedAt: "t0" });
      return { id };
    },
    async saveContent(userId, note, content) {
      const n = notes.get(note.id);
      if (n && n.userId === userId) notes.set(note.id, { ...n, content, updatedAt: "t1" });
    },
    async rename(userId, noteId, title) {
      const n = notes.get(noteId);
      if (!n || n.userId !== userId) return false;
      notes.set(noteId, { ...n, title, updatedAt: "t1" });
      return true;
    },
  };
}

function setup() {
  const store = memoryStore();
  store.notes.set("n1", {
    id: "n1",
    userId: "alice",
    title: "Groceries",
    isPublic: false,
    updatedAt: "t0",
    content: serializeDocument({
      title: "Groceries",
      roots: [{ id: "r", text: "Groceries", children: [{ id: "milk", text: "milk", children: [], checked: false }] }],
    }),
  });
  store.notes.set("n2", { id: "n2", userId: "bob", title: "Bob's", isPublic: false, updatedAt: "t0", content: "" });
  const app = new Hono<Env>().route(
    "/mcp",
    mcpRoutes({
      resolveUserId: async (c) => (c.req.header("Authorization") === `Bearer ${TOKEN}` ? "alice" : null),
      store: () => store,
    })
  );
  const post = (body: unknown, token: string | null = TOKEN) =>
    app.request("https://edane.test/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        ...(token && { Authorization: `Bearer ${token}` }),
      },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  let id = 0;
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const res = await post({ jsonrpc: "2.0", id: ++id, method: "tools/call", params: { name, arguments: args } });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { result: { content: { text: string }[]; isError?: boolean } };
    return { text: json.result.content[0].text, isError: json.result.isError === true };
  };
  const docOf = (noteId: string) => {
    const n = store.notes.get(noteId)!;
    return parseContent(n.content, n.title);
  };
  return { app, store, post, call, docOf };
}

describe("POST /mcp transport", () => {
  it("401s without a valid Bearer token, advertising Bearer", async () => {
    const { post } = setup();
    for (const token of [null, "wrong"]) {
      const res = await post({ jsonrpc: "2.0", id: 1, method: "ping" }, token);
      expect(res.status).toBe(401);
      expect(res.headers.get("WWW-Authenticate")).toMatch(/^Bearer/);
    }
  });

  it("negotiates the protocol version and lists the tools", async () => {
    const { post } = setup();
    const init = await post({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "0" } },
    });
    const body = (await init.json()) as { result: { protocolVersion: string; capabilities: object } };
    expect(body.result.protocolVersion).toBe("2025-03-26");
    expect(body.result.capabilities).toHaveProperty("tools");

    const unknown = await post({ jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "1999-01-01" } });
    expect(((await unknown.json()) as { result: { protocolVersion: string } }).result.protocolVersion).toBe(
      SUPPORTED_PROTOCOL_VERSIONS[0]
    );

    const list = await post({ jsonrpc: "2.0", id: 3, method: "tools/list" });
    const tools = ((await list.json()) as { result: { tools: { name: string }[] } }).result.tools.map((t) => t.name);
    expect(tools).toEqual(["list_notes", "read_note", "create_note", "rename_note", "add_nodes", "update_node", "delete_node"]);
  });

  it("answers notifications with 202 and no body, and batches with the responses only", async () => {
    const { post } = setup();
    const note = await post({ jsonrpc: "2.0", method: "notifications/initialized" });
    expect(note.status).toBe(202);
    expect(await note.text()).toBe("");

    const batch = await post([
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 7, method: "ping" },
    ]);
    expect(await batch.json()).toEqual([{ jsonrpc: "2.0", id: 7, result: {} }]);
  });

  it("reports parse errors, unknown methods and unknown tools as JSON-RPC errors", async () => {
    const { post } = setup();
    const parse = await post("{nope");
    expect(parse.status).toBe(400);
    expect(((await parse.json()) as { error: { code: number } }).error.code).toBe(-32700);

    const method = await post({ jsonrpc: "2.0", id: 1, method: "resources/list" });
    expect(((await method.json()) as { error: { code: number } }).error.code).toBe(-32601);

    const tool = await post({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "rm_rf" } });
    expect(((await tool.json()) as { error: { code: number } }).error.code).toBe(-32602);
  });

  it("405s GET (no SSE stream) and DELETE (no session)", async () => {
    const { app } = setup();
    for (const method of ["GET", "DELETE"]) {
      const res = await app.request("/mcp", { method, headers: { Authorization: `Bearer ${TOKEN}` } });
      expect(res.status).toBe(405);
    }
  });
});

describe("note tools", () => {
  it("lists and reads only the caller's notes", async () => {
    const { call } = setup();
    const list = await call("list_notes");
    expect(JSON.parse(list.text).map((n: { id: string }) => n.id)).toEqual(["n1"]);
    expect(JSON.parse(list.text)[0].url).toBe("https://edane.test/notes/n1/edit");
    expect(JSON.parse((await call("list_notes", { query: "nothing" })).text)).toEqual([]);

    const read = await call("read_note", { noteId: "n1" });
    expect(read.text).toContain("- [ ] milk {id=milk}");
    expect(await call("read_note", { noteId: "n2" })).toMatchObject({ isError: true });
  });

  it("creates a note and edits it node by node", async () => {
    const { call, docOf, store } = setup();
    const created = await call("create_note", { title: "Trip", markdown: "- pack\n- book hotel" });
    const id = /Created note (\S+)/.exec(created.text)![1];
    expect(store.notes.get(id)!.title).toBe("Trip");
    const root = docOf(id).roots[0];
    expect(root.text).toBe("Trip");
    expect(root.children.map((c) => c.text)).toEqual(["pack", "book hotel"]);

    const added = await call("add_nodes", { noteId: id, parentId: root.children[0].id, markdown: "- [ ] passport" });
    expect(added.text).toMatch(/Added node ids: \S+/);
    const passport = docOf(id).roots[0].children[0].children[0];
    expect(passport).toMatchObject({ text: "passport", checked: false });

    await call("update_node", { noteId: id, nodeId: passport.id, checked: true });
    expect(docOf(id).roots[0].children[0].children[0].checked).toBe(true);

    await call("delete_node", { noteId: id, nodeId: root.children[1].id });
    expect(docOf(id).roots[0].children.map((c) => c.text)).toEqual(["pack"]);

    await call("rename_note", { noteId: id, title: "Trip 2" });
    expect(store.notes.get(id)!.title).toBe("Trip 2");
  });

  it("returns misuse as isError results without saving", async () => {
    const { call, store } = setup();
    const before = store.notes.get("n1")!.content;
    expect(await call("update_node", { noteId: "n1", nodeId: "milk" })).toMatchObject({ isError: true });
    expect(await call("update_node", { noteId: "n1", nodeId: "milk", checked: "yes" })).toMatchObject({ isError: true });
    expect(await call("delete_node", { noteId: "n1", nodeId: "ghost" })).toMatchObject({ isError: true });
    expect(await call("add_nodes", { noteId: "n1", markdown: "   " })).toMatchObject({ isError: true });
    expect(await call("read_note", {})).toMatchObject({ isError: true });
    expect(await call("rename_note", { noteId: "n2", title: "mine" })).toMatchObject({ isError: true });
    expect(store.notes.get("n2")!.title).toBe("Bob's");
    expect(store.notes.get("n1")!.content).toBe(before);
  });
});
