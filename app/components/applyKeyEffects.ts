/**
 * The interpreter for effect descriptions (see application/editorKeymap.ts):
 * key presses and multi-step commands (application/editorCommands.ts) both
 * only say what should happen, so this is the one place anything actually
 * dispatches, saves, flashes or opens.
 *
 * Rule for `save`: persist the model as it stands now, but only if the
 * dispatches so far actually changed the document — a no-op reorder, a
 * view-only step, or a dispatch swallowed by read-only mode must not write.
 */
import type { MindMapModel } from "../domain/model";
import type {
  EditorAction,
  EditorState,
  UndoType,
} from "../application/editorReducer";
import type { KeyEffect } from "../application/editorKeymap";

export interface KeyEffectDeps {
  dispatch: (action: EditorAction, undoType?: UndoType) => EditorState;
  /** Persist the model (no-op when the note is unsaved). */
  saveNote: (model: MindMapModel) => void;
  // Key-press only; a command runner (paste) leaves them out.
  openPalette?: () => void;
  openHelp?: () => void;
  undo?: () => void;
  redo?: () => void;
  /** Highlight nodes; absent where nothing is drawn (outline). */
  flashNodes?: (ids: string[]) => void;
}

export function applyKeyEffects(
  effects: readonly KeyEffect[],
  state: EditorState,
  deps: KeyEffectDeps
): EditorState {
  let current = state;
  for (const effect of effects) {
    switch (effect.kind) {
      case "dispatch":
        current = deps.dispatch(effect.action, effect.undoType);
        break;
      case "save":
        if (current.document.model !== state.document.model) {
          deps.saveNote(current.document.model);
        }
        break;
      case "flash": {
        const ids =
          effect.ids === "active"
            ? current.view.activeNodeId
              ? [current.view.activeNodeId]
              : []
            : effect.ids;
        deps.flashNodes?.(ids);
        break;
      }
      case "openPalette":
        deps.openPalette?.();
        break;
      case "openHelp":
        deps.openHelp?.();
        break;
      case "undo":
        deps.undo?.();
        break;
      case "redo":
        deps.redo?.();
        break;
    }
  }
  return current;
}
