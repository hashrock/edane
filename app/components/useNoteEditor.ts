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
import { NoteSyncClient } from "./noteSyncClient";
import { registerWebMcp, prepareActions } from "./webmcp";
import { editorReducer } from "../application/editorReducer";
import { router } from "@inertiajs/react";
import { type MindMapDocument, findNode, firstRootId } from "../domain/model";
import {
  freshEditorState,
  type EditorState,
  type EditorAction,
  type UndoType,
} from "../application/editorReducer";
import { guardedStep } from "../application/readOnlyGuard";
import {
  AUTOSAVE_DELAY_MS,
  isRetryableFailure,
  nextRetryDelay,
  type SaveDisplay,
  type SaveFailureReason,
} from "../application/saveTracker";
import {
  parseContent,
} from "../application/persistence";
import { publicNoteUrl } from "../application/publicNoteLink";
import { t } from "../application/i18n";
import type { MessageKey } from "../application/messages";
import { UndoManager } from "../application/undoManager";
import { copyText } from "../lib/clipboard";
import { formatBytes } from "../lib/formatBytes";
import { IMAGE_STORAGE_LIMIT_BYTES } from "../domain/imageStorage";

/**
 * updateSaveStatus に渡す状態コード。表示文言は描画時に現在のUI言語で解決する
 * ので、呼び出し側は文言ではなくコードを渡す（フェード演出の分岐 "" / "saved" /
 * それ以外もコードで判定できる）。
 *
 * 保存以外のヘッダー通知（画像アップロード、リンクコピー）も同じ一行に相乗り
 * している。専用のトースト機構は持たない。
 */
export type SaveStatusText =
  | ""
  | "saving"
  // 保存の結末は saveTracker が決めるので、そちらを単一ソースにする（片方だけ
  // 改名しても、ここが合わなければコンパイルで気づく）。
  | NonNullable<SaveDisplay>
  | "uploading"
  | "upload-failed"
  | "storage-limit"
  | "link-copied"
  | "link-copy-failed";

/**
 * 失敗理由→説明文のカタログキー。ヘッダーの「保存できませんでした」の横と、
 * 離脱ダイアログの本文で使う（usertest #3: 理由と対処を必ず示す）。
 */
export const SAVE_FAILURE_MESSAGE = {
  auth: "saveFailedAuth",
  server: "saveFailedServer",
  network: "saveFailedNetwork",
  other: "saveFailedOther",
} as const satisfies Record<SaveFailureReason, MessageKey>;

/** 離脱ダイアログの本文: 失敗理由（あれば）＋未保存の警告。 */
export function leaveDialogMessage(reason: SaveFailureReason | null): string {
  const warning = t("leaveMessage");
  return reason ? `${t(SAVE_FAILURE_MESSAGE[reason])} ${warning}` : warning;
}

/** コード→カタログキー。網羅は satisfies で強制（キー追加漏れを防ぐ）。 */
const SAVE_STATUS_MESSAGE = {
  saving: "statusSaving",
  saved: "statusSaved",
  "save-failed": "statusSaveFailed",
  uploading: "statusUploading",
  "upload-failed": "statusUploadFailed",
  "storage-limit": "statusStorageLimit",
  "link-copied": "copyLinkSuccess",
  "link-copy-failed": "copyLinkFailure",
} as const satisfies Record<Exclude<SaveStatusText, "">, MessageKey>;

/** ステータス→ t() に渡す埋め込みパラメータ（不要なものは省略）。 */
const SAVE_STATUS_PARAMS: Partial<
  Record<Exclude<SaveStatusText, "">, Record<string, string>>
> = {
  "storage-limit": { limit: formatBytes(IMAGE_STORAGE_LIMIT_BYTES) },
};

export interface NoteEditorInit {
  noteId?: string;
  initialContent?: string;
  initialTitle?: string;
  initialIsPublic?: boolean;
  /**
   * 閲覧専用モード。編集モードへの突入とドキュメント変更を dispatch の段階で
   * 一括遮断する（例外: 折りたたみトグルは閲覧操作として許可）。保存系
   * （autosave / 離脱ガード / beforeunload）もすべて無効になる。
   */
  readOnly?: boolean;
}

/** A pending Inertia visit held back while an unsaved edit is flushed. */
export interface LeaveConfirm {
  url: string | URL;
  method: "get" | "post" | "put" | "patch" | "delete";
}

export interface NoteEditorEngine {
  /** The full editor state (re-renders consumers on change). */
  syncError: string | null;
  syncRecovery: string;
  state: EditorState;
  stateRef: React.MutableRefObject<EditorState>;
  /** Convenience alias for state.document.model. */
  model: MindMapDocument;
  modelRef: React.MutableRefObject<MindMapDocument>;
  /** Central dispatch: pure reducer + undo bookkeeping. Returns next state. */
  dispatch: (action: EditorAction, undoType?: UndoType) => EditorState;
  /** Persist the model (no-op when the note is unsaved / guest mode). */
  saveNote: (currentModel: MindMapDocument, pub?: boolean) => Promise<boolean>;
  updateSaveStatus: (status: SaveStatusText) => void;
  saveStatusRef: React.RefObject<HTMLSpanElement | null>;
  /**
   * 直近の保存が失敗した理由。成功するか、内容が変わって次の保存が走るまで
   * 残る。ヘッダーはこれで説明文と「再試行」を出す（null = 失敗していない）。
   */
  saveFailure: SaveFailureReason | null;
  /** 今の内容をすぐ保存し直す（自動再試行を待たない）。 */
  retrySave: () => void;
  /**
   * 公開ノートの閲覧URLをクリップボードへコピーし、結果をヘッダーの
   * ステータス行に出す。未保存ノート（noteId なし）では何もしない。
   */
  copyPublicLink: () => void;
  /** 公開ノートの閲覧ページを新しいタブで開く（noteId なしでは何もしない）。 */
  openPublicPage: () => void;
  isDirty: () => boolean;
  isPublic: boolean;
  setIsPublic: (v: boolean) => void;
  undoManagerRef: React.MutableRefObject<UndoManager>;
  undo: () => void;
  redo: () => void;
  noteId?: string;
  /** 閲覧専用モード（ビュー側は編集系UIを隠す）。 */
  readOnly: boolean;
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
  readOnly = false,
}: NoteEditorInit): NoteEditorEngine {
  // --- Single source of truth: the full editor state ---
  // Exactly one node is always selected; the first top-level node starts
  // active (the root is the title, not a node).
  const [state, setStateRaw] = useState<EditorState>(() => {
    const model = parseContent(initialContent, initialTitle);
    return freshEditorState(model, firstRootId(model));
  });
  const stateRef = useRef(state);
  stateRef.current = state;

  const model = state.document.model;
  const modelRef = useRef(model);
  modelRef.current = model;

  const [isPublic, setIsPublic] = useState(initialIsPublic || false);
  const [leaveConfirm, setLeaveConfirm] = useState<LeaveConfirm | null>(null);
  const [saveFailure, setSaveFailure] = useState<SaveFailureReason | null>(null);

  const saveTimerRef = useRef<any>(null);
  // Set true just before re-issuing a visit we already flushed, so the
  // navigation guard lets that one visit pass through instead of re-flushing.
  const bypassNavGuardRef = useRef(false);
  const saveStatusRef = useRef<HTMLSpanElement>(null);
  const undoManagerRef = useRef(new UndoManager());
  // Mirror of `saveFailure` for the timer / effect closures.
  const saveFailureRef = useRef<SaveFailureReason | null>(null);
  saveFailureRef.current = saveFailure;

  const syncRef = useRef<NoteSyncClient | null>(null);
  const [syncReady, setSyncReady] = useState(!noteId || readOnly);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [syncRecovery, setSyncRecovery] = useState("");
  const lastCommitRef = useRef<Promise<void>>(Promise.resolve());

  // --- Central dispatch: state -> action -> newState ---
  // Pure reducer computes the complete next state; a no-op returns the same
  // reference so we skip re-render and undo bookkeeping.
  const dispatch = useCallback(
    (action: EditorAction, undoType?: UndoType): EditorState => {
      const prev = stateRef.current;
      if (noteId && !readOnly && !syncRef.current?.snapshot) return prev;
      // 閲覧専用: どのビュー・どの経路から来ても、ここで編集を一括遮断する
      // （規則は application/readOnlyGuard.ts）。
      const next = guardedStep(prev, action, readOnly);
      if (next === prev) return prev;
      if (!readOnly && undoType && next.document !== prev.document) {
        undoManagerRef.current.push(undoType, prev.document, next.document);
      }
      if (!readOnly && next.document.model !== prev.document.model && syncRef.current) {
        lastCommitRef.current = syncRef.current.commit(prev.document.model, next.document.model);
      }
      stateRef.current = next;
      modelRef.current = next.document.model;
      setStateRaw(next);
      return next;
    },
    [readOnly, noteId]
  );

  // --- Save ---
  // いまステータス行に出しているコード。同じ表示への書き直しや、保存の
  // 往復ごとの消える→出る（フェード）を避けるために覚えておく。
  const currentStatusRef = useRef<SaveStatusText>("");
  const updateSaveStatus = useCallback((status: SaveStatusText) => {
    const el = saveStatusRef.current;
    if (!el) return;
    const prev = currentStatusRef.current;
    currentStatusRef.current = status;
    // 同じ表示の書き直しはしない（「保存済み」のままの保存で点滅させない）。
    if (status === prev && el.textContent !== "") return;
    el.textContent =
      status === ""
        ? ""
        : t(SAVE_STATUS_MESSAGE[status], SAVE_STATUS_PARAMS[status]);
    el.style.transition = "opacity 300ms ease";
    if (status === "") {
      // Hidden state: drop out immediately, no fade.
      el.style.opacity = "0";
    } else if (status === "saved" && prev === "") {
      // First appearance of "saved": fade in gently. Swapping from another
      // visible state (saving… → saved) just replaces the text in place.
      el.style.opacity = "0";
      requestAnimationFrame(() => {
        if (saveStatusRef.current === el) el.style.opacity = "1";
      });
    } else {
      el.style.opacity = "1";
    }
  }, []);

  useEffect(() => {
    if (!noteId || readOnly) return;
    const client = new NoteSyncClient(`/api/notes/${noteId}/sync`, snapshot => {
      const prev = stateRef.current;
      if (JSON.stringify(prev.document.model) !== JSON.stringify(snapshot.model)) undoManagerRef.current.commitPendingText();
      const active = prev.view.activeNodeId;
      const sameActiveText = active && findNode(prev.document.model, active)?.text === findNode(snapshot.model, active)?.text;
      let next = editorReducer(prev, { type: "replace", state: { document: { ...prev.document, model: snapshot.model }, view: prev.view } });
      // An unrelated remote edit must not interrupt an IME composition.
      if (sameActiveText) next = { ...next, view: prev.view };
      stateRef.current = next;
      modelRef.current = next.document.model;
      setStateRaw(next);
      setIsPublic(snapshot.isPublic);
      setSyncReady(true);
      if (!client.isDirty()) {
        setSaveFailure(null);
        updateSaveStatus("saved");
      }
    }, (message, commit) => {
      setSyncError(message);
      if (commit) setSyncRecovery(previous => previous + JSON.stringify(commit) + "\n");
      setSaveFailure("other");
      updateSaveStatus("save-failed");
    });
    syncRef.current = client;
    const stop = client.connect();
    return () => { stop(); syncRef.current = null; };
  }, [noteId, readOnly, updateSaveStatus]);

  useEffect(() => registerWebMcp({
    readOnly,
    read: () => ({ noteId: noteId ?? null, model: stateRef.current.document.model, selectedNodeId: stateRef.current.view.activeNodeId, version: syncRef.current?.snapshot?.version ?? null, pending: syncRef.current?.isDirty() ?? false, ready: !noteId || readOnly || !!syncRef.current?.snapshot }),
    apply: async input => {
      if (readOnly) throw new Error("Read-only note");
      if (noteId && !syncRef.current?.snapshot) throw new Error("Waiting for initial sync");
      const next = prepareActions(stateRef.current, input);
      dispatch({ type: "replace", state: next }, "paste");
      if (syncRef.current) await syncRef.current.flush();
      else await lastCommitRef.current;
      return { model: stateRef.current.document.model, version: syncRef.current?.snapshot?.version ?? null };
    },
  }), [noteId, readOnly, dispatch]);

  // 共有リンクのコピー。エディタは canvas / outline の2ビューがあるので、
  // 「URLの組み立て → コピー → フィードバック」はここに一本化して両方から使う。
  const copyPublicLink = useCallback(() => {
    if (!noteId) return;
    void copyText(publicNoteUrl(window.location.origin, noteId)).then((ok) =>
      updateSaveStatus(ok ? "link-copied" : "link-copy-failed")
    );
  }, [noteId, updateSaveStatus]);

  const openPublicPage = useCallback(() => {
    if (!noteId) return;
    window.open(publicNoteUrl(window.location.origin, noteId), "_blank", "noopener");
  }, [noteId]);

  const saveNote = useCallback(
    async (currentModel: MindMapDocument, pub?: boolean): Promise<boolean> => {
      if (!noteId || readOnly) return true;
      const client = syncRef.current;
      if (!client?.snapshot) return false;
      try {
        // Document operations are queued by dispatch. Save only waits for
        // those operations; an old caller's model is never a replacement.
        if (pub !== undefined && pub !== client.snapshot.isPublic) {
          await client.commit(modelRef.current, modelRef.current, { before: client.snapshot.isPublic, after: pub });
        }
        await client.flush();
        setSaveFailure(null);
        updateSaveStatus("saved");
        return true;
      } catch {
        setSaveFailure("network");
        updateSaveStatus("save-failed");
        return false;
      }
    },
    [noteId, readOnly, updateSaveStatus]
  );

  // Are there edits not yet confirmed persisted? Only meaningful with a noteId
  // (guest/embed mode has no autosave and nothing to guard — the tracker has
  // no baseline there, so this is false).
  const isDirty = useCallback(
    () => syncRef.current?.isDirty() ?? false,
    []
  );

  // 手動の再試行: 自動再試行のタイマーを待たず、今の内容を保存し直す。
  // 失敗が auth（ログイン切れ）だと自動再試行は止まるので、ログインし直した
  // あとの復帰手段はこれだけ。
  const retrySave = useCallback(() => {
    if (!noteId || readOnly) return;
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    void saveNote(modelRef.current);
  }, [noteId, readOnly, saveNote]);

  // Debounced auto-save (with retry-on-failure).
  useEffect(() => {
    if (!noteId || readOnly) return;
    // Don't surface the "unsaved" state as visible text — it's visual noise.
    // A standing "saved" / "saving…" line stays put through the debounce so
    // the header doesn't blink on every edit (the autosave follows right
    // after, and the leave guard covers the gap). One-off notices (link
    // copied, upload done…) are cleared once the user goes back to editing.
    // A standing failure stays visible: the reason and the retry button must
    // not vanish just because the user kept typing.
    const shown = currentStatusRef.current;
    if (
      isDirty() &&
      !saveFailureRef.current &&
      shown !== "saved" &&
      shown !== "saving"
    )
      updateSaveStatus("");
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    let cancelled = false;
    // A failed autosave used to sit unsaved until the next edit or navigation.
    // Re-arm with exponential backoff (capped) so a transient failure recovers
    // on its own; stop once the save lands or the model changes (this effect
    // re-runs and resets the chain). A failure that can't heal by itself
    // (auth / rejected content) is not retried on a timer — it would only
    // pile up identical errors — the header offers a manual retry instead.
    const arm = (delay: number) => {
      saveTimerRef.current = setTimeout(async () => {
        const ok = await saveNote(modelRef.current);
        if (cancelled || ok || !isDirty()) return;
        const reason = saveFailureRef.current;
        if (reason && !isRetryableFailure(reason)) return;
        arm(nextRetryDelay(delay));
      }, delay);
    };
    arm(AUTOSAVE_DELAY_MS);
    return () => {
      cancelled = true;
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    };
  }, [model, noteId, readOnly, saveNote, isDirty, updateSaveStatus]);

  // --- Guard against leaving with unsaved edits ---
  // Tab close / reload / hard navigation: fire a best-effort keepalive save so
  // the last edit survives, and raise the browser's native confirm as a
  // backstop in case that request doesn't land.
  useEffect(() => {
    if (!noteId || readOnly) return;
    const handler = (e: BeforeUnloadEvent) => {
      if (!isDirty()) return;
      // Pending operation IDs survive reconnect within this editor. A full
      // document keepalive PUT would bypass merging and is deliberately gone.
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [noteId, readOnly, isDirty, isPublic]);

  // Client-side (Inertia) navigation — e.g. the "← 一覧" link or the browser
  // back button. When there are unsaved edits, hold the visit, flush the save,
  // then let it proceed; only interrupt the user with a dialog if that save
  // fails (otherwise navigation stays invisible, matching the autosave UX).
  useEffect(() => {
    if (!noteId || readOnly) return;
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
  }, [noteId, readOnly, isDirty, saveNote]);

  // --- Undo manager: commit pending text using the latest state ---
  useEffect(() => {
    undoManagerRef.current.setCommitCallback(() => stateRef.current.document);
  }, []);

  // Undo/redo restore only the document; the current selection/caret (view
  // state) is carried over as-is. The `replace` reducer reconciles it against
  // the restored document, so if the active node no longer exists there it
  // falls back to the first top-level node instead of dangling.
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
    () => {
      try { restoreDocument(syncRef.current ? undoManagerRef.current.collaborativeStep("undo") : undoManagerRef.current.undo()); }
      catch (error) { setSyncError((error as Error).message); }
    },
    [restoreDocument]
  );
  const redo = useCallback(
    () => {
      try { restoreDocument(syncRef.current ? undoManagerRef.current.collaborativeStep("redo") : undoManagerRef.current.redo()); }
      catch (error) { setSyncError((error as Error).message); }
    },
    [restoreDocument]
  );

  return {
    syncError,
    syncRecovery,
    state,
    stateRef,
    model,
    modelRef,
    dispatch,
    saveNote,
    updateSaveStatus,
    saveStatusRef,
    saveFailure,
    retrySave,
    copyPublicLink,
    openPublicPage,
    isDirty,
    isPublic,
    setIsPublic,
    undoManagerRef,
    undo,
    redo,
    noteId,
    readOnly: readOnly || !syncReady,
    leaveConfirm,
    setLeaveConfirm,
    bypassNavGuardRef,
  };
}
