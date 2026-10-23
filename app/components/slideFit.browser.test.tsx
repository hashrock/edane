import { describe, it, expect } from "vitest";
import { render } from "vitest-browser-react";
import { page } from "vitest/browser";
import type { MindMapDocument, MindMapModel } from "../domain/model";
import { DEFAULT_PAGE_THEME } from "../domain/pageTheme";
import { buildSlides, slideFits, type Slide } from "../application/slides";
import { PageRoot, PageSection } from "./PageView";
import "./webpage.css";

/**
 * buildSlides decides what fits on a slide from an estimate of the slide
 * variant's layout (application/slides.ts). Here the real stylesheet draws
 * every slide it says fits, and none of them may overflow its list.
 */

let next = 0;
const n = (text: string, children: MindMapModel[] = [], extra: Partial<MindMapModel> = {}): MindMapModel => ({
  id: `n${next++}`,
  text,
  children,
  ...extra,
});
const leaves = (text: string, count: number) => Array.from({ length: count }, (_, i) => n(`${text}${i + 1}`));

const LONG_JA = "スライドに載せると二行三行に折り返されてしまうくらいの長さがある説明文です。補足もさらに足していきます。";
const LONG_EN = "A sentence long enough to wrap over more than one line once it is drawn on the slide at the smallest size.";

const DOC: MindMapDocument = {
  title: "",
  roots: [
    n("経済史概論 第5回 産業革命とイギリス社会", [
      n("短い項目", leaves("項目", 10)),
      n("長い一覧", leaves("課題", 23)),
      n("長文", [n(LONG_JA, [n(LONG_JA), n(LONG_JA)]), n(LONG_JA, [n(LONG_JA)]), n(LONG_EN), n(LONG_EN)]),
      n("深い入れ子", [n("一", [n("二", [n("三", [n("四", leaves("五", 3))])])]), n("別", leaves("葉", 4))]),
      n("見出しがとても長くて二行に折り返されてしまうくらいの長さがあるスライドの見出し", leaves("行", 9)),
      n("章", [n("節A", [n(LONG_JA), n(LONG_EN), ...leaves("a", 5)]), n("節B", leaves("b", 8)), n("メモ")]),
      n("タスク", leaves("やること", 8).map((c, i) => ({ ...c, checked: i % 2 === 0 }))),
    ]),
  ],
};

/** Draw one slide on a 1280×720 stage; how far its list overflows, in px. */
async function overflow(slide: Slide, index: number): Promise<number> {
  const screen = await render(
    <PageRoot theme={DEFAULT_PAGE_THEME} variant="slide" style={{ width: 1280, height: 720 }}>
      <PageSection slide={slide} index={index} />
    </PageRoot>
  );
  const list = document.querySelector<HTMLElement>(".wp-items")!;
  const over = list.scrollHeight - list.clientHeight;
  await screen.unmount();
  return over;
}

describe("slide fit (browser)", () => {
  it("draws every slide it says fits without overflowing the list", async () => {
    await page.viewport(1280, 720);
    const slides = buildSlides(DOC);
    expect(slides.length).toBeGreaterThan(8);
    for (const [i, slide] of slides.entries()) {
      if (slide.kind === "title" || !slideFits(slide.heading, slide.items)) continue;
      const label = `slide ${i + 1}: ${slide.heading.text}${slide.part ? ` (${slide.part.index})` : ""}`;
      expect(await overflow(slide, i), label).toBeLessThanOrEqual(1);
    }
  });

  it("would overflow with the list it pages (the check above can fail)", async () => {
    await page.viewport(1280, 720);
    const list = DOC.roots[0].children[1];
    const whole: Slide = { kind: "content", heading: list, trail: [], ids: [], size: "s", items: list.children.map((node) => ({ node, depth: 0 })) };
    expect(slideFits(whole.heading, whole.items)).toBe(false);
    expect(await overflow(whole, 0)).toBeGreaterThan(1);
  });
});
