import { describe, it, expect } from "vitest";
import { outlineRows, verticalMoveInText } from "./outline";
import type { MindMapModel } from "../domain/model";

const tree: MindMapModel = {
  id: "root",
  text: "Title",
  children: [
    {
      id: "a",
      text: "A",
      children: [
        { id: "a1", text: "A1", children: [] },
        { id: "a2", text: "A2", children: [] },
      ],
    },
    { id: "b", text: "B", children: [{ id: "b1", text: "B1", children: [] }] },
  ],
};

describe("outlineRows", () => {
  it("includes the root first, then descendants in DFS order with depth", () => {
    const rows = outlineRows(tree);
    expect(rows.map((r) => r.node.id)).toEqual([
      "root",
      "a",
      "a1",
      "a2",
      "b",
      "b1",
    ]);
    expect(rows.map((r) => r.depth)).toEqual([0, 1, 2, 2, 1, 2]);
  });

  it("reports hasChildren for parents", () => {
    const rows = outlineRows(tree);
    const byId = Object.fromEntries(rows.map((r) => [r.node.id, r]));
    expect(byId.a.hasChildren).toBe(true);
    expect(byId.a1.hasChildren).toBe(false);
  });

  it("omits descendants of a collapsed node but keeps the node", () => {
    const collapsed: MindMapModel = {
      ...tree,
      children: [{ ...tree.children[0], collapsed: true }, tree.children[1]],
    };
    const rows = outlineRows(collapsed);
    expect(rows.map((r) => r.node.id)).toEqual(["root", "a", "b", "b1"]);
    const a = rows.find((r) => r.node.id === "a")!;
    expect(a.collapsed).toBe(true);
    expect(a.hasChildren).toBe(true);
  });
});

describe("verticalMoveInText", () => {
  it("returns null when there is no line in the given direction", () => {
    expect(verticalMoveInText("one line", 3, -1)).toBeNull();
    expect(verticalMoveInText("one line", 3, 1)).toBeNull();
  });

  it("preserves the column moving down", () => {
    // "abc\ndefgh" — pos 2 is column 2 on line 0 → column 2 on line 1 = index 6
    expect(verticalMoveInText("abc\ndefgh", 2, 1)).toBe(6);
  });

  it("clamps the column to a shorter target line", () => {
    // "abcdef\ngh" — pos 5 (col 5) down onto "gh" (len 2) → end of "gh" = index 9
    expect(verticalMoveInText("abcdef\ngh", 5, 1)).toBe(9);
  });

  it("moves up preserving column", () => {
    // "abcde\nfg" — pos 7 (line1 col1) up → line0 col1 = index 1
    expect(verticalMoveInText("abcde\nfg", 7, -1)).toBe(1);
  });
});
