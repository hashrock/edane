import {
  useState,
  useRef,
  useMemo,
  useCallback,
  useEffect,
  useLayoutEffect,
} from "react";
import { Link, router } from "@inertiajs/react";
import { findNode, cloneWithNewIds } from "../domain/model";
import type { UndoType } from "../application/editorReducer";
import { textToModel } from "../application/persistence";
import { outlineRows, verticalMoveInText } from "../application/outline";
import {
  buildKeymap,
  runKeymap,
  activeNode,
  type KeyBinding,
} from "../application/editorKeymap";
import { handleAuxInputKeys } from "../application/editSurface";
import { DEFAULT_FONT_SIZE } from "../lib/measureText";
import ConfirmDialog from "./ConfirmDialog";
import PublicityDropdown from "./PublicityDropdown";
import { TrashIcon } from "./icons";
import type { NoteEditorEngine } from "./useNoteEditor";
import { useTextInputHandlers } from "./useTextInputHandlers";

interface Props {
  engine: NoteEditorEngine;
  /** Embedded (iframe) mode: hide the navigation header. */
  embed?: boolean;
  /** Guest mode: hand the current document off to be saved to an account. */
  onSaveToAccount?: (note: { title: string; content: string }) => void;
}

// Indent per outline level (px). Kept modest so deep trees stay readable on a
// narrow screen.
const INDENT = 18;

/**
 * Mobile / narrow-viewport layout: a vertically-scrolling, indented outline —
 * an outline text editor rather than a mind map. It drives the exact same
 * editing engine (state, reducer, keymap, undo, autosave) as the Konva view via
 * the shared {@link useNoteEditor} hook, so switching layouts is lossless.
 *
 * Only the active row is editable at a time: a single, always-mounted textarea
 * is overlaid on the active row (measuring its box), which keeps the soft
 * keyboard open as the caret hops between nodes (Enter / arrows), the way the
 * canvas view keeps one hidden textarea focused.
 */
export default function OutlineEditor({
  engine,
  embed,
  onSaveToAccount,
}: Props) {
  const {
    state,
    stateRef,
    model,
    dispatch,
    saveNote,
    saveStatusRef,
    isPublic,
    setIsPublic,
    undo,
    redo,
    noteId,
    leaveConfirm,
    setLeaveConfirm,
    bypassNavGuardRef,
  } = engine;

  const {
    view: { activeNodeId, editing, editingText, cursorPos, selectionEnd },
  } = state;

  const rows = useMemo(() => outlineRows(model), [model]);
  const title = model.text;
  // The root is mirrored in the header title, but it is also a real outline row
  // (the first one) so the caret can rest on and edit it — see outlineRows().
  const activeNode_ = activeNodeId ? findNode(model, activeNodeId) : null;
  // Custom nodes (image / link) keep their rendered preview while editing and
  // expose the URL in an inline box below it, instead of swapping the whole row
  // for a raw-text field. Those use a dedicated inline editor, so the floating
  // caret overlay (which is for plain text rows) is suppressed for them.
  const activeType = activeNode_?.type ?? "text";
  const activeIsCustom = activeType === "image" || activeType === "link";
  const bodyActive = editing && !!activeNodeId && !activeIsCustom;

  // --- Shared text-input glue (input ref, IME state, typeText handlers) ---
  const {
    inputRef,
    isComposing,
    isComposingRef,
    handleInputChange,
    handleCompositionStart,
    handleCompositionEnd,
    handleSelect,
    handleUrlChange,
  } = useTextInputHandlers(engine);

  // --- Refs ---
  const scrollRef = useRef<HTMLDivElement>(null);
  const activeRowRef = useRef<HTMLDivElement>(null);
  const [editingTitle, setEditingTitle] = useState(false);
  const [overlay, setOverlay] = useState<{
    top: number;
    left: number;
    width: number;
  } | null>(null);

  // --- Keymap (shared with the canvas view) ---
  const keymap = useMemo<KeyBinding[]>(
    () =>
      buildKeymap({
        dispatch,
        saveNote: (m) => saveNote(m),
        // No command palette / help overlay on the mobile layout.
        openPalette: () => {},
        openHelp: () => {},
        undo,
        redo,
        verticalMove: verticalMoveInText,
      }),
    [dispatch, saveNote, undo, redo]
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (isComposing) return;
      const st = stateRef.current;
      runKeymap(keymap, {
        e,
        state: st,
        node: activeNode(st),
        pos: inputRef.current?.selectionStart || 0,
        selEnd: inputRef.current?.selectionEnd || 0,
      });
    },
    [isComposing, keymap, stateRef]
  );

  // Paste of multi-line (indented) text becomes fresh nodes; single-line text
  // is left to the native textarea.
  const handlePaste = useCallback(
    (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
      const text = e.clipboardData.getData("text");
      if (!text || !text.includes("\n")) return;
      e.preventDefault();
      const cur = stateRef.current;
      const targetId = cur.view.activeNodeId || cur.document.model.id;
      const fresh = textToModel("_", text).children.map(cloneWithNewIds);
      if (fresh.length === 0) return;
      const next = dispatch(
        { type: "insertNodes", targetId, nodes: fresh },
        "paste"
      );
      if (noteId) saveNote(next.document.model);
    },
    [dispatch, noteId, saveNote, stateRef]
  );

  // --- Row activation ---
  const focusSoon = useCallback(() => {
    setTimeout(() => inputRef.current?.focus(), 0);
  }, []);

  const activateRow = useCallback(
    (nodeId: string, caret: "end" | "start" = "end") => {
      const node = findNode(stateRef.current.document.model, nodeId);
      const len = node ? node.text.length : 0;
      const pos = caret === "end" ? len : 0;
      dispatch({
        type: "activateNode",
        nodeId,
        cursorPos: pos,
        selectionEnd: pos,
        editing: true,
      });
      focusSoon();
    },
    [dispatch, focusSoon, stateRef]
  );

  // --- Overlay geometry: place the single textarea over the active row ---
  useLayoutEffect(() => {
    const rowEl = activeRowRef.current;
    const scroller = scrollRef.current;
    if (!bodyActive || !rowEl || !scroller) {
      setOverlay(null);
      return;
    }
    const r = rowEl.getBoundingClientRect();
    const s = scroller.getBoundingClientRect();
    setOverlay({
      top: r.top - s.top + scroller.scrollTop,
      left: r.left - s.left + scroller.scrollLeft,
      width: r.width,
    });
  }, [bodyActive, activeNodeId, rows, editingText]);

  // --- Sync the textarea (value / caret / focus / auto-grow) ---
  useEffect(() => {
    const el = inputRef.current;
    if (!el || !bodyActive || isComposingRef.current) return;
    if (el.value !== editingText) el.value = editingText;
    el.setSelectionRange(cursorPos, selectionEnd);
    el.focus();
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [bodyActive, editingText, cursorPos, selectionEnd, activeNodeId, overlay]);

  // Keep the active row scrolled into view.
  useEffect(() => {
    if (!bodyActive) return;
    activeRowRef.current?.scrollIntoView({ block: "nearest" });
  }, [bodyActive, activeNodeId]);

  // --- Toolbar actions (structural edits available without a hardware kbd) ---
  const withSave = useCallback(
    (undoType: UndoType, action: Parameters<typeof dispatch>[0]) => {
      const prev = stateRef.current;
      const next = dispatch(action, undoType);
      if (noteId && next.document !== prev.document) saveNote(next.document.model);
      focusSoon();
    },
    [dispatch, focusSoon, noteId, saveNote, stateRef]
  );

  const activeStyle = activeNode_
    ? {
        fontSize: activeNode_.fontSize ?? DEFAULT_FONT_SIZE,
        fontWeight: activeNode_.bold ? 700 : 400,
      }
    : { fontSize: DEFAULT_FONT_SIZE, fontWeight: 400 };

  const rowFontStyle = (node: (typeof rows)[number]["node"]) => ({
    fontSize: node.fontSize ?? DEFAULT_FONT_SIZE,
    fontWeight: node.bold ? 700 : 400,
  });

  return (
    <div
      data-testid="outline-view"
      className="flex h-full flex-col bg-white text-slate-950"
    >
      <ConfirmDialog
        open={leaveConfirm !== null}
        variant="danger"
        title="保存に失敗しました"
        message="未保存の変更があります。このまま移動すると変更が失われる可能性があります。移動しますか？"
        confirmLabel="移動する"
        cancelLabel="とどまる"
        onConfirm={() => {
          const target = leaveConfirm;
          setLeaveConfirm(null);
          if (!target) return;
          bypassNavGuardRef.current = true;
          router.visit(target.url, { method: target.method });
        }}
        onCancel={() => setLeaveConfirm(null)}
      />

      {/* Header */}
      <header className="anim-header flex h-14 shrink-0 items-center gap-2 border-b border-slate-200 bg-white px-3">
        {!embed && (
          <Link
            href="/notes"
            aria-label="一覧へ戻る"
            title="一覧へ戻る"
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100 hover:text-slate-700"
          >
            <svg
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </Link>
        )}
        {editingTitle ? (
          <input
            type="text"
            autoFocus
            value={title}
            onChange={(e) => dispatch({ type: "setTitle", text: e.target.value })}
            onBlur={() => {
              setEditingTitle(false);
              if (noteId) saveNote(model);
            }}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing) return;
              if (e.key === "Enter" || e.key === "Escape") e.currentTarget.blur();
            }}
            className="h-9 min-w-0 flex-1 rounded-lg border border-slate-300 bg-white px-2 text-base font-bold outline-none focus:border-emerald-500 focus:ring-2 focus:ring-emerald-100"
            placeholder="タイトル"
          />
        ) : (
          <button
            onClick={() => setEditingTitle(true)}
            className="flex min-w-0 flex-1 items-center gap-1.5 rounded-lg px-1 py-1 text-left hover:bg-slate-100"
          >
            <span className="truncate text-base font-bold tracking-tight">
              {title || "無題"}
            </span>
            <span className="shrink-0 text-slate-400">✎</span>
          </button>
        )}
        {noteId && (
          <span
            ref={saveStatusRef}
            className="shrink-0 whitespace-nowrap text-xs text-slate-500"
          />
        )}
        {noteId && (
          <PublicityDropdown
            isPublic={isPublic}
            onChange={(next) => {
              setIsPublic(next);
              saveNote(model, next);
            }}
          />
        )}
        {!noteId && onSaveToAccount && (
          <button
            onClick={() =>
              onSaveToAccount({
                title: model.text,
                content: JSON.stringify(model),
              })
            }
            className="shrink-0 whitespace-nowrap rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white"
          >
            保存
          </button>
        )}
      </header>

      {/* Outline body */}
      <div ref={scrollRef} className="relative flex-1 overflow-y-auto px-2 py-3">
        <ul>
            {rows.map((row) => {
              const { node, depth, hasChildren, collapsed } = row;
              const isActive = node.id === activeNodeId;
              const isEditingThis = isActive && editing;
              const type = node.type ?? "text";
              const isCustom = type === "image" || type === "link";
              // Image/link nodes keep their preview while editing and expose the
              // URL in an inline box below (instead of raw-text editing).
              const showUrlEditor = isEditingThis && isCustom;
              const isEmpty = node.text === "";
              const displayText = isEditingThis ? editingText : node.text;

              return (
                <li key={node.id}>
                  <div
                    className={`flex items-start gap-1.5 rounded-lg py-1 pr-1 ${
                      isActive ? "bg-slate-100" : ""
                    }`}
                    style={{ paddingLeft: depth * INDENT }}
                  >
                    {/* Bullet / disclosure */}
                    <button
                      onClick={() => {
                        if (hasChildren) {
                          withSave("collapse", {
                            type: "toggleCollapse",
                            nodeId: node.id,
                          });
                        } else {
                          activateRow(node.id);
                        }
                      }}
                      className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center ${
                        isActive ? "text-slate-900" : "text-slate-400"
                      }`}
                      aria-label={
                        hasChildren ? (collapsed ? "展開" : "折りたたむ") : "項目"
                      }
                    >
                      {hasChildren ? (
                        <span
                          className={`text-[10px] transition-transform ${
                            collapsed ? "" : "rotate-90"
                          }`}
                        >
                          ▶
                        </span>
                      ) : (
                        <span className="text-[8px]">●</span>
                      )}
                    </button>

                    {/* Content */}
                    <div
                      ref={isEditingThis ? activeRowRef : null}
                      onClick={() => activateRow(node.id)}
                      className="min-w-0 flex-1 cursor-text py-0.5"
                    >
                      {type === "image" ? (
                        node.text ? (
                          <img
                            src={node.text}
                            alt=""
                            className="max-h-48 max-w-full rounded-lg"
                          />
                        ) : (
                          <span className="block italic leading-6 text-slate-400">
                            画像URL未設定
                          </span>
                        )
                      ) : (
                        <span
                          className={`block whitespace-pre-wrap break-words leading-6 ${
                            // Text nodes hide their static text under the caret
                            // overlay while editing; custom nodes keep the preview.
                            isEditingThis && !isCustom ? "opacity-0" : ""
                          } ${
                            type === "link"
                              ? "text-blue-600 underline"
                              : isEmpty
                                ? "italic text-slate-400"
                                : "text-slate-900"
                          }`}
                          style={rowFontStyle(node)}
                        >
                          {type === "link"
                            ? node.linkTitle || node.text || "empty"
                            : isEmpty
                              ? "空の項目"
                              : displayText}
                        </span>
                      )}
                      {collapsed && hasChildren && (
                        <span className="ml-1 align-middle text-[10px] text-slate-400">
                          ({node.children.length})
                        </span>
                      )}

                      {/* Inline URL editor for image / link nodes. */}
                      {showUrlEditor && (
                        <input
                          type="text"
                          autoFocus
                          inputMode="url"
                          value={editingText}
                          onClick={(e) => e.stopPropagation()}
                          onChange={handleUrlChange}
                          onKeyDown={(e) => handleAuxInputKeys(e, dispatch)}
                          placeholder={
                            type === "image" ? "画像のURL" : "リンクのURL"
                          }
                          className="mt-1.5 w-full rounded-lg border border-slate-300 bg-white px-2 py-1 text-sm text-slate-900 outline-none focus:border-emerald-500 focus:ring-2 focus:ring-emerald-100"
                        />
                      )}
                    </div>

                    {/* Open link */}
                    {type === "link" && node.text && !isEditingThis && (
                      <a
                        href={node.text}
                        target="_blank"
                        rel="noopener noreferrer"
                        onClick={(e) => e.stopPropagation()}
                        className="mt-0.5 shrink-0 rounded px-1.5 py-0.5 text-xs text-blue-600"
                      >
                        ↗
                      </a>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        {model.children.length === 0 && (
          <button
            onClick={() => withSave("add-child", { type: "addChild", nodeId: model.id })}
            className="mx-auto mt-4 block rounded-xl border border-dashed border-slate-300 px-4 py-3 text-sm text-slate-500 hover:bg-slate-50"
          >
            ＋ 最初の項目を追加
          </button>
        )}

        {/* Single overlaid editor for the active row (keeps the keyboard open). */}
        {overlay && (
          <textarea
            ref={inputRef}
            defaultValue={editingText}
            rows={1}
            onChange={handleInputChange}
            onKeyDown={handleKeyDown}
            onSelect={handleSelect}
            onPaste={handlePaste}
            onCompositionStart={handleCompositionStart}
            onCompositionEnd={handleCompositionEnd}
            className="absolute resize-none overflow-hidden border-0 bg-transparent py-0.5 leading-6 text-slate-900 outline-none"
            style={{
              top: overlay.top,
              left: overlay.left,
              width: overlay.width,
              ...activeStyle,
            }}
          />
        )}
      </div>

      {/* Bottom action bar: structural edits for touch (no hardware keyboard). */}
      <div className="flex shrink-0 items-stretch justify-around gap-1 border-t border-slate-200 bg-white px-1 py-1.5">
        {(
          [
            { label: "⇤", title: "アウトデント", type: "tab" as const, shift: true },
            { label: "⇥", title: "インデント", type: "tab" as const, shift: false },
            { label: "↑", title: "上へ移動", type: "moveNodeUp" as const },
            { label: "↓", title: "下へ移動", type: "moveNodeDown" as const },
          ]
        ).map((b) => (
          <button
            key={b.title}
            title={b.title}
            disabled={!bodyActive}
            onClick={() =>
              withSave(
                b.type === "tab" ? "indent" : "reorder",
                b.type === "tab"
                  ? { type: "tab", shift: b.shift }
                  : { type: b.type }
              )
            }
            className="flex-1 rounded-lg py-2 text-lg text-slate-700 disabled:text-slate-300 enabled:hover:bg-slate-100 enabled:active:bg-slate-200"
          >
            {b.label}
          </button>
        ))}
        <button
          title="項目を追加"
          disabled={!activeNodeId}
          onClick={() => withSave("insert-sibling", { type: "insertSiblingAfter" })}
          className="flex-1 rounded-lg py-2 text-lg font-semibold text-emerald-700 disabled:text-slate-300 enabled:hover:bg-emerald-50 enabled:active:bg-emerald-100"
        >
          ＋
        </button>
        <button
          title="項目を削除"
          disabled={!bodyActive}
          onClick={() => {
            if (activeNodeId)
              withSave("delete", { type: "deleteNode", nodeId: activeNodeId });
          }}
          className="flex flex-1 items-center justify-center rounded-lg py-2 text-rose-600 disabled:text-slate-300 enabled:hover:bg-rose-50 enabled:active:bg-rose-100"
        >
          <TrashIcon width="20" height="20" />
        </button>
      </div>
    </div>
  );
}
