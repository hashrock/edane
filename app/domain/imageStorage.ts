/**
 * Domain layer: per-user image storage quota.
 * No framework or rendering dependencies.
 */

/** Per-user image storage quota, in bytes. */
export const IMAGE_STORAGE_LIMIT_BYTES = 10 * 1024 * 1024; // 10MB

/** One image's size cap (the upload route's body limit leaves room for the multipart envelope). */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/**
 * Sum of stored image sizes ("used" bytes for the quota), as the settings page
 * shows it. The upload's own check is inside its INSERT
 * (utils/imageRepository.ts) so it holds under parallel uploads.
 */
export function totalImageBytes(sizes: number[]): number {
  return sizes.reduce((sum, size) => sum + size, 0);
}


/**
 * Image types an upload may be stored as. Raster only: an SVG (or HTML, or
 * anything a browser runs scripts in) served from our origin would be stored
 * XSS, so it is refused rather than trusted to the serving headers alone.
 */
export const ALLOWED_IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif"] as const;
export type AllowedImageType = (typeof ALLOWED_IMAGE_TYPES)[number];

const startsWith = (bytes: Uint8Array, offset: number, sig: readonly number[]) =>
  sig.every((b, i) => bytes[offset + i] === b);
const ascii = (s: string) => [...s].map((ch) => ch.charCodeAt(0));

/**
 * The image type `bytes` actually is, from its magic number, or null when it
 * is none of {@link ALLOWED_IMAGE_TYPES}. The client-declared Content-Type is
 * never trusted: it is whatever the uploader typed into the multipart part.
 */
export function sniffImageType(bytes: Uint8Array): AllowedImageType | null {
  if (startsWith(bytes, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (startsWith(bytes, 0, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWith(bytes, 0, ascii("GIF87a")) || startsWith(bytes, 0, ascii("GIF89a"))) return "image/gif";
  if (startsWith(bytes, 0, ascii("RIFF")) && startsWith(bytes, 8, ascii("WEBP"))) return "image/webp";
  if (startsWith(bytes, 4, ascii("ftyp")) && (startsWith(bytes, 8, ascii("avif")) || startsWith(bytes, 8, ascii("avis")))) {
    return "image/avif";
  }
  return null;
}

/**
 * Headers for serving a stored image. Images are served from our own origin
 * without auth (they appear in public notes), so opening one as a top-level
 * document must never run script: nosniff stops content sniffing, and the
 * sandbox CSP gives the document an opaque origin with scripts disabled.
 * Rows from before {@link sniffImageType} may hold other client-declared
 * types: those are also sent as attachments so navigating to one downloads it
 * instead of rendering a page. A legacy SVG keeps its type so existing
 * `<img>` tags still show it (an `<img>` never runs SVG script); anything
 * else becomes octet-stream.
 */
export function imageResponseHeaders(contentType: string): Record<string, string> {
  const allowed = (ALLOWED_IMAGE_TYPES as readonly string[]).includes(contentType);
  const legacySvg = contentType === "image/svg+xml";
  return {
    "Content-Type": allowed || legacySvg ? contentType : "application/octet-stream",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox",
    ...(allowed ? {} : { "Content-Disposition": "attachment" }),
    // A day, not a year: once deleted, an image shouldn't linger in caches for long.
    "Cache-Control": "public, max-age=86400",
  };
}
