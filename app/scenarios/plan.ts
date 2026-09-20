/**
 * UI テスト用シナリオの「計画」（ScenarioPlan）。
 *
 * シナリオは **純粋な計画** として組み立て（このファイルと fixtures.ts）、
 * DB への書き込みは seed.ts が別に担う。計画は ID まで確定した値なので、
 * テストは DB なしで「どんなノートが何件、どの状態で作られるか」を検証できる。
 *
 * 毎回新しい隔離データを作るのが原則（docs/ui-test-scenarios.md）：
 * - ID はすべて新規（`nextId`）。既存行を更新・削除する計画は存在しない。
 * - タイトルは `scenario-<name>-<tag>` で始まり、一覧で見分けられる。
 */
import type { IdSource, MindMapDocument } from "../domain/model";

export interface PlannedNote {
  /** 計画内での役割（JSON 応答のキー。例: "main" / "pinned"） */
  key: string;
  id: string;
  title: string;
  model: MindMapDocument;
  isPublic: boolean;
  pinned: boolean;
  trashed: boolean;
}

export interface PlannedPublication {
  id: string;
  noteId: string;
  nodeId: string;
}

export interface PlannedSite {
  publicationId: string;
  template: string;
  schema: string;
  html: string;
  css: string;
}

export interface ScenarioPlan {
  notes: PlannedNote[];
  publications: PlannedPublication[];
  sites: PlannedSite[];
  /** 状態を作ったあとブラウザを送る先（オリジンなしのパス）。 */
  redirect: string;
}

export interface ScenarioContext {
  /** 同じシナリオの実行同士を見分ける短いランダム文字列。 */
  tag: string;
  nextId: IdSource;
}

/** `scenario-<name>-<tag>`（+ 任意の補足）。全シナリオの全ノートがこの形。 */
export function scenarioTitle(name: string, tag: string, suffix?: string): string {
  const base = `scenario-${name}-${tag}`;
  return suffix ? `${base} ${suffix}` : base;
}

/** 6 文字の 16 進。`crypto.getRandomValues` 由来（推測されない必要はないが衝突しにくい程度）。 */
export function shortTag(bytes: Uint8Array = crypto.getRandomValues(new Uint8Array(3))): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
