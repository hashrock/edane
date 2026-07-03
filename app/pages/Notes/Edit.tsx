import { Head } from "@inertiajs/react";
import NoteEditor from "../../components/NoteEditor";

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
      <NoteEditor
        noteId={note.id}
        initialContent={note.content}
        initialTitle={note.title}
        initialIsPublic={note.isPublic}
      />
    </div>
  );
}
