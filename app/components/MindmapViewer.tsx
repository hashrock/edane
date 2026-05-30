import { useState, useEffect, useRef, useMemo } from "react";
import type { MindMapNode } from "../types/MindMap";
import { layoutMindMap } from "../lib/treeLayout";
import { parseContent } from "../application/persistence";
import { flattenToNodes } from "../application/nodeUtils";

interface Props {
  initialContent: string;
  title: string;
}

export default function MindmapViewer({ initialContent, title }: Props) {
  const canvasRef = useRef<HTMLDivElement>(null);
  const konvaStageRef = useRef<any>(null);

  const nodes = useMemo(() => {
    const model = parseContent(initialContent, title);
    const flat = flattenToNodes(model);
    if (flat.length > 0) layoutMindMap(flat);
    return flat;
  }, [initialContent, title]);

  useEffect(() => {
    if (!canvasRef.current || nodes.length === 0) return;

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

      const textWidths = new Map<string, number>();
      nodes.forEach((node) => {
        const displayText = node.text === "" ? "empty" : node.text;
        const t = new Konva.Text({
          text: displayText,
          fontSize: 14,
          fontFamily: "sans-serif",
        });
        textWidths.set(node.id, t.width());
      });

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
        const textWidth = textWidths.get(node.id) || 100;
        const padding = 20;
        const rectWidth = Math.max(
          textWidth + padding * 2,
          isRoot ? 100 : 80
        );
        const rectHeight = 32;

        const rect = new Konva.Rect({
          x: node.x,
          y: node.y - rectHeight / 2,
          width: rectWidth,
          height: rectHeight,
          cornerRadius: 4,
          fill: isRoot ? "#000000" : isEmpty ? "#fafafa" : "#ffffff",
          stroke: isRoot ? "#000000" : "#808080",
          strokeWidth: 1,
        });
        layer.add(rect);

        const textNode = new Konva.Text({
          x: node.x + padding,
          y: node.y - 7,
          text: displayText,
          fontSize: 14,
          fontFamily: "sans-serif",
          fill: isRoot ? "#ffffff" : isEmpty ? "#808080" : "#000000",
          fontStyle: isEmpty ? "italic" : "normal",
        });
        layer.add(textNode);
      });

      layer.draw();

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
      });

      const resizeObserver = new ResizeObserver(() => {
        stage.width(container.clientWidth);
        stage.height(container.clientHeight);
        layer.draw();
      });
      resizeObserver.observe(container);
    });

    return () => {
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
