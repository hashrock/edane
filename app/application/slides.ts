/**
 * Application layer: the document read as a slide deck (プレゼンモード).
 *
 * The map is already a talk outline, so the deck is derived from the tree
 * with no extra markup, by one rule that holds anywhere in the tree:
 *
 *  - every ROOT opens with a title slide, and each of its children is laid
 *    out by the rule below;
 *  - a branch whose nested bullets FIT on one slide is ONE content slide: the
 *    node is the heading and its descendants are the bullets. "Fit" is
 *    measured ({@link slideFits}): wrapped lines of text, images and markdown
 *    at a body size still readable from the back of a room — not a count of
 *    nodes, and the same wherever the branch sits;
 *  - a branch that doesn't fit is split by what its children are:
 *    - only leaves and items with a one-line note → one list continued over
 *      pages ("見出し (1/2)", "(2/2)"), cut into balanced runs, each item kept
 *      whole with its note. A list is never exploded into a slide per item;
 *    - some children are TOPICS (two bullets or more under them) → a section
 *      slide listing the children as the agenda (the small ones in full),
 *      then each topic by the same rule;
 *    - a single child → no agenda to give; the child stands in its place.
 *  - `slideSplit` overrides this per node: `true` splits it even when it fits
 *    and gives every child slides of its own (one message per slide) — and,
 *    so the switch always shows, no ancestor of such a node is folded into one
 *    slide; `false` keeps it one list continued over pages.
 *
 * Two section slides never follow each other: when a section's first topic
 * would open with its own section, its children are nested into the outer
 * agenda instead (if that still fits).
 *
 * The trail (breadcrumb) is the path from below the root: the title slide
 * already said which talk this is.
 *
 * Collapse is ignored — it is a view state of the editor, not of the talk.
 * Blank text leaves (an empty node left behind while typing) are skipped.
 */
import { findNode, locateNode, subtreeIds, type MindMapDocument, type MindMapModel } from "../domain/model";
import { nodeDisplayText, supportsCheckbox } from "./nodeUtils";
import { markdownTitle } from "./markdownCard";

export interface SlideItem {
  node: MindMapModel;
  /** Nesting below the slide heading (0 = direct child). */
  depth: number;
}

/** Bullet type size; webpage.css draws each in the slide variant. */
export type SlideItemSize = "l" | "m" | "s";

export interface Slide {
  kind: "title" | "section" | "content";
  heading: MindMapModel;
  /** Display texts of the heading's ancestors below the root (empty on a title slide). */
  trail: string[];
  items: SlideItem[];
  /** Nodes this slide presents — where "start from the selected node" lands. */
  ids: string[];
  /** One page of a heading continued over several (1-based); absent when it has one. */
  part?: { index: number; count: number };
  /** The biggest bullet size its items fit at (never bigger than the count allows). */
  size: SlideItemSize;
}

/** A node as a breadcrumb label: what the canvas shows for it. */
function label(n: MindMapModel): string {
  return n.type === "markdown" ? markdownTitle(n.text) : nodeDisplayText(n);
}

/** A text leaf with nothing in it: left behind while typing, never presented. */
export function isBlankLeaf(n: MindMapModel): boolean {
  return (n.type ?? "text") === "text" && n.text.trim() === "" && n.children.length === 0;
}

function contentChildren(n: MindMapModel): MindMapModel[] {
  return n.children.filter((c) => !isBlankLeaf(c));
}

// --- Measuring a slide -------------------------------------------------------
//
// The slide variant of webpage.css sizes everything in cqw of a 16:9 stage
// (100 wide, 56.25 tall). These mirror its numbers (keep the two in step;
// slideFit.browser.test.tsx draws the slides to check). Text width is
// estimated per character (full-width 1em, the rest ~0.55em), which is all a
// layout decision needs — the stage clips anything that still overflows.

const STAGE_H = 56.25;
const INNER_W = 88; // 100 − 2 × 6 padding
const INNER_H = STAGE_H - 4.5 - 5;
const TRAIL_H = 1.4 * 1.25 + 1; // 1.4cqw at the default line height, + its margin
const HEADING_FONT = 4;
const HEADING_LINE_HEIGHT = 1.2;
const HEADING_W = INNER_W / HEADING_FONT - 1; // in heading em, less a style's padding
const HEADING_GAP = 2.5;
const ITEM_GAP = 0.9;
const BULLET_EM = 1; // bullet glyph + the 1cqw gap, roughly
const INDENT_EM = 1.6;
const NESTED_SCALE = 0.85;
const LINE_HEIGHT = 1.4;
const IMAGE_H = 30;
const SIZES: SlideItemSize[] = ["l", "m", "s"];
const SIZE_FONT: Record<SlideItemSize, number> = { l: 3, m: 2.5, s: 2.1 };

/**
 * Count-based cap: a short page's few bullets get the big type, so it doesn't
 * look empty. Never "s": that size is only reached for a slide that can't
 * fit otherwise.
 */
function countSize(n: number): SlideItemSize {
  return n <= 4 ? "l" : "m";
}

function charWidth(ch: string): number {
  const c = ch.codePointAt(0)!;
  const wide =
    (c >= 0x1100 && c <= 0x115f) ||
    (c >= 0x2e80 && c <= 0xa4cf) ||
    (c >= 0xac00 && c <= 0xd7a3) ||
    (c >= 0xf900 && c <= 0xfaff) ||
    (c >= 0xfe30 && c <= 0xfe4f) ||
    (c >= 0xff00 && c <= 0xff60) ||
    (c >= 0xffe0 && c <= 0xffe6) ||
    c >= 0x1f300;
  return wide ? 1 : 0.55;
}

/**
 * The width of each line of `text`, in em. Memoized by text: a deck is
 * rebuilt on every edit, and a node's text is measured at every level of the
 * tree above it, but rarely changes.
 */
const widthCache = new Map<string, number[]>();
function lineWidths(text: string): number[] {
  let widths = widthCache.get(text);
  if (!widths) {
    widths = text.split("\n").map((line) => {
      let w = 0;
      for (const ch of line) w += charWidth(ch);
      return w;
    });
    if (widthCache.size > 5000) widthCache.clear();
    widthCache.set(text, widths);
  }
  return widths;
}

/** Lines `text` wraps to in a column `widthEm` wide (explicit newlines kept). */
function wrappedLines(text: string, widthEm: number): number {
  return lineWidths(text).reduce((lines, w) => lines + Math.max(1, Math.ceil(w / widthEm)), 0);
}

const headingLines = (text: string) => wrappedLines(text, HEADING_W);

/** Height of one bullet, in cqw, drawn at `font` (the list's size). */
function itemHeight({ node, depth }: SlideItem, font: number): number {
  const f = depth > 0 ? font * NESTED_SCALE : font;
  const type = node.type ?? "text";
  if (type === "image") return IMAGE_H;
  const width = INNER_W / f - INDENT_EM * depth - BULLET_EM;
  if (type === "markdown") {
    // Blocks are separated by blank lines; give each a little extra for its margins.
    const blocks = node.text.split(/\n\s*\n/).filter((b) => b.trim());
    const lines = blocks.reduce((sum, b) => sum + wrappedLines(b.trim(), width) + 0.6, 0);
    return Math.max(1, lines) * f * LINE_HEIGHT;
  }
  const check = node.checked !== undefined && supportsCheckbox(type) ? "☐ " : "";
  return wrappedLines(check + nodeDisplayText(node), width) * f * LINE_HEIGHT;
}

/**
 * The room a content or section slide leaves for its bullets, in cqw. It
 * always reserves a trail and a page number, so whether a branch fits doesn't
 * depend on how deep it sits or whether it is continued.
 */
function itemRoom(heading: MindMapModel): number {
  const headingH = headingLines(label(heading) + " (9/9)") * HEADING_FONT * HEADING_LINE_HEIGHT;
  return INNER_H - TRAIL_H - headingH - HEADING_GAP;
}

function listHeight(items: SlideItem[], font: number): number {
  return items.reduce((sum, it) => sum + itemHeight(it, font), 0) + ITEM_GAP * Math.max(0, items.length - 1);
}

/**
 * The biggest bullet size from `smallest` up that `items` fit at under
 * `heading`, or null. Never bigger than {@link countSize} allows.
 */
function fitSize(heading: MindMapModel, items: SlideItem[], smallest: SlideItemSize): SlideItemSize | null {
  const room = itemRoom(heading);
  const from = SIZES.indexOf(countSize(items.length));
  for (const size of SIZES.slice(from, SIZES.indexOf(smallest) + 1)) {
    if (listHeight(items, SIZE_FONT[size]) <= room) return size;
  }
  return null;
}

/**
 * Whether `items` fit on one slide under `heading` at a size still readable
 * from the back of a room ("m"). The smallest size is only a last resort, for
 * a single item too big to split.
 */
export function slideFits(heading: MindMapModel, items: SlideItem[]): boolean {
  return fitSize(heading, items, "m") !== null;
}

// --- Building the deck -------------------------------------------------------

/** All of `n`'s descendants as nested bullets, in outline order. */
function bullets(n: MindMapModel, depth = 0, out: SlideItem[] = []): SlideItem[] {
  for (const c of contentChildren(n)) {
    out.push({ node: c, depth });
    bullets(c, depth + 1, out);
  }
  return out;
}

/** A child and its nested bullets: what travels together on a page. */
function unit(c: MindMapModel): SlideItem[] {
  return bullets(c, 1, [{ node: c, depth: 0 }]);
}

const names = (children: MindMapModel[]): SlideItem[] => children.map((c) => ({ node: c, depth: 0 }));

/** Whether `n` or anything under it asks to be split ({@link MindMapModel.slideSplit}). */
const asksSplit = (n: MindMapModel): boolean =>
  (n.slideSplit === true && contentChildren(n).length > 0) || n.children.some(asksSplit);

/** Whether `n` reads as a slide heading: two heading lines at most (not a paragraph). */
const headingFits = (n: MindMapModel) => headingLines(label(n)) <= 2;

/** Whether `n` has two bullets or more under it. */
function deep(n: MindMapModel): boolean {
  const children = contentChildren(n);
  return children.length >= 2 || (children.length === 1 && contentChildren(children[0]).length > 0);
}

/**
 * A child worth slides of its own when its parent is split: one with some
 * depth to it (two bullets or more), or one with a split asked for inside —
 * and whose text can head a slide. A leaf, an item with a one-line note or a
 * paragraph is said in full on its parent's page.
 */
const isTopic = (n: MindMapModel) => headingFits(n) && (asksSplit(n) || deep(n));

/** Whether the "how to split into slides" choice means anything for `n`: it has children to split. */
export const splittable = (n: MindMapModel) => contentChildren(n).length > 0;

function slide(kind: "section" | "content", heading: MindMapModel, trail: string[], items: SlideItem[], ids: string[]): Slide {
  return { kind, heading, trail, items, ids, size: fitSize(heading, items, "s") ?? "s" };
}

/**
 * `units` cut into the fewest pages that fit, balanced so the last page isn't
 * a stub. A unit is never cut.
 */
function paginate(heading: MindMapModel, units: SlideItem[][]): SlideItem[][] {
  const room = itemRoom(heading);
  const heights = units.map((u) => listHeight(u, SIZE_FONT.m));
  const greedy = (limit: number): SlideItem[][] => {
    const pages: SlideItem[][] = [];
    let used = Infinity;
    units.forEach((u, i) => {
      const h = heights[i];
      if (used + ITEM_GAP + h > limit) {
        pages.push([...u]);
        used = h;
      } else {
        pages[pages.length - 1].push(...u);
        used += ITEM_GAP + h;
      }
    });
    return pages;
  };
  const count = greedy(room).length;
  // The smallest page limit that still needs no more pages: an even split.
  let lo = Math.max(...heights);
  let hi = Math.max(room, lo);
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2;
    if (greedy(mid).length <= count) hi = mid;
    else lo = mid;
  }
  return greedy(hi);
}

/**
 * Number a heading's pages of one kind "(1/n)" when there are several, and
 * give them one type size: a list shouldn't change size as it flips. An
 * agenda and the list after it are numbered apart, unless `acrossKinds`
 * (the heading comes back between other slides: every return is numbered).
 */
function numbered(slides: Slide[], heading: MindMapModel, acrossKinds = false): Slide[] {
  const group = (x: Slide) => acrossKinds || x.kind;
  return slides.map((s) => {
    if (s.heading !== heading) return s;
    const own = slides.filter((o) => o.heading === heading && group(o) === group(s));
    // The smallest size only stays on the page that needed it (one item too big to split).
    const readable = own.filter((o) => o.kind === s.kind && o.size !== "s").map((o) => SIZES.indexOf(o.size));
    const size = s.size === "s" ? s.size : SIZES[Math.max(...readable)];
    return { ...s, size, ...(own.length > 1 && { part: { index: own.indexOf(s) + 1, count: own.length } }) };
  });
}

/**
 * `units` under one heading over as many pages as they need. A page presents
 * the children whose units it holds (the heading itself is added by
 * {@link branchSlides}, once).
 */
function pages(kind: "section" | "content", heading: MindMapModel, trail: string[], units: SlideItem[][]): Slide[] {
  const items = units.flat();
  const runs = slideFits(heading, items) ? [items] : paginate(heading, units);
  return runs.map((run) => slide(kind, heading, trail, run, run.filter((it) => it.depth === 0).flatMap((it) => subtreeIds(it.node))));
}

/**
 * A branch whose children don't all get slides, read in outline order:
 *
 *  - a child that `breaks` out gets its own slides in its place;
 *  - when none does, the branch is one list continued over pages
 *    ("見出し (1/2)"), every child whole with its notes;
 *  - otherwise a door (the children's names, if they fit) opens the branch,
 *    and the small children between the broken-out ones go on pages under
 *    its heading, numbered "(k/n)" with the door. A run of bare leaves is
 *    already said in full by the door and gets no page; a lone item with a
 *    note heads its own slide. A list `kept` together only opens with a door
 *    when a child's slides would otherwise come first, and keeps every small
 *    child on its pages.
 *
 * Anything too big for a page that isn't a topic (one long paragraph) stays
 * under this heading on a page of its own — never promoted to a heading.
 */
function mixedSlides(node: MindMapModel, trail: string[], breaks: (c: MindMapModel) => boolean, kept: boolean): Slide[] {
  const inner = [...trail, label(node)];
  const children = contentChildren(node);
  const broken = new Set(children.filter(breaks));
  if (broken.size === 0) return numbered(pages("content", node, trail, children.map(unit)), node);

  const agenda = slideFits(node, names(children));
  const door = !kept || broken.has(children[0]);
  // Bare leaves between broken-out children: said in full by the door.
  const leafRun = (run: MindMapModel[]) => door && !kept && agenda && run.every((c) => contentChildren(c).length === 0);
  const runs: MindMapModel[][] = [[]];
  for (const c of children) {
    if (broken.has(c)) runs.push([c], []);
    else runs[runs.length - 1].push(c);
  }
  const doorIds = runs.filter((r) => r.length && !broken.has(r[0]) && leafRun(r)).flat().flatMap(subtreeIds);
  const out: Slide[] = door ? [slide("section", node, trail, agenda ? names(children) : [], doorIds)] : [];
  for (const run of runs) {
    if (run.length === 0 || (!broken.has(run[0]) && leafRun(run))) continue;
    // A broken-out child, or a lone item with a note heading its own slide
    // (the section it is, not a return to the parent).
    if (broken.has(run[0]) || (!kept && run.length === 1 && contentChildren(run[0]).length > 0 && headingFits(run[0]))) {
      out.push(...branchSlides(run[0], inner));
    } else out.push(...pages("content", node, trail, run.map(unit)));
  }
  return numbered(out, node, true);
}

/** A branch's slides; the node itself is presented by the first of them. */
function branchSlides(node: MindMapModel, trail: string[]): Slide[] {
  const children = contentChildren(node);
  const items = bullets(node);
  if (children.length === 0 || (!asksSplit(node) && slideFits(node, items))) {
    return [slide("content", node, trail, items, subtreeIds(node))];
  }
  const [first, ...rest] = splitBranch(node, trail, children);
  return [{ ...first, ids: [node.id, ...first.ids] }, ...rest];
}

function splitBranch(node: MindMapModel, trail: string[], children: MindMapModel[]): Slide[] {
  const inner = [...trail, label(node)];
  const tooBig = (c: MindMapModel) => asksSplit(c) || (isTopic(c) && !slideFits(node, unit(c)));
  if (node.slideSplit === false) return mixedSlides(node, trail, tooBig, true);
  // One topic child: no agenda to give, so it stands in the branch's place.
  if (children.length === 1 && isTopic(children[0])) return branchSlides(children[0], inner);
  const topics = children.filter(isTopic).length;
  if (node.slideSplit !== true && topics < children.length) {
    // Mostly topics: a narrative, each topic in its place. Mostly small: an enumeration, one list.
    return mixedSlides(node, trail, topics * 2 < children.length ? tooBig : isTopic, false);
  }

  // Every child gets slides: an agenda of their names, then each in turn.
  const sub = children.flatMap((c) => branchSlides(c, inner));
  const next = sub[0];
  // Never two section slides in a row: fold the first child's agenda into this one.
  if (next?.kind === "section" && !next.part && next.heading.id === children[0].id && !children[0].slideSplit) {
    const [head, ...rest] = names(children);
    const folded = [head, ...next.items.map((it) => ({ ...it, depth: it.depth + 1 })), ...rest];
    if (slideFits(node, folded)) return [slide("section", node, trail, folded, next.ids), ...sub.slice(1)];
  }
  const agenda = pages("section", node, trail, names(children).map((it) => [it])).map((s) => ({ ...s, ids: [] }));
  return [...numbered(agenda, node), ...sub];
}

export function buildSlides(doc: MindMapDocument): Slide[] {
  return doc.roots
    .filter((r) => !isBlankLeaf(r))
    .flatMap((root) => [
      { kind: "title" as const, heading: root, trail: [], items: [], ids: [root.id], size: "l" as const },
      ...contentChildren(root).flatMap((c) => branchSlides(c, [])),
    ]);
}

/** `nodeId` and its ancestors, nearest first (empty for null). */
export function ancestry(doc: MindMapDocument, nodeId: string | null): string[] {
  const chain: string[] = [];
  for (let id = nodeId ?? undefined; id; id = locateNode(doc, id)?.parent?.id) chain.push(id);
  return chain;
}

/**
 * The slide that presents `nodeId`, or the one of its nearest ancestor that
 * has one (a skipped blank leaf); 0 when nothing matches.
 */
export function slideIndexOf(slides: Slide[], doc: MindMapDocument, nodeId: string | null): number {
  for (const id of ancestry(doc, nodeId)) {
    const i = slides.findIndex((s) => s.ids.includes(id));
    if (i >= 0) return i;
  }
  return 0;
}

/** Indices of the slides that present some node of `nodeId`'s branch (the node and its descendants). */
export function branchSlideIndices(slides: Slide[], doc: MindMapDocument, nodeId: string | null): number[] {
  const node = nodeId ? findNode(doc, nodeId) : null;
  if (!node) return [];
  const ids = new Set(subtreeIds(node));
  return slides.flatMap((s, i) => (s.ids.some((id) => ids.has(id)) ? [i] : []));
}

/** Where a node of a branch lands in the deck: shown over the map while choosing how to split it. */
export interface PageMark {
  /** The deck's page number (1-based), as the preview counter and the slideshow count. */
  page: number;
  /** The page's position within the branch (0-based): picks its colour. */
  order: number;
  /** The first node of its page in outline order: where the page number is drawn. */
  first: boolean;
}

/**
 * The page each node of `nodeId`'s branch is presented on (blank leaves,
 * never presented, are left out).
 */
export function branchPageMarks(slides: Slide[], doc: MindMapDocument, nodeId: string | null): Map<string, PageMark> {
  const node = nodeId ? findNode(doc, nodeId) : null;
  const marks = new Map<string, PageMark>();
  if (!node) return marks;
  const ids = subtreeIds(node);
  const pageOf = new Map<string, { page: number; order: number }>();
  branchSlideIndices(slides, doc, nodeId).forEach((i, order) => {
    for (const id of slides[i].ids) if (!pageOf.has(id)) pageOf.set(id, { page: i + 1, order });
  });
  const seen = new Set<number>();
  for (const id of ids) {
    const p = pageOf.get(id);
    if (!p) continue;
    marks.set(id, { ...p, first: !seen.has(p.page) });
    seen.add(p.page);
  }
  return marks;
}

/** How many slides present some node of `nodeId`'s branch. */
export function branchSlideCount(slides: Slide[], doc: MindMapDocument, nodeId: string | null): number {
  return branchSlideIndices(slides, doc, nodeId).length;
}
