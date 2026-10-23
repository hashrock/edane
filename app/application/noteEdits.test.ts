import { describe, it, expect } from "vitest";
import type { MindMapDocument } from "../domain/model";
import { sequentialIds } from "../domain/model.arb";
import { applyNoteEdit, documentFromMarkdown, documentToOutline, nodesFromMarkdown } from "./noteEdits";

const doc = (): MindMapDocument => ({
  title: "Plan",
  roots: [
    {
      id: "r",
      text: "Plan",
      children: [
        { id: "a", text: "A", children: [{ id: "a1", text: "A1", children: [] }], collapsed: true },
        { id: "b", text: "B", children: [], checked: false },
      ],
    },
    { id: "s", text: "Second", children: [], position: { x: 10, y: 20 } },
  ],
});

const ok = (r: ReturnType<typeof applyNoteEdit>) => {
  if (!r.ok) throw new Error(r.error);
  return r;
};

describe("documentToOutline", () => {
  it("keeps a multi-line text inside its item: continuation lines indented, the id on the bullet line", () => {
    const d = doc();
    d.roots[1].children.push({ id: "ml", text: "Hello, world\ntest", children: [] });
    const lines = documentToOutline(d).split("\n");
    expect(lines.slice(-2)).toEqual(["  - Hello, world {id=ml}", "    test"]);
    // Read back as Markdown, it's still one node — "test" doesn't become a node of its own.
    const second = nodesFromMarkdown(lines.slice(-3).join("\n").replace(/ \{id=[^}]+\}/g, ""));
    expect(second[0].children.map((c) => c.text)).toEqual(["Hello, world\ntest"]);
  });

  it("lists every node as Markdown with its id and folded state", () => {
    const d = doc();
    d.roots[1].children.push(
      { id: "l", text: "https://x.test", type: "link", linkTitle: "X", children: [] },
      { id: "m", text: "# h\nbody", type: "markdown", children: [] }
    );
    expect(documentToOutline(d)).toBe(
      [
        "# Plan",
        "- Plan {id=r}",
        "  - A {id=a} (collapsed)",
        "    - A1 {id=a1}",
        "  - [ ] B {id=b}",
        "- Second {id=s}",
        "  - [X](https://x.test) {id=l}",
        "  - # h body {id=m}",
      ].join("\n")
    );
  });
});

describe("documentFromMarkdown", () => {
  it("uses a single top-level item as the tree, and the title as root otherwise", () => {
    const single = documentFromMarkdown("T", "- Root\n  - child", sequentialIds());
    expect(single.roots.map((r) => r.text)).toEqual(["Root"]);
    expect(single.roots[0].children.map((c) => c.text)).toEqual(["child"]);

    const many = documentFromMarkdown("T", "- one\n- two", sequentialIds());
    expect(many.roots).toHaveLength(1);
    expect(many.roots[0].text).toBe("T");
    expect(many.roots[0].children.map((c) => c.text)).toEqual(["one", "two"]);

    const empty = documentFromMarkdown("T", "", sequentialIds());
    expect(empty.roots).toHaveLength(1);
    expect(empty.roots[0].text).toBe("T");
  });
});

describe("applyNoteEdit", () => {
  it("appends under parentId with fresh ids, expanding the parent", () => {
    const nodes = nodesFromMarkdown("- x\n  - y\n- [x] z", sequentialIds("md"));
    const r = ok(applyNoteEdit(doc(), { kind: "addNodes", parentId: "a", nodes }, sequentialIds()));
    const a = r.document.roots[0].children[0];
    expect(a.collapsed).toBe(false);
    expect(a.children.map((c) => c.text)).toEqual(["A1", "x", "z"]);
    expect(a.children[1].children.map((c) => c.text)).toEqual(["y"]);
    expect(a.children[2].checked).toBe(true);
    expect(r.nodeIds).toEqual([a.children[1].id, a.children[2].id]);
  });

  it("inserts after a nested node as siblings, and after a root as its children", () => {
    const nodes = nodesFromMarkdown("- x", sequentialIds("md"));
    const sib = ok(applyNoteEdit(doc(), { kind: "addNodes", afterId: "a", nodes }));
    expect(sib.document.roots[0].children.map((c) => c.text)).toEqual(["A", "x", "B"]);

    const root = ok(applyNoteEdit(doc(), { kind: "addNodes", afterId: "s", nodes }));
    expect(root.document.roots).toHaveLength(2);
    expect(root.document.roots[1].children.map((c) => c.text)).toEqual(["x"]);
  });

  it("defaults to the first root", () => {
    const nodes = nodesFromMarkdown("- x", sequentialIds("md"));
    const r = ok(applyNoteEdit(doc(), { kind: "addNodes", nodes }));
    expect(r.document.roots[0].children.map((c) => c.text)).toEqual(["A", "B", "x"]);
  });

  it("updates text and checkbox, and deletes whole subtrees", () => {
    const u = ok(applyNoteEdit(doc(), { kind: "updateNode", nodeId: "b", text: "B!", checked: true }));
    expect(u.document.roots[0].children[1]).toMatchObject({ text: "B!", checked: true });
    const cleared = ok(applyNoteEdit(u.document, { kind: "updateNode", nodeId: "b", checked: null }));
    expect(cleared.document.roots[0].children[1].checked).toBeUndefined();

    const del = ok(applyNoteEdit(doc(), { kind: "deleteNode", nodeId: "a" }));
    expect(del.document.roots[0].children.map((c) => c.id)).toEqual(["b"]);
  });

  it("keeps a root after the last one is deleted", () => {
    const one: MindMapDocument = { title: "T", roots: [{ id: "r", text: "R", children: [] }] };
    const r = ok(applyNoteEdit(one, { kind: "deleteNode", nodeId: "r" }, sequentialIds()));
    expect(r.document.roots).toHaveLength(1);
    expect(r.document.roots[0].id).not.toBe("r");
  });

  it("rejects unknown nodes, empty inserts and an ambiguous target", () => {
    const nodes = nodesFromMarkdown("- x");
    expect(applyNoteEdit(doc(), { kind: "deleteNode", nodeId: "nope" })).toEqual({ ok: false, error: "Node not found: nope" });
    expect(applyNoteEdit(doc(), { kind: "updateNode", nodeId: "nope", text: "x" }).ok).toBe(false);
    expect(applyNoteEdit(doc(), { kind: "addNodes", parentId: "nope", nodes }).ok).toBe(false);
    expect(applyNoteEdit(doc(), { kind: "addNodes", afterId: "nope", nodes }).ok).toBe(false);
    expect(applyNoteEdit(doc(), { kind: "addNodes", nodes: [] }).ok).toBe(false);
    expect(applyNoteEdit(doc(), { kind: "addNodes", parentId: "a", afterId: "b", nodes }).ok).toBe(false);
  });
});
