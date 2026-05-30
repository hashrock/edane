import { Head, Link, router } from "@inertiajs/react";

type Note = {
  id: string;
  title: string;
  isPublic: boolean;
  updatedAt: string;
};

type User = {
  id: string;
  email: string;
  name: string;
  avatarUrl: string;
} | null;

export default function NotesIndex({
  user,
  notes,
}: {
  user: User;
  notes: Note[];
}) {
  const createNote = () => {
    const title = prompt("ノートのタイトル");
    if (!title) return;
    // サーバ側で作成後 /notes/:id/edit へリダイレクト
    router.post("/notes", { title });
  };

  const deleteNote = (id: string) => {
    if (!confirm("このノートを削除しますか？")) return;
    router.delete(`/notes/${id}`, { preserveScroll: true });
  };

  return (
    <div className="max-w-3xl mx-auto px-6 py-7 md:py-9">
      <Head title="Edane" />
      <header className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 mb-10">
        <h1 className="text-xl font-bold tracking-tight flex items-center gap-2">
          <img src="/logo.svg" alt="" className="w-7 h-7" />
          Edane
        </h1>
        <div className="flex items-center gap-2 sm:gap-3 flex-wrap">
          {user ? (
            <div className="flex items-center gap-3 text-sm text-slate-700">
              {user.avatarUrl && (
                <img
                  src={user.avatarUrl}
                  alt=""
                  className="w-7 h-7 rounded-full"
                />
              )}
              <span>{user.name}</span>
              <a
                href="/auth/logout"
                className="text-slate-500 hover:text-slate-900 transition"
              >
                ログアウト
              </a>
            </div>
          ) : (
            <>
              <Link
                href="/guest"
                className="px-3.5 py-2 text-sm border border-slate-200 rounded-lg hover:bg-slate-100 transition"
              >
                ゲストで試す
              </Link>
              <a
                href="/auth/google"
                className="px-3.5 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition"
              >
                Googleでログイン
              </a>
            </>
          )}
        </div>
      </header>

      {user && (
        <section>
          <div className="flex items-center justify-between mb-5">
            <h2 className="text-xl font-bold tracking-tight">マイノート</h2>
            <button
              onClick={createNote}
              className="rounded-xl bg-emerald-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-emerald-700 transition"
            >
              + 新規作成
            </button>
          </div>
          {notes.length === 0 ? (
            <p className="text-slate-500">ノートがありません。</p>
          ) : (
            <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
              {notes.map((note, index) => (
                <div
                  key={note.id}
                  className={`group flex items-center transition-colors hover:bg-slate-50 ${index !== 0 ? "border-t border-slate-100" : ""}`}
                >
                  <Link
                    href={`/notes/${note.id}/edit`}
                    className="flex-1 min-w-0 px-5 py-4"
                  >
                    <div className="text-[15px] font-semibold text-slate-950 truncate">
                      {note.title}
                    </div>
                    <div className="mt-1 text-sm text-slate-500">
                      {new Date(note.updatedAt).toLocaleDateString("ja-JP")}
                    </div>
                  </Link>
                  <div className="flex items-center gap-4 pr-4 pl-2">
                    <span
                      className={`rounded-full px-2.5 py-1 text-xs font-medium ${note.isPublic ? "bg-emerald-50 text-emerald-700" : "bg-slate-100 text-slate-600"}`}
                    >
                      {note.isPublic ? "公開" : "非公開"}
                    </span>
                    <button
                      onClick={() => deleteNote(note.id)}
                      className="p-2 text-slate-400 opacity-70 hover:text-red-500 group-hover:opacity-100 transition"
                      title="削除"
                    >
                      <svg
                        xmlns="http://www.w3.org/2000/svg"
                        width="16"
                        height="16"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <path d="M3 6h18" />
                        <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
                        <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
                      </svg>
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      )}
    </div>
  );
}
