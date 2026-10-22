import { describe, it, expect } from "vitest";
import { seededD1 } from "../../vitest.d1";
import { insertImageWithinQuota } from "./imageRepository";

describe("insertImageWithinQuota", () => {
  it("writes only while the user's total stays within the limit", async () => {
    const db = await seededD1();
    const image = (id: string, size: number) => ({
      id,
      userId: "u",
      r2Key: `u/${id}`,
      filename: "a.png",
      contentType: "image/png",
      size,
      createdAt: "2026-01-01",
    });
    expect(await insertImageWithinQuota(db, image("a", 6), 10)).toBe(true);
    expect(await insertImageWithinQuota(db, image("b", 4), 10)).toBe(true); // exactly at the limit
    expect(await insertImageWithinQuota(db, image("c", 1), 10)).toBe(false);
    const { results } = await db.prepare("SELECT id FROM images ORDER BY id").all();
    expect(results.map((r) => r.id)).toEqual(["a", "b"]);
  });
});
