/**
 * Application layer: 公開サイト機能が読む木の形（`SiteNode`）と、
 * `MindMapModel` からの変換。
 *
 * スキーマ（siteSchema.ts）とテンプレート（siteTemplate.ts）の両方がこの
 * 形に依存するので、どちらのモジュールにも属させず独立させてある
 * （どちらかに置くと、もう一方がそれを import する循環になる）。
 */
import type { MindMapModel, NodeType } from "../domain/model";

/**
 * テンプレートに渡すデータ。エディタ内部の MindMapModel をそのまま晒さず、
 * 「枝の形＋順序＋type」だけの薄い形にする（モデルを変えてもテンプレートが壊れない）。
 */
export interface SiteNode {
  id: string;
  /** ノード種別。`text` 以外は `text` の中身が URL / Markdown 本文になる。 */
  type: NodeType;
  text: string;
  children: SiteNode[];
}

export function toSiteNode(node: MindMapModel): SiteNode {
  return {
    id: node.id,
    type: node.type ?? "text",
    text: node.text,
    children: node.children.map(toSiteNode),
  };
}
