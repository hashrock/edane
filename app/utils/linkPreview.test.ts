import { describe, expect, it } from "vitest";
import { extractLinkPreview } from "./linkPreview";

describe("extractLinkPreview", () => {
  it("extracts the title, collapsing whitespace and trimming", () => {
    const html = `<html><head><title>  Hello\n  World  </title></head></html>`;
    const { title } = extractLinkPreview(html, new URL("https://example.com"));
    expect(title).toBe("Hello World");
  });

  it("falls back to the hostname when there is no <title>", () => {
    const html = `<html><head></head></html>`;
    const { title } = extractLinkPreview(html, new URL("https://example.com/page"));
    expect(title).toBe("example.com");
  });

  it("truncates long titles to 300 characters", () => {
    const longTitle = "x".repeat(400);
    const html = `<title>${longTitle}</title>`;
    const { title } = extractLinkPreview(html, new URL("https://example.com"));
    expect(title).toHaveLength(300);
  });

  it("resolves a relative favicon href against the target URL", () => {
    const html = `<link rel="icon" href="/favicon-32.png">`;
    const { favicon } = extractLinkPreview(html, new URL("https://example.com/blog/post"));
    expect(favicon).toBe("https://example.com/favicon-32.png");
  });

  it("matches rel values containing 'icon', e.g. shortcut icon", () => {
    const html = `<link rel="shortcut icon" href="https://cdn.example.com/icon.ico">`;
    const { favicon } = extractLinkPreview(html, new URL("https://example.com"));
    expect(favicon).toBe("https://cdn.example.com/icon.ico");
  });

  it("falls back to /favicon.ico on the target origin when no icon link is found", () => {
    const html = `<html><head></head></html>`;
    const { favicon } = extractLinkPreview(html, new URL("https://example.com/page"));
    expect(favicon).toBe("https://example.com/favicon.ico");
  });
});
