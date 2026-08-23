/**
 * Application layer: node-level web publication (`/pub/:id.json` / `/pub/:id.md`).
 *
 * ノート内の1ノード（枝）に取り消し可能なランダムIDを発行し、その枝を
 * JSON / Markdown で配信する機能の決めごとを、サーバ（server.ts）と
 * UI（PublishNodeDialog / Settings）の両方から使える純関数として置く。
 *
 * 決めごと:
 *  - 配信は常に「今の枝」— スナップショットは持たない。ノードが消えたら404。
 *  - 公開できるのは isPublic なノートのノードだけ（非公開ノートの暗号化
 *    モデルには一切触れない）。ノートが後から非公開/ゴミ箱行きになったら
 *    URLは（rowを残したまま）404になり、公開に戻せばまた生きる。
 *  - 解除はrow削除。再公開は新しいIDを発行する＝URLのローテーション。
 *
 * Depends on domain/model only.
 */

import type { MindMapModel } from "../domain/model";

/** 非公開ノートでノード公開を断るときの理由（UIとAPIエラーで共用）。 */
export const PRIVATE_NOTE_PUBLISH_REASON =
  "非公開ノートのノードは公開できません。ノートを公開に切り替えてください。";

/** Publication URL pair for one publication id. */
export interface PublicationUrls {
  json: string;
  md: string;
}

/**
 * 公開URLの組（絶対URL）。origin は `window.location.origin` 相当で、
 * 末尾スラッシュ付きでも二重スラッシュにしない（publicNoteUrl と同じ流儀）。
 */
export function publicationUrls(origin: string, pubId: string): PublicationUrls {
  const base = `${origin.replace(/\/+$/, "")}/pub/${encodeURIComponent(pubId)}`;
  return { json: `${base}.json`, md: `${base}.md` };
}

export type PublicationFormat = "json" | "md";

/**
 * `/pub/:file` のパスパラメータ（`<id>.json` / `<id>.md`）を分解する。
 * 拡張子がどちらでもない・IDが空のときは null（→404）。
 */
export function parsePublicationPath(
  file: string
): { pubId: string; format: PublicationFormat } | null {
  const m = /^(.+)\.(json|md)$/.exec(file);
  if (!m) return null;
  return { pubId: m[1], format: m[2] as PublicationFormat };
}

/**
 * 配信してよいノートか。row が残っていても、ノートが消えた・ゴミ箱にある・
 * 非公開に戻された、のどれかなら配信しない（404）。「非公開＝暗号化」の
 * モデルを配信経路が破らないための唯一のゲート。
 */
export function canServePublication(
  note: { isPublic: boolean; deletedAt: string | null } | null | undefined
): boolean {
  return !!note && note.isPublic && !note.deletedAt;
}

/**
 * 公開JSONとして配信する形。ビュー状態（collapsed）だけを落とし、内容
 * （text / type / 書式 / リンクメタ / 子）はそのまま。`id` は消費側が
 * ノードを安定して同定できるよう残す。
 */
export function publishedNodeJson(node: MindMapModel): MindMapModel {
  const { collapsed: _collapsed, ...rest } = node;
  return { ...rest, children: node.children.map(publishedNodeJson) };
}

/**
 * ルートから対象ノードまでのテキストの列（両端を含む）。設定ページの
 * 「どの枝を公開しているか」表示用。ノードが見つからなければ null。
 */
export function nodePathTexts(
  model: MindMapModel,
  nodeId: string
): string[] | null {
  if (model.id === nodeId) return [model.text];
  for (const child of model.children) {
    const sub = nodePathTexts(child, nodeId);
    if (sub) return [model.text, ...sub];
  }
  return null;
}
