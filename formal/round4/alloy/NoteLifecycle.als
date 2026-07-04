/*
 * Alloy model of a note's lifecycle: list ⇄ trash, pin, and permanent delete.
 *
 * Sources being formalized
 * ------------------------
 * DB (app/db/schema.ts notes):
 *   - pinned      integer(boolean)  — pinned notes sort to the top of the list
 *   - deletedAt   text (nullable)   — non-null ⇒ the note is in the trash
 *
 * server.ts routes:
 *   - GET  /notes            : WHERE userId = me AND deleted_at IS NULL   (list)
 *   - GET  /trash            : WHERE userId = me AND deleted_at IS NOT NULL(trash)
 *   - POST /notes/:id/trash  : set deleted_at = now            (list → trash)
 *   - POST /notes/:id/restore: set deleted_at = null           (trash → list)
 *   - DELETE /notes/:id      : db.delete(...)                  (purge from trash)
 *   - POST /notes/:id/pin    : set pinned = !pinned
 *   - GET /notes/:id(/edit)  : notFound when deleted_at is set (guards)
 *
 * We model a world State (which notes exist, which are trashed, which pinned),
 * derive the two views the way the queries do, and check that the operations
 * keep the model's core invariants.
 */

sig Note {}

sig State {
  notes   : set Note,   // notes that still exist (not permanently deleted)
  trashed : set Note,   // notes currently in the trash (deleted_at set)
  pinned  : set Note    // notes currently pinned
}

// The two views the app renders, defined exactly as the SQL WHERE clauses.
fun listView  [s : State] : set Note { s.notes - s.trashed }   // deleted_at IS NULL
fun trashView [s : State] : set Note { s.notes & s.trashed }   // deleted_at IS NOT NULL

// ---- Core invariant ---------------------------------------------------------
pred Inv[s : State] {
  s.trashed in s.notes                 // can't trash a note that doesn't exist
  s.pinned  in s.notes                 // can't pin a note that doesn't exist
  no (s.pinned & s.trashed)            // trashing unpins: pinned ⇒ not trashed
}

// A well-formed state also has the two views partition the existing notes.
pred Partition[s : State] {
  no (listView[s] & trashView[s])
  listView[s] + trashView[s] = s.notes
}

// ---- Operations (pre → post) ------------------------------------------------
// Move a listed note to the trash. Trashing also unpins it (matches: a trashed
// note can never be pinned, and the list is where pins matter).
pred trash[s, t : State, n : Note] {
  n in listView[s]
  t.notes   = s.notes
  t.trashed = s.trashed + n
  t.pinned  = s.pinned - n
}

// Bring a trashed note back to the list.
pred restore[s, t : State, n : Note] {
  n in trashView[s]
  t.notes   = s.notes
  t.trashed = s.trashed - n
  t.pinned  = s.pinned            // stays unpinned; user re-pins if desired
}

// Permanently delete a trashed note.
pred purge[s, t : State, n : Note] {
  n in trashView[s]
  t.notes   = s.notes - n
  t.trashed = s.trashed - n
  t.pinned  = s.pinned - n
}

// Toggle pin on a LISTED note (a trashed note has no menu to pin it).
pred pin[s, t : State, n : Note] {
  n in listView[s]
  t.notes   = s.notes
  t.trashed = s.trashed
  // toggle: remove n if already pinned, otherwise add it
  (n in s.pinned implies t.pinned = s.pinned - n
                 else    t.pinned = s.pinned + n)
}

// ---------------------------------------------------------------------------
// CHECK 1: every operation preserves the core invariant. UNSAT (no counter-
// example) means trash/restore/purge/pin can never produce a note that is both
// pinned and trashed, or that exists in neither/both views inconsistently.
// ---------------------------------------------------------------------------
check InvPreserved {
  all s, t : State, n : Note |
    (Inv[s] and (trash[s,t,n] or restore[s,t,n] or purge[s,t,n] or pin[s,t,n]))
      implies Inv[t]
} for 6

// CHECK 2: the invariant guarantees the two views always partition the notes,
// so the list query never shows a trashed note and vice-versa.
check ViewsPartition {
  all s : State | Inv[s] implies Partition[s]
} for 6

// CHECK 3: trash then restore round-trips — the note is listed again and the
// two states show the same notes (no note lost or duplicated by the detour).
check TrashRestoreRoundTrip {
  all s, s1, s2 : State, n : Note |
    (Inv[s] and trash[s,s1,n] and restore[s1,s2,n])
      implies (n in listView[s2] and s2.notes = s.notes)
} for 6

// CHECK 4: a purged note is gone from BOTH views and cannot be restored later.
check PurgeIsPermanent {
  all s, t : State, n : Note |
    (Inv[s] and purge[s,t,n])
      implies (n not in listView[t] and n not in trashView[t])
} for 6

// Sanity: the operations are actually satisfiable (not vacuously true).
run TrashThenRestore {
  some s, s1, s2 : State, n : Note |
    Inv[s] and trash[s,s1,n] and restore[s1,s2,n] and some listView[s]
} for 6
