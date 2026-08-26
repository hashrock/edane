/**
 * JSX テンプレートを ono のブラウザコンパイラで静的 HTML/CSS にする Web Worker。
 * typescript（トランスパイラ）と UnoCSS をメインスレッドから隔離するためだけの
 * 薄い層。メッセージ形式は SiteEditor と対。
 *
 * 枝データ（data.js）はページの寿命中変わらないので `init` で一度だけ受け取り、
 * 以後の `compile` はテンプレートだけを運ぶ。
 *
 * リセット CSS は ono の Node ビルドと同じ @unocss/reset/tailwind.css を
 * ビルド成果物の先頭に含める（Uno のユーティリティは `*{border-style:solid;
 * border-width:0}` と border-box を前提にしている）。成果物に入れるので、
 * プレビューと公開ページが構造的に同じ CSS になる。
 */
import { compileProject } from "@hashrock/ono/browser/compiler";
import resetCss from "@unocss/reset/tailwind.css?raw";
import { SITE_DATA_FILE, SITE_ENTRY_FILE } from "../application/siteTemplate";

export type CompileRequest =
  | { type: "init"; dataModule: string }
  | { type: "compile"; id: number; template: string };
export type CompileResponse =
  | { id: number; ok: true; html: string; css: string }
  | { id: number; ok: false; error: string };

let dataModule = "";

self.onmessage = async (event: MessageEvent<CompileRequest>) => {
  const msg = event.data;
  if (msg.type === "init") {
    dataModule = msg.dataModule;
    return;
  }
  try {
    const { html, css } = await compileProject(
      { [SITE_ENTRY_FILE]: msg.template, [SITE_DATA_FILE]: dataModule },
      SITE_ENTRY_FILE
    );
    const res: CompileResponse = { id: msg.id, ok: true, html, css: resetCss + css };
    self.postMessage(res);
  } catch (e) {
    const res: CompileResponse = { id: msg.id, ok: false, error: e instanceof Error ? e.message : String(e) };
    self.postMessage(res);
  }
};
