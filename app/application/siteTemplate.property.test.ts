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
  exceedsBytes,
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
  /**
   * `.` / `..` はドットセグメントとして URL 正規化に食われる。percent-encoded の
   * 綴り（`%2e`）でも同じ扱いなので、この2つに復号されるセグメントは作れない
   * ——ビルダーは `undefined` を返してリンクを出さない。それ以外は必ず
   * `/sites/` の内側の1セグメントに収まり、復号すると元の id に戻る。
   */
  const pubIdArb = fc.oneof(
    fc.constantFrom(".", "..", "../..", "%2e%2e", "a.b", "...", "a/b", "a?b#c"),
    fc.string({ unit: "grapheme", maxLength: 12 })
  );

  it("puts the id in one path segment that survives URL normalisation and decodes back", () => {
    fc.assert(
      fc.property(pubIdArb, (pubId) => {
        const url = siteUrl("https://x.test", pubId);
        const path = siteEditPath(pubId);
        if (pubId === "." || pubId === "..") {
          // 表現できない2つ。投げずに落とす（呼び出し側はレンダー中）。
          expect(url).toBeUndefined();
          expect(path).toBeUndefined();
          return;
        }
        // URL() がドットセグメントを畳んだあとも `/sites/` の内側にいる。
        const viewed = new URL(url!);
        const edited = new URL(`https://x.test${path}`);
        expect(viewed.pathname).toMatch(/^\/sites\/[^/]*$/);
        expect(edited.pathname).toMatch(/^\/sites\/[^/]*\/edit$/);
        const seg = viewed.pathname.slice("/sites/".length);
        expect(seg).not.toMatch(/[/?#&\s]/);
        expect(decodeURIComponent(seg)).toBe(pubId);
        // 2つのビルダーは同じセグメントを使う。
        expect(path).toBe(`/sites/${seg}/edit`);
      })
    );
  });

  it("strips every trailing slash of the origin, never doubling the separator", () => {
    fc.assert(
      fc.property(pubIdArb, fc.nat({ max: 4 }), (pubId, slashes) => {
        const url = siteUrl("https://x.test" + "/".repeat(slashes), pubId);
        expect(url).toBe(siteUrl("https://x.test", pubId));
        expect(url ?? "").not.toContain("//sites/");
      })
    );
  });
});

describe("exceedsBytes", () => {
  /**
   * ロング・サロゲートも引ける、多バイトを狙った生成器。`unit: "binary"` は
   * 同じ目的を果たすが生成が桁違いに遅いので、単位を明示して同じ被覆を得る。
   */
  const mixedArb = fc.string({
    unit: fc.constantFrom("a", " ", "é", "あ", "😀", "\uD800", "\uDFFF"),
    maxLength: 40,
  });

  /** 各 part を別々に符号化した合計 = 列ごとに保存されるバイト数。 */
  const bytesOf = (...parts: string[]) =>
    parts.reduce((n, p) => n + new TextEncoder().encode(p).length, 0);

  it("agrees with the platform encoder at every limit, short-circuits or not", () => {
    fc.assert(
      fc.property(mixedArb, mixedArb, fc.nat({ max: 130 }), (a, b, limit) => {
        // 挟み込み（units / units*3）で早期に決める枝と、実際に符号化する枝の
        // どちらを通っても答えは同じでなければならない。
        expect(exceedsBytes(limit, a, b)).toBe(bytesOf(a, b) > limit);
        expect(exceedsBytes(limit, a)).toBe(bytesOf(a) > limit);
      }),
      { numRuns: 300 }
    );
  });

  it("counts each part separately — parts land in separate columns, so a surrogate pair split across the boundary is not re-joined", () => {
    // 上位サロゲートで終わり、下位サロゲートで始まる。連結すると対になって
    // 4バイトだが、別々に保存されるので実際は 3 + 3 = 6 バイト。
    const a = "\uD800";
    const b = "\uDFFF";
    expect(bytesOf(a, b)).toBe(6);
    expect(new TextEncoder().encode(a + b).length).toBe(4);
    expect(exceedsBytes(5, a, b)).toBe(true);
    expect(exceedsBytes(6, a, b)).toBe(false);
  });

  it("counts ASCII as one byte each, so an ASCII body behaves exactly as before", () => {
    fc.assert(
      fc.property(fc.stringMatching(/^[ -~]{0,40}$/), fc.nat({ max: 60 }), (ascii, limit) => {
        expect(exceedsBytes(limit, ascii)).toBe(ascii.length > limit);
      })
    );
  });
});

describe("validateSiteSave", () => {
  /** Lengths straddling each limit, so both sides of every branch are hit. */
  const around = (limit: number) => fc.constantFrom(0, 1, limit - 1, limit, limit + 1);
  const filler = (n: number) => "x".repeat(n);

  it("measures every limit in UTF-8 bytes, so multi-byte content cannot slip past it", () => {
    fc.assert(
      fc.property(
        // 「あ」は UTF-8 で3バイト、絵文字は4バイト。UTF-16 長で測っていた頃は
        // 上限ちょうどの「文字数」まで通っていたので、上限の3〜4倍の実バイト数が
        // 保存されていた。
        fc.constantFrom("あ", "😀", "é"),
        fc.constantFrom(-1, 0, 1),
        (ch, delta) => {
          const bytesOf = (s: string) => new TextEncoder().encode(s).length;
          // ちょうど上限に収まる個数 ± 1 文字。
          const count = Math.floor(SITE_SCHEMA_MAX_BYTES / bytesOf(ch)) + delta;
          const schema = ch.repeat(count);
          const r = validateSiteSave({ template: "", schema, html: "", css: "" });
          expect(r.ok).toBe(bytesOf(schema) <= SITE_SCHEMA_MAX_BYTES);
          // 旧実装（UTF-16 長で比較）なら全部通っていたことを対比として固定する。
          expect(schema.length).toBeLessThanOrEqual(SITE_SCHEMA_MAX_BYTES);
        }
      )
    );
  });

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
