/**
 * ルートの判断とレスポンスの形（純粋関数）。Hono に触るのは index.ts だけ。
 */
import type { IdSource } from "../domain/model";
import type { SessionUser } from "../user";
import type { AuthProvider } from "../auth/provider";
import { findScenario, type ScenarioDefinition } from "./catalog";
import { scenarioTitle, type ScenarioPlan } from "./plan";

/** `?format=json` か `Accept: application/json` なら JSON。ブラウザの既定 Accept には含まれない。 */
export function wantsJson(format: string | undefined, accept: string | undefined): boolean {
  return format === "json" || /\bapplication\/json\b/i.test(accept ?? "");
}

/**
 * 誰のデータとしてシナリオを作るか。
 * - `throwaway`: 認証バイパス時。シナリオ専用の使い捨てユーザーを作って `auth.signIn` する
 *   （既存データと完全に隔離され、`empty` は本当にノート 0 件の一覧になる）。
 * - `current`: 本番（session 認証）。ログイン中ユーザーの新規データとして作る。
 *   本番で任意ユーザーとしてログインさせる経路は存在しない。
 */
export type ScenarioActor = { kind: "throwaway"; user: SessionUser } | { kind: "current"; user: SessionUser };

export type ScenarioAccess =
  | { kind: "unknown" }
  /** 認証は迂回しない：本番で未ログインなら通常のログイン導線へ（docs 参照）。 */
  | { kind: "login-required"; scenario: ScenarioDefinition }
  | { kind: "run"; scenario: ScenarioDefinition; actor: ScenarioActor };

export interface AccessContext {
  user: SessionUser | null;
  authKind: AuthProvider["kind"];
  tag: string;
  nextId: IdSource;
}

export function throwawayUser(name: string, tag: string, id: string): SessionUser {
  return { id, email: `${id}@scenario.invalid`, name: scenarioTitle(name, tag), avatarUrl: "" };
}

export function resolveScenarioAccess(name: string, ctx: AccessContext): ScenarioAccess {
  const scenario = findScenario(name);
  if (!scenario) return { kind: "unknown" };
  if (ctx.authKind === "bypass") {
    return { kind: "run", scenario, actor: { kind: "throwaway", user: throwawayUser(name, ctx.tag, ctx.nextId()) } };
  }
  if (!ctx.user) return { kind: "login-required", scenario };
  return { kind: "run", scenario, actor: { kind: "current", user: ctx.user } };
}

export const LOGIN_PATH = "/auth/google";
export const SCENARIOS_PATH = "/__scenarios";

/** JSON 応答。Chrome MCP が作った状態を辿れるように、ID と絶対 URL を全部出す。 */
export interface ScenarioResult {
  scenario: string;
  description: string;
  tag: string;
  /** データの持ち主。`signedInAs` が `throwaway` ならこのユーザーでログイン済みになっている。 */
  user: { id: string; email: string; name: string };
  signedInAs: ScenarioActor["kind"];
  /** ブラウザで開くとリダイレクトされる先（絶対 URL）。 */
  redirect: string;
  notes: {
    key: string;
    id: string;
    title: string;
    isPublic: boolean;
    pinned: boolean;
    trashed: boolean;
    editUrl: string;
    viewUrl: string;
  }[];
  publications: {
    id: string;
    noteId: string;
    nodeId: string;
    jsonUrl: string;
    markdownUrl: string;
    siteEditUrl: string;
  }[];
  sites: { publicationId: string; url: string; editUrl: string }[];
}

export function describePlan(
  scenario: ScenarioDefinition,
  plan: ScenarioPlan,
  tag: string,
  actor: ScenarioActor,
  origin: string
): ScenarioResult {
  const abs = (path: string) => `${origin.replace(/\/+$/, "")}${path}`;
  return {
    scenario: scenario.name,
    description: scenario.description,
    tag,
    user: { id: actor.user.id, email: actor.user.email, name: actor.user.name },
    signedInAs: actor.kind,
    redirect: abs(plan.redirect),
    notes: plan.notes.map((n) => ({
      key: n.key,
      id: n.id,
      title: n.title,
      isPublic: n.isPublic,
      pinned: n.pinned,
      trashed: n.trashed,
      editUrl: abs(`/notes/${n.id}/edit`),
      viewUrl: abs(`/notes/${n.id}`),
    })),
    publications: plan.publications.map((p) => ({
      id: p.id,
      noteId: p.noteId,
      nodeId: p.nodeId,
      jsonUrl: abs(`/pub/${p.id}.json`),
      markdownUrl: abs(`/pub/${p.id}.md`),
      siteEditUrl: abs(`/sites/${p.id}/edit`),
    })),
    sites: plan.sites.map((s) => ({
      publicationId: s.publicationId,
      url: abs(`/sites/${s.publicationId}`),
      editUrl: abs(`/sites/${s.publicationId}/edit`),
    })),
  };
}
