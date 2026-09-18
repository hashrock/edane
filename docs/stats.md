# サインアップ数 endpoint（`GET /api/stats`）

repos.hashrock.info の管理画面が各サービスのサインアップ数を集めるための endpoint。`Authorization: Bearer <STATS_TOKEN>` 必須で、`STATS_TOKEN`（Worker の secret）が未設定なら 404、トークン不一致なら 401。
レスポンスは `{ "service": "edane", "generated_at": "<ISO 8601>", "users": { "total", "new_7d", "new_30d" } }`（`Cache-Control: no-store`）。UI テスト用の使い捨てユーザー（id が `scenario-`、メールが `@scenario.invalid`）は数えない。
ローカルでは `.dev.vars` に `STATS_TOKEN=dev-stats-token` を足して `curl -H "Authorization: Bearer dev-stats-token" localhost:5173/api/stats`。実装は `app/stats/` と `countUsers`（`app/utils/userRepository.ts`）。
