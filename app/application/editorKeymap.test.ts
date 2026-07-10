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
import {
  DEFAULT_PREFERENCES,
  type EditorPreferences,
} from "./editorPreferences";

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
  ctxPatch: Partial<KeyContext> = {},
  prefs: EditorPreferences = DEFAULT_PREFERENCES
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
  runKeymap(buildKeymap(deps, prefs), ctx, prefs);
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
});

describe("cross-mode collapse chord (Cmd/Ctrl + .)", () => {
  it("toggles collapse while editing a parent node", () => {
    const { deps, dispatched } = makeDeps();
    const { preventDefault } = run(deps, state(model(), "a", true, "A"), {
      key: ".",
      metaKey: true,
    });
    expect(dispatched).toEqual([{ type: "toggleCollapse", nodeId: "a" }]);
    expect(preventDefault).toHaveBeenCalled();
  });

  it("toggles collapse in selection mode too", () => {
    const { deps, dispatched } = makeDeps();
    run(deps, state(model(), "a", false), { key: ".", ctrlKey: true });
    expect(dispatched).toEqual([{ type: "toggleCollapse", nodeId: "a" }]);
  });

  it("is swallowed on a leaf node (handled, no dispatch)", () => {
    const { deps, dispatched } = makeDeps();
    const { preventDefault } = run(deps, state(model(), "b", true, "B"), {
      key: ".",
      metaKey: true,
    });
    expect(dispatched).toEqual([]);
    expect(preventDefault).toHaveBeenCalled();
  });

  it("saves after a successful toggle", () => {
    const { deps } = makeDeps();
    run(deps, state(model(), "a", true, "A"), { key: ".", metaKey: true });
    expect(deps.saveNote).toHaveBeenCalled();
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

describe("preference: tabBehavior = insert-child", () => {
  const prefs: EditorPreferences = {
    ...DEFAULT_PREFERENCES,
    tabBehavior: "insert-child",
  };

  it("Tab inserts a child and starts editing it", () => {
    const { deps, dispatched } = makeDeps();
    run(deps, state(model(), "a", false), { key: "Tab" }, {}, prefs);
    expect(dispatched).toEqual([
      { type: "addChild", nodeId: "a" },
      { type: "startEditing" },
    ]);
    expect(deps.saveNote).toHaveBeenCalled();
  });

  it("Shift+Tab still outdents", () => {
    const { deps, dispatched } = makeDeps();
    run(
      deps,
      state(model(), "a1", false),
      { key: "Tab", shiftKey: true },
      {},
      prefs
    );
    expect(dispatched).toEqual([{ type: "tab", shift: true }]);
  });

  it("Tab is swallowed on a row of an object card (its subtree is hidden)", () => {
    const m = model();
    m.children[0].type = "object"; // "a" is a card; "a1" is one of its rows
    const { deps, dispatched } = makeDeps();
    const { preventDefault } = run(
      deps,
      state(m, "a1", false),
      { key: "Tab" },
      {},
      prefs
    );
    expect(dispatched).toEqual([]);
    expect(preventDefault).toHaveBeenCalled();
  });

  it("Tab in editing mode keeps indenting regardless of the preference", () => {
    const { deps, dispatched } = makeDeps();
    run(
      deps,
      state(model(), "a", true, "A"),
      { key: "Tab", shiftKey: false },
      {},
      prefs
    );
    expect(dispatched).toEqual([{ type: "tab", shift: false }]);
  });
});

describe("preference: arrowBehavior = navigate", () => {
  const prefs: EditorPreferences = {
    ...DEFAULT_PREFERENCES,
    arrowBehavior: "navigate",
  };

  it("Right moves into the first child of an expanded parent", () => {
    const { deps, dispatched } = makeDeps();
    run(deps, state(model(), "a", false), { key: "ArrowRight" }, {}, prefs);
    expect(dispatched).toEqual([{ type: "moveDown" }]);
  });

  it("Right auto-expands a collapsed parent before moving in", () => {
    const m = model();
    m.children[0].collapsed = true;
    const { deps, dispatched } = makeDeps();
    run(deps, state(m, "a", false), { key: "ArrowRight" }, {}, prefs);
    expect(dispatched).toEqual([
      { type: "toggleCollapse", nodeId: "a" },
      { type: "moveDown" },
    ]);
  });

  it("Right on a leaf is swallowed", () => {
    const { deps, dispatched } = makeDeps();
    const { preventDefault } = run(
      deps,
      state(model(), "b", false),
      { key: "ArrowRight" },
      {},
      prefs
    );
    expect(dispatched).toEqual([]);
    expect(preventDefault).toHaveBeenCalled();
  });

  it("Left always moves to the parent, never collapses", () => {
    const { deps, dispatched } = makeDeps();
    run(deps, state(model(), "a", false), { key: "ArrowLeft" }, {}, prefs);
    expect(dispatched).toEqual([{ type: "moveToParent" }]);
  });
});

describe("preference: selectionMode = false (always edit)", () => {
  const prefs: EditorPreferences = {
    ...DEFAULT_PREFERENCES,
    selectionMode: false,
  };

  it("editing bindings fire even when view.editing is false (forced mode)", () => {
    const { deps, dispatched } = makeDeps();
    // Enter with view.editing=false would insert a sibling in selection mode;
    // always-edit must route it to the editing split instead.
    run(deps, state(model(), "a", false, "A"), { key: "Enter" }, { pos: 1 }, prefs);
    expect(dispatched).toEqual([{ type: "enter", pos: 1 }]);
  });

  it("Escape does nothing (falls through to native)", () => {
    const { deps, dispatched } = makeDeps();
    const { preventDefault } = run(
      deps,
      state(model(), "a", true, "A"),
      { key: "Escape" },
      {},
      prefs
    );
    expect(dispatched).toEqual([]);
    expect(preventDefault).not.toHaveBeenCalled();
  });

  it("Cmd+Shift+Backspace deletes the branch", () => {
    const { deps, dispatched } = makeDeps();
    run(
      deps,
      state(model(), "a", true, "A"),
      { key: "Backspace", metaKey: true, shiftKey: true },
      {},
      prefs
    );
    expect(dispatched).toEqual([{ type: "deleteNode", nodeId: "a" }]);
  });

  it("plain Backspace at caret 0 still merges instead of deleting", () => {
    const { deps, dispatched } = makeDeps();
    run(deps, state(model(), "a", true, "A"), { key: "Backspace" }, {}, prefs);
    expect(dispatched).toEqual([{ type: "backspaceAtStart" }]);
  });

  it("selection-only bindings are absent from the keymap (help stays truthful)", () => {
    const { deps } = makeDeps();
    const bindings = buildKeymap(deps, prefs);
    expect(bindings.some((b) => b.when === "selection")).toBe(false);
    expect(bindings.some((b) => b.id === "edit-escape")).toBe(false);
  });
});

describe("help chord (Cmd/Ctrl + /)", () => {
  it("opens help while editing, with default preferences", () => {
    const { deps } = makeDeps();
    run(deps, state(model(), "a", true, "A"), { key: "/", metaKey: true });
    expect(deps.openHelp).toHaveBeenCalled();
  });

  it("opens help in always-edit mode", () => {
    const { deps } = makeDeps();
    run(
      deps,
      state(model(), "a", true, "A"),
      { key: "/", ctrlKey: true },
      {},
      { ...DEFAULT_PREFERENCES, selectionMode: false }
    );
    expect(deps.openHelp).toHaveBeenCalled();
  });
});
