import { describe, it, expect } from "vitest";
import type { MindMapModel } from "../domain/model";
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
  it("preserves simple tree structure", () => {
    const original: MindMapModel = {
      id: "n0",
      text: "Root",
      children: [
        { id: "n1", text: "A", children: [] },
        { id: "n2", text: "B", children: [] },
      ],
    };

    const text = modelToText(original);
    const lines = text.split("\n");
    const parsed = textToModel(lines[0], lines.slice(1).join("\n"));

    expect(stripIds(parsed)).toEqual(stripIds(original));
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

    const text = modelToText(original);
    const lines = text.split("\n");
    const parsed = textToModel(lines[0], lines.slice(1).join("\n"));

    expect(stripIds(parsed)).toEqual(stripIds(original));
  });

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

  it("parses valid JSON content", () => {
    const original: MindMapModel = {
      id: "r1",
      text: "From JSON",
      children: [{ id: "c1", text: "Child", children: [] }],
    };
    const model = parseContent(JSON.stringify(original), "ignored");
    expect(model.id).toBe("r1");
    expect(model.text).toBe("From JSON");
    expect(model.children[0].text).toBe("Child");
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

  it("uses 'Mindmap' as title when title is undefined and content is legacy text", () => {
    const model = parseContent("Child1\nChild2", undefined);
    expect(model.text).toBe("Mindmap");
    expect(model.children[0].text).toBe("Child1");
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

  it("defaults to 'Edane' when no title is provided", () => {
    const model = createDefaultModel();
    expect(model.text).toBe("Edane");
  });
});
