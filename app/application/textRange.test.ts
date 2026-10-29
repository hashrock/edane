import { describe, it, expect } from "vitest";
import type { MindMapDocument } from "../domain/model";
import { verticalMove as lines } from "../lib/textGeometry";
import { editorReducer, type EditorState } from "./editorReducer";
import { buildKeymap, type KeymapKeyEvent } from "./editorKeymap";
import { editorStateAt, pressKey } from "./editorState.arb";
import { rangeClipboardCommand, type RangeClipboardOp } from "./editorCommands";
import { sequentialIds } from "../domain/model.arb";
import {
  beginRange,
  rangeSegments,
  rangeTextOf,
  rangeToPlainText,
  stepPoint,
  type TextRange,
} from "./textRange";

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

describe("a node not drawn as its own text is taken whole", () => {
  const d: MindMapDocument = {
    title: "",
    roots: [
      { id: "a", text: "ab", children: [] },
      { id: "img", text: "https://example.com/a.png", type: "image", children: [] },
      { id: "b", text: "cd", children: [] },
    ],
  };
  it("one Shift+arrow crosses it, never stepping through its URL", () => {
    const t = textOf(d);
    const len = t.text("img").length;
    expect(stepPoint(d, { id: "img", offset: 0 }, "right", t, lines)).toEqual({ id: "img", offset: len });
    expect(stepPoint(d, { id: "img", offset: len }, "left", t, lines)).toEqual({ id: "img", offset: 0 });
    // Vertically into it, the range covers it whole.
    expect(stepPoint(d, { id: "a", offset: 1 }, "down", t, lines)).toEqual({ id: "img", offset: len });
    expect(stepPoint(d, { id: "b", offset: 1 }, "up", t, lines)).toEqual({ id: "img", offset: 0 });
  });
  it("except while it is the node being edited: its textarea shows that text", () => {
    const t = rangeTextOf(d, "img", "https://example.com/a.png");
    expect(stepPoint(d, { id: "img", offset: 3 }, "right", t, lines)).toEqual({ id: "img", offset: 4 });
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
      ["r", { from: 6, to: 11, breaks: true }],
      ["c1", { from: 0, to: 9, breaks: true }],
      ["g", { from: 0, to: 5, breaks: true }],
      ["c2", { from: 0, to: 2, breaks: false }],
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

function press(st: EditorState, e: KeymapKeyEvent): { state: EditorState; handled: boolean } {
  const { state, outcome } = pressKey(keymap, st, e);
  return { state, handled: outcome.result === "handled" };
}

const editing = (nodeId: string, pos: number) => editorStateAt(doc(), nodeId, { editing: true, pos });

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

  it("a character goes to the textarea, and its edit replaces the whole range", () => {
    // Range: "hello |world" … "child |one". The key passes; the textarea swaps
    // its selection (the anchor's part, "world") for the character — typed,
    // dictated or autocorrected alike. c1 goes; its child g now hangs under
    // the joined line, like the text "hello aone\n    grand" reads.
    const st = press(editing("r", 6), key("ArrowDown", { shiftKey: true })).state;
    for (const ch of ["a", "と"]) {
      expect(press(st, key(ch)).handled, ch).toBe(false);
      const next = editorReducer(st, {
        type: "typeText",
        text: `hello ${ch}`,
        cursorPos: 7,
        selectionEnd: 7,
        commitModel: true,
      });
      expect([next.view.activeNodeId, next.view.editingText, next.view.cursorPos, next.view.textRange], ch).toEqual([
        "r",
        `hello ${ch}one`,
        7,
        undefined,
      ]);
      expect(next.document.model.roots[0].children.map((c) => c.id), ch).toEqual(["g", "c2"]);
    }
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

  it("an IME's first key empties the range for the composition", () => {
    const st = press(editing("r", 6), key("ArrowDown", { shiftKey: true })).state;
    // Not cancelled (that would lose the composition): the textarea is
    // synced right away instead, so the composition lands at the caret.
    const { state, outcome } = pressKey(keymap, st, { ...key("Process"), keyCode: 229 });
    expect(outcome.result).toBe("native");
    expect(outcome.effects.at(-1)).toEqual({ kind: "syncInput" });
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

describe("rangeClipboardCommand", () => {
  const run = (st: EditorState, op: RangeClipboardOp) => {
    const cmd = rangeClipboardCommand(st, op, { nextId: sequentialIds() });
    let next = st;
    for (const f of cmd?.effects ?? []) if (f.kind === "dispatch") next = editorReducer(next, f.action);
    return { cmd, next };
  };
  const ranged = () => press(editing("r", 6), key("ArrowDown", { shiftKey: true })).state;

  it("is null without a range: the event is the textarea's own", () => {
    expect(rangeClipboardCommand(editing("r", 6), { kind: "copy" })).toBeNull();
  });
  it("copy gives the text only; cut also deletes the range", () => {
    expect(run(ranged(), { kind: "copy" }).cmd).toEqual({ text: "world\n  child ", effects: [] });
    const { cmd, next } = run(ranged(), { kind: "cut" });
    expect(cmd?.text).toBe("world\n  child ");
    expect(next.view.editingText).toBe("hello one");
  });
  it("paste replaces the range in one step, or pastes nodes after the joined line", () => {
    expect(run(ranged(), { kind: "paste", text: "X", asNodes: false }).next.view.editingText).toBe("hello Xone");
    const { next } = run(ranged(), { kind: "paste", text: "p\n  q", asNodes: true });
    const r = next.document.model.roots[0];
    expect(r.text).toBe("hello one");
    // The joined line is a root, which takes pasted nodes as its last children.
    expect(r.children.map((c) => c.text)).toEqual(["grand", "two\nlines", "p"]);
    // Nothing to paste: the range stays.
    expect(run(ranged(), { kind: "paste", text: "", asNodes: false }).cmd?.effects).toEqual([]);
  });
});
