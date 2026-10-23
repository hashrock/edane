/**
 * Application layer: publishing a whole note as a web page (`/w/:id`).
 *
 * Same policy as node publications (nodePublication.ts), for the note as a
 * whole: a random, revocable id; the page is always rendered from the LIVE
 * note (no snapshot — a saved edit shows up on the next load); only public
 * notes serve, and a note that was made private or trashed since stays dark
 * until its owner publishes again (`canServePublication`'s epoch check).
 * Unpublishing deletes the row; publishing again mints a new URL.
 *
 * Depends on lib/url only.
 */
import { absoluteUrl } from "../lib/url";

/** Path of a published web page. */
export function webPagePath(id: string): string {
  return `/w/${encodeURIComponent(id)}`;
}

/** Absolute URL of a published web page. */
export function webPageUrl(origin: string, id: string): string {
  return absoluteUrl(origin, webPagePath(id));
}

/** What the editor's publish section shows (`GET /api/notes/:id/webpage`). */
export interface WebPagePublicationStatus {
  id: string;
  /** False when the note went private / to the trash since publishing. */
  active: boolean;
}

/** The serve path's Content-Security-Policy: our own script, Google Fonts, images from anywhere https. */
export const WEB_PAGE_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src https://fonts.gstatic.com",
  "img-src 'self' https: data:",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'self'",
].join("; ");
