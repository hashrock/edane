import { describe, it, expect } from "vitest";
import {
  toSiteNode,
  siteDataModule,
  renderSiteResponse,
  siteUrl,
  siteEditPath,
  validateSiteSave,
} from "./siteTemplate";
import type { MindMapModel } from "../domain/model";

const TREE: MindMapModel = {
  id: "r",
  text: "root",
  children: [
    { id: "a", text: "A", type: "link", collapsed: true, children: [] },
    { id: "b", text: "B", children: [{ id: "b1", text: "b1", children: [] }] },
  ],
};

describe("toSiteNode", () => {
  it("keeps id/text/type/children, resolves default type, drops view state", () => {
    expect(toSiteNode(TREE)).toEqual({
      id: "r",
      type: "text",
      text: "root",
      children: [
        { id: "a", type: "link", text: "A", children: [] },
        { id: "b", type: "text", text: "B", children: [{ id: "b1", type: "text", text: "b1", children: [] }] },
      ],
    });
  });
});

describe("siteDataModule", () => {
  it("emits data, items and schema, escaping `<` so `</script>` can't close a tag", () => {
    const src = siteDataModule(
      { id: "r", type: "text", text: "</script>", children: [{ id: "a", type: "text", text: "A", children: [{ id: "a1", type: "text", text: "x", children: [] }] }] },
      [{ key: "f", list: false }]
    );
    expect(src.startsWith("export const data = ")).toBe(true);
    expect(src).toContain('export const items = [{"id":"a","title":"A","f":"x"}];');
    expect(src).toContain("export const schema = ");
    expect(src).toContain('export const title = "\\u003c/script>";');
    expect(src).not.toContain("</script>");
    expect(src).toContain("\\u003c/script>");
  });
});

describe("renderSiteResponse", () => {
  it("wraps html/css, escapes the title and embeds only the nonce'd search script", () => {
    const { body, headers } = renderSiteResponse({ html: "<main>hi</main>", css: ".a{color:red}" }, "<t>");
    expect(body).toContain("<title>&lt;t&gt;</title>");
    expect(body).toContain("<style>.a{color:red}</style>");
    expect(body).toContain("<main>hi</main>");
    expect(body.match(/<script/g)).toHaveLength(1);
    const nonce = body.match(/<script nonce="([^"]+)">/)?.[1];
    expect(nonce).toBeTruthy();
    // the same nonce is in the header and in the <meta> policy (for srcdoc previews)
    expect(headers["Content-Security-Policy"]).toContain(`script-src 'nonce-${nonce}'`);
    expect(body).toContain(`<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'`);
  });

  it("neutralises </style> inside css so it can't break out of the style block", () => {
    const { body } = renderSiteResponse({ html: "", css: "</style><script>x</script>" }, "");
    expect(body).not.toContain("</style><script>");
    expect(body.match(/<\/style>/g)).toHaveLength(1);
  });

  it("sandboxes without same-origin and marks noindex", () => {
    const { headers } = renderSiteResponse({ html: "", css: "" }, "");
    expect(headers["Content-Security-Policy"]).toMatch(/^sandbox allow-scripts allow-popups;/);
    expect(headers["Content-Security-Policy"]).not.toContain("allow-same-origin");
    expect(headers["X-Robots-Tag"]).toBe("noindex");
  });
});

describe("site urls", () => {
  it("encode the id and tolerate a trailing slash on the origin", () => {
    expect(siteUrl("https://x.test/", "a b")).toBe("https://x.test/sites/a%20b");
    expect(siteEditPath("a b")).toBe("/sites/a%20b/edit");
  });
});

describe("validateSiteSave", () => {
  it("accepts a well-formed body", () => {
    const r = validateSiteSave({ template: "x", schema: "a, b", html: "<p>", css: "" });
    expect(r).toMatchObject({ ok: true, schema: "a, b" });
    expect(validateSiteSave({ template: "x", html: "", css: "" })).toMatchObject({ ok: true, schema: "" });
  });
  it("rejects missing fields and oversized payloads", () => {
    expect(validateSiteSave(null).ok).toBe(false);
    expect(validateSiteSave({ template: "x" }).ok).toBe(false);
    expect(validateSiteSave({ template: "x".repeat(70_000), html: "", css: "" }).ok).toBe(false);
    expect(validateSiteSave({ template: "", html: "x".repeat(3_000_000), css: "" }).ok).toBe(false);
    expect(validateSiteSave({ template: "", schema: "x".repeat(5000), html: "", css: "" }).ok).toBe(false);
  });
});
