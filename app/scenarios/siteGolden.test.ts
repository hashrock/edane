/**
 * `site` シナリオの golden fixture（siteGolden.ts）が本物のビルドと一致することを
 * 固定する。ブラウザの Worker（components/siteCompiler.worker.ts）と同じ
 * `compileProject` + リセット CSS で、同じ入力（既定テンプレート × 枝データ）から
 * コンパイルする。ono は `new Function` と typescript しか使わないので Node でも走る。
 *
 * 更新: `UPDATE_GOLDEN=1 pnpm vitest run --project node app/scenarios/siteGolden.test.ts`
 */
import { describe, it, expect } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { compileProject } from "@hashrock/ono/browser/compiler";
import { SITE_GOLDEN } from "./siteGolden";
import { siteScenarioBranch } from "./fixtures";
import { toSiteNode } from "../application/siteNode";
import { defaultTemplate, inferSchema } from "../application/siteSchema";
import { SITE_DATA_FILE, SITE_ENTRY_FILE, siteDataModule } from "../application/siteTemplate";

const require = createRequire(import.meta.url);
const GOLDEN_PATH = fileURLToPath(new URL("./siteGolden.ts", import.meta.url));

async function realBuild() {
  let n = 0;
  const branch = siteScenarioBranch(() => `id-${++n}`);
  const data = toSiteNode(branch);
  const schema = inferSchema(data);
  const { html, css } = await compileProject(
    { [SITE_ENTRY_FILE]: defaultTemplate(schema), [SITE_DATA_FILE]: siteDataModule(data, schema) },
    SITE_ENTRY_FILE
  );
  const resetCss = readFileSync(require.resolve("@unocss/reset/tailwind.css"), "utf8");
  return { html, css: resetCss + css };
}

describe("site scenario golden fixture", () => {
  it("equals what the real compiler produces from the default template", async () => {
    const build = await realBuild();
    if (process.env.UPDATE_GOLDEN) {
      writeFileSync(
        GOLDEN_PATH,
        "// 生成物。手で編集しない。更新: UPDATE_GOLDEN=1 pnpm vitest run --project node app/scenarios/siteGolden.test.ts\n" +
          `export const SITE_GOLDEN = ${JSON.stringify(build, null, 2)};\n`
      );
    }
    expect(build.html).toBe(process.env.UPDATE_GOLDEN ? build.html : SITE_GOLDEN.html);
    expect(build.css).toBe(process.env.UPDATE_GOLDEN ? build.css : SITE_GOLDEN.css);
    expect((build.html.match(/data-card/g) ?? []).length).toBe(6);
    expect(build.html).toContain("data-search");
  });
});
