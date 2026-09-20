import { describe, it, expect } from "vitest";
import { notFoundHtml, wantsJsonNotFound } from "./notFoundPage";
import { MESSAGES_JA } from "./messages";

describe("wantsJsonNotFound", () => {
  it("keeps JSON for the API and the data feeds", () => {
    expect(wantsJsonNotFound("/api/notes/x", "*/*")).toBe(true);
    expect(wantsJsonNotFound("/pub/abc.json", "*/*")).toBe(true);
    expect(wantsJsonNotFound("/pub/abc.md", "*/*")).toBe(true);
    expect(wantsJsonNotFound("/notes/x/edit", "application/json")).toBe(true);
  });
  it("gives the HTML page to page navigations", () => {
    expect(wantsJsonNotFound("/notes/x/edit", "text/html,application/xhtml+xml")).toBe(false);
    expect(wantsJsonNotFound("/notes/x", undefined)).toBe(false);
    expect(wantsJsonNotFound("/nope", "*/*")).toBe(false);
  });
});

describe("notFoundHtml", () => {
  const html = notFoundHtml();
  it("explains what happened and links back to the note list", () => {
    expect(html).toContain(MESSAGES_JA.notFoundTitle);
    expect(html).toContain(MESSAGES_JA.notFoundMessage);
    expect(html).toContain('href="/notes"');
    expect(html).toContain(MESSAGES_JA.notFoundBackToList);
  });
  it("escapes the catalog text", () => {
    const out = notFoundHtml({
      notFoundTitle: "<b>x</b>",
      notFoundMessage: 'a "quoted" & b',
      notFoundBackToList: "back",
    });
    expect(out).not.toContain("<b>x</b>");
    expect(out).toContain("&lt;b&gt;x&lt;/b&gt;");
    expect(out).toContain("&quot;quoted&quot; &amp; b");
  });
});
