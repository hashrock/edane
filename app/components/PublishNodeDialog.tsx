import { useCallback, useEffect, useState } from "react";
import { publicationUrls } from "../application/nodePublication";
import { t } from "../application/i18n";
import { copyText } from "../lib/clipboard";
import { useLocale } from "./useLocale";

interface Props {
  noteId: string;
  nodeId: string;
  /** 対象ノードの表示テキスト（見出しに出す）。 */
  nodeText: string;
  /** ノートの公開状態。非公開なら発行せず理由だけ見せる。 */
  isPublic: boolean;
  onClose: () => void;
}

type State =
  | { kind: "private" }
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; pubId: string };

/**
 * ノードのWeb公開ダイアログ。開いた時点で公開URLを発行（既に公開済みなら
 * 同じURLが返る＝冪等）し、JSON / Markdown の両URLをコピーできる。解除は
 * ここから即時（再公開すると新しいURL＝ローテーション）。一覧・管理は
 * 設定ページ（/settings）にもある。
 */
export default function PublishNodeDialog({
  noteId,
  nodeId,
  nodeText,
  isPublic,
  onClose,
}: Props) {
  useLocale(); // 言語切り替えで再レンダー（t() の購読）
  const [state, setState] = useState<State>(
    isPublic ? { kind: "loading" } : { kind: "private" }
  );
  const [copied, setCopied] = useState<"json" | "md" | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  useEffect(() => {
    if (!isPublic) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/notes/${noteId}/publications`, {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ nodeId }),
        });
        const data = (await res.json().catch(() => ({}))) as {
          id?: string;
          error?: string;
        };
        if (cancelled) return;
        if (!res.ok || !data.id) {
          setState({
            kind: "error",
            message: data.error || t("publishError"),
          });
          return;
        }
        setState({ kind: "ready", pubId: data.id });
      } catch {
        if (!cancelled)
          setState({ kind: "error", message: t("publishError") });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [noteId, nodeId, isPublic]);

  const revoke = useCallback(async () => {
    if (state.kind !== "ready") return;
    await fetch(`/api/publications/${state.pubId}`, {
      method: "DELETE",
      credentials: "include",
    });
    onClose();
  }, [state, onClose]);

  const urls =
    state.kind === "ready"
      ? publicationUrls(window.location.origin, state.pubId)
      : null;

  const urlRow = (label: string, format: "json" | "md", url: string) => (
    <div className="flex items-center gap-2">
      <span className="w-20 shrink-0 text-xs font-medium text-slate-500">
        {label}
      </span>
      <input
        readOnly
        value={url}
        data-testid={`pub-url-${format}`}
        onFocus={(e) => e.currentTarget.select()}
        className="min-w-0 flex-1 rounded-lg border border-slate-200 bg-slate-50 px-2 py-1.5 font-mono text-xs text-slate-700"
      />
      <button
        type="button"
        onClick={() => {
          void copyText(url).then((ok) => setCopied(ok ? format : null));
        }}
        className="shrink-0 rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs font-medium text-slate-600 transition hover:bg-slate-100"
      >
        {copied === format ? t("copied") : t("copy")}
      </button>
    </div>
  );

  return (
    <div
      className="anim-overlay fixed inset-0 z-50 flex items-center justify-center bg-slate-950/40 px-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={t("publishDialogTitle")}
    >
      <div
        className="anim-modal w-full max-w-lg rounded-2xl border border-slate-200 bg-white p-6 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-base font-bold tracking-tight text-slate-950">
          {t("publishDialogTitle")}
        </h2>
        <p className="mt-1 truncate text-sm text-slate-500" title={nodeText}>
          {nodeText}
        </p>

        {state.kind === "private" && (
          <p className="mt-4 rounded-lg bg-amber-50 px-3 py-2 text-sm leading-relaxed text-amber-800">
            {t("privateNotePublishReason")}
            {t("publishToggleHint")}
          </p>
        )}

        {state.kind === "loading" && (
          <p className="mt-4 text-sm text-slate-500">{t("publishCreating")}</p>
        )}

        {state.kind === "error" && (
          <p className="mt-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
            {state.message}
          </p>
        )}

        {urls && (
          <>
            <div className="mt-4 space-y-2">
              {urlRow("JSON", "json", urls.json)}
              {urlRow("Markdown", "md", urls.md)}
            </div>
            <p className="mt-3 text-xs leading-relaxed text-slate-500">
              {t("publishNoteBeforeLink")}
              <a href="/settings" className="text-emerald-700 underline">
                {t("publishNoteLinkText")}
              </a>
              {t("publishNoteAfterLink")}
            </p>
          </>
        )}

        <div className="mt-6 flex items-center justify-end gap-3">
          {state.kind === "ready" && (
            <button
              type="button"
              onClick={() => void revoke()}
              className="rounded-xl px-4 py-2 text-sm font-medium text-red-600 transition hover:bg-red-50"
            >
              {t("publishRevoke")}
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            className="rounded-xl bg-slate-900 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-slate-700"
          >
            {t("close")}
          </button>
        </div>
      </div>
    </div>
  );
}
