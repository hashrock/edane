import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { scopeUserCss } from "./scopedCss";

const scope = ".wp-root";
const wrap = (inner: string) => `@scope (${scope}) {\n${inner}}\n`;

describe("scopeUserCss", () => {
  it("wraps rules in @scope", () => {
    expect(scopeUserCss(".wp-heading { color: red; }", scope)).toBe(wrap(".wp-heading { color: red; }\n"));
  });

  it("is empty for blank or comment-only CSS", () => {
    expect(scopeUserCss("", scope)).toBe("");
    expect(scopeUserCss("  /* nothing */ ", scope)).toBe("");
  });

  it("drops CSS whose braces don't balance (a stray } would close the scope)", () => {
    expect(scopeUserCss(".a { color: red; } } body { display: none }", scope)).toBe("");
    expect(scopeUserCss(".a { color: red;", scope)).toBe("");
    expect(scopeUserCss('.a { content: "}" } }', scope)).toBe("");
  });

  it("counts braces in strings, comments and escapes as text", () => {
    expect(scopeUserCss('.a::after { content: "}{"; }', scope)).toBe(wrap('.a::after { content: "}{"; }\n'));
    expect(scopeUserCss(".a { /* } */ color: red; }", scope)).toBe(wrap(".a {   color: red; }\n"));
    expect(scopeUserCss(".a\\} { color: red; }", scope)).toBe(wrap(".a\\} { color: red; }\n"));
    expect(scopeUserCss(".a\\{ } } body { display: none }", scope)).toBe("");
  });

  it("drops unterminated strings and comments", () => {
    expect(scopeUserCss('.a { content: "x }', scope)).toBe("");
    expect(scopeUserCss(".a { color: red } /* x", scope)).toBe("");
  });

  it("removes disallowed at-rules, keeps group rules (filtered) and hoists keyframes under a prefixed name", () => {
    const css = `@import url(https://evil.example/x.css);
@font-face { font-family: X; src: url(https://evil.example/x.woff); }
@scope (body) { * { display: none } }
@media (max-width: 600px) { .a { color: red; } @import "y.css"; }
@keyframes spin { from { transform: rotate(0) } to { transform: rotate(1turn) } }
.b { animation: spin 1s; }`;
    const out = scopeUserCss(css, scope);
    expect(out).not.toMatch(/@import|@font-face|evil|body/);
    expect(out.startsWith("@keyframes wpu-spin {")).toBe(true);
    expect(out).toContain(`@scope (${scope}) {\n@media (max-width: 600px) {\n.a { color: red; }\n}\n.b { animation: wpu-spin 1s; }\n}`);
  });

  it("never defines a keyframe name the app could be using", () => {
    const out = scopeUserCss("@keyframes spin { to { opacity: 0 } } .b { animation-name: spin, pulse; animation: 1s spin infinite }", scope);
    expect(out).not.toMatch(/@keyframes spin/);
    expect(out).toContain("animation-name: wpu-spin, pulse;");
    expect(out).toContain("animation: 1s wpu-spin infinite");
    expect(scopeUserCss('@keyframes "spin" { to { opacity: 0 } }', scope)).toBe("");
  });

  it("drops escaped at-keywords instead of reading them as style rules", () => {
    expect(scopeUserCss("@\\73 cope (html) { body { display: none } }", scope)).toBe("");
    expect(scopeUserCss("@m\\65 dia all { body { display: none } }", scope)).toBe("");
    expect(scopeUserCss("@\\69mport url(https://evil.example/x.css);", scope)).toBe("");
  });

  it("filters at-rules nested in style rules", () => {
    const out = scopeUserCss(".x { color: red; @scope (body) { * { display: none } } @media (x) { color: blue; } }", scope);
    expect(out).not.toMatch(/@scope \(body\)|display: none/);
    expect(out).toContain(".x { color: red;  @media (x) {\n color: blue; } }");
  });

  it("escapes < so the text can't close its <style> element", () => {
    const out = scopeUserCss('.a::after { content: "</style><script>alert(1)</script>"; }', scope);
    expect(out).not.toContain("<");
    expect(out).toContain("\\3c /style>");
  });

  it("never emits < and always confines output to one @scope (plus hoisted keyframes)", () => {
    const alphabet = fc.constantFrom("{", "}", ";", "@", '"', "'", "\\", "/", "*", "<", " ", "a", ".x", "import ", "keyframes ", "media ", "scope ", "\n");
    fc.assert(
      fc.property(fc.array(alphabet, { maxLength: 40 }).map((xs) => xs.join("")), (css) => {
        const out = scopeUserCss(css, scope);
        expect(out).not.toContain("<");
        if (out === "") return;
        expect(out.endsWith("}\n")).toBe(true);
        expect(out).toContain(`@scope (${scope}) {\n`);
        // Before the scope, only hoisted @keyframes.
        const before = out.slice(0, out.lastIndexOf(`@scope (${scope}) {\n`));
        for (const line of before.split("\n").filter((l) => /^@/.test(l))) expect(line).toMatch(/^@(-webkit-)?keyframes/i);
      })
    );
  });
});
