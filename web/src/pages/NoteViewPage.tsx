import { useState, useEffect } from "react";
import { useParams, Link } from "react-router-dom";
import { api } from "../lib/api";
import MindmapViewer from "../components/MindmapViewer";
import { isElectron } from "../hooks/useElectron";

type Note = {
  id: string;
  title: string;
  content: string;
  isPublic: boolean;
};

export default function NoteViewPage() {
  const { id } = useParams<{ id: string }>();
  const [note, setNote] = useState<Note | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    api<Note>(`/api/notes/${id}`)
      .then(setNote)
      .catch(() => setError("ノートが見つかりません。"));
  }, [id]);

  if (error) {
    return (
      <div className="max-w-4xl mx-auto px-4 py-8">
        <p>{error}</p>
        <Link to="/notes" className="text-blue-600 underline">一覧に戻る</Link>
      </div>
    );
  }

  const electron = isElectron();

  if (!note) return null;

  return (
    <div className={`h-screen flex flex-col ${electron ? "electron-transparent" : ""}`}>
      <header
        className="flex items-center gap-2 md:gap-4 px-3 md:px-4 py-2 border-b bg-white"
        data-electron-interactive
      >
        <Link to="/notes" className="text-blue-600 hover:underline text-sm">
          &larr; 一覧
        </Link>
        <h1 className="font-semibold text-sm md:text-base truncate">{note.title}</h1>
      </header>
      <div className="flex-1" data-electron-interactive>
        <MindmapViewer initialContent={note.content} title={note.title} />
      </div>
    </div>
  );
}
