import type { NodeType } from "../domain/model";

/** Flat node for rendering (computed from domain model via layout) */
export interface MindMapNode {
  id: string;
  text: string;
  x: number;
  y: number;
  children: string[];
  /** Node kind (text/image/link). */
  type: NodeType;
  /** Measured box width (px); filled in by layout. */
  width: number;
  /** Measured box height (px), incl. multi-line text; filled in by layout. */
  height: number;
  /** Whether this node is collapsed (its descendants are hidden). */
  collapsed: boolean;
  /** Number of direct children in the model (even when collapsed). */
  childCount: number;
  /** Font size in px (text/link nodes); falls back to the default when absent. */
  fontSize?: number;
  /** Bold text. */
  bold?: boolean;
  /** Link nodes: fetched page title (display text). */
  linkTitle?: string;
  /** Link nodes: favicon URL. */
  favicon?: string;
}
