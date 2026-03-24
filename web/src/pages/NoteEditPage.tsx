import { useState, useEffect } from "react";
import { useParams, Link } from "react-router-dom";
import { api } from "../lib/api";
import MindmapEditor from "../components/MindmapEditor";
import { isElectron } from "../hooks/useElectron";

type Note = {
  id: string;
  title: string;
  content: string;
  isPublic: boolean;
};

export default function NoteEditPage() {
  const { id } = useParams<{ id: string }>();
  const [note, setNote] = useState<Note | null>(null);
  const [error, setError] = useState(false);
  const electron = isElectron();

  useEffect(() => {
    if (!id) return;
    api<Note>(`/api/notes/${id}`)
      .then(setNote)
      .catch(() => setError(true));
  }, [id]);

  if (error) {
    return (
      <div className="max-w-4xl mx-auto px-4 py-8">
        <p>ノートが見つかりません。</p>
        <Link to="/notes" className="text-blue-600 underline">一覧に戻る</Link>
      </div>
    );
  }

  if (!note) return null;

  return (
    <div className={`h-screen flex flex-col ${electron ? "electron-transparent" : ""}`}>
      {!electron && (
        <header className="flex items-center gap-4 px-4 py-2 border-b bg-white">
          <Link to="/notes" className="text-blue-600 hover:underline text-sm">
            &larr; 一覧
          </Link>
          <span className="font-semibold">{note.title}</span>
          <span
            className={`text-xs px-2 py-0.5 rounded ${note.isPublic ? "bg-green-100 text-green-700" : "bg-gray-100 text-gray-600"}`}
          >
            {note.isPublic ? "公開" : "非公開"}
          </span>
        </header>
      )}
      <div className="flex-1 overflow-hidden" data-electron-interactive>
        <MindmapEditor
          noteId={note.id}
          initialContent={note.content}
          initialTitle={note.title}
          initialIsPublic={note.isPublic}
        />
      </div>
    </div>
  );
}
