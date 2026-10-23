/**
 * Application layer: what the data export (GET /api/export, Settings →
 * データのエクスポート) puts in its ZIP.
 *
 * - `notes.json`: every note (trash included) with its metadata and its
 *   document in the v2 content shape (`{ version, roots }`, as
 *   serializeDocument writes it) — the complete data.
 * - `notes/<title>.md` and `trash/<title>.md`: each note as Markdown, to read
 *   without edane. Node types beyond what Markdown carries are flattened
 *   (documentToMarkdown), which is why the JSON is there too.
 *
 * Uploaded images are not included; their URLs stay in the content. A note
 * whose content can't be decrypted is still listed in the JSON (document null,
 * `error`), so nothing goes missing silently.
 */
import type { MindMapDocument } from "../domain/model";
import type { ZipEntry } from "../lib/zip";
import { documentToMarkdown } from "./markdown";
import { serializeDocument } from "./persistence";

export interface ExportNote {
  id: string;
  title: string;
  isPublic: boolean;
  pinned: boolean;
  createdAt: string;
  updatedAt: string;
  /** In the trash since (ISO), or null. */
  deletedAt: string | null;
  /** null = the stored content couldn't be decrypted. */
  document: MindMapDocument | null;
}

/** `notes.json`'s format marker, bumped if its shape ever changes. */
const EXPORT_FORMAT = "edane-export";
const EXPORT_FORMAT_VERSION = 1;

/** The download's file name for an export made at `at`. */
export function exportArchiveName(at: Date): string {
  return `edane-export-${at.toISOString().slice(0, 10)}.zip`;
}

// Characters no common file system accepts in a name, plus controls.
// eslint-disable-next-line no-control-regex
const UNSAFE_FILE_CHARS = /[\\/:*?"<>|\u0000-\u001f\u007f]/g;
const MAX_FILE_STEM = 80;

/**
 * A file name stem for `title` that is safe on Windows / macOS / Linux and not
 * yet in `taken` (a numbered suffix otherwise; compared case-insensitively, as
 * macOS and Windows do). Adds the result to `taken`.
 */
export function uniqueFileStem(title: string, taken: Set<string>): string {
  const cleaned = Array.from(title.replace(UNSAFE_FILE_CHARS, "_").trim())
    .slice(0, MAX_FILE_STEM)
    .join("")
    // Trailing dots and spaces are dropped by Windows; a leading dot hides the file.
    .replace(/^\.+/, "")
    .replace(/[. ]+$/, "");
  const base = cleaned || "Untitled";
  let stem = base;
  for (let n = 2; taken.has(stem.toLowerCase()); n++) stem = `${base} (${n})`;
  taken.add(stem.toLowerCase());
  return stem;
}

/** The archive's entries: notes.json first, then one Markdown file per readable note. */
export function buildExportEntries(notes: ExportNote[], exportedAt: Date): ZipEntry[] {
  const json = {
    format: EXPORT_FORMAT,
    version: EXPORT_FORMAT_VERSION,
    exportedAt: exportedAt.toISOString(),
    notes: notes.map(({ document, ...meta }) => ({
      ...meta,
      ...(document ? { content: JSON.parse(serializeDocument(document)) } : { content: null, error: "decrypt-failed" }),
    })),
  };
  const entries: ZipEntry[] = [{ name: "notes.json", data: `${JSON.stringify(json, null, 2)}\n` }];
  const taken = { notes: new Set<string>(), trash: new Set<string>() };
  for (const note of notes) {
    if (!note.document) continue;
    const folder = note.deletedAt ? "trash" : "notes";
    const stem = uniqueFileStem(note.title, taken[folder]);
    entries.push({ name: `${folder}/${stem}.md`, data: `${documentToMarkdown(note.document)}\n` });
  }
  return entries;
}
