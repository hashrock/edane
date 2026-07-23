/**
 * Note content is stored encrypted-at-rest unless the note is public. A PATCH
 * to a note can change its content, its publicity, or both at once, so the
 * server must decide — per request — whether to store the incoming content
 * as-is, encrypt it, or decrypt the existing stored content because the note
 * just flipped public. That decision is pure (no crypto, no DB); pulled out
 * of app/server.ts so it's testable without an encryption key or D1, and so
 * the publicity/encryption policy isn't buried inside HTTP handler code.
 */

export type NoteContentAction =
  | { kind: "unchanged" }
  | { kind: "store-plain"; content: string }
  | { kind: "encrypt"; content: string }
  | { kind: "decrypt-if-encrypted"; content: string };

export function resolveNoteContentAction(params: {
  currentIsPublic: boolean;
  currentContent: string;
  requestedIsPublic: boolean | undefined;
  requestedContent: string | undefined;
}): NoteContentAction {
  const { currentIsPublic, currentContent, requestedIsPublic, requestedContent } = params;

  if (requestedContent !== undefined) {
    const nextIsPublic = requestedIsPublic ?? currentIsPublic;
    return nextIsPublic
      ? { kind: "store-plain", content: requestedContent }
      : { kind: "encrypt", content: requestedContent };
  }
  // public -> private with no new content: re-encrypt what's already stored.
  if (requestedIsPublic === false && currentIsPublic) {
    return { kind: "encrypt", content: currentContent };
  }
  // private -> public with no new content: decrypt what's already stored.
  if (requestedIsPublic === true && !currentIsPublic) {
    return { kind: "decrypt-if-encrypted", content: currentContent };
  }
  return { kind: "unchanged" };
}
