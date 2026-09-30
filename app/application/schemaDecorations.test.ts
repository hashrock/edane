import { describe, it, expect } from "vitest";
import { schemaDecorations } from "./schemaDecorations";
import type { MindMapModel } from "../domain/model";

const n = (id: string, text: string, children: MindMapModel[] = [], extra: Partial<MindMapModel> = {}): MindMapModel => ({
  id,
  text,
  children,
  ...extra,
});

describe("schemaDecorations", () => {
  it("labels fields, flags mismatches (items included) and tags the collection", () => {
    const deco = schemaDecorations({
      title: "",
      roots: [
        n("c", "Books", [n("r", "A", [n("f0", "Alice"), n("f1", "not a url"), n("f2", "", [n("i1", "x")])])], {
          schema: "author, cover:image, links[]:link",
        }),
      ],
    });
    expect(deco.get("c")).toEqual({ collection: true });
    expect(deco.get("r")).toBeUndefined();
    expect(deco.get("f0")).toEqual({ label: "author" });
    expect(deco.get("f1")).toEqual({ label: "cover", issue: "image" });
    expect(deco.get("f2")).toEqual({ label: "links[]" });
    expect(deco.get("i1")).toEqual({ issue: "link" });
  });
});
