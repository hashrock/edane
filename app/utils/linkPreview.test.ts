import { describe, expect, it } from "vitest";
import { extractLinkPreview, fetchLinkPreview, readTextPrefix, LINK_PREVIEW_MAX_BYTES } from "./linkPreview";

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

  it("skips a malformed icon href instead of throwing, using the next link or the fallback", () => {
    const target = new URL("https://example.com/page");
    const bad = `<link rel="icon" href="http://[">`;
    expect(extractLinkPreview(`<title>T</title>${bad}`, target)).toEqual({
      title: "T",
      favicon: "https://example.com/favicon.ico",
    });
    const good = `<link rel="apple-touch-icon" href="/a.png">`;
    expect(extractLinkPreview(bad + good, target).favicon).toBe(
      "https://example.com/a.png"
    );
  });
});

describe("fetchLinkPreview", () => {
  const page = (html: string, init: ResponseInit = {}) => new Response(html, init);
  const redirect = (to: string) => new Response(null, { status: 302, headers: { Location: to } });

  it("follows a few redirects and resolves the favicon against the final page", async () => {
    const hops = [redirect("/b"), redirect("https://other.example/c"), page("<title>Final</title>")];
    const seen: string[] = [];
    const fake = (async (url: string) => {
      seen.push(url);
      return hops.shift()!;
    }) as typeof fetch;
    expect(await fetchLinkPreview(new URL("https://example.com/a"), fake)).toEqual({
      title: "Final",
      favicon: "https://other.example/favicon.ico",
    });
    expect(seen).toEqual(["https://example.com/a", "https://example.com/b", "https://other.example/c"]);
  });

  it("gives up after too many redirects or on a non-http redirect", async () => {
    const loop = (async () => redirect("/again")) as typeof fetch;
    expect(await fetchLinkPreview(new URL("https://example.com/"), loop)).toBeNull();
    const toFile = (async () => redirect("file:///etc/passwd")) as typeof fetch;
    expect(await fetchLinkPreview(new URL("https://example.com/"), toFile)).toBeNull();
  });

  it("never reads past the size cap", async () => {
    let pulled = 0;
    const chunk = new Uint8Array(64 * 1024).fill(0x61);
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += chunk.byteLength;
        controller.enqueue(chunk);
      },
    });
    const fake = (async () => new Response(endless)) as typeof fetch;
    const preview = await fetchLinkPreview(new URL("https://example.com/"), fake);
    expect(preview?.title).toBe("example.com");
    expect(pulled).toBeLessThanOrEqual(LINK_PREVIEW_MAX_BYTES + 2 * chunk.byteLength);
  });
});

describe("readTextPrefix", () => {
  it("returns at most maxBytes", async () => {
    expect(await readTextPrefix(new Response("abcdef"), 4)).toBe("abcd");
    expect(await readTextPrefix(new Response("ab"), 4)).toBe("ab");
  });
});
