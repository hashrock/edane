import { Head } from "@inertiajs/react";
import { t } from "../../application/i18n";
import { useLocale } from "../../components/useLocale";
import type { SessionUser } from "../../user";

/**
 * OAuth の同意画面（GET /oauth/authorize、app/oauth/index.ts）。`fields` は検証済みの認可要求で、
 * 隠しフィールドとしてそのまま POST に戻し、サーバーが同じ規則で検証し直す。
 * Inertia の router ではなく素のフォーム送信にする（応答はクライアントの戻り先への 302 なので）。
 */
export default function Authorize({
  user,
  clientName,
  redirectTo,
  fields,
}: {
  user: SessionUser;
  clientName: string;
  redirectTo: string;
  fields: Record<string, string>;
}) {
  useLocale(); // 言語切り替えで再レンダー（t() の購読）
  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50 px-4 text-slate-950">
      <Head title={t("oauthConsentTitle")} />
      <form method="post" action="/oauth/authorize" className="w-full max-w-md rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        {Object.entries(fields).map(([name, value]) => (
          <input key={name} type="hidden" name={name} value={value} />
        ))}
        <h1 className="mb-3 text-lg font-semibold">{t("oauthConsentHeading", { client: clientName })}</h1>
        <p className="mb-3 text-sm leading-relaxed text-slate-600">{t("oauthConsentBody", { email: user.email })}</p>
        <p className="mb-1 text-xs text-slate-500">{t("oauthConsentRedirect", { redirect: redirectTo })}</p>
        <p className="mb-5 text-xs text-amber-700">{t("oauthConsentWarning")}</p>
        <div className="flex justify-end gap-2">
          <button
            type="submit"
            name="decision"
            value="deny"
            className="rounded-lg border border-slate-300 bg-white px-4 py-1.5 text-sm font-medium hover:bg-slate-50"
          >
            {t("oauthDeny")}
          </button>
          <button
            type="submit"
            name="decision"
            value="approve"
            className="rounded-lg bg-slate-900 px-4 py-1.5 text-sm font-medium text-white hover:bg-slate-700"
          >
            {t("oauthApprove")}
          </button>
        </div>
      </form>
    </div>
  );
}
