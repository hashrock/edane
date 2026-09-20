import { describe, it, expect } from "vitest";
import { STORED_NODE_TYPES, type MindMapDocument, type MindMapModel } from "../domain/model";
import {
  modelToText,
  documentToText,
  textToNodes,
  textToDocument,
  parseContent,
  serializeDocument,
  createDefaultDocument,
  normalizeDocument,
  CONTENT_FORMAT_VERSION,
} from "./persistence";

/** Strip IDs so we can compare tree structure and text only */
function stripIds(node: MindMapModel): unknown {
  return {
    text: node.text,
    children: node.children.map(stripIds),
  };
}

/** Every node id of a document in DFS order. */
function allIds(doc: MindMapDocument): string[] {
  const walk = (n: MindMapModel): string[] => [n.id, ...n.children.flatMap(walk)];
  return doc.roots.flatMap(walk);
}

let seq = 0;
const ids = () => `id${seq++}`;

describe("modelToText", () => {
  it("serializes a single node", () => {
    const model: MindMapModel = { id: "n0", text: "Root", children: [] };
    expect(modelToText(model)).toBe("Root");
  });

  it("serializes a tree with children", () => {
    const model: MindMapModel = {
      id: "n0",
      text: "Root",
      children: [
        {
          id: "n1",
          text: "Child1",
          children: [
            { id: "n2", text: "Grandchild", children: [] },
          ],
        },
        { id: "n3", text: "Child2", children: [] },
      ],
    };
    expect(modelToText(model)).toBe(
      "Root\n  Child1\n    Grandchild\n  Child2"
    );
  });

  it("serializes deeply nested tree", () => {
    const model: MindMapModel = {
      id: "n0",
      text: "A",
      children: [
        {
          id: "n1",
          text: "B",
          children: [
            {
              id: "n2",
              text: "C",
              children: [{ id: "n3", text: "D", children: [] }],
            },
          ],
        },
      ],
    };
    expect(modelToText(model)).toBe("A\n  B\n    C\n      D");
  });
});

describe("documentToText", () => {
  it("joins every tree in order", () => {
    const doc: MindMapDocument = {
      title: "T",
      roots: [
        { id: "a", text: "A", children: [{ id: "a1", text: "A1", children: [] }] },
        { id: "b", text: "B", children: [] },
      ],
    };
    expect(documentToText(doc)).toBe("A\n  A1\nB");
  });
});

describe("textToNodes / textToDocument", () => {
  it("parses empty content as no nodes, and as a single childless root carrying the title", () => {
    expect(textToNodes("")).toEqual([]);
    const doc = textToDocument("Root", "");
    expect(doc.title).toBe("Root");
    expect(doc.roots).toHaveLength(1);
    expect(doc.roots[0].text).toBe("Root");
    expect(doc.roots[0].children).toEqual([]);
  });

  it("parses a flat list as the children of one title root (the shape it was written in)", () => {
    const doc = textToDocument("Root", "Child1\nChild2\nChild3");
    expect(doc.title).toBe("Root");
    expect(doc.roots).toHaveLength(1);
    expect(doc.roots[0].text).toBe("Root");
    expect(doc.roots[0].children.map((c) => c.text)).toEqual([
      "Child1",
      "Child2",
      "Child3",
    ]);
  });

  it("parses indented content into nested trees", () => {
    const nodes = textToNodes("  Child1\n    Grandchild\n  Child2");
    expect(nodes.length).toBe(2);
    expect(nodes[0].text).toBe("Child1");
    expect(nodes[0].children[0].text).toBe("Grandchild");
    expect(nodes[1].text).toBe("Child2");
  });

  it("skips blank lines", () => {
    expect(textToNodes("Child1\n\nChild2\n\n").length).toBe(2);
  });

  it("mints ids from the supplied source, root first then DFS", () => {
    seq = 0;
    const doc = textToDocument("T", "a\n  b\nc", ids);
    expect(doc.roots[0].id).toBe("id0");
    expect(allIds(doc)).toEqual(["id0", "id1", "id2", "id3"]);
  });
});

describe("round-trip: modelToText → textToNodes", () => {
  it("preserves a single node with no children", () => {
    const original: MindMapModel = { id: "n0", text: "Leaf", children: [] };
    const parsed = textToNodes(modelToText(original));
    expect(parsed.map(stripIds)).toEqual([stripIds(original)]);
  });
});

describe("round-trip: textToDocument → documentToText", () => {
  it("re-emits the title root with the lines nested under it (leading indent is relative)", () => {
    const content = "  Child1\n    Grandchild\n  Child2";
    const doc = textToDocument("Root", content);
    expect(documentToText(doc)).toBe("Root\n  Child1\n    Grandchild\n  Child2");
  });
});

describe("parseContent", () => {
  it("returns a default document when content is undefined", () => {
    const doc = parseContent(undefined, "My Title");
    expect(doc.title).toBe("My Title");
    expect(doc.roots.length).toBeGreaterThan(0);
  });

  it("returns a default document when content is an empty string", () => {
    const doc = parseContent("", "My Title");
    expect(doc.title).toBe("My Title");
  });

  it("reads v2 content and round-trips it exactly", () => {
    const doc: MindMapDocument = {
      title: "T",
      roots: [
        { id: "a", text: "A", position: { x: 1, y: 2 }, children: [{ id: "a1", text: "A1", collapsed: true, children: [] }] },
        { id: "b", text: "B", type: "link", linkTitle: "L", children: [] },
      ],
    };
    const back = parseContent(serializeDocument(doc), "T");
    expect(back).toEqual(doc);
  });

  it("migrates v1 JSON as a SINGLE root: the old root node keeps its id and subtree", () => {
    const v1 = {
      id: "old-root",
      text: "Old title",
      children: [
        { id: "c1", text: "One", children: [{ id: "g1", text: "Deep", children: [] }] },
        { id: "c2", text: "Two", children: [] },
      ],
    };
    const doc = parseContent(JSON.stringify(v1), "DB title");
    // One tree, shaped exactly as it was written: the classic single root.
    expect(doc.roots).toHaveLength(1);
    expect(doc.roots[0].id).toBe("old-root");
    expect(doc.roots[0].text).toBe("Old title");
    expect(doc.roots[0].children.map((c) => c.id)).toEqual(["c1", "c2"]);
    expect(doc.roots[0].children[0].children[0].id).toBe("g1");
    expect(allIds(doc)).toEqual(["old-root", "c1", "g1", "c2"]);
  });

  it("v1 migration: the note's title wins; the v1 root text is the fallback", () => {
    const v1 = { id: "r", text: "JSON title", children: [{ id: "c", text: "C", children: [] }] };
    expect(parseContent(JSON.stringify(v1), "DB title").title).toBe("DB title");
    expect(parseContent(JSON.stringify(v1), "").title).toBe("JSON title");
    expect(parseContent(JSON.stringify(v1), undefined).title).toBe("JSON title");
  });

  it("v1 migration: a childless root stays a single (non-blank) root", () => {
    const v1 = { id: "r", text: "Just a title", children: [] };
    const doc = parseContent(JSON.stringify(v1), "T");
    expect(doc.roots).toHaveLength(1);
    expect(doc.roots[0]).toEqual({ id: "r", text: "Just a title", children: [] });
  });

  it("v1 migration: a legacy multiRoot flag on the old root is dropped", () => {
    // #149 の単一/複数ツリー切り替えは廃止済み。古い content に残っていても
    // 読み飛ばすだけで、ノードにも文書にも残さない。
    const v1 = { id: "r", text: "T", multiRoot: false, children: [{ id: "c", text: "C", children: [] }] };
    const doc = parseContent(JSON.stringify(v1), "T");
    expect("multiRoot" in doc).toBe(false);
    expect("multiRoot" in doc.roots[0]).toBe(false);
  });

  it("re-serializing a migrated v1 note emits v2 with the old root as roots[0]", () => {
    const v1 = { id: "r", text: "T", children: [{ id: "c", text: "C", children: [] }] };
    const out = JSON.parse(serializeDocument(parseContent(JSON.stringify(v1), "T")));
    expect(out.version).toBe(CONTENT_FORMAT_VERSION);
    expect(out.roots.map((r: MindMapModel) => r.id)).toEqual(["r"]);
    expect(out.roots[0].children.map((r: MindMapModel) => r.id)).toEqual(["c"]);
    expect(out).not.toHaveProperty("id");
    expect(out).not.toHaveProperty("title");
  });

  it("repairs an empty v2 roots array with one blank root", () => {
    const doc = parseContent(JSON.stringify({ version: 2, roots: [] }), "T");
    expect(doc.roots).toHaveLength(1);
    expect(doc.roots[0].text).toBe("");
    expect(doc.title).toBe("T");
  });

  it("falls back to legacy text format when JSON is invalid", () => {
    const doc = parseContent("not-json-content", "Root");
    expect(doc.title).toBe("Root");
    expect(doc.roots).toHaveLength(1);
    expect(doc.roots[0].text).toBe("Root");
    expect(doc.roots[0].children.map((c) => c.text)).toEqual(["not-json-content"]);
  });

  it("falls back to legacy format when JSON lacks required fields", () => {
    const doc = parseContent(JSON.stringify({ foo: "bar" }), "Root");
    // No roots/text field → falls back to the legacy parser (a title root
    // with one child per line).
    expect(doc.title).toBe("Root");
    expect(doc.roots.map((r) => r.text)).toEqual(["Root"]);
    expect(doc.roots[0].children.map((c) => c.text)).toEqual([JSON.stringify({ foo: "bar" })]);
  });

  it("falls back to legacy format when JSON has id/text but no children array", () => {
    // MindMapModel.children is required; without this guard, a shallow cast
    // would return an object whose .children is undefined, crashing every
    // domain traversal (findNode, getFlatOrder, ...) that iterates
    // `node.children` unconditionally.
    const doc = parseContent(JSON.stringify({ id: "x", text: "y" }), "Root");
    expect(doc.title).toBe("Root");
    for (const r of doc.roots) expect(Array.isArray(r.children)).toBe(true);
  });

  it("uses 'Mindmap' as title when title is undefined and content is legacy text", () => {
    const doc = parseContent("Child1\nChild2", undefined);
    expect(doc.title).toBe("Mindmap");
    expect(doc.roots.map((r) => r.text)).toEqual(["Mindmap"]);
    expect(doc.roots[0].children.map((c) => c.text)).toEqual(["Child1", "Child2"]);
  });

  it("legacy text: an all-blank content still yields exactly one root (the title)", () => {
    const doc = parseContent("\n  \n", "T");
    expect(doc.roots).toHaveLength(1);
    expect(doc.roots[0].text).toBe("T");
    expect(doc.roots[0].children).toEqual([]);
  });

  it("keeps a task checkbox in either state, and only for booleans", () => {
    // `false` is the OPEN task, not "no checkbox" — a truthiness guard here
    // would quietly turn every open task into a plain node on reload.
    const json = JSON.stringify({
      version: 2,
      roots: [
        { id: "open", text: "o", checked: false, children: [] },
        { id: "done", text: "d", checked: true, children: [] },
        { id: "plain", text: "p", children: [] },
        { id: "junk", text: "j", checked: "yes", children: [] },
      ],
    });
    const doc = parseContent(json, "ignored");
    expect(doc.roots.map((c) => c.checked)).toEqual([
      false,
      true,
      undefined,
      undefined,
    ]);
  });

  it("keeps a finite tree position and drops malformed ones", () => {
    const json = JSON.stringify({
      version: 2,
      roots: [
        { id: "ok", text: "o", position: { x: 12.5, y: -3 }, children: [] },
        { id: "bad", text: "b", position: { x: "1", y: 2 }, children: [] },
        { id: "none", text: "n", position: null, children: [] },
      ],
    });
    const doc = parseContent(json, "ignored");
    expect(doc.roots.map((c) => c.position)).toEqual([
      { x: 12.5, y: -3 },
      undefined,
      undefined,
    ]);
  });

  it("ignores a stored multiRoot flag (the single/multi-tree switch is gone)", () => {
    const withFlag = (multiRoot: unknown) =>
      JSON.stringify({ version: 2, multiRoot, roots: [{ id: "a", text: "a", children: [] }] });
    for (const flag of [false, true, "yes"]) {
      expect("multiRoot" in parseContent(withFlag(flag), "ignored")).toBe(false);
    }
  });

  it("preserves every declared NodeType through normalization", () => {
    // Guards the round-trip invariant that STORED_NODE_TYPE_SET protects at
    // the type level: every non-default NodeType must survive normalizeTree
    // unchanged, not silently fall back to "text".
    for (const type of STORED_NODE_TYPES) {
      const json = JSON.stringify({
        version: 2,
        roots: [{ id: "c", text: "v", type, children: [] }],
      });
      const doc = parseContent(json, "ignored");
      expect(doc.roots[0].type).toBe(type);
    }
  });

  it("drops malformed roots and children instead of accepting a non-tree shape", () => {
    const json = JSON.stringify({
      version: 2,
      roots: [
        {
          id: "ok",
          text: "OK",
          children: [{ id: "k", text: "K", children: [] }, 42, null, { id: "x", text: "missing children" }],
        },
        7,
        { text: "no children" },
      ],
    });
    const doc = parseContent(json, "ignored");
    expect(doc.roots.map((c) => c.text)).toEqual(["OK"]);
    expect(doc.roots[0].children.map((c) => c.text)).toEqual(["K"]);
  });

  it("reassigns duplicated ids so the loaded document is a unique-id forest", () => {
    // External JSON can carry duplicated ids; the whole domain layer addresses
    // nodes by id (findNode/removeNode act on the first match), so load-time
    // normalization must make every id unique — across roots too.
    const json = JSON.stringify({
      version: 2,
      roots: [
        { id: "dup", text: "First", children: [{ id: "dup", text: "Inner", children: [] }] },
        { id: "dup", text: "Second", children: [] },
      ],
    });
    const doc = parseContent(json, "ignored");
    const all = allIds(doc);
    expect(new Set(all).size).toBe(all.length);
    expect(doc.roots[0].id).toBe("dup"); // the first occurrence keeps its id
    expect(doc.roots.map((r) => r.text)).toEqual(["First", "Second"]);
  });
});

describe("normalizeDocument", () => {
  it("returns null for non-objects and shapes that are neither v1 nor v2", () => {
    for (const bad of [null, 42, "x", [], {}, { roots: "no" }, { id: "x", text: "y" }]) {
      expect(normalizeDocument(bad, "T")).toBeNull();
    }
  });

  it("does not repair an empty roots array itself (parseContent does, via ensureRoot)", () => {
    expect(normalizeDocument({ version: 2, roots: [] }, "T")).toEqual({ title: "T", roots: [] });
  });

  it("defaults the title to an empty string for v2 when none is given", () => {
    expect(normalizeDocument({ version: 2, roots: [] }, undefined)!.title).toBe("");
  });
});

describe("serializeDocument", () => {
  it("writes the version tag and the roots, but not the title", () => {
    const doc: MindMapDocument = { title: "Root", roots: [{ id: "r", text: "R", children: [] }] };
    const parsed = JSON.parse(serializeDocument(doc));
    expect(parsed.version).toBe(CONTENT_FORMAT_VERSION);
    expect(parsed.roots[0].id).toBe("r");
    expect(parsed).not.toHaveProperty("title");
    expect(parsed).not.toHaveProperty("multiRoot");
  });
});

describe("createDefaultDocument", () => {
  it("creates a document with the given title and a sample tree", () => {
    const doc = createDefaultDocument("My Map");
    expect(doc.title).toBe("My Map");
    expect(doc.roots.length).toBeGreaterThan(0);
    expect(doc.roots[0].children.length).toBeGreaterThan(0);
  });

  it("defaults to 'New Note' plus the date when no title is provided", () => {
    const doc = createDefaultDocument();
    expect(doc.title).toMatch(/^New Note \d{4}-\d{2}-\d{2}$/);
  });

  it("mints ids from the supplied source", () => {
    seq = 0;
    const doc = createDefaultDocument("T", ids);
    expect(allIds(doc)).toEqual(["id0", "id1", "id2"]);
  });
});
