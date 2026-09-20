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
 * `run` is a PURE function of the key context: it returns a {@link KeyOutcome}
 * — "handled" (the caller prevents the default and stops) or "pass" (the
 * event is left to the browser's native textarea handling) plus the list of
 * {@link KeyEffect}s the key asks for. Nothing in this module dispatches,
 * saves or opens anything; the component's interpreter
 * (`applyKeyEffects` in components/) carries the effects out in order. That
 * split is what lets the keyboard invariants be checked headlessly:
 * editorKeymap.property.test.ts feeds the dispatch effects straight into
 * editorReducer. Bindings are matched in array order, so a more specific
 * binding (e.g. Alt+Arrow reorder) must precede the plainer one it would
 * otherwise shadow.
 *
 * The table is parameterized by EditorPreferences: Tab and ←/→ in selection
 * mode have two user-selectable behaviours, and turning selection mode off
 * swaps the selection-only bindings for always-edit alternatives. Building the
 * keymap per preference set (instead of branching inside `run`) keeps the
 * shortcut-help overlay truthful — it only ever lists bindings that can fire.
 */

import type {
  EditorAction,
  EditorState,
  UndoType,
} from "./editorReducer";
import type { MessageKey } from "./messages";
import type { MindMapModel } from "../domain/model";
import { findNode, hasStructuralSuccessor, nextCheckedState } from "../domain/model";
import { supportsCheckbox } from "./nodeUtils";
import {
  DEFAULT_PREFERENCES,
  type EditorPreferences,
} from "./editorPreferences";
import type { EditorLayout } from "./editSurface";
import { verticalMove as measuredVerticalMove } from "../lib/textGeometry";

export type KeyMode = "selection" | "editing";
export type KeyResult = "handled" | "pass";

/**
 * What a key asks the editor to do. A binding returns a list of these instead
 * of calling anything, so the keymap stays pure; the component interprets
 * them in order (see `applyKeyEffects`).
 *
 * `save` persists the model as it stands after the preceding dispatches —
 * but only if one of them actually changed the state (a no-op reorder or a
 * read-only view must not trigger a write). That rule lives in the
 * interpreter, so bindings never need to look at a dispatch's result.
 */
export type KeyEffect =
  | { kind: "dispatch"; action: EditorAction; undoType?: UndoType }
  | { kind: "save" }
  /** Highlight nodes: the given ids, or whichever node is active afterwards. */
  | { kind: "flash"; ids: string[] | "active" }
  | { kind: "openPalette" }
  | { kind: "openHelp" }
  | { kind: "undo" }
  | { kind: "redo" };

export interface KeyOutcome {
  result: KeyResult;
  effects: KeyEffect[];
}

/** No binding wants the key: leave it to the browser. */
export const PASS: KeyOutcome = { result: "pass", effects: [] };

/** The key facts the keymap needs; React's synthetic KeyboardEvent and a
 *  native KeyboardEvent both satisfy it (mirrors AuxKeyEvent in editSurface.ts).
 *  Deliberately no `preventDefault`: the keymap decides, the caller acts. */
export interface KeymapKeyEvent {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

/**
 * Line-wise caret move inside a multi-line node; null = past the edge. A
 * pure function of the text, but the production one measures glyphs (see
 * lib/textGeometry), so tests inject a plain line-splitting stand-in.
 */
export type VerticalMove = (text: string, pos: number, dir: -1 | 1) => number | null;

export interface KeyContext {
  e: KeymapKeyEvent;
  state: EditorState;
  /** The active node resolved from the current model (null if none). */
  node: MindMapModel | null;
  /** Caret start / end read from the live textarea. */
  pos: number;
  selEnd: number;
}

export interface KeyBinding {
  id: string;
  /**
   * Message key of the human description for the help overlay ("" hides the
   * binding from help). A key, not display text: ShortcutHelp resolves it with
   * `t()` at render time so the overlay follows the current UI language.
   */
  label: MessageKey | "";
  /** Key combo shown in the help overlay. */
  keys: string;
  when: "global" | "selection" | "editing" | "both";
  match: (e: KeymapKeyEvent) => boolean;
  run: (ctx: KeyContext) => KeyOutcome;
}

// --- Effect constructors (keep the bindings below readable) ---
const handled = (...effects: KeyEffect[]): KeyOutcome => ({
  result: "handled",
  effects,
});
const dispatch = (action: EditorAction, undoType?: UndoType): KeyEffect => ({
  kind: "dispatch",
  action,
  undoType,
});
const SAVE: KeyEffect = { kind: "save" };
/** Fold / unfold a node and persist the fold state. */
const fold = (nodeId: string): KeyEffect[] => [
  dispatch({ type: "toggleCollapse", nodeId }, "collapse"),
  SAVE,
];
const deleteBranch = (nodeId: string): KeyEffect =>
  dispatch({ type: "deleteNode", nodeId }, "delete");
/**
 * Insert an empty child and hand it straight into edit mode (Tab under
 * "insert-child"). addChild always changes the state for an existing node
 * (the active node is one), so the follow-ups are unconditional: save, then
 * edit the child, matching Enter's insert-sibling behaviour.
 */
const insertChild = (nodeId: string): KeyEffect[] => [
  dispatch({ type: "addChild", nodeId }, "add-child"),
  SAVE,
  dispatch({ type: "startEditing" }),
];

// Treat Cmd (mac) and Ctrl (win/linux) as the same "primary" modifier.
const mod = (e: KeymapKeyEvent) => e.metaKey || e.ctrlKey;

export function buildKeymap(
  prefs: EditorPreferences = DEFAULT_PREFERENCES,
  layout: EditorLayout = "canvas",
  verticalMove: VerticalMove = measuredVerticalMove
): KeyBinding[] {
  // An empty node must not spawn another empty child — otherwise Tab-spam on a
  // fresh (blank) node stacks up empties. The live text is editingText while
  // editing (the node's stored text lags a keystroke), the stored text
  // otherwise. Mirrors the blank-leaf test the reducer uses in exitEditing.
  const activeIsBlank = (ctx: KeyContext): boolean => {
    const text = ctx.state.view.editing
      ? ctx.state.view.editingText
      : ctx.node?.text ?? "";
    return text.trim() === "";
  };

  // Tab is the same in both modes, driven by the one `tabBehavior` preference:
  // "indent" makes Tab/Shift+Tab indent/outdent, "insert-child" makes Tab
  // insert a child (handed straight into edit mode, pairing with Enter's
  // split) while Shift+Tab still outdents. One factory, two scopes, so Tab
  // does the same thing whether or not the caret is in the textarea.
  const tabBindings = (when: "selection" | "editing", prefix: string): KeyBinding[] =>
    prefs.tabBehavior === "insert-child"
      ? [
          {
            id: `${prefix}-insert-child`,
            label: "kmInsertChild",
            keys: "Tab",
            when,
            match: (e) => e.key === "Tab" && !e.shiftKey,
            run: (ctx) => {
              const n = ctx.node;
              if (!n) return handled();
              // Don't stack an empty child under an already-empty node.
              if (activeIsBlank(ctx)) return handled();
              return handled(...insertChild(n.id));
            },
          },
          {
            id: `${prefix}-outdent`,
            label: "kmOutdent",
            keys: "Shift + Tab",
            when,
            match: (e) => e.key === "Tab" && e.shiftKey,
            run: () => handled(dispatch({ type: "tab", shift: true }, "indent")),
          },
        ]
      : [
          {
            id: `${prefix}-indent`,
            label: "kmIndentOutdent",
            keys: "Tab / Shift + Tab",
            when,
            match: (e) => e.key === "Tab",
            run: (ctx) => handled(dispatch({ type: "tab", shift: ctx.e.shiftKey }, "indent")),
          },
        ];

  // ---- Selection mode ----
  // No Escape binding here: the editor keeps exactly one node selected at all
  // times (see the empty-space click handler), so leaving selection mode would
  // strand the keyboard on an unfocused textarea. Escape only acts in editing
  // mode (edit-escape), returning to selection.
  // `enterBehavior` swaps which of the two Enter forms inserts a sibling and
  // which starts editing — both stay reachable either way, one on plain Enter
  // and one on the ⌘/Ctrl chord. The chord has no native browser action inside
  // the page (⌘/Ctrl+Enter only means "complete the URL" in the address bar),
  // so it can't collide with a browser shortcut. Each `match` tests mod()
  // explicitly rather than relying on table order, so the pair stays
  // order-independent, and the keys strings are built here so the help overlay
  // shows the binding that actually fires.
  const enterEdits = prefs.enterBehavior === "edit";
  // ↑/↓ in selection mode follow the layout, not a preference. On the canvas
  // siblings are what sit above and below each other, so walking the flat
  // (depth-first) order jumps into a neighbouring branch — the outline draws
  // that same order as one vertical column, where it is exactly right. The
  // canvas pair leaves the branch once the siblings run out (to the parent /
  // over the subtree) but never descends into children, so ↑/↓ keep moving
  // without their meaning depending on where in the tree you are. Editing mode
  // uses plain moveUp/moveDown in BOTH layouts (the keyboard-escape invariant
  // wants the adjacent node, not the adjacent sibling — see editSurface.ts).
  const siblingArrows = layout === "canvas";
  const selectionBindings: KeyBinding[] = [
    {
      id: "sel-insert-sibling",
      label: "kmInsertSibling",
      keys: enterEdits ? "⌘/Ctrl + Enter" : "Enter",
      when: "selection",
      match: (e) => e.key === "Enter" && (enterEdits ? mod(e) : !mod(e)),
      run: () => handled(dispatch({ type: "insertSiblingAfter" }, "insert-sibling")),
    },
    {
      id: "sel-edit",
      label: "kmStartEditing",
      keys: enterEdits ? "Enter / Space / F2" : "Space / F2 / ⌘/Ctrl + Enter",
      when: "selection",
      match: (e) =>
        e.key === " " ||
        e.key === "F2" ||
        (e.key === "Enter" && (enterEdits ? !mod(e) : mod(e))),
      run: () => {
        // No cursor args → the reducer's default: whole text selected, exactly
        // like Space, so a follow-up keystroke replaces the text either way.
        return handled(dispatch({ type: "startEditing" }));
      },
    },
    {
      id: "sel-up",
      label: siblingArrows ? "kmSelUpSibling" : "kmSelUpFlat",
      keys: "↑",
      when: "selection",
      match: (e) => e.key === "ArrowUp" && !e.altKey,
      run: () => {
        return handled(dispatch({
          type: siblingArrows ? "moveUpSiblingFirst" : "moveUp",
        }));
      },
    },
    {
      id: "sel-down",
      label: siblingArrows ? "kmSelDownSibling" : "kmSelDownFlat",
      keys: "↓",
      when: "selection",
      match: (e) => e.key === "ArrowDown" && !e.altKey,
      run: () => {
        return handled(dispatch({
          type: siblingArrows ? "moveDownSiblingFirst" : "moveDown",
        }));
      },
    },
    prefs.arrowBehavior === "navigate"
      ? {
          id: "sel-right",
          label: "kmSelChild",
          keys: "→",
          when: "selection",
          match: (e) => e.key === "ArrowRight" && !e.altKey,
          run: (ctx) => {
            const n = ctx.node;
            if (!n || n.children.length === 0) return handled();
            // Expand a folded branch first so focus never lands on a node the
            // fold is hiding; then land on the child the user last visited in
            // this branch (the first one until they've been inside), so ←
            // then → is a round-trip rather than a jump back to the top.
            const expand = n.collapsed ? fold(n.id) : [];
            return handled(...expand, dispatch({ type: "moveToChild" }));
          },
        }
      : {
          id: "sel-right",
          label: "kmSelExpandOrChild",
          keys: "→",
          when: "selection",
          match: (e) => e.key === "ArrowRight" && !e.altKey,
          run: (ctx) => {
            const n = ctx.node;
            if (!n || n.children.length === 0) return handled();
            if (n.collapsed) {
              return handled(...fold(n.id));
            }
            // Already expanded: descend, resuming at the last-visited child
            // (see the navigate branch above).
            return handled(dispatch({ type: "moveToChild" }));
          },
        },
    prefs.arrowBehavior === "navigate"
      ? {
          id: "sel-left",
          label: "kmSelParent",
          keys: "←",
          when: "selection",
          match: (e) => e.key === "ArrowLeft" && !e.altKey,
          run: () => handled(dispatch({ type: "moveToParent" })),
        }
      : {
          id: "sel-left",
          label: "kmSelCollapseOrParent",
          keys: "←",
          when: "selection",
          match: (e) => e.key === "ArrowLeft" && !e.altKey,
          run: (ctx) => {
            const n = ctx.node;
            if (n && n.children.length > 0 && !n.collapsed) {
              return handled(...fold(n.id));
            }
            return handled(dispatch({ type: "moveToParent" }));
          },
        },
    ...tabBindings("selection", "sel"),
    {
      // The horizontal twin of Alt+↑↓: those reorder among siblings, these move
      // the node across levels. Selection mode ONLY, unlike the reorder pair:
      // in a textarea Alt+←→ is macOS's word-wise caret move (and Alt+Shift+←→
      // its word-wise selection), which an editor has no business swallowing.
      // Re-parenting while editing stays Tab / Shift+Tab.
      id: "indent-right",
      label: "kmIndent",
      keys: "Alt + →",
      when: "selection",
      match: (e) => e.altKey && e.key === "ArrowRight",
      run: () => handled(dispatch({ type: "tab", shift: false }, "indent")),
    },
    {
      id: "outdent-left",
      label: "kmOutdent",
      keys: "Alt + ←",
      when: "selection",
      match: (e) => e.altKey && e.key === "ArrowLeft",
      run: () => handled(dispatch({ type: "tab", shift: true }, "indent")),
    },
    {
      id: "sel-delete",
      label: "kmDeleteNode",
      keys: "Backspace / Delete",
      when: "selection",
      match: (e) => e.key === "Backspace" || e.key === "Delete",
      run: (ctx) => {
        if (!ctx.node) return handled();
        return handled(deleteBranch(ctx.node.id));
      },
    },
    {
      id: "sel-help",
      label: "kmShortcutList",
      keys: "?",
      when: "selection",
      match: (e) => e.key === "?",
      run: () => handled({ kind: "openHelp" }),
    },
  ];

  // ---- Always-edit mode (selection mode disabled) ----
  // Replaces the selection-only operations that plain keys can no longer
  // reach: branch deletion gets a chord (folding already has ⌘+., help gets
  // the global ⌘+/). Must precede edit-backspace, which matches any Backspace.
  const alwaysEditBindings: KeyBinding[] = [
    {
      id: "edit-delete-branch",
      label: "kmDeleteBranch",
      keys: "⌘/Ctrl + Shift + Backspace",
      when: "both",
      match: (e) => mod(e) && e.shiftKey && e.key === "Backspace",
      run: (ctx) => {
        if (!ctx.node) return handled();
        return handled(deleteBranch(ctx.node.id));
      },
    },
  ];

  const editIndentBindings = tabBindings("editing", "edit");

  // Escape returns from editing to selection mode; with selection mode
  // disabled there is nowhere to return to, so the binding is dropped and
  // Escape is left to native behaviour (IME cancel, closing dialogs).
  const editEscape: KeyBinding = {
    id: "edit-escape",
    label: "kmExitEditing",
    keys: "Esc",
    when: "editing",
    match: (e) => e.key === "Escape",
    run: () => handled(dispatch({ type: "exitEditing" })),
  };

  return [
    // ---- Global (work regardless of mode / active node) ----
    {
      id: "palette",
      label: "kmCommandPalette",
      keys: "⌘/Ctrl + K",
      when: "global",
      match: (e) => mod(e) && e.key.toLowerCase() === "k",
      run: () => handled({ kind: "openPalette" }),
    },
    {
      id: "undo",
      label: "kmUndo",
      keys: "⌘/Ctrl + Z",
      when: "global",
      match: (e) => mod(e) && !e.shiftKey && e.key.toLowerCase() === "z",
      run: () => handled({ kind: "undo" }),
    },
    {
      id: "redo",
      label: "kmRedo",
      keys: "⌘/Ctrl + Shift + Z",
      when: "global",
      match: (e) => mod(e) && e.shiftKey && e.key.toLowerCase() === "z",
      run: () => handled({ kind: "redo" }),
    },
    {
      // Windows-style redo alias; hidden from help to avoid a duplicate row.
      id: "redo-y",
      label: "",
      keys: "⌘/Ctrl + Y",
      when: "global",
      match: (e) => mod(e) && e.key.toLowerCase() === "y",
      run: () => handled({ kind: "redo" }),
    },
    {
      // Chorded twin of selection mode's "?": while editing (and in always-edit
      // mode, where "?" just types a character) this is the only key that can
      // reach the help overlay.
      id: "help-slash",
      label: "kmShortcutList",
      keys: "⌘/Ctrl + /",
      when: "global",
      match: (e) => mod(e) && e.key === "/",
      run: () => handled({ kind: "openHelp" }),
    },

    // ---- Cross-mode (need an active node; must precede plain-arrow bindings) ----
    {
      id: "reorder-up",
      label: "kmMoveNodeUp",
      keys: "Alt + ↑",
      when: "both",
      match: (e) => e.altKey && e.key === "ArrowUp",
      run: (ctx) => {
        return handled(dispatch({ type: "moveNodeUp" }, "reorder"), SAVE);
      },
    },
    {
      id: "reorder-down",
      label: "kmMoveNodeDown",
      keys: "Alt + ↓",
      when: "both",
      match: (e) => e.altKey && e.key === "ArrowDown",
      run: (ctx) => {
        return handled(dispatch({ type: "moveNodeDown" }, "reorder"), SAVE);
      },
    },
    {
      id: "bold",
      label: "kmBold",
      keys: "⌘/Ctrl + B",
      when: "both",
      match: (e) => mod(e) && e.key.toLowerCase() === "b",
      run: (ctx) => {
        const n = ctx.node;
        // Bold only applies to text nodes (matches the context menu).
        if (!n || (n.type ?? "text") !== "text") return handled();
        return handled(dispatch({ type: "setNodeStyle", nodeId: n.id, bold: !n.bold }, "style"), SAVE);
      },
    },

    {
      id: "toggle-task",
      label: "kmToggleTask",
      keys: "⌘/Ctrl + Shift + D",
      when: "both",
      // "D" for done. NOT the ⌘/Ctrl+Enter chord most task apps use: the two
      // Enter forms above are a preference-swapped PAIR, and both deliberately
      // ignore Shift (see editorKeymap.test.ts), so every Enter combination is
      // already spoken for by one half or the other.
      match: (e) => mod(e) && e.shiftKey && e.key.toLowerCase() === "d",
      run: (ctx) => {
        const n = ctx.node;
        if (!n || !supportsCheckbox(n.type ?? "text")) return handled();
        return handled(dispatch({ type: "setChecked", nodeId: n.id, checked: nextCheckedState(n.checked) }, "check"), SAVE);
      },
    },

    {
      id: "toggle-collapse",
      label: "kmToggleCollapse",
      keys: "⌘/Ctrl + .",
      when: "both",
      // Selection mode already collapses with ←/→, but those are the caret keys
      // while editing. This chord toggles collapse in either mode so you never
      // have to leave edit mode to fold a subtree.
      match: (e) => mod(e) && e.key === ".",
      run: (ctx) => {
        const n = ctx.node;
        if (!n || n.children.length === 0) return handled();
        return handled(...fold(n.id));
      },
    },

    // Selection-only bindings, or their always-edit replacements (the two-mode
    // model itself is a preference).
    ...(prefs.selectionMode ? selectionBindings : alwaysEditBindings),

    // ---- Editing mode ----
    {
      id: "edit-newline",
      label: "kmNewline",
      keys: "Shift + Enter",
      when: "editing",
      match: (e) => e.key === "Enter" && e.shiftKey,
      run: () => PASS, // native textarea inserts the "\n"
    },
    {
      id: "edit-enter",
      label: "kmSplitNode",
      keys: "Enter",
      when: "editing",
      match: (e) => e.key === "Enter",
      run: (ctx) => {
        return handled(dispatch({ type: "enter", pos: ctx.pos }, "enter"));
      },
    },
    ...editIndentBindings,
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
          return handled(dispatch({ type: "backspaceAtStart" }, "backspace"));
        }
        return PASS;
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
        if (ctx.pos !== ctx.selEnd) return PASS;
        // Only a caret at the end with a structural successor merges;
        // otherwise let the textarea delete forward.
        const n = ctx.node;
        if (!n || ctx.pos < n.text.length) return PASS;
        if (!hasStructuralSuccessor(ctx.state.document.model, n.id)) return PASS;
        return handled(dispatch({ type: "deleteAtEnd", pos: ctx.pos }, "delete"));
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
        const newPos = verticalMove(ctx.state.view.editingText, ctx.pos, -1);
        if (newPos === null) return handled(dispatch({ type: "moveUp" }));
        return handled(
          dispatch({ type: "setSelection", cursorPos: newPos, selectionEnd: newPos })
        );
      },
    },
    {
      id: "edit-down",
      label: "",
      keys: "↓",
      when: "editing",
      match: (e) => e.key === "ArrowDown" && !e.altKey,
      run: (ctx) => {
        const newPos = verticalMove(ctx.state.view.editingText, ctx.pos, 1);
        if (newPos === null) return handled(dispatch({ type: "moveDown" }));
        return handled(
          dispatch({ type: "setSelection", cursorPos: newPos, selectionEnd: newPos })
        );
      },
    },
    {
      id: "edit-cmd-shift-left",
      label: "",
      keys: "⌘/Ctrl + Shift + ←",
      when: "editing",
      match: (e) => e.key === "ArrowLeft" && mod(e) && e.shiftKey,
      run: (ctx) => {
        return handled(dispatch({ type: "cmdShiftLeft", pos: ctx.pos, selEnd: ctx.selEnd }));
      },
    },
    {
      id: "edit-cmd-left",
      label: "",
      keys: "⌘/Ctrl + ←",
      when: "editing",
      match: (e) => e.key === "ArrowLeft" && mod(e),
      run: (ctx) => {
        return handled(dispatch({ type: "cmdLeft", pos: ctx.pos }));
      },
    },
    {
      id: "edit-shift-left",
      label: "",
      keys: "Shift + ←",
      when: "editing",
      match: (e) => e.key === "ArrowLeft" && e.shiftKey,
      run: () => PASS, // native selection extension
    },
    {
      id: "edit-left",
      label: "",
      keys: "←",
      when: "editing",
      match: (e) => e.key === "ArrowLeft" && !e.altKey,
      run: (ctx) => {
        if (ctx.pos === 0 && ctx.pos === ctx.selEnd) {
          return handled(dispatch({ type: "arrowLeftEdge" }));
        }
        return PASS;
      },
    },
    {
      id: "edit-cmd-shift-right",
      label: "",
      keys: "⌘/Ctrl + Shift + →",
      when: "editing",
      match: (e) => e.key === "ArrowRight" && mod(e) && e.shiftKey,
      run: (ctx) => {
        return handled(dispatch({ type: "cmdShiftRight", pos: ctx.pos, selEnd: ctx.selEnd }));
      },
    },
    {
      id: "edit-cmd-right",
      label: "",
      keys: "⌘/Ctrl + →",
      when: "editing",
      match: (e) => e.key === "ArrowRight" && mod(e),
      run: (ctx) => {
        return handled(dispatch({ type: "cmdRight", pos: ctx.pos }));
      },
    },
    {
      id: "edit-shift-right",
      label: "",
      keys: "Shift + →",
      when: "editing",
      match: (e) => e.key === "ArrowRight" && e.shiftKey,
      run: () => PASS, // native selection extension
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
          return handled(dispatch({ type: "arrowRightEdge" }));
        }
        return PASS;
      },
    },
    ...(prefs.selectionMode ? [editEscape] : []),
  ];
}

/**
 * Resolve a key event against the keymap: the first binding whose scope
 * matches the current mode and whose `match` accepts the event decides. Pure
 * — returns what should happen; the caller prevents the default for
 * "handled" and interprets the effects. No match → {@link PASS}.
 */
export function runKeymap(
  bindings: KeyBinding[],
  ctx: KeyContext,
  prefs: EditorPreferences = DEFAULT_PREFERENCES
): KeyOutcome {
  // With selection mode disabled the editor never leaves edit mode, but
  // view.editing can still momentarily be false (initial load, canvas paste
  // landing, markdown-panel handoff). Force the editing scope so keys never
  // fall into a mode the user has turned off.
  const mode: KeyMode =
    !prefs.selectionMode || ctx.state.view.editing ? "editing" : "selection";
  const hasActive = ctx.state.view.activeNodeId !== null;
  for (const b of bindings) {
    if (b.when === "global") {
      if (!b.match(ctx.e)) continue;
    } else {
      if (!hasActive) continue;
      if (b.when !== "both" && b.when !== mode) continue;
      if (!b.match(ctx.e)) continue;
    }
    return b.run(ctx);
  }
  return PASS;
}

// Resolve the active node without re-reading refs in the component.
export function activeNode(state: EditorState): MindMapModel | null {
  return state.view.activeNodeId
    ? findNode(state.document.model, state.view.activeNodeId)
    : null;
}
