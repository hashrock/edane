import { Head, Link, useForm } from "@inertiajs/react";
import type { SessionUser } from "../../utils/session";

type User = SessionUser | null;

export default function NotesNew({ user }: { user: User }) {
  const { data, setData, post, processing } = useForm({
    title: "",
    isPublic: false,
  });

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!data.title.trim()) return;
    post("/notes");
  };

  return (
    <div className="max-w-3xl mx-auto px-6 py-7 md:py-9">
      <Head title="新規ノート" />
      <header className="anim-header mb-10 flex items-center justify-between gap-3">
        <h1 className="text-xl font-bold tracking-tight flex items-center gap-2">
          <img src="/logo.svg" alt="" className="w-7 h-7" />
          Edane
        </h1>
        {user && (
          <Link
            href="/notes"
            className="text-sm font-medium text-emerald-700 hover:text-emerald-800"
          >
            ← 一覧
          </Link>
        )}
      </header>

      <section className="anim-item">
        <form
          onSubmit={submit}
          className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm md:p-8"
        >
          <h2 className="text-xl font-bold tracking-tight">新しいノート</h2>
          <p className="mt-1 text-sm text-slate-500">
            タイトルを入力するとマインドマップの起点（ルートノード）になります。
          </p>

          <div className="mt-6">
            <label
              htmlFor="title"
              className="block text-sm font-medium text-slate-700"
            >
              タイトル
            </label>
            <input
              id="title"
              type="text"
              autoFocus
              value={data.title}
              onChange={(e) => setData("title", e.target.value)}
              placeholder="例: プロジェクト計画"
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
              <span className="font-medium text-slate-800">公開する</span>
              <span className="ml-2 text-slate-500">
                リンクを知っている人が閲覧できます
              </span>
            </span>
          </label>

          <div className="mt-7 flex items-center justify-end gap-3">
            <Link
              href="/notes"
              className="rounded-xl px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-100 transition"
            >
              キャンセル
            </Link>
            <button
              type="submit"
              disabled={processing || !data.title.trim()}
              className="rounded-xl bg-emerald-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {processing ? "作成中..." : "作成して編集"}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}
