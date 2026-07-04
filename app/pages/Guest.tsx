import { Head } from "@inertiajs/react";
import NoteEditor from "../components/NoteEditor";
import { stashPendingNote, type PendingNote } from "../lib/guestNote";
import type { SessionUser } from "../user";

export default function Guest({
  user,
  embed,
}: {
  user: SessionUser | null;
  embed?: boolean;
}) {
  // Stash the current document, then break out of the iframe (window.top ===
  // self when not embedded) and send the visitor to login. After Google auth
  // they land on /notes, which imports the stashed note into a real one. When
  // already signed in, skip straight to /notes.
  const saveToAccount = (note: PendingNote) => {
    stashPendingNote(note);
    const dest = user ? "/notes" : "/auth/google";
    (window.top ?? window).location.href = dest;
  };

  return (
    <div className="h-screen flex flex-col bg-slate-50 text-slate-950">
      <Head title="ゲストエディタ" />
      <NoteEditor embed={embed} onSaveToAccount={saveToAccount} />
    </div>
  );
}
