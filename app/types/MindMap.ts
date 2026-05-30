/** Flat node for rendering (computed from domain model via layout) */
export interface MindMapNode {
  id: string;
  text: string;
  x: number;
  y: number;
  children: string[];
}
