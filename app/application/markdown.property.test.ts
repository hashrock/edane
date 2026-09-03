/**
 * modelToMarkdown → markdownToModel round trip. The Markdown side can only
 * carry text, nesting and the task checkbox (bold is stripped on the way in,
 * image/link/markdown kinds become their syntax), so the property is stated
 * over plain text nodes whose text contains no Markdown syntax.
 */
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import type { MindMapModel } from "../domain/model";
import { markdownToModel, modelToMarkdown } from "./markdown";
import { sequentialIds } from "../domain/model.arb";

type Plain = { text: string; checked?: boolean; children: Plain[] };

const word = fc.stringMatching(/^[a-zA-Z0-9]{1,6}$/);
const plainText = fc.array(word, { minLength: 1, maxLength: 3 }).map((w) => w.join(" "));

const plainArb: fc.Arbitrary<Plain> = fc.letrec<{ p: Plain }>((tie) => ({
  p: fc.record(
    {
      text: plainText,
      checked: fc.boolean(),
      children: fc.oneof(
        { depthSize: "small", withCrossShrink: true },
        fc.constant([] as Plain[]),
        fc.array(tie("p"), { maxLength: 3 })
      ),
    },
    { requiredKeys: ["text", "children"] }
  ),
})).p;

function toModel(p: Plain, path = "n"): MindMapModel {
  const node: MindMapModel = {
    id: path,
    text: p.text,
    children: p.children.map((c, i) => toModel(c, `${path}.${i}`)),
  };
  if (p.checked !== undefined) node.checked = p.checked;
  return node;
}

function toPlain(n: MindMapModel): Plain {
  const p: Plain = { text: n.text, children: n.children.map(toPlain) };
  if (n.checked !== undefined) p.checked = n.checked;
  return p;
}

describe("markdown round trip", () => {
  it("markdownToModel(modelToMarkdown(n)) is exactly the synthetic root over [n], ids drawn root-first in DFS order", () => {
    fc.assert(
      fc.property(plainArb, (plain) => {
        const md = modelToMarkdown(toModel(plain));
        const back = markdownToModel(md, sequentialIds());
        const next = sequentialIds();
        const expected = (p: Plain): MindMapModel => {
          const node: MindMapModel = { id: next(), text: p.text, children: [] };
          if (p.checked !== undefined) node.checked = p.checked;
          node.children = p.children.map(expected);
          return node;
        };
        expect(back).toEqual({ id: next(), text: "", children: [expected(plain)] });
        expect(back.children.map(toPlain)).toEqual([plain]);
      })
    );
  });
});
