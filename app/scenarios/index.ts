/**
 * UI テスト用シナリオ route（`/__scenarios`）。使い方は docs/ui-test-scenarios.md。
 *
 *   GET /__scenarios            一覧ページ（ログイン状態も表示）
 *   GET /__scenarios/:name      初期状態を新規に作って画面へ 303
 *   GET /__scenarios/:name?format=json（または Accept: application/json）
 *                               リダイレクトせず、作った ID・URL を JSON で返す
 *
 * server.ts に `app.route("/__scenarios", scenarioRoutes())` で薄く mount する。
 * 認証は親の middleware が選んだ AuthProvider（`c.get("auth")`）に任せる：
 * バイパス時はシナリオ専用の使い捨てユーザーを作って `auth.signIn`、本番では
 * ログイン中ユーザーのデータとして作る（response.ts の `resolveScenarioAccess`）。
 * Cookie やミドルウェアをここで直接触ることはない。
 */
import { Hono } from "hono";
import { html } from "hono/html";
import { drizzle } from "drizzle-orm/d1";
import type { Env } from "../global.d";
import { generateId } from "../domain/model";
import { listScenarios } from "./catalog";
import { shortTag } from "./plan";
import { applyScenarioPlan } from "./seed";
import { insertUser } from "../utils/userRepository";
import { LOGIN_PATH, SCENARIOS_PATH, describePlan, resolveScenarioAccess, wantsJson } from "./response";

export function scenarioRoutes() {
  const r = new Hono<Env>();

  r.get("/", (c) => {
    const user = c.get("user");
    const reason = c.req.query("reason");
    const bypass = c.get("auth").kind === "bypass";
    const rows = listScenarios().map(
      (s) => html`<tr>
        <td><code>${s.name}</code></td>
        <td>${s.description}</td>
        <td><code>${s.target}</code></td>
        <td>
          <a href="${SCENARIOS_PATH}/${s.name}">開く</a> ·
          <a href="${SCENARIOS_PATH}/${s.name}?format=json">JSON</a>
        </td>
      </tr>`
    );
    const status = bypass
      ? html`<p class="ok">認証バイパス中${user ? html`（いまは ${user.name || user.email}）` : "（ゲストモード）"}。シナリオごとに使い捨てユーザーを作り、そのユーザーでログインした状態になります。</p>`
      : user
        ? html`<p class="ok">ログイン中: ${user.name || user.email}（<code>${user.id}</code>）。シナリオはこのユーザーの新規データとして作られます。</p>`
        : html`<p class="warn">未ログイン。シナリオはログイン済みユーザーのデータとして作るので、先に<a href="${LOGIN_PATH}">Google でログイン</a>してください。</p>`;
    return c.html(html`<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>UI test scenarios — edane</title>
<style>
body{font-family:system-ui,sans-serif;margin:2rem auto;max-width:64rem;padding:0 1rem;color:#0f172a;line-height:1.5}
table{border-collapse:collapse;width:100%}th,td{border-bottom:1px solid #e2e8f0;padding:.5rem;text-align:left;vertical-align:top;font-size:.9rem}
code{background:#f1f5f9;padding:.1rem .3rem;border-radius:.25rem}.ok{color:#047857}.warn{color:#b45309}.err{color:#b91c1c}
</style></head><body>
<h1>UI テスト用シナリオ</h1>
<p>URL を開くだけで所定の初期状態が<strong>毎回新規に</strong>作られ、その画面へリダイレクトされます。既存データは変更しません。<code>?format=json</code> を付けると作った ID と URL を JSON で返します。</p>
${reason === "login-required" ? html`<p class="err">ログインが必要なシナリオです。</p>` : ""}
${status}
<table><thead><tr><th>名前</th><th>説明</th><th>行き先</th><th></th></tr></thead><tbody>${rows}</tbody></table>
<p><a href="https://github.com/hashrock/edane/blob/main/docs/ui-test-scenarios.md">docs/ui-test-scenarios.md</a></p>
</body></html>`);
  });

  r.get("/:name", async (c) => {
    const json = wantsJson(c.req.query("format"), c.req.header("Accept"));
    const name = c.req.param("name");
    const auth = c.get("auth");
    const tag = shortTag();
    const access = resolveScenarioAccess(name, { user: c.get("user"), authKind: auth.kind, tag, nextId: generateId });
    c.header("Cache-Control", "no-store");

    switch (access.kind) {
      case "unknown":
        return json
          ? c.json({ error: "unknown-scenario", scenarios: listScenarios().map((s) => s.name) }, 404)
          : c.html(
              html`<!doctype html><meta charset="utf-8"><p>Unknown scenario: <code>${name}</code>. <a href="${SCENARIOS_PATH}">一覧</a></p>`,
              404
            );
      case "login-required":
        return json
          ? c.json({ error: "login-required", loginUrl: LOGIN_PATH, scenariosUrl: SCENARIOS_PATH }, 401)
          : c.redirect(`${SCENARIOS_PATH}?reason=login-required&scenario=${encodeURIComponent(name)}`, 303);
      case "run": {
        const db = drizzle(c.env.DB);
        const { actor } = access;
        if (actor.kind === "throwaway") {
          await insertUser(db, actor.user);
          await auth.signIn(c, actor.user);
        }
        const plan = access.scenario.build({ tag, nextId: generateId });
        await applyScenarioPlan(db, plan, actor.user.id, c.env.ENCRYPTION_KEY);
        if (!json) return c.redirect(plan.redirect, 303);
        const origin = new URL(c.req.url).origin;
        return c.json(describePlan(access.scenario, plan, tag, actor, origin));
      }
    }
  });

  return r;
}
