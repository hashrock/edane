import { useEffect, useState } from "react";
import { webPageUrl, type WebPagePublicationStatus } from "../application/webPagePublication";
import { t } from "../application/i18n";
import { copyText } from "../lib/clipboard";

async function webPageApi(noteId: string, method: "GET" | "POST" | "DELETE"): Promise<WebPagePublicationStatus | null> {
  const res = await fetch(`/api/notes/${encodeURIComponent(noteId)}/webpage`, { method, credentials: "include" });
  if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error || t("webPublishFailed"));
  const body = (await res.json()) as { publication?: WebPagePublicationStatus | null };
  return body.publication ?? null;
}

/**
 * Publish / unpublish the note as a web page (`/w/:id`) — the web page
 * format's action in the pages mode's preview, as ▶ is the slides'.
 */
export default function PagePublish({ noteId, isPublic }: { noteId: string; isPublic: boolean }) {
  const [status, setStatus] = useState<WebPagePublicationStatus | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let live = true;
    setError(null);
    webPageApi(noteId, "GET").then(
      (s) => live && setStatus(s),
      (e: Error) => live && setError(e.message)
    );
    return () => {
      live = false;
    };
  }, [noteId, isPublic]);

  const run = async (method: "POST" | "DELETE") => {
    setBusy(true);
    setError(null);
    try {
      setStatus(await webPageApi(noteId, method));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const url = status ? webPageUrl(window.location.origin, status.id) : null;
  const button = "rounded-md px-3 py-1.5 text-xs font-medium disabled:opacity-50";

  return (
    <section data-testid="webpage-publish" className="mt-1 space-y-2 border-t border-slate-100 px-0.5 pt-2">
      {!isPublic ? (
        <>
          <p className="text-xs text-slate-500">{t("webPublishPrivate")}</p>
          {/* A page published before the note went private can still be revoked. */}
          {status && (
            <button type="button" disabled={busy} data-testid="webpage-unpublish" className={`${button} text-red-600 hover:bg-red-50`} onClick={() => void run("DELETE")}>
              {t("webPublishUnpublish")}
            </button>
          )}
        </>
      ) : status === undefined && !error ? (
        <p className="text-xs text-slate-400">{t("loading")}</p>
      ) : status && url ? (
        <>
          <div className="flex items-center gap-1">
            <input readOnly aria-label="URL" data-testid="webpage-url" value={url} className="min-w-0 flex-1 rounded-md border border-slate-200 bg-slate-50 px-2 py-1 text-xs" onFocus={(e) => e.currentTarget.select()} />
            <button
              type="button"
              className={`${button} text-slate-600 hover:bg-slate-100`}
              onClick={() => {
                void copyText(url).then(() => setCopied(true));
              }}
            >
              {copied ? t("copied") : t("copy")}
            </button>
            <a href={url} target="_blank" rel="noopener noreferrer" className={`${button} text-emerald-700 hover:bg-emerald-50`}>
              {t("webPublishOpen")}
            </a>
          </div>
          <p className="text-[11px] text-slate-400">{status.active ? t("webPublishLive") : t("webPublishInactive")}</p>
          <div className="flex gap-2">
            {!status.active && (
              <button type="button" disabled={busy} className={`${button} bg-emerald-600 text-white hover:bg-emerald-700`} onClick={() => void run("POST")}>
                {t("webPublishAction")}
              </button>
            )}
            <button type="button" disabled={busy} data-testid="webpage-unpublish" className={`${button} text-red-600 hover:bg-red-50`} onClick={() => void run("DELETE")}>
              {t("webPublishUnpublish")}
            </button>
          </div>
        </>
      ) : (
        <button type="button" disabled={busy} data-testid="webpage-publish-action" className={`${button} bg-emerald-600 text-white hover:bg-emerald-700`} onClick={() => void run("POST")}>
          {t("webPublishAction")}
        </button>
      )}
      {error && <p role="alert" className="text-xs text-red-600">{error}</p>}
    </section>
  );
}
