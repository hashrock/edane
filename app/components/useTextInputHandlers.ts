/**
 * Shared text-input glue for both editor views.
 *
 * The canvas (MindmapEditor) and outline (OutlineEditor) views host the same
 * hidden/inline textarea and drive the shared editor engine identically: every
 * keystroke snapshots undo state and dispatches `typeText`, IME composition is
 * held back from the model until it ends, selection changes sync the caret, and
 * the inline URL box edits a node's `text` and persists. This hook owns that
 * common machinery (the input ref + composition state + the four handlers) so
 * the two views stay in lock-step instead of maintaining parallel copies.
 */

import { useState, useRef, useCallback } from "react";
import type { NoteEditorEngine } from "./useNoteEditor";
import { rangeClipboardCommand } from "../application/editorCommands";
import { applyKeyEffects } from "./applyKeyEffects";

export interface TextInputHandlers {
  /** Ref for the view's editing textarea (hidden on canvas, inline on outline). */
  inputRef: React.RefObject<HTMLTextAreaElement | null>;
  /** True while an IME composition is in flight (re-renders on change). */
  isComposing: boolean;
  /** Same signal as a ref, for reads inside effects/handlers without a dep. */
  isComposingRef: React.MutableRefObject<boolean>;
  handleInputChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => void;
  handleCompositionStart: () => void;
  handleCompositionEnd: () => void;
  handleSelect: () => void;
  handleUrlChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  /**
   * Write the edit buffer and caret into the textarea right now, instead of
   * on the next render. For a key whose native action still runs after the
   * handler (an IME's first keydown) and must find the textarea already
   * showing what the reducer just made of it.
   */
  syncInputNow: (view: { editingText: string; cursorPos: number; selectionEnd: number }) => void;
  /**
   * Take a copy / cut / paste over a cross-node range off the textarea
   * (which holds only the anchor's part of it). Returns false, touching
   * nothing, when there is no range: the event is the view's to handle.
   * `pasteAsNodes`: this view pastes the text as nodes.
   */
  handleRangeClipboard: (e: React.ClipboardEvent, opts?: { pasteAsNodes?: boolean }) => boolean;
}

export function useTextInputHandlers(
  engine: NoteEditorEngine
): TextInputHandlers {
  const { dispatch, saveNote, noteId, stateRef, undoManagerRef } = engine;

  const inputRef = useRef<HTMLTextAreaElement>(null);
  const isComposingRef = useRef(false);
  const [isComposing, setIsComposing] = useState(false);

  const handleInputChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const el = e.target;
      // Snapshot the pre-typing state once per debounce batch.
      undoManagerRef.current.handleTextChange(stateRef.current.document);
      dispatch({
        type: "typeText",
        text: el.value,
        cursorPos: el.selectionStart ?? 0,
        selectionEnd: el.selectionEnd ?? 0,
        // Don't commit to the model mid-IME-composition.
        commitModel: !isComposingRef.current,
      });
    },
    [dispatch, stateRef, undoManagerRef]
  );

  const handleCompositionStart = useCallback(() => {
    setIsComposing(true);
    isComposingRef.current = true;
  }, []);

  const handleCompositionEnd = useCallback(() => {
    setIsComposing(false);
    isComposingRef.current = false;
    const el = inputRef.current;
    if (!el || !stateRef.current.view.activeNodeId) return;
    undoManagerRef.current.handleTextChange(stateRef.current.document);
    dispatch({
      type: "typeText",
      text: el.value,
      cursorPos: el.selectionStart ?? el.value.length,
      selectionEnd: el.selectionEnd ?? el.value.length,
      commitModel: true,
    });
  }, [dispatch, stateRef, undoManagerRef]);

  const handleSelect = useCallback(() => {
    const el = inputRef.current;
    if (!el) return;
    dispatch({
      type: "setSelection",
      cursorPos: el.selectionStart || 0,
      selectionEnd: el.selectionEnd || 0,
    });
  }, [dispatch]);

  // Inline URL box (image / link nodes): edits the node's `text` (its URL)
  // while the view keeps drawing the preview. Persists on change so the preview
  // and any saved copy stay in sync.
  const handleUrlChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      undoManagerRef.current.handleTextChange(stateRef.current.document);
      const next = dispatch({
        type: "typeText",
        text: e.target.value,
        cursorPos: e.target.selectionStart ?? e.target.value.length,
        selectionEnd: e.target.selectionEnd ?? e.target.value.length,
        commitModel: true,
      });
      if (noteId) saveNote(next.document.model);
    },
    [dispatch, noteId, saveNote, stateRef, undoManagerRef]
  );

  const syncInputNow = useCallback<TextInputHandlers["syncInputNow"]>((view) => {
    const el = inputRef.current;
    if (!el) return;
    if (el.value !== view.editingText) el.value = view.editingText;
    el.setSelectionRange(view.cursorPos, view.selectionEnd);
  }, []);

  const handleRangeClipboard = useCallback<TextInputHandlers["handleRangeClipboard"]>(
    (e, opts = {}) => {
      const st = stateRef.current;
      const text = e.clipboardData.getData("text");
      const cmd = rangeClipboardCommand(
        st,
        e.type === "paste"
          ? { kind: "paste", text, asNodes: !!opts.pasteAsNodes }
          : { kind: e.type === "cut" ? "cut" : "copy" }
      );
      if (!cmd) return false;
      e.preventDefault();
      if (cmd.text !== undefined) e.clipboardData.setData("text/plain", cmd.text);
      applyKeyEffects(cmd.effects, st, { dispatch, saveNote });
      return true;
    },
    [dispatch, saveNote, stateRef]
  );

  return {
    inputRef,
    syncInputNow,
    handleRangeClipboard,
    isComposing,
    isComposingRef,
    handleInputChange,
    handleCompositionStart,
    handleCompositionEnd,
    handleSelect,
    handleUrlChange,
  };
}
