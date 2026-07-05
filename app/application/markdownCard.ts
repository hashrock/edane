/**
 * Pure helpers for a markdown node's COMPACT canvas card (title + line count).
 *
 * Kept dependency-free (no marked/DOMPurify) so it's safe on the measurement
 * hot path and in Node tests; the full HTML render lives in lib/markdownHtml.ts,
 * loaded only by the client-only preview panel.
 */

/** Max characters shown in a card title before an ellipsis. */
export const MD_TITLE_MAX = 40;

/**
 * Derive a short card title: the first heading, else the first non-empty line,
 * with leading markers/inline decorations stripped and clipped so the canvas
 * card measurement and draw agree.
 */
export function markdownTitle(src: string, maxLen = MD_TITLE_MAX): string {
  let title = "無題のMarkdown";
  for (const raw of src.split("\n")) {
    const line = raw.trim();
    if (line === "") continue;
    const heading = line.match(/^#{1,6}\s+(.*)$/);
    const text = (heading ? heading[1] : line)
      .replace(/^[-*+]\s+/, "")
      .replace(/^\d+[.)]\s+/, "")
      .replace(/^>\s?/, "")
      .replace(/[*_`#]/g, "")
      .trim();
    if (text !== "") {
      title = text;
      break;
    }
  }
  return title.length > maxLen ? title.slice(0, maxLen) + "…" : title;
}

/** Non-blank line count — shown as a small badge on the card. */
export function markdownLineCount(src: string): number {
  return src.split("\n").filter((l) => l.trim() !== "").length;
}
