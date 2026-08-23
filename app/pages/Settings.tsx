import { Head, Link } from "@inertiajs/react";
import { useEffect, useState, useCallback } from "react";
import type { SessionUser } from "../user";
import { IMAGE_STORAGE_LIMIT_BYTES } from "../domain/imageStorage";
import { publicationUrls } from "../application/nodePublication";
import { copyText } from "../lib/clipboard";

type User = SessionUser | null;

interface ImageMeta {
  id: string;
  url: string;
  filename: string;
  contentType: string;
  size: number;
  createdAt: string;
}

interface ApiToken {
  id: string;
  name: string;
  createdAt: string;
}

/** GET /api/publications の1行（Web公開中のノード）。 */
interface Publication {
  id: string;
  noteId: string;
  nodeId: string;
  createdAt: string;
  noteTitle: string;
  /** ルート→ノードのテキスト列。ノードが消えていれば null。 */
  path: string[] | null;
  /** 今URLが生きているか（ノートが公開中 かつ ノードが存在）。 */
  active: boolean;
  inactiveReason: "note-trashed" | "note-private" | "node-missing" | null;
}

const INACTIVE_LABEL: Record<
  NonNullable<Publication["inactiveReason"]>,
  string
> = {
  "note-trashed": "停止中（ノートがゴミ箱にあります）",
  "note-private": "停止中（ノートが非公開です）",
  "node-missing": "停止中（ノードが見つかりません）",
};

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export default function Settings({ user }: { user: User }) {
  const [images, setImages] = useState<ImageMeta[]>([]);
  const [used, setUsed] = useState(0);
  const [limit, setLimit] = useState(IMAGE_STORAGE_LIMIT_BYTES);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [tokens, setTokens] = useState<ApiToken[]>([]);
  const [newToken, setNewToken] = useState<string | null>(null);

  const [publications, setPublications] = useState<Publication[]>([]);
  const [copiedPubUrl, setCopiedPubUrl] = useState<string | null>(null);

  const loadImages = useCallback(async () => {
    const res = await fetch("/api/images", { credentials: "include" });
    if (!res.ok) return;
    const data = (await res.json()) as {
      images: ImageMeta[];
      used: number;
      limit: number;
    };
    setImages(data.images);
    setUsed(data.used);
    setLimit(data.limit);
  }, []);

  const loadTokens = useCallback(async () => {
    const res = await fetch("/api/tokens", { credentials: "include" });
    if (res.ok) setTokens((await res.json()) as ApiToken[]);
  }, []);

  const loadPublications = useCallback(async () => {
    const res = await fetch("/api/publications", { credentials: "include" });
    if (!res.ok) return;
    const data = (await res.json()) as { publications: Publication[] };
    setPublications(data.publications);
  }, []);

  useEffect(() => {
    Promise.all([loadImages(), loadTokens(), loadPublications()]).finally(() =>
      setLoading(false)
    );
  }, [loadImages, loadTokens, loadPublications]);

  const handleUpload = async (file: File | undefined) => {
    if (!file) return;
    setUploading(true);
    setError(null);
    try {
      const form = new FormData();
      form.append("file", file);
      const res = await fetch("/api/images", {
        method: "POST",
        credentials: "include",
        body: form,
      });
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { error?: string };
        setError(
          err?.error === "Storage limit exceeded"
            ? `容量上限（${formatBytes(limit)}）を超えています`
            : "アップロードに失敗しました"
        );
        return;
      }
      await loadImages();
    } finally {
      setUploading(false);
    }
  };

  const deleteImage = async (id: string) => {
    await fetch(`/api/images/${id}`, {
      method: "DELETE",
      credentials: "include",
    });
    await loadImages();
  };

  const createToken = async () => {
    const res = await fetch("/api/tokens", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "default" }),
    });
    if (res.ok) {
      const data = (await res.json()) as { token: string };
      setNewToken(data.token);
      await loadTokens();
    }
  };

  const deleteToken = async (id: string) => {
    await fetch(`/api/tokens/${id}`, {
      method: "DELETE",
      credentials: "include",
    });
    await loadTokens();
  };

  const revokePublication = async (id: string) => {
    await fetch(`/api/publications/${id}`, {
      method: "DELETE",
      credentials: "include",
    });
    await loadPublications();
  };

  const copyPubUrl = async (url: string) => {
    const ok = await copyText(url);
    setCopiedPubUrl(ok ? url : null);
  };

  const pct = Math.min(100, Math.round((used / limit) * 100));

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <Head title="設定" />
      <header className="flex h-14 items-center gap-3 border-b border-slate-200 bg-white px-4 md:px-6">
        <Link
          href="/notes"
          className="text-sm font-medium text-emerald-700 hover:text-emerald-800"
        >
          ← 一覧
        </Link>
        <div className="h-6 w-px bg-slate-200" />
        <h1 className="text-lg font-bold tracking-tight">プロジェクト設定</h1>
      </header>

      <main className="mx-auto max-w-3xl px-4 py-8 md:px-6">
        {user && (
          <section className="mb-8">
            <h2 className="mb-2 text-sm font-semibold uppercase text-slate-400">
              アカウント
            </h2>
            <div className="rounded-xl border border-slate-200 bg-white p-4 text-sm">
              <div className="font-medium">{user.name || "（名前未設定）"}</div>
              <div className="text-slate-500">{user.email}</div>
            </div>
          </section>
        )}

        <section className="mb-8">
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-sm font-semibold uppercase text-slate-400">
              画像ストレージ
            </h2>
            <label className="cursor-pointer rounded-lg bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-700">
              {uploading ? "アップロード中…" : "画像を追加"}
              <input
                type="file"
                accept="image/*"
                className="hidden"
                disabled={uploading}
                onChange={(e) => handleUpload(e.target.files?.[0])}
              />
            </label>
          </div>

          <div className="rounded-xl border border-slate-200 bg-white p-4">
            <div className="mb-1 flex items-center justify-between text-sm">
              <span className="font-medium">使用量</span>
              <span className="text-slate-500">
                {formatBytes(used)} / {formatBytes(limit)}
              </span>
            </div>
            <div className="mb-4 h-2 w-full overflow-hidden rounded-full bg-slate-100">
              <div
                className={pct > 90 ? "h-full bg-red-500" : "h-full bg-emerald-500"}
                style={{ width: `${pct}%` }}
              />
            </div>
            {error && <div className="mb-3 text-sm text-red-600">{error}</div>}

            {loading ? (
              <div className="py-6 text-center text-slate-400">読み込み中…</div>
            ) : images.length === 0 ? (
              <div className="rounded-lg border border-dashed border-slate-200 py-8 text-center text-sm text-slate-400">
                画像はまだありません
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4">
                {images.map((img) => (
                  <div
                    key={img.id}
                    className="group relative overflow-hidden rounded-lg border border-slate-200"
                  >
                    <img
                      src={img.url}
                      alt={img.filename}
                      className="h-28 w-full object-cover"
                    />
                    <div
                      className="truncate px-1.5 py-1 text-[11px] text-slate-600"
                      title={img.filename}
                    >
                      {img.filename}
                    </div>
                    <div className="px-1.5 pb-1 text-[11px] text-slate-400">
                      {formatBytes(img.size)}
                    </div>
                    <button
                      onClick={() => deleteImage(img.id)}
                      className="absolute right-1.5 top-1.5 hidden rounded bg-red-600 px-2 py-0.5 text-[11px] text-white group-hover:block"
                    >
                      削除
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </section>

        <section className="mb-8">
          <h2 className="mb-2 text-sm font-semibold uppercase text-slate-400">
            Web公開中のノード
          </h2>
          <div className="rounded-xl border border-slate-200 bg-white">
            {loading ? (
              <div className="py-6 text-center text-sm text-slate-400">
                読み込み中…
              </div>
            ) : publications.length === 0 ? (
              <div className="py-6 text-center text-sm text-slate-400">
                Web公開中のノードはありません（エディタでノードを右クリック →
                「Web公開」）
              </div>
            ) : (
              <ul className="divide-y divide-slate-100">
                {publications.map((pub) => {
                  const urls = publicationUrls(window.location.origin, pub.id);
                  const urlButton = (label: string, url: string) => (
                    <span className="inline-flex items-center gap-1">
                      <a
                        href={url}
                        target="_blank"
                        rel="noopener"
                        className="text-emerald-700 hover:underline"
                      >
                        {label}
                      </a>
                      <button
                        onClick={() => void copyPubUrl(url)}
                        title={`${label} URLをコピー`}
                        className="rounded border border-slate-200 px-1.5 py-0.5 text-[11px] text-slate-500 hover:bg-slate-100"
                      >
                        {copiedPubUrl === url ? "コピーしました" : "コピー"}
                      </button>
                    </span>
                  );
                  return (
                    <li key={pub.id} className="px-4 py-3 text-sm">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <Link
                            href={`/notes/${pub.noteId}/edit`}
                            className="font-medium hover:underline"
                          >
                            {pub.noteTitle}
                          </Link>
                          <div
                            className="mt-0.5 truncate text-xs text-slate-500"
                            title={pub.path?.join(" › ")}
                          >
                            {pub.path
                              ? pub.path.join(" › ")
                              : "（ノードが見つかりません）"}
                          </div>
                          <div className="mt-1.5 flex flex-wrap items-center gap-3 text-xs">
                            {urlButton("JSON", urls.json)}
                            {urlButton("Markdown", urls.md)}
                            {pub.inactiveReason && (
                              <span className="rounded bg-amber-50 px-1.5 py-0.5 text-[11px] text-amber-700">
                                {INACTIVE_LABEL[pub.inactiveReason]}
                              </span>
                            )}
                          </div>
                        </div>
                        <button
                          onClick={() => void revokePublication(pub.id)}
                          className="shrink-0 text-xs text-red-600 hover:underline"
                        >
                          解除
                        </button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
          <p className="mt-2 text-xs leading-relaxed text-slate-400">
            公開URLは枝（ノードとその子孫）の最新内容を JSON / Markdown
            で配信します。解除するとURLは無効になり、再公開すると新しいURLが
            発行されます。
          </p>
        </section>

        <section>
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-sm font-semibold uppercase text-slate-400">
              APIトークン（デスクトップアプリ用）
            </h2>
            <button
              onClick={createToken}
              className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium hover:bg-slate-50"
            >
              新規作成
            </button>
          </div>
          {newToken && (
            <div className="mb-3 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm">
              <div className="mb-1 font-medium text-amber-800">
                トークンを発行しました（この画面でしか確認できません）
              </div>
              <code className="block break-all rounded bg-white px-2 py-1 text-xs">
                {newToken}
              </code>
            </div>
          )}
          <div className="rounded-xl border border-slate-200 bg-white">
            {tokens.length === 0 ? (
              <div className="py-6 text-center text-sm text-slate-400">
                トークンはありません
              </div>
            ) : (
              <ul className="divide-y divide-slate-100">
                {tokens.map((t) => (
                  <li
                    key={t.id}
                    className="flex items-center justify-between px-4 py-3 text-sm"
                  >
                    <div>
                      <div className="font-medium">{t.name}</div>
                      <div className="text-xs text-slate-400">{t.createdAt}</div>
                    </div>
                    <button
                      onClick={() => deleteToken(t.id)}
                      className="text-xs text-red-600 hover:underline"
                    >
                      削除
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>
      </main>
    </div>
  );
}
