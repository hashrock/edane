/**
 * Property-based tests for the *serving* half of the public-site pipeline
 * (`siteTemplate.ts`). The data half (`siteDataModule`) is covered by
 * `siteSchema.property.test.ts`, next to the schema it shapes records with;
 * what is left is the part that decides whether author-supplied text can break
 * out of the document it is embedded in, and `validateSiteSave`, which decides
 * how large a payload may be (its weaker "never throws" property used to live
 * in `siteSchema.property.test.ts` and is subsumed here, next to its module).
 *
 * The document is served from our own origin, so the escaping here is a
 * security boundary (the CSP in `renderSiteResponse` is the second layer):
 * - the CSS must never close its own `<style>` element,
 * - the title must never introduce markup,
 * - the nonce'd search script must always be the last thing in the document,
 *   and its nonce must be freshly minted and identical in document and header.
 *
 * `build.html` is *deliberately* inserted verbatim — it is the compiled
 * template, and it is the CSP (sandbox + `script-src 'nonce-…'`) that contains
 * it. That contract is pinned here too, so a future "let's sanitise the HTML"
 * change has to be a conscious one.
 */
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  SITE_BUILD_MAX_BYTES,
  SITE_SCHEMA_MAX_BYTES,
  SITE_SEARCH_SCRIPT,
  SITE_TEMPLATE_MAX_BYTES,
  renderSiteResponse,
  siteEditPath,
  siteUrl,
  validateSiteSave,
} from "./siteTemplate";

/**
 * Text built out of random strings and fragments that are dangerous in one of
 * the embedding contexts, so the generator actually reaches the escaping
 * branches instead of only ever producing inert noise.
 */
const HOSTILE = [
  "</style>",
  "</STYLE",
  "</style",
  "<\\/style",
  "</script>",
  "<script>",
  "</title>",
  "<!--",
  "&",
  "<",
  ">",
  '"',
  "'",
  "\n",
  "{color:red}",
] as const;

const textArb = fc
  .array(
    fc.oneof(fc.string({ unit: "grapheme", maxLength: 8 }), fc.constantFrom(...HOSTILE)),
    { maxLength: 6 }
  )
  .map((parts) => parts.join(""));

const buildArb = fc.record({ html: textArb, css: textArb });

/** The text an element holds: between its first start tag and the end tag after it. */
function elementText(body: string, tag: string): string {
  const open = body.indexOf(`<${tag}>`);
  expect(open).toBeGreaterThanOrEqual(0);
  const start = open + tag.length + 2;
  const close = body.indexOf(`</${tag}>`, start);
  expect(close).toBeGreaterThanOrEqual(0);
  return body.slice(start, close);
}

/** Inverse of the `</style` escaping, case preserved. */
const unescapeStyle = (s: string) => s.replace(/<\\\/style/gi, (m) => "<" + m.slice(2));

/** Inverse of escapeHtml: `&amp;` must be undone last. */
const unescapeHtml = (s: string) =>
  s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");

describe("renderSiteResponse", () => {
  it("closes the style block itself: the CSS can never contain `</style`, whatever the case", () => {
    fc.assert(
      fc.property(buildArb, textArb, (build, title) => {
        const region = elementText(renderSiteResponse(build, title).body, "style");
        expect(region.toLowerCase()).not.toContain("</style");
      })
    );
  });

  it("keeps the CSS otherwise intact — the escaping is reversible", () => {
    fc.assert(
      fc.property(buildArb, textArb, (build, title) => {
        // Ambiguous only if the CSS already contains the escaped form.
        fc.pre(!/<\\\/style/i.test(build.css));
        expect(unescapeStyle(elementText(renderSiteResponse(build, title).body, "style"))).toBe(build.css);
      })
    );
  });

  it("escapes the title into markup-free text that decodes back to the title", () => {
    fc.assert(
      fc.property(buildArb, textArb, (build, title) => {
        const region = elementText(renderSiteResponse(build, title).body, "title");
        expect(region).not.toMatch(/[<>"]/);
        expect(unescapeHtml(region)).toBe(title);
      })
    );
  });

  it("serves build.html verbatim and always ends with the nonce'd search script", () => {
    fc.assert(
      fc.property(buildArb, textArb, (build, title) => {
        const { body, headers } = renderSiteResponse(build, title);
        expect(body.startsWith("<!DOCTYPE html>")).toBe(true);
        expect(body).toContain(`<body>${build.html}`);
        const nonce = headers["Content-Security-Policy"].match(/script-src 'nonce-([^']*)'/)?.[1];
        // Freshly minted per response, so no input can ever reach it.
        expect(nonce).toMatch(/^[0-9a-f-]{36}$/);
        expect(body).toContain(`content="default-src 'none'; script-src 'nonce-${nonce}';`);
        expect(
          body.endsWith(`<script nonce="${nonce}">${SITE_SEARCH_SCRIPT}</script></body></html>`)
        ).toBe(true);
      })
    );
  });

  it("always sandboxes, never same-origin, and never injects a header", () => {
    fc.assert(
      fc.property(buildArb, textArb, (build, title) => {
        const { headers } = renderSiteResponse(build, title);
        const csp = headers["Content-Security-Policy"];
        expect(csp).toMatch(/^sandbox allow-scripts allow-popups; default-src 'none';/);
        expect(csp).not.toContain("allow-same-origin");
        expect(headers["X-Robots-Tag"]).toBe("noindex");
        expect(headers["Referrer-Policy"]).toBe("no-referrer");
        expect(headers["Content-Type"]).toBe("text/html; charset=utf-8");
        for (const v of Object.values(headers)) expect(v).not.toMatch(/[\r\n]/);
      })
    );
  });

  it("mints a different nonce for every response", () => {
    fc.assert(
      fc.property(buildArb, textArb, (build, title) => {
        const a = renderSiteResponse(build, title).headers["Content-Security-Policy"];
        const b = renderSiteResponse(build, title).headers["Content-Security-Policy"];
        expect(a).not.toBe(b);
      })
    );
  });
});

describe("site urls", () => {
  it("put the id in one path segment that decodes back to it, with no separator escaping it", () => {
    fc.assert(
      fc.property(fc.string({ unit: "grapheme", maxLength: 12 }), (pubId) => {
        const path = siteEditPath(pubId);
        const seg = path.slice("/sites/".length, -"/edit".length);
        expect(path).toBe(`/sites/${seg}/edit`);
        expect(seg).not.toMatch(/[/?#&\s]/);
        expect(decodeURIComponent(seg)).toBe(pubId);
        expect(siteUrl("https://x.test", pubId)).toBe(`https://x.test/sites/${seg}`);
      })
    );
  });

  it("strips every trailing slash of the origin, never doubling the separator", () => {
    fc.assert(
      fc.property(
        fc.string({ unit: "grapheme", maxLength: 12 }),
        fc.nat({ max: 4 }),
        (pubId, slashes) => {
          const url = siteUrl("https://x.test" + "/".repeat(slashes), pubId);
          expect(url).toBe(siteUrl("https://x.test", pubId));
          expect(url).not.toContain("//sites/");
        }
      )
    );
  });
});

describe("validateSiteSave", () => {
  /** Lengths straddling each limit, so both sides of every branch are hit. */
  const around = (limit: number) => fc.constantFrom(0, 1, limit - 1, limit, limit + 1);
  const filler = (n: number) => "x".repeat(n);

  it("accepts exactly the string bodies that fit every limit", () => {
    fc.assert(
      fc.property(
        around(SITE_TEMPLATE_MAX_BYTES),
        around(SITE_SCHEMA_MAX_BYTES),
        around(SITE_BUILD_MAX_BYTES),
        fc.nat({ max: 2 }),
        (t, s, h, css) => {
          const body = { template: filler(t), schema: filler(s), html: filler(h), css: filler(css) };
          const r = validateSiteSave(body);
          const fits =
            t <= SITE_TEMPLATE_MAX_BYTES &&
            s <= SITE_SCHEMA_MAX_BYTES &&
            h + css <= SITE_BUILD_MAX_BYTES;
          expect(r.ok).toBe(fits);
          if (r.ok) {
            expect(r.template).toBe(body.template);
            expect(r.schema).toBe(body.schema);
            expect(r.build).toEqual({ html: body.html, css: body.css });
          } else {
            expect(r.error).not.toBe("");
          }
        }
      ),
      { numRuns: 40 }
    );
  });

  it("never throws on arbitrary JSON, and what it accepts is four strings", () => {
    fc.assert(
      fc.property(fc.jsonValue(), (body) => {
        const r = validateSiteSave(body);
        if (!r.ok) {
          expect(r.error).not.toBe("");
          return;
        }
        expect(typeof r.template).toBe("string");
        expect(typeof r.schema).toBe("string");
        expect(typeof r.build.html).toBe("string");
        expect(typeof r.build.css).toBe("string");
      })
    );
  });

  it("requires all four fields to be strings, defaulting only a missing schema", () => {
    const fieldArb = fc.oneof(fc.string({ maxLength: 4 }), fc.jsonValue(), fc.constant(undefined));
    fc.assert(
      fc.property(fieldArb, fieldArb, fieldArb, fieldArb, (template, schema, html, css) => {
        const body: Record<string, unknown> = { template, html, css };
        if (schema !== undefined) body.schema = schema;
        const r = validateSiteSave(body);
        expect(r.ok).toBe(
          typeof template === "string" &&
            typeof html === "string" &&
            typeof css === "string" &&
            (schema === undefined || typeof schema === "string")
        );
        if (r.ok && schema === undefined) expect(r.schema).toBe("");
      })
    );
  });
});
