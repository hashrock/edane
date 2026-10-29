import {
  useState,
  useRef,
  useMemo,
  useCallback,
  useEffect,
  useLayoutEffect,
} from "react";
import { safeExternalUrl } from "../lib/url";
import { Link, router } from "@inertiajs/react";
import { findNode } from "../domain/model";
import type { UndoType } from "../application/editorReducer";
import { pasteCommand } from "../application/editorCommands";
import { serializeDocument } from "../application/persistence";
import { outlineRows, verticalMoveInText } from "../application/outline";
import {
  rangeSegments,
  rangeTextOf,
  rangeToPlainText,
} from "../application/textRange";
import { supportsCheckbox } from "../application/nodeUtils";
import {
  buildKeymap,
  runKeymap,
  activeNode,
  type KeyBinding,
} from "../application/editorKeymap";
import { applyKeyEffects, type KeyEffectDeps } from "./applyKeyEffects";
import {
  handleAuxInputKeys,
  isAuxInputSurface,
  type EditorLayout,
} from "../application/editSurface";
import { DEFAULT_PREFERENCES } from "../application/editorPreferences";
import { DEFAULT_FONT_SIZE } from "../lib/measureText";
import ConfirmDialog from "./ConfirmDialog";
import PublicityDropdown from "./PublicityDropdown";
import ViewControls, { type PageModeToggle } from "./ViewControls";
import SaveStatus from "./SaveStatus";
import { TrashIcon } from "./icons";
import { leaveDialogMessage, type NoteEditorEngine } from "./useNoteEditor";
import { renderMarkdownHtml } from "../lib/markdownHtml";
import { useTextInputHandlers } from "./useTextInputHandlers";
import { t } from "../application/i18n";
import { useLocale } from "./useLocale";
import ServiceSwitcher from "./ServiceSwitcher";
import { pageMarkColor, type PageMarks } from "./pageMarks";
import { withAlpha } from "../application/accentColor";

interface Props {
  engine: NoteEditorEngine;
  /** Embedded (iframe) mode: hide the navigation header. */
  embed?: boolean;
  /** Guest mode: hand the current document off to be saved to an account. */
  onSaveToAccount?: (note: { title: string; content: string }) => void;
  /**
   * Current layout + switcher for the floating view controls. Provided by the
   * responsive {@link NoteEditor} wrapper; absent when used standalone, which
   * hides the switch.
   */
  layout?: EditorLayout;
  onLayoutChange?: (layout: EditorLayout) => void;
  /** Start the slideshow (header button). Absent = no presentation mode. */
  onPresent?: () => void;
  /** Webページモード toggle (header button). Absent = no web page mode. */
  pageMode?: PageModeToggle;
  /** Which page each node of a branch is on, shown on the rows for a moment (see NoteEditor). */
  pageMarks?: PageMarks;
}

// Background of the part of a row a cross-node selection covers.
const RANGE_HIGHLIGHT = "bg-sky-200/70";

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
  layout,
  onLayoutChange,
  onPresent,
  pageMode,
  pageMarks = null,
}: Props) {
  useLocale(); // 言語切り替えで再レンダー（t() の購読）
  const {
    state,
    stateRef,
    model,
    dispatch,
    saveNote,
    saveStatusRef,
    saveFailure,
    retrySave,
    copyPublicLink,
    openPublicPage,
    isPublic,
    setIsPublic,
    undo,
    redo,
    noteId,
    readOnly,
    leaveConfirm,
    setLeaveConfirm,
    bypassNavGuardRef,
  } = engine;

  const {
    view: { activeNodeId, editing, editingText, cursorPos, selectionEnd, textRange },
  } = state;

  const rows = useMemo(() => outlineRows(model), [model]);
  // The rows a cross-node selection covers, with the covered part of each
  // (the anchor row's part is the textarea's own selection).
  const rangeSegs = useMemo(
    () =>
      textRange
        ? rangeSegments(model, textRange, rangeTextOf(model, activeNodeId, editingText))
        : null,
    [model, textRange, activeNodeId, editingText]
  );
  const rangeLastId = rangeSegs ? [...rangeSegs.keys()].pop() : undefined;
  // The root is the note title (edited in the header); it is not an outline
  // row — the rows start at the top-level nodes. See outlineRows().
  const title = model.title;
  const activeNode_ = activeNodeId ? findNode(model, activeNodeId) : null;
  // Custom nodes (image / link) keep their rendered preview while editing and
  // expose the URL in an inline box below it, instead of swapping the whole row
  // for a raw-text field. Those use a dedicated inline editor, so the floating
  // caret overlay (which is for plain text rows) is suppressed for them.
  const activeType = activeNode_?.type ?? "text";
  const activeIsCustom = isAuxInputSurface("outline", activeType);
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
  // The mobile layout has no settings dialog, so it runs on the defaults;
  // "outline" keeps ↑/↓ walking the flat order drawn as one column (the
  // canvas moves between siblings instead).
  const keymap = useMemo<KeyBinding[]>(
    () => buildKeymap(DEFAULT_PREFERENCES, "outline", verticalMoveInText),
    []
  );
  const keyDeps = useMemo<KeyEffectDeps>(
    () => ({
      dispatch,
      saveNote: (m) => saveNote(m),
      // No command palette / help overlay on the mobile layout.
      openPalette: () => {},
      openHelp: () => {},
      present: onPresent,
      undo,
      redo,
    }),
    [dispatch, saveNote, undo, redo, onPresent]
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (isComposing) return;
      const st = stateRef.current;
      const outcome = runKeymap(keymap, {
        e,
        state: st,
        node: activeNode(st),
        pos: inputRef.current?.selectionStart || 0,
        selEnd: inputRef.current?.selectionEnd || 0,
        backward: inputRef.current?.selectionDirection === "backward",
      });
      if (outcome.result === "handled") e.preventDefault();
      applyKeyEffects(outcome.effects, st, keyDeps);
    },
    [isComposing, keymap, keyDeps, stateRef]
  );

  // Paste of multi-line (indented) text becomes fresh nodes; single-line text
  // is left to the native textarea.
  // A selection across nodes copies as indented lines (the textarea only
  // holds the anchor's part of it). Cutting / pasting over one is not
  // supported yet, so neither may act on the anchor's part alone.
  const handleCopy = useCallback(
    (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
      const st = stateRef.current;
      const range = st.view.textRange;
      if (!range) return; // native text copy
      e.preventDefault();
      const textOf = rangeTextOf(st.document.model, st.view.activeNodeId, st.view.editingText);
      e.clipboardData.setData("text/plain", rangeToPlainText(st.document.model, range, textOf));
    },
    [stateRef]
  );
  const handleCut = useCallback(
    (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
      if (stateRef.current.view.textRange) e.preventDefault();
    },
    [stateRef]
  );

  const handlePaste = useCallback(
    (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
      if (stateRef.current.view.textRange) {
        e.preventDefault();
        return;
      }
      const text = e.clipboardData.getData("text");
      if (!text || !text.includes("\n")) return;
      e.preventDefault();
      const st = stateRef.current;
      // Same effects as the canvas (application/editorCommands.ts): insert,
      // then leave edit mode so the next keystroke is its own undo entry.
      const effects = pasteCommand(st, { kind: "text", text });
      if (effects) applyKeyEffects(effects, st, keyDeps);
    },
    [keyDeps, stateRef]
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

  // 静的表示（readOnly）と編集ボタンの中身で共用するタイトル。
  const titleSpan = (
    <span className="truncate text-sm font-semibold tracking-tight">
      {title || t("untitled")}
    </span>
  );

  return (
    <div
      data-testid="outline-view"
      className="flex h-full flex-col bg-white text-slate-950"
    >
      <ConfirmDialog
        open={leaveConfirm !== null}
        variant="danger"
        title={t("saveFailedTitle")}
        message={leaveDialogMessage(saveFailure)}
        confirmLabel={t("leaveConfirm")}
        cancelLabel={t("leaveCancel")}
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
      {/* Same structure and order as the canvas header (usertest #5): a
          left cluster [× title ✎] that only takes the width it needs, and a
          right-aligned cluster [view controls][status][multi-root][publicity].
          The title is NOT a full-width click target, so a click aimed at the
          view controls from the other layout never opens title editing. */}
      <header className="anim-header flex h-12 shrink-0 items-center justify-between gap-3 border-b border-slate-200 bg-white px-3 md:px-6">
        <div className="flex min-w-0 items-center gap-2">
        {!embed && (
          <Link
            href="/notes"
            aria-label={t("backToList")}
            title={t("backToList")}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100 hover:text-slate-700"
          >
            <svg
              width="18"
              height="18"
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
        {readOnly ? (
          <div className="flex min-w-0 px-1">{titleSpan}</div>
        ) : editingTitle ? (
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
            className="h-8 min-w-0 rounded-lg border border-slate-300 bg-white px-2 text-sm font-semibold outline-none focus:border-emerald-500 focus:ring-2 focus:ring-emerald-100"
            placeholder={t("titlePlaceholder")}
          />
        ) : (
          <button
            onClick={() => setEditingTitle(true)}
            className="flex min-w-0 items-center gap-1.5 rounded-lg px-1 py-1 text-left hover:bg-slate-100"
            title={t("editTitle")}
          >
            {titleSpan}
            <span className="shrink-0 text-sm text-slate-400">✎</span>
          </button>
        )}
        </div>
        <div className="flex shrink-0 items-center gap-2 text-xs md:gap-3">
        {onLayoutChange && (
          <ViewControls
            layout={layout ?? "outline"}
            onLayoutChange={onLayoutChange}
            pageMode={pageMode}
          />
        )}
        {noteId && !readOnly && (
          <SaveStatus
            statusRef={saveStatusRef}
            failure={saveFailure}
            onRetry={retrySave}
          />
        )}
        {noteId && !readOnly && (
          <PublicityDropdown
            isPublic={isPublic}
            onChange={(next) => {
              setIsPublic(next);
              saveNote(model, next);
            }}
            onCopyLink={copyPublicLink}
            onOpenPublicPage={openPublicPage}
          />
        )}
        {!noteId && !readOnly && onSaveToAccount && (
          <button
            onClick={() =>
              onSaveToAccount({
                title: model.title,
                content: serializeDocument(model),
              })
            }
            className="shrink-0 whitespace-nowrap rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white"
          >
            {t("saveButton")}
          </button>
        )}
        {/* 埋め込み（iframe）では出さない。埋め込み先のページのメニューではないため */}
        {!embed && <ServiceSwitcher className="text-slate-500 hover:text-slate-700" />}
        </div>
      </header>

      {/* Outline body */}
      <div ref={scrollRef} className="relative flex-1 overflow-y-auto px-2 py-3">
        <ul>
            {rows.map((row) => {
              const { node, depth, hasChildren, collapsed } = row;
              const isActive = node.id === activeNodeId;
              const isEditingThis = isActive && editing;
              const type = node.type ?? "text";
              const linkUrl = type === "link" ? safeExternalUrl(node.text) : null;
              const isCustom = isAuxInputSurface("outline", type);
              // Image/link nodes keep their preview while editing and expose the
              // URL in an inline box below (instead of raw-text editing).
              const showUrlEditor = isEditingThis && isCustom;
              const isEmpty = node.text === "";
              // Task checkbox — the same flag the canvas draws beside a node.
              const isTask =
                node.checked !== undefined && supportsCheckbox(type);
              const isDone = node.checked === true;
              const displayText = isEditingThis ? editingText : node.text;
              // The anchor row's part shows as the textarea's own selection.
              const rangeSeg = isEditingThis ? undefined : rangeSegs?.get(node.id);
              // The slide this row went to, tinted in its colour for a moment
              // after its branch's split choice changes (see pageMarks).
              const mark = pageMarks?.get(node.id);
              const markColor = mark && pageMarkColor(mark);

              return (
                <li key={node.id}>
                  <div
                    className={`flex items-start gap-1.5 rounded-lg py-1 pr-1 transition-[background-color,box-shadow] duration-200 ${
                      isActive ? "bg-slate-100" : ""
                    }`}
                    style={{
                      paddingLeft: depth * INDENT,
                      ...(markColor && {
                        backgroundColor: withAlpha(markColor, 0.14),
                        boxShadow: `inset 3px 0 0 ${markColor}`,
                      }),
                    }}
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
                        hasChildren
                          ? collapsed
                            ? t("outlineExpand")
                            : t("outlineCollapse")
                          : t("outlineItem")
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

                    {/* Task checkbox. `tabIndex={-1}` deliberately: it is a
                        pointer affordance only, so the keyboard never lands in
                        it and the keyboard-escape invariant (see CLAUDE.md)
                        stays a question about text fields alone. The keyboard
                        route is ⌘/Ctrl+Shift+D. */}
                    {isTask && (
                      <button
                        type="button"
                        tabIndex={-1}
                        disabled={readOnly}
                        aria-label={
                          isDone ? t("outlineTaskOpen") : t("outlineTaskDone")
                        }
                        aria-pressed={isDone}
                        onClick={(e) => {
                          e.stopPropagation();
                          withSave("check", {
                            type: "setChecked",
                            nodeId: node.id,
                            checked: !isDone,
                          });
                        }}
                        className={`mt-1 flex h-4 w-4 shrink-0 items-center justify-center rounded border text-[10px] leading-none ${
                          isDone
                            ? "border-emerald-500 bg-emerald-500 text-white"
                            : "border-slate-400 bg-white text-transparent"
                        }`}
                      >
                        ✓
                      </button>
                    )}

                    {/* Content */}
                    {/* The row text wraps at the viewport, not at the canvas
                        node-box cap — an outline is a text column, so a long
                        item uses the full width. The overlaid textarea
                        measures THIS element (see the overlay effect), so the
                        edit width follows the display width. */}
                    <div
                      ref={isEditingThis ? activeRowRef : null}
                      onClick={() => activateRow(node.id)}
                      className="min-w-0 flex-1 cursor-text py-0.5"
                    >
                      {type === "markdown" && !isEditingThis && node.text.trim() !== "" ? (
                        // A markdown node shows its rendered document, as the
                        // canvas panel does — not the raw `##` / `**` source
                        // (usertest #7). Clicking still edits the source.
                        <div
                          data-testid="outline-md-preview"
                          className="md-body rounded-lg border border-violet-100 bg-violet-50/40 px-3 py-2 text-sm"
                          // Sanitized by renderMarkdownHtml (DOMPurify).
                          dangerouslySetInnerHTML={{ __html: renderMarkdownHtml(node.text) }}
                        />
                      ) : type === "image" ? (
                        node.text ? (
                          <img
                            src={node.text}
                            alt=""
                            className="max-h-48 max-w-full rounded-lg"
                          />
                        ) : (
                          <span className="block italic leading-6 text-slate-400">
                            {t("imageUrlUnset")}
                          </span>
                        )
                      ) : (
                        <span
                          className={`block whitespace-pre-wrap break-words leading-6 ${
                            // Text nodes hide their static text under the caret
                            // overlay while editing; custom nodes keep the preview.
                            isEditingThis && !isCustom ? "opacity-0" : ""
                          } ${
                            isDone
                              ? "text-slate-400 line-through"
                              : type === "link"
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
                              ? t("emptyItem")
                              : rangeSeg && type === "text"
                                ? <>
                                    {displayText.slice(0, rangeSeg[0])}
                                    <span data-testid="range-highlight" className={RANGE_HIGHLIGHT}>
                                      {displayText.slice(rangeSeg[0], rangeSeg[1])}
                                    </span>
                                    {displayText.slice(rangeSeg[1])}
                                  </>
                                : displayText}
                          {/* The range runs on past this row: mark its line
                              break, so empty rows and line ends show too. */}
                          {rangeSeg && node.id !== rangeLastId && (
                            <span className={`${RANGE_HIGHLIGHT} inline-block w-1.5`}>&#8203;</span>
                          )}
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
                            type === "image" ? t("imageUrlLabel") : t("linkUrlLabel")
                          }
                          className="mt-1.5 w-full rounded-lg border border-slate-300 bg-white px-2 py-1 text-sm text-slate-900 outline-none focus:border-emerald-500 focus:ring-2 focus:ring-emerald-100"
                        />
                      )}
                    </div>

                    {/* Open link */}
                    {linkUrl && !isEditingThis && (
                      <a
                        href={linkUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        onClick={(e) => e.stopPropagation()}
                        className="mt-0.5 shrink-0 rounded px-1.5 py-0.5 text-xs text-blue-600"
                      >
                        ↗
                      </a>
                    )}

                    {mark?.first && (
                      <span
                        data-testid="page-mark"
                        className="mt-1 shrink-0 rounded px-1 text-[11px] font-bold leading-4 text-white"
                        style={{ backgroundColor: markColor }}
                      >
                        {t("pageMarkLabel", { n: String(mark.page) })}
                      </span>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>

        {/* Single overlaid editor for the active row (keeps the keyboard open). */}
        {overlay && (
          <textarea
            ref={inputRef}
            defaultValue={editingText}
            rows={1}
            onChange={handleInputChange}
            onKeyDown={handleKeyDown}
            onSelect={handleSelect}
            onCopy={handleCopy}
            onCut={handleCut}
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
      {!readOnly && (
        <div className="flex shrink-0 items-stretch justify-around gap-1 border-t border-slate-200 bg-white px-1 py-1.5">
          {/* Each button carries a short visible caption under its glyph —
              the glyphs alone (⇤ ⇥ ↑ ↓) meant nothing to a first-time user
              (usertest #16). */}
          {(
            [
              { label: "⇤", caption: t("tbOutdent"), title: t("kmOutdent"), type: "tab" as const, shift: true },
              { label: "⇥", caption: t("tbIndent"), title: t("kmIndent"), type: "tab" as const, shift: false },
              { label: "↑", caption: t("tbMoveUp"), title: t("moveUpTitle"), type: "moveNodeUp" as const },
              { label: "↓", caption: t("tbMoveDown"), title: t("moveDownTitle"), type: "moveNodeDown" as const },
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
              className="flex flex-1 flex-col items-center rounded-lg py-1 text-slate-700 disabled:text-slate-300 enabled:hover:bg-slate-100 enabled:active:bg-slate-200"
            >
              <span className="text-lg leading-6">{b.label}</span>
              <span className="text-[10px] leading-3">{b.caption}</span>
            </button>
          ))}
          <button
            title={t("addItem")}
            disabled={!activeNodeId}
            onClick={() => withSave("insert-sibling", { type: "insertSiblingAfter" })}
            className="flex flex-1 flex-col items-center rounded-lg py-1 font-semibold text-emerald-700 disabled:text-slate-300 enabled:hover:bg-emerald-50 enabled:active:bg-emerald-100"
          >
            <span className="text-lg leading-6">＋</span>
            <span className="text-[10px] font-medium leading-3">{t("tbAdd")}</span>
          </button>
          <button
            title={t("deleteItem")}
            disabled={!bodyActive}
            onClick={() => {
              if (activeNodeId)
                withSave("delete", { type: "deleteNode", nodeId: activeNodeId });
            }}
            className="flex flex-1 flex-col items-center rounded-lg py-1 text-rose-600 disabled:text-slate-300 enabled:hover:bg-rose-50 enabled:active:bg-rose-100"
          >
            <span className="flex h-6 items-center"><TrashIcon width="18" height="18" /></span>
            <span className="text-[10px] leading-3">{t("tbDelete")}</span>
          </button>
        </div>
      )}
    </div>
  );
}
