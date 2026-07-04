/**
 * Application layer: the editor's central keymap.
 *
 * Every keyboard shortcut the Konva editor understands lives here as one
 * declarative binding — replacing the long imperative if-chain that used to
 * live inside MindmapEditor's onKeyDown. Keeping them in a single ordered table
 * makes the bindings easy to audit, prevents silent conflicts, and lets the
 * shortcut-help overlay be generated from the same source of truth.
 *
 * A binding is scoped by `when`:
 *   - "global"    : always active (undo/redo/palette), even with no active node.
 *   - "both"      : active whenever a node is active, in either mode.
 *   - "selection" : only when a node is selected (not editing its text).
 *   - "editing"   : only while editing a node's text (caret in the textarea).
 *
 * `run` returns "handled" (the runner calls preventDefault and stops) or "pass"
 * (the event is left to the browser's native textarea handling). Bindings are
 * matched in array order, so a more specific binding (e.g. Alt+Arrow reorder)
 * must precede the plainer one it would otherwise shadow.
 */

import type { KeyboardEvent } from "react";
import type { EditorAction, EditorState } from "./editorReducer";
import type { MindMapModel } from "../domain/model";
import { findNode } from "../domain/model";

export type KeyMode = "selection" | "editing";
export type KeyResult = "handled" | "pass";

export interface KeyContext {
  e: KeyboardEvent<HTMLTextAreaElement>;
  state: EditorState;
  /** The active node resolved from the current model (null if none). */
  node: MindMapModel | null;
  /** Caret start / end read from the live textarea. */
  pos: number;
  selEnd: number;
}

/** Component-provided callbacks the bindings dispatch into. */
export interface KeymapDeps {
  dispatch: (action: EditorAction, undoType?: string) => EditorState;
  /** Persist the model (no-op when the note is unsaved). */
  saveNote: (model: MindMapModel) => void;
  openPalette: () => void;
  openHelp: () => void;
  undo: () => void;
  redo: () => void;
  /** Line-wise caret move inside a multi-line node; null = past the edge. */
  verticalMove: (text: string, pos: number, dir: -1 | 1) => number | null;
}

export interface KeyBinding {
  id: string;
  /** Human description for the help overlay; "" hides the binding from help. */
  label: string;
  /** Key combo shown in the help overlay. */
  keys: string;
  when: "global" | "selection" | "editing" | "both";
  match: (e: KeyboardEvent) => boolean;
  run: (ctx: KeyContext) => KeyResult;
}

// Treat Cmd (mac) and Ctrl (win/linux) as the same "primary" modifier.
const mod = (e: KeyboardEvent) => e.metaKey || e.ctrlKey;

export function buildKeymap(deps: KeymapDeps): KeyBinding[] {
  return [
    // ---- Global (work regardless of mode / active node) ----
    {
      id: "palette",
      label: "コマンドパレット",
      keys: "⌘/Ctrl + K",
      when: "global",
      match: (e) => mod(e) && e.key.toLowerCase() === "k",
      run: () => {
        deps.openPalette();
        return "handled";
      },
    },
    {
      id: "undo",
      label: "元に戻す",
      keys: "⌘/Ctrl + Z",
      when: "global",
      match: (e) => mod(e) && !e.shiftKey && e.key.toLowerCase() === "z",
      run: () => {
        deps.undo();
        return "handled";
      },
    },
    {
      id: "redo",
      label: "やり直し",
      keys: "⌘/Ctrl + Shift + Z",
      when: "global",
      match: (e) => mod(e) && e.shiftKey && e.key.toLowerCase() === "z",
      run: () => {
        deps.redo();
        return "handled";
      },
    },
    {
      // Windows-style redo alias; hidden from help to avoid a duplicate row.
      id: "redo-y",
      label: "",
      keys: "⌘/Ctrl + Y",
      when: "global",
      match: (e) => mod(e) && e.key.toLowerCase() === "y",
      run: () => {
        deps.redo();
        return "handled";
      },
    },

    // ---- Cross-mode (need an active node; must precede plain-arrow bindings) ----
    {
      id: "reorder-up",
      label: "ノードを上へ移動",
      keys: "Alt + ↑",
      when: "both",
      match: (e) => e.altKey && e.key === "ArrowUp",
      run: (ctx) => {
        const next = deps.dispatch({ type: "moveNodeUp" }, "reorder");
        if (next !== ctx.state) deps.saveNote(next.document.model);
        return "handled";
      },
    },
    {
      id: "reorder-down",
      label: "ノードを下へ移動",
      keys: "Alt + ↓",
      when: "both",
      match: (e) => e.altKey && e.key === "ArrowDown",
      run: (ctx) => {
        const next = deps.dispatch({ type: "moveNodeDown" }, "reorder");
        if (next !== ctx.state) deps.saveNote(next.document.model);
        return "handled";
      },
    },
    {
      id: "bold",
      label: "太字",
      keys: "⌘/Ctrl + B",
      when: "both",
      match: (e) => mod(e) && e.key.toLowerCase() === "b",
      run: (ctx) => {
        const n = ctx.node;
        // Bold only applies to text nodes (matches the context menu).
        if (!n || (n.type ?? "text") !== "text") return "handled";
        const next = deps.dispatch(
          { type: "setNodeStyle", nodeId: n.id, bold: !n.bold },
          "style"
        );
        if (next !== ctx.state) deps.saveNote(next.document.model);
        return "handled";
      },
    },

    {
      id: "toggle-collapse",
      label: "折りたたみ / 展開",
      keys: "⌘/Ctrl + .",
      when: "both",
      // Selection mode already collapses with ←/→, but those are the caret keys
      // while editing. This chord toggles collapse in either mode so you never
      // have to leave edit mode to fold a subtree.
      match: (e) => mod(e) && e.key === ".",
      run: (ctx) => {
        const n = ctx.node;
        if (!n || n.children.length === 0) return "handled";
        const next = deps.dispatch(
          { type: "toggleCollapse", nodeId: n.id },
          "collapse"
        );
        if (next !== ctx.state) deps.saveNote(next.document.model);
        return "handled";
      },
    },

    // ---- Selection mode ----
    // No Escape binding here: the editor keeps exactly one node selected at all
    // times (see the empty-space click handler), so leaving selection mode would
    // strand the keyboard on an unfocused textarea. Escape only acts in editing
    // mode (edit-escape), returning to selection.
    {
      id: "sel-insert-sibling",
      label: "兄弟ノードを追加",
      keys: "Enter",
      when: "selection",
      match: (e) => e.key === "Enter",
      run: () => {
        deps.dispatch({ type: "insertSiblingAfter" }, "insert-sibling");
        return "handled";
      },
    },
    {
      id: "sel-edit",
      label: "編集を開始",
      keys: "Space",
      when: "selection",
      match: (e) => e.key === " ",
      run: () => {
        deps.dispatch({ type: "startEditing" });
        return "handled";
      },
    },
    {
      id: "sel-up",
      label: "上のノードへ",
      keys: "↑",
      when: "selection",
      match: (e) => e.key === "ArrowUp" && !e.altKey,
      run: () => {
        deps.dispatch({ type: "moveUp" });
        return "handled";
      },
    },
    {
      id: "sel-down",
      label: "下のノードへ",
      keys: "↓",
      when: "selection",
      match: (e) => e.key === "ArrowDown" && !e.altKey,
      run: () => {
        deps.dispatch({ type: "moveDown" });
        return "handled";
      },
    },
    {
      id: "sel-right",
      label: "展開 / 子ノードへ",
      keys: "→",
      when: "selection",
      match: (e) => e.key === "ArrowRight" && !e.altKey,
      run: (ctx) => {
        const n = ctx.node;
        if (n && n.children.length > 0) {
          if (n.collapsed) {
            const next = deps.dispatch(
              { type: "toggleCollapse", nodeId: n.id },
              "collapse"
            );
            if (next !== ctx.state) deps.saveNote(next.document.model);
          } else {
            // Expanded: the first child is the next node in flat order.
            deps.dispatch({ type: "moveDown" });
          }
        }
        return "handled";
      },
    },
    {
      id: "sel-left",
      label: "折りたたみ / 親ノードへ",
      keys: "←",
      when: "selection",
      match: (e) => e.key === "ArrowLeft" && !e.altKey,
      run: (ctx) => {
        const n = ctx.node;
        if (n && n.children.length > 0 && !n.collapsed) {
          const next = deps.dispatch(
            { type: "toggleCollapse", nodeId: n.id },
            "collapse"
          );
          if (next !== ctx.state) deps.saveNote(next.document.model);
        } else {
          deps.dispatch({ type: "moveToParent" });
        }
        return "handled";
      },
    },
    {
      id: "sel-indent",
      label: "インデント / アウトデント",
      keys: "Tab / Shift + Tab",
      when: "selection",
      match: (e) => e.key === "Tab",
      run: (ctx) => {
        deps.dispatch({ type: "tab", shift: ctx.e.shiftKey }, "indent");
        return "handled";
      },
    },
    {
      id: "sel-delete",
      label: "ノードを削除",
      keys: "Backspace / Delete",
      when: "selection",
      match: (e) => e.key === "Backspace" || e.key === "Delete",
      run: (ctx) => {
        if (!ctx.node) return "handled";
        deps.dispatch({ type: "deleteNode", nodeId: ctx.node.id }, "delete");
        return "handled";
      },
    },
    {
      id: "sel-help",
      label: "ショートカット一覧",
      keys: "?",
      when: "selection",
      match: (e) => e.key === "?",
      run: () => {
        deps.openHelp();
        return "handled";
      },
    },

    // ---- Editing mode ----
    {
      id: "edit-newline",
      label: "改行",
      keys: "Shift + Enter",
      when: "editing",
      match: (e) => e.key === "Enter" && e.shiftKey,
      run: () => "pass", // native textarea inserts the "\n"
    },
    {
      id: "edit-enter",
      label: "ノードを分割 / 追加",
      keys: "Enter",
      when: "editing",
      match: (e) => e.key === "Enter",
      run: (ctx) => {
        deps.dispatch({ type: "enter", pos: ctx.pos }, "enter");
        return "handled";
      },
    },
    {
      id: "edit-indent",
      label: "インデント / アウトデント",
      keys: "Tab / Shift + Tab",
      when: "editing",
      match: (e) => e.key === "Tab",
      run: (ctx) => {
        deps.dispatch({ type: "tab", shift: ctx.e.shiftKey }, "indent");
        return "handled";
      },
    },
    {
      id: "edit-backspace",
      label: "",
      keys: "Backspace",
      when: "editing",
      match: (e) => e.key === "Backspace",
      run: (ctx) => {
        // Only the caret-at-very-start case merges with the previous node;
        // otherwise let the textarea delete a character.
        if (ctx.pos === 0 && ctx.pos === ctx.selEnd) {
          deps.dispatch({ type: "backspaceAtStart" }, "backspace");
          return "handled";
        }
        return "pass";
      },
    },
    {
      id: "edit-delete",
      label: "",
      keys: "Delete",
      when: "editing",
      match: (e) => e.key === "Delete",
      run: (ctx) => {
        // With a text range selected, defer to native delete.
        if (ctx.pos !== ctx.selEnd) return "pass";
        const next = deps.dispatch({ type: "deleteAtEnd", pos: ctx.pos }, "delete");
        // No model change (not at end) → let the textarea delete forward.
        return next !== ctx.state ? "handled" : "pass";
      },
    },
    {
      id: "edit-up",
      label: "",
      keys: "↑",
      when: "editing",
      match: (e) => e.key === "ArrowUp" && !e.altKey,
      run: (ctx) => {
        // Move between lines inside a multi-line node; cross to the previous
        // node only from the first line.
        const newPos = deps.verticalMove(ctx.state.view.editingText, ctx.pos, -1);
        if (newPos !== null) {
          deps.dispatch({
            type: "setSelection",
            cursorPos: newPos,
            selectionEnd: newPos,
          });
        } else {
          deps.dispatch({ type: "moveUp" });
        }
        return "handled";
      },
    },
    {
      id: "edit-down",
      label: "",
      keys: "↓",
      when: "editing",
      match: (e) => e.key === "ArrowDown" && !e.altKey,
      run: (ctx) => {
        const newPos = deps.verticalMove(ctx.state.view.editingText, ctx.pos, 1);
        if (newPos !== null) {
          deps.dispatch({
            type: "setSelection",
            cursorPos: newPos,
            selectionEnd: newPos,
          });
        } else {
          deps.dispatch({ type: "moveDown" });
        }
        return "handled";
      },
    },
    {
      id: "edit-cmd-shift-left",
      label: "",
      keys: "⌘/Ctrl + Shift + ←",
      when: "editing",
      match: (e) => e.key === "ArrowLeft" && mod(e) && e.shiftKey,
      run: (ctx) => {
        deps.dispatch({ type: "cmdShiftLeft", pos: ctx.pos, selEnd: ctx.selEnd });
        return "handled";
      },
    },
    {
      id: "edit-cmd-left",
      label: "",
      keys: "⌘/Ctrl + ←",
      when: "editing",
      match: (e) => e.key === "ArrowLeft" && mod(e),
      run: (ctx) => {
        deps.dispatch({ type: "cmdLeft", pos: ctx.pos });
        return "handled";
      },
    },
    {
      id: "edit-shift-left",
      label: "",
      keys: "Shift + ←",
      when: "editing",
      match: (e) => e.key === "ArrowLeft" && e.shiftKey,
      run: () => "pass", // native selection extension
    },
    {
      id: "edit-left",
      label: "",
      keys: "←",
      when: "editing",
      match: (e) => e.key === "ArrowLeft" && !e.altKey,
      run: (ctx) => {
        if (ctx.pos === 0 && ctx.pos === ctx.selEnd) {
          deps.dispatch({ type: "arrowLeftEdge" });
          return "handled";
        }
        return "pass";
      },
    },
    {
      id: "edit-cmd-shift-right",
      label: "",
      keys: "⌘/Ctrl + Shift + →",
      when: "editing",
      match: (e) => e.key === "ArrowRight" && mod(e) && e.shiftKey,
      run: (ctx) => {
        deps.dispatch({ type: "cmdShiftRight", pos: ctx.pos, selEnd: ctx.selEnd });
        return "handled";
      },
    },
    {
      id: "edit-cmd-right",
      label: "",
      keys: "⌘/Ctrl + →",
      when: "editing",
      match: (e) => e.key === "ArrowRight" && mod(e),
      run: (ctx) => {
        deps.dispatch({ type: "cmdRight", pos: ctx.pos });
        return "handled";
      },
    },
    {
      id: "edit-shift-right",
      label: "",
      keys: "Shift + →",
      when: "editing",
      match: (e) => e.key === "ArrowRight" && e.shiftKey,
      run: () => "pass", // native selection extension
    },
    {
      id: "edit-right",
      label: "",
      keys: "→",
      when: "editing",
      match: (e) => e.key === "ArrowRight" && !e.altKey,
      run: (ctx) => {
        const n = ctx.node;
        if (n && ctx.pos >= n.text.length && ctx.pos === ctx.selEnd) {
          deps.dispatch({ type: "arrowRightEdge" });
          return "handled";
        }
        return "pass";
      },
    },
    {
      id: "edit-escape",
      label: "編集を終了",
      keys: "Esc",
      when: "editing",
      match: (e) => e.key === "Escape",
      run: () => {
        deps.dispatch({ type: "exitEditing" });
        return "handled";
      },
    },
  ];
}

/**
 * Dispatch a key event against the keymap. Finds the first binding whose scope
 * matches the current mode and whose `match` accepts the event, runs it, and
 * calls preventDefault for "handled" results. No match → the event is left to
 * native handling.
 */
export function runKeymap(bindings: KeyBinding[], ctx: KeyContext): void {
  const mode: KeyMode = ctx.state.view.editing ? "editing" : "selection";
  const hasActive = ctx.state.view.activeNodeId !== null;
  for (const b of bindings) {
    if (b.when === "global") {
      if (!b.match(ctx.e)) continue;
    } else {
      if (!hasActive) continue;
      if (b.when !== "both" && b.when !== mode) continue;
      if (!b.match(ctx.e)) continue;
    }
    const result = b.run(ctx);
    if (result === "handled") ctx.e.preventDefault();
    return;
  }
}

// Resolve the active node without re-reading refs in the component.
export function activeNode(state: EditorState): MindMapModel | null {
  return state.view.activeNodeId
    ? findNode(state.document.model, state.view.activeNodeId)
    : null;
}
