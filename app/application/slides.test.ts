import { describe, it, expect } from "vitest";
import type { MindMapDocument, MindMapModel } from "../domain/model";
import { buildSlides, slideIndexOf, SLIDE_MAX_ITEMS } from "./slides";

function n(id: string, text: string, children: MindMapModel[] = [], extra: Partial<MindMapModel> = {}): MindMapModel {
  return { id, text, children, ...extra };
}

function doc(...roots: MindMapModel[]): MindMapDocument {
  return { title: "T", roots };
}

const summary = (d: MindMapDocument) =>
  buildSlides(d).map((s) => `${s.kind}:${s.heading.text}[${s.items.map((i) => "-".repeat(i.depth) + i.node.text).join(",")}]`);

describe("buildSlides", () => {
  it("opens each root with a title slide and gives each small branch one slide of nested bullets", () => {
    const d = doc(
      n("r", "Talk", [n("a", "Why", [n("a1", "fast", [n("a1x", "keyboard")])]), n("b", "How")]),
      n("r2", "Appendix")
    );
    expect(summary(d)).toEqual([
      "title:Talk[]",
      "content:Why[fast,-keyboard]",
      "content:How[]",
      "title:Appendix[]",
    ]);
  });

  it("splits a branch too big for one slide into a section slide and one slide per child", () => {
    const many = Array.from({ length: SLIDE_MAX_ITEMS }, (_, i) => n(`x${i}`, `x${i}`));
    const d = doc(n("r", "R", [n("big", "Big", [n("p", "P", many.slice(0, 6)), n("q", "Q", many.slice(6))])]));
    const slides = buildSlides(d);
    expect(slides.map((s) => `${s.kind}:${s.heading.text}`)).toEqual([
      "title:R",
      "section:Big",
      "content:P",
      "content:Q",
    ]);
    expect(slides[1].items.map((i) => i.node.text)).toEqual(["P", "Q"]);
    expect(slides[2].trail).toEqual(["R", "Big"]);
  });

  it("skips blank text leaves but keeps blank nodes that carry content", () => {
    const d = doc(n("r", "R", [n("a", "A", [n("e", " "), n("img", "", [], { type: "image" })]), n("e2", "")]), n("e3", ""));
    expect(summary(d)).toEqual(["title:R[]", "content:A[]"]);
    expect(buildSlides(d)[1].items.map((i) => i.node.id)).toEqual(["img"]);
  });

  it("uses a link's fetched title in the trail", () => {
    const many = Array.from({ length: SLIDE_MAX_ITEMS + 1 }, (_, i) => n(`x${i}`, "x"));
    const d = doc(n("r", "https://e.x", [n("a", "A", [n("b", "B", many)])], { type: "link", linkTitle: "Example" }));
    expect(buildSlides(d)[2].trail).toEqual(["Example", "A"]);
  });
});

describe("slideIndexOf", () => {
  const d = doc(n("r", "R", [n("a", "A", [n("a1", "a1")]), n("blank", "")]));
  const slides = buildSlides(d);

  it("finds the slide presenting the node", () => {
    expect(slideIndexOf(slides, d, "a1")).toBe(1);
    expect(slideIndexOf(slides, d, "r")).toBe(0);
  });

  it("falls back to the nearest presented ancestor, then to the first slide", () => {
    expect(slideIndexOf(slides, d, "blank")).toBe(0);
    expect(slideIndexOf(slides, d, "missing")).toBe(0);
  });
});
