import type { DrizzleD1Database } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { notes } from "../db/schema";

type Note = typeof notes.$inferSelect;

/**
 * Fetch a note by id and return it only if `userId` owns it — otherwise
 * `null`, which the caller treats identically to "not found". Several
 * `/notes/:id/*` routes (trash, restore, permanent delete, pin) repeated this
 * fetch-then-check as an inline block; this is the one place that judgement
 * is made.
 */
export async function loadOwnedNote(
  db: DrizzleD1Database,
  id: string,
  userId: string
): Promise<Note | null> {
  const note = await db.select().from(notes).where(eq(notes.id, id)).get();
  return note && note.userId === userId ? note : null;
}
