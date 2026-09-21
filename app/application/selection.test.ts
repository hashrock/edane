import { describe, it, expect } from "vitest";
import type { MindMapDocument, MindMapModel } from "../domain/model";
import {
  checkboxMenuTargets,
  nextMultiSelection,
  outermostBranches,
  planGroupCheckToggle,
  planGroupCollapse,
} from "./selection";

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

/** Mixed: one open task, one done task, one plain note, one image (no box). */
function taskDoc(): MindMapDocument {
  return doc([
    { id: "open", text: "Open", checked: false, children: [] },
    { id: "done", text: "Done", checked: true, children: [] },
    { id: "plain", text: "Plain", children: [] },
    { id: "pic", text: "https://x/y.png", type: "image", children: [] },
  ]);
}

describe("checkboxMenuTargets", () => {
  it("splits a mixed selection into the ones to create and the ones to move", () => {
    expect(
      checkboxMenuTargets(taskDoc(), ["open", "done", "plain", "pic"])
    ).toEqual({ plain: ["plain"], tasked: ["open", "done"] });
  });

  it("skips kinds that never show a box, and ids that no longer exist", () => {
    expect(checkboxMenuTargets(taskDoc(), ["pic", "ghost"])).toEqual({
      plain: [],
      tasked: [],
    });
  });

  it("a single id behaves exactly like the old single-node menu", () => {
    expect(checkboxMenuTargets(taskDoc(), ["plain"])).toEqual({
      plain: ["plain"],
      tasked: [],
    });
    expect(checkboxMenuTargets(taskDoc(), ["done"])).toEqual({
      plain: [],
      tasked: ["done"],
    });
  });
});

describe("planGroupCheckToggle", () => {
  it("checks everyone when the group is mixed", () => {
    expect(
      planGroupCheckToggle(taskDoc(), ["open", "done"], { requireExisting: true })
    ).toEqual({ nodeIds: ["open", "done"], checked: true });
  });

  it("opens everyone when the whole group is already done", () => {
    expect(
      planGroupCheckToggle(taskDoc(), ["done"], { requireExisting: true })
    ).toEqual({ nodeIds: ["done"], checked: false });
  });

  it("requireExisting skips nodes that have no box yet; without it they join", () => {
    expect(
      planGroupCheckToggle(taskDoc(), ["done", "plain"], { requireExisting: true })
    ).toEqual({ nodeIds: ["done"], checked: false });
    expect(
      planGroupCheckToggle(taskDoc(), ["done", "plain"], { requireExisting: false })
    ).toEqual({ nodeIds: ["done", "plain"], checked: true });
  });

  it("returns null when nothing in the selection qualifies", () => {
    expect(
      planGroupCheckToggle(taskDoc(), ["pic", "plain"], { requireExisting: true })
    ).toBeNull();
  });
});

/** Two trees, one of them nested two deep and already folded. */
function treeDoc(): MindMapDocument {
  return doc([
    {
      id: "a",
      text: "A",
      children: [
        { id: "a1", text: "A1", children: [{ id: "a1x", text: "A1x", children: [] }] },
      ],
    },
    { id: "b", text: "B", collapsed: true, children: [{ id: "b1", text: "B1", children: [] }] },
    { id: "c", text: "C", children: [] },
  ]);
}

describe("planGroupCollapse", () => {
  it("folds everyone when the group is mixed (and skips the leaves)", () => {
    expect(planGroupCollapse(treeDoc(), ["a", "b", "c"])).toEqual({
      nodeIds: ["a", "b"],
      collapsed: true,
    });
  });

  it("opens everyone when the whole group is already folded", () => {
    expect(planGroupCollapse(treeDoc(), ["b"])).toEqual({
      nodeIds: ["b"],
      collapsed: false,
    });
  });

  it("is the plain flip over a single node", () => {
    expect(planGroupCollapse(treeDoc(), ["a"])).toEqual({
      nodeIds: ["a"],
      collapsed: true,
    });
  });

  it("returns null when nothing in the selection has children", () => {
    expect(planGroupCollapse(treeDoc(), ["c", "a1x"])).toBeNull();
  });
});

describe("outermostBranches", () => {
  it("drops the ids that sit inside another selected branch", () => {
    expect(outermostBranches(treeDoc(), ["a", "a1", "a1x", "c"])).toEqual(["a", "c"]);
  });

  it("reads out in document order whatever order the ids came in", () => {
    expect(outermostBranches(treeDoc(), ["c", "b", "a"])).toEqual(["a", "b", "c"]);
  });

  it("walks into folded branches — hidden is not the same as unselected", () => {
    expect(outermostBranches(treeDoc(), ["b1"])).toEqual(["b1"]);
  });

  it("ignores ids that no longer exist", () => {
    expect(outermostBranches(treeDoc(), ["ghost", "c"])).toEqual(["c"]);
  });
});
