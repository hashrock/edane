import type { MindMapDocument, MindMapModel } from "../domain/model";
import { normalizeDocument, normalizeTree } from "../application/persistence";
import { normalizePageTheme, type PageTheme } from "../domain/pageTheme";

export type Fields = Omit<MindMapModel, "children" | "id">;
type FlatNode = { fields: Fields; children: string[] };
export type Change<T> = { before: T; after: T };
export interface Patch {
  title?: Change<string>;
  nodes: Record<string, Change<FlatNode | null>>;
  roots?: Change<string[]>;
  /** The page theme as a whole (null = none). Two sessions editing it at once conflict. */
  theme?: Change<PageTheme | null>;
}
export interface Snapshot { model: MindMapDocument; version: number; isPublic: boolean }
export interface Commit { id: string; patch: Patch; publicity?: Change<boolean> }
export class Conflict extends Error {}
/** parseCommit's refusal. `tooLarge` separates "send less" from "send something well-formed". */
export class InvalidCommit extends Error {
  constructor(message: string, readonly tooLarge = false) { super(message); }
}

/** A snapshot as NoteRoom reads it: `updatedAt` comes from the same row as the content and version. */
export interface RoomSnapshot extends Snapshot { updatedAt: string }
/** A persisted commit: the resulting snapshot plus the receipt for the operation id. */
export interface CommitReceipt extends RoomSnapshot { ack: string; committedVersion: number }
/** NoteRoom.applyEdit's answer: the snapshot as committed (other clients' merged edits included). */
export interface EditReceipt extends CommitReceipt { nodeIds?: string[] }
/**
 * Why NoteRoom refused a request — the expected outcomes. They're returned, not thrown,
 * because exception types don't survive Durable Object RPC; each caller (WebSocket,
 * legacy PUT, remote MCP) words them for its own audience. Anything else (D1 failing,
 * a bug) is thrown and stays an internal error.
 */
export type RoomRejection =
  /** Missing, someone else's, or in the trash — deliberately indistinguishable. */
  | { code: "not-found" }
  | { code: "decrypt-failed" }
  /** The note changed in a way this commit can't merge with. Read the latest and retry. */
  | { code: "conflict"; detail: string }
  /** The legacy full-document PUT named a version that isn't the current one. */
  | { code: "version-conflict" }
  | { code: "invalid-commit"; detail: string }
  /** An agent's edit names a node that isn't there, or asks for nothing. */
  | { code: "invalid-edit"; detail: string }
  | { code: "too-large" }
  /** The operation id already has a receipt for a different commit. */
  | { code: "operation-reused" };
export type RoomResult<T> = { ok: true; value: T } | ({ ok: false } & RoomRejection);
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, v]) => [key, canonical(v)]));
  return value;
}
const same = (a: unknown, b: unknown) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
/**
 * Fields as storage keeps them. Persistence drops `collapsed: false` and `bold: false`,
 * and NoteRoom reloads every commit's base from storage, so the reducer's
 * explicit default and the reloaded absence must count as the same value when checking
 * a patch's `before` — or collapsing a branch this session expanded conflicts with itself.
 */
function stored(fields: Fields): Record<string, unknown> {
  const { id: _, children: __, ...kept } = normalizeTree({ ...fields, id: "_", children: [] }, new Set())!;
  return kept;
}
function fail(where: string): never { throw new Conflict(`Concurrent change: ${where}. Read the latest note and retry.`); }
function flatten(doc: MindMapDocument) {
  const nodes = new Map<string, FlatNode>();
  const visit = ({ id, children, ...fields }: MindMapModel) => {
    nodes.set(id, { fields, children: children.map(n => n.id) });
    children.forEach(visit);
  };
  doc.roots.forEach(visit);
  return nodes;
}
export function diffDocument(before: MindMapDocument, after: MindMapDocument): Patch {
  const a = flatten(before), b = flatten(after);
  // Object.fromEntries, not assignment: an id like "__proto__" stays an own key,
  // and the result is a plain object that RPC structured clone accepts.
  const changes = [...new Set([...a.keys(), ...b.keys()])]
    .map(id => [id, { before: a.get(id) ?? null, after: b.get(id) ?? null }] as const)
    .filter(([, change]) => !same(change.before, change.after));
  const patch: Patch = { nodes: Object.fromEntries(changes) };
  if (before.title !== after.title) patch.title = { before: before.title, after: after.title };
  const roots = { before: before.roots.map(n => n.id), after: after.roots.map(n => n.id) };
  if (!same(roots.before, roots.after)) patch.roots = roots;
  const theme = { before: before.theme ?? null, after: after.theme ?? null };
  if (!same(theme.before, theme.after)) patch.theme = theme;
  return patch;
}
export const hasChanges = (p: Patch) => !!(p.title || p.roots || p.theme || Object.keys(p.nodes).length);
/**
 * The commit that turns `before` into `after` (and flips publicity), or null when
 * nothing would change — a no-op must not advance the version. The one place
 * a commit is put together: the editor's socket, the legacy PUT and NoteRoom.applyEdit.
 */
export function buildCommit(id: string, before: MindMapDocument, after: MindMapDocument, publicity?: Change<boolean>): Commit | null {
  const patch = diffDocument(before, after);
  const flip = publicity && publicity.before !== publicity.after ? publicity : undefined;
  if (!hasChanges(patch) && !flip) return null;
  return { id, patch, ...(flip && { publicity: flip }) };
}

// Preserve concurrent insertions. Concurrent reorder of the same sibling set
// is rejected; there is no hidden whole-document last-writer-wins fallback.
function mergeOrder(current: string[], before: string[], after: string[]): string[] {
  if (same(current, before)) return [...after];
  const common = new Set(before.filter(id => after.includes(id)));
  const oldOrder = before.filter(id => common.has(id));
  const newOrder = after.filter(id => common.has(id));
  const liveOrder = current.filter(id => common.has(id));
  if (!same(oldOrder, newOrder) && !same(liveOrder, oldOrder)) fail("sibling order");
  for (const id of common) if (!current.includes(id)) fail(`removed node ${id}`);
  let result = current.filter(id => !before.includes(id) || after.includes(id));
  if (!same(oldOrder, newOrder)) {
    let i = 0;
    result = result.map(id => common.has(id) ? newOrder[i++] : id);
  }
  for (let i = 0; i < after.length; i++) {
    const id = after[i];
    if (before.includes(id)) continue;
    if (result.includes(id)) fail(`duplicate placement ${id}`);
    const anchor = after.slice(i + 1).find(next => result.includes(next));
    result.splice(anchor === undefined ? result.length : result.indexOf(anchor), 0, id);
  }
  return result;
}

export function applyPatch(doc: MindMapDocument, patch: Patch): MindMapDocument {
  const nodes = flatten(doc);
  let title = doc.title;
  if (patch.title) {
    if (title !== patch.title.before) fail("title");
    title = patch.title.after;
  }
  let theme = doc.theme ?? null;
  if (patch.theme) {
    if (!same(theme, patch.theme.before)) fail("theme");
    theme = patch.theme.after;
  }
  for (const [id, { before, after }] of Object.entries(patch.nodes)) {
    const current = nodes.get(id);
    if (!before) {
      if (current || !after) fail(`duplicate node ${id}`);
      nodes.set(id, structuredClone(after));
    } else if (!after) {
      if (!current || !same(current.children, before.children) || !same(stored(current.fields), stored(before.fields))) fail(`deleted node ${id}`);
      nodes.delete(id);
    } else {
      if (!current) fail(`missing node ${id}`);
      const fields = { ...current.fields } as Record<string, unknown>;
      const currentStored = stored(current.fields), beforeStored = stored(before.fields);
      const oldFields = before.fields as Record<string, unknown>;
      const newFields = after.fields as Record<string, unknown>;
      for (const key of new Set([...Object.keys(oldFields), ...Object.keys(newFields)])) {
        if (same(oldFields[key], newFields[key])) continue;
        if (!same(currentStored[key], beforeStored[key])) fail(`${id}.${key}`);
        if (newFields[key] === undefined) delete fields[key];
        else fields[key] = newFields[key];
      }
      nodes.set(id, { fields: fields as Fields, children: mergeOrder(current.children, before.children, after.children) });
    }
  }
  const roots = patch.roots ? mergeOrder(doc.roots.map(n => n.id), patch.roots.before, patch.roots.after) : doc.roots.map(n => n.id);
  const seen = new Set<string>();
  const build = (id: string, depth: number): MindMapModel => {
    if (depth > 200 || seen.has(id)) fail("cycle or duplicate parent");
    seen.add(id);
    const node = nodes.get(id);
    if (!node) fail(`missing child ${id}`);
    return { ...node.fields, id, children: node.children.map(child => build(child, depth + 1)) };
  };
  const result: MindMapDocument = { title, roots: roots.map(id => build(id, 0)), ...(theme && { theme }) };
  if (!roots.length || seen.size !== nodes.size || nodes.size > 20000) fail("orphan or empty document");
  return result;
}

/** Strict wire boundary: validate sizes, shapes and known field types before apply. */
export function parseCommit(value: unknown): Commit {
  const raw = JSON.stringify(value);
  if (!raw || raw.length > 1_000_000) throw new InvalidCommit("Commit exceeds 1 MB", true);
  const v = value as Commit;
  if (!v || typeof v.id !== "string" || !/^[\w-]{1,100}$/.test(v.id) || !v.patch || typeof v.patch.nodes !== "object" || !v.patch.nodes || Array.isArray(v.patch.nodes)) throw new InvalidCommit("Invalid commit");
  const strings = (x: unknown): x is string[] => Array.isArray(x) && x.every(id => typeof id === "string" && id.length > 0 && id.length <= 200) && new Set(x).size === x.length;
  const change = (x: unknown, test: (v: unknown) => boolean) => !!x && typeof x === "object" && test((x as Change<unknown>).before) && test((x as Change<unknown>).after);
  if (v.patch.title && !change(v.patch.title, x => typeof x === "string")) throw new InvalidCommit("Invalid title");
  if (v.publicity && !change(v.publicity, x => typeof x === "boolean")) throw new InvalidCommit("Invalid publicity");
  if (v.patch.roots && !change(v.patch.roots, strings)) throw new InvalidCommit("Invalid roots");
  if (v.patch.theme && !change(v.patch.theme, x => x === null || same(normalizePageTheme(x), x))) throw new InvalidCommit("Invalid theme");
  for (const [id, c] of Object.entries(v.patch.nodes)) {
    if (!id || id.length > 200 || !c || typeof c !== "object") throw new InvalidCommit("Invalid node change");
    for (const n of [c.before, c.after]) {
      if (n === null) continue;
      if (!n || !strings(n.children) || !n.fields || typeof n.fields !== "object") throw new InvalidCommit("Invalid node");
      const normalized = normalizeDocument({ roots: [{ ...n.fields, id, children: [] }] }, "");
      const fields = normalized?.roots[0];
      if (!fields) throw new InvalidCommit("Invalid fields");
      const allowed = new Set(["text", "collapsed", "type", "fontSize", "bold", "linkTitle", "favicon", "checked", "position"]);
      for (const [key, val] of Object.entries(n.fields)) {
        if (!allowed.has(key)) throw new InvalidCommit(`Unknown field: ${key}`);
        // false booleans are valid reducer output.
        if ((key === "collapsed" || key === "bold") && val === false) continue;
        if (!same(val, (fields as unknown as Record<string, unknown>)[key])) throw new InvalidCommit(`Invalid field: ${key}`);
      }
    }
  }
  return v;
}
