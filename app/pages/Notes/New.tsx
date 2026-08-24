import { Head, Link, useForm } from "@inertiajs/react";
import type { SessionUser } from "../../user";
import { t } from "../../application/i18n";
import { useLocale } from "../../components/useLocale";

type User = SessionUser | null;

export default function NotesNew({ user }: { user: User }) {
  useLocale(); // 言語切り替えで再レンダー（t() の購読）
  const { data, setData, post, processing, transform } = useForm({
    title: "",
    isPublic: false,
  });

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!data.title.trim()) return;
    // 初期コンテンツ（スターターのトピック）はUI言語に合わせてクライアントが
    // 添える。送らなければサーバ側の日本語フォールバックになる。
    transform((d) => ({ ...d, content: t("starterTopics") }));
    post("/notes");
  };

  return (
    <div className="max-w-3xl mx-auto px-6 py-7 md:py-9">
      <Head title={t("newNoteHeadTitle")} />
      <header className="anim-header mb-10 flex items-center justify-between gap-3">
        <h1 className="text-xl font-bold tracking-tight">
          <img src="/logo.svg" alt="Edane" className="h-7 w-auto" />
        </h1>
        {user && (
          <Link
            href="/notes"
            className="text-sm font-medium text-emerald-700 hover:text-emerald-800"
          >
            {t("settingsBackToList")}
          </Link>
        )}
      </header>

      <section className="anim-item">
        <form
          onSubmit={submit}
          className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm md:p-8"
        >
          <h2 className="text-xl font-bold tracking-tight">{t("newNoteHeading")}</h2>
          <p className="mt-1 text-sm text-slate-500">
            {t("newNoteDesc")}
          </p>

          <div className="mt-6">
            <label
              htmlFor="title"
              className="block text-sm font-medium text-slate-700"
            >
              {t("titleLabel")}
            </label>
            <input
              id="title"
              type="text"
              autoFocus
              value={data.title}
              onChange={(e) => setData("title", e.target.value)}
              placeholder={t("titleExample")}
              className="mt-2 w-full rounded-xl border border-slate-300 bg-white px-3.5 py-2.5 text-[15px] outline-none transition focus:border-emerald-500 focus:ring-2 focus:ring-emerald-100"
            />
          </div>

          <label className="mt-5 flex cursor-pointer items-center gap-3 rounded-xl border border-slate-200 bg-slate-50 px-4 py-3">
            <input
              type="checkbox"
              className="h-4 w-4 accent-emerald-600"
              checked={data.isPublic}
              onChange={(e) => setData("isPublic", e.target.checked)}
            />
            <span className="text-sm">
              <span className="font-medium text-slate-800">{t("makePublic")}</span>
              <span className="ml-2 text-slate-500">
                {t("makePublicDesc")}
              </span>
            </span>
          </label>

          <div className="mt-7 flex items-center justify-end gap-3">
            <Link
              href="/notes"
              className="rounded-xl px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-100 transition"
            >
              {t("cancel")}
            </Link>
            <button
              type="submit"
              disabled={processing || !data.title.trim()}
              className="rounded-xl bg-emerald-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {processing ? t("creating") : t("createAndEdit")}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}
