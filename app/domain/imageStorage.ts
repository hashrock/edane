/**
 * Domain layer: per-user image storage quota.
 * No framework or rendering dependencies.
 */

/** Per-user image storage quota, in bytes. */
export const IMAGE_STORAGE_LIMIT_BYTES = 10 * 1024 * 1024; // 10MB

/**
 * Sum of stored image sizes ("used" bytes for the quota). Pulled out as the
 * single place that computes it so the two server.ts call sites (listing
 * usage, checking a new upload) can't drift into different definitions of
 * "used".
 */
export function totalImageBytes(sizes: number[]): number {
  return sizes.reduce((sum, size) => sum + size, 0);
}

/**
 * Whether adding `incomingSize` bytes to `used` would exceed
 * {@link IMAGE_STORAGE_LIMIT_BYTES}. Single source of truth for the quota
 * comparison, matching {@link totalImageBytes}.
 */
export function exceedsImageQuota(used: number, incomingSize: number): boolean {
  return used + incomingSize > IMAGE_STORAGE_LIMIT_BYTES;
}
