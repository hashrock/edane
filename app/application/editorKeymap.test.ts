import { describe, it, expect, vi } from "vitest";
import type { MindMapModel } from "../domain/model";
import type { EditorState, EditorAction } from "./editorReducer";
import {
  buildKeymap,
  runKeymap,
  activeNode,
  type KeymapDeps,
  type KeyContext,
} from "./editorKeymap";

/** Root → A(children: A1) , B */
function model(): MindMapModel {
  return {
    id: "root",
    text: "Root",
    children: [
      { id: "a", text: "A", children: [{ id: "a1", text: "A1", children: [] }] },
      { id: "b", text: "B", children: [] },
    ],
  };
}

function state(
  m: MindMapModel,
  activeNodeId: string | null,
  editing: boolean,
  editingText = ""
): EditorState {
  return {
    document: { model: m, clipboard: null },
    view: {
      activeNodeId,
      editing,
      editingText,
      cursorPos: 0,
      selectionEnd: 0,
    },
  };
}

interface FakeKey {
  key: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
}

function makeDeps(overrides: Partial<KeymapDeps> = {}) {
  const dispatched: EditorAction[] = [];
  const deps: KeymapDeps = {
    dispatch: vi.fn((action: EditorAction) => {
      dispatched.push(action);
      // Return a fresh, shaped state so run()'s `next !== ctx.state` checks pass
      // and any follow-up saveNote(next.document.model) is safe.
      return {
        document: { model: {} as MindMapModel, clipboard: null },
        view: {
          activeNodeId: null,
          editing: false,
          editingText: "",
          cursorPos: 0,
          selectionEnd: 0,
        },
      } as EditorState;
    }),
    saveNote: vi.fn(),
    openPalette: vi.fn(),
    openHelp: vi.fn(),
    blurInput: vi.fn(),
    undo: vi.fn(),
    redo: vi.fn(),
    verticalMove: vi.fn(() => null),
    ...overrides,
  };
  return { deps, dispatched };
}

function run(
  deps: KeymapDeps,
  st: EditorState,
  fake: FakeKey,
  ctxPatch: Partial<KeyContext> = {}
) {
  const preventDefault = vi.fn();
  const e = { preventDefault, ...fake } as unknown as KeyContext["e"];
  const ctx: KeyContext = {
    e,
    state: st,
    node: activeNode(st),
    pos: 0,
    selEnd: 0,
    ...ctxPatch,
  };
  runKeymap(buildKeymap(deps), ctx);
  return { preventDefault };
}

describe("global bindings", () => {
  it("Cmd+K opens the palette and is handled", () => {
    const { deps } = makeDeps();
    const { preventDefault } = run(deps, state(model(), "a", false), {
      key: "k",
      metaKey: true,
    });
    expect(deps.openPalette).toHaveBeenCalled();
    expect(preventDefault).toHaveBeenCalled();
  });

  it("Ctrl+Z undoes, Ctrl+Shift+Z and Ctrl+Y redo", () => {
    const { deps } = makeDeps();
    run(deps, state(model(), "a", true), { key: "z", ctrlKey: true });
    run(deps, state(model(), "a", true), {
      key: "z",
      ctrlKey: true,
      shiftKey: true,
    });
    run(deps, state(model(), "a", true), { key: "y", ctrlKey: true });
    expect(deps.undo).toHaveBeenCalledTimes(1);
    expect(deps.redo).toHaveBeenCalledTimes(2);
  });

  it("works even with no active node", () => {
    const { deps } = makeDeps();
    run(deps, state(model(), null, false), { key: "k", metaKey: true });
    expect(deps.openPalette).toHaveBeenCalled();
  });
});

describe("selection-mode collapse / navigate", () => {
  it("Right expands a collapsed parent", () => {
    const m = model();
    m.children[0].collapsed = true;
    const { deps, dispatched } = makeDeps();
    run(deps, state(m, "a", false), { key: "ArrowRight" });
    expect(dispatched).toEqual([{ type: "toggleCollapse", nodeId: "a" }]);
  });

  it("Right on an expanded parent moves into the first child", () => {
    const { deps, dispatched } = makeDeps();
    run(deps, state(model(), "a", false), { key: "ArrowRight" });
    expect(dispatched).toEqual([{ type: "moveDown" }]);
  });

  it("Right on a leaf is swallowed (handled, no dispatch)", () => {
    const { deps, dispatched } = makeDeps();
    const { preventDefault } = run(deps, state(model(), "b", false), {
      key: "ArrowRight",
    });
    expect(dispatched).toEqual([]);
    expect(preventDefault).toHaveBeenCalled();
  });

  it("Left collapses an expanded parent", () => {
    const { deps, dispatched } = makeDeps();
    run(deps, state(model(), "a", false), { key: "ArrowLeft" });
    expect(dispatched).toEqual([{ type: "toggleCollapse", nodeId: "a" }]);
  });

  it("Left on a leaf moves to the parent", () => {
    const { deps, dispatched } = makeDeps();
    run(deps, state(model(), "a1", false), { key: "ArrowLeft" });
    expect(dispatched).toEqual([{ type: "moveToParent" }]);
  });

  it("Enter inserts a sibling after the selected node", () => {
    const { deps, dispatched } = makeDeps();
    const { preventDefault } = run(deps, state(model(), "a", false), {
      key: "Enter",
    });
    expect(dispatched).toEqual([{ type: "insertSiblingAfter" }]);
    expect(preventDefault).toHaveBeenCalled();
  });

  it("Space starts editing the selected node", () => {
    const { deps, dispatched } = makeDeps();
    const { preventDefault } = run(deps, state(model(), "a", false), {
      key: " ",
    });
    expect(dispatched).toEqual([{ type: "startEditing" }]);
    expect(preventDefault).toHaveBeenCalled();
  });
});

describe("reorder and bold (cross-mode)", () => {
  it("Alt+ArrowUp reorders up, in selection mode", () => {
    const { deps, dispatched } = makeDeps();
    run(deps, state(model(), "b", false), { key: "ArrowUp", altKey: true });
    expect(dispatched).toEqual([{ type: "moveNodeUp" }]);
  });

  it("Alt+ArrowDown reorders down, in editing mode", () => {
    const { deps, dispatched } = makeDeps();
    run(deps, state(model(), "a", true), { key: "ArrowDown", altKey: true });
    expect(dispatched).toEqual([{ type: "moveNodeDown" }]);
  });

  it("Cmd+B toggles bold on a text node", () => {
    const { deps, dispatched } = makeDeps();
    run(deps, state(model(), "a", true), { key: "b", metaKey: true });
    expect(dispatched).toEqual([
      { type: "setNodeStyle", nodeId: "a", bold: true },
    ]);
  });

  it("Cmd+B is a no-op dispatch on a non-text node", () => {
    const m = model();
    m.children[0].type = "image";
    const { deps, dispatched } = makeDeps();
    const { preventDefault } = run(deps, state(m, "a", true), {
      key: "b",
      metaKey: true,
    });
    expect(dispatched).toEqual([]);
    expect(preventDefault).toHaveBeenCalled(); // still swallowed
  });
});

describe("editing-mode passes vs handles", () => {
  it("Shift+Enter passes to native (no dispatch, no preventDefault)", () => {
    const { deps, dispatched } = makeDeps();
    const { preventDefault } = run(deps, state(model(), "a", true, "hi"), {
      key: "Enter",
      shiftKey: true,
    });
    expect(dispatched).toEqual([]);
    expect(preventDefault).not.toHaveBeenCalled();
  });

  it("Enter splits the node", () => {
    const { deps, dispatched } = makeDeps();
    run(deps, state(model(), "a", true, "hi"), { key: "Enter" }, { pos: 1 });
    expect(dispatched).toEqual([{ type: "enter", pos: 1 }]);
  });

  it("Backspace at caret 0 merges with the previous node", () => {
    const { deps, dispatched } = makeDeps();
    run(deps, state(model(), "a", true, "hi"), { key: "Backspace" });
    expect(dispatched).toEqual([{ type: "backspaceAtStart" }]);
  });

  it("Backspace mid-text passes to native", () => {
    const { deps, dispatched } = makeDeps();
    const { preventDefault } = run(
      deps,
      state(model(), "a", true, "hi"),
      { key: "Backspace" },
      { pos: 1, selEnd: 1 }
    );
    expect(dispatched).toEqual([]);
    expect(preventDefault).not.toHaveBeenCalled();
  });

  it("printable keys in selection mode fall through to native", () => {
    const { deps, dispatched } = makeDeps();
    const { preventDefault } = run(deps, state(model(), "a", false), {
      key: "x",
    });
    expect(dispatched).toEqual([]);
    expect(preventDefault).not.toHaveBeenCalled();
  });
});
