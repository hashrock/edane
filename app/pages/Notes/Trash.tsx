import { Head, Link, router } from "@inertiajs/react";
import { useState } from "react";
import ConfirmDialog from "../../components/ConfirmDialog";
import { TrashIcon } from "../../components/icons";
import type { SessionUser } from "../../user";
import { dateLocale, t } from "../../application/i18n";
import { useLocale } from "../../components/useLocale";
import ServiceSwitcher from "../../components/ServiceSwitcher";

const MAX_STAGGER_INDEX = 8;
const STAGGER_STEP_MS = 30;

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
    <div className="mx-auto max-w-3xl px-4 py-6 sm:px-6 sm:py-7 md:py-9">
      <Head title={`${t("trash")} - Edane`} />
      <header className="anim-header mb-8 sm:mb-10 flex items-center justify-between gap-3">
        <h1 className="text-xl font-bold tracking-tight">
          <Link
            href="/notes"
            className="inline-flex items-center rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500"
          >
            <img src="/logo.svg" alt="Edane" className="h-7 w-auto" />
          </Link>
        </h1>
        <div className="flex items-center gap-3">
          {user.name && (
            <span className="text-sm font-medium text-slate-700">{user.name}</span>
          )}
          <ServiceSwitcher className="text-slate-500 hover:text-slate-900" />
        </div>
      </header>

      <section>
        <div className="mb-5 flex items-center justify-between gap-3">
          <h2 className="text-xl font-bold tracking-tight text-slate-900">{t("trash")}</h2>
          <Link
            href="/notes"
            className="rounded-md px-1 py-1 text-sm font-medium text-emerald-700 hover:text-emerald-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500"
          >
            {t("backToMyNotes")}
          </Link>
        </div>

        {notes.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-slate-200 bg-white px-6 py-12 text-center">
            <p className="text-sm text-slate-500">{t("trashEmpty")}</p>
          </div>
        ) : (
          <>
            <p className="mb-4 text-sm text-slate-500">
              {t("trashNote")}
            </p>
            <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
              {notes.map((note, index) => (
                <div
                  key={note.id}
                  style={{
                    animationDelay: `${Math.min(index, MAX_STAGGER_INDEX) * STAGGER_STEP_MS}ms`,
                  }}
                  className={`anim-item flex flex-col gap-3 px-4 py-3.5 sm:flex-row sm:items-center sm:px-5 sm:py-4 ${
                    index !== 0 ? "border-t border-slate-100" : ""
                  }`}
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[15px] font-semibold text-slate-950">
                      {note.title || t("untitled")}
                    </div>
                    <div className="mt-1 text-xs text-slate-500">
                      {t("deletedOn", {
                        date: new Date(note.deletedAt).toLocaleDateString(dateLocale()),
                      })}
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      type="button"
                      onClick={() => restore(note)}
                      className="cursor-pointer rounded-lg border border-slate-200 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500"
                    >
                      {t("restore")}
                    </button>
                    <button
                      type="button"
                      onClick={() => setPurgeTarget(note)}
                      className="flex cursor-pointer items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium text-red-600 hover:bg-red-50 transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500"
                    >
                      <TrashIcon width="15" height="15" />
                      {t("purge")}
                    </button>
                  </div>
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
