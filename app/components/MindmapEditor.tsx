import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { Link, router } from "@inertiajs/react";
import type { MindMapNode } from "../application/nodeUtils";
import type { MindMapModel } from "../domain/model";
import { findNode, cloneWithNewIds, generateId } from "../domain/model";
import { looksLikeMarkdown, markdownToModel } from "../application/markdown";
import { useNoteEditor, type NoteEditorEngine } from "./useNoteEditor";
import { layoutMindMap } from "../lib/treeLayout";
import {
  LINE_HEIGHT,
  lineHeightFor,
  nodeFontString,
  DEFAULT_FONT_SIZE,
  NODE_FONT,
} from "../lib/measureText";
import { subscribeImages, imageDisplaySize, getImageEntry } from "../lib/imageCache";
import {
  flattenToNodes,
  FAVICON_SIZE,
  FAVICON_GAP,
  NODE_PADDING,
  nodeBoxWidth,
  nodeBoxHeight,
  markdownPreview,
} from "../application/nodeUtils";
import { resolveDropTarget, type DropTarget } from "../application/dragDrop";
import {
  nodeRect,
  rectCenter,
  worldViewport,
  centerOffset,
  ensureVisibleOffset,
} from "../lib/viewport";
import ContextMenu, {
  type ContextMenuAction,
  type ContextMenuItem,
} from "./ContextMenu";
import PublicityDropdown from "./PublicityDropdown";
import {
  serializeModel,
  modelToText,
  textToModel,
} from "../application/persistence";
import CommandPalette from "./CommandPalette";
import type { Command } from "./CommandPalette";
import ShortcutHelp from "./ShortcutHelp";
import ConfirmDialog from "./ConfirmDialog";
import MarkdownPasteDialog from "./MarkdownPasteDialog";
import type { EditorState } from "../application/editorReducer";
import {
  buildKeymap,
  runKeymap,
  activeNode,
  type KeyBinding,
} from "../application/editorKeymap";

// --- Text measurement (cached) ---
// The canvas redraw needs each node's width and per-character cursor offsets.
// Measuring via Konva.Text objects is very expensive (one object per character,
// for every node, on every redraw). Instead we measure with a single shared 2D
// context and cache offsets per text string — only the actively edited node's
// text changes per keystroke, so every other node is an O(1) cache hit.
const NODE_FONT_ITALIC = `italic ${NODE_FONT}`;
let _measureCtx: CanvasRenderingContext2D | null | undefined;
const _offsetCache = new Map<string, number[]>();
let _emptyWidth = -1;

function getMeasureCtx(): CanvasRenderingContext2D | null {
  if (_measureCtx === undefined) {
    _measureCtx = document.createElement("canvas").getContext("2d");
    if (_measureCtx) _measureCtx.font = NODE_FONT;
  }
  return _measureCtx;
}

/**
 * Cumulative prefix widths for `text`: [0, w(c0), w(c0c1), …, fullWidth].
 * Measured with `font` (defaults to the 14px node font) so the caret offsets
 * line up with a node's own font size / weight.
 */
function measureOffsets(text: string, font: string = NODE_FONT): number[] {
  const key = font === NODE_FONT ? text : `${font}|${text}`;
  const cached = _offsetCache.get(key);
  if (cached) return cached;
  const ctx = getMeasureCtx();
  const offsets: number[] = [0];
  if (ctx) {
    if (font !== NODE_FONT) ctx.font = font;
    for (let i = 0; i < text.length; i++) {
      offsets.push(ctx.measureText(text.slice(0, i + 1)).width);
    }
    if (font !== NODE_FONT) ctx.font = NODE_FONT;
  } else {
    for (let i = 0; i < text.length; i++) offsets.push((i + 1) * 8);
  }
  if (_offsetCache.size > 4000) _offsetCache.clear();
  _offsetCache.set(key, offsets);
  return offsets;
}

/** Width of the italic "empty" placeholder (measured once). */
function measureEmptyWidth(): number {
  if (_emptyWidth >= 0) return _emptyWidth;
  const ctx = getMeasureCtx();
  if (ctx) {
    ctx.font = NODE_FONT_ITALIC;
    _emptyWidth = ctx.measureText("empty").width;
    ctx.font = NODE_FONT;
  } else {
    _emptyWidth = 40;
  }
  return _emptyWidth;
}

// --- Multi-line geometry ---

// Screen-space distance (px) the pointer must travel after mousedown before a
// press turns into a drag-select. Below this a small jitter stays a plain click
// so selection doesn't jump to a neighbouring (e.g. same-Y parent) node.
const DRAG_THRESHOLD = 4;

/**
 * In-flight pointer drag. Two kinds share the click-vs-drag threshold logic:
 * - "text": drag inside the node being edited extends a text selection.
 * - "move": drag on any other (non-root) node picks the branch up and moves it
 *   to a new parent / sibling slot on release.
 * Both start at mousedown and only become "real" once the pointer travels past
 * DRAG_THRESHOLD (`moved`); below that the press stays a plain click.
 */
type DragState =
  | {
      mode: "text";
      nodeId: string;
      anchorCharIdx: number;
      // Screen-space pointer position at mousedown, used to distinguish a
      // click (with minor jitter) from an intentional drag-select.
      startX: number;
      startY: number;
      // Flips true once the pointer moves past DRAG_THRESHOLD; from then on
      // every move is treated as a drag even if it dips back under.
      moved: boolean;
    }
  | {
      mode: "move";
      nodeId: string;
      startX: number;
      startY: number;
      moved: boolean;
      // Pointer offset from the node's box origin at mousedown (world), so
      // the ghost stays under the grab point instead of snapping to it.
      grabDX: number;
      grabDY: number;
      // Built lazily when the drag becomes real (moved = true):
      /** Dragged node + its visible descendants — never valid drop targets. */
      excluded: Set<string> | null;
      /** child id → parent id over the current flat node array. */
      parentOf: Map<string, string> | null;
      /** Total descendant count (incl. hidden), for the ghost's "+N" badge. */
      descendants: number;
      /** Current drop resolution (null = would not drop anywhere). */
      drop: DropTarget | null;
    };

interface LineData {
  lines: string[];
  /** Per-line cumulative char x-offsets (from measureOffsets). */
  lineOffsets: number[][];
  /** Absolute start index of each line in the full string. */
  lineStarts: number[];
  /** Line box height in px for this node's font size. */
  lineHeight: number;
}

/**
 * Split node text into lines and pre-measure each line's caret offsets, using
 * the node's own `fontSize` / `bold` so offsets and line height match the
 * rendered text (including the actively edited node).
 */
function buildLineData(
  text: string,
  fontSize: number = DEFAULT_FONT_SIZE,
  bold: boolean = false
): LineData {
  const font = nodeFontString(fontSize, bold);
  const lines = text.split("\n");
  const lineOffsets = lines.map((l) => measureOffsets(l, font));
  const lineStarts: number[] = [];
  let acc = 0;
  for (let i = 0; i < lines.length; i++) {
    lineStarts[i] = acc;
    acc += lines[i].length + 1; // +1 for the consumed "\n"
  }
  return { lines, lineOffsets, lineStarts, lineHeight: lineHeightFor(fontSize) };
}

/** Absolute string offset → { line, column-within-line }. */
function posToLineCol(
  data: LineData,
  pos: number
): { line: number; col: number } {
  const { lines, lineStarts } = data;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (pos >= lineStarts[i]) {
      return { line: i, col: Math.min(pos - lineStarts[i], lines[i].length) };
    }
  }
  return { line: 0, col: 0 };
}

/** { line, column } → absolute string offset (clamped to the line's length). */
function lineColToPos(data: LineData, line: number, col: number): number {
  const l = Math.max(0, Math.min(line, data.lines.length - 1));
  return data.lineStarts[l] + Math.min(col, data.lines[l].length);
}

/** Widest line's measured width (px). */
function lineDataWidth(data: LineData): number {
  let w = 0;
  for (const offs of data.lineOffsets) w = Math.max(w, offs[offs.length - 1] || 0);
  return w;
}

/** Number of descendants (incl. hidden ones) of a node in the model. */
function countDescendants(model: MindMapModel, nodeId: string): number {
  const node = findNode(model, nodeId);
  if (!node) return 0;
  let count = -1;
  (function walk(n: MindMapModel) {
    count++;
    for (const child of n.children) walk(child);
  })(node);
  return count;
}

/** Find the caret column nearest `relX` within a line's offsets. */
function nearestCol(offsets: number[] | undefined, relX: number): number {
  if (!offsets) return 0;
  let col = 0;
  let best = Math.abs(relX);
  for (let i = 1; i < offsets.length; i++) {
    const d = Math.abs(relX - offsets[i]);
    if (d < best) {
      best = d;
      col = i;
    }
  }
  return col;
}

/** Vertical caret move within a node; returns new pos or null if no such line. */
function verticalMove(text: string, pos: number, dir: -1 | 1): number | null {
  const data = buildLineData(text);
  const { line, col } = posToLineCol(data, pos);
  const target = line + dir;
  if (target < 0 || target >= data.lines.length) return null;
  return lineColToPos(data, target, col);
}

/** Imperative hooks exposed on `window` in non-production builds for e2e tests. */
export interface RedrawStats {
  redrawCount: number;
  redrawTotalMs: number;
  redrawLastMs: number;
  redrawDrawMs: number;
}

export interface MindmapTestApi {
  getModel: () => MindMapModel;
  getActiveNodeId: () => string | null;
  /** Current selection state (focused node + caret + edit mode). */
  getSelection: () => {
    activeNodeId: string | null;
    cursorPos: number;
    selectionEnd: number;
    editing: boolean;
  };
  getNodeClickPoint: (id: string) => { x: number; y: number } | null;
  /** Screen-space box of a node (x/y = top-left), for drag & drop zone tests. */
  getNodeRect: (
    id: string
  ) => { x: number; y: number; width: number; height: number } | null;
  /** Main-canvas-redraw timing counters (the dominant per-keystroke cost). */
  getRedrawStats: () => RedrawStats;
  resetRedrawStats: () => void;
}

declare global {
  interface Window {
    __mindmapTest?: MindmapTestApi;
  }
}

interface Props {
  noteId?: string;
  initialContent?: string;
  initialTitle?: string;
  initialIsPublic?: boolean;
  /** Embedded (iframe) mode: hide the navigation header. */
  embed?: boolean;
  /**
   * Guest mode "save to account" action. When provided (and there is no
   * noteId), the header shows a save button that hands the current document
   * off to the page, which carries it through login into a real note.
   */
  onSaveToAccount?: (note: { title: string; content: string }) => void;
}

interface ViewProps {
  engine: NoteEditorEngine;
  /** Embedded (iframe) mode: hide the navigation header. */
  embed?: boolean;
  onSaveToAccount?: (note: { title: string; content: string }) => void;
}

/**
 * The Konva mind-map view. Rendering + pointer interaction only; all editing
 * state, dispatch, undo and persistence come from the shared {@link useNoteEditor}
 * engine so this view and the mobile outline view stay perfectly in sync.
 */
export function MindmapEditorView({
  engine,
  embed,
  onSaveToAccount,
}: ViewProps) {
  const {
    state,
    stateRef,
    model,
    modelRef,
    dispatch,
    saveNote,
    updateSaveStatus,
    saveStatusRef,
    undoManagerRef,
    undo,
    redo,
    isPublic,
    setIsPublic,
    noteId,
    leaveConfirm,
    setLeaveConfirm,
    bypassNavGuardRef,
  } = engine;

  // Derived views of the editor state (keeps downstream code/deps unchanged)
  const {
    view: { activeNodeId, editing, editingText, cursorPos, selectionEnd },
  } = state;

  // Custom nodes (image / link) keep their rendered preview while editing and
  // expose the URL in a visible input below the node — mirroring the outline
  // view — instead of swapping the canvas node to raw-text editing.
  const activeModelNode = activeNodeId ? findNode(model, activeNodeId) : null;
  const activeIsCustom =
    activeModelNode?.type === "image" || activeModelNode?.type === "link";
  const urlEditing = editing && !!activeNodeId && activeIsCustom;

  // --- UI-only state (not part of the editing document) ---
  const [cmdPaletteOpen, setCmdPaletteOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [editingTitle, setEditingTitle] = useState(false);
  const [isComposing, setIsComposing] = useState(false);
  const [cursorVisible, setCursorVisible] = useState(true);
  const [konvaReady, setKonvaReady] = useState(false);
  // Bumped whenever the stage is panned or zoomed so the (viewport-culled)
  // redraw effect re-runs and refills the newly-visible area. See the redraw
  // effect below — only nodes intersecting the visible viewport are built.
  const [viewportTick, setViewportTick] = useState(0);
  // Transient highlight of just-inserted nodes (paste / child add) so the
  // insertion position is obvious. Cleared after a short delay.
  const [highlightIds, setHighlightIds] = useState<Set<string>>(new Set());
  const [inputPos, setInputPos] = useState<{ x: number; y: number }>({
    x: 0,
    y: 0,
  });
  // Screen-space slot of the visible URL box shown under an image/link node
  // while it is being edited (null = hidden).
  const [urlBoxPos, setUrlBoxPos] = useState<{
    x: number;
    y: number;
    width: number;
  } | null>(null);
  // Right-click context menu over a node (null = closed).
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    nodeId: string;
  } | null>(null);
  // Pending Markdown paste awaiting a strategy choice (null = dialog closed).
  const [mdPaste, setMdPaste] = useState<{
    text: string;
    targetId: string;
  } | null>(null);
  // Refs
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const urlInputRef = useRef<HTMLInputElement>(null);
  const imageFileInputRef = useRef<HTMLInputElement>(null);
  const uploadTargetRef = useRef<string | null>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const konvaStageRef = useRef<any>(null);
  const layerRef = useRef<any>(null);
  const cursorLayerRef = useRef<any>(null);
  const flashLayerRef = useRef<any>(null);
  const konvaRef = useRef<any>(null);
  const updateGridRef = useRef<() => void>(() => {});
  const lineDataRef = useRef<Map<string, LineData>>(new Map());
  const dragStateRef = useRef<DragState | null>(null);
  const dragLayerRef = useRef<any>(null);
  const wasDraggingRef = useRef(false);
  const highlightTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isComposingRef = useRef(false);
  // True once the view has been centred for the current note (see the
  // centre-on-open logic in the Konva setup). Reset when the note changes.
  const didCenterRef = useRef(false);
  // Non-production perf counters for the (expensive) main canvas redraw.
  const perfRef = useRef({
    redrawCount: 0,
    redrawTotalMs: 0,
    redrawLastMs: 0,
    redrawDrawMs: 0,
  });
  // Briefly highlight a set of nodes (used to show where a paste/insert landed).
  const flashNodes = useCallback((ids: string[]) => {
    if (ids.length === 0) return;
    setHighlightIds(new Set(ids));
    if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current);
    highlightTimerRef.current = setTimeout(
      () => setHighlightIds(new Set()),
      1600
    );
  }, []);

  // Commit a drag & drop branch move. Called from the Konva mouseup handler
  // via a ref — the stage setup effect runs once, so capturing saveNote (which
  // is re-created when isPublic changes) directly would go stale.
  const commitMove = useCallback(
    (nodeId: string, drop: DropTarget) => {
      const prevModel = stateRef.current.document.model;
      const next = dispatch(
        {
          type: "moveBranch",
          nodeId,
          newParentId: drop.parentId,
          index: drop.kind === "sibling" ? drop.index : undefined,
        },
        "move-branch"
      );
      if (next.document.model === prevModel) return;
      flashNodes([nodeId]);
      if (noteId) saveNote(next.document.model);
    },
    [dispatch, flashNodes, noteId, saveNote]
  );
  const commitMoveRef = useRef(commitMove);
  commitMoveRef.current = commitMove;

  // Re-render when an image-node's image finishes loading (size becomes known).
  const [imageVersion, setImageVersion] = useState(0);
  useEffect(
    () => subscribeImages(() => setImageVersion((v) => v + 1)),
    []
  );

  // Derived: flat nodes with layout. Only while a caret is active on a TEXT
  // node is it sized from the live buffer. Image/link nodes keep their real
  // preview size even while editing — their URL is edited in the visible box
  // below the node, so the canvas box must keep matching the drawn preview.
  const nodes = useMemo(() => {
    const flat = flattenToNodes(
      model,
      editing && activeNodeId && !activeIsCustom
        ? { id: activeNodeId, text: editingText }
        : undefined
    );
    if (flat.length > 0) layoutMindMap(flat);
    return flat;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model, editing, activeNodeId, activeIsCustom, editingText, imageVersion]);
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;

  // Title = root node text
  const title = model.text;

  // --- Cursor blink ---
  useEffect(() => {
    if (!activeNodeId) return;
    setCursorVisible(true);
    const interval = setInterval(() => setCursorVisible((v) => !v), 530);
    return () => clearInterval(interval);
  }, [activeNodeId, cursorPos, editingText]);

  // --- Sync the hidden input to the editor state (single place) ---
  // Replaces the scattered value/setSelectionRange/focus calls. While a custom
  // node's URL box is open, the box owns the keyboard — never steal focus back.
  useEffect(() => {
    const el = inputRef.current;
    if (!el || isComposingRef.current) return;
    if (el.value !== editingText) el.value = editingText;
    el.setSelectionRange(cursorPos, selectionEnd);
    if (activeNodeId && !urlEditing) el.focus();
  }, [editingText, cursorPos, selectionEnd, activeNodeId, urlEditing]);

  // Hand the keyboard to the right editor when URL editing starts/stops: the
  // visible URL box while open, the hidden textarea (keymap host) otherwise —
  // e.g. after Enter/Escape closes the box, arrow navigation must stay live.
  useEffect(() => {
    if (urlEditing) urlInputRef.current?.focus();
    else if (activeNodeId) inputRef.current?.focus();
  }, [urlEditing, activeNodeId]);

  // --- Input handling ---
  const handleInputChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const el = e.target;
      const newText = el.value;
      const pos = el.selectionStart ?? 0;
      const end = el.selectionEnd ?? 0;
      // Snapshot the pre-typing state once per debounce batch
      undoManagerRef.current.handleTextChange(stateRef.current.document);
      dispatch({
        type: "typeText",
        text: newText,
        cursorPos: pos,
        selectionEnd: end,
        // Don't commit to the model mid-IME-composition
        commitModel: !isComposingRef.current,
      });
    },
    [dispatch]
  );

  const handleCompositionEnd = useCallback(() => {
    setIsComposing(false);
    isComposingRef.current = false;
    const el = inputRef.current;
    if (!el || !stateRef.current.view.activeNodeId) return;
    const finalText = el.value;
    const pos = el.selectionStart ?? finalText.length;
    const end = el.selectionEnd ?? pos;
    undoManagerRef.current.handleTextChange(stateRef.current.document);
    dispatch({
      type: "typeText",
      text: finalText,
      cursorPos: pos,
      selectionEnd: end,
      commitModel: true,
    });
  }, [dispatch]);

  const handleSelect = useCallback(() => {
    const el = inputRef.current;
    if (!el) return;
    dispatch({
      type: "setSelection",
      cursorPos: el.selectionStart || 0,
      selectionEnd: el.selectionEnd || 0,
    });
  }, [dispatch]);

  // Visible URL box (image / link nodes): edits the node's `text` (its URL)
  // while the canvas keeps drawing the preview. Persists on change so the
  // preview and any saved copy stay in sync (same behaviour as the outline
  // view's inline URL editor).
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
    [dispatch, noteId, saveNote]
  );

  // Refocus the editor after a click/menu/palette interaction, picking the
  // right keyboard host: the visible URL box while an image/link node is being
  // edited, the hidden textarea (keymap host) otherwise. Deferred a macrotask
  // so it survives the interaction's own default focus handling.
  const focusEditorSoon = useCallback(() => {
    setTimeout(() => {
      const v = stateRef.current.view;
      const t = v.activeNodeId
        ? findNode(modelRef.current, v.activeNodeId)?.type
        : undefined;
      if (v.editing && (t === "image" || t === "link")) {
        urlInputRef.current?.focus();
      } else {
        inputRef.current?.focus();
      }
    }, 0);
  }, []);

  // --- Image upload: push a file to R2 and turn the node into an image ---
  const uploadAndSetImage = useCallback(
    async (nodeId: string, file: File) => {
      if (!file.type.startsWith("image/")) return;
      updateSaveStatus("画像アップロード中...");
      try {
        const form = new FormData();
        form.append("file", file);
        const res = await fetch("/api/images", {
          method: "POST",
          credentials: "include",
          body: form,
        });
        if (!res.ok) {
          const err = (await res.json().catch(() => ({}))) as {
            error?: string;
          };
          updateSaveStatus(
            err?.error === "Storage limit exceeded"
              ? "容量超過（上限10MB）"
              : "アップロード失敗"
          );
          return;
        }
        const data = (await res.json()) as { url: string };
        const next = dispatch(
          {
            type: "setNodeContent",
            nodeId,
            text: data.url,
            nodeType: "image",
          },
          "image-upload"
        );
        if (noteId) saveNote(next.document.model);
        else updateSaveStatus("");
      } catch {
        updateSaveStatus("アップロード失敗");
      }
    },
    [dispatch, noteId, saveNote, updateSaveStatus]
  );

  const triggerImageUpload = useCallback((nodeId: string) => {
    uploadTargetRef.current = nodeId;
    imageFileInputRef.current?.click();
  }, []);

  // --- Clipboard ---
  // Insert indented plain text as fresh nodes after the active node.
  const pasteTextAsNodes = useCallback(
    (clipText: string) => {
      if (!clipText.trim()) return;
      const cur = stateRef.current;
      const targetId = cur.view.activeNodeId || cur.document.model.id;
      const parsed = textToModel("_", clipText);
      const freshChildren = parsed.children.map(cloneWithNewIds);
      if (freshChildren.length === 0) return;
      const next = dispatch(
        { type: "insertNodes", targetId, nodes: freshChildren },
        "paste"
      );
      // Land in selection mode on the pasted subtree rather than leaving the
      // caret inside a pasted node: if the paste happened while editing, edit
      // mode would otherwise persist (focusView keeps it), and the next
      // keystroke would become a separate "text" undo entry — making the paste
      // feel like it needs two Ctrl+Z to undo. View-only, so no undo entry.
      dispatch({ type: "exitEditing" });
      // Flash every inserted node so the paste destination is obvious.
      const collectIds = (n: MindMapModel): string[] => [
        n.id,
        ...n.children.flatMap(collectIds),
      ];
      flashNodes(freshChildren.flatMap(collectIds));
      if (noteId) saveNote(next.document.model);
    },
    [dispatch, noteId, saveNote, flashNodes]
  );

  // Copy/cut/paste operate on whole branches via the internal clipboard while a
  // node is merely selected; inside text editing they fall back to the native
  // textarea behaviour (and, for paste, to turning external indented text into
  // nodes).
  const hasTextRange = (st: EditorState) =>
    st.view.cursorPos !== st.view.selectionEnd;

  const handleCopy = useCallback((e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const st = stateRef.current;
    if (st.view.editing && hasTextRange(st)) return; // native text copy
    e.preventDefault();
    dispatch({ type: "copyBranch" });
  }, [dispatch]);

  const handleCut = useCallback(
    (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
      const st = stateRef.current;
      if (st.view.editing && hasTextRange(st)) return; // native text cut
      e.preventDefault();
      const next = dispatch({ type: "cutBranch" }, "cut-branch");
      if (noteId && next.document.model !== st.document.model)
        saveNote(next.document.model);
    },
    [dispatch, noteId, saveNote]
  );

  const handlePaste = useCallback(
    (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
      // Pasting an image file into an empty node uploads it and turns the node
      // into an image. (Non-empty nodes fall through to normal text paste.)
      const files = e.clipboardData.files;
      if (files && files.length > 0 && files[0].type.startsWith("image/")) {
        const st = stateRef.current;
        const node = st.view.activeNodeId
          ? findNode(st.document.model, st.view.activeNodeId)
          : null;
        if (node && node.text === "") {
          e.preventDefault();
          uploadAndSetImage(node.id, files[0]);
          return;
        }
      }

      const st = stateRef.current;
      const text = e.clipboardData.getData("text");

      // External Markdown → open the choice dialog (decompose / markdown node /
      // plain text). The internal branch clipboard carries no text, so a
      // cut/copied branch still pastes as a branch below.
      if (looksLikeMarkdown(text)) {
        e.preventDefault();
        const targetId = st.view.activeNodeId || st.document.model.id;
        setMdPaste({ text, targetId });
        return;
      }

      if (!st.view.editing) {
        // Selection mode: paste the internal branch clipboard as a child, or
        // fall back to external indented text → nodes.
        if (st.document.clipboard) {
          e.preventDefault();
          const next = dispatch({ type: "pasteBranch" }, "paste-branch");
          flashNodes(next.view.activeNodeId ? [next.view.activeNodeId] : []);
          if (noteId && next.document.model !== st.document.model)
            saveNote(next.document.model);
          return;
        }
        if (!text) return;
        e.preventDefault();
        pasteTextAsNodes(text);
        return;
      }

      // Editing mode: multi-line external text becomes nodes; single-line text
      // is left to the native textarea.
      if (!text || !text.includes("\n")) return;
      e.preventDefault();
      pasteTextAsNodes(text);
    },
    [dispatch, pasteTextAsNodes, flashNodes, noteId, saveNote]
  );

  // Resolve the Markdown paste dialog with one of the three strategies.
  const applyMarkdownPaste = useCallback(
    (mode: "decompose" | "node" | "plain") => {
      const pending = mdPaste;
      if (!pending) return;
      const { text, targetId } = pending;
      setMdPaste(null);
      const collectIds = (n: MindMapModel): string[] => [
        n.id,
        ...n.children.flatMap(collectIds),
      ];
      const insert = (children: MindMapModel[]) => {
        const fresh = children.map(cloneWithNewIds);
        if (fresh.length === 0) return;
        const next = dispatch(
          { type: "insertNodes", targetId, nodes: fresh },
          "paste"
        );
        // Land in selection mode so a follow-up keystroke doesn't become a
        // separate undo step (see pasteTextAsNodes). View-only, no undo entry.
        dispatch({ type: "exitEditing" });
        flashNodes(fresh.flatMap(collectIds));
        if (noteId) saveNote(next.document.model);
      };
      if (mode === "decompose") {
        insert(markdownToModel(text).children);
      } else if (mode === "node") {
        insert([
          { id: generateId(), text: text.trim(), type: "markdown", children: [] },
        ]);
      } else {
        insert(textToModel("_", text).children);
      }
      setTimeout(() => inputRef.current?.focus(), 0);
    },
    [mdPaste, dispatch, flashNodes, noteId, saveNote]
  );

  // --- Link preview: fetch <title> + favicon for a link node's URL ---
  const fetchLinkMeta = useCallback(
    async (nodeId: string) => {
      const node = findNode(stateRef.current.document.model, nodeId);
      if (!node || node.type !== "link" || !node.text) return;
      try {
        const res = await fetch(
          `/api/link-preview?url=${encodeURIComponent(node.text)}`,
          { credentials: "include" }
        );
        if (!res.ok) return;
        const data = (await res.json()) as { title?: string; favicon?: string };
        const next = dispatch(
          {
            type: "setLinkMeta",
            nodeId,
            linkTitle: data.title,
            favicon: data.favicon ?? null,
          },
          "link-meta"
        );
        if (noteId) saveNote(next.document.model);
      } catch {
        // network/parse failure: leave the node showing its raw URL
      }
    },
    [dispatch, noteId, saveNote]
  );

  // Auto-fetch link metadata when focus leaves a link node that has a URL but
  // no title yet (e.g. right after converting to a link and typing the URL).
  const prevActiveRef = useRef<string | null>(null);
  useEffect(() => {
    const prevId = prevActiveRef.current;
    prevActiveRef.current = activeNodeId;
    if (prevId && prevId !== activeNodeId) {
      const node = findNode(modelRef.current, prevId);
      if (node?.type === "link" && node.text && !node.linkTitle) {
        fetchLinkMeta(prevId);
      }
    }
  }, [activeNodeId, fetchLinkMeta]);

  // --- Command palette ---
  const commands = useMemo<Command[]>(() => {
    const copyAllText = () => {
      const text = modelToText(stateRef.current.document.model);
      navigator.clipboard.writeText(text);
    };
    const copyBranch = () => {
      const {
        document: { model },
        view: { activeNodeId },
      } = stateRef.current;
      if (!activeNodeId) {
        copyAllText();
        return;
      }
      const node = findNode(model, activeNodeId);
      if (node) {
        navigator.clipboard.writeText(modelToText(node));
      }
    };
    const sendToChatGPT = () => {
      const {
        document: { model },
        view: { activeNodeId },
      } = stateRef.current;
      const text = activeNodeId
        ? modelToText(findNode(model, activeNodeId) || model)
        : modelToText(model);
      const prompt = `この箇条書きツリー形式のテキストデータを文章に整形してください。内容は「${model.text}」についてです。\n\n${text}`;
      window.open(
        `https://chatgpt.com/?q=${encodeURIComponent(prompt)}`,
        "_blank"
      );
    };
    const pasteAsNodes = async () => {
      const clipText = await navigator.clipboard.readText();
      pasteTextAsNodes(clipText);
    };
    return [
      { id: "copy-all", label: "すべてプレーンテキストでコピー", action: copyAllText },
      { id: "copy-branch", label: "選択した枝以下をテキストコピー", action: copyBranch },
      { id: "paste", label: "プレーンテキストからペースト", action: pasteAsNodes },
      { id: "chatgpt", label: "ChatGPTに送る", action: sendToChatGPT },
      { id: "shortcuts", label: "キーボードショートカット一覧", action: () => setHelpOpen(true) },
    ];
  }, [pasteTextAsNodes]);

  // --- Right-click context menu items (for the node under the cursor) ---
  const contextMenuItems = useMemo<ContextMenuItem[]>(() => {
    if (!contextMenu) return [];
    const nodeId = contextMenu.nodeId;
    const node = findNode(modelRef.current, nodeId);
    if (!node) return [];
    const isRoot = node.id === modelRef.current.id;
    const hasChildren = node.children.length > 0;
    const type = node.type ?? "text";

    // Items are grouped by category; empty groups are dropped and the
    // remaining groups are joined with divider separators below.
    const groups: ContextMenuAction[][] = [];

    // --- Link actions: open / fetch metadata (link only) ---
    // Single click edits, so opening the URL lives in the menu.
    const linkGroup: ContextMenuAction[] = [];
    if (type === "link" && node.text) {
      linkGroup.push({
        label: "リンクを開く",
        onSelect: () => window.open(node.text, "_blank", "noopener"),
      });
      linkGroup.push({
        label: "リンク情報を取得（タイトル/favicon）",
        onSelect: () => fetchLinkMeta(nodeId),
      });
    }
    groups.push(linkGroup);

    // --- Structure: add child / collapse ---
    const structureGroup: ContextMenuAction[] = [];
    structureGroup.push({
      label: "子ノードを追加",
      onSelect: () => {
        const next = dispatch({ type: "addChild", nodeId }, "add-child");
        if (next.view.activeNodeId) flashNodes([next.view.activeNodeId]);
        if (noteId) saveNote(next.document.model);
        focusEditorSoon();
      },
    });
    if (hasChildren) {
      structureGroup.push({
        label: node.collapsed ? "展開する" : "折りたたむ",
        onSelect: () => {
          const next = dispatch({ type: "toggleCollapse", nodeId }, "collapse");
          if (noteId) saveNote(next.document.model);
        },
      });
    }
    groups.push(structureGroup);

    // --- Kind conversion (root excluded — it's the note title) ---
    const typeGroup: ContextMenuAction[] = [];
    if (!isRoot) {
      const setType = (nodeType: "text" | "image" | "link" | "markdown") => () => {
        const next = dispatch(
          { type: "setNodeType", nodeId, nodeType },
          "set-type"
        );
        if (noteId) saveNote(next.document.model);
        focusEditorSoon();
      };
      if (type !== "text") typeGroup.push({ label: "テキストにする", onSelect: setType("text") });
      if (type !== "image") typeGroup.push({ label: "画像にする（URL）", onSelect: setType("image") });
      if (type !== "link") typeGroup.push({ label: "リンクにする（URL）", onSelect: setType("link") });
      if (type !== "markdown") typeGroup.push({ label: "Markdownにする", onSelect: setType("markdown") });
    }
    groups.push(typeGroup);

    // --- Text formatting (font size / bold) ---
    const formatGroup: ContextMenuAction[] = [];
    if (type === "text") {
      const SIZES = [12, DEFAULT_FONT_SIZE, 18, 24, 32];
      const current = node.fontSize ?? DEFAULT_FONT_SIZE;
      const bigger = SIZES.find((s) => s > current);
      const smaller = [...SIZES].reverse().find((s) => s < current);
      const applyStyle = (style: { fontSize?: number | null; bold?: boolean }) => {
        const next = dispatch(
          { type: "setNodeStyle", nodeId, ...style },
          "style"
        );
        if (noteId) saveNote(next.document.model);
      };
      if (bigger !== undefined)
        formatGroup.push({
          label: "文字を大きく",
          onSelect: () => applyStyle({ fontSize: bigger }),
        });
      if (smaller !== undefined)
        formatGroup.push({
          label: "文字を小さく",
          onSelect: () => applyStyle({ fontSize: smaller }),
        });
      if (node.fontSize !== undefined && node.fontSize !== DEFAULT_FONT_SIZE)
        formatGroup.push({
          label: "標準サイズに戻す",
          onSelect: () => applyStyle({ fontSize: null }),
        });
      formatGroup.push({
        label: node.bold ? "太字を解除" : "太字にする",
        onSelect: () => applyStyle({ bold: !node.bold }),
      });
    }
    groups.push(formatGroup);

    // --- Media: image upload (R2). Replaces the node's content ---
    const mediaGroup: ContextMenuAction[] = [];
    if (!isRoot) {
      mediaGroup.push({
        label: "画像をアップロード",
        onSelect: () => triggerImageUpload(nodeId),
      });
    }
    groups.push(mediaGroup);

    // --- Copy ---
    const copyGroup: ContextMenuAction[] = [];
    copyGroup.push({
      label: "枝をテキストコピー",
      onSelect: () => {
        navigator.clipboard.writeText(modelToText(node));
      },
    });
    groups.push(copyGroup);

    // --- Destructive ---
    const dangerGroup: ContextMenuAction[] = [];
    if (!isRoot) {
      dangerGroup.push({
        label: "ノードを削除",
        danger: true,
        onSelect: () => {
          const next = dispatch({ type: "deleteNode", nodeId }, "delete-node");
          if (noteId) saveNote(next.document.model);
        },
      });
    }
    groups.push(dangerGroup);

    // Join non-empty groups with divider separators.
    const items: ContextMenuItem[] = [];
    for (const group of groups.filter((g) => g.length > 0)) {
      if (items.length > 0) items.push({ separator: true });
      items.push(...group);
    }
    return items;
  }, [
    contextMenu,
    dispatch,
    noteId,
    saveNote,
    fetchLinkMeta,
    triggerImageUpload,
    flashNodes,
  ]);

  // --- Keyboard handling ---
  // Central keymap: a single declarative table (see editorKeymap.ts) drives all
  // shortcuts, so bindings stay auditable and the help overlay is generated
  // from the same source.
  const keymap = useMemo<KeyBinding[]>(
    () =>
      buildKeymap({
        dispatch,
        saveNote: (m) => saveNote(m),
        openPalette: () => setCmdPaletteOpen(true),
        openHelp: () => setHelpOpen(true),
        undo,
        redo,
        verticalMove,
      }),
    [dispatch, saveNote, undo, redo]
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (isComposing) return;
      // The help overlay doesn't grab focus, so the textarea still receives
      // keys while it's open; let ShortcutHelp handle Escape and ignore the rest.
      if (helpOpen) return;
      const state = stateRef.current;
      runKeymap(keymap, {
        e,
        state,
        node: activeNode(state),
        pos: inputRef.current?.selectionStart || 0,
        selEnd: inputRef.current?.selectionEnd || 0,
      });
    },
    [isComposing, keymap, helpOpen]
  );

  // --- Guest mode: hand the current document off to be saved to an account ---
  const handleSaveToAccount = useCallback(() => {
    const m = stateRef.current.document.model;
    onSaveToAccount?.({ title: m.text, content: serializeModel(m) });
  }, [onSaveToAccount]);

  // --- Title editing ---
  const handleTitleChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      dispatch({ type: "setTitle", text: e.target.value });
    },
    [dispatch]
  );

  // --- Konva setup ---
  useEffect(() => {
    if (!canvasRef.current) return;
    const container = canvasRef.current;
    let removeWindowMouseUp: (() => void) | null = null;

    import("konva").then((mod) => {
      const Konva = mod.default;
      konvaRef.current = Konva;

      const stage = new Konva.Stage({
        container,
        width: container.clientWidth,
        height: container.clientHeight,
        draggable: true,
      });
      konvaStageRef.current = stage;

      const layer = new Konva.Layer();
      stage.add(layer);
      layerRef.current = layer;

      const cursorLayer = new Konva.Layer();
      stage.add(cursorLayer);
      cursorLayerRef.current = cursorLayer;

      // Paste / insert flash layer. Kept separate from the cursor layer so its
      // soft fade animation isn't torn down and restarted by the caret blink,
      // which destroyChildren()'s the cursor layer twice a second.
      const flashLayer = new Konva.Layer({ listening: false });
      stage.add(flashLayer);
      flashLayerRef.current = flashLayer;

      // Drag & drop preview layer. Drawn imperatively on every mousemove of a
      // move drag — going through React state would re-render per move. It sits
      // above the cursor layer and is never touched by the React effects (the
      // cursor layer gets destroyChildren()'d, so the preview can't live there).
      const dragLayer = new Konva.Layer({ listening: false });
      stage.add(dragLayer);
      dragLayerRef.current = dragLayer;

      // Preview shapes: a ghost of the dragged node following the pointer, and
      // a marker showing where it would land (box highlight = become a child,
      // horizontal line = insert as sibling at that slot).
      let ghost: any = null;
      let marker: any = null;
      let markerKey: string | null = null;

      const clearMovePreview = () => {
        ghost?.destroy();
        marker?.destroy();
        ghost = marker = markerKey = null;
        dragLayer.batchDraw();
        stage.container().style.cursor = "";
      };

      const buildGhost = (nodeId: string, descendants: number) => {
        const flat = nodesRef.current;
        const node = flat.find((n) => n.id === nodeId);
        if (!node) return;
        const w = nodeBoxWidth(node.width, false);
        const h = nodeBoxHeight(node.height);
        const g = new Konva.Group({ opacity: 0.65, listening: false });
        g.add(
          new Konva.Rect({
            width: w,
            height: h,
            cornerRadius: 12,
            fill: "#ffffff",
            stroke: "#94a3b8",
            strokeWidth: 1.5,
            shadowColor: "#0f172a",
            shadowBlur: 12,
            shadowOpacity: 0.25,
            shadowOffsetY: 4,
          })
        );
        const firstLine = node.text.split("\n")[0];
        const label = !firstLine
          ? "empty"
          : firstLine.length > 24
            ? firstLine.slice(0, 24) + "…"
            : firstLine;
        g.add(
          new Konva.Text({
            x: NODE_PADDING,
            y: h / 2 - 7,
            text: label,
            fontSize: 14,
            fontFamily: "sans-serif",
            fill: firstLine ? "#0f172a" : "#94a3b8",
            fontStyle: firstLine ? "normal" : "italic",
          })
        );
        // Subtree travels along — surface its size like the collapse badge does.
        if (descendants > 0) {
          const badgeR = 9;
          g.add(
            new Konva.Circle({
              x: w + 4 + badgeR,
              y: h / 2,
              radius: badgeR,
              fill: "#000000",
            })
          );
          g.add(
            new Konva.Text({
              x: w + 4,
              y: h / 2 - 5,
              width: badgeR * 2,
              align: "center",
              text: `+${descendants}`,
              fontSize: 10,
              fontFamily: "sans-serif",
              fill: "#ffffff",
            })
          );
        }
        ghost = g;
        dragLayer.add(g);
      };

      // Rebuild the drop marker only when the resolved target actually changes
      // (its identity, not the pointer position) — the common per-move path is
      // just a ghost position update + batchDraw.
      const updateDropMarker = (drop: DropTarget | null) => {
        const key = drop
          ? `${drop.kind}:${drop.targetId}:${drop.kind === "sibling" ? drop.position : ""}`
          : null;
        if (key === markerKey) return;
        marker?.destroy();
        marker = null;
        markerKey = key;
        if (!drop) return;
        const flat = nodesRef.current;
        const target = flat.find((n) => n.id === drop.targetId);
        if (!target) return;
        const isRoot = flat[0]?.id === target.id;
        const w = nodeBoxWidth(target.width, isRoot);
        const h = nodeBoxHeight(target.height);
        if (drop.kind === "child") {
          marker = new Konva.Rect({
            x: target.x - 3,
            y: target.y - h / 2 - 3,
            width: w + 6,
            height: h + 6,
            cornerRadius: 14,
            fill: "rgba(16, 185, 129, 0.12)",
            stroke: "#10b981",
            strokeWidth: 2,
            listening: false,
          });
        } else {
          // Insertion line in the middle of the sibling gap (VERTICAL_GAP=10).
          const y =
            drop.position === "before" ? target.y - h / 2 - 5 : target.y + h / 2 + 5;
          const g = new Konva.Group({ listening: false });
          g.add(
            new Konva.Line({
              points: [target.x - 4, y, target.x + w + 4, y],
              stroke: "#10b981",
              strokeWidth: 3,
              lineCap: "round",
            })
          );
          g.add(new Konva.Circle({ x: target.x - 4, y, radius: 3.5, fill: "#10b981" }));
          marker = g;
        }
        dragLayer.add(marker);
        ghost?.moveToTop();
      };

      // Keep the CSS dot grid in sync with stage pan/zoom. The dots only appear
      // once zoomed in past 150% — at normal zoom they'd just be visual noise.
      const GRID = 20;
      const DOTS = "radial-gradient(#dbe2ea 1px, transparent 1px)";
      const updateGrid = () => {
        const scale = stage.scaleX();
        const size = GRID * scale;
        container.style.backgroundImage = scale >= 1.5 ? DOTS : "none";
        container.style.backgroundSize = `${size}px ${size}px`;
        container.style.backgroundPosition = `${stage.x()}px ${stage.y()}px`;
      };
      updateGridRef.current = updateGrid;
      updateGrid();
      stage.on("dragmove", updateGrid);
      // After a pan settles, refill the viewport: nodes just scrolled into view
      // (beyond the pre-rendered margin) need to be built. During the drag the
      // margin covers the movement, so we only redraw on release.
      stage.on("dragend", () => setViewportTick((t) => t + 1));

      // Zoom
      stage.on("wheel", (e: any) => {
        e.evt.preventDefault();
        const oldScale = stage.scaleX();
        const pointer = stage.getPointerPosition();
        if (!pointer) return;
        const mousePointTo = {
          x: (pointer.x - stage.x()) / oldScale,
          y: (pointer.y - stage.y()) / oldScale,
        };
        const scaleBy = 1.05;
        const newScale =
          e.evt.deltaY > 0 ? oldScale / scaleBy : oldScale * scaleBy;
        const limitedScale = Math.max(0.2, Math.min(3, newScale));
        stage.scale({ x: limitedScale, y: limitedScale });
        stage.position({
          x: pointer.x - mousePointTo.x * limitedScale,
          y: pointer.y - mousePointTo.y * limitedScale,
        });
        // Immediate feedback at the new transform; the effect below then
        // refills any nodes the zoom brought into view.
        layer.batchDraw();
        updateGrid();
        // Zoom changes which nodes fall inside the viewport (zooming out reveals
        // more) — re-run the culled redraw instead of just translating.
        setViewportTick((t) => t + 1);
      });

      // Click on empty space: keep the node selected, just leave edit mode
      // (exactly one node is always selected). Skip if just finished dragging.
      stage.on("click tap", (e: any) => {
        if (wasDraggingRef.current) {
          wasDraggingRef.current = false;
          return;
        }
        if (e.target === stage) {
          dispatch({ type: "exitEditing" });
        }
      });

      // Drag from a node: on the node being edited it selects a text range
      // (never crossing to another node); on any other non-root node it picks
      // the branch up and moves it (see the "move" branch below).
      stage.on("mousemove", () => {
        const drag = dragStateRef.current;
        if (!drag) return;
        const pointer = stage.getPointerPosition();
        if (!pointer) return;

        // Ignore sub-threshold jitter: a click that barely moves must not turn
        // into a drag-select (which would enter edit mode on a plain click).
        if (!drag.moved) {
          const dx = pointer.x - drag.startX;
          const dy = pointer.y - drag.startY;
          if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
          drag.moved = true;
        }

        const scale = stage.scaleX();
        const worldX = (pointer.x - stage.x()) / scale;
        const worldY = (pointer.y - stage.y()) / scale;

        if (drag.mode === "move") {
          if (!drag.excluded || !drag.parentOf) {
            // First real move: snapshot the drag context once. The flat array
            // is stable for the whole drag (no dispatches until drop).
            const flat = nodesRef.current;
            const byId = new Map(flat.map((n) => [n.id, n]));
            const parentOf = new Map<string, string>();
            for (const n of flat) for (const c of n.children) parentOf.set(c, n.id);
            const excluded = new Set<string>();
            (function collect(id: string) {
              excluded.add(id);
              byId.get(id)?.children.forEach(collect);
            })(drag.nodeId);
            drag.excluded = excluded;
            drag.parentOf = parentOf;
            buildGhost(drag.nodeId, drag.descendants);
          }
          drag.drop = resolveDropTarget(
            nodesRef.current,
            drag.nodeId,
            drag.excluded,
            drag.parentOf,
            worldX,
            worldY
          );
          ghost?.position({ x: worldX - drag.grabDX, y: worldY - drag.grabDY });
          updateDropMarker(drag.drop);
          const cursor = drag.drop ? "grabbing" : "no-drop";
          const el = stage.container();
          if (el.style.cursor !== cursor) el.style.cursor = cursor;
          dragLayer.batchDraw();
          return;
        }

        const node = nodesRef.current.find((n) => n.id === drag.nodeId);
        if (!node) return;

        // Find char position within the node (line by Y, column by X). Y and X
        // are clamped to the node's own lines, so dragging past its edges just
        // extends the selection to the nearest end.
        const data = lineDataRef.current.get(node.id);
        let charIdx = 0;
        if (data) {
          const blockHeight = data.lines.length * data.lineHeight;
          const relY = worldY - (node.y - blockHeight / 2);
          const line = Math.max(
            0,
            Math.min(data.lines.length - 1, Math.floor(relY / data.lineHeight))
          );
          const relX = worldX - node.x - NODE_PADDING;
          charIdx = lineColToPos(
            data,
            line,
            nearestCol(data.lineOffsets[line], relX)
          );
        }

        dispatch({
          type: "dragSelect",
          nodeId: drag.nodeId,
          anchorOffset: drag.anchorCharIdx,
          focusOffset: charIdx,
        });
      });

      stage.on("mouseup touchend", () => {
        const drag = dragStateRef.current;
        if (drag) {
          if (drag.mode === "move") {
            clearMovePreview();
            if (drag.moved && drag.drop) {
              commitMoveRef.current(drag.nodeId, drag.drop);
            }
          }
          wasDraggingRef.current = true;
          dragStateRef.current = null;
          stage.draggable(true);
        }
      });

      // Releasing the pointer outside the canvas never reaches the stage's own
      // mouseup — treat it as a drag cancel so the preview can't get stuck.
      const onWindowMouseUp = () => {
        const drag = dragStateRef.current;
        if (!drag) return;
        if (drag.mode === "move") clearMovePreview();
        dragStateRef.current = null;
        stage.draggable(true);
      };
      window.addEventListener("mouseup", onWindowMouseUp);
      removeWindowMouseUp = () =>
        window.removeEventListener("mouseup", onWindowMouseUp);

      const resizeObserver = new ResizeObserver(() => {
        stage.width(container.clientWidth);
        stage.height(container.clientHeight);
        // First time the stage gains a real size, centre the open document
        // (covers the case where it was 0×0 at setup time).
        if (!didCenterRef.current && centerOnOpenRef.current()) {
          didCenterRef.current = true;
        }
        layer.draw();
      });
      resizeObserver.observe(container);

      // Centre the view on the active node before the first paint, so the very
      // first frame — and the coordinates the test API reports — are already
      // centred (no async post-layout shift that could race a click).
      if (centerOnOpenRef.current()) didCenterRef.current = true;

      // Signal that Konva is ready so the redraw effect can fire
      setKonvaReady(true);
    });

    return () => {
      removeWindowMouseUp?.();
      if (konvaStageRef.current) {
        konvaStageRef.current.destroy();
        konvaStageRef.current = null;
        layerRef.current = null;
        cursorLayerRef.current = null;
        dragLayerRef.current = null;
      }
    };
  }, [dispatch]);

  // --- Centre the active node when the document first opens ---
  // On open the caret sits on the active node (the root), so we place that
  // node's box centre at the viewport centre. Placing the target requires the
  // stage to be sized and the first layout to exist; returns false (so the
  // caller keeps trying) until both are true. Called synchronously from the
  // Konva setup BEFORE the first redraw — so the very first frame (and the
  // coordinates the test API reports) are already centred, with no async shift.
  const centerOnOpen = useCallback(() => {
    const stage = konvaStageRef.current;
    if (!stage) return false;
    const width = stage.width();
    const height = stage.height();
    if (width <= 0 || height <= 0) return false;
    const flat = nodesRef.current;
    if (flat.length === 0) return false;
    const activeId = stateRef.current.view.activeNodeId;
    const target = flat.find((n) => n.id === activeId) ?? flat[0];
    const rect = nodeRect(target, flat[0]?.id === target.id);
    const { offsetX, offsetY } = centerOffset(rectCenter(rect), stage.scaleX(), {
      width,
      height,
    });
    stage.x(offsetX);
    stage.y(offsetY);
    layerRef.current?.draw();
    updateGridRef.current();
    return true;
  }, []);
  const centerOnOpenRef = useRef(centerOnOpen);
  centerOnOpenRef.current = centerOnOpen;

  // Re-centre when the note changes (a fresh document should open centred too).
  useEffect(() => {
    didCenterRef.current = false;
  }, [noteId]);

  // Fallback: if the setup couldn't centre yet (stage not sized, or the first
  // layout not ready), try again once those become available.
  useEffect(() => {
    if (didCenterRef.current || !konvaReady) return;
    if (centerOnOpenRef.current()) {
      didCenterRef.current = true;
      setViewportTick((t) => t + 1);
    }
  }, [konvaReady, nodes]);

  // --- Keep the active node on-screen (scroll it just into view) ---
  // Skips the initial open (centre-on-open owns that first frame).
  useEffect(() => {
    const stage = konvaStageRef.current;
    if (!stage || !activeNodeId || !didCenterRef.current) return;

    const activeNode = nodes.find((n) => n.id === activeNodeId);
    if (!activeNode) return;

    const rect = nodeRect(activeNode, nodes[0]?.id === activeNode.id);
    const { offsetX, offsetY, changed } = ensureVisibleOffset(
      rect,
      { scale: stage.scaleX(), offsetX: stage.x(), offsetY: stage.y() },
      { width: stage.width(), height: stage.height() },
      50
    );
    if (changed) {
      stage.x(offsetX);
      stage.y(offsetY);
      layerRef.current?.draw();
      updateGridRef.current();
    }
  }, [activeNodeId, nodes]);

  // --- Position hidden input at active node for IME ---
  useEffect(() => {
    const stage = konvaStageRef.current;
    if (!stage || !activeNodeId) {
      setInputPos({ x: 0, y: 0 });
      return;
    }
    const activeNode = nodes.find((n) => n.id === activeNodeId);
    if (!activeNode) return;

    const scale = stage.scaleX();
    const data = lineDataRef.current.get(activeNodeId);
    let cursorX = 0;
    let lineCenterOffset = 0;
    if (data) {
      const { line, col } = posToLineCol(data, cursorPos);
      cursorX = data.lineOffsets[line]?.[col] || 0;
      const blockHeight = data.lines.length * data.lineHeight;
      lineCenterOffset =
        -blockHeight / 2 + line * data.lineHeight + data.lineHeight / 2;
    }

    const screenX = (activeNode.x + NODE_PADDING + cursorX) * scale + stage.x();
    const screenY = (activeNode.y + lineCenterOffset) * scale + stage.y();
    setInputPos({ x: screenX, y: screenY });
  }, [activeNodeId, nodes, cursorPos, editingText]);

  // --- Position the visible URL box under the edited image/link node ---
  // Re-runs on pan/zoom via viewportTick (like the culled redraw); during an
  // in-flight pan the box goes briefly stale and snaps back on release.
  useEffect(() => {
    const stage = konvaStageRef.current;
    if (!urlEditing || !stage || !activeNodeId) {
      setUrlBoxPos(null);
      return;
    }
    const node = nodes.find((n) => n.id === activeNodeId);
    if (!node) {
      setUrlBoxPos(null);
      return;
    }
    const scale = stage.scaleX();
    const isRoot = nodes[0]?.id === node.id;
    const w = nodeBoxWidth(node.width, isRoot);
    const h = nodeBoxHeight(node.height);
    setUrlBoxPos({
      x: node.x * scale + stage.x(),
      y: (node.y + h / 2) * scale + stage.y() + 8,
      // Wide enough to read a URL even when the node (or zoom) is small.
      width: Math.max(240, w * scale),
    });
  }, [urlEditing, activeNodeId, nodes, viewportTick]);

  // --- Redraw canvas ---
  useEffect(() => {
    const Konva = konvaRef.current;
    const layer = layerRef.current;
    if (!Konva || !layer || nodes.length === 0) return;

    const perfStart = import.meta.env.PROD ? 0 : performance.now();

    layer.destroyChildren();

    const nodeMap: Record<string, MindMapNode> = {};
    nodes.forEach((n) => (nodeMap[n.id] = n));

    // --- Viewport culling ---
    // Only nodes/connections intersecting the visible viewport (expanded by a
    // margin so short pans stay smooth) are built and rasterised. At large tree
    // sizes most nodes are off-screen, so this is the dominant per-keystroke
    // win: both the JS object build and the Konva raster scale with the number
    // of *drawn* nodes, not the total. A stage pan/zoom bumps `viewportTick`
    // (see the setup effect) to refill the area.
    const stage = konvaStageRef.current;
    const scale = stage ? stage.scaleX() : 1;
    // World rectangle currently on screen (single source of truth in viewport.ts).
    const view = stage
      ? worldViewport(
          { scale, offsetX: stage.x(), offsetY: stage.y() },
          { width: stage.width(), height: stage.height() }
        )
      : { x: 0, y: 0, width: 800, height: 600 };
    const MARGIN = 0.6; // extra viewport fraction rendered on each side
    const cullLeft = view.x - view.width * MARGIN;
    const cullTop = view.y - view.height * MARGIN;
    const cullRight = view.x + view.width * (1 + MARGIN);
    const cullBottom = view.y + view.height * (1 + MARGIN);

    /** A node's (generous) world bounding box intersects the cull rect. */
    const nodeVisible = (node: MindMapNode, isRoot: boolean): boolean => {
      // The active node is always drawn (auto-scroll keeps it on-screen, and
      // the cursor/input effects read its line data).
      if (node.id === activeNodeId) return true;
      const left = node.x - 8;
      const right = node.x + nodeBoxWidth(node.width, isRoot) + 48;
      const top = node.y - node.height / 2 - 8;
      const bottom = node.y + node.height / 2 + 8;
      return (
        right >= cullLeft &&
        left <= cullRight &&
        bottom >= cullTop &&
        top <= cullBottom
      );
    };

    const visible = new Array<boolean>(nodes.length);
    nodes.forEach((node, index) => {
      visible[index] = nodeVisible(node, index === 0);
    });

    // Pre-calculate per-node line data + widths (cached, see top of file), but
    // only for the nodes we're actually drawing. lineDataRef must still hold the
    // active node so the cursor/input/drag effects can resolve caret geometry.
    const textWidths = new Map<string, number>();
    const lineDataMap = new Map<string, LineData>();
    const nodePadding = NODE_PADDING;

    nodes.forEach((node, index) => {
      if (!visible[index]) return;
      // For active node during editing, use editingText. A markdown node draws
      // its bounded preview (except while actually being edited), so its line
      // data must be built from that same preview or blockHeight/caret geometry
      // would follow the full source and mis-place the text.
      const displayRaw =
        node.type === "markdown" && !(activeNodeId === node.id && editing)
          ? markdownPreview(node.text)
          : activeNodeId === node.id
            ? editingText
            : node.text;
      const data = buildLineData(
        displayRaw,
        node.fontSize ?? DEFAULT_FONT_SIZE,
        !!node.bold
      );
      lineDataMap.set(node.id, data);
      textWidths.set(
        node.id,
        displayRaw === "" ? measureEmptyWidth() : lineDataWidth(data)
      );
    });
    lineDataRef.current = lineDataMap;

    // Draw connections whose parent→child segment crosses the cull rect. A long
    // edge can cross the viewport while both endpoints sit outside it, so we
    // test the segment's bounding box rather than either node's visibility.
    nodes.forEach((node) => {
      node.children.forEach((childId) => {
        const child = nodeMap[childId];
        if (!child) return;
        // Exact width for drawn parents; node.width otherwise (invisible sub-
        // pixel difference on an off-screen curve start).
        const parentWidth = textWidths.get(node.id) ?? node.width;
        const startX = node.x + parentWidth + 40;
        const startY = node.y;
        const endX = child.x;
        const endY = child.y;
        if (
          Math.max(startX, endX) < cullLeft ||
          Math.min(startX, endX) > cullRight ||
          Math.max(startY, endY) < cullTop ||
          Math.min(startY, endY) > cullBottom
        ) {
          return;
        }
        const controlOffset = Math.abs(endX - startX) * 0.5;
        const path = new Konva.Path({
          data: `M ${startX} ${startY} C ${startX + controlOffset} ${startY}, ${endX - controlOffset} ${endY}, ${endX} ${endY}`,
          stroke: "#aeb7c2",
          strokeWidth: 1.5,
          fill: "transparent",
        });
        layer.add(path);
      });
    });

    // Draw nodes
    nodes.forEach((node, index) => {
      if (!visible[index]) return;
      const isRoot = index === 0;
      // isEditing = caret/text-input active; isSelected = node highlighted but
      // not being edited (single click). A selected node renders like any other
      // (link title, stored format) with just an accent outline.
      const isEditing = editing && activeNodeId === node.id;
      const isSelected = !editing && activeNodeId === node.id;
      // Image/link nodes keep their rendered preview even while editing — the
      // URL is edited in the visible box below the node — so only TEXT nodes
      // swap to raw-text (live buffer) editing on the canvas. Markdown edits as
      // raw multi-line text in place, so it is NOT a custom (URL-box) node.
      const isCustom = node.type === "image" || node.type === "link";
      const isTextEditing = isEditing && !isCustom;
      const asImage = node.type === "image";
      const asLink = node.type === "link";
      // A markdown node renders a bounded preview of its source (full text is
      // shown only while editing); it's tinted and tagged with an "MD" label.
      const asMarkdown = !isEditing && node.type === "markdown";
      // Links display their fetched title (falling back to the raw URL).
      const displayRaw = isTextEditing
        ? editingText
        : asLink
          ? node.linkTitle || node.text
          : asMarkdown
            ? markdownPreview(node.text)
            : node.text;
      const isEmpty = displayRaw === "";
      const displayText = isEmpty ? "empty" : displayRaw;
      const fontSize = node.fontSize ?? DEFAULT_FONT_SIZE;
      const bold = !!node.bold;
      const lineHeightPx = lineHeightFor(fontSize);
      const konvaLineHeight = lineHeightPx / fontSize;
      // Line count comes from the (14px) lineData; titles/text are single-line
      // in practice, multi-line text keeps its hard breaks.
      const data = lineDataMap.get(node.id)!;
      const lineCount = data.lines.length;
      const blockHeight = lineCount * lineHeightPx;
      // Favicon only when a non-active link node has one.
      const favEntry =
        asLink && node.favicon ? getImageEntry(node.favicon) : undefined;
      const favLoaded =
        favEntry?.status === "loaded" ? favEntry.img : undefined;
      const favOffset = asLink && node.favicon ? FAVICON_SIZE + FAVICON_GAP : 0;

      // Box geometry from a single measured size. While text-editing it follows
      // the caret's own line measurement (so the caret can't overflow the box);
      // otherwise it trusts node.width/height from measureModelNode — image,
      // link and text are all sized there, so there's no per-kind branch here.
      let rectWidth: number;
      let rectHeight: number;
      if (isTextEditing) {
        const textWidth = textWidths.get(node.id) || 100;
        rectWidth = nodeBoxWidth(textWidth, isRoot);
        rectHeight = Math.max(32, blockHeight + 14);
      } else {
        rectWidth = nodeBoxWidth(node.width, isRoot);
        rectHeight = nodeBoxHeight(node.height);
      }

      const group = new Konva.Group();

      const rect = new Konva.Rect({
        x: node.x,
        y: node.y - rectHeight / 2,
        width: rectWidth,
        height: rectHeight,
        cornerRadius: 12,
        fill: isEditing
          ? isRoot
            ? "#1e293b"
            : "#f1f5f9"
          : isRoot
            ? "#0f172a"
            : asMarkdown
              ? "#faf5ff"
              : isEmpty
                ? "#f8fafc"
                : "#ffffff",
        stroke:
          isEditing || isSelected
            ? "#000000"
            : isRoot
              ? "#0f172a"
              : asMarkdown
                ? "#d8b4fe"
                : "#e2e8f0",
        strokeWidth: isEditing || isSelected ? 2 : 1,
        // Shadow blur is the dominant raster cost; keep the soft shadow only on
        // the single root node and drop the near-invisible one on every other.
        shadowColor: "#0f172a",
        shadowBlur: isRoot ? 16 : 0,
        shadowOpacity: isRoot ? 0.18 : 0,
        shadowOffsetY: isRoot ? 6 : 0,
        // Skip Konva's extra offscreen buffer for fill+stroke shapes.
        perfectDrawEnabled: false,
      });
      group.add(rect);

      if (asImage) {
        const d = imageDisplaySize(node.text);
        if (d.status === "loaded" && d.img) {
          group.add(
            new Konva.Image({
              image: d.img,
              x: node.x + nodePadding,
              y: node.y - d.h / 2,
              width: d.w,
              height: d.h,
              cornerRadius: 8,
              listening: false,
            })
          );
        } else {
          group.add(
            new Konva.Text({
              x: node.x + nodePadding,
              y: node.y - 7,
              width: d.w,
              align: "center",
              text: d.status === "error" ? "画像を読み込めません" : "読み込み中…",
              fontSize: 12,
              fontFamily: "sans-serif",
              fill: "#94a3b8",
              listening: false,
            })
          );
        }
      } else {
        // Favicon before the link title (when fetched + loaded).
        if (asLink && favLoaded) {
          group.add(
            new Konva.Image({
              image: favLoaded,
              x: node.x + nodePadding,
              y: node.y - FAVICON_SIZE / 2,
              width: FAVICON_SIZE,
              height: FAVICON_SIZE,
              listening: false,
            })
          );
        }
        const textNode = new Konva.Text({
          x: node.x + nodePadding + favOffset,
          y: node.y - blockHeight / 2 + 2,
          text: displayText,
          fontSize,
          fontFamily: "sans-serif",
          lineHeight: konvaLineHeight,
          fill: asLink
            ? "#2563eb"
            : isRoot
              ? "#ffffff"
              : asMarkdown
                ? "#6b21a8"
                : isEmpty
                  ? "#94a3b8"
                  : "#0f172a",
          fontStyle: isEmpty ? "italic" : bold ? "bold" : "normal",
          textDecoration: asLink ? "underline" : "",
          listening: false,
        });
        group.add(textNode);
      }

      // Markdown tag: a small "MD" tab riding the top-left edge of the box.
      if (asMarkdown) {
        const tabW = 30;
        const tabH = 16;
        const tabX = node.x + 8;
        const tabY = node.y - rectHeight / 2 - tabH + 3;
        group.add(
          new Konva.Rect({
            x: tabX,
            y: tabY,
            width: tabW,
            height: tabH,
            cornerRadius: 5,
            fill: "#9333ea",
            listening: false,
            perfectDrawEnabled: false,
          })
        );
        group.add(
          new Konva.Text({
            x: tabX,
            y: tabY + 3,
            width: tabW,
            align: "center",
            text: "MD",
            fontSize: 10,
            fontStyle: "bold",
            fontFamily: "sans-serif",
            fill: "#ffffff",
            listening: false,
          })
        );
      }

      // Collapsed indicator: a small pill on the right showing hidden child count.
      if (node.collapsed && node.childCount > 0) {
        const badgeR = 9;
        const badgeX = node.x + rectWidth + 4 + badgeR;
        const badge = new Konva.Circle({
          x: badgeX,
          y: node.y,
          radius: badgeR,
          fill: "#000000",
          listening: false,
        });
        group.add(badge);
        const badgeText = new Konva.Text({
          x: badgeX - badgeR,
          y: node.y - 6,
          width: badgeR * 2,
          align: "center",
          text: String(node.childCount),
          fontSize: 11,
          fontFamily: "sans-serif",
          fill: "#ffffff",
          listening: false,
        });
        group.add(badgeText);
      }

      // Click → activate node
      group.on("mousedown touchstart", (e: any) => {
        e.cancelBubble = true;
        const stage = konvaStageRef.current;
        if (!stage) return;
        const pointer = stage.getPointerPosition();
        if (!pointer) return;

        const scale = stage.scaleX();
        const worldX = (pointer.x - stage.x()) / scale;
        const worldY = (pointer.y - stage.y()) / scale;

        // Find the clicked caret position: line by Y, column by X. Image/link
        // nodes don't render their text, so caret to the end of the URL/label.
        let charIdx: number;
        if (asImage || asLink || asMarkdown) {
          charIdx = node.text.length;
        } else {
          const relY = worldY - (node.y - blockHeight / 2);
          const line = Math.max(
            0,
            Math.min(lineCount - 1, Math.floor(relY / data.lineHeight))
          );
          const relX = worldX - node.x - nodePadding;
          charIdx = lineColToPos(
            data,
            line,
            nearestCol(data.lineOffsets[line], relX)
          );
        }

        // A single click selects the node; only clicking inside the node that
        // is already being edited moves the caret. A drag (handled in mousemove
        // → dragSelect) then enters edit mode with a text range.
        const cur = stateRef.current;
        const editingThis =
          cur.view.editing && cur.view.activeNodeId === node.id;
        if (editingThis) {
          dispatch({
            type: "activateNode",
            nodeId: node.id,
            cursorPos: charIdx,
            selectionEnd: charIdx,
            editing: true,
          });
        } else {
          // Select mode: whole text selected so a follow-up keypress replaces it.
          dispatch({
            type: "activateNode",
            nodeId: node.id,
            cursorPos: 0,
            selectionEnd: node.text.length,
            editing: false,
          });
        }

        // Arm a drag (it only becomes "real" once the pointer moves past
        // DRAG_THRESHOLD; below that it stays a plain click). Dragging the node
        // being edited extends a text selection; dragging any other node picks
        // the branch up to move it. The root anchors the tree and can't move,
        // so it keeps the text-selection drag.
        if (editingThis || isRoot) {
          dragStateRef.current = {
            mode: "text",
            nodeId: node.id,
            anchorCharIdx: charIdx,
            startX: pointer.x,
            startY: pointer.y,
            moved: false,
          };
        } else {
          dragStateRef.current = {
            mode: "move",
            nodeId: node.id,
            startX: pointer.x,
            startY: pointer.y,
            moved: false,
            grabDX: worldX - node.x,
            grabDY: worldY - (node.y - rectHeight / 2),
            excluded: null,
            parentOf: null,
            descendants: countDescendants(modelRef.current, node.id),
            drop: null,
          };
        }
        if (stage) stage.draggable(false);

        // Focus the hidden input in a macrotask so it survives the click
        // event's default focus handling (mousedown → mouseup → click are
        // separate tasks; the click default would otherwise blur the input,
        // overriding the focus applied by the input-sync effect).
        focusEditorSoon();
      });

      // Double-click → select all text
      group.on("dblclick dbltap", () => {
        dispatch({ type: "selectAllInNode", nodeId: node.id });
        focusEditorSoon();
      });

      // Right-click → open the node context menu at the cursor.
      group.on("contextmenu", (e: any) => {
        e.evt.preventDefault();
        e.cancelBubble = true;
        setContextMenu({
          x: e.evt.clientX,
          y: e.evt.clientY,
          nodeId: node.id,
        });
      });

      layer.add(group);
    });

    const drawStart = import.meta.env.PROD ? 0 : performance.now();
    layer.draw();

    if (!import.meta.env.PROD) {
      const now = performance.now();
      perfRef.current.redrawCount += 1;
      perfRef.current.redrawTotalMs += now - perfStart;
      perfRef.current.redrawLastMs = now - perfStart;
      perfRef.current.redrawDrawMs += now - drawStart;
    }
  }, [nodes, activeNodeId, editing, editingText, konvaReady, dispatch, viewportTick]);

  // --- Cursor layer (lightweight, redraws only on cursor changes) ---
  useEffect(() => {
    const Konva = konvaRef.current;
    const cursorLayer = cursorLayerRef.current;
    if (!Konva || !cursorLayer || !activeNodeId) {
      if (cursorLayer) {
        cursorLayer.destroyChildren();
        cursorLayer.draw();
      }
      return;
    }

    cursorLayer.destroyChildren();

    const nodePadding = NODE_PADDING;

    // Caret + in-node text selection — only while TEXT-editing. A merely
    // selected node gets its accent outline on the main layer, and an edited
    // image/link node keeps its caret in the visible URL box instead.
    const activeNode = nodes.find((n) => n.id === activeNodeId);
    const activeCustom =
      activeNode?.type === "image" || activeNode?.type === "link";
    if (editing && !activeCustom) {
      if (!activeNode) return;

      const isRoot = nodes.indexOf(activeNode) === 0;
      const data = lineDataRef.current.get(activeNodeId);
      const lineHeight = data ? data.lineHeight : LINE_HEIGHT;
      const blockHeight = (data ? data.lines.length : 1) * lineHeight;
      const textTop = activeNode.y - blockHeight / 2;
      // Selection / caret half-height scales with the node's font size
      // (10px at the 14px baseline).
      const caretHalf = Math.round(
        ((activeNode.fontSize ?? DEFAULT_FONT_SIZE) * 10) / DEFAULT_FONT_SIZE
      );

      // Selection highlight (per line, so it spans multi-line ranges).
      if (data && cursorPos !== selectionEnd) {
        const a = Math.min(cursorPos, selectionEnd);
        const b = Math.max(cursorPos, selectionEnd);
        for (let li = 0; li < data.lines.length; li++) {
          const lineStart = data.lineStarts[li];
          const lineEnd = lineStart + data.lines[li].length;
          const segStart = Math.max(a, lineStart);
          const segEnd = Math.min(b, lineEnd);
          if (segEnd <= segStart) continue;
          const offs = data.lineOffsets[li];
          const x1 = offs[segStart - lineStart] || 0;
          const x2 = offs[segEnd - lineStart] || 0;
          if (x2 <= x1) continue;
          const lineCenterY = textTop + li * lineHeight + lineHeight / 2;
          cursorLayer.add(
            new Konva.Rect({
              x: activeNode.x + nodePadding + x1,
              y: lineCenterY - caretHalf,
              width: x2 - x1,
              height: caretHalf * 2,
              fill: isRoot
                ? "rgba(255, 255, 255, 0.3)"
                : "rgba(16, 185, 129, 0.18)",
              listening: false,
            })
          );
        }
      }

      // Cursor line
      if (cursorVisible && cursorPos === selectionEnd) {
        const { line, col } = data
          ? posToLineCol(data, cursorPos)
          : { line: 0, col: 0 };
        const cursorX =
          activeNode.x + nodePadding + (data?.lineOffsets[line]?.[col] || 0);
        const lineCenterY = textTop + line * lineHeight + lineHeight / 2;
        cursorLayer.add(
          new Konva.Line({
            points: [
              cursorX,
              lineCenterY - caretHalf,
              cursorX,
              lineCenterY + caretHalf,
            ],
            stroke: isRoot ? "#ffffff" : "#0f172a",
            strokeWidth: 2,
            listening: false,
          })
        );
      }
    }

    cursorLayer.draw();
  }, [activeNodeId, editing, cursorPos, selectionEnd, cursorVisible, nodes]);

  // --- Paste / insert flash ---
  // A soft amber glow that blooms in and gently dissolves around just-inserted
  // nodes, so the destination reads at a glance without the harsh dashed
  // outline. Runs on its own layer with Konva tweens (see stage setup) so the
  // caret blink can't restart it mid-fade.
  useEffect(() => {
    const Konva = konvaRef.current;
    const flashLayer = flashLayerRef.current;
    if (!Konva || !flashLayer) return;

    flashLayer.destroyChildren();
    if (highlightIds.size === 0) {
      flashLayer.batchDraw();
      return;
    }

    const group = new Konva.Group({ opacity: 0, listening: false });
    const bloomTweens: any[] = [];

    for (const id of highlightIds) {
      const node = nodes.find((n) => n.id === id);
      if (!node) continue;
      const isRoot = nodes.indexOf(node) === 0;
      const rectWidth = nodeBoxWidth(node.width, isRoot);
      const rectHeight = node.height;
      const w = rectWidth + 12;
      const h = rectHeight + 12;
      // Position by centre so the bloom scales symmetrically about the node.
      const cx = node.x - 6 + w / 2;
      const cy = node.y - rectHeight / 2 - 6 + h / 2;
      const rect = new Konva.Rect({
        x: cx,
        y: cy,
        width: w,
        height: h,
        offsetX: w / 2,
        offsetY: h / 2,
        cornerRadius: 18,
        fill: "#f59e0b",
        opacity: 0.1,
        shadowColor: "#f59e0b",
        shadowBlur: 24,
        shadowOpacity: 0.5,
        scaleX: 0.92,
        scaleY: 0.92,
        listening: false,
      });
      group.add(rect);
      const bloom = new Konva.Tween({
        node: rect,
        duration: 0.34,
        scaleX: 1,
        scaleY: 1,
        easing: Konva.Easings.EaseOut,
      });
      bloomTweens.push(bloom);
    }

    flashLayer.add(group);

    let holdTimer: ReturnType<typeof setTimeout> | null = null;
    let fadeOut: any = null;
    const fadeIn = new Konva.Tween({
      node: group,
      duration: 0.24,
      opacity: 1,
      easing: Konva.Easings.EaseOut,
      onFinish: () => {
        // Linger briefly at full strength, then dissolve.
        holdTimer = setTimeout(() => {
          fadeOut = new Konva.Tween({
            node: group,
            duration: 0.66,
            opacity: 0,
            easing: Konva.Easings.EaseInOut,
          });
          fadeOut.play();
        }, 480);
      },
    });

    fadeIn.play();
    bloomTweens.forEach((t) => t.play());

    return () => {
      if (holdTimer) clearTimeout(holdTimer);
      fadeIn.destroy();
      fadeOut?.destroy();
      bloomTweens.forEach((t) => t.destroy());
      group.destroy();
      flashLayer.batchDraw();
    };
  }, [highlightIds, nodes]);

  // --- Test API (non-production): imperative hooks for browser e2e tests ---
  // Exposes the live model plus a "node select" helper that returns the screen
  // point at the middle of a node's text, so tests can issue a real click that
  // activates the node and exercises the click→focus path.
  useEffect(() => {
    if (import.meta.env.PROD) return;
    const api: MindmapTestApi = {
      getModel: () => stateRef.current.document.model,
      getActiveNodeId: () => stateRef.current.view.activeNodeId,
      getSelection: () => {
        const s = stateRef.current.view;
        return {
          activeNodeId: s.activeNodeId,
          cursorPos: s.cursorPos,
          selectionEnd: s.selectionEnd,
          editing: s.editing,
        };
      },
      getNodeClickPoint: (id: string) => {
        const node = nodesRef.current.find((n) => n.id === id);
        const stage = konvaStageRef.current;
        if (!node || !stage) return null;
        const scale = stage.scaleX();
        const data = lineDataRef.current.get(id);
        const textW = data ? lineDataWidth(data) || 40 : 40;
        const worldX = node.x + NODE_PADDING + textW / 2;
        const worldY = node.y;
        return { x: worldX * scale + stage.x(), y: worldY * scale + stage.y() };
      },
      getNodeRect: (id: string) => {
        const flat = nodesRef.current;
        const node = flat.find((n) => n.id === id);
        const stage = konvaStageRef.current;
        if (!node || !stage) return null;
        const scale = stage.scaleX();
        const w = nodeBoxWidth(node.width, flat[0]?.id === id);
        const h = nodeBoxHeight(node.height);
        return {
          x: node.x * scale + stage.x(),
          y: (node.y - h / 2) * scale + stage.y(),
          width: w * scale,
          height: h * scale,
        };
      },
      getRedrawStats: () => ({ ...perfRef.current }),
      resetRedrawStats: () => {
        perfRef.current = {
          redrawCount: 0,
          redrawTotalMs: 0,
          redrawLastMs: 0,
          redrawDrawMs: 0,
        };
      },
    };
    window.__mindmapTest = api;
    return () => {
      if (window.__mindmapTest === api) delete window.__mindmapTest;
    };
  }, []);

  // Global command-palette handler (when the hidden input is not focused).
  // Cmd/Ctrl+K avoids clobbering the browser's native Cmd/Ctrl+P (print).
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setCmdPaletteOpen(true);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  return (
    <div className="flex flex-col h-full">
      <CommandPalette
        commands={commands}
        open={cmdPaletteOpen}
        onClose={() => {
          setCmdPaletteOpen(false);
          focusEditorSoon();
        }}
      />
      <ShortcutHelp
        bindings={keymap}
        open={helpOpen}
        onClose={() => {
          setHelpOpen(false);
          focusEditorSoon();
        }}
      />
      <MarkdownPasteDialog
        open={mdPaste !== null}
        preview={mdPaste ? markdownPreview(mdPaste.text, 6) : undefined}
        onDecompose={() => applyMarkdownPaste("decompose")}
        onAsNode={() => applyMarkdownPaste("node")}
        onPlain={() => applyMarkdownPaste("plain")}
        onCancel={() => {
          setMdPaste(null);
          setTimeout(() => inputRef.current?.focus(), 0);
        }}
      />
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
      <header className="anim-header flex h-14 items-center justify-between gap-3 border-b border-slate-200 bg-white px-4 md:px-6">
        <div className="flex items-center gap-3 min-w-0">
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
              onChange={handleTitleChange}
              onBlur={() => {
                setEditingTitle(false);
                if (noteId) saveNote(model);
              }}
              onKeyDown={(e) => {
                // Enter/Escape while an IME composition is active confirm or
                // cancel the conversion — don't end title editing then.
                if (e.nativeEvent.isComposing) return;
                if (e.key === "Enter" || e.key === "Escape") {
                  e.currentTarget.blur();
                }
              }}
              className="h-9 min-w-0 rounded-lg border border-slate-300 bg-white px-2 text-lg font-bold tracking-tight outline-none focus:border-emerald-500 focus:ring-2 focus:ring-emerald-100"
              placeholder="タイトル（ルートノード）"
            />
          ) : (
            <button
              onClick={() => setEditingTitle(true)}
              className="flex min-w-0 items-center gap-2 rounded-lg px-1 text-left hover:bg-slate-100"
              title="タイトルを編集"
            >
              <span className="truncate text-lg font-bold tracking-tight">
                {title || "無題"}
              </span>
              <span className="text-slate-400">✎</span>
            </button>
          )}
        </div>
        {noteId && (
          <div className="flex items-center gap-4 text-sm">
            <span
              ref={saveStatusRef}
              className="whitespace-nowrap text-slate-500"
            />
            <PublicityDropdown
              isPublic={isPublic}
              onChange={(next) => {
                setIsPublic(next);
                saveNote(model, next);
              }}
            />
          </div>
        )}
        {!noteId && onSaveToAccount && (
          <div className="flex items-center gap-3 text-sm">
            <button
              onClick={handleSaveToAccount}
              className="whitespace-nowrap rounded-xl bg-emerald-600 px-4 py-2 font-semibold text-white shadow-sm transition hover:bg-emerald-700"
            >
              アカウントに保存
            </button>
          </div>
        )}
      </header>
      <div className="flex-1 relative overflow-hidden bg-slate-50">
        <div
          ref={canvasRef}
          data-testid="mm-canvas"
          className="absolute inset-0 [background-size:20px_20px]"
        />
        <textarea
          ref={inputRef}
          value={editingText}
          rows={1}
          wrap="off"
          onChange={handleInputChange}
          onKeyDown={handleKeyDown}
          onSelect={handleSelect}
          onCopy={handleCopy}
          onCut={handleCut}
          onPaste={handlePaste}
          onCompositionStart={() => {
            setIsComposing(true);
            isComposingRef.current = true;
          }}
          onCompositionEnd={handleCompositionEnd}
          style={{
            position: "absolute",
            left: `${inputPos.x}px`,
            top: `${inputPos.y}px`,
            // Must stay large enough for the browser to compute real caret
            // geometry internally — a near-zero size (e.g. 1px) breaks native
            // keyboard navigation (Home/End/Arrow) in some browsers even
            // though the element is invisible (opacity 0) either way.
            width: "40px",
            height: "24px",
            opacity: 0,
            pointerEvents: "none",
            caretColor: "transparent",
            resize: "none",
            fontSize: "14px",
          }}
        />
        {/* Visible URL editor for image/link nodes: the canvas keeps drawing
            the node's preview while this box below it edits the URL. Enter /
            Escape close it and hand the keyboard back to the hidden textarea
            (via the urlEditing focus effect). */}
        {urlEditing && urlBoxPos && (
          <input
            ref={urlInputRef}
            data-testid="mm-url-input"
            type="text"
            inputMode="url"
            autoFocus
            value={editingText}
            onChange={handleUrlChange}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === "Escape") {
                e.preventDefault();
                dispatch({ type: "exitEditing" });
              }
            }}
            placeholder={
              activeModelNode?.type === "image" ? "画像のURL" : "リンクのURL"
            }
            className="absolute z-10 rounded-lg border border-slate-300 bg-white px-2 py-1 text-sm text-slate-900 shadow-md outline-none focus:border-emerald-500 focus:ring-2 focus:ring-emerald-100"
            style={{
              left: `${urlBoxPos.x}px`,
              top: `${urlBoxPos.y}px`,
              width: `${urlBoxPos.width}px`,
            }}
          />
        )}
        <input
          ref={imageFileInputRef}
          type="file"
          accept="image/*"
          style={{ display: "none" }}
          onChange={async (e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            const nodeId = uploadTargetRef.current;
            uploadTargetRef.current = null;
            if (file && nodeId) await uploadAndSetImage(nodeId, file);
          }}
        />
        {contextMenu && (
          <ContextMenu
            x={contextMenu.x}
            y={contextMenu.y}
            items={contextMenuItems}
            onClose={() => {
              setContextMenu(null);
              focusEditorSoon();
            }}
          />
        )}
      </div>
    </div>
  );
}

/**
 * Standalone mind-map editor: owns its own editing engine. Used directly by the
 * guest editor and the browser tests. The responsive {@link NoteEditor} wrapper
 * instead lifts the engine so it can share it with the mobile outline view.
 */
export default function MindmapEditor(props: Props) {
  const engine = useNoteEditor(props);
  return (
    <MindmapEditorView
      engine={engine}
      embed={props.embed}
      onSaveToAccount={props.onSaveToAccount}
    />
  );
}
