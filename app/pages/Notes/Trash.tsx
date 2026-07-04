import { Head, Link, router } from "@inertiajs/react";
import { useState } from "react";
import ConfirmDialog from "../../components/ConfirmDialog";
import { TrashIcon } from "../../components/icons";
import type { SessionUser } from "../../utils/session";

type TrashedNote = {
  id: string;
  title: string;
  isPublic: boolean;
  deletedAt: string;
  updatedAt: string;
};

export default function NotesTrash({
  user,
  notes,
}: {
  user: SessionUser;
  notes: TrashedNote[];
}) {
  const [purgeTarget, setPurgeTarget] = useState<TrashedNote | null>(null);

  const restore = (note: TrashedNote) => {
    router.post(`/notes/${note.id}/restore`, {}, { preserveScroll: true });
  };

  const confirmPurge = () => {
    if (!purgeTarget) return;
    router.delete(`/notes/${purgeTarget.id}`, { preserveScroll: true });
    setPurgeTarget(null);
  };

  return (
    <div className="mx-auto max-w-3xl px-6 py-7 md:py-9">
      <Head title="ゴミ箱 - Edane" />
      <header className="anim-header mb-10 flex items-center justify-between gap-3">
        <h1 className="text-xl font-bold tracking-tight">
          <img src="/logo.svg" alt="Edane" className="h-7 w-auto" />
        </h1>
        {user.name && (
          <span className="text-sm text-slate-500">{user.name}</span>
        )}
      </header>

      <section>
        <div className="mb-5 flex items-center justify-between">
          <h2 className="text-xl font-bold tracking-tight">ゴミ箱</h2>
          <Link
            href="/notes"
            className="text-sm font-medium text-emerald-700 hover:text-emerald-800"
          >
            ← マイノートへ
          </Link>
        </div>

        {notes.length === 0 ? (
          <p className="text-slate-500">ゴミ箱は空です。</p>
        ) : (
          <>
            <p className="mb-4 text-sm text-slate-500">
              復元すればマイノートに戻ります。「完全に削除」は取り消せません。
            </p>
            <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
              {notes.map((note, index) => (
                <div
                  key={note.id}
                  style={{ animationDelay: `${index * 40}ms` }}
                  className={`anim-item flex items-center gap-3 px-5 py-4 ${index !== 0 ? "border-t border-slate-100" : ""}`}
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[15px] font-semibold text-slate-950">
                      {note.title || "無題"}
                    </div>
                    <div className="mt-1 text-sm text-slate-500">
                      {new Date(note.deletedAt).toLocaleDateString("ja-JP")} に削除
                    </div>
                  </div>
                  <button
                    onClick={() => restore(note)}
                    className="rounded-lg border border-slate-200 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
                  >
                    復元
                  </button>
                  <button
                    onClick={() => setPurgeTarget(note)}
                    className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium text-red-600 hover:bg-red-50"
                  >
                    <TrashIcon width="15" height="15" />
                    完全に削除
                  </button>
                </div>
              ))}
            </div>
          </>
        )}
      </section>

      <ConfirmDialog
        open={purgeTarget !== null}
        variant="danger"
        title="完全に削除しますか？"
        message={
          purgeTarget
            ? `「${purgeTarget.title || "無題"}」を完全に削除します。この操作は取り消せません。`
            : undefined
        }
        confirmLabel="完全に削除"
        cancelLabel="キャンセル"
        onConfirm={confirmPurge}
        onCancel={() => setPurgeTarget(null)}
      />
    </div>
  );
}
