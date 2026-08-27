import { describe, it, expect } from "vitest";
import { buildSuggestMessages, extractTemplate, sampleItems, validateSuggestRequest } from "./siteAi";
import { defaultTemplate, inferSchema } from "./siteSchema";
import type { SiteNode } from "./siteTemplate";

const leaf = (id: string, text: string, type: SiteNode["type"] = "text"): SiteNode => ({
  id, text, type, children: [],
});
const root: SiteNode = {
  id: "r", type: "text", text: "Root",
  children: Array.from({ length: 10 }, (_, i) => ({
    id: `c${i}`, type: "text", text: `Item ${i}`,
    children: [leaf(`d${i}`, "desc"), leaf(`u${i}`, "https://x/" + i, "link")],
  })),
};

describe("sampleItems", () => {
  it("shows at most 5 items, clips long values and notes the rest", () => {
    const items = Array.from({ length: 7 }, (_, i) => ({ id: `i${i}`, title: `T${i}`, body: "x".repeat(200), tags: ["a"] }));
    const s = sampleItems(items);
    expect(s).toContain('"T4"');
    expect(s).not.toContain('"T5"');
    expect(s).toContain("(+2 more items)");
    expect(s).toContain("x".repeat(120) + "…");
    expect(s).not.toContain("x".repeat(121));
  });
  it("truncates to maxChars", () => {
    const s = sampleItems([{ id: "a", title: "b".repeat(100) }], 50);
    expect(s).toContain("truncated");
  });
});

describe("buildSuggestMessages", () => {
  it("has a system prompt with the runtime contract and a user turn with data + instruction", () => {
    const m = buildSuggestMessages({ data: root, currentTemplate: "TPL", instruction: "  dark theme ", schema: "area, url:link" });
    expect(m[0].role).toBe("system");
    expect(m[0].content).toContain("data-search");
    expect(m[1].content).toContain("Schema (field order = child order): area, url:link");
    expect(m[1].content).toContain("url: string | undefined  // link URL");
    expect(m[1].content).toContain('"area": "desc"');
    expect(m[1].content).not.toContain("children");
    expect(m[1].content).toContain("Author's request: dark theme");
    expect(m[1].content).toContain("TPL");
  });
  it("omits the request line when no instruction", () => {
    expect(buildSuggestMessages({ data: root, currentTemplate: "", instruction: "", schema: "" })[1].content).not.toContain("Author's request");
  });
  it("treats the default template as no template", () => {
    const m = buildSuggestMessages({ data: root, currentTemplate: defaultTemplate(inferSchema(root)), instruction: "", schema: "" });
    expect(m[1].content).not.toContain("Current template");
    const m2 = buildSuggestMessages({ data: root, currentTemplate: "export default function X(){}", instruction: "", schema: "" });
    expect(m2[1].content).toContain("Current template");
  });
});

describe("validateSuggestRequest", () => {
  it("defaults non-string fields", () => {
    expect(validateSuggestRequest(null)).toEqual({ instruction: "", currentTemplate: "", schema: "" });
    expect(validateSuggestRequest({ instruction: 1, template: "t", schema: "a" })).toEqual({ instruction: "", currentTemplate: "t", schema: "a" });
  });
});

describe("extractTemplate", () => {
  it("strips <think> and code fences", () => {
    const out = extractTemplate("<think>hmm</think>\nHere:\n```jsx\nimport { data } from './data.js';\nexport default function P(){return <div/>}\n```\nEnjoy");
    expect(out).toEqual({ kind: "ok", template: "import { data } from './data.js';\nexport default function P(){return <div/>}\n" });
  });
  it("prepends the data import when missing", () => {
    const out = extractTemplate("export default function P(){return null}");
    expect(out.kind).toBe("ok");
    expect(out.kind === "ok" && out.template).toMatch(/^import \{ items, title \} from '\.\/data\.js';/);
  });
  it("reports non-code answers as none", () => {
    expect(extractTemplate("<think>...</think> I can't help.")).toEqual({ kind: "none" });
    expect(extractTemplate("")).toEqual({ kind: "none" });
  });
  it("reports a cut-off answer as truncated instead of returning the fence", () => {
    expect(extractTemplate("```jsx\nimport { data } from './data.js';\n\nexport default function Page()\n")).toEqual({ kind: "truncated" });
    expect(extractTemplate("<think>still thinking")).toEqual({ kind: "truncated" });
    expect(extractTemplate("```jsx\nexport default function P(){}\n```", { truncated: true })).toEqual({ kind: "truncated" });
  });
});
