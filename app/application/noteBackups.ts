/**
 * Application layer: the automatic per-note backup policy (版履歴).
 *
 * NoteRoom (sync/room.ts) snapshots a note as it was *before* a commit, so the
 * first edit after a pause keeps what was there until then. It does so at most
 * once per {@link BACKUP_INTERVAL_MS} per note, keeps the newest
 * {@link MAX_BACKUPS_PER_NOTE}, and always backs up right before a restore, so
 * restoring is itself undoable. The rules live here (pure) so room.ts only
 * applies them.
 */

/** At most one automatic backup per note per hour of editing. */
export const BACKUP_INTERVAL_MS = 60 * 60 * 1000;

/** Backups kept per note (the oldest beyond this are pruned on the next backup). */
export const MAX_BACKUPS_PER_NOTE = 50;

/** What a commit is: an ordinary edit, or a restore from the history. */
export type BackupCause = "edit" | "restore";

/**
 * Whether a commit now should first back the note up. `lastBackupAt` is the
 * newest backup's time (epoch ms), or null when the note has none. A restore
 * always does (so it can be undone). A clock that went backwards counts as
 * due rather than blocking backups until it catches up.
 */
export function isBackupDue(lastBackupAt: number | null, now: number, cause: BackupCause = "edit"): boolean {
  if (cause === "restore" || lastBackupAt === null) return true;
  const elapsed = now - lastBackupAt;
  return elapsed < 0 || elapsed >= BACKUP_INTERVAL_MS;
}

/** One row of GET /api/notes/:id/backups (the history page's list). */
export interface NoteBackupSummary {
  id: string;
  title: string;
  /** The note's version the snapshot was of. */
  version: number;
  createdAt: string;
}
