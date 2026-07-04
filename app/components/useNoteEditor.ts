/**
 * Shared note-editing engine.
 *
 * Owns the single source of truth (EditorState) plus everything that is view
 * independent: the central dispatch (with undo bookkeeping), the undo manager,
 * autosave / navigation-guard / beforeunload persistence, and the public flag.
 *
 * Both the Konva mind-map view and the mobile outline view consume this hook so
 * they operate on the *same* state — switching layouts (e.g. when the viewport
 * crosses the mobile breakpoint) keeps edits, caret and undo history intact.
 */

import { useState, useRef, useEffect, useCallback } from "react";
import { router } from "@inertiajs/react";
import type { MindMapModel } from "../domain/model";
import {
  editorReducer,
  type EditorState,
  type EditorAction,
} from "../application/editorReducer";
import {
  parseContent,
  serializeModel,
} from "../application/persistence";
import { UndoManager } from "../application/undoManager";

export interface NoteEditorInit {
  noteId?: string;
  initialContent?: string;
  initialTitle?: string;
  initialIsPublic?: boolean;
}

/** A pending Inertia visit held back while an unsaved edit is flushed. */
export interface LeaveConfirm {
  url: string | URL;
  method: "get" | "post" | "put" | "patch" | "delete";
}

export interface NoteEditorEngine {
  /** The full editor state (re-renders consumers on change). */
  state: EditorState;
  stateRef: React.MutableRefObject<EditorState>;
  /** Convenience alias for state.document.model. */
  model: MindMapModel;
  modelRef: React.MutableRefObject<MindMapModel>;
  /** Central dispatch: pure reducer + undo bookkeeping. Returns next state. */
  dispatch: (action: EditorAction, undoType?: string) => EditorState;
  /** Persist the model (no-op when the note is unsaved / guest mode). */
  saveNote: (currentModel: MindMapModel, pub?: boolean) => Promise<boolean>;
  updateSaveStatus: (status: string) => void;
  saveStatusRef: React.RefObject<HTMLSpanElement | null>;
  isDirty: () => boolean;
  isPublic: boolean;
  setIsPublic: (v: boolean) => void;
  undoManagerRef: React.MutableRefObject<UndoManager>;
  undo: () => void;
  redo: () => void;
  noteId?: string;
  // --- navigation guard (rendered as a confirm dialog by the active view) ---
  leaveConfirm: LeaveConfirm | null;
  setLeaveConfirm: (v: LeaveConfirm | null) => void;
  bypassNavGuardRef: React.MutableRefObject<boolean>;
}

export function useNoteEditor({
  noteId,
  initialContent,
  initialTitle,
  initialIsPublic,
}: NoteEditorInit): NoteEditorEngine {
  // --- Single source of truth: the full editor state ---
  // Exactly one node is always selected; the root starts active.
  const [state, setStateRaw] = useState<EditorState>(() => {
    const model = parseContent(initialContent, initialTitle);
    return {
      document: { model, clipboard: null },
      view: {
        activeNodeId: model.id,
        editing: false,
        editingText: model.text,
        cursorPos: 0,
        selectionEnd: 0,
      },
    };
  });
  const stateRef = useRef(state);
  stateRef.current = state;

  const model = state.document.model;
  const modelRef = useRef(model);
  modelRef.current = model;

  const [isPublic, setIsPublic] = useState(initialIsPublic || false);
  const [leaveConfirm, setLeaveConfirm] = useState<LeaveConfirm | null>(null);

  const saveTimerRef = useRef<any>(null);
  // Serialized content last confirmed persisted. The server just handed us the
  // initial model, so that's our clean baseline; every successful save advances
  // it. `isDirty()` compares the live model against this.
  const lastSavedContentRef = useRef<string>(serializeModel(model));
  // Monotonic save-dispatch counter. An edit can arrive while a save is still
  // in flight, so two saves run concurrently and their responses may land out
  // of order. Each save takes the next `saveSeqRef` on dispatch; on success we
  // only advance the baseline when this save is the newest one acknowledged
  // (`ackedSeqRef`), so a slow older save can never regress the baseline and
  // resurrect a false "unsaved" state.
  const saveSeqRef = useRef(0);
  const ackedSeqRef = useRef(0);
  // Set true just before re-issuing a visit we already flushed, so the
  // navigation guard lets that one visit pass through instead of re-flushing.
  const bypassNavGuardRef = useRef(false);
  const saveStatusRef = useRef<HTMLSpanElement>(null);
  const undoManagerRef = useRef(new UndoManager());

  // --- Central dispatch: state -> action -> newState ---
  // Pure reducer computes the complete next state; a no-op returns the same
  // reference so we skip re-render and undo bookkeeping.
  const dispatch = useCallback(
    (action: EditorAction, undoType?: string): EditorState => {
      const prev = stateRef.current;
      const next = editorReducer(prev, action);
      if (next === prev) return prev;
      if (undoType && next.document !== prev.document) {
        undoManagerRef.current.push(undoType, prev.document, next.document);
      }
      stateRef.current = next;
      setStateRaw(next);
      return next;
    },
    []
  );

  // --- Save ---
  const updateSaveStatus = useCallback((status: string) => {
    if (saveStatusRef.current) saveStatusRef.current.textContent = status;
  }, []);

  const saveNote = useCallback(
    async (currentModel: MindMapModel, pub?: boolean): Promise<boolean> => {
      if (!noteId) return true;
      const content = serializeModel(currentModel);
      const seq = ++saveSeqRef.current;
      updateSaveStatus("保存中...");
      try {
        const res = await fetch(`/api/notes/${noteId}`, {
          method: "PUT",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            content,
            title: currentModel.text,
            isPublic: pub ?? isPublic,
          }),
        });
        if (res.ok) {
          // Advance the baseline only if no newer save has already been
          // acknowledged — an out-of-order older completion must not roll the
          // baseline (and the "unsaved" state) backwards.
          if (seq > ackedSeqRef.current) {
            ackedSeqRef.current = seq;
            lastSavedContentRef.current = content;
            updateSaveStatus("保存済み");
          }
          return true;
        }
        updateSaveStatus("保存失敗");
        return false;
      } catch {
        updateSaveStatus("保存失敗");
        return false;
      }
    },
    [noteId, isPublic, updateSaveStatus]
  );

  // Are there edits not yet confirmed persisted? Only meaningful with a noteId
  // (guest/embed mode has no autosave and nothing to guard).
  const isDirty = useCallback(
    () =>
      !!noteId &&
      serializeModel(modelRef.current) !== lastSavedContentRef.current,
    [noteId]
  );

  // Debounced auto-save (with retry-on-failure).
  useEffect(() => {
    if (!noteId) return;
    // Reflect the pending edit immediately so the header shows the note isn't
    // persisted yet (the save itself flips this to 保存中... → 保存済み).
    if (isDirty()) updateSaveStatus("未保存");
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    let cancelled = false;
    // A failed autosave used to sit unsaved until the next edit or navigation.
    // Re-arm with exponential backoff (capped) so a transient failure recovers
    // on its own; stop once the save lands or the model changes (this effect
    // re-runs and resets the chain).
    const arm = (delay: number) => {
      saveTimerRef.current = setTimeout(async () => {
        const ok = await saveNote(modelRef.current);
        if (!cancelled && !ok && isDirty()) arm(Math.min(delay * 2, 15000));
      }, delay);
    };
    arm(1500);
    return () => {
      cancelled = true;
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    };
  }, [model, noteId, saveNote, isDirty, updateSaveStatus]);

  // --- Guard against leaving with unsaved edits ---
  // Tab close / reload / hard navigation: fire a best-effort keepalive save so
  // the last edit survives, and raise the browser's native confirm as a
  // backstop in case that request doesn't land.
  useEffect(() => {
    if (!noteId) return;
    const handler = (e: BeforeUnloadEvent) => {
      if (!isDirty()) return;
      const current = modelRef.current;
      fetch(`/api/notes/${noteId}`, {
        method: "PUT",
        credentials: "include",
        keepalive: true,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content: serializeModel(current),
          title: current.text,
          isPublic,
        }),
      }).catch(() => {});
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [noteId, isDirty, isPublic]);

  // Client-side (Inertia) navigation — e.g. the "← 一覧" link or the browser
  // back button. When there are unsaved edits, hold the visit, flush the save,
  // then let it proceed; only interrupt the user with a dialog if that save
  // fails (otherwise navigation stays invisible, matching the autosave UX).
  useEffect(() => {
    if (!noteId) return;
    return router.on("before", (event) => {
      // The visit we re-issue after a successful flush must pass through.
      if (bypassNavGuardRef.current) {
        bypassNavGuardRef.current = false;
        return;
      }
      if (!isDirty()) return;
      event.preventDefault();
      const visit = event.detail.visit;
      void (async () => {
        if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
        const ok = await saveNote(modelRef.current);
        if (ok) {
          bypassNavGuardRef.current = true;
          router.visit(visit.url, {
            method: visit.method,
            data: visit.data,
            replace: visit.replace,
            preserveScroll: visit.preserveScroll,
            preserveState: visit.preserveState,
          });
        } else {
          setLeaveConfirm({ url: visit.url, method: visit.method });
        }
      })();
    });
  }, [noteId, isDirty, saveNote]);

  // --- Undo manager: commit pending text using the latest state ---
  useEffect(() => {
    undoManagerRef.current.setCommitCallback(() => stateRef.current.document);
  }, []);

  // Undo/redo restore only the document; the current selection/caret (view
  // state) is carried over as-is. The `replace` reducer reconciles it against
  // the restored document, so if the active node no longer exists there it
  // falls back to the root instead of dangling.
  const restoreDocument = useCallback(
    (restored: EditorState["document"] | null) => {
      if (!restored) return;
      dispatch({
        type: "replace",
        state: { document: restored, view: stateRef.current.view },
      });
    },
    [dispatch]
  );
  const undo = useCallback(
    () => restoreDocument(undoManagerRef.current.undo()),
    [restoreDocument]
  );
  const redo = useCallback(
    () => restoreDocument(undoManagerRef.current.redo()),
    [restoreDocument]
  );

  return {
    state,
    stateRef,
    model,
    modelRef,
    dispatch,
    saveNote,
    updateSaveStatus,
    saveStatusRef,
    isDirty,
    isPublic,
    setIsPublic,
    undoManagerRef,
    undo,
    redo,
    noteId,
    leaveConfirm,
    setLeaveConfirm,
    bypassNavGuardRef,
  };
}
