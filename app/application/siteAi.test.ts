import { describe, it, expect } from "vitest";
import { buildSuggestMessages, extractTemplate, sampleSiteData, validateSuggestRequest } from "./siteAi";
import { DEFAULT_SITE_TEMPLATE } from "./siteTemplate";
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

describe("sampleSiteData", () => {
  it("keeps type/text/children, caps the top-level list and drops ids", () => {
    const s = sampleSiteData(root);
    expect(s).not.toContain('"id"');
    expect(s).toContain('"Item 5"');
    expect(s).not.toContain('"Item 6"');
    expect(s).toContain("(+4 more)");
    expect(s).toContain('"link"');
  });
  it("truncates to maxChars", () => {
    expect(sampleSiteData(root, 100).length).toBeLessThan(140);
    expect(sampleSiteData(root, 100)).toContain("truncated");
  });
});

describe("buildSuggestMessages", () => {
  it("has a system prompt with the runtime contract and a user turn with data + instruction", () => {
    const m = buildSuggestMessages({ data: root, currentTemplate: "TPL", instruction: "  dark theme " });
    expect(m[0].role).toBe("system");
    expect(m[0].content).toContain("data-search");
    expect(m[1].content).toContain("Author's request: dark theme");
    expect(m[1].content).toContain("TPL");
  });
  it("omits the request line when no instruction", () => {
    expect(buildSuggestMessages({ data: root, currentTemplate: "", instruction: "" })[1].content).not.toContain("Author's request");
  });
  it("treats the default template as no template", () => {
    const m = buildSuggestMessages({ data: root, currentTemplate: DEFAULT_SITE_TEMPLATE, instruction: "" });
    expect(m[1].content).not.toContain("Current template");
    const m2 = buildSuggestMessages({ data: root, currentTemplate: "export default function X(){}", instruction: "" });
    expect(m2[1].content).toContain("Current template");
  });
});

describe("validateSuggestRequest", () => {
  it("defaults non-string fields", () => {
    expect(validateSuggestRequest(null)).toEqual({ instruction: "", currentTemplate: "" });
    expect(validateSuggestRequest({ instruction: 1, template: "t" })).toEqual({ instruction: "", currentTemplate: "t" });
  });
});

describe("extractTemplate", () => {
  it("strips <think> and code fences", () => {
    const out = extractTemplate("<think>hmm</think>\nHere:\n```jsx\nimport { data } from './data.js';\nexport default function P(){return <div/>}\n```\nEnjoy");
    expect(out).toBe("import { data } from './data.js';\nexport default function P(){return <div/>}\n");
  });
  it("prepends the data import when missing", () => {
    expect(extractTemplate("export default function P(){return null}")).toMatch(/^import \{ data \} from '\.\/data\.js';/);
  });
  it("returns null for non-code answers", () => {
    expect(extractTemplate("<think>...</think> I can't help.")).toBeNull();
    expect(extractTemplate("")).toBeNull();
  });
});
