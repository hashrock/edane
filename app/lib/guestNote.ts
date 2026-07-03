/**
 * Guest → account save flow.
 *
 * A guest-mode document lives only in the browser (no note row exists yet).
 * To carry it across the Google-login redirect we stash the serialized note in
 * localStorage; once the visitor lands back on /notes as a signed-in user, that
 * page imports it into a real note. Both sides share this single module so the
 * storage key and shape stay in one place.
 */

export const PENDING_NOTE_KEY = "edane:pending-note";

export type PendingNote = {
  /** Root-node text (used as the note title). */
  title: string;
  /** Serialized MindMapModel (JSON), stored verbatim as the note content. */
  content: string;
};

/** Stash the in-progress guest note before sending the visitor through login. */
export function stashPendingNote(note: PendingNote): boolean {
  try {
    localStorage.setItem(PENDING_NOTE_KEY, JSON.stringify(note));
    return true;
  } catch {
    return false;
  }
}

/**
 * Read and remove the stashed guest note (consume-once, so a reload can't
 * re-import it). Returns null when nothing valid is stored.
 */
export function takePendingNote(): PendingNote | null {
  try {
    const raw = localStorage.getItem(PENDING_NOTE_KEY);
    if (!raw) return null;
    localStorage.removeItem(PENDING_NOTE_KEY);
    const parsed = JSON.parse(raw) as Partial<PendingNote> | null;
    if (!parsed || typeof parsed.content !== "string") return null;
    return {
      title: typeof parsed.title === "string" ? parsed.title : "Untitled",
      content: parsed.content,
    };
  } catch {
    return null;
  }
}
