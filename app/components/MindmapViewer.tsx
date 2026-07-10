import { useState, useEffect, useRef, useMemo } from "react";
import type { MindMapNode } from "../application/nodeUtils";
import { layoutMindMap } from "../lib/treeLayout";
import { LINE_HEIGHT, KONVA_LINE_HEIGHT } from "../lib/measureText";
import { subscribeImages, imageDisplaySize } from "../lib/imageCache";
import { parseContent } from "../application/persistence";
import { flattenToNodes, layoutObjectRows } from "../application/nodeUtils";
import { KEY_FONT_SIZE, KEY_GAP, ROW_V_PAD } from "../application/objectCard";
import { attachStagePanZoom } from "./stagePanZoom";

const PADDING = 20;

interface Props {
  initialContent: string;
  title: string;
}

export default function MindmapViewer({ initialContent, title }: Props) {
  const canvasRef = useRef<HTMLDivElement>(null);
  const konvaStageRef = useRef<any>(null);

  const [imageVersion, setImageVersion] = useState(0);
  useEffect(() => subscribeImages(() => setImageVersion((v) => v + 1)), []);

  const nodes = useMemo(() => {
    const model = parseContent(initialContent, title);
    const flat = flattenToNodes(model);
    if (flat.length > 0) {
      layoutMindMap(flat);
      layoutObjectRows(flat);
    }
    return flat;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialContent, title, imageVersion]);

  useEffect(() => {
    if (!canvasRef.current || nodes.length === 0) return;
    let detachPanZoom: (() => void) | null = null;

    import("konva").then((KonvaModule) => {
      const Konva = KonvaModule.default;
      const container = canvasRef.current!;

      if (konvaStageRef.current) {
        konvaStageRef.current.destroy();
      }

      const stage = new Konva.Stage({
        container,
        width: container.clientWidth,
        height: container.clientHeight,
        draggable: true,
      });
      konvaStageRef.current = stage;

      const layer = new Konva.Layer();
      stage.add(layer);

      const nodeMap: Record<string, MindMapNode> = {};
      nodes.forEach((n) => (nodeMap[n.id] = n));

      nodes.forEach((node) => {
        node.children.forEach((childId) => {
          const child = nodeMap[childId];
          if (!child) return;
          const parentWidth = node.width || 100;
          const startX = node.x + parentWidth + 40;
          const startY = node.y;
          const endX = child.x;
          const endY = child.y;
          const controlOffset = Math.abs(endX - startX) * 0.5;
          const path = new Konva.Path({
            data: `M ${startX} ${startY} C ${startX + controlOffset} ${startY}, ${endX - controlOffset} ${endY}, ${endX} ${endY}`,
            stroke: "#808080",
            strokeWidth: 1,
            fill: "transparent",
          });
          layer.add(path);
        });
      });

      nodes.forEach((node, index) => {
        const isRoot = index === 0;
        const isEmpty = node.text === "";
        const displayText = isEmpty ? "empty" : node.text;
        const isImage = node.type === "image";
        const isLink = node.type === "link";
        const isCard = !!node.card;
        const isRow = !!node.cardRow;
        const lineCount = isEmpty ? 1 : node.text.split("\n").length;
        const blockHeight = lineCount * LINE_HEIGHT;

        let rectWidth: number;
        const rectHeight = node.height;
        if (isImage) {
          rectWidth = (node.width || 100) + PADDING * 2;
        } else {
          rectWidth = Math.max((node.width || 100) + PADDING * 2, isRoot ? 100 : 80);
        }

        // Object-card field rows draw no box of their own (they live inside
        // their card's box, drawn by the card node just before them).
        if (!isRow) {
          const rect = new Konva.Rect({
            x: node.x,
            y: node.y - rectHeight / 2,
            width: rectWidth,
            height: rectHeight,
            cornerRadius: isCard ? 12 : 4,
            fill: isRoot ? "#000000" : isEmpty && !isCard ? "#fafafa" : "#ffffff",
            stroke: isRoot ? "#000000" : isCard ? "#7dd3fc" : "#808080",
            strokeWidth: isCard ? 1.5 : 1,
          });
          layer.add(rect);
        }

        if (isRow) {
          const r = node.cardRow!;
          const contentTop = node.y - rectHeight / 2 + ROW_V_PAD / 2;
          if (r.key !== null) {
            layer.add(
              new Konva.Text({
                x: node.x + PADDING,
                y: contentTop + 3,
                width: r.keyColW,
                text: r.key,
                fontSize: KEY_FONT_SIZE,
                fontFamily: "sans-serif",
                fill: "#64748b",
                wrap: "none",
                ellipsis: true,
              })
            );
          }
          const valueX =
            node.x + PADDING + (r.key !== null ? r.keyColW + KEY_GAP : 0);
          if (r.kind === "image") {
            const d = imageDisplaySize(node.text);
            if (d.status === "loaded" && d.img && r.thumbW && r.thumbH) {
              layer.add(
                new Konva.Image({
                  image: d.img,
                  x: valueX,
                  y: node.y - r.thumbH / 2,
                  width: r.thumbW,
                  height: r.thumbH,
                  cornerRadius: 6,
                })
              );
            }
          } else {
            const placeholder =
              r.display === "" ? (r.key !== null ? "—" : "empty") : null;
            const displayLines = (placeholder ?? r.display).split("\n").length;
            layer.add(
              new Konva.Text({
                x: valueX,
                y: node.y - (displayLines * LINE_HEIGHT) / 2 + 2,
                text: placeholder ?? r.display,
                fontSize: 14,
                fontFamily: "sans-serif",
                lineHeight: KONVA_LINE_HEIGHT,
                fill: placeholder
                  ? "#94a3b8"
                  : r.kind === "url"
                    ? "#2563eb"
                    : r.kind === "date"
                      ? "#0f766e"
                      : "#0f172a",
                fontStyle: placeholder ? "italic" : "normal",
                textDecoration: r.kind === "url" ? "underline" : "",
              })
            );
          }
        } else if (isCard) {
          layer.add(
            new Konva.Text({
              x: node.x + PADDING,
              y: node.y + (node.card?.titleOffsetY ?? 0) - blockHeight / 2 + 2,
              text: displayText,
              fontSize: 14,
              fontFamily: "sans-serif",
              lineHeight: KONVA_LINE_HEIGHT,
              fill: isEmpty ? "#94a3b8" : "#0369a1",
              fontStyle: isEmpty ? "italic" : "bold",
            })
          );
          const sepY = node.y + (node.card?.sepOffsetY ?? 0);
          layer.add(
            new Konva.Line({
              points: [node.x + 10, sepY, node.x + rectWidth - 10, sepY],
              stroke: "#bae6fd",
              strokeWidth: 1,
            })
          );
        } else if (isImage) {
          const d = imageDisplaySize(node.text);
          if (d.status === "loaded" && d.img) {
            layer.add(
              new Konva.Image({
                image: d.img,
                x: node.x + PADDING,
                y: node.y - d.h / 2,
                width: d.w,
                height: d.h,
                cornerRadius: 8,
              })
            );
          } else {
            layer.add(
              new Konva.Text({
                x: node.x + PADDING,
                y: node.y - 7,
                width: d.w,
                align: "center",
                text: d.status === "error" ? "画像を読み込めません" : "読み込み中…",
                fontSize: 12,
                fontFamily: "sans-serif",
                fill: "#808080",
              })
            );
          }
        } else {
          const textNode = new Konva.Text({
            x: node.x + PADDING,
            y: node.y - blockHeight / 2 + 2,
            text: displayText,
            fontSize: 14,
            fontFamily: "sans-serif",
            lineHeight: KONVA_LINE_HEIGHT,
            fill: isLink
              ? "#2563eb"
              : isRoot
                ? "#ffffff"
                : isEmpty
                  ? "#808080"
                  : "#000000",
            fontStyle: isEmpty ? "italic" : "normal",
            textDecoration: isLink ? "underline" : "",
          });
          layer.add(textNode);
        }

        // Collapsed indicator: pill showing the hidden child count.
        if (node.collapsed && node.childCount > 0) {
          const badgeR = 9;
          const badgeX = node.x + rectWidth + 4 + badgeR;
          layer.add(
            new Konva.Circle({
              x: badgeX,
              y: node.y,
              radius: badgeR,
              fill: "#000000",
            })
          );
          layer.add(
            new Konva.Text({
              x: badgeX - badgeR,
              y: node.y - 6,
              width: badgeR * 2,
              align: "center",
              text: String(node.childCount),
              fontSize: 11,
              fontFamily: "sans-serif",
              fill: "#ffffff",
            })
          );
        }
      });

      layer.draw();

      // Wheel: mouse wheel zooms (fixed steps), trackpad 2-finger scroll pans,
      // pinch zooms smoothly — see stagePanZoom / lib/panZoom.
      detachPanZoom = attachStagePanZoom(stage, () => layer.draw());

      const resizeObserver = new ResizeObserver(() => {
        stage.width(container.clientWidth);
        stage.height(container.clientHeight);
        layer.draw();
      });
      resizeObserver.observe(container);
    });

    return () => {
      detachPanZoom?.();
      if (konvaStageRef.current) {
        konvaStageRef.current.destroy();
        konvaStageRef.current = null;
      }
    };
  }, [nodes]);

  return (
    <div className="flex h-full">
      <div ref={canvasRef} className="flex-1 bg-white overflow-hidden" />
    </div>
  );
}
