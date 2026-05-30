import { Head, Link } from "@inertiajs/react";
import MindmapViewer from "../../components/MindmapViewer";

type Note = {
  id: string;
  title: string;
  content: string;
  isPublic: boolean;
};

export default function NotesShow({ note }: { note: Note }) {
  return (
    <div className="h-screen flex flex-col">
      <Head title={note.title} />
      <header className="flex items-center gap-2 md:gap-4 px-3 md:px-4 py-2 border-b bg-white">
        <Link href="/notes" className="text-blue-600 hover:underline text-sm">
          &larr; 一覧
        </Link>
        <h1 className="font-semibold text-sm md:text-base truncate">
          {note.title}
        </h1>
      </header>
      <div className="flex-1">
        <MindmapViewer initialContent={note.content} title={note.title} />
      </div>
    </div>
  );
}
