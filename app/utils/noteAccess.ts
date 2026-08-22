/**
 * Who gets to see a note, for the two pages that ask the question:
 * `/notes/:id/edit` (edit) and `/notes/:id` (read-only view). Both routes
 * share the same underlying facts — is there a live (non-trashed) note, is
 * it public, does the viewer own it — so the policy lives here once rather
 * than as two ad hoc `if` chains sitting inline in app/server.ts.
 *
 * The decisions are pure (no DB, no crypto), which makes the visibility
 * policy testable without D1. The note/viewer are carried through the
 * `render` case so the caller gets them already narrowed.
 */

type NoteAccessFields = {
  userId: string | null;
  isPublic: boolean;
  deletedAt: string | null;
};

/**
 * The rule is not just "owner or 404": a visitor who follows a shared
 * `/notes/:id/edit` URL should land on the readable `/notes/:id` view when
 * the note is public, rather than hitting a dead end. Private notes still
 * answer 404 for signed-in non-owners so the response doesn't reveal that
 * the id exists, and a logged-out visitor goes to the landing page to sign
 * in (they may be the owner with a stale session).
 */
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

/**
 * The view page has no redirect cases (there's nowhere "more open" to send
 * a viewer): a live note renders for its owner or for anyone when it's
 * public, and everything else — missing, trashed, or private-and-not-owner
 * — is 404, matching the edit page's "don't reveal the id exists" rule.
 * The viewer is carried through `render` too, but may be `null` (a public
 * note renders for a logged-out visitor).
 */
export type ViewPageAccess<TNote, TViewer> =
  | { kind: "render"; note: TNote; viewer: TViewer | null }
  | { kind: "not-found" };

export function resolveViewPageAccess<
  TNote extends NoteAccessFields,
  TViewer extends { id: string },
>(params: {
  note: TNote | undefined;
  viewer: TViewer | null;
}): ViewPageAccess<TNote, TViewer> {
  const { note, viewer } = params;

  if (!note || note.deletedAt) return { kind: "not-found" };
  if (note.isPublic) return { kind: "render", note, viewer };
  if (viewer && note.userId === viewer.id) return { kind: "render", note, viewer };
  return { kind: "not-found" };
}
