/**
 * シナリオの一覧（名前・説明・計画の組み立て方）。
 *
 * `satisfies Record<ScenarioName, …>` で名前の集合と定義を一致させる：
 * 名前を足したら定義（と docs/ui-test-scenarios.md）を書くまでコンパイルが通らない。
 */
import { isKeyOf } from "../domain/isKeyOf";
import { buildEmpty, buildLarge, buildPublic, buildSite, buildTrash, buildTypical } from "./fixtures";
import type { ScenarioContext, ScenarioPlan } from "./plan";

export const SCENARIO_NAMES = ["empty", "typical", "large", "trash", "public", "site"] as const;
export type ScenarioName = (typeof SCENARIO_NAMES)[number];

export interface ScenarioDefinition {
  name: ScenarioName;
  /** 一覧ページと JSON に出す 1 行説明。 */
  description: string;
  /** リダイレクト先の画面（一覧ページの案内用）。 */
  target: string;
  build(ctx: ScenarioContext): ScenarioPlan;
}

export const SCENARIOS = {
  empty: {
    name: "empty",
    description: "まっさら。空のトップレベルノード 1 つだけの新規ノートをエディタで開く。",
    target: "/notes/:id/edit",
    build: buildEmpty,
  },
  typical: {
    name: "typical",
    description:
      "ふつうの利用状態。text / link / image / markdown・チェックボックス・折りたたみ・複数の木を持つノート + ピン留め・公開の各 1 件。",
    target: "/notes/:id/edit",
    build: buildTypical,
  },
  large: {
    name: "large",
    description: "レイアウトが崩れやすい状態。子 40 個の広い木、深さ 15 の木、長文・長い Markdown、位置固定の木、一覧を埋める 20 件。",
    target: "/notes/:id/edit",
    build: buildLarge,
  },
  trash: {
    name: "trash",
    description: "ゴミ箱に非公開 1 件・公開 1 件。復元と完全削除の UI。",
    target: "/trash",
    build: buildTrash,
  },
  public: {
    name: "public",
    description: "公開ノート + 枝のノード公開（/pub/:id.json・.md が生きている）。サイトは未作成。閲覧ページを開く。",
    target: "/notes/:id",
    build: buildPublic,
  },
  site: {
    name: "site",
    description: "公開済みサイト。公開ノート + ノード公開 + ビルド済みサイト（/sites/:pubId で配信）。サイトエディタを開く。",
    target: "/sites/:pubId/edit",
    build: buildSite,
  },
} as const satisfies Record<ScenarioName, ScenarioDefinition>;

export function findScenario(name: string): ScenarioDefinition | undefined {
  return isKeyOf(SCENARIOS, name) ? SCENARIOS[name] : undefined;
}

export function listScenarios(): ScenarioDefinition[] {
  return SCENARIO_NAMES.map((n) => SCENARIOS[n]);
}
