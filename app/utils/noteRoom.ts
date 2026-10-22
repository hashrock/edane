import type { Env } from "../global.d";

/**
 * The note's coordinator (app/sync/room.ts). Every write to an existing note —
 * the editor's WebSocket, the legacy PUT, the remote MCP server — must reach
 * the same object, so the naming lives here once.
 */
export const noteRoom = (env: Env["Bindings"], noteId: string) =>
  env.NOTE_ROOMS.get(env.NOTE_ROOMS.idFromName(noteId));
