/**
 * An executable SPECIFICATION of the canvas editor's keyboard/mouse behaviour,
 * used as the oracle of the graph-based e2e test
 * (app/components/MindmapEditor.graph.browser.test.tsx).
 *
 * Graph-based testing (cf. https://blog.kuniwak.com/entry/e2ebok): instead of
 * hand-picked event sequences, the spec is a state machine; an explorer walks
 * it against the real editor, and after every event checks
 *
 *   - safety:   the implementation reached the state the spec predicts
 *               (the observed trace is a trace of the spec), and
 *   - liveness: an event the spec ACCEPTS (changes the state) was not
 *               refused by the implementation, and an event the spec
 *               REFUSES (no-op) left the implementation untouched — the
 *               failures model, observed one event at a time.
 *
 * This file is deliberately written from the documented behaviour (CLAUDE.md,
 * the keymap's help labels) over its own tiny tree type, NOT by calling the
 * domain/application functions — an oracle that delegates to the code under
 * test can only ever agree with it. It imports nothing from the app.
 *
 * Scope: the canvas layout with DEFAULT_PREFERENCES (selection mode on,
 * Tab = insert child, Enter = insert sibling, ←/→ = navigate), single-line
 * texts, no folding / undo / clipboard. Extending the scope = adding an event
 * here and its driver in the browser test.
 */

export interface SpecNode {
  id: string;
  text: string;
  children: SpecNode[];
}

export interface SpecState {
  roots: SpecNode[];
  activeId: string;
  editing: boolean;
  /** Caret / selection inside the active node; only observed while editing. */
  caret: number;
  selEnd: number;
  /**
   * Hidden state: the child of each parent that the focus last landed on (→
   * resumes there). Not observable directly — only through where → goes.
   */
  lastChild: Readonly<Record<string, string>>;
}

export const KEYS = [
  "up",
  "down",
  "left",
  "right",
  "space",
  "enter",
  "tab",
  "shiftTab",
  "backspace",
  "escape",
  "type",
] as const;
export type SpecKey = (typeof KEYS)[number];

export type SpecEvent =
  | { kind: "key"; key: SpecKey }
  | { kind: "click"; id: string };

/** Id the spec gives a node it creates; the runner binds it to the real id. */
export const NEW_ID = "?new";

/** The character the "type" event types. */
export const TYPED_CHAR = "x";

// --- tiny tree toolkit (independent of app/domain) --------------------------

function clone(roots: SpecNode[]): SpecNode[] {
  return roots.map((n) => ({ ...n, children: clone(n.children) }));
}

interface Loc {
  parent: SpecNode | null;
  siblings: SpecNode[];
  index: number;
  node: SpecNode;
}

function locate(roots: SpecNode[], id: string): Loc | null {
  const walk = (parent: SpecNode | null, siblings: SpecNode[]): Loc | null => {
    for (let i = 0; i < siblings.length; i++) {
      const n = siblings[i];
      if (n.id === id) return { parent, siblings, index: i, node: n };
      const hit = walk(n, n.children);
      if (hit) return hit;
    }
    return null;
  };
  return walk(null, roots);
}

/** Depth-first reading order — what ↑/↓ walk while editing. */
export function flatIds(roots: SpecNode[]): string[] {
  const out: string[] = [];
  const walk = (ns: SpecNode[]) => {
    for (const n of ns) {
      out.push(n.id);
      walk(n.children);
    }
  };
  walk(roots);
  return out;
}

export function allIds(roots: SpecNode[]): Set<string> {
  return new Set(flatIds(roots));
}

const isBlank = (s: string) => s.trim() === "";

// --- the transition relation ------------------------------------------------

/** Where the focus goes when `id` disappears: the node before it in reading
 *  order, else (it was the very first node) the first remaining root. */
function predecessorOf(before: SpecNode[], id: string): string | null {
  const order = flatIds(before);
  const i = order.indexOf(id);
  return i > 0 ? order[i - 1] : null;
}

function removeBranch(s: SpecState, id: string): SpecState {
  const roots = clone(s.roots);
  const loc = locate(roots, id)!;
  loc.siblings.splice(loc.index, 1);
  let focus = predecessorOf(s.roots, id) ?? roots[0]?.id;
  if (roots.length === 0) {
    // A document always keeps a tree: the last one is replaced by a blank one.
    roots.push({ id: NEW_ID, text: "", children: [] });
    focus = NEW_ID;
  }
  return { ...s, roots, activeId: focus!, editing: false, caret: 0, selEnd: 0 };
}

/** "Make a sibling" — a root never gets a sibling (that would be a new
 *  tree); it gets a child instead, at `rootIndex`. */
function insertAfter(
  roots: SpecNode[],
  id: string,
  node: SpecNode,
  rootIndex: "first" | "last"
) {
  const loc = locate(roots, id)!;
  if (loc.parent === null) {
    if (rootIndex === "first") loc.node.children.unshift(node);
    else loc.node.children.push(node);
  } else {
    loc.siblings.splice(loc.index + 1, 0, node);
  }
}

function focus(s: SpecState, id: string, caret: number, selEnd = caret): SpecState {
  return { ...s, activeId: id, caret, selEnd };
}

function textOf(roots: SpecNode[], id: string): string {
  return locate(roots, id)?.node.text ?? "";
}

function moveFlat(s: SpecState, dir: -1 | 1, caretAt: "start" | "end"): SpecState {
  const order = flatIds(s.roots);
  const target = order[order.indexOf(s.activeId) + dir];
  if (target === undefined) return s;
  return focus(s, target, caretAt === "start" ? 0 : textOf(s.roots, target).length);
}

function dedent(s: SpecState): SpecState {
  const roots = clone(s.roots);
  const loc = locate(roots, s.activeId)!;
  if (loc.parent === null) return s;
  const grand = locate(roots, loc.parent.id)!;
  loc.siblings.splice(loc.index, 1);
  grand.siblings.splice(grand.index + 1, 0, loc.node);
  return { ...s, roots };
}

function insertChild(s: SpecState): SpecState {
  const roots = clone(s.roots);
  const node = locate(roots, s.activeId)!.node;
  if (isBlank(node.text)) return s; // never stack an empty child under an empty node
  node.children.push({ id: NEW_ID, text: "", children: [] });
  return { ...s, roots, activeId: NEW_ID, editing: true, caret: 0, selEnd: 0 };
}

function replaceSelection(s: SpecState, ch: string): SpecState {
  const roots = clone(s.roots);
  const node = locate(roots, s.activeId)!.node;
  const a = Math.min(s.caret, s.selEnd);
  const b = Math.max(s.caret, s.selEnd);
  node.text = node.text.slice(0, a) + ch + node.text.slice(b);
  return { ...s, roots, caret: a + ch.length, selEnd: a + ch.length };
}

function selectionStep(s: SpecState, key: SpecKey): SpecState {
  const loc = locate(s.roots, s.activeId)!;
  switch (key) {
    case "up": {
      // Previous sibling, else the parent; the first root is the top edge.
      const prev = loc.siblings[loc.index - 1];
      if (prev) return focus(s, prev.id, 0);
      return loc.parent ? focus(s, loc.parent.id, 0) : s;
    }
    case "down": {
      // Next sibling, else climb until an ancestor has one. Never descends.
      for (let at: Loc | null = loc; at; at = at.parent ? locate(s.roots, at.parent.id) : null) {
        const next = at.siblings[at.index + 1];
        if (next) return focus(s, next.id, 0);
      }
      return s;
    }
    case "left":
      // The parent also remembers the child being LEFT, so ← then → is a
      // round trip even if the focus reached the child some other way.
      if (!loc.parent) return s;
      return {
        ...focus(s, loc.parent.id, 0),
        lastChild: { ...s.lastChild, [loc.parent.id]: s.activeId },
      };
    case "right": {
      const kids = loc.node.children;
      if (kids.length === 0) return s;
      const remembered = s.lastChild[loc.node.id];
      return focus(s, kids.some((k) => k.id === remembered) ? remembered : kids[0].id, 0);
    }
    case "space":
      return { ...s, editing: true, caret: 0, selEnd: loc.node.text.length };
    case "enter": {
      const roots = clone(s.roots);
      insertAfter(roots, s.activeId, { id: NEW_ID, text: "", children: [] }, "last");
      return { ...s, roots, activeId: NEW_ID, editing: true, caret: 0, selEnd: 0 };
    }
    case "tab":
      return insertChild(s);
    case "shiftTab":
      return dedent(s);
    case "backspace":
      return removeBranch(s, s.activeId);
    case "escape":
      return s; // nothing to leave
    case "type":
      // A selected node has its whole text selected: typing replaces it and
      // starts editing (spreadsheet-style).
      return replaceSelection(
        { ...s, editing: true, caret: 0, selEnd: loc.node.text.length },
        TYPED_CHAR
      );
  }
}

function editingStep(s: SpecState, key: SpecKey): SpecState {
  const loc = locate(s.roots, s.activeId)!;
  const text = loc.node.text;
  const collapsed = s.caret === s.selEnd;
  const start = Math.min(s.caret, s.selEnd);
  const end = Math.max(s.caret, s.selEnd);
  switch (key) {
    // Single-line texts: ↑/↓ always leave the node (keyboard-escape invariant),
    // landing at the end of the neighbour's text.
    case "up":
      return moveFlat(s, -1, "end");
    case "down":
      return moveFlat(s, 1, "end");
    case "left":
      if (collapsed && s.caret === 0) return moveFlat(s, -1, "end");
      return collapsed ? focus(s, s.activeId, s.caret - 1) : focus(s, s.activeId, start);
    case "right":
      if (collapsed && s.caret === text.length) return moveFlat(s, 1, "start");
      return collapsed ? focus(s, s.activeId, s.caret + 1) : focus(s, s.activeId, end);
    case "space":
      return replaceSelection(s, " ");
    case "type":
      return replaceSelection(s, TYPED_CHAR);
    case "enter": {
      // Split at the selection start. The prefix keeps the node's id.
      const roots = clone(s.roots);
      if (start >= text.length) {
        insertAfter(roots, s.activeId, { id: NEW_ID, text: "", children: [] }, "last");
        return { ...s, roots, activeId: NEW_ID, caret: 0, selEnd: 0 };
      }
      const here = locate(roots, s.activeId)!;
      if (start === 0) {
        // Blank line ABOVE; the caret stays on this node.
        const blank = { id: NEW_ID, text: "", children: [] };
        if (here.parent === null) here.node.children.unshift(blank);
        else here.siblings.splice(here.index, 0, blank);
        return { ...s, roots, caret: 0, selEnd: 0 };
      }
      here.node.text = text.slice(0, start);
      insertAfter(roots, s.activeId, { id: NEW_ID, text: text.slice(start), children: [] }, "first");
      return { ...s, roots, activeId: NEW_ID, caret: 0, selEnd: 0 };
    }
    case "tab":
      return insertChild(s);
    case "shiftTab":
      return dedent(s);
    case "backspace": {
      if (!collapsed || s.caret > 0) {
        return replaceSelection(collapsed ? { ...s, caret: s.caret - 1 } : s, "");
      }
      // Join into the structural predecessor: previous sibling (children
      // trail its own) or, for a first child, the parent (children take its
      // slot). The first root has nothing before it.
      const roots = clone(s.roots);
      const here = locate(roots, s.activeId)!;
      const target = here.index > 0 ? here.siblings[here.index - 1] : here.parent;
      if (!target) return s;
      const join = target.text.length;
      target.text += here.node.text;
      if (here.index > 0) {
        target.children.push(...here.node.children);
        here.siblings.splice(here.index, 1);
      } else {
        here.siblings.splice(here.index, 1, ...here.node.children);
      }
      return { ...s, roots, activeId: target.id, caret: join, selEnd: join };
    }
    case "escape": {
      // Leaving a blank leaf deletes it (an accidental Enter then Esc leaves
      // nothing behind) — but never the only tree.
      const onlyRoot = s.roots.length === 1 && s.roots[0].id === s.activeId;
      if (isBlank(text) && loc.node.children.length === 0 && !onlyRoot) {
        return removeBranch(s, s.activeId);
      }
      return { ...s, editing: false };
    }
  }
}

/** δ: the spec's (deterministic) transition function. */
export function specStep(s: SpecState, ev: SpecEvent): SpecState {
  const next =
    ev.kind === "click"
      ? { ...s, activeId: ev.id, editing: false, caret: 0, selEnd: 0 }
      : s.editing
        ? editingStep(s, ev.key)
        : selectionStep(s, ev.key);
  return rememberFocus(s, next, ev);
}

/** Whenever the focus moves onto a node, its parent remembers it. */
function rememberFocus(prev: SpecState, next: SpecState, ev: SpecEvent): SpecState {
  if (next.activeId === prev.activeId && ev.kind !== "click") return next;
  const loc = locate(next.roots, next.activeId);
  if (!loc?.parent) return next;
  return { ...next, lastChild: { ...next.lastChild, [loc.parent.id]: next.activeId } };
}

/** Events the explorer may fire in `s` (every key, plus clicking any OTHER
 *  node; clicking the active node is caret placement, out of scope). */
export function enabledEvents(s: SpecState): SpecEvent[] {
  return [
    ...KEYS.map((key) => ({ kind: "key", key }) as const),
    ...flatIds(s.roots)
      .filter((id) => id !== s.activeId)
      .map((id) => ({ kind: "click", id }) as const),
  ];
}

// --- observation / comparison -----------------------------------------------

/** The observable part of a state (drops the hidden `lastChild`, and the
 *  caret outside editing mode). */
export interface Observation {
  roots: SpecNode[];
  activeId: string;
  editing: boolean;
  caret: number | null;
  selEnd: number | null;
}

export function observe(s: SpecState): Observation {
  return {
    roots: s.roots,
    activeId: s.activeId,
    editing: s.editing,
    caret: s.editing ? s.caret : null,
    selEnd: s.editing ? s.selEnd : null,
  };
}

export function sameObservation(a: Observation, b: Observation): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Bind the spec's placeholder id to the node the implementation actually
 * created: the single id present in `observed` but not in `before`. Returns
 * the spec state unchanged when it created nothing.
 */
export function bindNewId(spec: SpecState, before: Set<string>, observed: Observation): SpecState {
  if (!allIds(spec.roots).has(NEW_ID)) return spec;
  const fresh = [...allIds(observed.roots)].filter((id) => !before.has(id));
  if (fresh.length !== 1) return spec; // leave "?new" in place → mismatch is reported
  const realId = fresh[0];
  const rename = (ns: SpecNode[]): SpecNode[] =>
    ns.map((n) => ({ ...n, id: n.id === NEW_ID ? realId : n.id, children: rename(n.children) }));
  const swap = (id: string) => (id === NEW_ID ? realId : id);
  return {
    ...spec,
    roots: rename(spec.roots),
    activeId: swap(spec.activeId),
    lastChild: Object.fromEntries(
      Object.entries(spec.lastChild).map(([k, v]) => [swap(k), swap(v)])
    ),
  };
}

/**
 * Coverage class of a state: which situations the next event can meet.
 * The explorer counts (class, event) EDGES and prefers ones not yet taken.
 */
export function stateClass(s: SpecState): string {
  const loc = locate(s.roots, s.activeId)!;
  const order = flatIds(s.roots);
  const i = order.indexOf(s.activeId);
  const text = loc.node.text;
  const bits = [
    s.editing ? "edit" : "sel",
    loc.parent ? "child" : "root",
    loc.index > 0 ? "hasPrev" : "first",
    loc.index < loc.siblings.length - 1 ? "hasNext" : "last",
    loc.node.children.length > 0 ? "parent" : "leaf",
    i === 0 ? "docStart" : i === order.length - 1 ? "docEnd" : "docMid",
    isBlank(text) ? "blank" : "text",
    s.roots.length > 1 ? "multiRoot" : "oneRoot",
  ];
  if (s.editing) {
    bits.push(
      s.caret !== s.selEnd
        ? "range"
        : s.caret === 0
          ? "caret0"
          : s.caret === text.length
            ? "caretEnd"
            : "caretMid"
    );
  }
  return bits.join("/");
}

export function eventClass(ev: SpecEvent): string {
  return ev.kind === "click" ? "click" : ev.key;
}
