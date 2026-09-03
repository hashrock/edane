import { describe, it, expect } from "vitest";
import { STORED_NODE_TYPES, type MindMapModel } from "../domain/model";
import {
  modelToText,
  textToModel,
  parseContent,
  serializeModel,
  createDefaultModel,
} from "./persistence";

/** Strip IDs so we can compare tree structure and text only */
function stripIds(model: MindMapModel): unknown {
  return {
    text: model.text,
    children: model.children.map(stripIds),
  };
}

describe("modelToText", () => {
  it("serializes a single root node", () => {
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

describe("textToModel", () => {
  it("parses empty content as root only", () => {
    const model = textToModel("Root", "");
    expect(model.text).toBe("Root");
    expect(model.children).toEqual([]);
  });

  it("parses flat list as children of root", () => {
    const model = textToModel("Root", "Child1\nChild2\nChild3");
    expect(model.text).toBe("Root");
    expect(model.children.map((c) => c.text)).toEqual([
      "Child1",
      "Child2",
      "Child3",
    ]);
  });

  it("parses indented content into nested tree", () => {
    const model = textToModel("Root", "  Child1\n    Grandchild\n  Child2");
    expect(model.text).toBe("Root");
    expect(model.children.length).toBe(2);
    expect(model.children[0].text).toBe("Child1");
    expect(model.children[0].children[0].text).toBe("Grandchild");
    expect(model.children[1].text).toBe("Child2");
  });

  it("skips blank lines", () => {
    const model = textToModel("Root", "Child1\n\nChild2\n\n");
    expect(model.children.length).toBe(2);
  });
});

describe("round-trip: modelToText → textToModel", () => {
  it("preserves single root with no children", () => {
    const original: MindMapModel = {
      id: "n0",
      text: "Leaf",
      children: [],
    };

    const text = modelToText(original);
    const parsed = textToModel(text, "");

    expect(stripIds(parsed)).toEqual(stripIds(original));
  });
});

describe("round-trip: textToModel → modelToText", () => {
  it("preserves indented text", () => {
    const title = "Root";
    const content = "  Child1\n    Grandchild\n  Child2";

    const model = textToModel(title, content);
    const text = modelToText(model);

    expect(text).toBe("Root\n  Child1\n    Grandchild\n  Child2");
  });
});

describe("parseContent", () => {
  it("returns a default model when content is undefined", () => {
    const model = parseContent(undefined, "My Title");
    expect(model.text).toBe("My Title");
    expect(model.children.length).toBeGreaterThan(0);
  });

  it("returns a default model when content is an empty string", () => {
    const model = parseContent("", "My Title");
    expect(model.text).toBe("My Title");
  });

  it("falls back to legacy text format when JSON is invalid", () => {
    const model = parseContent("not-json-content", "Root");
    expect(model.text).toBe("Root");
    expect(model.children[0].text).toBe("not-json-content");
  });

  it("falls back to legacy format when JSON lacks required fields", () => {
    const model = parseContent(JSON.stringify({ foo: "bar" }), "Root");
    // No id/text field → falls back to legacy parser
    expect(model.text).toBe("Root");
  });

  it("falls back to legacy format when JSON has id/text but no children array", () => {
    // MindMapModel.children is required; without this guard, `parsed as
    // MindMapModel` would return an object whose .children is undefined,
    // crashing every domain traversal (findNode, getFlatOrder, ...) that
    // iterates `node.children` unconditionally.
    const model = parseContent(JSON.stringify({ id: "x", text: "y" }), "Root");
    expect(model.text).toBe("Root");
    expect(Array.isArray(model.children)).toBe(true);
  });

  it("uses 'Mindmap' as title when title is undefined and content is legacy text", () => {
    const model = parseContent("Child1\nChild2", undefined);
    expect(model.text).toBe("Mindmap");
    expect(model.children[0].text).toBe("Child1");
  });

  it("keeps a task checkbox in either state, and only for booleans", () => {
    // `false` is the OPEN task, not "no checkbox" — a truthiness guard here
    // would quietly turn every open task into a plain node on reload.
    const json = JSON.stringify({
      id: "r",
      text: "Root",
      children: [
        { id: "open", text: "o", checked: false, children: [] },
        { id: "done", text: "d", checked: true, children: [] },
        { id: "plain", text: "p", children: [] },
        { id: "junk", text: "j", checked: "yes", children: [] },
      ],
    });
    const model = parseContent(json, "ignored");
    expect(model.children.map((c) => c.checked)).toEqual([
      false,
      true,
      undefined,
      undefined,
    ]);
  });

  it("keeps a finite tree position and drops malformed ones", () => {
    const json = JSON.stringify({
      id: "r",
      text: "Root",
      children: [
        { id: "ok", text: "o", position: { x: 12.5, y: -3 }, children: [] },
        { id: "bad", text: "b", position: { x: "1", y: 2 }, children: [] },
        { id: "none", text: "n", position: null, children: [] },
      ],
    });
    const model = parseContent(json, "ignored");
    expect(model.children.map((c) => c.position)).toEqual([
      { x: 12.5, y: -3 },
      undefined,
      undefined,
    ]);
  });

  it("preserves every declared NodeType through normalization", () => {
    // Guards the round-trip invariant that OPTIONAL_NODE_TYPES protects at
    // the type level: every non-default NodeType must survive normalizeTree
    // unchanged, not silently fall back to "text".
    for (const type of STORED_NODE_TYPES) {
      const json = JSON.stringify({
        id: "r",
        text: "Root",
        children: [{ id: "c", text: "v", type, children: [] }],
      });
      const model = parseContent(json, "ignored");
      expect(model.children[0].type).toBe(type);
    }
  });

  it("drops malformed children instead of accepting a non-tree shape", () => {
    // Only the root is shape-checked by the old guard; nested junk must be
    // rejected too (children that aren't {text, children[]} nodes).
    const json = JSON.stringify({
      id: "r",
      text: "Root",
      children: [
        { id: "ok", text: "OK", children: [] },
        42,
        null,
        { id: "x", text: "missing children" },
      ],
    });
    const model = parseContent(json, "ignored");
    expect(model.children.map((c) => c.text)).toEqual(["OK"]);
  });
});

describe("serializeModel", () => {
  it("serializes a model to a JSON string", () => {
    const model: MindMapModel = { id: "r", text: "Root", children: [] };
    const json = serializeModel(model);
    const parsed = JSON.parse(json);
    expect(parsed.id).toBe("r");
    expect(parsed.text).toBe("Root");
  });
});

describe("createDefaultModel", () => {
  it("creates a model with the given title", () => {
    const model = createDefaultModel("My Map");
    expect(model.text).toBe("My Map");
    expect(model.children.length).toBeGreaterThan(0);
  });

  it("defaults to 'New Note' plus the date when no title is provided", () => {
    const model = createDefaultModel();
    expect(model.text).toMatch(/^New Note \d{4}-\d{2}-\d{2}$/);
  });
});
