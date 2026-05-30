import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { Link } from "@inertiajs/react";
import type { MindMapNode } from "../types/MindMap";
import type { MindMapModel } from "../domain/model";
import { findNode, getFlatOrder, generateId } from "../domain/model";
import { layoutMindMap } from "../lib/treeLayout";
import { LINE_HEIGHT } from "../lib/measureText";
import { flattenToNodes } from "../application/nodeUtils";
import ContextMenu, { type ContextMenuItem } from "./ContextMenu";
import {
  parseContent,
  serializeModel,
  modelToText,
  textToModel,
} from "../application/persistence";
import CommandPalette from "./CommandPalette";
import type { Command } from "./CommandPalette";
import {
  editorReducer,
  isMultiNodeSelection,
  type EditorState,
  type EditorAction,
} from "../application/editorReducer";
import { UndoManager } from "../application/undoManager";
import { selectionNodesToText } from "../application/clipboard";

// --- Text measurement (cached) ---
// The canvas redraw needs each node's width and per-character cursor offsets.
// Measuring via Konva.Text objects is very expensive (one object per character,
// for every node, on every redraw). Instead we measure with a single shared 2D
// context and cache offsets per text string — only the actively edited node's
// text changes per keystroke, so every other node is an O(1) cache hit.
const NODE_FONT = "14px sans-serif";
const NODE_FONT_ITALIC = "italic 14px sans-serif";
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

/** Cumulative prefix widths for `text`: [0, w(c0), w(c0c1), …, fullWidth]. */
function measureOffsets(text: string): number[] {
  const cached = _offsetCache.get(text);
  if (cached) return cached;
  const ctx = getMeasureCtx();
  const offsets: number[] = [0];
  if (ctx) {
    for (let i = 0; i < text.length; i++) {
      offsets.push(ctx.measureText(text.slice(0, i + 1)).width);
    }
  } else {
    for (let i = 0; i < text.length; i++) offsets.push((i + 1) * 8);
  }
  if (_offsetCache.size > 4000) _offsetCache.clear();
  _offsetCache.set(text, offsets);
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
// Konva's lineHeight is a multiple of fontSize (14px), so LINE_HEIGHT/14 gives
// us the same px line box pretext used to measure node height.
const KONVA_LINE_HEIGHT = LINE_HEIGHT / 14;
const NODE_PADDING = 20;

interface LineData {
  lines: string[];
  /** Per-line cumulative char x-offsets (from measureOffsets). */
  lineOffsets: number[][];
  /** Absolute start index of each line in the full string. */
  lineStarts: number[];
}

/** Split node text into lines and pre-measure each line's caret offsets. */
function buildLineData(text: string): LineData {
  const lines = text.split("\n");
  const lineOffsets = lines.map((l) => measureOffsets(l));
  const lineStarts: number[] = [];
  let acc = 0;
  for (let i = 0; i < lines.length; i++) {
    lineStarts[i] = acc;
    acc += lines[i].length + 1; // +1 for the consumed "\n"
  }
  return { lines, lineOffsets, lineStarts };
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
  /** Current selection state (focus + multi-node anchor). */
  getSelection: () => {
    activeNodeId: string | null;
    cursorPos: number;
    selectionEnd: number;
    selAnchorNodeId: string | null;
    selAnchorOffset: number;
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
}

export default function MindmapEditor({
  noteId,
  initialContent,
  initialTitle,
  initialIsPublic,
}: Props) {
  // --- Single source of truth: the full editor state ---
  const [state, setStateRaw] = useState<EditorState>(() => ({
    model: parseContent(initialContent, initialTitle),
    activeNodeId: null,
    editingText: "",
    cursorPos: 0,
    selectionEnd: 0,
    selAnchorNodeId: null,
    selAnchorOffset: 0,
  }));
  const stateRef = useRef(state);
  stateRef.current = state;

  // Derived views of the editor state (keeps downstream code/deps unchanged)
  const {
    model,
    activeNodeId,
    editingText,
    cursorPos,
    selectionEnd,
    selAnchorNodeId,
    selAnchorOffset,
  } = state;

  // --- UI-only state (not part of the editing document) ---
  const [isPublic, setIsPublic] = useState(initialIsPublic || false);
  const [cmdPaletteOpen, setCmdPaletteOpen] = useState(false);
  const [editingTitle, setEditingTitle] = useState(false);
  const [isComposing, setIsComposing] = useState(false);
  const [cursorVisible, setCursorVisible] = useState(true);
  const [konvaReady, setKonvaReady] = useState(false);
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

  // Refs
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const konvaStageRef = useRef<any>(null);
  const layerRef = useRef<any>(null);
  const cursorLayerRef = useRef<any>(null);
  const konvaRef = useRef<any>(null);
  const saveTimerRef = useRef<any>(null);
  const updateGridRef = useRef<() => void>(() => {});
  const saveStatusRef = useRef<HTMLSpanElement>(null);
  const lineDataRef = useRef<Map<string, LineData>>(new Map());
  const dragStateRef = useRef<{
    nodeId: string;
    anchorCharIdx: number;
  } | null>(null);
  const wasDraggingRef = useRef(false);
  const undoManagerRef = useRef(new UndoManager());
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
      if (undoType) undoManagerRef.current.push(undoType, prev, next);
      stateRef.current = next;
      setStateRaw(next);
      return next;
    },
    []
  );

  // Derived: flat nodes with layout
  const nodes = useMemo(() => {
    const flat = flattenToNodes(model);
    if (flat.length > 0) layoutMindMap(flat);
    return flat;
  }, [model]);
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;

  // Title = root node text
  const title = model.text;

  // --- Save ---
  const updateSaveStatus = useCallback((status: string) => {
    if (saveStatusRef.current) saveStatusRef.current.textContent = status;
  }, []);

  const saveNote = useCallback(
    async (currentModel: MindMapModel, pub?: boolean) => {
      if (!noteId) return;
      updateSaveStatus("保存中...");
      try {
        const res = await fetch(`/api/notes/${noteId}`, {
          method: "PUT",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            content: serializeModel(currentModel),
            title: currentModel.text,
            isPublic: pub ?? isPublic,
          }),
        });
        updateSaveStatus(res.ok ? "保存済み" : "保存失敗");
      } catch {
        updateSaveStatus("保存失敗");
      }
    },
    [noteId, isPublic, updateSaveStatus]
  );

  // Debounced auto-save
  useEffect(() => {
    if (!noteId) return;
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => saveNote(model), 1500);
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    };
  }, [model, noteId, saveNote]);

  // --- Cursor blink ---
  useEffect(() => {
    if (!activeNodeId) return;
    setCursorVisible(true);
    const interval = setInterval(() => setCursorVisible((v) => !v), 530);
    return () => clearInterval(interval);
  }, [activeNodeId, cursorPos, editingText]);

  // --- Undo manager: commit pending text using the latest state ---
  useEffect(() => {
    undoManagerRef.current.setCommitCallback(() => stateRef.current);
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
      undoManagerRef.current.handleTextChange(stateRef.current);
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
    if (!el || !stateRef.current.activeNodeId) return;
    const finalText = el.value;
    const pos = el.selectionStart ?? finalText.length;
    const end = el.selectionEnd ?? pos;
    undoManagerRef.current.handleTextChange(stateRef.current);
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

  // --- Clipboard ---
  // Insert indented plain text as fresh nodes after the active node.
  const pasteTextAsNodes = useCallback(
    (clipText: string) => {
      if (!clipText.trim()) return;
      const cur = stateRef.current;
      const targetId = cur.activeNodeId || cur.model.id;
      const parsed = textToModel("_", clipText);
      const reId = (n: MindMapModel): MindMapModel => ({
        id: generateId(),
        text: n.text,
        children: n.children.map(reId),
      });
      const freshChildren = parsed.children.map(reId);
      if (freshChildren.length === 0) return;
      const next = dispatch(
        { type: "insertNodes", targetId, nodes: freshChildren },
        "paste"
      );
      if (noteId) saveNote(next.model);
    },
    [dispatch, noteId, saveNote]
  );

  const handleCopy = useCallback((e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const st = stateRef.current;
    if (isMultiNodeSelection(st)) {
      // Multi-node selection: copy the selected nodes as indented text.
      e.preventDefault();
      e.clipboardData.setData("text/plain", selectionNodesToText(st));
    } else if (st.activeNodeId && st.cursorPos === st.selectionEnd) {
      // Collapsed caret: copy the whole current node's text.
      e.preventDefault();
      e.clipboardData.setData("text/plain", st.editingText);
    }
    // Otherwise (in-node text selection): let the input copy natively.
  }, []);

  const handleCut = useCallback(
    (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
      const st = stateRef.current;
      if (isMultiNodeSelection(st)) {
        e.preventDefault();
        e.clipboardData.setData("text/plain", selectionNodesToText(st));
        dispatch({ type: "deleteSelectedNodes" }, "delete-nodes");
      }
      // Otherwise: native cut of the in-node text selection.
    },
    [dispatch]
  );

  const handlePaste = useCallback(
    (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
      const text = e.clipboardData.getData("text");
      if (!text) return;
      const st = stateRef.current;
      const multi = isMultiNodeSelection(st);

      // Plain single-line paste with no multi-node selection: let the input
      // handle it natively (no clipboard permission needed).
      if (!text.includes("\n") && !multi) return;

      e.preventDefault();
      if (multi) dispatch({ type: "deleteSelectedNodes" }, "delete-nodes");

      if (text.includes("\n")) {
        pasteTextAsNodes(text);
        return;
      }
      // Single line replacing a (now collapsed) multi-node selection.
      const s2 = stateRef.current;
      if (!s2.activeNodeId) return;
      const a = Math.min(s2.cursorPos, s2.selectionEnd);
      const b = Math.max(s2.cursorPos, s2.selectionEnd);
      const newText = s2.editingText.slice(0, a) + text + s2.editingText.slice(b);
      dispatch(
        {
          type: "typeText",
          text: newText,
          cursorPos: a + text.length,
          selectionEnd: a + text.length,
          commitModel: true,
        },
        "paste-text"
      );
    },
    [dispatch, pasteTextAsNodes]
  );

  // --- Command palette ---
  const commands = useMemo<Command[]>(() => {
    const copyAllText = () => {
      const text = modelToText(stateRef.current.model);
      navigator.clipboard.writeText(text);
    };
    const copyBranch = () => {
      const { model, activeNodeId } = stateRef.current;
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
      const { model, activeNodeId } = stateRef.current;
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
    const items: ContextMenuItem[] = [];

    if (hasChildren) {
      items.push({
        label: node.collapsed ? "展開する" : "折りたたむ",
        onSelect: () => {
          const next = dispatch({ type: "toggleCollapse", nodeId }, "collapse");
          if (noteId) saveNote(next.model);
        },
      });
    }
    items.push({
      label: "子ノードを追加",
      onSelect: () => {
        const next = dispatch({ type: "addChild", nodeId }, "add-child");
        if (noteId) saveNote(next.model);
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
          if (noteId) saveNote(next.model);
        },
      });
    }
    return items;
  }, [contextMenu, dispatch, noteId, saveNote]);

  // --- Keyboard handling ---
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (isComposing) return;

      // Command palette
      if ((e.metaKey || e.ctrlKey) && e.key === "p") {
        e.preventDefault();
        setCmdPaletteOpen(true);
        return;
      }

      // Undo / Redo
      if ((e.metaKey || e.ctrlKey) && e.key === "z") {
        e.preventDefault();
        const restored = e.shiftKey
          ? undoManagerRef.current.redo()
          : undoManagerRef.current.undo();
        if (restored) dispatch({ type: "replace", state: restored });
        return;
      }

      const state = stateRef.current;
      if (!state.activeNodeId) return;

      const pos = inputRef.current?.selectionStart || 0;
      const selEnd = inputRef.current?.selectionEnd || 0;

      // Shift+Arrow Up/Down: extend a multi-node selection to the adjacent node.
      if (
        (e.key === "ArrowDown" || e.key === "ArrowUp") &&
        e.shiftKey &&
        !e.metaKey &&
        !e.ctrlKey
      ) {
        e.preventDefault();
        dispatch({
          type: e.key === "ArrowDown" ? "extendSelectionDown" : "extendSelectionUp",
        });
        return;
      }

      // Node selection: act on WHOLE nodes (delete / replace).
      if (isMultiNodeSelection(state)) {
        if (
          e.key === "Backspace" ||
          e.key === "Delete" ||
          e.key === "Enter"
        ) {
          e.preventDefault();
          dispatch({ type: "deleteSelectedNodes" }, "delete-nodes");
          return;
        }
        if (e.key.length === 1 && !e.metaKey && !e.ctrlKey) {
          e.preventDefault();
          dispatch(
            { type: "deleteSelectedNodesAndInsert", char: e.key },
            "delete-nodes"
          );
          return;
        }
        // Arrow keys / Escape: clear the multi-node selection, then fall through
        if (e.key.startsWith("Arrow") || e.key === "Escape") {
          dispatch({
            type: "activateNode",
            nodeId: state.activeNodeId,
            cursorPos: state.cursorPos,
            selectionEnd: state.selectionEnd,
            anchorNodeId: null,
            anchorOffset: 0,
          });
        }
      }

      // Shift+Enter inserts a line break inside the node; let the textarea's
      // native handling add the "\n" (onChange then commits it to the model).
      if (e.key === "Enter" && e.shiftKey) {
        return;
      }

      if (e.key === "Enter") {
        e.preventDefault();
        dispatch({ type: "enter", pos }, "enter");
        return;
      }

      if (e.key === "Tab") {
        e.preventDefault();
        dispatch({ type: "tab", shift: e.shiftKey }, "indent");
        return;
      }

      if (e.key === "Backspace" && pos === 0 && pos === selEnd) {
        e.preventDefault();
        dispatch({ type: "backspaceAtStart" }, "backspace");
        return;
      }

      if (e.key === "Delete" && pos === selEnd) {
        const prev = stateRef.current;
        const next = dispatch({ type: "deleteAtEnd", pos }, "delete");
        if (next !== prev) {
          e.preventDefault();
          return;
        }
      }

      if (e.key === "ArrowUp") {
        e.preventDefault();
        // Move between lines inside a multi-line node; cross to the previous
        // node only from the first line.
        const newPos = verticalMove(state.editingText, pos, -1);
        if (newPos !== null) {
          dispatch({ type: "setSelection", cursorPos: newPos, selectionEnd: newPos });
        } else {
          dispatch({ type: "moveUp" });
        }
        return;
      }

      if (e.key === "ArrowDown") {
        e.preventDefault();
        const newPos = verticalMove(state.editingText, pos, 1);
        if (newPos !== null) {
          dispatch({ type: "setSelection", cursorPos: newPos, selectionEnd: newPos });
          return;
        }
        dispatch({ type: "moveDown" });
        return;
      }

      if (e.key === "ArrowLeft") {
        if ((e.metaKey || e.ctrlKey) && e.shiftKey) {
          e.preventDefault();
          dispatch({ type: "cmdShiftLeft", pos, selEnd });
          return;
        }
        if (e.metaKey || e.ctrlKey) {
          e.preventDefault();
          dispatch({ type: "cmdLeft", pos });
          return;
        }
        if (e.shiftKey) {
          // Shift+Left: let native input handle selection extension
          return;
        }
        if (pos === 0 && pos === selEnd) {
          e.preventDefault();
          dispatch({ type: "arrowLeftEdge" });
          return;
        }
      }

      if (e.key === "ArrowRight") {
        if ((e.metaKey || e.ctrlKey) && e.shiftKey) {
          e.preventDefault();
          dispatch({ type: "cmdShiftRight", pos, selEnd });
          return;
        }
        if (e.metaKey || e.ctrlKey) {
          e.preventDefault();
          dispatch({ type: "cmdRight", pos });
          return;
        }
        if (e.shiftKey) {
          // Shift+Right: let native input handle selection extension
          return;
        }
        const currentNode = findNode(modelRef.current, state.activeNodeId);
        if (currentNode && pos >= currentNode.text.length && pos === selEnd) {
          e.preventDefault();
          dispatch({ type: "arrowRightEdge" });
          return;
        }
      }

      if (e.key === "Escape") {
        e.preventDefault();
        dispatch({ type: "deselect" });
        inputRef.current?.blur();
        return;
      }
    },
    [isComposing, dispatch]
  );

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

      // Click on empty space → deselect (skip if just finished dragging)
      stage.on("click tap", (e: any) => {
        if (wasDraggingRef.current) {
          wasDraggingRef.current = false;
          return;
        }
        if (e.target === stage) {
          dispatch({ type: "deselect" });
        }
      });

      // Drag selection on stage (supports multi-node)
      stage.on("mousemove", () => {
        const drag = dragStateRef.current;
        if (!drag) return;
        const pointer = stage.getPointerPosition();
        if (!pointer) return;
        const scale = stage.scaleX();
        const worldX = (pointer.x - stage.x()) / scale;
        const worldY = (pointer.y - stage.y()) / scale;

        const currentNodes = nodesRef.current;

        // Find closest node by Y
        let closestNode = currentNodes.find((n) => n.id === drag.nodeId);
        let closestDist = Infinity;
        for (const n of currentNodes) {
          const dist = Math.abs(n.y - worldY);
          if (dist < closestDist) {
            closestDist = dist;
            closestNode = n;
          }
        }
        if (!closestNode) return;

        // Find char position within closest node (line by Y, column by X).
        const data = lineDataRef.current.get(closestNode.id);
        let charIdx = 0;
        if (data) {
          const blockHeight = data.lines.length * LINE_HEIGHT;
          const relY = worldY - (closestNode.y - blockHeight / 2);
          const line = Math.max(
            0,
            Math.min(data.lines.length - 1, Math.floor(relY / LINE_HEIGHT))
          );
          const relX = worldX - closestNode.x - NODE_PADDING;
          charIdx = lineColToPos(
            data,
            line,
            nearestCol(data.lineOffsets[line], relX)
          );
        }

        dispatch({
          type: "dragSelect",
          anchorNodeId: drag.nodeId,
          anchorOffset: drag.anchorCharIdx,
          focusNodeId: closestNode.id,
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
      const blockHeight = data.lines.length * LINE_HEIGHT;
      lineCenterOffset = -blockHeight / 2 + line * LINE_HEIGHT + LINE_HEIGHT / 2;
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
      const data = buildLineData(displayRaw);
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
      const displayRaw = activeNodeId === node.id ? editingText : node.text;
      const isEmpty = displayRaw === "";
      const isActive = activeNodeId === node.id;
      const displayText = isEmpty ? "empty" : displayRaw;
      const data = lineDataMap.get(node.id)!;
      const lineCount = data.lines.length;
      const textWidth = textWidths.get(node.id) || 100;
      const rectWidth = Math.max(
        textWidth + nodePadding * 2,
        isRoot ? 100 : 80
      );
      const blockHeight = lineCount * LINE_HEIGHT;
      const rectHeight = Math.max(32, blockHeight + 14);

      const group = new Konva.Group();

      const rect = new Konva.Rect({
        x: node.x,
        y: node.y - rectHeight / 2,
        width: rectWidth,
        height: rectHeight,
        cornerRadius: 12,
        fill: isActive
          ? isRoot
            ? "#1e293b"
            : "#f1f5f9"
          : isRoot
            ? "#0f172a"
            : isEmpty
              ? "#f8fafc"
              : "#ffffff",
        stroke: isActive
          ? "#10b981"
          : isRoot
            ? "#0f172a"
            : "#e2e8f0",
        strokeWidth: isActive ? 2 : 1,
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

      const textNode = new Konva.Text({
        x: node.x + nodePadding,
        y: node.y - blockHeight / 2 + 2,
        text: displayText,
        fontSize: 14,
        fontFamily: "sans-serif",
        lineHeight: KONVA_LINE_HEIGHT,
        fill: isRoot ? "#ffffff" : isEmpty ? "#94a3b8" : "#0f172a",
        fontStyle: isEmpty ? "italic" : "normal",
        listening: false,
      });
      group.add(textNode);

      // Collapsed indicator: a small pill on the right showing hidden child count.
      if (node.collapsed && node.childCount > 0) {
        const badgeR = 9;
        const badgeX = node.x + rectWidth + 4 + badgeR;
        const badge = new Konva.Circle({
          x: badgeX,
          y: node.y,
          radius: badgeR,
          fill: "#10b981",
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

        // Find the clicked caret position: line by Y, column by X.
        const relY = worldY - (node.y - blockHeight / 2);
        const line = Math.max(
          0,
          Math.min(lineCount - 1, Math.floor(relY / LINE_HEIGHT))
        );
        const relX = worldX - node.x - nodePadding;
        const charIdx = lineColToPos(
          data,
          line,
          nearestCol(data.lineOffsets[line], relX)
        );

        // Activate the node at the clicked caret position (no anchor yet —
        // a drag will set the anchor on the first mousemove).
        dispatch({
          type: "activateNode",
          nodeId: node.id,
          cursorPos: charIdx,
          selectionEnd: charIdx,
          anchorNodeId: null,
          anchorOffset: 0,
        });

        // Start drag selection
        dragStateRef.current = { nodeId: node.id, anchorCharIdx: charIdx };
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
  }, [nodes, activeNodeId, editingText, konvaReady, dispatch]);

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
    const isMulti =
      selAnchorNodeId !== null && selAnchorNodeId !== activeNodeId;

    if (isMulti) {
      // Node selection: highlight each selected node's WHOLE rectangle with a
      // filled outline (distinct from the in-node text-selection highlight).
      const order = getFlatOrder(modelRef.current);
      const anchorIdx = order.indexOf(selAnchorNodeId);
      const focusIdx = order.indexOf(activeNodeId);
      const startIdx = Math.min(anchorIdx, focusIdx);
      const endIdx = Math.max(anchorIdx, focusIdx);

      for (let i = startIdx; i <= endIdx; i++) {
        const nodeId = order[i];
        const node = nodes.find((n) => n.id === nodeId);
        if (!node) continue;

        const isRoot = nodes.indexOf(node) === 0;
        const data = lineDataRef.current.get(nodeId);
        const textWidth =
          data && node.text !== "" ? lineDataWidth(data) : measureEmptyWidth();
        const rectWidth = Math.max(
          textWidth + nodePadding * 2,
          isRoot ? 100 : 80
        );
        const rectHeight = node.height;

        const sel = new Konva.Rect({
          x: node.x,
          y: node.y - rectHeight / 2,
          width: rectWidth,
          height: rectHeight,
          cornerRadius: 12,
          fill: "rgba(16, 185, 129, 0.16)",
          stroke: "#10b981",
          strokeWidth: 1.5,
          listening: false,
        });
        cursorLayer.add(sel);
      }
    } else {
      // Single-node selection or cursor
      const activeNode = nodes.find((n) => n.id === activeNodeId);
      if (!activeNode) return;

      const isRoot = nodes.indexOf(activeNode) === 0;
      const data = lineDataRef.current.get(activeNodeId);
      const blockHeight = (data ? data.lines.length : 1) * LINE_HEIGHT;
      const textTop = activeNode.y - blockHeight / 2;

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
          const lineCenterY = textTop + li * LINE_HEIGHT + LINE_HEIGHT / 2;
          cursorLayer.add(
            new Konva.Rect({
              x: activeNode.x + nodePadding + x1,
              y: lineCenterY - 10,
              width: x2 - x1,
              height: 20,
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
        const lineCenterY = textTop + line * LINE_HEIGHT + LINE_HEIGHT / 2;
        cursorLayer.add(
          new Konva.Line({
            points: [cursorX, lineCenterY - 10, cursorX, lineCenterY + 10],
            stroke: isRoot ? "#ffffff" : "#0f172a",
            strokeWidth: 2,
            listening: false,
          })
        );
      }
    }

    cursorLayer.draw();
  }, [activeNodeId, cursorPos, selectionEnd, cursorVisible, nodes, selAnchorNodeId, selAnchorOffset]);

  // --- Test API (non-production): imperative hooks for browser e2e tests ---
  // Exposes the live model plus a "node select" helper that returns the screen
  // point at the middle of a node's text, so tests can issue a real click that
  // activates the node and exercises the click→focus path.
  useEffect(() => {
    if (import.meta.env.PROD) return;
    const api: MindmapTestApi = {
      getModel: () => stateRef.current.model,
      getActiveNodeId: () => stateRef.current.activeNodeId,
      getSelection: () => {
        const s = stateRef.current;
        return {
          activeNodeId: s.activeNodeId,
          cursorPos: s.cursorPos,
          selectionEnd: s.selectionEnd,
          selAnchorNodeId: s.selAnchorNodeId,
          selAnchorOffset: s.selAnchorOffset,
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

  // Global Meta+P handler (when hidden input is not focused)
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "p") {
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
      <header className="anim-header flex h-14 items-center justify-between gap-3 border-b border-slate-200 bg-white px-4 md:px-6">
        <div className="flex items-center gap-3 min-w-0">
          <Link
            href="/notes"
            className="text-sm font-medium text-emerald-700 hover:text-emerald-800 whitespace-nowrap"
          >
            ← 一覧
          </Link>
          <div className="h-6 w-px bg-slate-200" />
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
          <span
            className={`whitespace-nowrap rounded-full px-2.5 py-1 text-xs font-medium ${isPublic ? "bg-emerald-50 text-emerald-700" : "bg-slate-100 text-slate-600"}`}
          >
            {isPublic ? "公開" : "非公開"}
          </span>
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
            width: "1px",
            height: "1px",
            opacity: 0,
            pointerEvents: "none",
            caretColor: "transparent",
            resize: "none",
            fontSize: "14px",
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
