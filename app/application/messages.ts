/**
 * Application layer: the UI message catalog (ja / en).
 *
 * 日本語カタログ（MESSAGES_JA）がキーの正であり、英語カタログは
 * `satisfies Record<MessageKey, string>` で全キーの翻訳を強制する —
 * キーを足して片方の言語を書き忘れるとコンパイルエラーになる
 * （domain/model.ts の STORED_NODE_TYPE_SET と同じ網羅性イディオム）。
 *
 * 文言はコンポーネントに直書きせず、必ずここを経由して i18n.ts の `t()` で
 * 引く。`{name}` プレースホルダは `t(key, { name: value })` で差し込む。
 */

export const MESSAGES_JA = {
  // --- 共通 ---
  close: "閉じる",
  cancel: "キャンセル",
  copy: "コピー",
  copied: "コピーしました",
  untitled: "無題",
  loading: "読み込み中…",
  menu: "メニュー",

  // --- 保存ステータス行（useNoteEditor.SaveStatus） ---
  statusSaving: "保存中...",
  statusSaved: "保存済み",
  statusSaveFailed: "保存失敗",
  statusUploading: "画像アップロード中...",
  statusUploadFailed: "アップロード失敗",
  statusStorageLimit: "容量超過（上限10MB）",

  // --- 共有リンク（publicNoteLink） ---
  privateNoteCopyReason: "非公開のため共有できません",
  copyLinkSuccess: "リンクをコピーしました",
  copyLinkFailure: "コピーできませんでした",

  // --- キーマップ（editorKeymap のラベル; ShortcutHelp が表示） ---
  kmInsertSibling: "兄弟ノードを追加",
  kmStartEditing: "編集を開始",
  kmSelUpSibling: "前の兄弟へ（なければ親へ）",
  kmSelUpFlat: "上のノードへ",
  kmSelDownSibling: "次の兄弟へ（なければ枝の外へ）",
  kmSelDownFlat: "下のノードへ",
  kmSelChild: "子ノードへ",
  kmSelExpandOrChild: "展開 / 子ノードへ",
  kmSelParent: "親ノードへ",
  kmSelCollapseOrParent: "折りたたみ / 親ノードへ",
  kmInsertChild: "子ノードを挿入",
  kmIndent: "インデント",
  kmOutdent: "アウトデント",
  kmIndentOutdent: "インデント / アウトデント",
  kmDeleteNode: "ノードを削除",
  kmDeleteBranch: "ノードを枝ごと削除",
  kmShortcutList: "ショートカット一覧",
  kmCommandPalette: "コマンドパレット",
  kmUndo: "元に戻す",
  kmRedo: "やり直し",
  kmMoveNodeUp: "ノードを上へ移動",
  kmMoveNodeDown: "ノードを下へ移動",
  kmBold: "太字",
  kmToggleTask: "チェックボックスの完了 / 未完了",
  kmToggleCollapse: "折りたたみ / 展開",
  kmNewline: "改行",
  kmSplitNode: "ノードを分割 / 追加",
  kmExitEditing: "編集を終了",

  // --- ショートカットヘルプ ---
  helpTitle: "キーボードショートカット",
  helpGroupGlobal: "共通",
  helpGroupNode: "ノード操作",
  helpGroupSelection: "ノード選択中",
  helpGroupEditing: "テキスト編集中",

  // --- エディタ設定ダイアログ ---
  editorSettings: "エディタ設定",
  selectionModeLabel: "選択モードを使う",
  selectionModeDesc:
    "オフにすると常に編集モードになり、クリックした位置にカーソルが入ります。",
  alwaysEditHintPrefix: "常時編集モードの操作: 枝ごと削除は",
  alwaysEditHintCollapse: "、枝の開閉は",
  alwaysEditHintHelp: "、ショートカット一覧は",
  alwaysEditHintSuffix: "",
  tabKeyHeading: "選択中の Tab キー",
  enterKeyHeading: "選択中の Enter キー",
  arrowKeyHeading: "選択中の ← / → キー",
  tabIndentDesc: "選択ノードを直前のノードの子にする（Shift + Tab で戻す）",
  tabInsertChildDesc:
    "選択ノードの下に新しい子を作って編集を始める（Shift + Tab はアウトデント）",
  enterInsertSiblingDesc: "編集の開始は Space / F2 / ⌘/Ctrl + Enter",
  enterEditDesc: "兄弟ノードの追加は ⌘/Ctrl + Enter に移る",
  arrowCollapseLabel: "枝の開閉を優先",
  arrowCollapseDesc: "→ で展開、← で折りたたみ。開閉できないときは親子へ移動",
  arrowNavigateLabel: "親子への移動を優先",
  arrowNavigateDesc: "→ で子ノードへ、← で親ノードへ。開閉は ⌘/Ctrl + .",
  languageHeading: "言語 / Language",

  // --- コンテキストメニュー（MindmapEditor） ---
  nodeTypeText: "テキストにする",
  nodeTypeImage: "画像にする（URL）",
  nodeTypeLink: "リンクにする（URL）",
  nodeTypeMarkdown: "Markdownにする",
  menuOpenLink: "リンクを開く",
  menuFetchLinkMeta: "リンク情報を取得（タイトル/favicon）",
  menuAddChild: "子ノードを追加",
  menuAddRoot: "ここにルートを追加",
  menuExpand: "展開する",
  menuCollapse: "折りたたむ",
  menuBiggerText: "文字を大きく",
  menuSmallerText: "文字を小さく",
  menuResetTextSize: "標準サイズに戻す",
  menuBoldOn: "太字にする",
  menuBoldOff: "太字を解除",
  menuAddCheckbox: "チェックボックスを付ける",
  menuRemoveCheckbox: "チェックボックスを外す",
  menuCheckTask: "完了にする",
  menuUncheckTask: "未完了に戻す",
  outlineTaskDone: "完了にする",
  outlineTaskOpen: "未完了に戻す",
  menuUploadImage: "画像をアップロード",
  menuCopyBranchText: "枝をテキストコピー",
  menuPublishNode: "Web公開（JSON / Markdown）…",
  menuDeleteNode: "ノードを削除",

  // --- コマンドパレット ---
  cmdCopyAll: "すべてプレーンテキストでコピー",
  cmdCopyBranch: "選択した枝以下をテキストコピー",
  cmdPasteText: "プレーンテキストからペースト",
  cmdToggleCheckbox: "チェックボックスを付ける / 外す",
  cmdSendToChatGPT: "ChatGPTに送る",
  cmdShortcuts: "キーボードショートカット一覧",
  cmdEditorSettings: "エディタ設定",
  chatgptPrompt:
    "この箇条書きツリー形式のテキストデータを文章に整形してください。内容は「{title}」についてです。",
  paletteSearchPlaceholder: "コマンドを検索...",
  paletteNoMatch: "該当するコマンドがありません",

  // --- キャンバス（MindmapEditor） ---
  imageLoadError: "画像を読み込めません",
  mdLineCount: "{n}行",
  saveFailedTitle: "保存に失敗しました",
  leaveMessage:
    "未保存の変更があります。このまま移動すると変更が失われる可能性があります。移動しますか？",
  leaveConfirm: "移動する",
  leaveCancel: "とどまる",
  backToList: "一覧へ戻る",
  titlePlaceholderCanvas: "ノートのタイトル",
  editTitle: "タイトルを編集",
  saveToAccount: "アカウントに保存",
  dropImageHint: "画像をドロップしてアップロード",
  imageUrlLabel: "画像のURL",
  linkUrlLabel: "リンクのURL",

  // --- アウトラインエディタ ---
  titlePlaceholder: "タイトル",
  outlineExpand: "展開",
  outlineCollapse: "折りたたむ",
  outlineItem: "項目",
  imageUrlUnset: "画像URL未設定",
  emptyItem: "空の項目",
  addFirstItem: "＋ 最初の項目を追加",
  moveUpTitle: "上へ移動",
  moveDownTitle: "下へ移動",
  addItem: "項目を追加",
  deleteItem: "項目を削除",
  saveButton: "保存",

  // --- ビュー操作（ズーム） ---
  zoomOut: "ズームアウト",
  zoomIn: "ズームイン",
  zoomReset: "100%に戻す",

  // --- Markdownパネル ---
  mdView: "表示",
  mdEdit: "編集",
  mdEmpty: "空のMarkdownです。「編集」から内容を追加できます。",
  mdPlaceholder: "# 見出し\n\n- 箇条書き",

  // --- Markdownペーストダイアログ ---
  mdPasteDecompose: "分解してペースト",
  mdPasteDecomposeDesc: "見出しやリストの階層をノードツリーに展開します",
  mdPasteNode: "Markdownノードとしてペースト",
  mdPasteNodeDesc: "1つのMarkdownノードとしてそのまま貼り付けます",
  mdPastePlain: "プレーンテキストとして貼り付け",
  mdPastePlainDesc: "Markdown記法を解釈せず、行のインデントだけでノード化します",
  mdPasteAriaLabel: "Markdownの貼り付け方法",
  mdPasteDetected: "Markdownを検出しました",
  mdPasteChoose: "貼り付け方法を選んでください。",

  // --- ノードWeb公開ダイアログ ---
  publishError: "公開URLを発行できませんでした",
  publishDialogTitle: "ノードのWeb公開",
  publishToggleHint: "（右上の公開メニューから切り替えられます）",
  publishCreating: "公開URLを発行中…",
  publishNoteBeforeLink:
    "URLを知っている人は誰でもこの枝（ノードとその子孫）の最新内容を取得できます。JSONはCORS対応（他サイトのスクリプトから直接fetch可能）。公開中のURLの一覧は",
  publishNoteLinkText: "設定ページ",
  publishNoteAfterLink: "で管理できます。",
  publishRevoke: "公開を解除",
  // --- 公開サイト（JSXテンプレート） ---
  siteOpenEditor: "サイトを作る（実験的）",
  siteEditorTitle: "公開サイト",
  siteEditorHint:
    "この枝を JSX テンプレートで Web ページにします。data.js の `items` にスキーマで整形したレコード（title と各キー）、`data` に生の枝が入ります。<input data-search> と [data-card] を置くと検索が動きます。",
  siteTemplateLabel: "テンプレート（index.jsx）",
  sitePreviewLabel: "プレビュー",
  siteCompiling: "コンパイル中…",
  sitePublish: "公開する",
  sitePublishing: "公開中…",
  sitePublished: "公開しました",
  sitePublishFailed: "公開に失敗しました",
  siteNotPublished: "まだ公開されていません",
  sitePublicUrl: "公開URL",
  siteResetTemplate: "既定のテンプレートに戻す",
  siteBackToNote: "ノートに戻る",
  siteAiSuggest: "AIにデザインしてもらう",
  siteAiSuggesting: "AIが考え中…",
  siteAiInstructionPlaceholder: "希望があれば（例: ダークテーマ、写真を大きく、一覧は表で）",
  siteAiFailed: "AIの提案に失敗しました",
  siteAiUndo: "AI提案前に戻す",
  siteSchemaLabel: "スキーマ",
  siteSchemaPlaceholder: "推定: {schema}",
  siteSchemaHint:
    "フィールドの位置に名前を付けます（例: description, url:link, image:image, tags[]）。空なら実データから推定。テンプレートでは items[i].キー で読めます。",
  siteSchemaAdopt: "推定を採用",
  siteSchemaWarnings: "データとのずれ",

  // --- 公開ドロップダウン ---
  publicLabel: "公開",
  privateLabel: "非公開",
  copyLinkLabel: "リンクをコピー",

  // --- 設定ページ ---
  settingsHeadTitle: "設定",
  projectSettings: "プロジェクト設定",
  settingsBackToList: "← 一覧",
  accountHeading: "アカウント",
  nameUnset: "（名前未設定）",
  imageStorageHeading: "画像ストレージ",
  addImage: "画像を追加",
  uploadingImage: "アップロード中…",
  usage: "使用量",
  storageLimitExceededError: "容量上限（{limit}）を超えています",
  uploadFailed: "アップロードに失敗しました",
  noImages: "画像はまだありません",
  inactiveNoteTrashed: "停止中（ノートがゴミ箱にあります）",
  inactiveNotePrivate: "停止中（ノートが非公開です）",
  inactiveNodeMissing: "停止中（ノードが見つかりません）",
  publishedNodesHeading: "Web公開中のノード",
  noPublishedNodes:
    "Web公開中のノードはありません（エディタでノードを右クリック → 「Web公開」）",
  nodeMissing: "（ノードが見つかりません）",
  copyUrlTitle: "{label} URLをコピー",
  revoke: "解除",
  publicationsFootnote:
    "公開URLは枝（ノードとその子孫）の最新内容を JSON / Markdown で配信します。解除するとURLは無効になり、再公開すると新しいURLが発行されます。",
  apiTokensHeading: "APIトークン（デスクトップアプリ用）",
  createNew: "新規作成",
  tokenIssued: "トークンを発行しました（この画面でしか確認できません）",
  noTokens: "トークンはありません",
  deleteAction: "削除",

  // --- ノート一覧 ---
  trash: "ゴミ箱",
  settingsNav: "設定",
  logout: "ログアウト",
  loginWithGoogle: "Googleでログイン",
  landingTitle: "シンプルで軽快なアイデアノート",
  landingSubtitle:
    "思いついたことを、そのまま書いて広げる。ログイン不要ですぐ試せます。",
  guestEditorTitle: "ゲストエディタ",
  myNotes: "マイノート",
  newNoteButton: "+ 新規作成",
  searchByTitle: "タイトルで検索",
  noNotes: "ノートがありません。",
  noNotesMatch: "「{query}」に一致するノートはありません。",
  savingNote: "ノートを保存しています...",
  menuEditNote: "編集する",
  menuUnpin: "固定を解除",
  menuPin: "先頭に固定して表示",
  menuMoveToTrash: "ゴミ箱に移動",

  // --- ゴミ箱 ---
  backToMyNotes: "← マイノートへ",
  trashEmpty: "ゴミ箱は空です。",
  trashNote: "復元すればマイノートに戻ります。「完全に削除」は取り消せません。",
  deletedOn: "{date} に削除",
  restore: "復元",
  purge: "完全に削除",
  purgeConfirmTitle: "完全に削除しますか？",
  purgeConfirmMessage:
    "「{title}」を完全に削除します。この操作は取り消せません。",

  // --- 新規ノート ---
  newNoteHeadTitle: "新規ノート",
  newNoteHeading: "新しいノート",
  newNoteDesc: "タイトルはヘッダーに表示されます。ノードは後から追加できます。",
  titleLabel: "タイトル",
  titleExample: "例: プロジェクト計画",
  makePublic: "公開する",
  makePublicDesc: "リンクを知っている人が閲覧できます",
  creating: "作成中...",
  createAndEdit: "作成して編集",
  starterTopics: "トピック1\nトピック2",

  // --- アプリケーション層の文言 ---
  untitledMarkdown: "無題のMarkdown",
  mdHeadingFallback: "見出し",
  privateNotePublishReason:
    "非公開ノートのノードは公開できません。ノートを公開に切り替えてください。",

  // --- 初期サンプルノート（createDefaultModel） ---
  sampleUsage: "使い方",
  sampleClickToEdit: "ノードをクリックして編集",
  sampleEnter: "Enterで兄弟ノード追加",
  sampleTab: "Tabでインデント",
  sampleFeatures: "特徴",
  sampleRealtime: "リアルタイムプレビュー",
  sampleJson: "JSONベース",
  sampleSimple: "シンプル",
} as const;

/** カタログのキー。日本語カタログが正。 */
export type MessageKey = keyof typeof MESSAGES_JA;

export const MESSAGES_EN = {
  // --- Common ---
  close: "Close",
  cancel: "Cancel",
  copy: "Copy",
  copied: "Copied",
  untitled: "Untitled",
  loading: "Loading…",
  menu: "Menu",

  // --- Save status line ---
  statusSaving: "Saving...",
  statusSaved: "Saved",
  statusSaveFailed: "Save failed",
  statusUploading: "Uploading image...",
  statusUploadFailed: "Upload failed",
  statusStorageLimit: "Storage limit exceeded (10MB max)",

  // --- Share link ---
  privateNoteCopyReason: "Private notes can't be shared",
  copyLinkSuccess: "Link copied",
  copyLinkFailure: "Couldn't copy",

  // --- Keymap labels ---
  kmInsertSibling: "Add sibling node",
  kmStartEditing: "Start editing",
  kmSelUpSibling: "Previous sibling (or parent)",
  kmSelUpFlat: "Previous node",
  kmSelDownSibling: "Next sibling (or out of the branch)",
  kmSelDownFlat: "Next node",
  kmSelChild: "To child node",
  kmSelExpandOrChild: "Expand / to child node",
  kmSelParent: "To parent node",
  kmSelCollapseOrParent: "Collapse / to parent node",
  kmInsertChild: "Insert child node",
  kmIndent: "Indent",
  kmOutdent: "Outdent",
  kmIndentOutdent: "Indent / outdent",
  kmDeleteNode: "Delete node",
  kmDeleteBranch: "Delete node with its branch",
  kmShortcutList: "Keyboard shortcuts",
  kmCommandPalette: "Command palette",
  kmUndo: "Undo",
  kmRedo: "Redo",
  kmMoveNodeUp: "Move node up",
  kmMoveNodeDown: "Move node down",
  kmBold: "Bold",
  kmToggleTask: "Complete / reopen task",
  kmToggleCollapse: "Collapse / expand",
  kmNewline: "New line",
  kmSplitNode: "Split / add node",
  kmExitEditing: "Finish editing",

  // --- Shortcut help ---
  helpTitle: "Keyboard shortcuts",
  helpGroupGlobal: "General",
  helpGroupNode: "Node actions",
  helpGroupSelection: "While a node is selected",
  helpGroupEditing: "While editing text",

  // --- Editor settings dialog ---
  editorSettings: "Editor settings",
  selectionModeLabel: "Use selection mode",
  selectionModeDesc:
    "When off, the editor always stays in edit mode and clicks place the caret.",
  alwaysEditHintPrefix: "Always-edit mode: delete a branch with",
  alwaysEditHintCollapse: ", fold or unfold a branch with",
  alwaysEditHintHelp: ", and open the shortcut list with",
  alwaysEditHintSuffix: ".",
  tabKeyHeading: "Tab key while selected",
  enterKeyHeading: "Enter key while selected",
  arrowKeyHeading: "← / → keys while selected",
  tabIndentDesc:
    "Make the selected node a child of the previous node (Shift + Tab to undo)",
  tabInsertChildDesc:
    "Create a new child under the selected node and start editing (Shift + Tab still outdents)",
  enterInsertSiblingDesc: "Start editing with Space / F2 / ⌘/Ctrl + Enter",
  enterEditDesc: "Adding a sibling moves to ⌘/Ctrl + Enter",
  arrowCollapseLabel: "Prefer folding",
  arrowCollapseDesc:
    "→ expands, ← collapses; moves to parent/child when folding doesn't apply",
  arrowNavigateLabel: "Prefer parent/child navigation",
  arrowNavigateDesc: "→ moves to a child, ← to the parent; fold with ⌘/Ctrl + .",
  languageHeading: "Language / 言語",

  // --- Context menu ---
  nodeTypeText: "Convert to text",
  nodeTypeImage: "Convert to image (URL)",
  nodeTypeLink: "Convert to link (URL)",
  nodeTypeMarkdown: "Convert to Markdown",
  menuOpenLink: "Open link",
  menuFetchLinkMeta: "Fetch link info (title/favicon)",
  menuAddChild: "Add child node",
  menuAddRoot: "Add root here",
  menuExpand: "Expand",
  menuCollapse: "Collapse",
  menuBiggerText: "Larger text",
  menuSmallerText: "Smaller text",
  menuResetTextSize: "Reset to default size",
  menuBoldOn: "Bold",
  menuBoldOff: "Remove bold",
  menuAddCheckbox: "Add checkbox",
  menuRemoveCheckbox: "Remove checkbox",
  menuCheckTask: "Mark as done",
  menuUncheckTask: "Mark as not done",
  outlineTaskDone: "Mark as done",
  outlineTaskOpen: "Mark as not done",
  menuUploadImage: "Upload image",
  menuCopyBranchText: "Copy branch as text",
  menuPublishNode: "Publish to web (JSON / Markdown)…",
  menuDeleteNode: "Delete node",

  // --- Command palette ---
  cmdCopyAll: "Copy everything as plain text",
  cmdCopyBranch: "Copy selected branch as text",
  cmdPasteText: "Paste from plain text",
  cmdToggleCheckbox: "Add / remove checkbox",
  cmdSendToChatGPT: "Send to ChatGPT",
  cmdShortcuts: "Keyboard shortcuts",
  cmdEditorSettings: "Editor settings",
  chatgptPrompt:
    'Please turn this bullet-tree text into prose. It is about "{title}".',
  paletteSearchPlaceholder: "Search commands...",
  paletteNoMatch: "No matching commands",

  // --- Canvas (MindmapEditor) ---
  imageLoadError: "Failed to load image",
  // Fits the fixed MD_CARD_BADGE column (34px) — "{n} lines" would overflow.
  mdLineCount: "{n}L",
  saveFailedTitle: "Save failed",
  leaveMessage:
    "You have unsaved changes. They may be lost if you leave. Leave anyway?",
  leaveConfirm: "Leave",
  leaveCancel: "Stay",
  backToList: "Back to list",
  titlePlaceholderCanvas: "Note title",
  editTitle: "Edit title",
  saveToAccount: "Save to account",
  dropImageHint: "Drop an image to upload",
  imageUrlLabel: "Image URL",
  linkUrlLabel: "Link URL",

  // --- Outline editor ---
  titlePlaceholder: "Title",
  outlineExpand: "Expand",
  outlineCollapse: "Collapse",
  outlineItem: "Item",
  imageUrlUnset: "No image URL",
  emptyItem: "Empty item",
  addFirstItem: "＋ Add the first item",
  moveUpTitle: "Move up",
  moveDownTitle: "Move down",
  addItem: "Add item",
  deleteItem: "Delete item",
  saveButton: "Save",

  // --- View controls (zoom) ---
  zoomOut: "Zoom out",
  zoomIn: "Zoom in",
  zoomReset: "Reset to 100%",

  // --- Markdown panel ---
  mdView: "View",
  mdEdit: "Edit",
  mdEmpty: 'This Markdown is empty. Use "Edit" to add content.',
  mdPlaceholder: "# Heading\n\n- List item",

  // --- Markdown paste dialog ---
  mdPasteDecompose: "Decompose and paste",
  mdPasteDecomposeDesc: "Expands headings and list levels into a node tree",
  mdPasteNode: "Paste as a Markdown node",
  mdPasteNodeDesc: "Pastes everything as a single Markdown node",
  mdPastePlain: "Paste as plain text",
  mdPastePlainDesc:
    "Ignores Markdown syntax; builds nodes from line indentation only",
  mdPasteAriaLabel: "How to paste Markdown",
  mdPasteDetected: "Markdown detected",
  mdPasteChoose: "Choose how to paste it.",

  // --- Publish node dialog ---
  publishError: "Couldn't create the public URL",
  publishDialogTitle: "Publish node to web",
  publishToggleHint: "(You can switch it from the publish menu at the top right)",
  publishCreating: "Creating public URL…",
  publishNoteBeforeLink:
    "Anyone with the URL can fetch the latest content of this branch (the node and its descendants). JSON is CORS-enabled (fetchable directly from other sites' scripts). Manage your published URLs on the ",
  publishNoteLinkText: "settings page",
  publishNoteAfterLink: ".",
  publishRevoke: "Unpublish",
  siteOpenEditor: "Build a site (experimental)",
  siteEditorTitle: "Published site",
  siteEditorHint:
    "Turn this branch into a web page with a JSX template. `items` in data.js holds the records shaped by the schema (title + your keys); `data` is the raw branch. Add <input data-search> and [data-card] to get search.",
  siteTemplateLabel: "Template (index.jsx)",
  sitePreviewLabel: "Preview",
  siteCompiling: "Compiling…",
  sitePublish: "Publish",
  sitePublishing: "Publishing…",
  sitePublished: "Published",
  sitePublishFailed: "Publish failed",
  siteNotPublished: "Not published yet",
  sitePublicUrl: "Public URL",
  siteResetTemplate: "Reset to default template",
  siteBackToNote: "Back to note",
  siteAiSuggest: "Ask AI for a design",
  siteAiSuggesting: "AI is thinking…",
  siteAiInstructionPlaceholder: "Optional wishes (e.g. dark theme, bigger photos, a table layout)",
  siteAiFailed: "AI suggestion failed",
  siteAiUndo: "Undo AI suggestion",
  siteSchemaLabel: "Schema",
  siteSchemaPlaceholder: "Inferred: {schema}",
  siteSchemaHint:
    "Name the field positions (e.g. description, url:link, image:image, tags[]). Empty = inferred from the data. Templates read them as items[i].key.",
  siteSchemaAdopt: "Use inferred",
  siteSchemaWarnings: "Mismatches with the data",

  // --- Publicity dropdown ---
  publicLabel: "Public",
  privateLabel: "Private",
  copyLinkLabel: "Copy link",

  // --- Settings page ---
  settingsHeadTitle: "Settings",
  projectSettings: "Project Settings",
  settingsBackToList: "← Notes",
  accountHeading: "Account",
  nameUnset: "(no name set)",
  imageStorageHeading: "Image storage",
  addImage: "Add image",
  uploadingImage: "Uploading…",
  usage: "Usage",
  storageLimitExceededError: "Over the storage limit ({limit})",
  uploadFailed: "Upload failed",
  noImages: "No images yet",
  inactiveNoteTrashed: "Suspended (note is in the trash)",
  inactiveNotePrivate: "Suspended (note is private)",
  inactiveNodeMissing: "Suspended (node not found)",
  publishedNodesHeading: "Published nodes",
  noPublishedNodes:
    'No published nodes (right-click a node in the editor → "Publish to web")',
  nodeMissing: "(node not found)",
  copyUrlTitle: "Copy {label} URL",
  revoke: "Revoke",
  publicationsFootnote:
    "Public URLs serve the branch's (node and its descendants) latest content as JSON / Markdown. Revoking invalidates the URL; publishing again issues a new one.",
  apiTokensHeading: "API tokens (for the desktop app)",
  createNew: "Create new",
  tokenIssued: "Token created (it is only shown on this screen)",
  noTokens: "No tokens",
  deleteAction: "Delete",

  // --- Notes index ---
  trash: "Trash",
  settingsNav: "Settings",
  logout: "Log out",
  loginWithGoogle: "Sign in with Google",
  landingTitle: "A simple, snappy idea notebook",
  landingSubtitle:
    "Write ideas down as they come and grow them. Try it right away — no sign-in needed.",
  guestEditorTitle: "Guest editor",
  myNotes: "My Notes",
  newNoteButton: "+ New note",
  searchByTitle: "Search by title",
  noNotes: "No notes yet.",
  noNotesMatch: 'No notes match "{query}".',
  savingNote: "Saving note...",
  menuEditNote: "Edit",
  menuUnpin: "Unpin",
  menuPin: "Pin to top",
  menuMoveToTrash: "Move to trash",

  // --- Trash ---
  backToMyNotes: "← My Notes",
  trashEmpty: "The trash is empty.",
  trashNote:
    'Restored notes return to My Notes. "Delete forever" cannot be undone.',
  deletedOn: "Deleted {date}",
  restore: "Restore",
  purge: "Delete forever",
  purgeConfirmTitle: "Delete forever?",
  purgeConfirmMessage:
    '"{title}" will be permanently deleted. This cannot be undone.',

  // --- New note ---
  newNoteHeadTitle: "New note",
  newNoteHeading: "New note",
  newNoteDesc: "The title is shown in the header; nodes are added afterwards.",
  titleLabel: "Title",
  titleExample: "e.g. Project plan",
  makePublic: "Make public",
  makePublicDesc: "Anyone with the link can view it",
  creating: "Creating...",
  createAndEdit: "Create and edit",
  starterTopics: "Topic 1\nTopic 2",

  // --- Application-layer strings ---
  untitledMarkdown: "Untitled Markdown",
  mdHeadingFallback: "Heading",
  privateNotePublishReason:
    "Nodes of a private note can't be published. Switch the note to public first.",

  // --- Initial sample note (createDefaultModel) ---
  sampleUsage: "How to use",
  sampleClickToEdit: "Click a node to edit",
  sampleEnter: "Enter adds a sibling node",
  sampleTab: "Tab indents",
  sampleFeatures: "Features",
  sampleRealtime: "Real-time preview",
  sampleJson: "JSON-based",
  sampleSimple: "Simple",
} as const satisfies Record<MessageKey, string>;
