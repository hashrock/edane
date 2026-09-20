/**
 * 各シナリオの計画を組み立てる純粋関数。DB・Hono に依存しない。
 *
 * 木はドメインの `MindMapModel` をそのまま組み立て、`ensureRoot` で
 * 「ルートを 1 つ以上」の不変条件を守る（CLAUDE.md）。
 */
import { ensureRoot, type IdSource, type MindMapDocument, type MindMapModel } from "../domain/model";
import { toSiteNode } from "../application/siteNode";
import { inferSchema, defaultTemplate } from "../application/siteSchema";
import { scenarioTitle, type PlannedNote, type ScenarioContext, type ScenarioPlan } from "./plan";
import { SITE_GOLDEN } from "./siteGolden";

// --- 木の組み立て ---

type NodeExtra = Omit<MindMapModel, "id" | "text" | "children">;

function node(nextId: IdSource, text: string, children: MindMapModel[] = [], extra: NodeExtra = {}): MindMapModel {
  return { id: nextId(), text, children, ...extra };
}

/** ドキュメント＝タイトル＋木の配列（CLAUDE.md「ドキュメントはルートの配列」）。 */
function document(nextId: IdSource, title: string, trees: MindMapModel[]): MindMapDocument {
  return ensureRoot({ title, roots: trees }, nextId);
}

function plannedNote(
  key: string,
  nextId: IdSource,
  title: string,
  trees: MindMapModel[],
  flags: Partial<Pick<PlannedNote, "isPublic" | "pinned" | "trashed">> = {}
): PlannedNote {
  return {
    key,
    id: nextId(),
    title,
    model: document(nextId, title, trees),
    isPublic: flags.isPublic ?? false,
    pinned: flags.pinned ?? false,
    trashed: flags.trashed ?? false,
  };
}

/** 外部へ取りに行かない画像（160x90 の SVG data URI）。image ノードの描画確認用。 */
export const INLINE_IMAGE_URL =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="90"><rect width="160" height="90" fill="#0f766e"/><circle cx="80" cy="45" r="28" fill="#99f6e4"/></svg>'
  );

const SAMPLE_MARKDOWN = `## 議事メモ

- 決定: 来週リリース
- 保留: **ログイン画面**の文言

\`\`\`ts
const answer = 42;
\`\`\`
`;

// --- シナリオ ---

/** まっさら：空のルート 1 つだけの新規ノート。 */
export function buildEmpty({ tag, nextId }: ScenarioContext): ScenarioPlan {
  const main = plannedNote("main", nextId, scenarioTitle("empty", tag), []);
  return { notes: [main], publications: [], sites: [], redirect: `/notes/${main.id}/edit` };
}

/** ふつうの利用状態：全ノード種別・チェックボックス・折りたたみ・複数の木 + 一覧に並ぶ数件のノート。 */
export function buildTypical({ tag, nextId }: ScenarioContext): ScenarioPlan {
  const main = plannedNote("main", nextId, scenarioTitle("typical", tag), [
    node(nextId, "プロジェクト計画", [
      node(
        nextId,
        "目標",
        [node(nextId, "9 月中にベータ公開"), node(nextId, "初週で 100 ユーザー")],
        { bold: true, fontSize: 18 }
      ),
      node(nextId, "タスク", [
        node(nextId, "要件をまとめる", [], { checked: true }),
        node(nextId, "画面を作る", [], { checked: false }),
        node(nextId, "テストを書く", [], { checked: false }),
      ]),
      node(nextId, "参考", [
        node(nextId, "https://example.com/", [], { type: "link", linkTitle: "Example Domain" }),
        node(nextId, INLINE_IMAGE_URL, [], { type: "image" }),
        node(nextId, SAMPLE_MARKDOWN, [], { type: "markdown" }),
      ]),
    ]),
    node(nextId, "アイデア（折りたたみ済み）", [node(nextId, "隠れている子 1"), node(nextId, "隠れている子 2")], {
      collapsed: true,
    }),
  ]);
  const pinned = plannedNote(
    "pinned",
    nextId,
    scenarioTitle("typical", tag, "(pinned)"),
    [node(nextId, "ピン留めされたノート", [node(nextId, "一覧の先頭に出る")])],
    { pinned: true }
  );
  const publicNote = plannedNote(
    "public",
    nextId,
    scenarioTitle("typical", tag, "(public)"),
    [node(nextId, "公開ノート", [node(nextId, "ログインなしで /notes/:id が見える")])],
    { isPublic: true }
  );
  return {
    notes: [main, pinned, publicNote],
    publications: [],
    sites: [],
    redirect: `/notes/${main.id}/edit`,
  };
}

export const LARGE_WIDE_CHILDREN = 40;
export const LARGE_DEPTH = 15;
export const LARGE_LIST_NOTES = 20;

const LONG_JA =
  "この文はレイアウトの折り返しを確認するための長い文章で、句読点をほとんど含まずに延々と続くことでノードの幅の上限と行送りが正しく働くかを試すものです。".repeat(3);
const LONG_TOKEN = "Supercalifragilisticexpialidocious".repeat(8);

/** 件数が多い・深い・長文：広い木、深い木、長文と長い Markdown、位置固定の木、一覧を埋める多数のノート。 */
export function buildLarge({ tag, nextId }: ScenarioContext): ScenarioPlan {
  const wide = node(
    nextId,
    "広い木",
    Array.from({ length: LARGE_WIDE_CHILDREN }, (_, i) =>
      node(nextId, `項目 ${String(i + 1).padStart(2, "0")}`, [node(nextId, "詳細 a"), node(nextId, "詳細 b")])
    )
  );

  let deep = node(nextId, `深さ ${LARGE_DEPTH}`);
  for (let d = LARGE_DEPTH - 1; d >= 1; d--) deep = node(nextId, `深さ ${d}`, [deep]);

  const longText = node(nextId, "長文", [
    node(nextId, LONG_JA),
    node(nextId, LONG_TOKEN),
    node(nextId, SAMPLE_MARKDOWN.repeat(6), [], { type: "markdown" }),
  ]);

  const placed = node(nextId, "位置固定の木", [node(nextId, "position を持つルート")], {
    position: { x: 1200, y: 40 },
  });

  const main = plannedNote("main", nextId, scenarioTitle("large", tag), [wide, deep, longText, placed]);
  const filler = Array.from({ length: LARGE_LIST_NOTES }, (_, i) =>
    plannedNote(
      `list-${i + 1}`,
      nextId,
      scenarioTitle("large", tag, `#${String(i + 1).padStart(2, "0")} ${i % 3 === 0 ? LONG_TOKEN.slice(0, 80) : "list filler"}`),
      [node(nextId, `一覧を埋めるノート ${i + 1}`)],
      { isPublic: i % 4 === 0 }
    )
  );
  return {
    notes: [main, ...filler],
    publications: [],
    sites: [],
    redirect: `/notes/${main.id}/edit`,
  };
}

/** ゴミ箱：削除済みノートが 2 件（非公開 / 公開）。 */
export function buildTrash({ tag, nextId }: ScenarioContext): ScenarioPlan {
  const privateNote = plannedNote(
    "private",
    nextId,
    scenarioTitle("trash", tag, "(private)"),
    [node(nextId, "ゴミ箱の非公開ノート", [node(nextId, "復元できる")])],
    { trashed: true }
  );
  const publicNote = plannedNote(
    "public",
    nextId,
    scenarioTitle("trash", tag, "(public)"),
    [node(nextId, "ゴミ箱の公開ノート", [node(nextId, "ゴミ箱に入ると公開 URL も 404")])],
    { trashed: true, isPublic: true }
  );
  return { notes: [privateNote, publicNote], publications: [], sites: [], redirect: "/trash" };
}

/** 公開サイト向けの枝：2 階層目 = レコード、3 階層目 = フィールド（説明・URL・画像・タグ）。 */
function catalogBranch(nextId: IdSource, count: number): MindMapModel {
  return node(
    nextId,
    "おすすめの道具",
    Array.from({ length: count }, (_, i) =>
      node(nextId, `道具 ${i + 1}`, [
        node(nextId, `${i + 1} 番目の道具の説明。短い一文で特徴を述べる。`),
        node(nextId, `https://example.com/tools/${i + 1}`, [], { type: "link" }),
        node(nextId, INLINE_IMAGE_URL, [], { type: "image" }),
        node(nextId, "タグ", [node(nextId, "定番"), node(nextId, i % 2 ? "屋外" : "屋内")]),
      ])
    )
  );
}

/** 公開ノート + 枝のノード公開（/pub/:id.json・.md）。サイトはまだ無い。 */
export function buildPublic({ tag, nextId }: ScenarioContext): ScenarioPlan {
  const branch = catalogBranch(nextId, 3);
  const main = plannedNote(
    "main",
    nextId,
    scenarioTitle("public", tag),
    [node(nextId, "公開ノート", [node(nextId, "この枝はノード公開されている →")]), branch],
    { isPublic: true }
  );
  const publication = { id: nextId(), noteId: main.id, nodeId: branch.id };
  return { notes: [main], publications: [publication], sites: [], redirect: `/notes/${main.id}` };
}

/** `site` シナリオが公開する枝。golden fixture（siteGolden.ts）はこの枝から作られる。 */
export const SITE_SCENARIO_RECORDS = 6;
export function siteScenarioBranch(nextId: IdSource): MindMapModel {
  return catalogBranch(nextId, SITE_SCENARIO_RECORDS);
}

/**
 * 公開済みサイト：公開ノート + ノード公開 + ビルド済みサイト（/sites/:pubId で配信される）。
 *
 * HTML/CSS は本物のコンパイラ（ono + UnoCSS。ブラウザの Worker と同じ
 * `compileProject`）で既定テンプレートから作った golden fixture。
 * siteGolden.test.ts が毎回コンパイルし直して一致を確かめるので、テンプレートや
 * コンパイラが変わればテストが落ちて `UPDATE_GOLDEN=1` で更新することになる。
 * 既定テンプレートは item.id を描かないので、ID が毎回違っても出力は同じ。
 */
export function buildSite({ tag, nextId }: ScenarioContext): ScenarioPlan {
  const branch = siteScenarioBranch(nextId);
  const main = plannedNote("main", nextId, scenarioTitle("site", tag), [branch], { isPublic: true });
  const publication = { id: nextId(), noteId: main.id, nodeId: branch.id };
  const site = {
    publicationId: publication.id,
    template: defaultTemplate(inferSchema(toSiteNode(branch))),
    schema: "",
    html: SITE_GOLDEN.html,
    css: SITE_GOLDEN.css,
  };
  return {
    notes: [main],
    publications: [publication],
    sites: [site],
    redirect: `/sites/${publication.id}/edit`,
  };
}
