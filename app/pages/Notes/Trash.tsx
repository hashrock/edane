import { Head, Link, router } from "@inertiajs/react";
import { useState } from "react";
import ConfirmDialog from "../../components/ConfirmDialog";
import { TrashIcon } from "../../components/icons";
import type { SessionUser } from "../../user";
import { dateLocale, t } from "../../application/i18n";
import { useLocale } from "../../components/useLocale";

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
  useLocale(); // 言語切り替えで再レンダー（t() / 日付表記の購読）
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
      <Head title={`${t("trash")} - Edane`} />
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
          <h2 className="text-xl font-bold tracking-tight">{t("trash")}</h2>
          <Link
            href="/notes"
            className="text-sm font-medium text-emerald-700 hover:text-emerald-800"
          >
            {t("backToMyNotes")}
          </Link>
        </div>

        {notes.length === 0 ? (
          <p className="text-slate-500">{t("trashEmpty")}</p>
        ) : (
          <>
            <p className="mb-4 text-sm text-slate-500">
              {t("trashNote")}
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
                      {note.title || t("untitled")}
                    </div>
                    <div className="mt-1 text-sm text-slate-500">
                      {t("deletedOn", {
                        date: new Date(note.deletedAt).toLocaleDateString(dateLocale()),
                      })}
                    </div>
                  </div>
                  <button
                    onClick={() => restore(note)}
                    className="rounded-lg border border-slate-200 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
                  >
                    {t("restore")}
                  </button>
                  <button
                    onClick={() => setPurgeTarget(note)}
                    className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium text-red-600 hover:bg-red-50"
                  >
                    <TrashIcon width="15" height="15" />
                    {t("purge")}
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
        title={t("purgeConfirmTitle")}
        message={
          purgeTarget
            ? t("purgeConfirmMessage", { title: purgeTarget.title || t("untitled") })
            : undefined
        }
        confirmLabel={t("purge")}
        cancelLabel={t("cancel")}
        onConfirm={confirmPurge}
        onCancel={() => setPurgeTarget(null)}
      />
    </div>
  );
}
