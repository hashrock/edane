import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { Link, router } from "@inertiajs/react";
import type { MindMapNode } from "../application/nodeUtils";
import type { MindMapModel } from "../domain/model";
import { findNode, cloneWithNewIds } from "../domain/model";
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
} from "../application/nodeUtils";
import ContextMenu, { type ContextMenuItem } from "./ContextMenu";
import {
  parseContent,
  serializeModel,
  modelToText,
  textToModel,
} from "../application/persistence";
import CommandPalette from "./CommandPalette";
import type { Command } from "./CommandPalette";
import ShortcutHelp from "./ShortcutHelp";
import ConfirmDialog from "./ConfirmDialog";
import {
  editorReducer,
  type EditorState,
  type EditorAction,
} from "../application/editorReducer";
import {
  buildKeymap,
  runKeymap,
  activeNode,
  type KeyBinding,
} from "../application/editorKeymap";
import { UndoManager } from "../application/undoManager";

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
const NODE_PADDING = 20;

// Screen-space distance (px) the pointer must travel after mousedown before a
// press turns into a drag-select. Below this a small jitter stays a plain click
// so selection doesn't jump to a neighbouring (e.g. same-Y parent) node.
const DRAG_THRESHOLD = 4;

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

/**
 * Visual box width for a measured text/content width: add horizontal padding,
 * then floor (roots a little wider). Keeps every node-box width derivation in
 * one place so the draw never re-implements per-kind sizing.
 */
function nodeBoxWidth(measuredWidth: number, isRoot: boolean): number {
  return Math.max(measuredWidth + NODE_PADDING * 2, isRoot ? 100 : 80);
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

export default function MindmapEditor({
  noteId,
  initialContent,
  initialTitle,
  initialIsPublic,
  embed,
  onSaveToAccount,
}: Props) {
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

  // Derived views of the editor state (keeps downstream code/deps unchanged)
  const {
    document: { model },
    view: { activeNodeId, editing, editingText, cursorPos, selectionEnd },
  } = state;

  // --- UI-only state (not part of the editing document) ---
  const [isPublic, setIsPublic] = useState(initialIsPublic || false);
  const [cmdPaletteOpen, setCmdPaletteOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [editingTitle, setEditingTitle] = useState(false);
  const [isComposing, setIsComposing] = useState(false);
  const [cursorVisible, setCursorVisible] = useState(true);
  const [konvaReady, setKonvaReady] = useState(false);
  // Transient highlight of just-inserted nodes (paste / child add) so the
  // insertion position is obvious. Cleared after a short delay.
  const [highlightIds, setHighlightIds] = useState<Set<string>>(new Set());
  const [inputPos, setInputPos] = useState<{ x: number; y: number }>({
    x: 0,
    y: 0,
  });
  // Right-click context menu over a node (null = closed).
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    nodeId: string;
  } | null>(null);
  // A navigation was attempted while a save was failing; ask before leaving so
  // an unsaved edit isn't dropped. Holds the pending Inertia visit to resume.
  const [leaveConfirm, setLeaveConfirm] = useState<{
    url: string | URL;
    method: "get" | "post" | "put" | "patch" | "delete";
  } | null>(null);

  // Refs
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const imageFileInputRef = useRef<HTMLInputElement>(null);
  const uploadTargetRef = useRef<string | null>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const konvaStageRef = useRef<any>(null);
  const layerRef = useRef<any>(null);
  const cursorLayerRef = useRef<any>(null);
  const konvaRef = useRef<any>(null);
  const saveTimerRef = useRef<any>(null);
  // Serialized content last confirmed persisted. The server just handed us the
  // initial model, so that's our clean baseline; every successful save advances
  // it. `isDirty()` compares the live model against this.
  const lastSavedContentRef = useRef<string>(serializeModel(model));
  // Set true just before re-issuing a visit we already flushed, so the
  // navigation guard lets that one visit pass through instead of re-flushing.
  const bypassNavGuardRef = useRef(false);
  const updateGridRef = useRef<() => void>(() => {});
  const saveStatusRef = useRef<HTMLSpanElement>(null);
  const lineDataRef = useRef<Map<string, LineData>>(new Map());
  const dragStateRef = useRef<{
    nodeId: string;
    anchorCharIdx: number;
    // Screen-space pointer position at mousedown, used to distinguish a click
    // (with minor jitter) from an intentional drag-select.
    startX: number;
    startY: number;
    // Flips true once the pointer moves past DRAG_THRESHOLD; from then on every
    // move is treated as a drag even if it dips back under the threshold.
    moved: boolean;
  } | null>(null);
  const wasDraggingRef = useRef(false);
  const undoManagerRef = useRef(new UndoManager());
  const highlightTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isComposingRef = useRef(false);
  // Non-production perf counters for the (expensive) main canvas redraw.
  const perfRef = useRef({
    redrawCount: 0,
    redrawTotalMs: 0,
    redrawLastMs: 0,
    redrawDrawMs: 0,
  });
  const modelRef = useRef(model);
  modelRef.current = model;

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

  // Re-render when an image-node's image finishes loading (size becomes known).
  const [imageVersion, setImageVersion] = useState(0);
  useEffect(
    () => subscribeImages(() => setImageVersion((v) => v + 1)),
    []
  );

  // Derived: flat nodes with layout. Only while a caret is active (editing) is
  // the node sized as text from the live buffer, so image/link nodes grow to fit
  // the URL you type. When merely selected, they keep their real (image/link)
  // size so the layout box matches what's drawn.
  const nodes = useMemo(() => {
    const flat = flattenToNodes(
      model,
      editing && activeNodeId ? { id: activeNodeId, text: editingText } : undefined
    );
    if (flat.length > 0) layoutMindMap(flat);
    return flat;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model, editing, activeNodeId, editingText, imageVersion]);
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;

  // Title = root node text
  const title = model.text;

  // --- Save ---
  const updateSaveStatus = useCallback((status: string) => {
    if (saveStatusRef.current) saveStatusRef.current.textContent = status;
  }, []);

  const saveNote = useCallback(
    async (currentModel: MindMapModel, pub?: boolean): Promise<boolean> => {
      if (!noteId) return true;
      const content = serializeModel(currentModel);
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
          // Remember exactly what we persisted so isDirty() goes clean until
          // the next edit (avoids false "unsaved" prompts on navigation).
          lastSavedContentRef.current = content;
          updateSaveStatus("保存済み");
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

  // Debounced auto-save
  useEffect(() => {
    if (!noteId) return;
    // Reflect the pending edit immediately so the header shows the note isn't
    // persisted yet (the save itself flips this to 保存中... → 保存済み).
    if (isDirty()) updateSaveStatus("未保存");
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => saveNote(model), 1500);
    return () => {
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

  // --- Cursor blink ---
  useEffect(() => {
    if (!activeNodeId) return;
    setCursorVisible(true);
    const interval = setInterval(() => setCursorVisible((v) => !v), 530);
    return () => clearInterval(interval);
  }, [activeNodeId, cursorPos, editingText]);

  // --- Undo manager: commit pending text using the latest state ---
  useEffect(() => {
    undoManagerRef.current.setCommitCallback(() => stateRef.current.document);
  }, []);

  // --- Sync the hidden input to the editor state (single place) ---
  // Replaces the scattered value/setSelectionRange/focus calls.
  useEffect(() => {
    const el = inputRef.current;
    if (!el || isComposingRef.current) return;
    if (el.value !== editingText) el.value = editingText;
    el.setSelectionRange(cursorPos, selectionEnd);
    if (activeNodeId) el.focus();
  }, [editingText, cursorPos, selectionEnd, activeNodeId]);

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
        const text = e.clipboardData.getData("text");
        if (!text) return;
        e.preventDefault();
        pasteTextAsNodes(text);
        return;
      }

      // Editing mode: multi-line external text becomes nodes; single-line text
      // is left to the native textarea.
      const text = e.clipboardData.getData("text");
      if (!text || !text.includes("\n")) return;
      e.preventDefault();
      pasteTextAsNodes(text);
    },
    [dispatch, pasteTextAsNodes, flashNodes, noteId, saveNote]
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
    const items: ContextMenuItem[] = [];

    // Link: jump to the URL (single click edits, so open lives in the menu).
    if (type === "link" && node.text) {
      items.push({
        label: "リンクを開く",
        onSelect: () => window.open(node.text, "_blank", "noopener"),
      });
    }

    // Kind conversion (root excluded — it's the note title).
    if (!isRoot) {
      const setType = (nodeType: "text" | "image" | "link") => () => {
        const next = dispatch(
          { type: "setNodeType", nodeId, nodeType },
          "set-type"
        );
        if (noteId) saveNote(next.document.model);
        setTimeout(() => inputRef.current?.focus(), 0);
      };
      if (type !== "text") items.push({ label: "テキストにする", onSelect: setType("text") });
      if (type !== "image") items.push({ label: "画像にする（URL）", onSelect: setType("image") });
      if (type !== "link") items.push({ label: "リンクにする（URL）", onSelect: setType("link") });
    }

    // Text formatting (font size / bold).
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
        items.push({
          label: "文字を大きく",
          onSelect: () => applyStyle({ fontSize: bigger }),
        });
      if (smaller !== undefined)
        items.push({
          label: "文字を小さく",
          onSelect: () => applyStyle({ fontSize: smaller }),
        });
      if (node.fontSize !== undefined && node.fontSize !== DEFAULT_FONT_SIZE)
        items.push({
          label: "標準サイズに戻す",
          onSelect: () => applyStyle({ fontSize: null }),
        });
      items.push({
        label: node.bold ? "太字を解除" : "太字にする",
        onSelect: () => applyStyle({ bold: !node.bold }),
      });
    }

    // Link metadata fetch (title + favicon).
    if (type === "link" && node.text) {
      items.push({
        label: "リンク情報を取得（タイトル/favicon）",
        onSelect: () => fetchLinkMeta(nodeId),
      });
    }

    // Image upload (R2). Replaces the node's content with the uploaded image.
    if (!isRoot) {
      items.push({
        label: "画像をアップロード",
        onSelect: () => triggerImageUpload(nodeId),
      });
    }

    if (hasChildren) {
      items.push({
        label: node.collapsed ? "展開する" : "折りたたむ",
        onSelect: () => {
          const next = dispatch({ type: "toggleCollapse", nodeId }, "collapse");
          if (noteId) saveNote(next.document.model);
        },
      });
    }
    items.push({
      label: "子ノードを追加",
      onSelect: () => {
        const next = dispatch({ type: "addChild", nodeId }, "add-child");
        if (next.view.activeNodeId) flashNodes([next.view.activeNodeId]);
        if (noteId) saveNote(next.document.model);
        setTimeout(() => inputRef.current?.focus(), 0);
      },
    });
    items.push({
      label: "枝をテキストコピー",
      onSelect: () => {
        navigator.clipboard.writeText(modelToText(node));
      },
    });
    if (!isRoot) {
      items.push({
        label: "ノードを削除",
        danger: true,
        onSelect: () => {
          const next = dispatch({ type: "deleteNode", nodeId }, "delete-node");
          if (noteId) saveNote(next.document.model);
        },
      });
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
  // Undo/redo restore only the document; the current selection/caret (view
  // state) is carried over as-is. The `replace` reducer reconciles it against
  // the restored document, so if the active node no longer exists there it
  // falls back to the root instead of dangling (which would silently no-op
  // every subsequent keyboard action).
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
        undo: () => restoreDocument(undoManagerRef.current.undo()),
        redo: () => restoreDocument(undoManagerRef.current.redo()),
        verticalMove,
      }),
    [dispatch, saveNote, restoreDocument]
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

      // Keep the CSS dot grid in sync with stage pan/zoom
      const GRID = 20;
      const updateGrid = () => {
        const scale = stage.scaleX();
        const size = GRID * scale;
        container.style.backgroundSize = `${size}px ${size}px`;
        container.style.backgroundPosition = `${stage.x()}px ${stage.y()}px`;
      };
      updateGridRef.current = updateGrid;
      updateGrid();
      stage.on("dragmove", updateGrid);

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
        layer.draw();
        updateGrid();
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

      // Drag within a node selects a text range. Selection stays on the node
      // the drag started on — it never crosses to another node.
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
        if (dragStateRef.current) {
          wasDraggingRef.current = true;
          dragStateRef.current = null;
          stage.draggable(true);
        }
      });

      const resizeObserver = new ResizeObserver(() => {
        stage.width(container.clientWidth);
        stage.height(container.clientHeight);
        layer.draw();
      });
      resizeObserver.observe(container);

      // Signal that Konva is ready so the redraw effect can fire
      setKonvaReady(true);
    });

    return () => {
      if (konvaStageRef.current) {
        konvaStageRef.current.destroy();
        konvaStageRef.current = null;
        layerRef.current = null;
        cursorLayerRef.current = null;
      }
    };
  }, [dispatch]);

  // --- Auto-scroll to active node ---
  useEffect(() => {
    const stage = konvaStageRef.current;
    if (!stage || !activeNodeId) return;

    const activeNode = nodes.find((n) => n.id === activeNodeId);
    if (!activeNode) return;

    const scale = stage.scaleX();
    const stageWidth = stage.width();
    const stageHeight = stage.height();
    const nodeWidth = 200;
    const nodeHeight = 32;
    const padding = 50;

    const nodeScreenX = activeNode.x * scale + stage.x();
    const nodeScreenY = (activeNode.y - nodeHeight / 2) * scale + stage.y();
    const nodeScreenWidth = nodeWidth * scale;
    const nodeScreenHeight = nodeHeight * scale;

    const isVisible =
      nodeScreenX >= padding &&
      nodeScreenX + nodeScreenWidth <= stageWidth - padding &&
      nodeScreenY >= padding &&
      nodeScreenY + nodeScreenHeight <= stageHeight - padding;

    if (!isVisible) {
      let targetX = stage.x();
      let targetY = stage.y();

      if (nodeScreenX < padding) {
        targetX = padding - activeNode.x * scale;
      } else if (nodeScreenX + nodeScreenWidth > stageWidth - padding) {
        targetX = stageWidth - padding - (activeNode.x + nodeWidth) * scale;
      }

      if (nodeScreenY < padding) {
        targetY = padding - (activeNode.y - nodeHeight / 2) * scale;
      } else if (nodeScreenY + nodeScreenHeight > stageHeight - padding) {
        targetY =
          stageHeight - padding - (activeNode.y + nodeHeight / 2) * scale;
      }

      stage.x(targetX);
      stage.y(targetY);
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

  // --- Redraw canvas ---
  useEffect(() => {
    const Konva = konvaRef.current;
    const layer = layerRef.current;
    if (!Konva || !layer || nodes.length === 0) return;

    const perfStart = import.meta.env.PROD ? 0 : performance.now();

    layer.destroyChildren();

    const nodeMap: Record<string, MindMapNode> = {};
    nodes.forEach((n) => (nodeMap[n.id] = n));

    // Pre-calculate per-node line data + widths (cached, see top of file).
    const textWidths = new Map<string, number>();
    const lineDataMap = new Map<string, LineData>();
    const nodePadding = NODE_PADDING;

    nodes.forEach((node) => {
      // For active node during editing, use editingText
      const displayRaw = activeNodeId === node.id ? editingText : node.text;
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

    // Draw connections
    nodes.forEach((node) => {
      node.children.forEach((childId) => {
        const child = nodeMap[childId];
        if (!child) return;
        const parentWidth = textWidths.get(node.id) || 100;
        const startX = node.x + parentWidth + 40;
        const startY = node.y;
        const endX = child.x;
        const endY = child.y;
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
      const isRoot = index === 0;
      // isEditing = caret/text-input active; isSelected = node highlighted but
      // not being edited (single click). A selected node renders like any other
      // (link title, stored format) with just an accent outline.
      const isEditing = editing && activeNodeId === node.id;
      const isSelected = !editing && activeNodeId === node.id;
      // The edited node shows raw text (image/link nodes show their URL while
      // editing) but still honours its stored font size / weight, so the text
      // doesn't visually jump when entering or leaving edit mode.
      const asImage = !isEditing && node.type === "image";
      const asLink = !isEditing && node.type === "link";
      // Links display their fetched title (falling back to the raw URL).
      const displayRaw = isEditing
        ? editingText
        : asLink
          ? node.linkTitle || node.text
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

      // Box geometry from a single measured size. While editing it follows the
      // caret's own line measurement (so the caret can't overflow the box);
      // otherwise it trusts node.width/height from measureModelNode — image,
      // link and text are all sized there, so there's no per-kind branch here.
      let rectWidth: number;
      let rectHeight: number;
      if (isEditing) {
        const textWidth = textWidths.get(node.id) || 100;
        rectWidth = nodeBoxWidth(textWidth, isRoot);
        rectHeight = Math.max(32, blockHeight + 14);
      } else {
        rectWidth = nodeBoxWidth(node.width, isRoot);
        rectHeight = Math.max(32, node.height);
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
            : isEmpty
              ? "#f8fafc"
              : "#ffffff",
        stroke:
          isEditing || isSelected
            ? "#000000"
            : isRoot
              ? "#0f172a"
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
              : isEmpty
                ? "#94a3b8"
                : "#0f172a",
          fontStyle: isEmpty ? "italic" : bold ? "bold" : "normal",
          textDecoration: asLink ? "underline" : "",
          listening: false,
        });
        group.add(textNode);
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
        if (asImage || asLink) {
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

        // Start drag selection (anchored at the clicked caret position). The
        // drag only becomes "real" once the pointer moves past DRAG_THRESHOLD;
        // until then it's a plain click and selection stays on this node.
        dragStateRef.current = {
          nodeId: node.id,
          anchorCharIdx: charIdx,
          startX: pointer.x,
          startY: pointer.y,
          moved: false,
        };
        if (stage) stage.draggable(false);

        // Focus the hidden input in a macrotask so it survives the click
        // event's default focus handling (mousedown → mouseup → click are
        // separate tasks; the click default would otherwise blur the input,
        // overriding the focus applied by the input-sync effect).
        setTimeout(() => inputRef.current?.focus(), 0);
      });

      // Double-click → select all text
      group.on("dblclick dbltap", () => {
        dispatch({ type: "selectAllInNode", nodeId: node.id });
        setTimeout(() => inputRef.current?.focus(), 0);
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
  }, [nodes, activeNodeId, editing, editingText, konvaReady, dispatch]);

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

    // Transient insertion highlight: dashed amber outline around just-inserted
    // nodes (paste / add-child) so the destination is obvious.
    if (highlightIds.size > 0) {
      for (const id of highlightIds) {
        const node = nodes.find((n) => n.id === id);
        if (!node) continue;
        const isRoot = nodes.indexOf(node) === 0;
        const rectWidth = nodeBoxWidth(node.width, isRoot);
        const rectHeight = node.height;
        cursorLayer.add(
          new Konva.Rect({
            x: node.x - 4,
            y: node.y - rectHeight / 2 - 4,
            width: rectWidth + 8,
            height: rectHeight + 8,
            cornerRadius: 14,
            stroke: "#f59e0b",
            strokeWidth: 2.5,
            dash: [6, 4],
            listening: false,
          })
        );
      }
    }

    if (editing) {
      // Caret + in-node text selection — only while editing. A merely selected
      // node is shown with the accent outline drawn on the main layer.
      const activeNode = nodes.find((n) => n.id === activeNodeId);
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
  }, [activeNodeId, editing, cursorPos, selectionEnd, cursorVisible, nodes, highlightIds]);

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
          setTimeout(() => inputRef.current?.focus(), 0);
        }}
      />
      <ShortcutHelp
        bindings={keymap}
        open={helpOpen}
        onClose={() => {
          setHelpOpen(false);
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
            <>
              <Link
                href="/notes"
                className="text-sm font-medium text-emerald-700 hover:text-emerald-800 whitespace-nowrap"
              >
                ← 一覧
              </Link>
              <div className="h-6 w-px bg-slate-200" />
            </>
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
          {noteId && (
            <span
              className={`whitespace-nowrap rounded-full px-2.5 py-1 text-xs font-medium ${isPublic ? "bg-emerald-50 text-emerald-700" : "bg-slate-100 text-slate-600"}`}
            >
              {isPublic ? "公開" : "非公開"}
            </span>
          )}
        </div>
        {noteId && (
          <div className="flex items-center gap-4 text-sm">
            <span
              ref={saveStatusRef}
              className="whitespace-nowrap text-slate-500"
            />
            <label className="flex cursor-pointer items-center gap-2 whitespace-nowrap rounded-xl border border-slate-200 bg-white px-3 py-2 font-medium text-slate-700 hover:bg-slate-50">
              <input
                type="checkbox"
                className="h-4 w-4 accent-emerald-600"
                checked={isPublic}
                onChange={(e) => {
                  const newVal = e.target.checked;
                  setIsPublic(newVal);
                  saveNote(model, newVal);
                }}
              />
              公開する
            </label>
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
          className="absolute inset-0 bg-[radial-gradient(#dbe2ea_1px,transparent_1px)] [background-size:20px_20px]"
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
              setTimeout(() => inputRef.current?.focus(), 0);
            }}
          />
        )}
      </div>
    </div>
  );
}
