import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../hooks/useAuth";
import { api } from "../lib/api";
import { isElectron } from "../hooks/useElectron";

type Note = {
  id: string;
  title: string;
  isPublic: boolean;
  createdAt: string;
  updatedAt: string;
};

type ApiToken = {
  id: string;
  name: string;
  createdAt: string;
};

export default function NotesListPage() {
  const { user, loading } = useAuth();
  const navigate = useNavigate();
  const [myNotes, setMyNotes] = useState<Note[]>([]);
  const [tokens, setTokens] = useState<ApiToken[]>([]);
  const [newToken, setNewToken] = useState<string | null>(null);

  useEffect(() => {
    if (user) {
      api<Note[]>("/api/notes/my").then(setMyNotes).catch(() => {});
      api<ApiToken[]>("/api/tokens").then(setTokens).catch(() => {});
    }
  }, [user]);

  const createNote = async () => {
    const title = prompt("ノートのタイトル");
    if (!title) return;
    const data = await api<{ id: string }>("/api/notes", {
      method: "POST",
      body: JSON.stringify({ title }),
    });
    navigate(`/notes/${data.id}/edit`);
  };

  const deleteNote = async (id: string) => {
    if (!confirm("このノートを削除しますか？")) return;
    await api(`/api/notes/${id}`, { method: "DELETE" });
    setMyNotes((prev) => prev.filter((n) => n.id !== id));
  };

  const createToken = async () => {
    const data = await api<{ id: string; token: string; name: string }>(
      "/api/tokens",
      { method: "POST", body: JSON.stringify({ name: "Electron" }) }
    );
    setNewToken(data.token);
    setTokens((prev) => [
      ...prev,
      { id: data.id, name: data.name, createdAt: new Date().toISOString() },
    ]);
  };

  const deleteToken = async (id: string) => {
    await api(`/api/tokens/${id}`, { method: "DELETE" });
    setTokens((prev) => prev.filter((t) => t.id !== id));
  };

  const electron = isElectron();

  if (loading) return null;

  return (
    <div
      className={`max-w-4xl mx-auto px-4 py-4 md:py-8 ${electron ? "electron-transparent" : ""}`}
      data-electron-interactive
    >
      <header className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 mb-6 md:mb-8">
        <h1 className="text-xl md:text-2xl font-bold flex items-center gap-2">
          <img src="/logo.svg" alt="" className="w-7 h-7 md:w-8 md:h-8" />
          Edane
        </h1>
        <div className="flex items-center gap-2 sm:gap-3 flex-wrap">
          {user ? (
            <div className="flex items-center gap-2 sm:gap-3">
              {user.avatarUrl && (
                <img
                  src={user.avatarUrl}
                  alt=""
                  className="w-7 h-7 sm:w-8 sm:h-8 rounded-full"
                />
              )}
              <span className="text-sm">{user.name}</span>
              <a
                href="/auth/logout"
                className="px-3 py-1.5 text-sm text-gray-600 hover:text-gray-900"
              >
                ログアウト
              </a>
            </div>
          ) : (
            <>
              <a
                href="/guest"
                className="px-3 md:px-4 py-2 text-sm border rounded-lg hover:bg-gray-100 transition"
              >
                ゲストで試す
              </a>
              <a
                href="/auth/google"
                className="px-3 md:px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition"
              >
                Googleでログイン
              </a>
            </>
          )}
        </div>
      </header>

      {user && (
        <>
          <section className="mb-8">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-semibold">マイノート</h2>
              <button
                onClick={createNote}
                className="px-4 py-2 text-sm bg-green-600 text-white rounded-lg hover:bg-green-700 transition"
              >
                + 新規作成
              </button>
            </div>
            {myNotes.length === 0 ? (
              <p className="text-gray-500">ノートがありません。</p>
            ) : (
              <div className="grid gap-3">
                {myNotes.map((note) => (
                  <div
                    key={note.id}
                    className="flex items-center gap-2 bg-white rounded-lg border hover:border-blue-400 transition"
                  >
                    <a
                      href={`/notes/${note.id}/edit`}
                      className="flex-1 p-4"
                      onClick={(e) => {
                        e.preventDefault();
                        navigate(`/notes/${note.id}/edit`);
                      }}
                    >
                      <div className="flex items-center justify-between">
                        <h3 className="font-medium">{note.title}</h3>
                        <span
                          className={`text-xs px-2 py-0.5 rounded ${note.isPublic ? "bg-green-100 text-green-700" : "bg-gray-100 text-gray-600"}`}
                        >
                          {note.isPublic ? "公開" : "非公開"}
                        </span>
                      </div>
                      <div className="text-sm text-gray-500 mt-1">
                        {new Date(note.updatedAt).toLocaleDateString("ja-JP")}
                      </div>
                    </a>
                    <button
                      onClick={() => deleteNote(note.id)}
                      className="p-2 mr-3 text-gray-400 hover:text-red-500 transition"
                      title="削除"
                    >
                      <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg>
                    </button>
                  </div>
                ))}
              </div>
            )}
          </section>

          <section className="mb-8">
            <h2 className="text-lg font-semibold mb-4">API トークン</h2>
            <p className="text-sm text-gray-500 mb-3">
              デスクトップアプリ (Electron) からノートにアクセスするためのトークンです。
            </p>

            {newToken && (
              <div className="mb-4 p-3 bg-yellow-50 border border-yellow-300 rounded-lg">
                <p className="text-sm font-semibold text-yellow-800 mb-1">
                  トークンが作成されました（この画面を閉じると二度と表示されません）
                </p>
                <code className="block text-xs bg-white p-2 rounded border select-all break-all">
                  {newToken}
                </code>
              </div>
            )}

            <div className="grid gap-2 mb-3">
              {tokens.map((t) => (
                <div
                  key={t.id}
                  className="flex items-center justify-between p-3 bg-white rounded-lg border"
                >
                  <div>
                    <span className="text-sm font-medium">{t.name}</span>
                    <span className="text-xs text-gray-400 ml-2">
                      {new Date(t.createdAt).toLocaleDateString("ja-JP")}
                    </span>
                  </div>
                  <button
                    onClick={() => deleteToken(t.id)}
                    className="text-xs text-red-500 hover:text-red-700"
                  >
                    削除
                  </button>
                </div>
              ))}
            </div>

            <button
              onClick={createToken}
              className="px-4 py-2 text-sm border rounded-lg hover:bg-gray-100 transition"
            >
              + トークンを発行
            </button>
          </section>
        </>
      )}
    </div>
  );
}
