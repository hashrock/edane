/**
 * Who gets to see the editor page for a note. The rule is not just
 * "owner or 404": a visitor who follows a shared `/notes/:id/edit` URL should
 * land on the readable `/notes/:id` view when the note is public, rather than
 * hitting a dead end. Private notes still answer 404 for signed-in non-owners
 * so the response doesn't reveal that the id exists, and a logged-out visitor
 * goes to the landing page to sign in (they may be the owner with a stale
 * session).
 *
 * The decision is pure (no DB, no crypto); pulled out of app/server.ts so the
 * visibility policy is testable without D1 and doesn't sit inline in the HTTP
 * handler. The note/viewer are carried through the `render` case so the caller
 * gets them already narrowed to non-null.
 */

type NoteAccessFields = {
  userId: string | null;
  isPublic: boolean;
  deletedAt: string | null;
};

export type EditPageAccess<TNote, TViewer> =
  | { kind: "render"; note: TNote; viewer: TViewer }
  | { kind: "redirect-to-view" }
  | { kind: "redirect-to-home" }
  | { kind: "not-found" };

export function resolveEditPageAccess<
  TNote extends NoteAccessFields,
  TViewer extends { id: string },
>(params: {
  note: TNote | undefined;
  viewer: TViewer | null;
}): EditPageAccess<TNote, TViewer> {
  const { note, viewer } = params;

  if (!note || note.deletedAt) return { kind: "not-found" };
  if (viewer && note.userId === viewer.id) return { kind: "render", note, viewer };
  if (note.isPublic) return { kind: "redirect-to-view" };
  if (!viewer) return { kind: "redirect-to-home" };
  return { kind: "not-found" };
}
