import { describe, it, expect } from "vitest";
import type { MindMapDocument, MindMapModel } from "../domain/model";
import { nextMultiSelection } from "./selection";

function doc(roots: MindMapModel[], title = "Root"): MindMapDocument {
  return { title, roots };
}

/** A B C D, each a root sibling — a flat, easy-to-reason-about order. */
function flatDoc(): MindMapDocument {
  return doc([
    { id: "a", text: "A", children: [] },
    { id: "b", text: "B", children: [] },
    { id: "c", text: "C", children: [] },
    { id: "d", text: "D", children: [] },
  ]);
}

describe("nextMultiSelection", () => {
  it("returns [] with no modifier held (the caller's plain-click path clears selection)", () => {
    expect(
      nextMultiSelection(flatDoc(), "a", [], "b", { shiftKey: false, toggleKey: false })
    ).toEqual([]);
  });

  it("ctrl/cmd-click starts a two-node selection from the active node", () => {
    expect(
      nextMultiSelection(flatDoc(), "a", [], "c", { shiftKey: false, toggleKey: true })
    ).toEqual(["a", "c"]);
  });

  it("ctrl/cmd-click toggles a node out of an existing selection", () => {
    expect(
      nextMultiSelection(flatDoc(), "a", ["a", "b", "c"], "b", {
        shiftKey: false,
        toggleKey: true,
      })
    ).toEqual(["a", "c"]);
  });

  it("ctrl/cmd-click toggling the sole active node clears the selection", () => {
    expect(
      nextMultiSelection(flatDoc(), "a", [], "a", { shiftKey: false, toggleKey: true })
    ).toEqual([]);
  });

  it("shift-click selects the flat-order range from the active node, inclusive", () => {
    expect(
      nextMultiSelection(flatDoc(), "a", [], "c", { shiftKey: true, toggleKey: false })
    ).toEqual(["a", "b", "c"]);
  });

  it("shift-click range direction doesn't matter — same set backward or forward", () => {
    expect(
      nextMultiSelection(flatDoc(), "c", [], "a", { shiftKey: true, toggleKey: false })
    ).toEqual(["a", "b", "c"]);
  });

  it("shift-click with no active node falls back to just the clicked node", () => {
    expect(
      nextMultiSelection(flatDoc(), null, [], "b", { shiftKey: true, toggleKey: false })
    ).toEqual(["b"]);
  });

  it("shift beats ctrl/cmd when both are held", () => {
    expect(
      nextMultiSelection(flatDoc(), "a", ["x"], "c", { shiftKey: true, toggleKey: true })
    ).toEqual(["a", "b", "c"]);
  });
});
