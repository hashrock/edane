/**
 * Human-readable byte size, e.g. `1536` → `"1.5 KB"`.
 *
 * The unit is chosen from the ROUNDED value, so a size just under a unit
 * boundary rolls over (`1048575` → `"1.00 MB"`) instead of printing `"1024.0 KB"`.
 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = (bytes / 1024).toFixed(1);
  if (Number(kb) < 1024) return `${kb} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}
