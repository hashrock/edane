/**
 * Property-based tests for `extractTemplate`（siteAi.ts）。
 *
 * モデル応答の後処理は「<think> を剥がす」「コードフェンスを剥がす」
 * 「data.js の import を補う」という3段の正規表現処理を順に通すだけの
 * 単純な関数に見えるが、境界（開いたまま閉じない <think> / フェンス、
 * 空応答、import の重複）を外すと壊れたコードを `ok` として返してしまう。
 * ここでは組み合わせを総当たりして、
 *
 *   1. `opts.truncated: true` は入力に関わらず必ず `truncated` になる
 *      （呼び出し側の「切れた」判定が最優先されるという契約そのもの）
 *   2. 空白だけの応答は（truncated 指定がなければ）必ず `none`
 *   3. 閉じない `<think>` は、その後に何が続いても `truncated`
 *   4. 閉じない ``` フェンスは（`<think>` が閉じている限り）必ず `truncated`
 *   5. `ok` になった結果は必ず data.js の import をちょうど1つだけ持ち、
 *      末尾に改行がある
 *
 * を確かめる。例示ベースの `siteAi.test.ts` は代表的な1ケースずつしか
 * 踏んでいなかった穴を埋める。
 */
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { extractTemplate } from "./siteAi";

/** `<think>` / フェンス / import の構造を壊さないための安全な埋め草文字列。 */
const safeText = () => fc.string({ maxLength: 24 }).map((s) => s.replace(/[<>`]/g, "_"));

const codeBodyArb = fc
  .tuple(fc.constantFrom("export default function Page(){return null;}", "function Page(){return null;}"), safeText(), safeText())
  .map(([code, before, after]) => `${before}\n${code}\n${after}`);

const fenceLangArb = fc.constantFrom("", "jsx", "tsx", "js", "javascript");

describe("extractTemplate", () => {
  it("opts.truncated forces `truncated` regardless of content", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 200 }), (response) => {
        expect(extractTemplate(response, { truncated: true })).toEqual({ kind: "truncated" });
      }),
      { numRuns: 300 }
    );
  });

  it("whitespace-only response is `none`", () => {
    fc.assert(
      fc.property(fc.stringMatching(/^[ \t\n]*$/), (response) => {
        expect(extractTemplate(response)).toEqual({ kind: "none" });
      }),
      { numRuns: 100 }
    );
  });

  it("an unclosed <think> is always `truncated`, whatever follows", () => {
    fc.assert(
      fc.property(fc.array(safeText(), { maxLength: 2 }), safeText(), safeText(), (closedFillers, openFiller, suffix) => {
        const closedBlocks = closedFillers.map((f) => `<think>${f}</think>`).join("\n");
        const response = `${closedBlocks}\n<think>${openFiller}\n${suffix}`;
        expect(extractTemplate(response)).toEqual({ kind: "truncated" });
      }),
      { numRuns: 300 }
    );
  });

  it("an unclosed code fence is always `truncated`", () => {
    fc.assert(
      fc.property(safeText(), fenceLangArb, safeText(), (prefix, lang, body) => {
        const response = `${prefix}\n\`\`\`${lang}\n${body}`;
        expect(extractTemplate(response)).toEqual({ kind: "truncated" });
      }),
      { numRuns: 300 }
    );
  });

  it("an `ok` result always carries exactly one data.js import and ends with a newline", () => {
    fc.assert(
      fc.property(codeBodyArb, fc.boolean(), fenceLangArb, (body, hasImport, lang) => {
        const content = hasImport ? `import { items, title } from './data.js';\n\n${body}` : body;
        const response = `\`\`\`${lang}\n${content}\n\`\`\``;
        const out = extractTemplate(response);
        expect(out.kind).toBe("ok");
        if (out.kind !== "ok") return;
        const importCount = (out.template.match(/from\s+['"]\.\/data\.js['"]/g) ?? []).length;
        expect(importCount).toBe(1);
        expect(out.template.endsWith("\n")).toBe(true);
      }),
      { numRuns: 300 }
    );
  });
});
