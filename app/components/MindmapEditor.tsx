import {
  useState,
  useEffect,
  useRef,
  useCallback,
  useMemo,
  lazy,
  Suspense,
} from "react";
import { Link, router } from "@inertiajs/react";
import type { MindMapNode } from "../application/nodeUtils";
import type { MindMapModel, NodeType } from "../domain/model";
import {
  findNode,
  findParentAndIndex,
  cloneWithNewIds,
  generateId,
} from "../domain/model";
import { markdownToModel, modelToMarkdown } from "../application/markdown";
import { planPaste } from "../application/pastePlan";
import { assertNever } from "../lib/assertNever";
import { markdownTitle, markdownLineCount } from "../application/markdownCard";
import {
  BRANCH_MIME,
  serializeBranch,
  parseBranch,
} from "../application/branchClipboard";
import ViewControls from "./ViewControls";
import {
  attachStagePanZoom,
  stageTransform,
  applyStageTransform,
} from "./stagePanZoom";
import { zoomAt, panBy } from "../lib/panZoom";
import { edgeScrollVelocity } from "../lib/dragAutoScroll";
import { useNoteEditor, type NoteEditorEngine } from "./useNoteEditor";
import { useTextInputHandlers } from "./useTextInputHandlers";
import { layoutMindMap } from "../lib/treeLayout";
import {
  LINE_HEIGHT,
  lineHeightFor,
  DEFAULT_FONT_SIZE,
} from "../lib/measureText";
import {
  measureEmptyWidth,
  buildLineData,
  posToLineCol,
  lineColToPos,
  lineDataWidth,
  nearestCol,
  verticalMove,
  type LineData,
} from "../lib/textGeometry";
import { subscribeImages, imageDisplaySize, getImageEntry } from "../lib/imageCache";
import {
  flattenToNodes,
  nodeDisplayText,
  nodeTextOffsetX,
  checkboxOffset,
  supportsCheckbox,
  CHECKBOX_SIZE,
  FAVICON_SIZE,
  NODE_PADDING,
  nodeBoxWidth,
  nodeBoxHeight,
  markdownPreview,
  MD_CARD_LEAD,
  MD_CARD_BADGE,
  MD_TITLE_MAX_W,
} from "../application/nodeUtils";
import { t } from "../application/i18n";
import type { MessageKey } from "../application/messages";
import { useLocale } from "./useLocale";
import { resolveDropTarget, type DropTarget } from "../application/dragDrop";
import {
  nodeRect,
  rectCenter,
  worldViewport,
  centerOffset,
  ensureVisibleOffset,
  type Vec,
  type ViewTransform,
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
import PublishNodeDialog from "./PublishNodeDialog";
import type { EditorState, ViewState } from "../application/editorReducer";
import {
  buildKeymap,
  runKeymap,
  activeNode,
  type KeyBinding,
} from "../application/editorKeymap";
import { handleAuxInputKeys, type EditorLayout } from "../application/editSurface";
import {
  loadPreferences,
  savePreferences,
  type EditorPreferences,
} from "../application/editorPreferences";
import EditorSettingsDialog from "./EditorSettingsDialog";

// パネルを開くまで markdown レンダラ（marked / dompurify）を読み込まない。
const MarkdownPanel = lazy(() => import("./MarkdownPanel"));

/**
 * True for middle/right mouse buttons. Only the primary (left) button may
 * activate or drag canvas targets — the others are reserved for panning and
 * the context menu.
 */
function isNonPrimaryButton(e: { evt?: { button?: unknown } }): boolean {
  return (
    !!e.evt && typeof e.evt.button === "number" && e.evt.button !== 0
  );
}

// --- Multi-line geometry ---

// Screen-space distance (px) the pointer must travel after mousedown before a
// press turns into a drag-select. Below this a small jitter stays a plain click
// so selection doesn't jump to a neighbouring (e.g. same-Y parent) node.
const DRAG_THRESHOLD = 4;

// Message keys for the context menu's "convert to…" group, keyed by NodeType.
// `satisfies Record<NodeType, MessageKey>` makes this exhaustive: adding a
// NodeType refuses to compile here until it's given a label, so the new
// type can't silently stay unreachable from the conversion menu (the same
// idiom as STORED_NODE_TYPE_SET in domain/model.ts and EDIT_SURFACE in
// application/editSurface.ts). Resolved with t() when the menu is built.
const NODE_TYPE_LABEL = {
  text: "nodeTypeText",
  image: "nodeTypeImage",
  link: "nodeTypeLink",
  markdown: "nodeTypeMarkdown",
} as const satisfies Record<NodeType, MessageKey>;

// Pre-release: node types that ship hidden. They are only kept out of the
// "convert to…" menu — existing nodes of the type still render, edit, save
// and load, and converting *away* from one stays available, so a note made
// before the type was hidden never becomes uneditable.
// To ship the type, drop it from this set; that's the whole switch.
// (Commenting out its NODE_TYPE_LABEL entry above would not work: the
// `satisfies Record<NodeType, string>` there is exhaustive by design.)
const HIDDEN_NODE_TYPES: ReadonlySet<NodeType> = new Set();

// Zoom factor per click of the floating +/− buttons. Deliberately coarser than
// WHEEL_ZOOM_STEP (1.05): a button click should make a visible jump.
const ZOOM_BUTTON_STEP = 1.2;

// Each connector leaves its parent with a short straight stub before the curve
// begins. The stub's end is the shared junction where all of a parent's edges
// fan out, so it anchors the collapse handle (see the collapse-handle pass).
const CONNECTOR_STUB = 6;
// The unified collapse/expand toggle button hugs a parent's right edge: a "−"
// while expanded (collapses) or the hidden-child count while collapsed
// (expands). One control in one place, so the two states morph into each other
// (see the morph overlay). TOGGLE_GAP is the gap from the box edge to the
// button; TOGGLE_R its radius (also the resting count-badge radius, so a
// collapsed node's badge keeps its previous position). The expand affordance
// (count pill) shows always; the collapse affordance (minus) is revealed only
// on hover, so an (invisible, wider) TOGGLE_HIT_R zone keeps it easy to aim at.
const TOGGLE_GAP = 4;
const TOGGLE_R = 9;
const TOGGLE_HIT_R = 12;

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
      /**
       * Everything Escape has to put back (see the cancel handler). The
       * selection is captured *before* mousedown moves it onto the grabbed
       * node, and the transform before edge auto-scroll can pan away from it,
       * so cancelling rewinds the whole gesture — not just the pending move.
       */
      viewBefore: ViewState;
      transformBefore: ViewTransform;
    };

/** The "move" half of {@link DragState}, once narrowed. */
type MoveDragState = Extract<DragState, { mode: "move" }>;

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

/** One shape a node painted, as {@link MindmapTestApi.getNodeRender} reports it. */
export interface RenderedText {
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  fontSize: number;
  fontStyle: string;
  textDecoration: string;
  fill: string;
}

export interface RenderedImage {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface RenderedRect {
  x: number;
  y: number;
  width: number;
  height: number;
  fill: string;
  stroke: string;
}

export interface NodeRender {
  /** The node's box in world px (x/y = top-left). */
  box: { x: number; y: number; width: number; height: number };
  texts: RenderedText[];
  images: RenderedImage[];
  /** Includes the node's own background rect, not just chrome like a checkbox. */
  rects: RenderedRect[];
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
  /**
   * Screen-space centre of a node's unified collapse/expand toggle button — the
   * round control hugging the node's right edge (null when the node has no
   * children). Works in both states (the button stays put when the branch
   * toggles), so a test clicks the same point to collapse then expand. Mirrors
   * the draw-side position math so click tests stay in sync with it.
   */
  getToggleButtonPoint: (id: string) => { x: number; y: number } | null;
  /**
   * Screen-space centre of a node's task checkbox (null when the node isn't a
   * task). Mirrors the draw-side position math, like getToggleButtonPoint, so
   * a click test aims at the box the user sees.
   */
  getCheckboxPoint: (id: string) => { x: number; y: number } | null;
  /** Screen-space box of a node (x/y = top-left), for drag & drop zone tests. */
  getNodeRect: (
    id: string
  ) => { x: number; y: number; width: number; height: number } | null;
  /**
   * What a node ACTUALLY drew: its box plus every Konva shape sitting inside
   * it, read back off the layer rather than recomputed. Coordinates are world
   * px (the same space `node.x` lives in), so a test can assert that the
   * painted text fits the box the layout measured — the one relationship no
   * amount of re-deriving the expected value from the same helper can check.
   */
  getNodeRender: (id: string) => NodeRender | null;
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
  /** 閲覧専用モード（公開ノートの閲覧ページなど）。編集・保存を全面無効化。 */
  readOnly?: boolean;
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
  /**
   * Current layout + switcher for the floating view controls. Provided by the
   * responsive {@link NoteEditor} wrapper; absent in the standalone editor,
   * which then shows only the zoom controls.
   */
  layout?: EditorLayout;
  onLayoutChange?: (layout: EditorLayout) => void;
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
  layout,
  onLayoutChange,
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
    copyPublicLink,
    undoManagerRef,
    undo,
    redo,
    isPublic,
    setIsPublic,
    noteId,
    readOnly,
    leaveConfirm,
    setLeaveConfirm,
    bypassNavGuardRef,
  } = engine;

  // UI言語。t() を使うラベル群（メニュー・パレット・キャンバス描画）を言語
  // 切り替えで作り直すため、useMemo / 再描画エフェクトの依存にも入れる。
  const locale = useLocale();

  // Derived views of the editor state (keeps downstream code/deps unchanged)
  const {
    view: { activeNodeId, editing, editingText, cursorPos, selectionEnd },
  } = state;

  // Shared text-input glue (input ref, IME state, typeText handlers) — the same
  // machinery the outline view uses, so both stay in lock-step.
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
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Per-device keyboard preferences (see editorPreferences.ts). The ref keeps
  // the Konva event handlers — which are rebuilt on unrelated schedules — on
  // the current value without adding it to their dependency lists.
  const [prefs, setPrefs] = useState<EditorPreferences>(() => loadPreferences());
  const prefsRef = useRef(prefs);
  prefsRef.current = prefs;
  const [editingTitle, setEditingTitle] = useState(false);
  const [cursorVisible, setCursorVisible] = useState(true);
  const [konvaReady, setKonvaReady] = useState(false);
  // True while an image file is being dragged over the canvas (drop-to-upload).
  const [dropActive, setDropActive] = useState(false);
  // The markdown node whose full document is open in the side panel (null =
  // closed). Markdown nodes edit/preview here rather than expanding on-canvas.
  const [mdPanelNodeId, setMdPanelNodeId] = useState<string | null>(null);
  // True while the markdown panel's textarea owns the keyboard. Same role as
  // `urlEditing` for the URL box: it marks an editing surface outside the
  // canvas, so the focus-sync effects below must leave the focus alone.
  const [mdPanelEditing, setMdPanelEditing] = useState(false);
  const mdPanelEditingRef = useRef(false);
  mdPanelEditingRef.current = mdPanelEditing;
  const handleMdPanelEditingChange = useCallback(
    (v: boolean) => setMdPanelEditing(v),
    []
  );
  // Bumped whenever the stage is panned or zoomed so the (viewport-culled)
  // redraw effect re-runs and refills the newly-visible area. See the redraw
  // effect below — only nodes intersecting the visible viewport are built.
  const [viewportTick, setViewportTick] = useState(0);
  // Current stage zoom mirrored into React for the floating view controls.
  const [zoomPercent, setZoomPercent] = useState(100);
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
  // ノードのWeb公開ダイアログの対象（null = 閉）。noteId のある編集画面限定。
  const [publishTarget, setPublishTarget] = useState<{
    nodeId: string;
    text: string;
  } | null>(null);
  // Refs
  const urlInputRef = useRef<HTMLInputElement>(null);
  const imageFileInputRef = useRef<HTMLInputElement>(null);
  const uploadTargetRef = useRef<string | null>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const konvaStageRef = useRef<any>(null);
  const layerRef = useRef<any>(null);
  const cursorLayerRef = useRef<any>(null);
  const flashLayerRef = useRef<any>(null);
  // Overlay layer for the collapse/expand morph tween (see the morph effect).
  const morphLayerRef = useRef<any>(null);
  const konvaRef = useRef<any>(null);
  const updateGridRef = useRef<() => void>(() => {});
  const lineDataRef = useRef<Map<string, LineData>>(new Map());
  const dragStateRef = useRef<DragState | null>(null);
  // Re-click on the already-selected node: the intent to enter edit mode is
  // recorded at mousedown but only committed on release, so a press that turns
  // into a drag (branch move / text selection) never flips into editing. Holds
  // the node and the caret position resolved from the click point; consumed and
  // cleared by the stage's mouseup handler.
  const clickEditIntentRef = useRef<{ nodeId: string; charIdx: number } | null>(
    null
  );
  const dragLayerRef = useRef<any>(null);
  const wasDraggingRef = useRef(false);
  const highlightTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Which node's toggle button the pointer is currently over. Lets the redraw
  // that follows a collapse/expand click keep the (hover-only) minus visible —
  // Konva won't re-fire mouseenter on the freshly rebuilt button under a
  // stationary pointer, so we seed its opacity from this ref instead.
  const hoveredToggleRef = useRef<string | null>(null);
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
  // Collapse/expand morph signal. Set whenever a branch toggles so the morph
  // overlay effect can tween the toggle button between its "−" and count looks.
  // The nonce makes re-toggling the same node re-fire the effect.
  const [morphSignal, setMorphSignal] = useState<{
    nodeId: string;
    toCollapsed: boolean;
    nonce: number;
  } | null>(null);
  const morphNonceRef = useRef(0);

  // Toggle a branch's collapsed state and arm the morph. All three entry points
  // (the toggle button, the count badge — now one control — and the context
  // menu) route through here so collapse and expand always morph in place.
  const toggleCollapse = useCallback(
    (nodeId: string) => {
      const before = findNode(modelRef.current, nodeId);
      const wasCollapsed = !!before?.collapsed;
      const next = dispatch({ type: "toggleCollapse", nodeId }, "collapse");
      morphNonceRef.current += 1;
      setMorphSignal({
        nodeId,
        toCollapsed: !wasCollapsed,
        nonce: morphNonceRef.current,
      });
      return next;
    },
    [dispatch]
  );
  const toggleCollapseRef = useRef(toggleCollapse);
  toggleCollapseRef.current = toggleCollapse;

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
    if (flat.length > 0) {
      layoutMindMap(flat);
    }
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
  // Replaces the scattered value/setSelectionRange/focus calls. While an
  // editing surface outside the canvas is open — a custom node's URL box, or
  // the markdown panel's textarea — that surface owns the keyboard and we must
  // never steal focus back. Editing in the markdown panel re-enters here on
  // every keystroke (the edit updates editingText), so without the guard the
  // second character onwards would land on the canvas as selection-mode
  // shortcuts: Backspace deletes the node, Enter adds a sibling, arrows move.
  useEffect(() => {
    const el = inputRef.current;
    if (!el || isComposingRef.current) return;
    if (el.value !== editingText) el.value = editingText;
    el.setSelectionRange(cursorPos, selectionEnd);
    if (activeNodeId && !urlEditing && !mdPanelEditing) el.focus();
  }, [
    editingText,
    cursorPos,
    selectionEnd,
    activeNodeId,
    urlEditing,
    mdPanelEditing,
  ]);

  // Hand the keyboard to the right editor when URL editing starts/stops: the
  // visible URL box while open, the hidden textarea (keymap host) otherwise —
  // e.g. after Enter/Escape closes the box, arrow navigation must stay live.
  // Leaving the markdown panel's edit mode also lands here, handing the
  // keyboard back to the hidden textarea so arrows navigate nodes again.
  useEffect(() => {
    if (urlEditing) urlInputRef.current?.focus();
    else if (activeNodeId && !mdPanelEditing) inputRef.current?.focus();
  }, [urlEditing, activeNodeId, mdPanelEditing]);

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
      } else if (!mdPanelEditingRef.current) {
        // The markdown panel's textarea keeps the keyboard; pulling focus to
        // the canvas here would drop the user mid-sentence.
        inputRef.current?.focus();
      }
    }, 0);
  }, []);

  // Flip a task node between done and open. Backs the checkbox drawn inside
  // the node (a click on the box itself) — the same edit ⌘/Ctrl+Shift+D makes.
  const setNodeChecked = useCallback(
    (nodeId: string, checked: boolean | null) => {
      const next = dispatch({ type: "setChecked", nodeId, checked }, "check");
      if (noteId) saveNote(next.document.model);
    },
    [dispatch, noteId, saveNote]
  );
  const setNodeCheckedRef = useRef(setNodeChecked);
  setNodeCheckedRef.current = setNodeChecked;

  // --- Image upload: push a file to R2 and turn the node into an image ---
  const uploadAndSetImage = useCallback(
    async (nodeId: string, file: File) => {
      if (!file.type.startsWith("image/")) return;
      updateSaveStatus("uploading");
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
              ? "storage-limit"
              : "upload-failed"
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
        updateSaveStatus("upload-failed");
      }
    },
    [dispatch, noteId, saveNote, updateSaveStatus]
  );

  // --- Drag & drop image files from the OS onto the canvas ---
  // Resolve which node (if any) sits under a client-space point, so a dropped
  // image attaches as that node's child; misses fall back to the active node.
  const nodeIdAtClientPoint = useCallback(
    (clientX: number, clientY: number): string | null => {
      const stage = konvaStageRef.current;
      if (!stage) return null;
      const rect = stage.container().getBoundingClientRect();
      const scale = stage.scaleX();
      const worldX = (clientX - rect.left - stage.x()) / scale;
      const worldY = (clientY - rect.top - stage.y()) / scale;
      const flat = nodesRef.current;
      for (const n of flat) {
        const w = nodeBoxWidth(n.width, flat[0]?.id === n.id);
        const h = nodeBoxHeight(n.height);
        if (
          worldX >= n.x &&
          worldX <= n.x + w &&
          worldY >= n.y - h / 2 &&
          worldY <= n.y + h / 2
        ) {
          return n.id;
        }
      }
      return null;
    },
    []
  );

  const dragHasImage = (dt: DataTransfer | null) =>
    !!dt && Array.from(dt.items ?? []).some((it) => it.kind === "file");

  const handleCanvasDragOver = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      if (readOnly) return;
      if (!dragHasImage(e.dataTransfer)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
      setDropActive(true);
    },
    [readOnly]
  );

  const handleCanvasDragLeave = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      // Ignore leaves into descendant elements; only clear when the pointer
      // actually exits the drop container.
      if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
      setDropActive(false);
    },
    []
  );

  const handleCanvasDrop = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      if (readOnly) return;
      setDropActive(false);
      const files = Array.from(e.dataTransfer?.files ?? []).filter((f) =>
        f.type.startsWith("image/")
      );
      if (files.length === 0) return;
      e.preventDefault();
      const st = stateRef.current;
      const targetId =
        nodeIdAtClientPoint(e.clientX, e.clientY) ??
        st.view.activeNodeId ??
        st.document.model.id;
      // Each image becomes a fresh child of the drop target; upload sequentially
      // so the save-status line and the R2 requests don't stomp each other.
      void (async () => {
        for (const file of files) {
          const next = dispatch({ type: "addChild", nodeId: targetId }, "add-child");
          const newId = next.view.activeNodeId;
          if (newId) await uploadAndSetImage(newId, file);
        }
      })();
    },
    [dispatch, nodeIdAtClientPoint, readOnly, stateRef, uploadAndSetImage]
  );

  // Markdown nodes don't edit on the canvas — any edit intent (Space / typing /
  // double-click all flip `editing` on) instead opens the full document in the
  // side panel and leaves the canvas in selection mode. An empty markdown node
  // is let go (exitEditing deletes it) rather than opening an empty panel.
  useEffect(() => {
    if (!editing || !activeNodeId) return;
    const node = findNode(model, activeNodeId);
    if (node?.type !== "markdown") return;
    if (node.text.trim() !== "") setMdPanelNodeId(activeNodeId);
    dispatch({ type: "exitEditing" });
  }, [editing, activeNodeId, model, dispatch]);

  // Close the panel if its node is gone (deleted / undo).
  useEffect(() => {
    if (mdPanelNodeId && !findNode(model, mdPanelNodeId)) setMdPanelNodeId(null);
  }, [mdPanelNodeId, model]);

  // Panel edits go through the same reducer as canvas edits; the debounced
  // autosave effect (keyed on the model) persists them, and handleTextChange
  // batches them into one undo step like typing does.
  const handleMarkdownEdit = useCallback(
    (nodeId: string, text: string) => {
      undoManagerRef.current.handleTextChange(stateRef.current.document);
      dispatch({ type: "setNodeContent", nodeId, text, nodeType: "markdown" });
    },
    [dispatch, undoManagerRef, stateRef]
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
  // textarea behaviour — for paste that means the clipboard text lands at the
  // caret as-is, with no Markdown dialog and no node splitting (see planPaste).
  const hasTextRange = (st: EditorState) =>
    st.view.cursorPos !== st.view.selectionEnd;

  const handleCopy = useCallback((e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const st = stateRef.current;
    if (st.view.editing && hasTextRange(st)) return; // native text copy
    e.preventDefault();
    dispatch({ type: "copyBranch" });
    // Keep the internal branch clipboard (for in-app paste) but also expose the
    // selected subtree on the system clipboard: a Markdown outline as text/plain
    // (so Cmd+C pastes meaningfully into other apps) plus a full-fidelity JSON
    // payload (so pasting back into edane restores node kinds/formatting).
    const node = st.view.activeNodeId
      ? findNode(st.document.model, st.view.activeNodeId)
      : null;
    if (node) {
      e.clipboardData.setData("text/plain", modelToMarkdown(node));
      e.clipboardData.setData(BRANCH_MIME, serializeBranch(node));
    }
  }, [dispatch]);

  const handleCut = useCallback(
    (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
      const st = stateRef.current;
      if (st.view.editing && hasTextRange(st)) return; // native text cut
      e.preventDefault();
      // Mirror copy's system-clipboard payload before the branch leaves the tree
      // (root can't be cut, so skip it — cutBranch would no-op anyway).
      const node =
        st.view.activeNodeId && st.view.activeNodeId !== st.document.model.id
          ? findNode(st.document.model, st.view.activeNodeId)
          : null;
      if (node) {
        e.clipboardData.setData("text/plain", modelToMarkdown(node));
        e.clipboardData.setData(BRANCH_MIME, serializeBranch(node));
      }
      const next = dispatch({ type: "cutBranch" }, "cut-branch");
      if (noteId && next.document.model !== st.document.model)
        saveNote(next.document.model);
    },
    [dispatch, noteId, saveNote]
  );

  const handlePaste = useCallback(
    (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
      if (readOnly) {
        e.preventDefault();
        return;
      }
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
      // An edane branch on the system clipboard carries full-fidelity JSON in a
      // custom MIME alongside its Markdown text/plain, so the JSON's presence
      // means "this is our own branch" (even across tabs).
      const jsonBranch = parseBranch(e.clipboardData.getData(BRANCH_MIME));

      // Which of the paste flavours applies is a pure decision — including the
      // rule that editing mode always means a plain text paste at the caret.
      const plan = planPaste({
        editing: st.view.editing,
        text,
        hasBranchJson: !!jsonBranch,
        hasInternalClipboard: !!st.document.clipboard,
      });

      // "native": let the textarea insert the text at the caret (replacing the
      // selection), like typing. "none": nothing to paste.
      if (plan === "native" || plan === "none") return;
      e.preventDefault();

      if (plan === "branch-json" || plan === "branch-clipboard") {
        // `node` present = the clipboard's own subtree; absent = the internal
        // branch clipboard (see the reducer's pasteBranch).
        const next = dispatch(
          {
            type: "pasteBranch",
            node: plan === "branch-json" ? (jsonBranch ?? undefined) : undefined,
          },
          "paste-branch"
        );
        flashNodes(next.view.activeNodeId ? [next.view.activeNodeId] : []);
        if (noteId && next.document.model !== st.document.model)
          saveNote(next.document.model);
        return;
      }

      if (plan === "markdown-dialog") {
        // Offer decompose / markdown node / plain text.
        const targetId = st.view.activeNodeId || st.document.model.id;
        setMdPaste({ text, targetId });
        return;
      }

      if (plan === "text-as-nodes") {
        pasteTextAsNodes(text);
        return;
      }
      return assertNever(plan);
    },
    [dispatch, pasteTextAsNodes, flashNodes, noteId, readOnly, saveNote]
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
      const prompt = `${t("chatgptPrompt", { title: model.text })}\n\n${text}`;
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
      { id: "copy-all", label: t("cmdCopyAll"), action: copyAllText },
      { id: "copy-branch", label: t("cmdCopyBranch"), action: copyBranch },
      ...(readOnly
        ? []
        : [{ id: "paste", label: t("cmdPasteText"), action: pasteAsNodes }]),
      ...(readOnly
        ? []
        : [
            {
              id: "toggle-checkbox",
              label: t("cmdToggleCheckbox"),
              action: () => {
                const id = stateRef.current.view.activeNodeId;
                const n = id ? findNode(modelRef.current, id) : null;
                if (!n || n.id === modelRef.current.id) return;
                if (!supportsCheckbox(n.type ?? "text")) return;
                setNodeCheckedRef.current(
                  n.id,
                  n.checked === undefined ? false : null
                );
              },
            },
          ]),
      { id: "chatgpt", label: t("cmdSendToChatGPT"), action: sendToChatGPT },
      { id: "shortcuts", label: t("cmdShortcuts"), action: () => setHelpOpen(true) },
      { id: "settings", label: t("cmdEditorSettings"), action: () => setSettingsOpen(true) },
    ];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pasteTextAsNodes, readOnly, locale]);

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
    // 閲覧専用では編集系の項目・グループを個別にゲートし、閲覧操作
    // （リンクを開く / 折りたたみ / コピー）だけが残る。
    const groups: ContextMenuAction[][] = [];

    // --- Link actions: open / fetch metadata (link only) ---
    // Single click edits, so opening the URL lives in the menu.
    const linkGroup: ContextMenuAction[] = [];
    if (type === "link" && node.text) {
      linkGroup.push({
        label: t("menuOpenLink"),
        onSelect: () => window.open(node.text, "_blank", "noopener"),
      });
      if (!readOnly) {
        linkGroup.push({
          label: t("menuFetchLinkMeta"),
          onSelect: () => fetchLinkMeta(nodeId),
        });
      }
    }
    groups.push(linkGroup);

    // --- Structure: add child / collapse ---
    const structureGroup: ContextMenuAction[] = [];
    if (!readOnly) {
      structureGroup.push({
        label: t("menuAddChild"),
        onSelect: () => {
          const next = dispatch({ type: "addChild", nodeId }, "add-child");
          if (next.view.activeNodeId) flashNodes([next.view.activeNodeId]);
          if (noteId) saveNote(next.document.model);
          focusEditorSoon();
        },
      });
    }
    if (hasChildren) {
      structureGroup.push({
        label: node.collapsed ? t("menuExpand") : t("menuCollapse"),
        onSelect: () => {
          const next = toggleCollapse(nodeId);
          if (noteId) saveNote(next.document.model);
        },
      });
    }
    groups.push(structureGroup);

    // --- Kind conversion (root excluded — it's the note title) ---
    const typeGroup: ContextMenuAction[] = [];
    if (!isRoot && !readOnly) {
      const setType = (nodeType: NodeType) => () => {
        const next = dispatch(
          { type: "setNodeType", nodeId, nodeType },
          "set-type"
        );
        if (noteId) saveNote(next.document.model);
        focusEditorSoon();
      };
      for (const [nodeType, label] of Object.entries(NODE_TYPE_LABEL) as [
        NodeType,
        MessageKey,
      ][]) {
        if (nodeType === type || HIDDEN_NODE_TYPES.has(nodeType)) continue;
        typeGroup.push({ label: t(label), onSelect: setType(nodeType) });
      }
    }
    groups.push(typeGroup);

    // --- Task checkbox ---
    // Offered for the kinds that can show one (supportsCheckbox).
    const taskGroup: ContextMenuAction[] = [];
    if (!readOnly && !isRoot && supportsCheckbox(type)) {
      if (node.checked === undefined) {
        taskGroup.push({
          label: t("menuAddCheckbox"),
          onSelect: () => setNodeChecked(nodeId, false),
        });
      } else {
        taskGroup.push({
          label: node.checked ? t("menuUncheckTask") : t("menuCheckTask"),
          onSelect: () => setNodeChecked(nodeId, !node.checked),
        });
        taskGroup.push({
          label: t("menuRemoveCheckbox"),
          onSelect: () => setNodeChecked(nodeId, null),
        });
      }
    }
    groups.push(taskGroup);

    // --- Text formatting (font size / bold) ---
    const formatGroup: ContextMenuAction[] = [];
    if (!readOnly && type === "text") {
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
          label: t("menuBiggerText"),
          onSelect: () => applyStyle({ fontSize: bigger }),
        });
      if (smaller !== undefined)
        formatGroup.push({
          label: t("menuSmallerText"),
          onSelect: () => applyStyle({ fontSize: smaller }),
        });
      if (node.fontSize !== undefined && node.fontSize !== DEFAULT_FONT_SIZE)
        formatGroup.push({
          label: t("menuResetTextSize"),
          onSelect: () => applyStyle({ fontSize: null }),
        });
      formatGroup.push({
        label: node.bold ? t("menuBoldOff") : t("menuBoldOn"),
        onSelect: () => applyStyle({ bold: !node.bold }),
      });
    }
    groups.push(formatGroup);

    // --- Media: image upload (R2). Replaces the node's content ---
    const mediaGroup: ContextMenuAction[] = [];
    if (!isRoot && !readOnly) {
      mediaGroup.push({
        label: t("menuUploadImage"),
        onSelect: () => triggerImageUpload(nodeId),
      });
    }
    groups.push(mediaGroup);

    // --- Copy / share ---
    const copyGroup: ContextMenuAction[] = [];
    copyGroup.push({
      label: t("menuCopyBranchText"),
      onSelect: () => {
        navigator.clipboard.writeText(modelToText(node));
      },
    });
    if (noteId && !readOnly) {
      // この枝に取り消し可能な公開URL（JSON / Markdown）を発行する。ノートが
      // 非公開のときも項目は残し、ダイアログ側で理由を見せる（PublicityDropdown
      // の非公開時コピー動線と同じ「消さずに理由」方針）。
      copyGroup.push({
        label: t("menuPublishNode"),
        onSelect: () => setPublishTarget({ nodeId, text: node.text }),
      });
    }
    groups.push(copyGroup);

    // --- Destructive ---
    const dangerGroup: ContextMenuAction[] = [];
    if (!isRoot && !readOnly) {
      dangerGroup.push({
        label: t("menuDeleteNode"),
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    contextMenu,
    dispatch,
    toggleCollapse,
    noteId,
    readOnly,
    saveNote,
    fetchLinkMeta,
    triggerImageUpload,
    flashNodes,
    setNodeChecked,
    locale,
  ]);

  // --- Keyboard handling ---
  // Central keymap: a single declarative table (see editorKeymap.ts) drives all
  // shortcuts, so bindings stay auditable and the help overlay is generated
  // from the same source.
  const keymap = useMemo<KeyBinding[]>(
    () =>
      buildKeymap(
        {
          dispatch,
          saveNote: (m) => saveNote(m),
          openPalette: () => setCmdPaletteOpen(true),
          openHelp: () => setHelpOpen(true),
          undo,
          redo,
          verticalMove,
        },
        prefs,
        "canvas"
      ),
    [dispatch, saveNote, undo, redo, prefs]
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (isComposing) return;
      // The help / settings overlays don't grab focus, so the textarea still
      // receives keys while they're open; they handle Escape themselves —
      // ignore the rest.
      if (helpOpen || settingsOpen) return;
      const state = stateRef.current;
      runKeymap(
        keymap,
        {
          e,
          state,
          node: activeNode(state),
          pos: inputRef.current?.selectionStart || 0,
          selEnd: inputRef.current?.selectionEnd || 0,
        },
        prefs
      );
    },
    [isComposing, keymap, helpOpen, settingsOpen, prefs]
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
    let detachWindowDragListeners: (() => void) | null = null;
    let detachPanZoom: (() => void) | null = null;

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

      // Collapse/expand morph overlay. Sits above the main layer so the morphing
      // circle covers the freshly-drawn real toggle button underneath, then
      // clears to reveal it (see the morph effect). Non-interactive.
      const morphLayer = new Konva.Layer({ listening: false });
      stage.add(morphLayer);
      morphLayerRef.current = morphLayer;

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

      // Wheel: mouse wheel zooms (fixed steps), trackpad 2-finger scroll pans,
      // pinch zooms smoothly — see stagePanZoom / lib/panZoom.
      detachPanZoom = attachStagePanZoom(stage, () => {
        // Immediate feedback at the new transform; the effect below then
        // refills any nodes the pan/zoom brought into view.
        layer.batchDraw();
        updateGrid();
        // Pan/zoom changes which nodes fall inside the viewport (zooming out
        // reveals more) — re-run the culled redraw instead of just translating.
        setViewportTick((t) => t + 1);
        setZoomPercent(Math.round(stage.scaleX() * 100));
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

      /**
       * Re-resolve the drop target and redraw the ghost/marker for a pointer at
       * `pointer` (screen). Called both on real pointer movement and on every
       * auto-scroll frame — panning under a stationary pointer changes which
       * world point it sits over, so the preview has to be recomputed there too.
       */
      const updateMovePreview = (drag: MoveDragState, pointer: Vec) => {
        const scale = stage.scaleX();
        const worldX = (pointer.x - stage.x()) / scale;
        const worldY = (pointer.y - stage.y()) / scale;

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
      };

      // --- Edge auto-scroll while a branch is being dragged ---
      // Holding the pointer in a band along any viewport edge pans the stage
      // that way (speed ramps with depth — see lib/dragAutoScroll), so a branch
      // can be carried to an off-screen drop target in one gesture. The loop
      // runs for as long as a real "move" drag lives, even while the pointer is
      // perfectly still, which is exactly when auto-scroll has to keep going.
      let autoScrollRaf: number | null = null;
      let autoScrollPrevTs = 0;
      // Screen-space pointer position of the last mousemove (auto-scroll needs
      // it between moves; stage.getPointerPosition() is only refreshed by real
      // pointer events).
      let autoScrollPointer: Vec | null = null;
      // Pan accumulated since the last viewport refill. The culled redraw is a
      // full React render + canvas rebuild, so it must not run every frame; the
      // cull margin (0.6 viewport on each side) covers far more than this, so
      // refilling every REFILL_AFTER px keeps freshly-revealed nodes drawn well
      // before the pre-rendered band runs out.
      const REFILL_AFTER = 160;
      let scrolledSinceRefill = 0;
      // Longest frame delta we integrate. A backgrounded tab or a long redraw
      // would otherwise resume with a huge dt and teleport the view.
      const MAX_FRAME_S = 0.05;

      const stopAutoScroll = () => {
        if (autoScrollRaf !== null) cancelAnimationFrame(autoScrollRaf);
        autoScrollRaf = null;
        autoScrollPointer = null;
        if (scrolledSinceRefill !== 0) {
          scrolledSinceRefill = 0;
          setViewportTick((t) => t + 1);
        }
      };

      const autoScrollTick = (ts: number) => {
        const drag = dragStateRef.current;
        if (!drag || drag.mode !== "move" || !drag.moved || !autoScrollPointer) {
          stopAutoScroll();
          return;
        }
        autoScrollRaf = requestAnimationFrame(autoScrollTick);
        const dt = Math.min((ts - autoScrollPrevTs) / 1000, MAX_FRAME_S);
        autoScrollPrevTs = ts;
        if (dt <= 0) return;

        const v = edgeScrollVelocity(autoScrollPointer, {
          width: stage.width(),
          height: stage.height(),
        });
        if (v.x === 0 && v.y === 0) return;

        const dx = v.x * dt;
        const dy = v.y * dt;
        applyStageTransform(stage, panBy(stageTransform(stage), dx, dy));
        updateGrid();
        layer.batchDraw();
        // The pointer hasn't moved but the world under it has.
        updateMovePreview(drag, autoScrollPointer);

        scrolledSinceRefill += Math.hypot(dx, dy);
        if (scrolledSinceRefill >= REFILL_AFTER) {
          scrolledSinceRefill = 0;
          setViewportTick((t) => t + 1);
        }
      };

      const startAutoScroll = () => {
        if (autoScrollRaf !== null) return;
        autoScrollPrevTs = performance.now();
        autoScrollRaf = requestAnimationFrame(autoScrollTick);
      };

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

        if (drag.mode === "move") {
          autoScrollPointer = { x: pointer.x, y: pointer.y };
          startAutoScroll();
          updateMovePreview(drag, pointer);
          return;
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
          const relX = worldX - node.x - nodeTextOffsetX(node);
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
        const intent = clickEditIntentRef.current;
        clickEditIntentRef.current = null;
        if (drag) {
          if (drag.mode === "move") {
            stopAutoScroll();
            clearMovePreview();
            if (drag.moved && drag.drop) {
              commitMoveRef.current(drag.nodeId, drag.drop);
            }
          }
          // Re-click on the already-selected node: enter edit mode now that the
          // press turned out to be a click rather than a drag. The caret lands
          // where the click did (a drag would have been a text selection or a
          // branch move instead).
          if (!drag.moved && intent && intent.nodeId === drag.nodeId) {
            // Move the hidden textarea's own selection first: the mousedown
            // render left a queued "select" event for the whole-text range it
            // had just applied, and handleSelect reads the live DOM when that
            // event lands — after this dispatch it would push the stale range
            // back into the state and undo the caret set here.
            inputRef.current?.setSelectionRange(
              intent.charIdx,
              intent.charIdx
            );
            dispatch({
              type: "activateNode",
              nodeId: intent.nodeId,
              cursorPos: intent.charIdx,
              selectionEnd: intent.charIdx,
              editing: true,
            });
            focusEditorSoon();
          }
          wasDraggingRef.current = true;
          dragStateRef.current = null;
        }
        stage.draggable(true);
      });

      // Releasing the pointer outside the canvas never reaches the stage's own
      // mouseup — treat it as a drag cancel so the preview can't get stuck.
      // Also the single place that re-arms stage panning, so a drag cancelled
      // mid-press (Escape) can't leave the stage undraggable.
      const onWindowMouseUp = () => {
        stage.draggable(true);
        const drag = dragStateRef.current;
        clickEditIntentRef.current = null;
        if (!drag) return;
        if (drag.mode === "move") {
          stopAutoScroll();
          clearMovePreview();
        }
        dragStateRef.current = null;
      };
      window.addEventListener("mouseup", onWindowMouseUp);

      /**
       * Escape during a branch drag: abandon the move and rewind the gesture.
       *
       * "Rewind" is taken literally — nothing the drag did survives:
       *   - no dispatch of `moveBranch`, so the document (and with it the undo
       *     history) is never touched. The drop only ever happens on mouseup,
       *     so cancelling is simply *not* committing;
       *   - the selection goes back to whatever it was before mousedown moved
       *     it onto the grabbed node;
       *   - the view goes back to the transform captured at mousedown. Edge
       *     auto-scroll can carry the view a long way from where the
       *     branch actually still lives, and leaving the user stranded there
       *     after "cancel" is disorienting; the pan happened only because of
       *     the drag, so it unwinds with it. (A wheel/pinch pan performed
       *     mid-drag is rewound too — it's the same one gesture.)
       *
       * Escape is also "leave edit mode" (keymap edit-escape). No conflict: the
       * event is swallowed here ONLY while a real move drag is in flight, which
       * is the innermost transient state and so the one Escape should unwind
       * first. A second Escape, after the drag is gone, exits editing as usual.
       * Arrow keys are never touched, so the keyboard-escape invariant holds.
       */
      const onWindowKeyDown = (e: KeyboardEvent) => {
        if (e.key !== "Escape") return;
        const drag = dragStateRef.current;
        if (!drag || drag.mode !== "move" || !drag.moved) return;
        e.preventDefault();
        e.stopPropagation();

        stopAutoScroll();
        clearMovePreview();
        dragStateRef.current = null;
        // The pointer is still down: swallow the click that the coming mouseup
        // will synthesize, so it can't re-select or exit editing behind our
        // back. `stage.draggable` is re-armed by onWindowMouseUp on release.
        wasDraggingRef.current = true;

        const t = stageTransform(stage);
        if (
          t.scale !== drag.transformBefore.scale ||
          t.offsetX !== drag.transformBefore.offsetX ||
          t.offsetY !== drag.transformBefore.offsetY
        ) {
          applyStageTransform(stage, drag.transformBefore);
          updateGrid();
          layer.batchDraw();
          setZoomPercent(Math.round(stage.scaleX() * 100));
          setViewportTick((tick) => tick + 1);
        }

        // View-only dispatch (no undoType, document untouched) — the undo
        // history stays exactly as the drag found it.
        const before = drag.viewBefore;
        if (before.activeNodeId) {
          dispatch({
            type: "activateNode",
            nodeId: before.activeNodeId,
            cursorPos: before.cursorPos,
            selectionEnd: before.selectionEnd,
            editing: before.editing,
          });
        }
      };
      // Capture phase: the hidden textarea's own Escape binding (edit-escape)
      // must not also fire for the keystroke that cancelled the drag.
      window.addEventListener("keydown", onWindowKeyDown, true);

      detachWindowDragListeners = () => {
        window.removeEventListener("mouseup", onWindowMouseUp);
        window.removeEventListener("keydown", onWindowKeyDown, true);
        stopAutoScroll();
      };

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
      detachWindowDragListeners?.();
      detachPanZoom?.();
      if (konvaStageRef.current) {
        konvaStageRef.current.destroy();
        konvaStageRef.current = null;
        layerRef.current = null;
        cursorLayerRef.current = null;
        dragLayerRef.current = null;
        flashLayerRef.current = null;
        morphLayerRef.current = null;
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

  // Zoom from the floating view controls: scale by `factor` around the
  // viewport centre (wheel/pinch zoom anchors at the pointer instead).
  const zoomBy = useCallback((factor: number) => {
    const stage = konvaStageRef.current;
    if (!stage) return;
    const t = zoomAt(
      stageTransform(stage),
      { x: stage.width() / 2, y: stage.height() / 2 },
      factor
    );
    applyStageTransform(stage, t);
    layerRef.current?.batchDraw();
    updateGridRef.current();
    setViewportTick((tick) => tick + 1);
    setZoomPercent(Math.round(t.scale * 100));
  }, []);

  // Stable object so the memoized ViewControls skips re-rendering on the
  // per-wheel-tick renders this view does during pan/zoom gestures.
  const zoomControls = useMemo(
    () => ({
      percent: zoomPercent,
      onZoomIn: () => zoomBy(ZOOM_BUTTON_STEP),
      onZoomOut: () => zoomBy(1 / ZOOM_BUTTON_STEP),
      onReset: () => {
        const stage = konvaStageRef.current;
        if (stage) zoomBy(1 / stage.scaleX());
      },
    }),
    [zoomPercent, zoomBy]
  );

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

    const screenX =
      (activeNode.x + nodeTextOffsetX(activeNode) + cursorX) * scale + stage.x();
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
      // A markdown node is always drawn as its compact card (it never edits on
      // the canvas — edit intent opens the side panel), so its connection-start
      // width comes from the measured render box, not a raw-text line measurement.
      if (node.type === "markdown") {
        lineDataMap.set(
          node.id,
          buildLineData("", node.fontSize ?? DEFAULT_FONT_SIZE, !!node.bold)
        );
        textWidths.set(node.id, node.width);
        return;
      }
      // The string this node actually PAINTS. Only a TEXT node swaps to its
      // live buffer while edited — an image/link node keeps its preview and
      // edits its URL in the box below (see `activeIsCustom` / the nodes memo),
      // so its lines must come from the preview the box was measured for
      // (nodeDisplayText: a link shows its fetched title, not the URL).
      const isTextEditingThis =
        editing &&
        activeNodeId === node.id &&
        node.type !== "image" &&
        node.type !== "link";
      const displayRaw = isTextEditingThis ? editingText : nodeDisplayText(node);
      const measuredBold = !!node.bold;
      // The very cap measureModelNode sized this node's box with (carried on
      // the node, so the per-kind decision is made in exactly one place), which
      // makes the caret's visual lines the ones the box was measured for.
      const data = buildLineData(
        displayRaw,
        node.fontSize ?? DEFAULT_FONT_SIZE,
        measuredBold,
        node.contentMaxWidth
      );
      lineDataMap.set(node.id, data);
      // Content width — where the box ends, so connectors and the collapse
      // toggle leave the node's real right edge. While a text node is edited
      // the box follows the live buffer, so it comes from the lines; otherwise
      // it's the measured width, which already counts the chrome the text
      // measurement knows nothing about (a link's favicon column, an image's
      // scaled size). An empty node paints the italic "empty" placeholder,
      // which is wider than the nothing it measured.
      const measured = isTextEditingThis
        ? lineDataWidth(data) + checkboxOffset(node)
        : node.width;
      textWidths.set(
        node.id,
        displayRaw === "" ? Math.max(measured, measureEmptyWidth()) : measured
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
        // A short straight stub leaves the parent horizontally, then the curve
        // takes over from the junction (stubX). The curve already departed
        // horizontally (control point shares startY), so the stub just extends
        // that departure — visually it reads as one continuous connector.
        const stubX = startX + CONNECTOR_STUB;
        const controlOffset = Math.abs(endX - stubX) * 0.5;
        const path = new Konva.Path({
          data: `M ${startX} ${startY} L ${stubX} ${startY} C ${stubX + controlOffset} ${startY}, ${endX - controlOffset} ${endY}, ${endX} ${endY}`,
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
      // A markdown node never enters the on-canvas editing state: any edit
      // intent opens the side panel (see the mdPanel effect) and leaves the
      // canvas in selection mode. Excluding it from isEditing here keeps it on
      // its compact card for the transient frame between `editing` flipping on
      // and the effect running — otherwise it flashes the raw-text edit card.
      const isMarkdown = node.type === "markdown";
      const isEditing = editing && activeNodeId === node.id && !isMarkdown;
      const isSelected = activeNodeId === node.id && !isEditing;
      // Image/link nodes keep their rendered preview even while editing — the
      // URL is edited in the visible box below the node — so only TEXT nodes
      // swap to raw-text (live buffer) editing on the canvas. Markdown edits as
      // raw multi-line text in place, so it is NOT a custom (URL-box) node.
      const isCustom = node.type === "image" || node.type === "link";
      const isTextEditing = isEditing && !isCustom;
      const asImage = node.type === "image";
      const asLink = node.type === "link";
      // A markdown node draws its styled block-level render (see the asMarkdown
      // branch below); it's tinted and tagged with an "MD" label. Its raw text is
      // never used for the single-Text path, so displayRaw ignores it here.
      const asMarkdown = isMarkdown;
      // Links display their fetched title (falling back to the raw URL).
      const displayRaw = isTextEditing ? editingText : nodeDisplayText(node);
      const isEmpty = displayRaw === "";
      const fontSize = node.fontSize ?? DEFAULT_FONT_SIZE;
      const bold = !!node.bold;
      const lineHeightPx = lineHeightFor(fontSize);
      const konvaLineHeight = lineHeightPx / fontSize;
      // Line count comes from the (14px) lineData; titles/text are single-line
      // in practice, multi-line text keeps its hard breaks.
      const data = lineDataMap.get(node.id)!;
      const lineCount = data.lines.length;
      const blockHeight = lineCount * lineHeightPx;
      // Draw the VISUAL lines the box was measured from (hard breaks + soft
      // wraps at the width cap), pre-joined at wrap time so Konva does no
      // wrapping of its own — text, box and caret agree by construction.
      const drawnText = isEmpty ? "empty" : data.visualText;
      // Favicon only when a non-active link node has one.
      const favEntry =
        asLink && node.favicon ? getImageEntry(node.favicon) : undefined;
      const favLoaded =
        favEntry?.status === "loaded" ? favEntry.img : undefined;
      // Task checkbox: its own column ahead of the favicon/text (0 wide when
      // the node isn't a task), and a done task reads as struck through.
      const checkOffset = checkboxOffset(node);
      const isDone = node.checked === true;
      // Where the text column starts — padding plus the checkbox and favicon
      // columns, from the same helper the caret and hit tests use.
      const textX = node.x + nodeTextOffsetX(node);

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
        // Editing gets the emerald accent so "I'm typing here" reads distinctly
        // from a mere selection (black); everything else keeps its resting edge.
        stroke: isEditing
          ? "#10b981"
          : isSelected
            ? "#000000"
            : isRoot
              ? "#0f172a"
              : asMarkdown
                ? "#d8b4fe"
                : "#e2e8f0",
        strokeWidth: isEditing ? 2.5 : isSelected ? 2 : 1,
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
              text: d.status === "error" ? t("imageLoadError") : t("loading"),
              fontSize: 12,
              fontFamily: "sans-serif",
              fill: "#94a3b8",
              listening: false,
            })
          );
        }
      } else if (asMarkdown) {
        // Compact card: a document glyph, the derived title, and a line-count
        // badge — one line. The full document opens in the side panel; the card
        // never grows to the document's size on the canvas.
        const glyphX = node.x + nodePadding;
        group.add(
          new Konva.Text({
            x: glyphX,
            y: node.y - fontSize / 2 - 1,
            text: "📄",
            fontSize,
            fontFamily: "sans-serif",
            listening: false,
          })
        );
        group.add(
          new Konva.Text({
            x: glyphX + MD_CARD_LEAD,
            y: node.y - fontSize / 2 - 1,
            // Stays one line: clipped with an ellipsis at the same width the
            // box was measured against, so a long title can't widen the card.
            width: MD_TITLE_MAX_W,
            wrap: "none",
            ellipsis: true,
            text: markdownTitle(node.text),
            fontSize,
            fontFamily: "sans-serif",
            fill: "#6b21a8",
            fontStyle: bold ? "bold" : "normal",
            listening: false,
          })
        );
        // Line-count badge pinned to the card's right edge.
        const badgeText = t("mdLineCount", { n: markdownLineCount(node.text) });
        group.add(
          new Konva.Text({
            x: node.x + rectWidth - MD_CARD_BADGE + 2,
            y: node.y - 6,
            width: MD_CARD_BADGE - 6,
            align: "right",
            text: badgeText,
            fontSize: 10,
            fontFamily: "sans-serif",
            fill: "#a855f7",
            listening: false,
          })
        );
      } else {
        // Task checkbox, then the favicon, then the text — one column each.
        if (checkOffset > 0) {
          // Aligned with the FIRST line, not the box centre, so a wrapped task
          // keeps its box beside the line the text starts on.
          const boxY =
            node.y - blockHeight / 2 + 2 + lineHeightPx / 2 - CHECKBOX_SIZE / 2;
          const boxX = node.x + nodePadding;
          const cbox = new Konva.Rect({
            x: boxX,
            y: boxY,
            width: CHECKBOX_SIZE,
            height: CHECKBOX_SIZE,
            cornerRadius: 4,
            fill: isDone ? "#10b981" : "#ffffff",
            stroke: isDone ? "#10b981" : "#94a3b8",
            strokeWidth: 1.5,
          });
          if (!readOnly) {
            cbox.on("mousedown touchstart", (e: any) => {
              if (isNonPrimaryButton(e)) return;
              // The node under the box must not also take the press: hitting
              // the checkbox is a toggle, never a select-or-edit.
              e.cancelBubble = true;
              // Read the state from the MODEL, not from the frame this shape
              // was drawn for: a second click that arrives before the redraw
              // would otherwise re-send the state the node already has.
              const live = findNode(modelRef.current, node.id);
              setNodeCheckedRef.current(node.id, live?.checked !== true);
            });
            cbox.on("mouseenter", () => {
              const st = konvaStageRef.current;
              if (st) st.container().style.cursor = "pointer";
            });
            cbox.on("mouseleave", () => {
              const st = konvaStageRef.current;
              if (st) st.container().style.cursor = "";
            });
          } else {
            cbox.listening(false);
          }
          group.add(cbox);
          if (isDone) {
            group.add(
              new Konva.Line({
                points: [
                  boxX + 3.5,
                  boxY + 7.5,
                  boxX + 6,
                  boxY + 10,
                  boxX + 10.5,
                  boxY + 4,
                ],
                stroke: "#ffffff",
                strokeWidth: 2,
                lineCap: "round",
                lineJoin: "round",
                listening: false,
              })
            );
          }
        }
        // Favicon before the link title (when fetched + loaded).
        if (asLink && favLoaded) {
          group.add(
            new Konva.Image({
              image: favLoaded,
              x: node.x + nodePadding + checkOffset,
              y: node.y - FAVICON_SIZE / 2,
              width: FAVICON_SIZE,
              height: FAVICON_SIZE,
              listening: false,
            })
          );
        }
        const textNode = new Konva.Text({
          x: textX,
          y: node.y - blockHeight / 2 + 2,
          text: drawnText,
          fontSize,
          fontFamily: "sans-serif",
          lineHeight: konvaLineHeight,
          // A completed task fades and is struck through — the node is still
          // there to read, just visibly finished.
          fill: isDone
            ? "#94a3b8"
            : asLink
              ? "#2563eb"
              : isRoot
                ? "#ffffff"
                : asMarkdown
                  ? "#6b21a8"
                  : isEmpty
                    ? "#94a3b8"
                    : "#0f172a",
          fontStyle: isEmpty ? "italic" : bold ? "bold" : "normal",
          textDecoration: [asLink ? "underline" : "", isDone ? "line-through" : ""]
            .filter(Boolean)
            .join(" "),
          listening: false,
        });
        group.add(textNode);
      }

      // The collapsed count / expand control is drawn once for every parent (in
      // either state) by the unified toggle-button pass below, so nothing to do
      // here.

      // Select the whole node without entering edit mode (single click in
      // select mode / any readOnly activation) — one payload, three call sites.
      const selectWholeNode = () =>
        dispatch({
          type: "activateNode",
          nodeId: node.id,
          cursorPos: 0,
          selectionEnd: node.text.length,
          editing: false,
        });

      // Click → activate node
      group.on("mousedown touchstart", (e: any) => {
        if (isNonPrimaryButton(e)) return;
        if (readOnly) {
          // 閲覧専用: 選択だけ行い、ドラッグはステージのパンに任せる
          // （cancelBubble しないのでノード上から掴んでもパンできる）。
          // markdownノードはここで dispatch すると再描画でグループが作り
          // 直され、mouseup 時に Konva の click 判定（同一シェイプ比較）が
          // 崩れてパネルが開かない。選択もパネルも click 側で行う。
          if (node.type !== "markdown") {
            selectWholeNode();
            focusEditorSoon();
          }
          return;
        }
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
          const relX = worldX - node.x - nodeTextOffsetX(node);
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
        // Clicking the node that is already selected (but not yet edited)
        // enters edit mode without waiting for a double click. The state change
        // is deferred to mouseup so the same press can still start a drag; a
        // drag that passes the threshold drops the intent (see mouseup).
        clickEditIntentRef.current =
          prefsRef.current.selectionMode &&
          !cur.view.editing &&
          cur.view.activeNodeId === node.id
            ? { nodeId: node.id, charIdx }
            : null;
        if (editingThis || !prefsRef.current.selectionMode) {
          // Always-edit preference: any click lands the caret at the clicked
          // position instead of passing through a select-first step.
          dispatch({
            type: "activateNode",
            nodeId: node.id,
            cursorPos: charIdx,
            selectionEnd: charIdx,
            editing: true,
          });
        } else {
          // Select mode: whole text selected so a follow-up keypress replaces it.
          selectWholeNode();
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
            // `cur` is the state from *before* the select/activate dispatch
            // above, which is what Escape must put back (see the cancel
            // handler). The transform is still untouched at mousedown.
            viewBefore: cur.view,
            transformBefore: stageTransform(stage),
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
      if (!readOnly) {
        group.on("dblclick dbltap", () => {
          dispatch({ type: "selectAllInNode", nodeId: node.id });
          focusEditorSoon();
        });
      }

      // 閲覧専用: markdownノードはクリックで全文をサイドパネル表示（編集時は
      // 「編集意図」フリップ経由で開くが、readOnly では editing に入れないため
      // ここで直接開く）。パン後は Konva がクリックを発火しないので誤爆しない。
      if (readOnly && node.type === "markdown") {
        group.on("click tap", () => {
          selectWholeNode();
          if (node.text.trim() !== "") setMdPanelNodeId(node.id);
        });
      }

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

    // Toggle buttons. Every parent carries a single round control hugging its
    // right edge, in the same place in both states: the hidden-child count while
    // collapsed (always shown — click expands) or a "−" while expanded (revealed
    // only on hover — click collapses). One control in one place, so toggling
    // morphs the two states into each other (see the morph overlay effect).
    // Drawn last so it sits above the connectors and stays interactive.
    nodes.forEach((node, index) => {
      if (!visible[index]) return;
      // childCount counts direct children even while collapsed (when the flat
      // `children` array is empty), so it's the true leaf test for both states.
      if (node.childCount === 0) return; // leaves have nothing to toggle
      const isRoot = index === 0;
      const parentWidth = textWidths.get(node.id) ?? node.width;
      const rectW = nodeBoxWidth(parentWidth, isRoot);
      const cx = node.x + rectW + TOGGLE_GAP + TOGGLE_R;
      const cy = node.y;
      if (cx < cullLeft || cx > cullRight || cy < cullTop || cy > cullBottom) {
        return;
      }

      const collapsed = !!node.collapsed;
      const btn = new Konva.Group();
      // Invisible hover/hit zone — wider than the button and always listening
      // (Konva's hit graph ignores opacity), so the hover-only minus is easy to
      // aim at and stays clickable even while unrevealed.
      btn.add(
        new Konva.Circle({
          x: cx,
          y: cy,
          radius: TOGGLE_HIT_R,
          fill: "#000000",
          opacity: 0,
        })
      );
      // The visible control. While expanded it's hidden until hovered; the
      // hoveredToggleRef seed keeps it shown across the click-driven redraw.
      const hovered = hoveredToggleRef.current === node.id;
      const visual = new Konva.Group({
        opacity: collapsed || hovered ? 1 : 0,
        listening: false,
      });
      visual.add(
        new Konva.Circle({
          x: cx,
          y: cy,
          radius: TOGGLE_R,
          fill: collapsed ? "#000000" : "#ffffff",
          stroke: collapsed ? undefined : "#aeb7c2",
          strokeWidth: collapsed ? 0 : 1.5,
        })
      );
      if (collapsed) {
        // Expand affordance: the hidden-child count in a filled pill.
        visual.add(
          new Konva.Text({
            x: cx - TOGGLE_R,
            y: cy - 6,
            width: TOGGLE_R * 2,
            align: "center",
            text: String(node.childCount),
            fontSize: 11,
            fontFamily: "sans-serif",
            fill: "#ffffff",
            listening: false,
          })
        );
      } else {
        // Collapse affordance: a minus glyph in an outlined pill.
        visual.add(
          new Konva.Line({
            points: [cx - 3.5, cy, cx + 3.5, cy],
            stroke: "#6b7280",
            strokeWidth: 1.5,
            listening: false,
          })
        );
      }
      btn.add(visual);

      btn.on("mouseenter", () => {
        hoveredToggleRef.current = node.id;
        // Reveal the minus (the count is always visible, so leave it be).
        if (!collapsed) {
          visual.opacity(1);
          layer.batchDraw();
        }
        const st = konvaStageRef.current;
        if (st) st.container().style.cursor = "pointer";
      });
      btn.on("mouseleave", () => {
        if (hoveredToggleRef.current === node.id) {
          hoveredToggleRef.current = null;
        }
        if (!collapsed) {
          visual.opacity(0);
          layer.batchDraw();
        }
        const st = konvaStageRef.current;
        if (st) st.container().style.cursor = "";
      });
      btn.on("mousedown touchstart", (e: any) => {
        if (isNonPrimaryButton(e)) return;
        e.cancelBubble = true;
        // The redraw destroys this button, so its mouseleave never fires —
        // clear the pointer cursor here to avoid it sticking.
        const st = konvaStageRef.current;
        if (st) st.container().style.cursor = "";
        toggleCollapseRef.current(node.id);
      });
      layer.add(btn);
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
  // locale: キャンバスに直接描く文言（読み込み中 / 行数バッジ / フィールド追加
  // ボタンなど）を言語切り替えで描き直す。
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes, activeNodeId, editing, editingText, konvaReady, dispatch, readOnly, viewportTick, locale]);

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
              x: activeNode.x + nodeTextOffsetX(activeNode) + x1,
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
          activeNode.x +
          nodeTextOffsetX(activeNode) +
          (data?.lineOffsets[line]?.[col] || 0);
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

  // --- Collapse / expand morph ---
  // The unified toggle button (drawn on the main layer) flips between "−" and
  // the child count the instant its node toggles. To bridge the jump, an overlay
  // circle at the same spot tweens its fill white⇄black while the minus line and
  // the count crossfade, then clears to reveal the freshly-drawn real button
  // underneath. The overlay circle shares the button's radius, so it fully hides
  // the real button below it for the whole tween — no double-draw peeking out.
  // Runs on its own layer (see stage setup) so nothing tears it down mid-morph.
  useEffect(() => {
    if (!morphSignal) return;
    const Konva = konvaRef.current;
    const layer = morphLayerRef.current;
    if (!Konva || !layer) return;

    const flat = nodesRef.current;
    const node = flat.find((n) => n.id === morphSignal.nodeId);
    layer.destroyChildren();
    if (!node || node.childCount === 0) {
      layer.batchDraw();
      return;
    }

    const isRoot = flat[0]?.id === node.id;
    const rectW = nodeBoxWidth(node.width, isRoot);
    const cx = node.x + rectW + TOGGLE_GAP + TOGGLE_R;
    const cy = node.y;
    // toCollapsed: the button is BECOMING the count pill (collapse). Each shape
    // starts in the pre-toggle look and tweens to the post-toggle one.
    const toCollapsed = morphSignal.toCollapsed;

    const circle = new Konva.Circle({
      x: cx,
      y: cy,
      radius: TOGGLE_R,
      stroke: "#aeb7c2",
      fill: toCollapsed ? "#ffffff" : "#000000",
      strokeWidth: toCollapsed ? 1.5 : 0,
      listening: false,
    });
    const minus = new Konva.Line({
      points: [cx - 3.5, cy, cx + 3.5, cy],
      stroke: "#6b7280",
      strokeWidth: 1.5,
      opacity: toCollapsed ? 1 : 0,
      listening: false,
    });
    const count = new Konva.Text({
      x: cx - TOGGLE_R,
      y: cy - 6,
      width: TOGGLE_R * 2,
      align: "center",
      text: String(node.childCount),
      fontSize: 11,
      fontFamily: "sans-serif",
      fill: "#ffffff",
      opacity: toCollapsed ? 0 : 1,
      listening: false,
    });
    layer.add(circle, minus, count);
    layer.batchDraw();

    const DUR = 0.2;
    const tweens = [
      new Konva.Tween({
        node: circle,
        duration: DUR,
        fill: toCollapsed ? "#000000" : "#ffffff",
        strokeWidth: toCollapsed ? 0 : 1.5,
        easing: Konva.Easings.EaseInOut,
      }),
      new Konva.Tween({
        node: minus,
        duration: DUR,
        opacity: toCollapsed ? 0 : 1,
        easing: Konva.Easings.EaseInOut,
      }),
      new Konva.Tween({
        node: count,
        duration: DUR,
        opacity: toCollapsed ? 1 : 0,
        easing: Konva.Easings.EaseInOut,
        onFinish: () => {
          layer.destroyChildren();
          layer.batchDraw();
        },
      }),
    ];
    tweens.forEach((t) => t.play());

    return () => {
      tweens.forEach((t) => t.destroy());
      layer.destroyChildren();
      layer.batchDraw();
    };
  }, [morphSignal]);

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
        const worldX = node.x + nodeTextOffsetX(node) + textW / 2;
        const worldY = node.y;
        return { x: worldX * scale + stage.x(), y: worldY * scale + stage.y() };
      },
      getToggleButtonPoint: (id: string) => {
        const flat = nodesRef.current;
        const node = flat.find((n) => n.id === id);
        const stage = konvaStageRef.current;
        if (!node || !stage) return null;
        if (node.childCount === 0) return null;
        const scale = stage.scaleX();
        const isRoot = flat[0]?.id === id;
        const rectW = nodeBoxWidth(node.width, isRoot);
        const worldX = node.x + rectW + TOGGLE_GAP + TOGGLE_R;
        const worldY = node.y;
        return { x: worldX * scale + stage.x(), y: worldY * scale + stage.y() };
      },
      getCheckboxPoint: (id: string) => {
        const node = nodesRef.current.find((n) => n.id === id);
        const stage = konvaStageRef.current;
        if (!node || !stage || checkboxOffset(node) === 0) return null;
        const scale = stage.scaleX();
        const data = lineDataRef.current.get(id);
        const lineHeight = data?.lineHeight ?? LINE_HEIGHT;
        const blockHeight = (data?.lines.length ?? 1) * lineHeight;
        const worldX = node.x + NODE_PADDING + CHECKBOX_SIZE / 2;
        const worldY = node.y - blockHeight / 2 + 2 + lineHeight / 2;
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
      getNodeRender: (id: string) => {
        const flat = nodesRef.current;
        const node = flat.find((n) => n.id === id);
        const layer = layerRef.current;
        if (!node || !layer) return null;
        const width = nodeBoxWidth(node.width, flat[0]?.id === id);
        const height = nodeBoxHeight(node.height);
        const box = { x: node.x, y: node.y - height / 2, width, height };
        // Konva positions every shape in world coordinates (node.x/node.y are
        // world too), so an inside-the-box test is a plain rect containment —
        // with a small slack for glyphs that intentionally overhang, like the
        // collapse toggle hugging the right edge.
        // Konva itself is loaded lazily (konvaRef), so the shapes come back
        // untyped here — same `any` the draw path uses.
        const inside = (s: any) =>
          s.x() >= box.x - 1 &&
          s.x() <= box.x + width &&
          s.y() >= box.y - 1 &&
          s.y() <= box.y + height + 1;
        const texts = layer
          .find("Text")
          .filter(inside)
          .map((s: any) => {
            const tx = s;
            return {
              text: tx.text(),
              x: tx.x(),
              y: tx.y(),
              // Konva reports the MEASURED width of an auto-width Text, which
              // is the width the glyphs really occupy on the canvas.
              width: tx.width(),
              height: tx.height(),
              fontSize: tx.fontSize(),
              fontStyle: tx.fontStyle(),
              textDecoration: tx.textDecoration(),
              fill: String(tx.fill()),
            };
          });
        const images = layer
          .find("Image")
          .filter(inside)
          .map((s: any) => ({
            x: s.x(),
            y: s.y(),
            width: s.width(),
            height: s.height(),
          }));
        const rects = layer
          .find("Rect")
          .filter(inside)
          .map((s: any) => ({
            x: s.x(),
            y: s.y(),
            width: s.width(),
            height: s.height(),
            fill: String(s.fill() ?? ""),
            stroke: String(s.stroke() ?? ""),
          }));
        return { box, texts, images, rects };
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

  // 静的表示（readOnly）と編集ボタンの中身で共用するタイトル。
  const titleSpan = (
    <span className="truncate text-base font-semibold tracking-tight">
      {title || t("untitled")}
    </span>
  );

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
      <EditorSettingsDialog
        open={settingsOpen}
        prefs={prefs}
        onChange={(next) => {
          setPrefs(next);
          savePreferences(next);
        }}
        onClose={() => {
          setSettingsOpen(false);
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
        title={t("saveFailedTitle")}
        message={t("leaveMessage")}
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
      <header className="anim-header flex h-12 items-center justify-between gap-3 border-b border-slate-200 bg-white px-4 md:px-6">
        <div className="flex items-center gap-3 min-w-0">
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
            titleSpan
          ) : editingTitle ? (
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
              className="h-8 min-w-0 rounded-lg border border-slate-300 bg-white px-2 text-base font-semibold tracking-tight outline-none focus:border-emerald-500 focus:ring-2 focus:ring-emerald-100"
              placeholder={t("titlePlaceholderCanvas")}
            />
          ) : (
            <button
              onClick={() => setEditingTitle(true)}
              className="flex min-w-0 items-center gap-2 rounded-lg px-1 text-left hover:bg-slate-100"
              title={t("editTitle")}
            >
              {titleSpan}
              <span className="text-sm text-slate-400">✎</span>
            </button>
          )}
        </div>
        <div className="flex items-center gap-3 text-xs">
          <ViewControls
            layout={layout ?? "canvas"}
            onLayoutChange={onLayoutChange}
            zoom={zoomControls}
          />
          {noteId && !readOnly && (
            <>
              <span
                ref={saveStatusRef}
                data-testid="save-status"
                className="whitespace-nowrap text-slate-500"
              />
              <PublicityDropdown
                isPublic={isPublic}
                onChange={(next) => {
                  setIsPublic(next);
                  saveNote(model, next);
                }}
                onCopyLink={copyPublicLink}
              />
            </>
          )}
          {!noteId && !readOnly && onSaveToAccount && (
            <button
              onClick={handleSaveToAccount}
              className="whitespace-nowrap rounded-lg bg-emerald-600 px-3 py-1.5 font-medium text-white transition hover:bg-emerald-700"
            >
              {t("saveToAccount")}
            </button>
          )}
        </div>
      </header>
      <div
        className="flex-1 relative overflow-hidden bg-slate-50"
        onDragOver={handleCanvasDragOver}
        onDragLeave={handleCanvasDragLeave}
        onDrop={handleCanvasDrop}
      >
        <div
          ref={canvasRef}
          data-testid="mm-canvas"
          className="absolute inset-0 [background-size:20px_20px]"
        />
        {dropActive && (
          <div
            data-testid="mm-drop-overlay"
            className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center border-2 border-dashed border-emerald-500 bg-emerald-500/10"
          >
            <span className="rounded-lg bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white shadow-md">
              {t("dropImageHint")}
            </span>
          </div>
        )}
        {(() => {
          const n = mdPanelNodeId ? findNode(model, mdPanelNodeId) : null;
          if (!n) return null;
          return (
            <Suspense fallback={null}>
              <MarkdownPanel
                source={n.text}
                readOnly={readOnly}
                onChange={(text) => handleMarkdownEdit(n.id, text)}
                onClose={() => setMdPanelNodeId(null)}
                onEditingChange={handleMdPanelEditingChange}
              />
            </Suspense>
          );
        })()}
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
          onCompositionStart={handleCompositionStart}
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
            onKeyDown={(e) => handleAuxInputKeys(e, dispatch)}
            placeholder={
              activeModelNode?.type === "image" ? t("imageUrlLabel") : t("linkUrlLabel")
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
        {publishTarget && noteId && (
          <PublishNodeDialog
            noteId={noteId}
            nodeId={publishTarget.nodeId}
            nodeText={publishTarget.text}
            isPublic={isPublic}
            onClose={() => {
              setPublishTarget(null);
              focusEditorSoon();
            }}
          />
        )}
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
