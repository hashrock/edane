import { describe, it, expect } from "vitest";
import type { MindMapModel } from "../domain/model";
import {
  objectCardGeom,
  CARD_MIN_CONTENT_W,
  CARD_TITLE_TOP,
  CARD_ROWS_TOP,
  CARD_BOTTOM,
  CARD_HINT_H,
  ROW_MIN_H,
  ROW_THUMB_MAX_H,
  ROW_BADGE_W,
  rowKeyColOffset,
} from "./objectCard";
import { NODE_MAX_CONTENT_WIDTH, measureNodeBox } from "../lib/measureText";

function card(children: MindMapModel[]): MindMapModel {
  return { id: "card", text: "商品A", type: "object", children };
}

describe("objectCardGeom", () => {
  it("produces one row per direct child, in order, stacked without gaps", () => {
    const g = objectCardGeom(
      card([
        { id: "r1", text: "価格: 1200", children: [] },
        { id: "r2", text: "URL: https://example.com", children: [] },
      ])
    );
    expect(g.rows.map((r) => r.id)).toEqual(["r1", "r2"]);
    expect(g.rows[0].index).toBe(0);
    expect(g.rows[1].top).toBe(g.rows[0].top + g.rows[0].height);
    expect(g.height).toBe(g.rows[1].top + g.rows[1].height + CARD_BOTTOM);
  });

  it("keeps rows at least ROW_MIN_H tall and the card at least min width", () => {
    const g = objectCardGeom(card([{ id: "r1", text: "a: b", children: [] }]));
    expect(g.rows[0].height).toBeGreaterThanOrEqual(ROW_MIN_H);
    expect(g.width).toBeGreaterThanOrEqual(CARD_MIN_CONTENT_W);
  });

  it("shares one key column across rows", () => {
    const g = objectCardGeom(
      card([
        { id: "r1", text: "短: 1", children: [] },
        { id: "r2", text: "とても長いキー名: 2", children: [] },
      ])
    );
    expect(g.keyColW).toBeGreaterThan(0);
    // Both rows carry the same shared column via geometry (keyColW), and the
    // longer key defines it.
    expect(g.rows[0].key).toBe("短");
    expect(g.rows[1].key).toBe("とても長いキー名");
  });

  it("parses keys/kinds and formats numeric display", () => {
    const g = objectCardGeom(
      card([
        {
          id: "r1",
          text: "価格: 1234.5",
          children: [],
          numFormat: "currency",
          decimals: 0,
        },
        { id: "r2", text: "日付: 2026-07-10", children: [] },
      ])
    );
    expect(g.rows[0].kind).toBe("number");
    expect(g.rows[0].display).toBe("¥1,235");
    expect(g.rows[1].kind).toBe("date");
  });

  it("reserves hint space (only) for an empty card", () => {
    const empty = objectCardGeom(card([]));
    const withRow = objectCardGeom(
      card([{ id: "r1", text: "a: b", children: [] }])
    );
    expect(empty.rows).toEqual([]);
    expect(empty.height).toBe(
      empty.sepY + CARD_ROWS_TOP + CARD_HINT_H + CARD_BOTTOM
    );
    expect(withRow.height).toBeGreaterThan(empty.height);
  });

  it("grows for a multi-line row", () => {
    const one = objectCardGeom(card([{ id: "r1", text: "a: b", children: [] }]));
    const two = objectCardGeom(
      card([{ id: "r1", text: "a: b\nc", children: [] }])
    );
    expect(two.rows[0].height).toBeGreaterThan(one.rows[0].height);
  });

  it("clamps image-row thumbnails to the row bounds", () => {
    // Node has no Image constructor → imageCache falls back to the 240×160
    // placeholder, which must scale down to the thumb box.
    const g = objectCardGeom(
      card([
        { id: "r1", text: "https://x.test/a.png", type: "image", children: [] },
      ])
    );
    expect(g.rows[0].kind).toBe("image");
    expect(g.rows[0].thumbH).toBeLessThanOrEqual(ROW_THUMB_MAX_H);
  });

  it("applies a live editing override to title and row measurement", () => {
    const base = card([{ id: "r1", text: "a: b", children: [] }]);
    const g0 = objectCardGeom(base);
    const gTitle = objectCardGeom(base, {
      id: "card",
      text: "とてもとてもとてもとてもとてもとても長いタイトル文字列",
    });
    expect(gTitle.width).toBeGreaterThan(g0.width);
    const gRow = objectCardGeom(base, { id: "r1", text: "a: b\nもう一行" });
    expect(gRow.rows[0].height).toBeGreaterThan(g0.rows[0].height);
  });

  it("stops widening at the node content cap and grows downwards instead", () => {
    const long = "x".repeat(600);
    const narrow = objectCardGeom(card([{ id: "r1", text: "キー: v", children: [] }]));
    const wide = objectCardGeom(card([{ id: "r1", text: `キー: ${long}`, children: [] }]));
    expect(wide.width).toBeLessThanOrEqual(NODE_MAX_CONTENT_WIDTH);
    expect(wide.rows[0].height).toBeGreaterThan(narrow.rows[0].height);
    // The value column is pre-wrapped for the draw, so the row's height and the
    // text it renders come from the same line list.
    expect(wide.rows[0].displayLines.length).toBeGreaterThan(1);
  });

  it("caps a long title too", () => {
    const g = objectCardGeom({
      id: "card",
      text: "あ".repeat(400),
      type: "object",
      children: [],
    });
    expect(g.width).toBeLessThanOrEqual(NODE_MAX_CONTENT_WIDTH);
  });

  it("leaves the value column room for the key column and the hidden-child pill", () => {
    const g = objectCardGeom(
      card([
        {
          id: "r1",
          text: `とてもながいキー: ${"x".repeat(600)}`,
          children: [{ id: "g", text: "hidden", children: [] }],
        },
      ])
    );
    const r = g.rows[0];
    const valueW = Math.max(0, ...r.displayLines.map((l) => measureNodeBox(l).width));
    expect(
      rowKeyColOffset(r.key, g.keyColW) + valueW + ROW_BADGE_W
    ).toBeLessThanOrEqual(NODE_MAX_CONTENT_WIDTH + 0.001);
  });

  it("positions the title block from the card top", () => {
    const g = objectCardGeom(card([]));
    expect(g.titleCenterY).toBeGreaterThan(CARD_TITLE_TOP);
    expect(g.sepY).toBeGreaterThan(g.titleCenterY);
  });
});
