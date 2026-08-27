import { describe, it, expect } from "vitest";
import type { MindMapModel } from "../domain/model";
import {
  publicationUrls,
  parsePublicationPath,
  canServePublication,
  publishedNodeJson,
  nodePathTexts,
} from "./nodePublication";

const TREE: MindMapModel = {
  id: "root",
  text: "Root",
  children: [
    {
      id: "a",
      text: "Alpha",
      collapsed: true,
      children: [
        {
          id: "a1",
          text: "price: 1200",
          fontSize: 20,
          children: [],
        },
      ],
    },
    { id: "b", text: "https://example.com", type: "link", linkTitle: "Example", children: [] },
  ],
};

describe("publicationUrls", () => {
  it("builds absolute .json/.md URLs without double slashes", () => {
    expect(publicationUrls("https://edane.example/", "pub-1")).toEqual({
      json: "https://edane.example/pub/pub-1.json",
      md: "https://edane.example/pub/pub-1.md",
    });
  });

  it("URL-encodes the id", () => {
    expect(publicationUrls("https://x.test", "a/b").json).toBe(
      "https://x.test/pub/a%2Fb.json"
    );
  });
});

describe("parsePublicationPath", () => {
  it("splits id and format", () => {
    expect(parsePublicationPath("abc.json")).toEqual({
      pubId: "abc",
      format: "json",
    });
    expect(parsePublicationPath("abc.md")).toEqual({ pubId: "abc", format: "md" });
  });

  it("keeps dots inside the id (only the last extension splits)", () => {
    expect(parsePublicationPath("a.b.json")).toEqual({
      pubId: "a.b",
      format: "json",
    });
  });

  it("rejects unknown extensions and empty ids", () => {
    expect(parsePublicationPath("abc")).toBeNull();
    expect(parsePublicationPath("abc.txt")).toBeNull();
    expect(parsePublicationPath(".json")).toBeNull();
  });
});

describe("canServePublication", () => {
  it("serves only live public notes", () => {
    expect(canServePublication({ isPublic: true, deletedAt: null })).toBe(true);
    expect(canServePublication({ isPublic: false, deletedAt: null })).toBe(false);
    expect(canServePublication({ isPublic: true, deletedAt: "2026-01-01" })).toBe(
      false
    );
    expect(canServePublication(null)).toBe(false);
    expect(canServePublication(undefined)).toBe(false);
  });
});

describe("publishedNodeJson", () => {
  it("strips collapsed (view state) recursively but keeps content fields", () => {
    const out = publishedNodeJson(TREE);
    expect(JSON.stringify(out)).not.toContain("collapsed");
    expect(out.children[0].id).toBe("a");
    expect(out.children[0].children[0]).toMatchObject({
      text: "price: 1200",
      fontSize: 20,
    });
    expect(out.children[1]).toMatchObject({
      type: "link",
      linkTitle: "Example",
    });
  });

  it("does not mutate the input model", () => {
    const before = JSON.stringify(TREE);
    publishedNodeJson(TREE);
    expect(JSON.stringify(TREE)).toBe(before);
  });

  it("drops fields outside the allowlist, not just collapsed", () => {
    // Simulates a future internal-only MindMapModel field: allowlisting
    // means it's dropped automatically, with no per-field exclusion needed.
    const withExtra = {
      id: "x",
      text: "hi",
      children: [],
      draftCursor: 42,
    } as unknown as MindMapModel;
    expect(publishedNodeJson(withExtra)).not.toHaveProperty("draftCursor");
  });
});

describe("nodePathTexts", () => {
  it("returns root-to-node texts inclusive", () => {
    expect(nodePathTexts(TREE, "a1")).toEqual(["Root", "Alpha", "price: 1200"]);
    expect(nodePathTexts(TREE, "root")).toEqual(["Root"]);
  });

  it("returns null for a missing node", () => {
    expect(nodePathTexts(TREE, "nope")).toBeNull();
  });
});
