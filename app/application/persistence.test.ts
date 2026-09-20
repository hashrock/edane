import { describe, it, expect } from "vitest";
import type { MindMapDocument, MindMapModel, NodeType } from "../domain/model";
import {
  modelToText,
  documentToText,
  textToNodes,
  textToDocument,
  parseContent,
  normalizeDocument,
  serializeDocument,
  createDefaultDocument,
  CONTENT_FORMAT_VERSION,
} from "./persistence";

/**
 * Every non-default NodeType. `satisfies` only checks each element is a
 * valid NodeType (not that the list is complete) — the real exhaustiveness
 * guard is model.ts's `isStoredNodeType` (backed by `STORED_NODE_TYPE_SET`),
 * which normalizeTree calls and which fails to typecheck if a NodeType is
 * added without being declared there. This list is an end-to-end regression
 * check that the full parseContent → normalizeTree pipeline actually
 * preserves every currently-declared type, not just the predicate itself.
 */
const STORED_NODE_TYPES: readonly Exclude<NodeType, "text">[] = [
  "image",
  "link",
  "markdown",
] satisfies NodeType[];

/** Strip IDs so we can compare tree structure and text only */
function stripIds(model: MindMapModel): unknown {
  return {
    text: model.text,
    children: model.children.map(stripIds),
  };
}

/** Every id in a document, DFS. */
function allIds(doc: MindMapDocument): string[] {
  const collect = (m: MindMapModel): string[] => [m.id, ...m.children.flatMap(collect)];
  return doc.roots.flatMap(collect);
}

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
  it("joins every tree in order, roots unindented", () => {
    const doc: MindMapDocument = {
      title: "T",
      roots: [
        { id: "a", text: "A", children: [{ id: "a1", text: "A1", children: [] }] },
        { id: "b", text: "B", children: [] },
      ],
    };
    expect(documentToText(doc)).toBe("A\n  A1\nB");
  });

  it("does not include the title", () => {
    const doc: MindMapDocument = { title: "T", roots: [{ id: "a", text: "A", children: [] }] };
    expect(documentToText(doc)).toBe("A");
  });
});

describe("textToNodes / textToDocument", () => {
  it("parses empty content as a single childless root carrying the title", () => {
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
    const nodes = textToNodes("Child1\n\nChild2\n\n");
    expect(nodes.length).toBe(2);
  });
});

describe("round-trip: modelToText → textToNodes", () => {
  it("preserves simple tree structure", () => {
    const original: MindMapModel = {
      id: "n0",
      text: "Root",
      children: [
        { id: "n1", text: "A", children: [] },
        { id: "n2", text: "B", children: [] },
      ],
    };

    const parsed = textToNodes(modelToText(original));
    expect(parsed).toHaveLength(1);
    expect(stripIds(parsed[0])).toEqual(stripIds(original));
  });

  it("preserves deeply nested structure", () => {
    const original: MindMapModel = {
      id: "n0",
      text: "プロジェクト",
      children: [
        {
          id: "n1",
          text: "設計",
          children: [
            {
              id: "n2",
              text: "UI",
              children: [
                { id: "n3", text: "コンポーネント", children: [] },
                { id: "n4", text: "レイアウト", children: [] },
              ],
            },
            { id: "n5", text: "API", children: [] },
          ],
        },
        {
          id: "n6",
          text: "実装",
          children: [{ id: "n7", text: "テスト", children: [] }],
        },
      ],
    };

    const parsed = textToNodes(modelToText(original));
    expect(parsed).toHaveLength(1);
    expect(stripIds(parsed[0])).toEqual(stripIds(original));
  });

  it("preserves a whole document through documentToText", () => {
    const doc: MindMapDocument = {
      title: "T",
      roots: [
        { id: "a", text: "A", children: [{ id: "a1", text: "A1", children: [] }] },
        { id: "b", text: "B", children: [] },
      ],
    };
    const parsed = textToNodes(documentToText(doc));
    expect(parsed.map(stripIds)).toEqual(doc.roots.map(stripIds));
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

  it("parses v2 JSON content, taking the title from the note", () => {
    const stored = {
      version: 2,
      roots: [
        { id: "r1", text: "Tree 1", children: [{ id: "c1", text: "Child", children: [] }] },
        { id: "r2", text: "Tree 2", position: { x: 10, y: 20 }, children: [] },
      ],
    };
    const doc = parseContent(JSON.stringify(stored), "Note title");
    expect(doc.title).toBe("Note title");
    expect(doc.roots.map((r) => r.id)).toEqual(["r1", "r2"]);
    expect(doc.roots[0].children[0].text).toBe("Child");
    expect(doc.roots[1].position).toEqual({ x: 10, y: 20 });
  });

  it("round-trips a v2 document through serializeDocument", () => {
    const doc: MindMapDocument = {
      title: "T",
      roots: [
        { id: "a", text: "A", bold: true, children: [{ id: "a1", text: "A1", checked: false, children: [] }] },
        { id: "b", text: "https://e/x", type: "link", linkTitle: "E", position: { x: 1, y: 2 }, children: [] },
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

  it("re-serializing a migrated v1 note emits v2 with the old root as roots[0]", () => {
    const v1 = { id: "r", text: "T", children: [{ id: "c", text: "C", children: [] }] };
    const out = JSON.parse(serializeDocument(parseContent(JSON.stringify(v1), "T")));
    expect(out.version).toBe(CONTENT_FORMAT_VERSION);
    expect(out.roots.map((r: MindMapModel) => r.id)).toEqual(["r"]);
    expect(out.roots[0].children.map((r: MindMapModel) => r.id)).toEqual(["c"]);
    expect(out).not.toHaveProperty("id");
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

  it("reassigns duplicated ids so the loaded document is a unique-id forest", () => {
    // External JSON can carry duplicated ids; the whole domain layer addresses
    // nodes by id (findNode/removeNode act on the first match), so load-time
    // normalization must make every id unique — across roots too.
    const json = JSON.stringify({
      version: 2,
      roots: [
        { id: "dup", text: "A", children: [{ id: "dup", text: "A1", children: [] }] },
        { id: "dup", text: "B", children: [] },
      ],
    });
    const doc = parseContent(json, "ignored");
    const ids = allIds(doc);
    expect(new Set(ids).size).toBe(ids.length);
    // Structure and text are preserved.
    expect(doc.roots.map((c) => c.text)).toEqual(["A", "B"]);
    expect(doc.roots[0].children[0].text).toBe("A1");
  });

  it("preserves known optional fields while normalizing", () => {
    const json = JSON.stringify({
      version: 2,
      roots: [
        {
          id: "c",
          text: "https://example.com",
          type: "link",
          bold: true,
          fontSize: 20,
          collapsed: true,
          linkTitle: "Example",
          favicon: "https://example.com/f.ico",
          children: [],
        },
      ],
    });
    const c = parseContent(json, "ignored").roots[0];
    expect(c.type).toBe("link");
    expect(c.bold).toBe(true);
    expect(c.fontSize).toBe(20);
    expect(c.collapsed).toBe(true);
    expect(c.linkTitle).toBe("Example");
    expect(c.favicon).toBe("https://example.com/f.ico");
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
          id: "r",
          text: "R",
          children: [
            { id: "ok", text: "OK", children: [] },
            42,
            null,
            { id: "x", text: "missing children" },
          ],
        },
        "junk",
        { id: "y", text: "no children" },
      ],
    });
    const doc = parseContent(json, "ignored");
    expect(doc.roots.map((r) => r.id)).toEqual(["r"]);
    expect(doc.roots[0].children.map((c) => c.text)).toEqual(["OK"]);
  });
});

describe("normalizeDocument", () => {
  it("returns null for non-objects and shapes that are neither v1 nor v2", () => {
    expect(normalizeDocument(null, "T")).toBeNull();
    expect(normalizeDocument("str", "T")).toBeNull();
    expect(normalizeDocument({ foo: 1 }, "T")).toBeNull();
    expect(normalizeDocument({ id: "x", text: "y" }, "T")).toBeNull();
  });

  it("does not repair an empty forest itself (that is parseContent's job)", () => {
    expect(normalizeDocument({ roots: [] }, "T")).toEqual({ title: "T", roots: [] });
  });

  it("uses an empty title for v2 when none is given", () => {
    expect(normalizeDocument({ roots: [] }, undefined)!.title).toBe("");
  });
});

describe("serializeDocument", () => {
  it("emits the v2 shape with the roots and no title", () => {
    const doc: MindMapDocument = {
      title: "Root",
      roots: [{ id: "r", text: "R", children: [] }],
    };
    const parsed = JSON.parse(serializeDocument(doc));
    expect(parsed).toEqual({
      version: CONTENT_FORMAT_VERSION,
      roots: [{ id: "r", text: "R", children: [] }],
    });
    expect(parsed).not.toHaveProperty("title");
    expect(serializeDocument(doc)).not.toContain("Root");
  });
});

describe("createDefaultDocument", () => {
  it("creates a document with the given title and one sample tree", () => {
    const doc = createDefaultDocument("My Map");
    expect(doc.title).toBe("My Map");
    expect(doc.roots.length).toBe(1);
    expect(doc.roots[0].children.length).toBeGreaterThan(0);
  });

  it("defaults to 'New Note' plus the date when no title is provided", () => {
    const doc = createDefaultDocument();
    expect(doc.title).toMatch(/^New Note \d{4}-\d{2}-\d{2}$/);
  });
});
