import { Head } from "@inertiajs/react";
import NoteEditor from "../../components/NoteEditor";

type Note = {
  id: string;
  title: string;
  content: string;
  isPublic: boolean;
};

// 公開ノートの閲覧ページ。編集ページと同じレスポンシブエディタ
// （canvas / outline）を閲覧専用モードで使う。
export default function NotesShow({ note }: { note: Note }) {
  return (
    <div className="h-screen flex flex-col bg-slate-50 text-slate-950">
      <Head title={note.title} />
      <NoteEditor
        initialContent={note.content}
        initialTitle={note.title}
        readOnly
      />
    </div>
  );
}
