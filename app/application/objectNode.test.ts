/**
 * Object-node behaviour across layers: domain navigation order, reducer
 * card-sibling prefill / row guards, persistence round-trip, outline rows and
 * flat-node layout.
 */

import { describe, it, expect } from "vitest";
import type { MindMapModel } from "../domain/model";
import { getFlatOrder, setNumFormat, findNode } from "../domain/model";
import { editorReducer, type EditorState } from "./editorReducer";
import { normalizeTree } from "./persistence";
import { outlineRows } from "./outline";
import { flattenToNodes, layoutObjectRows } from "./nodeUtils";
import { layoutMindMap } from "../lib/treeLayout";

function sampleModel(): MindMapModel {
  return {
    id: "root",
    text: "Root",
    children: [
      {
        id: "card",
        text: "商品A",
        type: "object",
        children: [
          { id: "r1", text: "価格: 1200", children: [] },
          {
            id: "r2",
            text: "メモ: あり",
            children: [{ id: "hidden", text: "詳細", children: [] }],
          },
        ],
      },
      { id: "b", text: "B", children: [] },
    ],
  };
}

function state(
  model: MindMapModel,
  activeNodeId: string,
  editing = false
): EditorState {
  const text = findNode(model, activeNodeId)?.text ?? "";
  return {
    document: { model, clipboard: null },
    view: {
      activeNodeId,
      editing,
      editingText: text,
      cursorPos: text.length,
      selectionEnd: text.length,
    },
  };
}

describe("getFlatOrder with object nodes", () => {
  it("includes card rows but not their hidden subtrees", () => {
    expect(getFlatOrder(sampleModel())).toEqual([
      "root",
      "card",
      "r1",
      "r2",
      "b",
    ]);
  });

  it("skips rows entirely when the card is collapsed", () => {
    const model = sampleModel();
    model.children[0].collapsed = true;
    expect(getFlatOrder(model)).toEqual(["root", "card", "b"]);
  });
});

describe("setNumFormat", () => {
  it("sets and clears format fields", () => {
    let model = setNumFormat(sampleModel(), "r1", {
      numFormat: "currency",
      decimals: 2,
    });
    expect(findNode(model, "r1")).toMatchObject({
      numFormat: "currency",
      decimals: 2,
    });
    model = setNumFormat(model, "r1", { numFormat: null, decimals: null });
    const node = findNode(model, "r1")!;
    expect(node.numFormat).toBeUndefined();
    expect(node.decimals).toBeUndefined();
  });
});

describe("reducer: object-card editing", () => {
  it("insertSiblingAfter on a card creates a prefilled sibling card", () => {
    const next = editorReducer(state(sampleModel(), "card"), {
      type: "insertSiblingAfter",
    });
    const root = next.document.model;
    const created = root.children[1];
    expect(created.type).toBe("object");
    expect(created.children.map((c) => c.text)).toEqual(["価格: ", "メモ: "]);
    expect(next.view.activeNodeId).toBe(created.id);
    expect(next.view.editing).toBe(true);
  });

  it("Enter while editing a card title creates the next card, never splits", () => {
    const next = editorReducer(state(sampleModel(), "card", true), {
      type: "enter",
      pos: 2, // mid-title — a plain node would split here
    });
    const root = next.document.model;
    expect(findNode(root, "card")!.text).toBe("商品A");
    const created = root.children[1];
    expect(created.type).toBe("object");
    expect(next.view.activeNodeId).toBe(created.id);
  });

  it("Enter on a row splits/appends rows as plain nodes", () => {
    const next = editorReducer(state(sampleModel(), "r1", true), {
      type: "enter",
      pos: "価格: 1200".length,
    });
    const card = findNode(next.document.model, "card")!;
    expect(card.children).toHaveLength(3);
    expect(card.children[1].text).toBe("");
  });

  it("blocks Tab-indent of a card row (it would hide the row)", () => {
    const before = state(sampleModel(), "r2");
    const next = editorReducer(before, { type: "tab", shift: false });
    expect(next.document.model).toBe(before.document.model);
  });

  it("allows Shift+Tab to move a row out of the card", () => {
    const next = editorReducer(state(sampleModel(), "r2"), {
      type: "tab",
      shift: true,
    });
    const card = findNode(next.document.model, "card")!;
    expect(card.children).toHaveLength(1);
    expect(next.document.model.children.map((c) => c.id)).toEqual([
      "card",
      "r2",
      "b",
    ]);
  });

  it("setNumFormat action updates the row", () => {
    const next = editorReducer(state(sampleModel(), "r1"), {
      type: "setNumFormat",
      nodeId: "r1",
      numFormat: "percent",
    });
    expect(findNode(next.document.model, "r1")!.numFormat).toBe("percent");
  });
});

describe("persistence: normalizeTree", () => {
  it("preserves object type and numeric format fields", () => {
    const raw = JSON.parse(
      JSON.stringify({
        id: "a",
        text: "t",
        type: "object",
        children: [
          {
            id: "b",
            text: "価格: 1",
            numFormat: "currency",
            decimals: 2,
            children: [],
          },
        ],
      })
    );
    const node = normalizeTree(raw, new Set())!;
    expect(node.type).toBe("object");
    expect(node.children[0].numFormat).toBe("currency");
    expect(node.children[0].decimals).toBe(2);
  });

  it("drops malformed format fields", () => {
    const node = normalizeTree(
      { id: "a", text: "t", numFormat: "bogus", decimals: 99, children: [] },
      new Set()
    )!;
    expect(node.numFormat).toBeUndefined();
    expect(node.decimals).toBeUndefined();
  });
});

describe("outlineRows with object nodes", () => {
  it("mirrors getFlatOrder: rows visible, row subtrees hidden with a count", () => {
    const rows = outlineRows(sampleModel());
    expect(rows.map((r) => r.node.id)).toEqual([
      "root",
      "card",
      "r1",
      "r2",
      "b",
    ]);
    const r2 = rows.find((r) => r.node.id === "r2")!;
    expect(r2.hasChildren).toBe(true);
    expect(r2.collapsed).toBe(true);
  });
});

describe("flattenToNodes + layoutObjectRows", () => {
  it("emits the card as a layout leaf and anchors rows inside its box", () => {
    const flat = flattenToNodes(sampleModel());
    const card = flat.find((n) => n.id === "card")!;
    expect(card.card).toBeDefined();
    expect(card.children).toEqual([]); // layout leaf — rows aren't tree children
    expect(card.childCount).toBe(2);

    const r1 = flat.find((n) => n.id === "r1")!;
    expect(r1.cardRow).toMatchObject({ cardId: "card", index: 0, key: "価格" });
    // Hidden subtree nodes are not emitted at all.
    expect(flat.find((n) => n.id === "hidden")).toBeUndefined();

    layoutMindMap(flat);
    layoutObjectRows(flat);
    const top = card.y - Math.max(32, card.height) / 2;
    expect(r1.x).toBe(card.x);
    expect(r1.y).toBeGreaterThan(top);
    expect(r1.y).toBeLessThan(card.y + card.height / 2);
  });

  it("keeps a collapsed object node as a plain collapsed node", () => {
    const model = sampleModel();
    model.children[0].collapsed = true;
    const flat = flattenToNodes(model);
    const card = flat.find((n) => n.id === "card")!;
    expect(card.card).toBeUndefined();
    expect(card.collapsed).toBe(true);
    expect(card.childCount).toBe(2);
    expect(flat.find((n) => n.id === "r1")).toBeUndefined();
  });
});
