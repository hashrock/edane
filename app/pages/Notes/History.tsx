import { Head, Link, router } from "@inertiajs/react";
import { useEffect, useState } from "react";
import ConfirmDialog from "../../components/ConfirmDialog";
import NoteEditor from "../../components/NoteEditor";
import { dateLocale, t } from "../../application/i18n";
import { MAX_BACKUPS_PER_NOTE, type NoteBackupSummary } from "../../application/noteBackups";
import { useLocale } from "../../components/useLocale";

/** GET /api/notes/:id/backups/:backupId の中身（プレビュー用）。 */
interface BackupContent {
  id: string;
  title: string;
  content: string;
}

const formatDate = (iso: string) => new Date(iso).toLocaleString(dateLocale());

// ノートのバックアップ履歴。左の一覧で選んだ版を右に閲覧専用で表示し、
// 「この版に復元」で NoteRoom 経由の commit として書き戻す（復元前の内容も
// バックアップに残る）。
export default function NotesHistory({
  note,
  backups,
}: {
  note: { id: string; title: string };
  backups: NoteBackupSummary[];
}) {
  useLocale(); // 言語切り替えで再レンダー（t() / 日付表記の購読）
  const [selectedId, setSelectedId] = useState<string | null>(backups[0]?.id ?? null);
  // null = loading (or nothing selected), "error" = the fetch failed.
  const [preview, setPreview] = useState<BackupContent | "error" | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [restore, setRestore] = useState<"idle" | "restoring" | "failed">("idle");

  useEffect(() => {
    if (!selectedId) return;
    let cancelled = false;
    setPreview(null);
    fetch(`/api/notes/${note.id}/backups/${selectedId}`)
      .then((r) => (r.ok ? (r.json() as Promise<BackupContent>) : Promise.reject(new Error(String(r.status)))))
      .then((b) => !cancelled && setPreview(b))
      .catch(() => !cancelled && setPreview("error"));
    return () => {
      cancelled = true;
    };
  }, [note.id, selectedId]);

  const selected = backups.find((b) => b.id === selectedId) ?? null;

  const restoreSelected = async () => {
    if (!selected) return;
    setConfirming(false);
    setRestore("restoring");
    try {
      const r = await fetch(`/api/notes/${note.id}/backups/${selected.id}/restore`, { method: "POST" });
      if (!r.ok) throw new Error(String(r.status));
      router.visit(`/notes/${note.id}/edit`);
    } catch {
      setRestore("failed");
    }
  };

  return (
    <div className="flex h-screen flex-col bg-slate-50 text-slate-950">
      <Head title={`${t("historyHeading")} - ${note.title || t("untitled")}`} />
      <header className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-slate-200 bg-white px-4 py-3">
        <div className="min-w-0">
          <h1 className="truncate text-base font-semibold tracking-tight">
            {t("historyHeading")}: {note.title || t("untitled")}
          </h1>
          <p className="mt-0.5 text-xs text-slate-500">{t("historyNote", { max: MAX_BACKUPS_PER_NOTE })}</p>
        </div>
        <Link
          href={`/notes/${note.id}/edit`}
          className="shrink-0 text-sm font-medium text-emerald-700 hover:text-emerald-800"
        >
          {t("historyBackToNote")}
        </Link>
      </header>

      {backups.length === 0 ? (
        <p className="p-6 text-slate-500">{t("historyEmpty")}</p>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col md:flex-row">
          <ul
            aria-label={t("historyHeading")}
            className="max-h-48 shrink-0 overflow-y-auto border-b border-slate-200 bg-white md:max-h-none md:w-64 md:border-b-0 md:border-r"
          >
            {backups.map((b) => (
              <li key={b.id}>
                <button
                  onClick={() => setSelectedId(b.id)}
                  aria-current={b.id === selectedId}
                  className={`w-full px-4 py-2.5 text-left text-sm ${
                    b.id === selectedId ? "bg-emerald-50 text-emerald-900" : "hover:bg-slate-50"
                  }`}
                >
                  <div className="font-medium">{formatDate(b.createdAt)}</div>
                  <div className="truncate text-xs text-slate-500">
                    {t("historyVersion", { version: b.version })} · {b.title || t("untitled")}
                  </div>
                </button>
              </li>
            ))}
          </ul>

          <section className="flex min-h-0 min-w-0 flex-1 flex-col">
            {selected && (
              <div className="flex shrink-0 items-center justify-between gap-3 border-b border-slate-200 bg-white px-4 py-2">
                <span className="text-sm text-slate-600">{formatDate(selected.createdAt)}</span>
                <div className="flex items-center gap-3">
                  {restore === "failed" && <span className="text-sm text-red-600">{t("historyRestoreFailed")}</span>}
                  <button
                    onClick={() => setConfirming(true)}
                    disabled={restore === "restoring" || !preview || preview === "error"}
                    className="rounded-lg bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
                  >
                    {t("historyRestore")}
                  </button>
                </div>
              </div>
            )}
            <div className="flex min-h-0 flex-1 flex-col">
              {preview === "error" ? (
                <p className="p-6 text-sm text-red-600">{t("historyPreviewFailed")}</p>
              ) : preview ? (
                <NoteEditor
                  key={preview.id}
                  initialContent={preview.content}
                  initialTitle={preview.title}
                  readOnly
                />
              ) : (
                <p className="p-6 text-sm text-slate-400">{selected ? t("loading") : t("historySelectHint")}</p>
              )}
            </div>
          </section>
        </div>
      )}

      <ConfirmDialog
        open={confirming}
        title={t("historyRestoreConfirmTitle")}
        message={selected ? t("historyRestoreConfirmMessage", { date: formatDate(selected.createdAt) }) : undefined}
        confirmLabel={t("historyRestore")}
        cancelLabel={t("cancel")}
        onConfirm={restoreSelected}
        onCancel={() => setConfirming(false)}
      />
    </div>
  );
}
