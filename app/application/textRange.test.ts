import { describe, it, expect } from "vitest";
import type { MindMapDocument } from "../domain/model";
import { editorReducer, freshEditorState, type EditorState } from "./editorReducer";
import { activeNode, buildKeymap, runKeymap, type KeymapKeyEvent } from "./editorKeymap";
import {
  beginRange,
  rangeSegments,
  rangeTextOf,
  rangeToPlainText,
  stepPoint,
  type TextRange,
  type VerticalMove,
} from "./textRange";

/** Hard-newline line moves (what both layouts' verticalMove do). */
const lines: VerticalMove = (text, pos, dir) => {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === "\n") starts.push(i + 1);
  let line = 0;
  while (line + 1 < starts.length && starts[line + 1] <= pos) line++;
  const target = line + dir;
  if (target < 0 || target >= starts.length) return null;
  const col = pos - starts[line];
  const end = target + 1 < starts.length ? starts[target + 1] - 1 : text.length;
  return Math.min(starts[target] + col, end);
};

/**
 *   hello world
 *     child one
 *       grand
 *     two\nlines
 *   last
 */
function doc(): MindMapDocument {
  return {
    title: "T",
    roots: [
      {
        id: "r",
        text: "hello world",
        children: [
          { id: "c1", text: "child one", children: [{ id: "g", text: "grand", children: [] }] },
          { id: "c2", text: "two\nlines", children: [] },
        ],
      },
      { id: "last", text: "last", children: [] },
    ],
  };
}

const textOf = (d: MindMapDocument) => rangeTextOf(d, null, "");
const range = (a: [string, number], f: [string, number]): TextRange => ({
  anchor: { id: a[0], offset: a[1] },
  focus: { id: f[0], offset: f[1] },
});

describe("stepPoint", () => {
  const d = doc();
  it("moves inside a node like a caret", () => {
    expect(stepPoint(d, { id: "r", offset: 3 }, "left", textOf(d), lines)).toEqual({ id: "r", offset: 2 });
    expect(stepPoint(d, { id: "c2", offset: 1 }, "down", textOf(d), lines)).toEqual({ id: "c2", offset: 5 });
  });
  it("crosses a node edge like a line break", () => {
    expect(stepPoint(d, { id: "r", offset: 11 }, "right", textOf(d), lines)).toEqual({ id: "c1", offset: 0 });
    expect(stepPoint(d, { id: "c1", offset: 0 }, "left", textOf(d), lines)).toEqual({ id: "r", offset: 11 });
  });
  it("keeps the column across nodes, landing on the neighbour's adjacent line", () => {
    // c1 col 7 → g's only line, clamped to its length (5).
    expect(stepPoint(d, { id: "c1", offset: 7 }, "down", textOf(d), lines)).toEqual({ id: "g", offset: 5 });
    // last col 2 → the LAST line of c2 ("lines" starts at 4).
    expect(stepPoint(d, { id: "last", offset: 2 }, "up", textOf(d), lines)).toEqual({ id: "c2", offset: 6 });
  });
  it("stops at the document's ends at the first / last offset", () => {
    expect(stepPoint(d, { id: "r", offset: 4 }, "up", textOf(d), lines)).toEqual({ id: "r", offset: 0 });
    expect(stepPoint(d, { id: "last", offset: 1 }, "down", textOf(d), lines)).toEqual({ id: "last", offset: 4 });
  });
  it("never splits a surrogate pair", () => {
    const e: MindMapDocument = { title: "", roots: [{ id: "x", text: "a😀b", children: [] }] };
    expect(stepPoint(e, { id: "x", offset: 3 }, "left", textOf(e), lines)).toEqual({ id: "x", offset: 1 });
    expect(stepPoint(e, { id: "x", offset: 1 }, "right", textOf(e), lines)).toEqual({ id: "x", offset: 3 });
  });
});

describe("beginRange", () => {
  const d = doc();
  it("is null while the moving end stays inside the node", () => {
    expect(beginRange(d, "r", textOf(d), { pos: 3, selEnd: 3, backward: false }, "right", lines)).toBeNull();
  });
  it("keeps the textarea selection's fixed end as the anchor", () => {
    // Forward selection 2..11 (focus at the end) → Shift+→ crosses.
    expect(beginRange(d, "r", textOf(d), { pos: 2, selEnd: 11, backward: false }, "right", lines)).toEqual(
      range(["r", 2], ["c1", 0])
    );
    // Backward selection 0..5 (focus at the start) → Shift+↑ crosses up.
    expect(beginRange(d, "c1", textOf(d), { pos: 0, selEnd: 5, backward: true }, "up", lines)).toEqual(
      range(["c1", 5], ["r", 0])
    );
  });
});

describe("rangeSegments", () => {
  it("covers the start node's tail, the middle whole, the end node's head", () => {
    const d = doc();
    expect([...rangeSegments(d, range(["c2", 2], ["r", 6]), textOf(d))]).toEqual([
      ["r", [6, 11]],
      ["c1", [0, 9]],
      ["g", [0, 5]],
      ["c2", [0, 2]],
    ]);
  });
});

describe("rangeToPlainText", () => {
  it("is the substring within one node", () => {
    const d = doc();
    expect(rangeToPlainText(d, range(["r", 8], ["r", 2]), textOf(d))).toBe("llo wo");
  });
  it("is one line per node, indented by depth below the shallowest", () => {
    const d = doc();
    expect(rangeToPlainText(d, range(["c1", 6], ["last", 2]), textOf(d))).toBe(
      ["  one", "    grand", "  two", "  lines", "la"].join("\n")
    );
  });
  it("an empty end part does not set the indentation", () => {
    // Ending at the start of the (shallower) root "last" adds a bare line
    // break, not a level the copied lines are indented against.
    const d = doc();
    expect(rangeToPlainText(d, range(["g", 0], ["last", 0]), textOf(d))).toBe(
      ["  grand", "two", "lines", ""].join("\n")
    );
  });
  it("leaves an empty covered part as a bare line break", () => {
    const d = doc();
    expect(rangeToPlainText(d, range(["r", 11], ["c1", 0]), textOf(d))).toBe("\n");
  });
  it("copies a collapsed node's hidden subtree when the range runs past it", () => {
    const d = doc();
    d.roots[0].children[0].collapsed = true;
    expect(rangeToPlainText(d, range(["c1", 0], ["c2", 3]), textOf(d))).toBe(
      ["child one", "  grand", "two"].join("\n")
    );
    // …but not when the collapsed node is where the range ends.
    expect(rangeToPlainText(d, range(["r", 6], ["c1", 5]), textOf(d))).toBe(
      ["world", "  child"].join("\n")
    );
  });
});

// --- Through the keymap and the reducer ---

const keymap = buildKeymap(undefined, "canvas", lines);
const key = (k: string, mods: Partial<KeymapKeyEvent> = {}): KeymapKeyEvent => ({
  key: k,
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  ...mods,
});

/** Press a key with the textarea's selection mirroring the view (forward). */
function press(st: EditorState, e: KeymapKeyEvent): { state: EditorState; handled: boolean } {
  const outcome = runKeymap(keymap, {
    e,
    state: st,
    node: activeNode(st),
    pos: st.view.cursorPos,
    selEnd: st.view.selectionEnd,
  });
  let next = st;
  for (const f of outcome.effects) {
    if (f.kind === "dispatch") next = editorReducer(next, f.action);
  }
  return { state: next, handled: outcome.result === "handled" };
}

function editing(nodeId: string, pos: number): EditorState {
  const s = freshEditorState(doc(), nodeId);
  return editorReducer(s, { type: "activateNode", nodeId, cursorPos: pos, selectionEnd: pos, editing: true });
}

describe("Shift+arrows across nodes (keymap → reducer)", () => {
  it("Shift+↓ on the last line starts a range; the textarea selects the anchor's part", () => {
    const { state, handled } = press(editing("r", 6), key("ArrowDown", { shiftKey: true }));
    expect(handled).toBe(true);
    expect(state.view.textRange).toEqual(range(["r", 6], ["c1", 6]));
    expect(state.view.activeNodeId).toBe("r");
    expect([state.view.cursorPos, state.view.selectionEnd]).toEqual([6, 11]);
  });

  it("Shift+← inside the node is left to the textarea", () => {
    const { state, handled } = press(editing("r", 6), key("ArrowLeft", { shiftKey: true }));
    expect(handled).toBe(false);
    expect(state.view.textRange).toBeUndefined();
  });

  it("the range keeps growing and can shrink back into the anchor", () => {
    let st = editing("c1", 3);
    st = press(st, key("ArrowDown", { shiftKey: true })).state;
    st = press(st, key("ArrowDown", { shiftKey: true })).state;
    expect(st.view.textRange?.focus).toEqual({ id: "c2", offset: 3 });
    st = press(st, key("ArrowUp", { shiftKey: true })).state;
    st = press(st, key("ArrowUp", { shiftKey: true })).state;
    expect(st.view.textRange?.focus).toEqual({ id: "c1", offset: 3 });
    // Upward past the anchor: the textarea's part flips to the head.
    st = press(st, key("ArrowUp", { shiftKey: true })).state;
    expect(st.view.textRange?.focus).toEqual({ id: "r", offset: 3 });
    expect([st.view.cursorPos, st.view.selectionEnd]).toEqual([0, 3]);
  });

  it("an echo of the segment from the textarea keeps the range; a real caret change ends it", () => {
    const st = press(editing("r", 6), key("ArrowDown", { shiftKey: true })).state;
    const echoed = editorReducer(st, { type: "setSelection", cursorPos: 6, selectionEnd: 11 });
    expect(echoed.view.textRange).toBeDefined();
    const moved = editorReducer(st, { type: "setSelection", cursorPos: 2, selectionEnd: 2 });
    expect(moved.view.textRange).toBeUndefined();
  });

  it("← / → collapse to the range's start / end, ↓ moves on from the moving end", () => {
    const st = press(editing("r", 6), key("ArrowDown", { shiftKey: true })).state;
    const left = press(st, key("ArrowLeft")).state;
    expect([left.view.activeNodeId, left.view.cursorPos, left.view.textRange]).toEqual(["r", 6, undefined]);
    const right = press(st, key("ArrowRight")).state;
    expect([right.view.activeNodeId, right.view.cursorPos, right.view.selectionEnd]).toEqual(["c1", 6, 6]);
    const down = press(st, key("ArrowDown")).state;
    expect([down.view.activeNodeId, down.view.editing, down.view.textRange]).toEqual(["g", true, undefined]);
  });

  it("typing replaces the whole range; the joined line keeps the start node", () => {
    // Range: "hello |world" … "child |one". c1 goes; its child g now hangs
    // under the joined line, like the text "hello aone\n    grand" reads.
    const st = press(editing("r", 6), key("ArrowDown", { shiftKey: true })).state;
    const { state, handled } = press(st, key("a"));
    expect(handled).toBe(true);
    expect(state.view.textRange).toBeUndefined();
    expect([state.view.activeNodeId, state.view.editingText, state.view.cursorPos]).toEqual(["r", "hello aone", 7]);
    const r = state.document.model.roots[0];
    expect(r.children.map((c) => c.id)).toEqual(["g", "c2"]);
  });

  it("Backspace / Delete delete the range, Enter deletes it and splits there", () => {
    const st = press(editing("r", 6), key("ArrowDown", { shiftKey: true })).state;
    for (const k of ["Backspace", "Delete"]) {
      const { state } = press(st, key(k));
      expect(state.view.editingText, k).toBe("hello one");
      expect(state.view.cursorPos, k).toBe(6);
    }
    const { state } = press(st, key("Enter"));
    const r = state.document.model.roots[0];
    expect(r.text).toBe("hello ");
    expect(r.children[0]).toMatchObject({ text: "one" });
    expect(state.view.activeNodeId).toBe(r.children[0].id);
  });

  it("text that reaches the textarea without a key replaces the whole range too", () => {
    // Dictation / autocorrect: the textarea swaps its selection (the anchor's
    // part, "world") for the new text with no keydown the keymap could see.
    const st = press(editing("r", 6), key("ArrowDown", { shiftKey: true })).state;
    const next = editorReducer(st, {
      type: "typeText",
      text: "hello と",
      cursorPos: 7,
      selectionEnd: 7,
      commitModel: true,
    });
    expect([next.view.editingText, next.view.cursorPos, next.view.textRange]).toEqual(["hello とone", 7, undefined]);
    expect(next.document.model.roots[0].children.map((c) => c.id)).toEqual(["g", "c2"]);
  });

  it("an IME's first key empties the range for the composition", () => {
    const st = press(editing("r", 6), key("ArrowDown", { shiftKey: true })).state;
    const { state, handled } = press(st, { ...key("Process"), keyCode: 229 });
    expect(handled).toBe(true);
    expect([state.view.editingText, state.view.cursorPos]).toEqual(["hello one", 6]);
  });

  it("Tab / Escape end the range without editing; clipboard chords and modifiers pass", () => {
    const st = press(editing("r", 6), key("ArrowDown", { shiftKey: true })).state;
    for (const k of ["Tab", "Escape", "F2"]) {
      const { state, handled } = press(st, key(k));
      expect(handled, k).toBe(true);
      expect(state.document, k).toBe(st.document);
      expect(state.view.textRange, k).toBeUndefined();
      expect([state.view.activeNodeId, state.view.cursorPos, state.view.editing], k).toEqual(["c1", 6, true]);
    }
    for (const e of [key("c", { metaKey: true }), key("x", { ctrlKey: true }), key("Shift", { shiftKey: true })]) {
      const { state, handled } = press(st, e);
      expect(handled, e.key).toBe(false);
      expect(state.view.textRange, e.key).toBeDefined();
    }
  });

  it("Shift+Home / End and ⌘/Ctrl+Shift+arrows extend the range like a textarea", () => {
    const st = press(editing("c1", 3), key("ArrowDown", { shiftKey: true })).state; // focus g:3
    expect(press(st, key("End", { shiftKey: true })).state.view.textRange?.focus).toEqual({ id: "g", offset: 5 });
    expect(press(st, key("Home", { shiftKey: true })).state.view.textRange?.focus).toEqual({ id: "g", offset: 0 });
    expect(press(st, key("ArrowDown", { shiftKey: true, ctrlKey: true })).state.view.textRange?.focus).toEqual({
      id: "last",
      offset: 4,
    });
    // Outside a range ⌘/Ctrl+Shift+↑ starts one at the document's start.
    expect(press(editing("c2", 2), key("ArrowUp", { shiftKey: true, metaKey: true })).state.view.textRange).toEqual(
      range(["c2", 2], ["r", 0])
    );
  });
});
