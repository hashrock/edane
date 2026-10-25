import type { PageMark } from "../application/slides";

/** A branch's pages over the map (see branchPageMarks): node id → its page. Null = not shown. */
export type PageMarks = ReadonlyMap<string, PageMark> | null;

// Neighbouring pages always differ; the cycle only repeats seven pages on.
const COLORS = ["#10b981", "#3b82f6", "#f59e0b", "#ec4899", "#8b5cf6", "#06b6d4", "#ef4444"];

/** The colour a page of the branch is marked in, by its order within the branch. */
export function pageMarkColor(mark: PageMark): string {
  return COLORS[mark.order % COLORS.length];
}
