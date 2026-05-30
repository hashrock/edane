import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { Link } from "@inertiajs/react";
import type { MindMapNode } from "../types/MindMap";
import type { MindMapModel } from "../domain/model";
import {
  findNode,
  findParentAndIndex,
  updateNodeText,
  cloneModel,
  generateId,
} from "../domain/model";
import { layoutMindMap } from "../lib/treeLayout";
import { flattenToNodes } from "../application/nodeUtils";
import {
  parseContent,
  serializeModel,
  modelToText,
  textToModel,
} from "../application/persistence";
import CommandPalette from "./CommandPalette";
import type { Command } from "./CommandPalette";
import {
  handleEnter,
  handleTab,
  handleBackspaceAtStart,
  handleDeleteAtEnd,
  handleArrowUp,
  handleArrowDown,
  handleCmdLeft,
  handleCmdRight,
  handleCmdShiftLeft,
  handleCmdShiftRight,
  handleArrowLeftEdge,
  handleArrowRightEdge,
  isMultiNodeSelection,
  collapseMultiNodeSelection,
  type EditorState,
  type StateUpdate,
} from "../application/editorActions";
import { UndoManager } from "../application/undoManager";
import { getFlatOrder } from "../domain/model";

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
  // Model state
  const [model, setModel] = useState<MindMapModel>(() =>
    parseContent(initialContent, initialTitle)
  );
  const [isPublic, setIsPublic] = useState(initialIsPublic || false);
  const [cmdPaletteOpen, setCmdPaletteOpen] = useState(false);
  const [editingTitle, setEditingTitle] = useState(false);

  // Editing state
  const [activeNodeId, setActiveNodeId] = useState<string | null>(null);
  const [editingText, setEditingText] = useState("");
  const [cursorPos, setCursorPos] = useState(0);
  const [selectionEnd, setSelectionEnd] = useState(0);
  const [isComposing, setIsComposing] = useState(false);
  const [cursorVisible, setCursorVisible] = useState(true);
  // Multi-node selection anchor (null = no multi-node selection)
  const [selAnchorNodeId, setSelAnchorNodeId] = useState<string | null>(null);
  const [selAnchorOffset, setSelAnchorOffset] = useState(0);
  const [konvaReady, setKonvaReady] = useState(false);
  const [inputPos, setInputPos] = useState<{ x: number; y: number }>({ x: 0, y: 0 });

  // Refs
  const inputRef = useRef<HTMLInputElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const konvaStageRef = useRef<any>(null);
  const layerRef = useRef<any>(null);
  const cursorLayerRef = useRef<any>(null);
  const konvaRef = useRef<any>(null);
  const saveTimerRef = useRef<any>(null);
  const updateGridRef = useRef<() => void>(() => {});
  const saveStatusRef = useRef<HTMLSpanElement>(null);
  const cursorOffsetsRef = useRef<Map<string, number[]>>(new Map());
  const dragStateRef = useRef<{
    nodeId: string;
    anchorCharIdx: number;
  } | null>(null);
  const wasDraggingRef = useRef(false);
  const undoManagerRef = useRef(new UndoManager());
  const modelRef = useRef(model);
  modelRef.current = model;

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

  // --- Build current editor state for action functions ---
  const getEditorState = useCallback(
    (): EditorState => ({
      model: modelRef.current,
      activeNodeId,
      editingText,
      cursorPos,
      selectionEnd,
      selAnchorNodeId,
      selAnchorOffset,
    }),
    [activeNodeId, editingText, cursorPos, selectionEnd, selAnchorNodeId, selAnchorOffset]
  );

  // --- Undo manager setup ---
  useEffect(() => {
    undoManagerRef.current.setCommitCallback(() => getEditorState());
  }, [getEditorState]);

  /** Restore full editor state (for undo/redo) */
  const applyFullState = useCallback((state: EditorState) => {
    setModel(state.model);
    setActiveNodeId(state.activeNodeId);
    setEditingText(state.editingText);
    setCursorPos(state.cursorPos);
    setSelectionEnd(state.selectionEnd);
    setSelAnchorNodeId(state.selAnchorNodeId);
    setSelAnchorOffset(state.selAnchorOffset);
    if (inputRef.current) {
      inputRef.current.value = state.editingText;
      const pos = state.cursorPos;
      const sel = state.selectionEnd;
      inputRef.current.setSelectionRange(pos, sel);
      if (state.activeNodeId) inputRef.current.focus();
    }
  }, []);

  /** Push a structural command to the undo stack */
  const pushUndoable = useCallback(
    (type: string, stateBefore: EditorState, stateAfter: EditorState) => {
      undoManagerRef.current.push(type, stateBefore, stateAfter);
    },
    []
  );

  // --- Apply state update from an action ---
  const applyUpdate = useCallback(
    (update: StateUpdate) => {
      if (!update) return false;
      if (update.model !== undefined) setModel(update.model);
      // For node changes, resolve the text from the new model
      const targetNodeId =
        update.activeNodeId !== undefined
          ? update.activeNodeId
          : activeNodeId;
      if (update.activeNodeId !== undefined) {
        setActiveNodeId(update.activeNodeId);
        if (update.editingText === undefined && update.activeNodeId) {
          // Changing active node without explicit text: resolve from model
          const m = update.model ?? modelRef.current;
          const node = findNode(m, update.activeNodeId);
          const text = node?.text || "";
          setEditingText(text);
          // Default cursor to end of text
          const pos = update.cursorPos ?? text.length;
          setCursorPos(pos);
          setSelectionEnd(update.selectionEnd ?? pos);
          if (inputRef.current) {
            inputRef.current.value = text;
            inputRef.current.setSelectionRange(pos, update.selectionEnd ?? pos);
            inputRef.current.focus();
          }
          return true;
        }
      }
      if (update.editingText !== undefined) setEditingText(update.editingText);
      if (update.cursorPos !== undefined) setCursorPos(update.cursorPos);
      if (update.selectionEnd !== undefined)
        setSelectionEnd(update.selectionEnd);
      if (update.selAnchorNodeId !== undefined)
        setSelAnchorNodeId(update.selAnchorNodeId);
      if (update.selAnchorOffset !== undefined)
        setSelAnchorOffset(update.selAnchorOffset);
      // Sync hidden input
      if (
        update.editingText !== undefined ||
        update.cursorPos !== undefined ||
        update.activeNodeId !== undefined
      ) {
        const text =
          update.editingText ?? editingText;
        const pos = update.cursorPos ?? cursorPos;
        const sel = update.selectionEnd ?? pos;
        if (inputRef.current) {
          inputRef.current.value = text;
          inputRef.current.setSelectionRange(pos, sel);
          inputRef.current.focus();
        }
      }
      return true;
    },
    [activeNodeId, editingText, cursorPos]
  );

  // --- Node activation (for click/dblclick) ---
  const activateNode = useCallback(
    (nodeId: string, cursor?: number) => {
      const node = nodes.find((n) => n.id === nodeId);
      if (!node) return;
      const modelNode = findNode(modelRef.current, nodeId);
      const text = modelNode?.text || "";
      const pos = cursor ?? text.length;
      applyUpdate({
        activeNodeId: nodeId,
        editingText: text,
        cursorPos: pos,
        selectionEnd: pos,
        selAnchorNodeId: null,
        selAnchorOffset: 0,
      });
    },
    [nodes, applyUpdate]
  );

  // --- Input handling ---
  const handleInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      // Record state before first keystroke of a batch
      if (!undoManagerRef.current.hasPendingText()) {
        undoManagerRef.current.handleTextChange(getEditorState());
      } else {
        undoManagerRef.current.handleTextChange(getEditorState());
      }
      const newText = e.target.value;
      const pos = e.target.selectionStart ?? 0;
      const end = e.target.selectionEnd ?? 0;
      setEditingText(newText);
      setCursorPos(pos);
      setSelectionEnd(end);
      setSelAnchorNodeId(null);
      setSelAnchorOffset(0);
      if (!isComposing && activeNodeId) {
        setModel((prev) => updateNodeText(prev, activeNodeId, newText));
      }
    },
    [isComposing, activeNodeId]
  );

  const handleCompositionEnd = useCallback(() => {
    setIsComposing(false);
    if (activeNodeId && inputRef.current) {
      const finalText = inputRef.current.value;
      setEditingText(finalText);
      setModel((prev) => updateNodeText(prev, activeNodeId, finalText));
      setTimeout(() => {
        if (inputRef.current) {
          setCursorPos(inputRef.current.selectionStart || 0);
          setSelectionEnd(inputRef.current.selectionEnd || 0);
        }
      }, 0);
    }
  }, [activeNodeId]);

  const handleSelect = useCallback(() => {
    if (inputRef.current) {
      setCursorPos(inputRef.current.selectionStart || 0);
      setSelectionEnd(inputRef.current.selectionEnd || 0);
    }
  }, []);

  // --- Command palette ---
  const commands = useMemo<Command[]>(() => {
    const copyAllText = () => {
      const text = modelToText(model);
      navigator.clipboard.writeText(text);
    };
    const copyBranch = () => {
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
      if (!clipText.trim()) return;
      const targetId = activeNodeId || model.id;
      let baseModel = model;
      if (activeNodeId) {
        baseModel = updateNodeText(model, activeNodeId, editingText);
      }
      const parsed = textToModel("_", clipText);
      const reId = (n: MindMapModel): MindMapModel => ({
        id: generateId(),
        text: n.text,
        children: n.children.map(reId),
      });
      const freshChildren = parsed.children.map(reId);
      if (freshChildren.length === 0) return;
      const newModel = cloneModel(baseModel);
      const parentInfo = findParentAndIndex(newModel, targetId);
      if (parentInfo) {
        parentInfo.parent.children.splice(
          parentInfo.index + 1,
          0,
          ...freshChildren
        );
      } else {
        const root = findNode(newModel, targetId)!;
        root.children.push(...freshChildren);
      }
      const lastChild = freshChildren[freshChildren.length - 1];
      setModel(newModel);
      setActiveNodeId(lastChild.id);
      setEditingText(lastChild.text);
      setCursorPos(lastChild.text.length);
      setSelectionEnd(lastChild.text.length);
      setSelAnchorNodeId(null);
      setSelAnchorOffset(0);
      if (noteId) saveNote(newModel);
    };
    return [
      { id: "copy-all", label: "すべてプレーンテキストでコピー", action: copyAllText },
      { id: "copy-branch", label: "選択した枝以下をテキストコピー", action: copyBranch },
      { id: "paste", label: "プレーンテキストからペースト", action: pasteAsNodes },
      { id: "chatgpt", label: "ChatGPTに送る", action: sendToChatGPT },
    ];
  }, [model, activeNodeId, editingText, noteId]);

  // --- Keyboard handling ---
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
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
        if (e.shiftKey) {
          const state = undoManagerRef.current.redo();
          if (state) applyFullState(state);
        } else {
          const state = undoManagerRef.current.undo();
          if (state) applyFullState(state);
        }
        return;
      }

      if (!activeNodeId) return;

      const state = getEditorState();
      const pos = inputRef.current?.selectionStart || 0;
      const selEnd = inputRef.current?.selectionEnd || 0;

      // If multi-node selection, collapse it before most actions
      if (isMultiNodeSelection(state)) {
        if (
          e.key === "Backspace" ||
          e.key === "Delete" ||
          e.key === "Enter" ||
          (e.key.length === 1 && !e.metaKey && !e.ctrlKey)
        ) {
          e.preventDefault();
          undoManagerRef.current.commitPendingText();
          const collapsed = collapseMultiNodeSelection(state);
          if (collapsed) {
            applyUpdate(collapsed);
            pushUndoable("delete-range", state, { ...state, ...collapsed });
            // For single-char typing, insert the char after collapse
            if (e.key.length === 1 && !e.metaKey && !e.ctrlKey) {
              // After collapse, insert the typed character
              setTimeout(() => {
                const m = modelRef.current;
                const nodeId = collapsed.activeNodeId;
                if (!nodeId) return;
                const node = findNode(m, nodeId);
                if (!node) return;
                const cPos = collapsed.cursorPos ?? 0;
                const newText =
                  node.text.substring(0, cPos) +
                  e.key +
                  node.text.substring(cPos);
                setModel(updateNodeText(m, nodeId, newText));
                setEditingText(newText);
                setCursorPos(cPos + 1);
                setSelectionEnd(cPos + 1);
                if (inputRef.current) {
                  inputRef.current.value = newText;
                  inputRef.current.setSelectionRange(cPos + 1, cPos + 1);
                }
              }, 0);
            }
          }
          return;
        }
        // Arrow keys / Escape: clear multi-node selection
        if (e.key.startsWith("Arrow") || e.key === "Escape") {
          setSelAnchorNodeId(null);
          setSelAnchorOffset(0);
          // Fall through to normal handling
        }
      }

      if (e.key === "Enter") {
        e.preventDefault();
        undoManagerRef.current.commitPendingText();
        const update = handleEnter(state, pos);
        if (update) {
          applyUpdate(update);
          pushUndoable("enter", state, { ...state, ...update });
        }
        return;
      }

      if (e.key === "Tab") {
        e.preventDefault();
        undoManagerRef.current.commitPendingText();
        const update = handleTab(state, e.shiftKey);
        if (update) {
          applyUpdate(update);
          pushUndoable("indent", state, { ...state, ...update });
        }
        return;
      }

      if (e.key === "Backspace" && pos === 0 && pos === selEnd) {
        e.preventDefault();
        undoManagerRef.current.commitPendingText();
        const update = handleBackspaceAtStart(state);
        if (update) {
          applyUpdate(update);
          pushUndoable("backspace", state, { ...state, ...update });
        }
        return;
      }

      if (e.key === "Delete" && pos === selEnd) {
        const update = handleDeleteAtEnd(state, pos);
        if (update) {
          e.preventDefault();
          undoManagerRef.current.commitPendingText();
          applyUpdate(update);
          pushUndoable("delete", state, { ...state, ...update });
          return;
        }
      }

      if (e.key === "ArrowUp") {
        e.preventDefault();
        applyUpdate(handleArrowUp(state));
        return;
      }

      if (e.key === "ArrowDown") {
        e.preventDefault();
        applyUpdate(handleArrowDown(state));
        return;
      }

      if (e.key === "ArrowLeft") {
        if ((e.metaKey || e.ctrlKey) && e.shiftKey) {
          e.preventDefault();
          applyUpdate(handleCmdShiftLeft(state, pos, selEnd));
          return;
        }
        if (e.metaKey || e.ctrlKey) {
          e.preventDefault();
          applyUpdate(handleCmdLeft(state, pos));
          return;
        }
        if (e.shiftKey) {
          // Shift+Left: let native input handle selection extension
          return;
        }
        if (pos === 0 && pos === selEnd) {
          e.preventDefault();
          applyUpdate(handleArrowLeftEdge(state));
          return;
        }
      }

      if (e.key === "ArrowRight") {
        if ((e.metaKey || e.ctrlKey) && e.shiftKey) {
          e.preventDefault();
          applyUpdate(handleCmdShiftRight(state, pos, selEnd));
          return;
        }
        if (e.metaKey || e.ctrlKey) {
          e.preventDefault();
          applyUpdate(handleCmdRight(state, pos));
          return;
        }
        if (e.shiftKey) {
          // Shift+Right: let native input handle selection extension
          return;
        }
        const currentNode = findNode(modelRef.current, activeNodeId);
        if (
          currentNode &&
          pos >= currentNode.text.length &&
          pos === selEnd
        ) {
          e.preventDefault();
          applyUpdate(handleArrowRightEdge(state));
          return;
        }
      }

      if (e.key === "Escape") {
        e.preventDefault();
        setActiveNodeId(null);
        inputRef.current?.blur();
        return;
      }
    },
    [isComposing, activeNodeId, getEditorState, applyUpdate, applyFullState, pushUndoable]
  );

  // --- Title editing ---
  const handleTitleChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const newTitle = e.target.value;
      setModel((prev) => updateNodeText(prev, prev.id, newTitle));
    },
    []
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
          setActiveNodeId(null);
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
        const nodePadding = 20;

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

        // Find char position within closest node
        const relX = worldX - closestNode.x - nodePadding;
        const offsets = cursorOffsetsRef.current.get(closestNode.id);
        let charIdx = 0;
        if (offsets) {
          let bestDist = Math.abs(relX);
          for (let i = 1; i < offsets.length; i++) {
            const d = Math.abs(relX - offsets[i]);
            if (d < bestDist) {
              bestDist = d;
              charIdx = i;
            }
          }
        }

        if (closestNode.id === drag.nodeId) {
          // Same node: single-node selection
          const start = Math.min(drag.anchorCharIdx, charIdx);
          const end = Math.max(drag.anchorCharIdx, charIdx);
          setCursorPos(start);
          setSelectionEnd(end);
          setSelAnchorNodeId(drag.nodeId);
          setSelAnchorOffset(drag.anchorCharIdx);
          if (inputRef.current) {
            inputRef.current.setSelectionRange(start, end);
          }
        } else {
          // Multi-node: focus moves to the closest node
          setActiveNodeId(closestNode.id);
          const modelNode = findNode(modelRef.current, closestNode.id);
          setEditingText(modelNode?.text || "");
          setCursorPos(charIdx);
          setSelectionEnd(charIdx);
          setSelAnchorNodeId(drag.nodeId);
          setSelAnchorOffset(drag.anchorCharIdx);
          if (inputRef.current) {
            inputRef.current.value = modelNode?.text || "";
            inputRef.current.setSelectionRange(charIdx, charIdx);
          }
        }
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
  }, []);

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
    const offsets = cursorOffsetsRef.current.get(activeNodeId);
    const cursorX = offsets?.[cursorPos] || 0;

    const screenX = (activeNode.x + 20 + cursorX) * scale + stage.x();
    const screenY = activeNode.y * scale + stage.y();
    setInputPos({ x: screenX, y: screenY });
  }, [activeNodeId, nodes, cursorPos, editingText]);

  // --- Redraw canvas ---
  useEffect(() => {
    const Konva = konvaRef.current;
    const layer = layerRef.current;
    if (!Konva || !layer || nodes.length === 0) return;

    layer.destroyChildren();

    const nodeMap: Record<string, MindMapNode> = {};
    nodes.forEach((n) => (nodeMap[n.id] = n));

    // Pre-calculate text widths and character offsets
    const textWidths = new Map<string, number>();
    const cursorOffsets = new Map<string, number[]>();
    const nodePadding = 20;

    nodes.forEach((node) => {
      // For active node during editing, use editingText
      const displayRaw =
        activeNodeId === node.id ? editingText : node.text;
      const isEmpty = displayRaw === "";
      const displayText = isEmpty ? "empty" : displayRaw;

      const t = new Konva.Text({
        text: displayText,
        fontSize: 14,
        fontFamily: "sans-serif",
        fontStyle: isEmpty ? "italic" : "normal",
      });
      textWidths.set(node.id, t.width());

      if (displayRaw.length > 0) {
        const offsets: number[] = [0];
        for (let i = 0; i < displayRaw.length; i++) {
          const partial = new Konva.Text({
            text: displayRaw.substring(0, i + 1),
            fontSize: 14,
            fontFamily: "sans-serif",
          });
          offsets.push(partial.width());
        }
        cursorOffsets.set(node.id, offsets);
      }
    });
    cursorOffsetsRef.current = cursorOffsets;

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
      const displayRaw =
        activeNodeId === node.id ? editingText : node.text;
      const isEmpty = displayRaw === "";
      const isActive = activeNodeId === node.id;
      const displayText = isEmpty ? "empty" : displayRaw;
      const textWidth = textWidths.get(node.id) || 100;
      const rectWidth = Math.max(
        textWidth + nodePadding * 2,
        isRoot ? 100 : 80
      );
      const rectHeight = 32;

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
        shadowColor: isRoot ? "#0f172a" : "#0f172a",
        shadowBlur: isRoot ? 16 : 3,
        shadowOpacity: isRoot ? 0.18 : 0.06,
        shadowOffsetY: isRoot ? 6 : 1,
      });
      group.add(rect);

      const textNode = new Konva.Text({
        x: node.x + nodePadding,
        y: node.y - 7,
        text: displayText,
        fontSize: 14,
        fontFamily: "sans-serif",
        fill: isRoot ? "#ffffff" : isEmpty ? "#94a3b8" : "#0f172a",
        fontStyle: isEmpty ? "italic" : "normal",
        listening: false,
      });
      group.add(textNode);

      // Click → activate node
      group.on("mousedown touchstart", (e: any) => {
        e.cancelBubble = true;
        const stage = konvaStageRef.current;
        if (!stage) return;
        const pointer = stage.getPointerPosition();
        if (!pointer) return;

        const scale = stage.scaleX();
        const clickX =
          (pointer.x - stage.x()) / scale - node.x - nodePadding;

        // Find closest character position
        const offsets = cursorOffsets.get(node.id);
        let charIdx = displayRaw.length;
        if (offsets) {
          let bestIdx = 0;
          let bestDist = Math.abs(clickX);
          for (let i = 1; i < offsets.length; i++) {
            const dist = Math.abs(clickX - offsets[i]);
            if (dist < bestDist) {
              bestDist = dist;
              bestIdx = i;
            }
          }
          charIdx = bestIdx;
        }

        setActiveNodeId(node.id);
        const modelNode = findNode(modelRef.current, node.id);
        setEditingText(modelNode?.text || "");
        setCursorPos(charIdx);
        setSelectionEnd(charIdx);
        setSelAnchorNodeId(node.id);
        setSelAnchorOffset(charIdx);

        // Start drag selection
        dragStateRef.current = { nodeId: node.id, anchorCharIdx: charIdx };
        const stageRef = konvaStageRef.current;
        if (stageRef) stageRef.draggable(false);

        setTimeout(() => {
          if (inputRef.current) {
            inputRef.current.focus();
            inputRef.current.setSelectionRange(charIdx, charIdx);
          }
        }, 0);
      });

      // Double-click → select all text
      group.on("dblclick dbltap", () => {
        const modelNode = findNode(modelRef.current, node.id);
        if (!modelNode) return;
        setActiveNodeId(node.id);
        setEditingText(modelNode.text);
        setCursorPos(0);
        setSelectionEnd(modelNode.text.length);
        setTimeout(() => {
          if (inputRef.current) {
            inputRef.current.focus();
            inputRef.current.setSelectionRange(0, modelNode.text.length);
          }
        }, 0);
      });

      layer.add(group);
    });

    layer.draw();
  }, [nodes, activeNodeId, editingText, konvaReady]);

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

    const nodePadding = 20;
    const isMulti =
      selAnchorNodeId !== null && selAnchorNodeId !== activeNodeId;

    if (isMulti) {
      // Multi-node selection highlight
      const order = getFlatOrder(modelRef.current);
      const anchorIdx = order.indexOf(selAnchorNodeId);
      const focusIdx = order.indexOf(activeNodeId);
      const startIdx = Math.min(anchorIdx, focusIdx);
      const endIdx = Math.max(anchorIdx, focusIdx);

      // Determine start/end offsets based on direction
      const isForward = anchorIdx <= focusIdx;
      const startNodeId = isForward ? selAnchorNodeId : activeNodeId;
      const startOffset = isForward ? selAnchorOffset : cursorPos;
      const endNodeId = isForward ? activeNodeId : selAnchorNodeId;
      const endOffset = isForward ? cursorPos : selAnchorOffset;

      for (let i = startIdx; i <= endIdx; i++) {
        const nodeId = order[i];
        const node = nodes.find((n) => n.id === nodeId);
        if (!node) continue;

        const nodeOffsets = cursorOffsetsRef.current.get(nodeId);
        const isRoot = nodes.indexOf(node) === 0;
        const modelNode = findNode(modelRef.current, nodeId);
        const textLen = modelNode?.text.length || 0;

        let hlStart = 0;
        let hlEnd = textLen;

        if (nodeId === startNodeId) {
          hlStart = startOffset;
        }
        if (nodeId === endNodeId) {
          hlEnd = endOffset;
        }

        if (hlStart < hlEnd && nodeOffsets) {
          const startX = nodeOffsets[hlStart] || 0;
          const endX = nodeOffsets[hlEnd] || 0;
          if (endX > startX) {
            const highlight = new Konva.Rect({
              x: node.x + nodePadding + startX,
              y: node.y - 10,
              width: endX - startX,
              height: 20,
              fill: isRoot
                ? "rgba(255, 255, 255, 0.3)"
                : "rgba(16, 185, 129, 0.18)",
              listening: false,
            });
            cursorLayer.add(highlight);
          }
        }
      }
    } else {
      // Single-node selection or cursor
      const activeNode = nodes.find((n) => n.id === activeNodeId);
      if (!activeNode) return;

      const isRoot = nodes.indexOf(activeNode) === 0;
      const offsets = cursorOffsetsRef.current.get(activeNodeId);

      // Selection highlight
      if (cursorPos !== selectionEnd) {
        const selStart = Math.min(cursorPos, selectionEnd);
        const selEndPos = Math.max(cursorPos, selectionEnd);
        const selStartX = offsets?.[selStart] || 0;
        const selEndX = offsets?.[selEndPos] || 0;
        if (selEndX > selStartX) {
          const highlight = new Konva.Rect({
            x: activeNode.x + nodePadding + selStartX,
            y: activeNode.y - 10,
            width: selEndX - selStartX,
            height: 20,
            fill: isRoot
              ? "rgba(255, 255, 255, 0.3)"
              : "rgba(16, 185, 129, 0.18)",
            listening: false,
          });
          cursorLayer.add(highlight);
        }
      }

      // Cursor line
      if (cursorVisible && cursorPos === selectionEnd) {
        const cursorX =
          activeNode.x + nodePadding + (offsets?.[cursorPos] || 0);
        const line = new Konva.Line({
          points: [cursorX, activeNode.y - 10, cursorX, activeNode.y + 10],
          stroke: isRoot ? "#ffffff" : "#0f172a",
          strokeWidth: 2,
          listening: false,
        });
        cursorLayer.add(line);
      }
    }

    cursorLayer.draw();
  }, [activeNodeId, cursorPos, selectionEnd, cursorVisible, nodes, selAnchorNodeId, selAnchorOffset]);

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
      <header className="flex h-14 items-center justify-between gap-3 border-b border-slate-200 bg-white px-4 md:px-6">
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
          className="absolute inset-0 bg-[radial-gradient(#dbe2ea_1px,transparent_1px)] [background-size:20px_20px]"
        />
        <input
          ref={inputRef}
          value={editingText}
          onChange={handleInputChange}
          onKeyDown={handleKeyDown}
          onSelect={handleSelect}
          onCompositionStart={() => setIsComposing(true)}
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
            fontSize: "14px",
          }}
        />
      </div>
    </div>
  );
}
