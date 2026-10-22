import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { renderSafeMarkdown, safePageUrl } from "./safeMarkdown";

describe("renderSafeMarkdown", () => {
  it("renders markdown", () => {
    expect(renderSafeMarkdown("**b** [x](https://example.com)")).toBe('<p><strong>b</strong> <a href="https://example.com/">x</a></p>\n');
    expect(renderSafeMarkdown("   ")).toBe("");
  });

  it("shows raw HTML as text", () => {
    expect(renderSafeMarkdown("<script>alert(1)</script>")).toBe("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(renderSafeMarkdown("hi <img src=x onerror=alert(1)>")).toBe("<p>hi &lt;img src=x onerror=alert(1)&gt;</p>\n");
  });

  it("drops unsafe link and image URLs, keeps same-origin paths", () => {
    expect(renderSafeMarkdown("[a](javascript:alert(1))")).toBe('<p><a href="">a</a></p>\n');
    expect(renderSafeMarkdown("[a](//evil.example)")).toBe('<p><a href="">a</a></p>\n');
    expect(renderSafeMarkdown("![i](data:image/svg+xml,x)")).toBe('<p><img src="" alt="i"></p>\n');
    expect(renderSafeMarkdown("![i](/api/images/x/raw)")).toBe('<p><img src="/api/images/x/raw" alt="i"></p>\n');
  });

  it("never lets a tag or an event handler through", () => {
    const piece = fc.constantFrom("<", ">", "script", "img", " onerror=", "x", "`", "\n", "[", "](", ")", "javascript:", "<div>", "</div>", '"', "'");
    fc.assert(
      fc.property(fc.array(piece, { maxLength: 30 }).map((p) => p.join("")), (src) => {
        const html = renderSafeMarkdown(src);
        expect(html).not.toMatch(/<(script|div|img[^>]*onerror)/i);
        expect(html).not.toMatch(/href="javascript:/i);
      })
    );
  });
});

describe("safePageUrl", () => {
  it("allows http(s) and same-origin paths only", () => {
    expect(safePageUrl("https://a.example/x")).toBe("https://a.example/x");
    expect(safePageUrl("/api/images/1/raw")).toBe("/api/images/1/raw");
    expect(safePageUrl("//evil.example")).toBeNull();
    expect(safePageUrl("/\\evil.example")).toBeNull();
    expect(safePageUrl("javascript:alert(1)")).toBeNull();
    expect(safePageUrl("")).toBeNull();
  });
});
