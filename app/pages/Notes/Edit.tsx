import { Head } from "@inertiajs/react";
import MindmapEditor from "../../components/MindmapEditor";

type Note = {
  id: string;
  title: string;
  content: string;
  isPublic: boolean;
};

export default function NotesEdit({ note }: { note: Note }) {
  return (
    <div className="h-screen flex flex-col bg-slate-50 text-slate-950">
      <Head title={note.title} />
      <MindmapEditor
        noteId={note.id}
        initialContent={note.content}
        initialTitle={note.title}
        initialIsPublic={note.isPublic}
      />
    </div>
  );
}
