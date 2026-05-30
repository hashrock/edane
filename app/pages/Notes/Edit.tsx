import { Head, Link } from "@inertiajs/react";
import MindmapEditor from "../../components/MindmapEditor";

type Note = {
  id: string;
  title: string;
  content: string;
  isPublic: boolean;
};

export default function NotesEdit({ note }: { note: Note }) {
  return (
    <div className="h-screen flex flex-col">
      <Head title={note.title} />
      <header className="flex items-center gap-4 px-4 py-2 border-b bg-white">
        <Link href="/notes" className="text-blue-600 hover:underline text-sm">
          &larr; 一覧
        </Link>
        <span className="font-semibold">{note.title}</span>
        <span
          className={`text-xs px-2 py-0.5 rounded ${note.isPublic ? "bg-green-100 text-green-700" : "bg-gray-100 text-gray-600"}`}
        >
          {note.isPublic ? "公開" : "非公開"}
        </span>
      </header>
      <div className="flex-1 overflow-hidden">
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
