import { describe, it, expect } from "vitest";
import type { MindMapModel } from "../domain/model";
import type { EditorState } from "./editorReducer";
import {
  buildKeymap,
  runKeymap,
  activeNode,
  type KeyContext,
  type KeymapKeyEvent,
  type VerticalMove,
} from "./editorKeymap";
import {
  DEFAULT_PREFERENCES,
  type EditorPreferences,
} from "./editorPreferences";
import type { EditorLayout } from "./editSurface";

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
      lastChildByParent: {},
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

/**
 * Run one key through the (pure) keymap and unpack its outcome: `handled`
 * (the caller would preventDefault), the dispatched actions in order, and the
 * kinds of every effect (so `kinds` shows a "save" between two dispatches).
 */
function run(
  st: EditorState,
  fake: FakeKey,
  ctxPatch: Partial<KeyContext> = {},
  prefs: EditorPreferences = DEFAULT_PREFERENCES,
  layout: EditorLayout = "canvas",
  verticalMove: VerticalMove = () => null // past the edge = cross to a node
) {
  const e: KeymapKeyEvent = {
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    ...fake,
  };
  const ctx: KeyContext = {
    e,
    state: st,
    node: activeNode(st),
    pos: 0,
    selEnd: 0,
    ...ctxPatch,
  };
  const out = runKeymap(buildKeymap(prefs, layout, verticalMove), ctx, prefs);
  return {
    handled: out.result === "handled",
    dispatched: out.effects.flatMap((f) => (f.kind === "dispatch" ? [f.action] : [])),
    kinds: out.effects.map((f) => f.kind),
  };
}

describe("global bindings", () => {
  it("Cmd+K opens the palette and is handled", () => {
    const r = run(state(model(), "a", false), { key: "k", metaKey: true });
    expect(r.kinds).toEqual(["openPalette"]);
    expect(r.handled).toBe(true);
  });

  it("Ctrl+Z undoes, Ctrl+Shift+Z and Ctrl+Y redo", () => {
    const st = () => state(model(), "a", true);
    expect(run(st(), { key: "z", ctrlKey: true }).kinds).toEqual(["undo"]);
    expect(run(st(), { key: "z", ctrlKey: true, shiftKey: true }).kinds).toEqual(["redo"]);
    expect(run(st(), { key: "y", ctrlKey: true }).kinds).toEqual(["redo"]);
  });

  it("works even with no active node", () => {
    const r = run(state(model(), null, false), { key: "k", metaKey: true });
    expect(r.kinds).toEqual(["openPalette"]);
  });
});

// ←/→ is a user preference, so each behaviour is pinned to its own setting
// rather than riding on DEFAULT_PREFERENCES — the default may move again
// (it already went "collapse" → "navigate") without silently retargeting
// these cases. The navigate half lives in its own describe below.
describe("preference: arrowBehavior = collapse", () => {
  const prefs: EditorPreferences = {
    ...DEFAULT_PREFERENCES,
    arrowBehavior: "collapse",
  };

  it("Right expands a collapsed parent (and saves)", () => {
    const m = model();
    m.children[0].collapsed = true;
    const r = run(state(m, "a", false), { key: "ArrowRight" }, {}, prefs);
    expect(r.dispatched).toEqual([{ type: "toggleCollapse", nodeId: "a" }]);
    expect(r.kinds).toEqual(["dispatch", "save"]);
  });

  it("Right on an expanded parent descends to the last-visited child", () => {
    const r = run(state(model(), "a", false), { key: "ArrowRight" }, {}, prefs);
    expect(r.dispatched).toEqual([{ type: "moveToChild" }]);
  });

  it("Right on a leaf is swallowed (handled, no effects)", () => {
    const r = run(state(model(), "b", false), { key: "ArrowRight" }, {}, prefs);
    expect(r.kinds).toEqual([]);
    expect(r.handled).toBe(true);
  });

  it("Left collapses an expanded parent", () => {
    const r = run(state(model(), "a", false), { key: "ArrowLeft" }, {}, prefs);
    expect(r.dispatched).toEqual([{ type: "toggleCollapse", nodeId: "a" }]);
    expect(r.kinds).toEqual(["dispatch", "save"]);
  });

  it("Left on a leaf moves to the parent", () => {
    const r = run(state(model(), "a1", false), { key: "ArrowLeft" }, {}, prefs);
    expect(r.dispatched).toEqual([{ type: "moveToParent" }]);
  });
});

describe("cross-mode collapse chord (Cmd/Ctrl + .)", () => {
  it("toggles collapse while editing a parent node", () => {
    const r = run(state(model(), "a", true, "A"), { key: ".", metaKey: true });
    expect(r.dispatched).toEqual([{ type: "toggleCollapse", nodeId: "a" }]);
    expect(r.handled).toBe(true);
  });

  it("toggles collapse in selection mode too", () => {
    const r = run(state(model(), "a", false), { key: ".", ctrlKey: true });
    expect(r.dispatched).toEqual([{ type: "toggleCollapse", nodeId: "a" }]);
  });

  it("is swallowed on a leaf node (handled, no effects)", () => {
    const r = run(state(model(), "b", true, "B"), { key: ".", metaKey: true });
    expect(r.kinds).toEqual([]);
    expect(r.handled).toBe(true);
  });

  it("saves after the toggle", () => {
    const r = run(state(model(), "a", true, "A"), { key: ".", metaKey: true });
    expect(r.kinds).toEqual(["dispatch", "save"]);
  });

  it("Enter inserts a sibling after the selected node", () => {
    const r = run(state(model(), "a", false), { key: "Enter" });
    expect(r.dispatched).toEqual([{ type: "insertSiblingAfter" }]);
    expect(r.handled).toBe(true);
  });

  it("Space starts editing the selected node", () => {
    const r = run(state(model(), "a", false), { key: " " });
    expect(r.dispatched).toEqual([{ type: "startEditing" }]);
    expect(r.handled).toBe(true);
  });

  it("F2 also starts editing the selected node", () => {
    const r = run(state(model(), "a", false), { key: "F2" });
    expect(r.dispatched).toEqual([{ type: "startEditing" }]);
    expect(r.handled).toBe(true);
  });

  // Plain Enter is insert-sibling, so the chord is the Enter-flavoured way into
  // edit mode. Same payload as Space: no cursor args → whole text selected.
  it("Cmd+Enter starts editing instead of inserting a sibling", () => {
    const r = run(state(model(), "a", false), { key: "Enter", metaKey: true });
    expect(r.dispatched).toEqual([{ type: "startEditing" }]);
    expect(r.handled).toBe(true);
  });

  it("Ctrl+Enter starts editing too (windows/linux)", () => {
    const r = run(state(model(), "a", false), { key: "Enter", ctrlKey: true });
    expect(r.dispatched).toEqual([{ type: "startEditing" }]);
  });

  it("Cmd+Shift+Enter still starts editing (shift is ignored)", () => {
    const r = run(state(model(), "a", false), {
      key: "Enter",
      metaKey: true,
      shiftKey: true,
    });
    expect(r.dispatched).toEqual([{ type: "startEditing" }]);
  });
});

describe("task checkbox (Cmd/Ctrl + Shift + D)", () => {
  it("turns a plain node into an open task on the first press", () => {
    const r = run(state(model(), "a", false), {
      key: "d",
      metaKey: true,
      shiftKey: true,
    });
    expect(r.dispatched).toEqual([
      { type: "setChecked", nodeId: "a", checked: false },
    ]);
    expect(r.kinds).toEqual(["dispatch", "save"]);
    expect(r.handled).toBe(true);
  });

  it("flips an open task done, and a done task back open", () => {
    const withTask = (checked: boolean) => {
      const m = model();
      m.children[0].checked = checked;
      return m;
    };
    const open = run(state(withTask(false), "a", false), {
      key: "D",
      ctrlKey: true,
      shiftKey: true,
    });
    expect(open.dispatched).toEqual([
      { type: "setChecked", nodeId: "a", checked: true },
    ]);

    const done = run(state(withTask(true), "a", false), {
      key: "d",
      metaKey: true,
      shiftKey: true,
    });
    // Never back to "no checkbox": removing one is an explicit, separate act.
    expect(done.dispatched).toEqual([
      { type: "setChecked", nodeId: "a", checked: false },
    ]);
  });

  it("works while editing too, without disturbing the text", () => {
    const r = run(state(model(), "a", true, "A"), {
      key: "d",
      metaKey: true,
      shiftKey: true,
    });
    expect(r.dispatched).toEqual([
      { type: "setChecked", nodeId: "a", checked: false },
    ]);
  });

  it("does nothing on a kind that shows no checkbox", () => {
    const m = model();
    m.children[0].type = "image";
    const r = run(state(m, "a", false), {
      key: "d",
      metaKey: true,
      shiftKey: true,
    });
    expect(r.kinds).toEqual([]);
    // Still swallowed: the chord is ours, it just has nothing to do here.
    expect(r.handled).toBe(true);
  });

  it("leaves plain ⌘/Ctrl + D to the browser", () => {
    const r = run(state(model(), "a", false), { key: "d", metaKey: true });
    expect(r.kinds).toEqual([]);
    expect(r.handled).toBe(false);
  });
});

describe("reorder and bold (cross-mode)", () => {
  it("Alt+ArrowUp reorders up, in selection mode", () => {
    const r = run(state(model(), "b", false), { key: "ArrowUp", altKey: true });
    expect(r.dispatched).toEqual([{ type: "moveNodeUp" }]);
    expect(r.kinds).toEqual(["dispatch", "save"]);
  });

  it("Alt+ArrowDown reorders down, in editing mode", () => {
    const r = run(state(model(), "a", true), { key: "ArrowDown", altKey: true });
    expect(r.dispatched).toEqual([{ type: "moveNodeDown" }]);
  });

  it("Alt+ArrowRight indents / Alt+ArrowLeft outdents, in selection mode", () => {
    expect(
      run(state(model(), "b", false), { key: "ArrowRight", altKey: true }).dispatched
    ).toEqual([{ type: "tab", shift: false }]);
    expect(
      run(state(model(), "a1", false), { key: "ArrowLeft", altKey: true }).dispatched
    ).toEqual([{ type: "tab", shift: true }]);
  });

  // In a textarea Alt+←→ is macOS's word-wise caret move and Alt+Shift+←→ its
  // word-wise selection. Swallowing those would break plain text editing, so
  // the indent pair is selection-only and every Alt+arrow form passes through
  // untouched while editing.
  it("Alt+←→ and Alt+Shift+←→ pass through to native while editing", () => {
    for (const key of ["ArrowLeft", "ArrowRight"]) {
      for (const shiftKey of [false, true]) {
        const r = run(
          state(model(), "a1", true, "A1"),
          { key, altKey: true, shiftKey },
          { pos: 1, selEnd: 1 }
        );
        expect(r.kinds).toEqual([]);
        expect(r.handled).toBe(false);
      }
    }
  });

  // Alt+↑↓ (reorder) stays cross-mode: those have no native meaning to protect.
  it("Alt+↑↓ still reorder while editing", () => {
    const r = run(state(model(), "a1", true, "A1"), { key: "ArrowUp", altKey: true });
    expect(r.dispatched).toEqual([{ type: "moveNodeUp" }]);
  });

  // The pair keeps working with tabBehavior = insert-child, where Tab no longer
  // indents and these are the only re-parenting keys.
  it("Alt+←→ still indent/outdent with tabBehavior = insert-child", () => {
    const prefs: EditorPreferences = {
      ...DEFAULT_PREFERENCES,
      tabBehavior: "insert-child",
    };
    const r = run(
      state(model(), "b", false),
      { key: "ArrowRight", altKey: true },
      {},
      prefs
    );
    expect(r.dispatched).toEqual([{ type: "tab", shift: false }]);
  });

  it("Cmd+B toggles bold on a text node", () => {
    const r = run(state(model(), "a", true), { key: "b", metaKey: true });
    expect(r.dispatched).toEqual([
      { type: "setNodeStyle", nodeId: "a", bold: true },
    ]);
    expect(r.kinds).toEqual(["dispatch", "save"]);
  });

  it("Cmd+B has no effect on a non-text node", () => {
    const m = model();
    m.children[0].type = "image";
    const r = run(state(m, "a", true), { key: "b", metaKey: true });
    expect(r.kinds).toEqual([]);
    expect(r.handled).toBe(true); // still swallowed
  });
});

describe("editing-mode passes vs handles", () => {
  it("Shift+Enter passes to native (no effects, not handled)", () => {
    const r = run(state(model(), "a", true, "hi"), { key: "Enter", shiftKey: true });
    expect(r.kinds).toEqual([]);
    expect(r.handled).toBe(false);
  });

  it("Enter splits the node", () => {
    const r = run(state(model(), "a", true, "hi"), { key: "Enter" }, { pos: 1 });
    expect(r.dispatched).toEqual([{ type: "enter", pos: 1 }]);
  });

  it("Backspace at caret 0 merges with the previous node", () => {
    const r = run(state(model(), "a", true, "hi"), { key: "Backspace" });
    expect(r.dispatched).toEqual([{ type: "backspaceAtStart" }]);
  });

  it("Backspace mid-text passes to native", () => {
    const r = run(
      state(model(), "a", true, "hi"),
      { key: "Backspace" },
      { pos: 1, selEnd: 1 }
    );
    expect(r.kinds).toEqual([]);
    expect(r.handled).toBe(false);
  });

  // Delete is decided purely by asking the reducer whether the key would
  // change anything: only a caret at the end with a successor merges.
  it("Delete at the end of a node with a successor merges it (handled)", () => {
    const r = run(state(model(), "a", true, "A"), { key: "Delete" }, { pos: 1, selEnd: 1 });
    expect(r.dispatched).toEqual([{ type: "deleteAtEnd", pos: 1 }]);
    expect(r.handled).toBe(true);
  });

  it("Delete mid-text, or at the end of the last node, passes to native", () => {
    const mid = run(state(model(), "a", true, "A"), { key: "Delete" }, { pos: 0, selEnd: 0 });
    expect(mid.kinds).toEqual([]);
    expect(mid.handled).toBe(false);
    const last = run(state(model(), "b", true, "B"), { key: "Delete" }, { pos: 1, selEnd: 1 });
    expect(last.kinds).toEqual([]);
    expect(last.handled).toBe(false);
  });

  it("printable keys in selection mode fall through to native", () => {
    const r = run(state(model(), "a", false), { key: "x" });
    expect(r.kinds).toEqual([]);
    expect(r.handled).toBe(false);
  });
});

// ↑/↓ in selection mode follow the layout, not a preference: siblings on the
// canvas (what actually sits above/below), the flat order in the outline (drawn
// as one column). Editing mode must keep crossing nodes in BOTH layouts or the
// keyboard-escape invariant breaks.
describe("selection ↑/↓ per layout", () => {
  it("canvas moves between siblings", () => {
    const st = () => state(model(), "a", false);
    expect(run(st(), { key: "ArrowUp" }, {}, undefined, "canvas").dispatched).toEqual([
      { type: "moveUpSiblingFirst" },
    ]);
    expect(run(st(), { key: "ArrowDown" }, {}, undefined, "canvas").dispatched).toEqual([
      { type: "moveDownSiblingFirst" },
    ]);
  });

  it("outline keeps walking the flat order", () => {
    const st = () => state(model(), "a", false);
    expect(run(st(), { key: "ArrowUp" }, {}, undefined, "outline").dispatched).toEqual([
      { type: "moveUp" },
    ]);
    expect(run(st(), { key: "ArrowDown" }, {}, undefined, "outline").dispatched).toEqual([
      { type: "moveDown" },
    ]);
  });

  it("editing-mode ↑/↓ still cross to the adjacent node in both layouts", () => {
    for (const layout of ["canvas", "outline"] as const) {
      // verticalMove returns null (run()'s default) = past the node's edge.
      const st = () => state(model(), "a1", true, "A1");
      expect(run(st(), { key: "ArrowUp" }, {}, undefined, layout).dispatched).toEqual([
        { type: "moveUp" },
      ]);
      expect(run(st(), { key: "ArrowDown" }, {}, undefined, layout).dispatched).toEqual([
        { type: "moveDown" },
      ]);
    }
  });

  it("editing-mode ↑/↓ move the caret inside a multi-line node", () => {
    const vm: VerticalMove = (_text, pos, dir) => (dir === 1 ? pos + 3 : null);
    const st = state(model(), "a1", true, "ab\ncd");
    expect(run(st, { key: "ArrowDown" }, { pos: 1, selEnd: 1 }, undefined, "canvas", vm).dispatched).toEqual([
      { type: "setSelection", cursorPos: 4, selectionEnd: 4 },
    ]);
    expect(run(st, { key: "ArrowUp" }, { pos: 1, selEnd: 1 }, undefined, "canvas", vm).dispatched).toEqual([
      { type: "moveUp" },
    ]);
  });

  it("defaults to the canvas layout", () => {
    const r = run(state(model(), "a", false), { key: "ArrowUp" });
    expect(r.dispatched).toEqual([{ type: "moveUpSiblingFirst" }]);
  });
});

// Enter is a user preference like ←/→, so each behaviour is pinned to its own
// setting rather than riding on DEFAULT_PREFERENCES.
describe("preference: enterBehavior = insert-sibling (default)", () => {
  const prefs: EditorPreferences = {
    ...DEFAULT_PREFERENCES,
    enterBehavior: "insert-sibling",
  };

  it("plain Enter inserts a sibling", () => {
    const r = run(state(model(), "a", false), { key: "Enter" }, {}, prefs);
    expect(r.dispatched).toEqual([{ type: "insertSiblingAfter" }]);
  });

  it("Cmd+Enter starts editing", () => {
    const r = run(state(model(), "a", false), { key: "Enter", metaKey: true }, {}, prefs);
    expect(r.dispatched).toEqual([{ type: "startEditing" }]);
  });
});

describe("preference: enterBehavior = edit", () => {
  const prefs: EditorPreferences = {
    ...DEFAULT_PREFERENCES,
    enterBehavior: "edit",
  };

  it("plain Enter starts editing", () => {
    const r = run(state(model(), "a", false), { key: "Enter" }, {}, prefs);
    expect(r.dispatched).toEqual([{ type: "startEditing" }]);
  });

  it("Cmd+Enter inserts a sibling (the two are swapped)", () => {
    const r = run(state(model(), "a", false), { key: "Enter", metaKey: true }, {}, prefs);
    expect(r.dispatched).toEqual([{ type: "insertSiblingAfter" }]);
  });

  it("Space and F2 still start editing", () => {
    for (const key of [" ", "F2"]) {
      const r = run(state(model(), "a", false), { key }, {}, prefs);
      expect(r.dispatched).toEqual([{ type: "startEditing" }]);
    }
  });

  it("Enter while editing still splits the node", () => {
    const r = run(state(model(), "a", true, "hi"), { key: "Enter" }, { pos: 1 }, prefs);
    expect(r.dispatched).toEqual([{ type: "enter", pos: 1 }]);
  });

  it("the help overlay lists the keys that actually fire", () => {
    const byId = (id: string, p: EditorPreferences) =>
      buildKeymap(p).find((b) => b.id === id);
    expect(byId("sel-edit", prefs)?.keys).toContain("Enter / Space");
    expect(byId("sel-insert-sibling", prefs)?.keys).toBe("⌘/Ctrl + Enter");
    expect(byId("sel-insert-sibling", DEFAULT_PREFERENCES)?.keys).toBe("Enter");
  });
});

describe("preference: tabBehavior = insert-child", () => {
  const prefs: EditorPreferences = {
    ...DEFAULT_PREFERENCES,
    tabBehavior: "insert-child",
  };

  it("Tab inserts a child, saves, and starts editing it", () => {
    const r = run(state(model(), "a", false), { key: "Tab" }, {}, prefs);
    expect(r.dispatched).toEqual([
      { type: "addChild", nodeId: "a" },
      { type: "startEditing" },
    ]);
    expect(r.kinds).toEqual(["dispatch", "save", "dispatch"]);
  });

  it("Tab is swallowed on an empty node (no empty-under-empty)", () => {
    const m = model();
    m.children[0].text = ""; // "a" is now blank
    const r = run(state(m, "a", false), { key: "Tab" }, {}, prefs);
    expect(r.kinds).toEqual([]);
    expect(r.handled).toBe(true);
  });

  it("Shift+Tab still outdents", () => {
    const r = run(state(model(), "a1", false), { key: "Tab", shiftKey: true }, {}, prefs);
    expect(r.dispatched).toEqual([{ type: "tab", shift: true }]);
  });

  it("Tab in editing mode also inserts a child and starts editing it", () => {
    const r = run(state(model(), "a", true, "A"), { key: "Tab", shiftKey: false }, {}, prefs);
    expect(r.dispatched).toEqual([
      { type: "addChild", nodeId: "a" },
      { type: "startEditing" },
    ]);
    expect(r.kinds).toEqual(["dispatch", "save", "dispatch"]);
  });

  it("Tab in editing mode is swallowed when the live text is blank", () => {
    // editingText === "" → the node being edited is still empty.
    const r = run(state(model(), "a", true, ""), { key: "Tab" }, {}, prefs);
    expect(r.kinds).toEqual([]);
    expect(r.handled).toBe(true);
  });

  it("Shift+Tab in editing mode still outdents", () => {
    const r = run(state(model(), "a1", true, "A1"), { key: "Tab", shiftKey: true }, {}, prefs);
    expect(r.dispatched).toEqual([{ type: "tab", shift: true }]);
  });
});

describe("preference: arrowBehavior = navigate", () => {
  const prefs: EditorPreferences = {
    ...DEFAULT_PREFERENCES,
    arrowBehavior: "navigate",
  };

  it("Right descends to the last-visited child of an expanded parent", () => {
    const r = run(state(model(), "a", false), { key: "ArrowRight" }, {}, prefs);
    expect(r.dispatched).toEqual([{ type: "moveToChild" }]);
  });

  it("Right auto-expands (and saves) a collapsed parent before moving in", () => {
    const m = model();
    m.children[0].collapsed = true;
    const r = run(state(m, "a", false), { key: "ArrowRight" }, {}, prefs);
    expect(r.dispatched).toEqual([
      { type: "toggleCollapse", nodeId: "a" },
      { type: "moveToChild" },
    ]);
    expect(r.kinds).toEqual(["dispatch", "save", "dispatch"]);
  });

  it("Right on a leaf is swallowed", () => {
    const r = run(state(model(), "b", false), { key: "ArrowRight" }, {}, prefs);
    expect(r.kinds).toEqual([]);
    expect(r.handled).toBe(true);
  });

  it("Left always moves to the parent, never collapses", () => {
    const r = run(state(model(), "a", false), { key: "ArrowLeft" }, {}, prefs);
    expect(r.dispatched).toEqual([{ type: "moveToParent" }]);
  });
});

describe("preference: selectionMode = false (always edit)", () => {
  const prefs: EditorPreferences = {
    ...DEFAULT_PREFERENCES,
    selectionMode: false,
  };

  it("editing bindings fire even when view.editing is false (forced mode)", () => {
    // Enter with view.editing=false would insert a sibling in selection mode;
    // always-edit must route it to the editing split instead.
    const r = run(state(model(), "a", false, "A"), { key: "Enter" }, { pos: 1 }, prefs);
    expect(r.dispatched).toEqual([{ type: "enter", pos: 1 }]);
  });

  it("Escape does nothing (falls through to native)", () => {
    const r = run(state(model(), "a", true, "A"), { key: "Escape" }, {}, prefs);
    expect(r.kinds).toEqual([]);
    expect(r.handled).toBe(false);
  });

  it("Cmd+Shift+Backspace deletes the branch", () => {
    const r = run(
      state(model(), "a", true, "A"),
      { key: "Backspace", metaKey: true, shiftKey: true },
      {},
      prefs
    );
    expect(r.dispatched).toEqual([{ type: "deleteNode", nodeId: "a" }]);
  });

  it("plain Backspace at caret 0 still merges instead of deleting", () => {
    const r = run(state(model(), "a", true, "A"), { key: "Backspace" }, {}, prefs);
    expect(r.dispatched).toEqual([{ type: "backspaceAtStart" }]);
  });

  it("selection-only bindings are absent from the keymap (help stays truthful)", () => {
    const bindings = buildKeymap(prefs);
    expect(bindings.some((b) => b.when === "selection")).toBe(false);
    expect(bindings.some((b) => b.id === "edit-escape")).toBe(false);
  });
});

describe("help chord (Cmd/Ctrl + /)", () => {
  it("opens help while editing, with default preferences", () => {
    const r = run(state(model(), "a", true, "A"), { key: "/", metaKey: true });
    expect(r.kinds).toEqual(["openHelp"]);
  });

  it("opens help in always-edit mode", () => {
    const r = run(
      state(model(), "a", true, "A"),
      { key: "/", ctrlKey: true },
      {},
      { ...DEFAULT_PREFERENCES, selectionMode: false }
    );
    expect(r.kinds).toEqual(["openHelp"]);
  });
});
