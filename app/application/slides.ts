/**
 * Application layer: the document read as a slide deck (プレゼンモード).
 *
 * The map is already a talk outline, so the deck is derived from the tree
 * with no extra markup, by one rule that holds anywhere in the tree:
 *
 *  - every ROOT opens with a title slide;
 *  - a branch small enough to read at once (≤ {@link SLIDE_MAX_ITEMS}
 *    non-blank descendants) is ONE content slide: the node is the heading and
 *    its descendants are nested bullets;
 *  - a bigger branch becomes a section slide (heading + its children as the
 *    agenda) and each child is laid out by the same rule.
 *
 * Collapse is ignored — it is a view state of the editor, not of the talk.
 * Blank text leaves (an empty node left behind while typing) are skipped.
 */
import { locateNode, subtreeIds, type MindMapDocument, type MindMapModel } from "../domain/model";
import { nodeDisplayText } from "./nodeUtils";

/** Bullets that still fit on one slide; a bigger branch is split into a section. */
export const SLIDE_MAX_ITEMS = 10;

export interface SlideItem {
  node: MindMapModel;
  /** Nesting below the slide heading (0 = direct child). */
  depth: number;
}

export interface Slide {
  kind: "title" | "section" | "content";
  heading: MindMapModel;
  /** Display texts of the heading's ancestors, root first (empty on a title slide). */
  trail: string[];
  items: SlideItem[];
  /** Nodes this slide presents — where "start from the selected node" lands. */
  ids: string[];
}

function isBlankLeaf(n: MindMapModel): boolean {
  return (n.type ?? "text") === "text" && n.text.trim() === "" && n.children.length === 0;
}

function contentChildren(n: MindMapModel): MindMapModel[] {
  return n.children.filter((c) => !isBlankLeaf(c));
}

function bullets(n: MindMapModel, depth = 0): SlideItem[] {
  return contentChildren(n).flatMap((c) => [{ node: c, depth }, ...bullets(c, depth + 1)]);
}

function branchSlides(node: MindMapModel, trail: string[]): Slide[] {
  const items = bullets(node);
  if (items.length <= SLIDE_MAX_ITEMS) {
    return [{ kind: "content", heading: node, trail, items, ids: subtreeIds(node) }];
  }
  const children = contentChildren(node);
  const inner = [...trail, nodeDisplayText(node)];
  return [
    {
      kind: "section",
      heading: node,
      trail,
      items: children.map((c) => ({ node: c, depth: 0 })),
      ids: [node.id],
    },
    ...children.flatMap((c) => branchSlides(c, inner)),
  ];
}

export function buildSlides(doc: MindMapDocument): Slide[] {
  return doc.roots
    .filter((r) => !isBlankLeaf(r))
    .flatMap((root) => [
      { kind: "title" as const, heading: root, trail: [], items: [], ids: [root.id] },
      ...contentChildren(root).flatMap((c) => branchSlides(c, [nodeDisplayText(root)])),
    ]);
}

/**
 * The slide that presents `nodeId`, or the one of its nearest ancestor that
 * has one (a skipped blank leaf); 0 when nothing matches.
 */
export function slideIndexOf(slides: Slide[], doc: MindMapDocument, nodeId: string): number {
  for (let id: string | undefined = nodeId; id; id = locateNode(doc, id)?.parent?.id) {
    const i = slides.findIndex((s) => s.ids.includes(id!));
    if (i >= 0) return i;
  }
  return 0;
}
