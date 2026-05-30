/** Flat node for rendering (computed from domain model via layout) */
export interface MindMapNode {
  id: string;
  text: string;
  x: number;
  y: number;
  children: string[];
  /** Measured box width (px); filled in by layout. */
  width: number;
  /** Measured box height (px), incl. multi-line text; filled in by layout. */
  height: number;
  /** Whether this node is collapsed (its descendants are hidden). */
  collapsed: boolean;
  /** Number of direct children in the model (even when collapsed). */
  childCount: number;
}
