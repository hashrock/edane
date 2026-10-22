import type { Env } from "../global.d";

/**
 * Workers AI は呼んだ分だけ課金される（neurons）。サイトの AI 提案（POST /api/sites/:pubId/suggest）は
 * 所有者がボタンで呼ぶもので、1 回が数秒かかるので人の操作なら 1 分に数回。1 リクエストは最大 2 回
 * （途中で切れた応答の再試行）AI を呼ぶので、ユーザーごと 10 回/分（wrangler.jsonc の
 * AI_SUGGEST_LIMITER）で AI 呼び出しは 20 回/分に収まる。止めたいのはクライアントの再試行ループや
 * スクリプトからの連打。
 */
export async function aiSuggestAllowed(env: Env["Bindings"], userId: string): Promise<boolean> {
  return (await env.AI_SUGGEST_LIMITER.limit({ key: userId })).success;
}
