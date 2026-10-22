/**
 * POST /mcp の契約: Bearer 必須、JSON-RPC の initialize / tools/list / tools/call、
 * 通知は 202、ツールの誤用は isError の結果。ノートはメモリ上の NoteStore に置く
 * （D1 も暗号化も通らない — そこは noteStore.ts と crypto のテストの担当）。
 */
import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import type { Env } from "../global.d";
import { mcpRoutes, MAX_BODY_BYTES } from "./index";
import { AGENT_INPUT_LIMITS } from "../application/agentInput";
import type { NoteStore, StoredNote } from "./noteStore";
import { SUPPORTED_PROTOCOL_VERSIONS, ToolInputError } from "./protocol";
import { applyNoteEditRequest } from "../application/noteEdits";
import { sequentialIds } from "../domain/model.arb";

const TOKEN = "edane_test";

function memoryStore(): NoteStore & { notes: Map<string, StoredNote & { userId: string }> } {
  const notes = new Map<string, StoredNote & { userId: string }>();
  const receipts = new Map<string, { request: string; nodeIds?: string[] }>();
  let seq = 0;
  return {
    notes,
    async list(userId) {
      return [...notes.values()]
        .filter((n) => n.userId === userId)
        .map(({ id, doc, updatedAt }) => ({ id, title: doc.title, isPublic: false, pinned: false, updatedAt }));
    },
    async load(userId, noteId) {
      const n = notes.get(noteId);
      return n && n.userId === userId ? n : null;
    },
    async create(userId, doc) {
      const id = `note${seq++}`;
      notes.set(id, { id, userId, doc, updatedAt: "t0" });
      return { id };
    },
    // Same rules as NoteRoom.applyEdit: the request applied to the note as it is now,
    // and a repeated operation id answered from its receipt.
    async edit(userId, noteId, request, operationId) {
      const n = notes.get(noteId);
      if (!n || n.userId !== userId) throw new ToolInputError(`Note not found: ${noteId}`);
      const receipt = operationId && receipts.get(`${noteId}/${operationId}`);
      if (receipt) {
        if (receipt.request !== JSON.stringify(request)) throw new ToolInputError("operation reused");
        return { doc: n.doc, nodeIds: receipt.nodeIds };
      }
      const result = applyNoteEditRequest(n.doc, request, sequentialIds(`${noteId}-${seq++}-`));
      if (!result.ok) throw new ToolInputError(result.error);
      if (operationId) receipts.set(`${noteId}/${operationId}`, { request: JSON.stringify(request), nodeIds: result.nodeIds });
      notes.set(noteId, { ...n, doc: result.document, updatedAt: "t1" });
      return { doc: result.document, nodeIds: result.nodeIds };
    },
  };
}

function setup() {
  const store = memoryStore();
  store.notes.set("n1", {
    id: "n1",
    userId: "alice",
    updatedAt: "t0",
    doc: {
      title: "Groceries",
      roots: [{ id: "r", text: "Groceries", children: [{ id: "milk", text: "milk", children: [], checked: false }] }],
    },
  });
  store.notes.set("n2", {
    id: "n2",
    userId: "bob",
    updatedAt: "t0",
    doc: { title: "Bob's", roots: [{ id: "b", text: "", children: [] }] },
  });
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
  const docOf = (noteId: string) => store.notes.get(noteId)!.doc;
  return { app, store, post, call, docOf };
}

/** A ping whose JSON is exactly `bytes` long (ASCII padding). */
function pingOfSize(bytes: number): string {
  const head = '{"jsonrpc":"2.0","id":1,"method":"ping","pad":"';
  return head + "x".repeat(bytes - head.length - 2) + '"}';
}

describe("POST /mcp transport", () => {
  it("413s a body over the limit, with or without Content-Length, and accepts one at the limit", async () => {
    const { app, post } = setup();
    expect((await post(pingOfSize(MAX_BODY_BYTES))).status).toBe(200);
    expect((await post(pingOfSize(MAX_BODY_BYTES + 1))).status).toBe(413);

    // No Content-Length: the limit is enforced while streaming.
    const bytes = new TextEncoder().encode(pingOfSize(MAX_BODY_BYTES + 1));
    const stream = new ReadableStream({
      start(controller) {
        for (let i = 0; i < bytes.length; i += 64 * 1024) controller.enqueue(bytes.slice(i, i + 64 * 1024));
        controller.close();
      },
    });
    const res = await app.request("https://edane.test/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
      body: stream,
      duplex: "half",
    } as RequestInit);
    expect(res.status).toBe(413);
  });

  it("401s without a valid Bearer token, pointing OAuth clients at the resource metadata", async () => {
    const { post } = setup();
    for (const token of [null, "wrong"]) {
      const res = await post({ jsonrpc: "2.0", id: 1, method: "ping" }, token);
      expect(res.status).toBe(401);
      const challenge = res.headers.get("WWW-Authenticate")!;
      expect(challenge).toMatch(/^Bearer /);
      expect(challenge).toMatch(/resource_metadata="https?:\/\/[^"]+\/\.well-known\/oauth-protected-resource\/mcp"/);
      expect(challenge.includes('error="invalid_token"')).toBe(token !== null);
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

  it("declares every tool's arguments strictly, with a length cap on every free-text string", async () => {
    const { post } = setup();
    const list = await post({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    type Schema = { additionalProperties?: boolean; properties: Record<string, { type: unknown; maxLength?: number; enum?: unknown }> };
    const tools = ((await list.json()) as { result: { tools: { name: string; inputSchema: Schema }[] } }).result.tools;
    for (const { name, inputSchema } of tools) {
      expect(inputSchema.additionalProperties, name).toBe(false);
      for (const [field, prop] of Object.entries(inputSchema.properties)) {
        if (prop.type === "string" && !prop.enum) expect(prop.maxLength, `${name}.${field}`).toBeGreaterThan(0);
      }
    }
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
    expect(store.notes.get(id)!.doc.title).toBe("Trip");
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
    expect(store.notes.get(id)!.doc.title).toBe("Trip 2");
  });

  it("rejects unknown arguments and over-long strings before running the tool", async () => {
    const { call, store } = setup();
    const before = store.notes.get("n1")!.doc;
    expect(await call("update_node", { noteId: "n1", nodeId: "milk", text: "oat", colour: "red" })).toMatchObject({
      isError: true,
      text: "Unknown argument: colour",
    });
    expect(await call("delete_node", { noteId: "n1", nodeId: "milk", ["__proto__"]: 1 })).toMatchObject({ isError: true });

    const limit = AGENT_INPUT_LIMITS.text;
    expect(await call("update_node", { noteId: "n1", nodeId: "milk", text: "a".repeat(limit + 1) })).toMatchObject({
      isError: true,
      text: `text is too long (max ${limit} characters)`,
    });
    expect(store.notes.get("n1")!.doc).toBe(before);

    // Code points, as JSON Schema counts: a surrogate pair is one character.
    const title = AGENT_INPUT_LIMITS.title;
    expect(await call("rename_note", { noteId: "n1", title: "😀".repeat(title) })).toMatchObject({ isError: false });
    expect(await call("rename_note", { noteId: "n1", title: "😀".repeat(title + 1) })).toMatchObject({ isError: true });
  });

  it("keeps an internal failure internal: JSON-RPC error to the agent, details only in the server log", async () => {
    const { store, post } = setup();
    store.edit = async () => {
      throw new Error("D1_ERROR: disk I/O error at /secret/path");
    };
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const res = await post({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "update_node", arguments: { noteId: "n1", nodeId: "milk", text: "oat" } },
      });
      const body = await res.text();
      expect(JSON.parse(body)).toMatchObject({ error: { code: -32603, message: "Internal error" } });
      expect(body).not.toContain("secret");
      expect(log).toHaveBeenCalledWith("mcp tool failed", expect.objectContaining({ tool: "update_node" }));
      expect(JSON.stringify(log.mock.calls)).not.toContain("oat"); // arguments may hold note text
    } finally {
      log.mockRestore();
    }
  });

  it("applies an edit sent again under the same operationId only once, with the same node ids", async () => {
    const { call, docOf } = setup();
    const args = { noteId: "n1", markdown: "- eggs", operationId: "op-1" };
    const first = await call("add_nodes", args);
    const again = await call("add_nodes", args);
    expect(again.isError).toBe(false);
    expect(/Added node ids: (\S+)/.exec(again.text)![1]).toBe(/Added node ids: (\S+)/.exec(first.text)![1]);
    expect(docOf("n1").roots[0].children.map((c) => c.text)).toEqual(["milk", "eggs"]);

    expect(await call("add_nodes", { ...args, markdown: "- ham" })).toMatchObject({ isError: true });
    expect(await call("add_nodes", { ...args, operationId: "not ok!" })).toMatchObject({ isError: true });
    expect(docOf("n1").roots[0].children.map((c) => c.text)).toEqual(["milk", "eggs"]);
  });

  it("returns misuse as isError results without saving", async () => {
    const { call, store } = setup();
    const before = store.notes.get("n1")!.doc;
    expect(await call("update_node", { noteId: "n1", nodeId: "milk" })).toMatchObject({ isError: true });
    expect(await call("update_node", { noteId: "n1", nodeId: "milk", checked: "yes" })).toMatchObject({ isError: true });
    expect(await call("delete_node", { noteId: "n1", nodeId: "ghost" })).toMatchObject({ isError: true });
    expect(await call("add_nodes", { noteId: "n1", markdown: "   " })).toMatchObject({ isError: true });
    expect(await call("read_note", {})).toMatchObject({ isError: true });
    expect(await call("rename_note", { noteId: "n2", title: "mine" })).toMatchObject({ isError: true });
    expect(store.notes.get("n2")!.doc.title).toBe("Bob's");
    expect(store.notes.get("n1")!.doc).toBe(before);
  });
});
