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

export interface TextInputHandlers {
  /** Ref for the view's editing textarea (hidden on canvas, inline on outline). */
  inputRef: React.RefObject<HTMLTextAreaElement | null>;
  /** True while an IME composition is in flight (re-renders on change). */
  isComposing: boolean;
  /** Same signal as a ref, for reads inside effects/handlers without a dep. */
  isComposingRef: React.MutableRefObject<boolean>;
  /**
   * Bind as `onInput`, NOT `onChange`: React's onChange skips an input whose
   * value equals the last one it saw, so typing "x" over a selected node
   * whose text is "x" (a replace that leaves the value unchanged) would be
   * dropped — the node would never enter edit mode and the next key would
   * replace the text again.
   */
  handleInputChange: (e: React.FormEvent<HTMLTextAreaElement>) => void;
  handleCompositionStart: () => void;
  handleCompositionEnd: () => void;
  handleSelect: () => void;
  handleUrlChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
}

export function useTextInputHandlers(
  engine: NoteEditorEngine
): TextInputHandlers {
  const { dispatch, saveNote, noteId, stateRef, undoManagerRef } = engine;

  const inputRef = useRef<HTMLTextAreaElement>(null);
  const isComposingRef = useRef(false);
  const [isComposing, setIsComposing] = useState(false);

  const handleInputChange = useCallback(
    (e: React.FormEvent<HTMLTextAreaElement>) => {
      const el = e.currentTarget;
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
    // "select" fires asynchronously, so it can land after a dispatch moved the
    // focus but before the sync effect rewrote the textarea: the range it
    // reads then belongs to the PREVIOUS node's text, and writing it back
    // corrupts the new node's selection (e.g. a deletion landing on a
    // neighbour kept the deleted node's 0..len, so typing prepended instead of
    // replacing). Only an event about the text the view holds may update it.
    // In selection mode the view owns the range outright (whole text
    // selected); the hidden textarea only mirrors it.
    const { view } = stateRef.current;
    if (!view.editing || el.value !== view.editingText) return;
    dispatch({
      type: "setSelection",
      cursorPos: el.selectionStart || 0,
      selectionEnd: el.selectionEnd || 0,
    });
  }, [dispatch, stateRef]);

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

  return {
    inputRef,
    isComposing,
    isComposingRef,
    handleInputChange,
    handleCompositionStart,
    handleCompositionEnd,
    handleSelect,
    handleUrlChange,
  };
}
