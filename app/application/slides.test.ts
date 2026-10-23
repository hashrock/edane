import { describe, it, expect } from "vitest";
import type { MindMapDocument, MindMapModel } from "../domain/model";
import { branchSlideCount, buildSlides, slideIndexOf } from "./slides";

function n(id: string, text: string, children: MindMapModel[] = [], extra: Partial<MindMapModel> = {}): MindMapModel {
  return { id, text, children, ...extra };
}

function doc(...roots: MindMapModel[]): MindMapDocument {
  return { title: "T", roots };
}

/** `count` short leaves named `${prefix}0`… */
function leaves(prefix: string, count: number): MindMapModel[] {
  return Array.from({ length: count }, (_, i) => n(`${prefix}${i}`, `${prefix}${i}`));
}

const summary = (d: MindMapDocument) =>
  buildSlides(d).map(
    (s) =>
      `${s.kind}:${s.heading.text}${s.part ? ` (${s.part.index}/${s.part.count})` : ""}[${s.items
        .map((i) => "-".repeat(i.depth) + i.node.text)
        .join(",")}]`
  );

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

  it("continues a long plain list over balanced pages instead of a slide per item", () => {
    const d = doc(n("r", "R", [n("list", "Issues", leaves("x", 15))]));
    const slides = buildSlides(d);
    expect(slides.map((s) => `${s.kind}:${s.heading.text}:${s.part?.index}/${s.part?.count}`)).toEqual([
      "title:R:undefined/undefined",
      "content:Issues:1/2",
      "content:Issues:2/2",
    ]);
    expect(slides[1].items.length + slides[2].items.length).toBe(15);
    expect(Math.abs(slides[1].items.length - slides[2].items.length)).toBeLessThanOrEqual(1);
    expect(slides[1].size).toBe(slides[2].size);
  });

  it("measures text, not node count: seven long sentences don't fit where seven words do", () => {
    const long = "とても長い説明文で、スライドに載せると何行にも折り返されてしまうくらいの長さがある文章です。".repeat(2);
    const words = doc(n("r", "R", [n("a", "A", leaves("w", 7))]));
    const sentences = doc(n("r", "R", [n("a", "A", leaves("s", 7).map((c) => ({ ...c, text: long })))]));
    expect(buildSlides(words)).toHaveLength(2);
    expect(buildSlides(sentences).length).toBeGreaterThan(2);
  });

  it("reads a branch of mostly topics in outline order: agenda, then topics, a lone noted item heading its own slide", () => {
    const d = doc(
      n("r", "R", [
        n("ch", "Ch", [
          n("p", "P", leaves("p", 6)),
          n("note", "note", [n("why", "why")]),
          n("q", "Q", leaves("q", 6)),
          n("end", "end"),
        ]),
      ])
    );
    const slides = buildSlides(d);
    expect(summary(d)).toEqual([
      "title:R[]",
      "section:Ch[P,note,Q,end]",
      `content:P[${leaves("p", 6).map((c) => c.text).join(",")}]`,
      "content:note[why]",
      `content:Q[${leaves("q", 6).map((c) => c.text).join(",")}]`,
    ]);
    // A bare leaf is said in full on the agenda.
    expect(slides[1].ids).toEqual(["ch", "end"]);
    expect(slides[3].trail).toEqual(["Ch"]);
  });

  it("reads a branch of mostly small items as one list; a child that must break out keeps its place in the order", () => {
    const items = Array.from({ length: 6 }, (_, i) => n(`i${i}`, `item${i}`, [n(`i${i}n`, `note${i}`)]));
    const big = n("big", "Big", [n("b1", "b1", leaves("x", 3)), n("b2", "b2")], { slideSplit: true });
    const plain = buildSlides(doc(n("r", "R", [n("list", "Issues", items)])));
    expect(plain.map((s) => `${s.kind}:${s.heading.id}:${s.part?.index}`)).toEqual(["title:r:undefined", "content:list:1", "content:list:2"]);

    const d = doc(n("r", "R", [n("list", "Issues", [items[0], big, ...items.slice(1)])]));
    const slides = buildSlides(d);
    // A door, item0 (a lone noted item heads its own slide), Big's slides, then the rest of the list.
    expect(slides[1]).toMatchObject({ kind: "section", heading: { id: "list" } });
    expect(slides[2].heading.id).toBe("i0");
    const bigAt = slides.findIndex((s) => s.heading.id === "big");
    expect(bigAt).toBe(3);
    expect(slides.slice(bigAt + 1).some((s) => s.heading.id === "list" && s.items.some((i) => i.node.id === "i5"))).toBe(true);
  });

  it("opens a branch of topics with an agenda of their names, then a slide per topic", () => {
    const d = doc(n("r", "R", [n("big", "Big", [n("p", "P", leaves("p", 6)), n("q", "Q", leaves("q", 6))])]));
    const slides = buildSlides(d);
    expect(slides.map((s) => `${s.kind}:${s.heading.text}`)).toEqual(["title:R", "section:Big", "content:P", "content:Q"]);
    expect(slides[1].items.map((i) => i.node.text)).toEqual(["P", "Q"]);
  });

  it("lays a lone child out in its parent's place instead of a one-item agenda", () => {
    const d = doc(n("r", "R", [n("x", "X", [n("c", "C", [n("a", "A", leaves("a", 7)), n("b", "B", leaves("b", 7))])])]));
    const slides = buildSlides(d);
    expect(slides.map((s) => `${s.kind}:${s.heading.text}`)).toEqual(["title:R", "section:C", "content:A", "content:B"]);
    expect(slides[1].trail).toEqual(["X"]);
    expect(slides[1].ids).toContain("x");
  });

  it("folds a first topic's agenda into its parent's, so two agendas never follow each other", () => {
    const topic = (id: string) => n(id, id.toUpperCase(), leaves(id, 7));
    const d = doc(
      n("r", "R", [n("ch", "Ch", [n("s1", "S1", [topic("a"), topic("b")]), n("s2", "S2", [topic("c"), topic("d")])])])
    );
    expect(buildSlides(d).map((s) => `${s.kind}:${s.heading.text}`)).toEqual([
      "title:R",
      "section:Ch",
      "content:A",
      "content:B",
      "section:S2",
      "content:C",
      "content:D",
    ]);
    expect(buildSlides(d)[1].items.map((i) => "-".repeat(i.depth) + i.node.text)).toEqual(["S1", "-A", "-B", "S2"]);
  });

  it("gives every child its own slide under a node marked slideSplit, even when it would fit", () => {
    const d = doc(n("r", "R", [n("res", "Results", [n("a", "A", [n("a1", "a1")]), n("b", "B")], { slideSplit: true })]));
    expect(summary(d)).toEqual(["title:R[]", "section:Results[A,B]", "content:A[a1]", "content:B[]"]);
  });

  it("leaves the root out of the trail", () => {
    const d = doc(n("r", "https://e.x", [n("a", "A", [n("b", "B", [n("b1", "b1", leaves("y", 6)), n("b2", "b2", leaves("z", 6))])]), n("c", "C")], { type: "link", linkTitle: "Example" }));
    const slides = buildSlides(d);
    expect(slides.find((s) => s.heading.id === "b1")!.trail).toEqual(["A", "B"]);
    expect(slides.every((s) => !s.trail.includes("Example"))).toBe(true);
  });

  it("skips blank text leaves but keeps blank nodes that carry content", () => {
    const d = doc(n("r", "R", [n("a", "A", [n("e", " "), n("img", "", [], { type: "image" })]), n("e2", "")]), n("e3", ""));
    expect(summary(d)).toEqual(["title:R[]", "content:A[]"]);
    expect(buildSlides(d)[1].items.map((i) => i.node.id)).toEqual(["img"]);
  });

  it("sizes bullets by count, and pages a list rather than shrink it below a readable size", () => {
    const few = buildSlides(doc(n("r", "R", [n("a", "A", leaves("x", 3))])))[1];
    const more = buildSlides(doc(n("r", "R", [n("a", "A", leaves("x", 6))])))[1];
    expect(few.size).toBe("l");
    expect(more.size).toBe("m");
    expect(buildSlides(doc(n("r", "R", [n("a", "A", leaves("x", 12))]))).every((s) => s.size !== "s")).toBe(true);
  });

  it("keeps items with a one-line note whole on a continued list instead of a slide each", () => {
    const issues = Array.from({ length: 8 }, (_, i) => n(`i${i}`, `issue${i}`, [n(`i${i}n`, `note${i}`)]));
    const d = doc(n("r", "R", [n("list", "Issues", issues)]));
    const slides = buildSlides(d);
    expect(slides.map((s) => `${s.kind}:${s.heading.text}`)).toEqual(["title:R", "content:Issues", "content:Issues"]);
    expect(slides[1].items.slice(0, 2).map((i) => `${i.depth}:${i.node.text}`)).toEqual(["0:issue0", "1:note0"]);
  });

  it("keeps a branch marked slideSplit false one list, even with topics under it", () => {
    const topic = (id: string) => n(id, id.toUpperCase(), leaves(id, 3));
    const d = doc(n("r", "R", [n("x", "X", [topic("a"), topic("b"), topic("c")], { slideSplit: false })]));
    expect(buildSlides(d).map((s) => `${s.kind}:${s.heading.text}${s.part ? ` ${s.part.index}/${s.part.count}` : ""}`)).toEqual([
      "title:R",
      "content:X 1/2",
      "content:X 2/2",
    ]);
  });

  it("keeps a paragraph too long for a slide under its parent's heading, never as a heading of its own", () => {
    const para = "結論として、この方針で進めるのがよいと考えます。".repeat(16);
    const one = buildSlides(doc(n("r", "R", [n("c", "Conclusion", [n("p", para)])])));
    expect(one.map((s) => `${s.kind}:${s.heading.id}`)).toEqual(["title:r", "content:c"]);
    const two = buildSlides(doc(n("r", "R", [n("c", "Conclusion", [n("p", para), n("q", "next week")])])));
    expect(two.every((s) => s.heading.id !== "p")).toBe(true);
    expect(two[1].heading.id).toBe("c");
  });

  it("splits the ancestors of a node marked slideSplit, so the switch always shows", () => {
    const d = doc(n("r", "R", [n("bg", "Background", [n("a", "A"), n("b", "B", [n("b1", "b1"), n("b2", "b2")], { slideSplit: true })])]));
    expect(buildSlides(d).map((s) => `${s.kind}:${s.heading.text}`)).toEqual([
      "title:R",
      "section:Background",
      "section:B",
      "content:b1",
      "content:b2",
    ]);
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

  it("finds a list item on its continuation page", () => {
    const d2 = doc(n("r", "R", [n("list", "L", leaves("x", 15))]));
    const s2 = buildSlides(d2);
    expect(s2[slideIndexOf(s2, d2, "x14")].part?.index).toBe(2);
  });
});

describe("branchSlideCount", () => {
  it("counts the slides presenting a node's branch", () => {
    const d = doc(n("r", "R", [n("list", "L", leaves("x", 15)), n("b", "B")]));
    const slides = buildSlides(d);
    expect(branchSlideCount(slides, d, "list")).toBe(2);
    expect(branchSlideCount(slides, d, "r")).toBe(slides.length);
    expect(branchSlideCount(slides, d, null)).toBe(0);
  });
});
