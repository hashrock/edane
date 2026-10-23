import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { modelArb } from "../domain/model.arb";
import { buildExportEntries, exportArchiveName, uniqueFileStem, type ExportNote } from "./dataExport";
import { parseContent, serializeDocument } from "./persistence";

const noteArb: fc.Arbitrary<ExportNote> = fc.record({
  id: fc.uuid(),
  title: fc.string({ maxLength: 120 }),
  isPublic: fc.boolean(),
  pinned: fc.boolean(),
  createdAt: fc.constant("2026-01-01T00:00:00.000Z"),
  updatedAt: fc.constant("2026-01-02T00:00:00.000Z"),
  deletedAt: fc.option(fc.constant("2026-01-03T00:00:00.000Z")),
  document: fc.option(modelArb, { freq: 5 }),
});

describe("uniqueFileStem", () => {
  it("is safe on every common file system and never repeats (case-insensitively)", () => {
    fc.assert(
      fc.property(fc.array(fc.string({ maxLength: 120 })), (titles) => {
        const taken = new Set<string>();
        const stems = titles.map((t) => uniqueFileStem(t, taken));
        for (const s of stems) {
          expect(s).not.toMatch(/[\\/:*?"<>|\u0000-\u001f\u007f]/);
          expect(s).not.toMatch(/^\.|[. ]$/);
          expect(s.length).toBeGreaterThan(0);
        }
        expect(new Set(stems.map((s) => s.toLowerCase())).size).toBe(stems.length);
      })
    );
  });

  it("keeps a plain title as is", () => {
    expect(uniqueFileStem("議事録 2026/10", new Set())).toBe("議事録 2026_10");
    const taken = new Set<string>();
    expect([uniqueFileStem("A", taken), uniqueFileStem("a", taken), uniqueFileStem("", taken)]).toEqual(["A", "a (2)", "Untitled"]);
  });
});

describe("buildExportEntries", () => {
  it("lists every note in notes.json, its document round-tripping, and one Markdown file per readable note", () => {
    fc.assert(
      fc.property(fc.array(noteArb, { maxLength: 6 }), (notes) => {
        const entries = buildExportEntries(notes, new Date("2026-10-23T00:00:00Z"));
        const [json, ...md] = entries;
        expect(json.name).toBe("notes.json");
        const parsed = JSON.parse(json.data as string);
        expect(parsed.notes.map((n: { id: string }) => n.id)).toEqual(notes.map((n) => n.id));
        parsed.notes.forEach((n: { content: unknown }, i: number) => {
          const doc = notes[i].document;
          // Same as reading back what the note itself stores (key order aside).
          if (doc) expect(parseContent(JSON.stringify(n.content), doc.title)).toEqual(parseContent(serializeDocument(doc), doc.title));
          else expect(n.content).toBeNull();
        });
        const readable = notes.filter((n) => n.document);
        expect(md).toHaveLength(readable.length);
        md.forEach((e, i) => expect(e.name.startsWith(readable[i].deletedAt ? "trash/" : "notes/")).toBe(true));
        expect(new Set(entries.map((e) => e.name)).size).toBe(entries.length);
      })
    );
  });
});

it("names the archive by date", () => {
  expect(exportArchiveName(new Date("2026-10-23T12:00:00Z"))).toBe("edane-export-2026-10-23.zip");
});
