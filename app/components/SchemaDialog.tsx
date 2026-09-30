import { useEffect, useMemo, useRef, useState } from "react";
import { formatSchema, parseSchema } from "../domain/branchSchema";
import { inferSchema } from "../application/siteSchema";
import { toSiteNode } from "../application/siteNode";
import {
  addField,
  blankField,
  draftErrors,
  DRAFT_KINDS,
  fromDraft,
  moveField,
  removeField,
  ridSource,
  toDraft,
  updateField,
  type DraftField,
  type DraftKind,
} from "../application/schemaDraft";
import type { MindMapModel } from "../domain/model";
import { t } from "../application/i18n";
import { useLocale } from "./useLocale";

interface Props {
  /** スキーマを付ける枝（コレクション）。推定の下書きもここから作る。 */
  node: MindMapModel;
  /** `null` = スキーマを外す。 */
  onSave: (schema: string | null) => void;
  onClose: () => void;
}

type Tab = "fields" | "text";

/**
 * 枝のスキーマ編集ダイアログ。既定はフィールド行のリスト（キー・型・並び・
 * 並べ替え・入れ子）で、テキスト書式（domain/branchSchema.ts）のタブにも
 * 切り替えられる。どちらのタブも最後は同じ文字列として保存する。行の操作と
 * 検証は application/schemaDraft.ts。
 */
export default function SchemaDialog({ node, onSave, onClose }: Props) {
  useLocale();
  const rid = useRef(ridSource()).current;
  const initial = useMemo(() => parseSchema(node.schema ?? ""), [node.schema]);
  const inferred = useMemo(() => inferSchema(toSiteNode(node)), [node]);
  // 保存済みのスキーマが読めない（手で壊した）ときはテキストタブで開く。
  const [tab, setTab] = useState<Tab>(initial.ok ? "fields" : "text");
  const [draft, setDraft] = useState<DraftField[]>(() => (initial.ok ? toDraft(initial.schema, rid) : []));
  const [text, setText] = useState(node.schema ?? "");

  const errors = useMemo(() => draftErrors(draft), [draft]);
  const parsedText = useMemo(() => parseSchema(text), [text]);
  const valid = tab === "fields" ? errors.size === 0 : parsedText.ok;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  const switchTab = (next: Tab) => {
    if (next === tab) return;
    if (next === "text") {
      // 不正な行が残っていても、書いた内容はそのままテキストで見せる。
      setText(formatSchema(fromDraft(draft)));
    } else {
      if (!parsedText.ok) return; // 読めないテキストは行にできない（エラーを見せたまま留まる）
      setDraft(toDraft(parsedText.schema, rid));
    }
    setTab(next);
  };

  const save = () => {
    if (!valid) return;
    const schema = tab === "fields" ? fromDraft(draft) : parsedText.ok ? parsedText.schema : [];
    onSave(schema.length === 0 ? null : formatSchema(schema));
  };

  const adoptInferred = () => {
    setDraft(toDraft(inferred, rid));
    setText(formatSchema(inferred));
  };

  const renderRows = (rows: DraftField[], depth: number, parentRid: string | null) => (
    <>
      {rows.map((row, i) => {
        const error = errors.get(row.rid);
        return (
          <li key={row.rid} data-testid="schema-row">
            <div className="flex items-center gap-1.5" style={{ paddingLeft: depth * 20 }}>
              <div className="flex shrink-0 flex-col">
                <button
                  type="button"
                  aria-label={t("schemaMoveUp")}
                  disabled={i === 0}
                  onClick={() => setDraft((d) => moveField(d, row.rid, -1))}
                  className="h-3.5 text-[9px] leading-none text-slate-400 hover:text-slate-700 disabled:opacity-20"
                >
                  ▲
                </button>
                <button
                  type="button"
                  aria-label={t("schemaMoveDown")}
                  disabled={i === rows.length - 1}
                  onClick={() => setDraft((d) => moveField(d, row.rid, 1))}
                  className="h-3.5 text-[9px] leading-none text-slate-400 hover:text-slate-700 disabled:opacity-20"
                >
                  ▼
                </button>
              </div>
              <input
                value={row.key}
                onChange={(e) => setDraft((d) => updateField(d, row.rid, { key: e.target.value.trim() }))}
                placeholder={t("schemaKeyPlaceholder")}
                spellCheck={false}
                aria-invalid={!!error}
                data-testid="schema-key"
                className={`min-w-0 flex-1 rounded-md border px-2 py-1 font-mono text-sm outline-none ${
                  error ? "border-red-300 focus:border-red-500" : "border-slate-200 focus:border-slate-400"
                }`}
              />
              <select
                value={row.kind}
                onChange={(e) => setDraft((d) => updateField(d, row.rid, { kind: e.target.value as DraftKind }))}
                data-testid="schema-kind"
                className="shrink-0 rounded-md border border-slate-200 bg-white px-1.5 py-1 text-sm outline-none focus:border-slate-400"
              >
                {DRAFT_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {k === "records" ? t("schemaKindRecords") : k}
                  </option>
                ))}
              </select>
              <label className="flex shrink-0 items-center gap-1 text-xs text-slate-500">
                <input
                  type="checkbox"
                  checked={row.list}
                  disabled={row.kind === "records"}
                  onChange={(e) => setDraft((d) => updateField(d, row.rid, { list: e.target.checked }))}
                  data-testid="schema-list"
                />
                {t("schemaListLabel")}
              </label>
              <button
                type="button"
                aria-label={t("schemaRemoveField")}
                onClick={() => setDraft((d) => removeField(d, row.rid))}
                className="shrink-0 rounded px-1.5 text-slate-400 hover:bg-red-50 hover:text-red-600"
              >
                ✕
              </button>
            </div>
            {error && (
              <p className="mt-0.5 text-xs text-red-600" style={{ paddingLeft: depth * 20 + 22 }}>
                {error}
              </p>
            )}
            {row.kind === "records" && <ul className="mt-1 space-y-1">{renderRows(row.fields, depth + 1, row.rid)}</ul>}
          </li>
        );
      })}
      <li>
        <button
          type="button"
          onClick={() => setDraft((d) => addField(d, parentRid, blankField(rid)))}
          data-testid="schema-add"
          className="rounded-md px-2 py-0.5 text-xs text-slate-500 hover:bg-slate-100"
          style={{ marginLeft: depth * 20 + 22 }}
        >
          {t("schemaAddField")}
        </button>
      </li>
    </>
  );

  const tabButton = (value: Tab, label: string) => (
    <button
      type="button"
      role="tab"
      aria-selected={tab === value}
      onClick={() => switchTab(value)}
      disabled={value === "fields" && tab === "text" && !parsedText.ok}
      className={`rounded-md px-3 py-1 text-xs font-medium disabled:opacity-40 ${
        tab === value ? "bg-white text-slate-900 shadow-sm" : "text-slate-500 hover:text-slate-800"
      }`}
    >
      {label}
    </button>
  );

  const empty = tab === "fields" ? draft.length === 0 : text.trim() === "";

  return (
    <div
      className="anim-overlay fixed inset-0 z-50 flex items-center justify-center bg-slate-950/40 px-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={t("schemaDialogTitle")}
    >
      <div
        className="anim-modal flex max-h-[85vh] w-full max-w-lg flex-col rounded-2xl border border-slate-200 bg-white p-6 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-base font-bold tracking-tight text-slate-950">{t("schemaDialogTitle")}</h2>
            <p className="mt-1 truncate text-sm text-slate-500" title={node.text}>
              {node.text}
            </p>
          </div>
          <div role="tablist" className="flex shrink-0 rounded-lg bg-slate-100 p-0.5">
            {tabButton("fields", t("schemaTabFields"))}
            {tabButton("text", t("schemaTabText"))}
          </div>
        </div>
        <p className="mt-3 text-xs leading-relaxed text-slate-500">{t("schemaDialogHint")}</p>

        <div className="mt-3 min-h-0 flex-1 overflow-y-auto">
          {tab === "fields" ? (
            <>
              {draft.length === 0 && <p className="mb-2 text-xs text-slate-400">{t("schemaNoFields")}</p>}
              <ul className="space-y-1">{renderRows(draft, 0, null)}</ul>
            </>
          ) : (
            <>
              <p className="text-xs text-slate-400">{t("schemaDialogTypes")}</p>
              <textarea
                value={text}
                onChange={(e) => setText(e.target.value)}
                rows={4}
                spellCheck={false}
                placeholder={inferred.length ? t("schemaDialogPlaceholder", { schema: formatSchema(inferred) }) : undefined}
                data-testid="schema-input"
                className="mt-2 w-full resize-none rounded-lg border border-slate-200 px-3 py-2 font-mono text-sm outline-none focus:border-slate-400"
              />
              {!parsedText.ok && (
                <p className="mt-1 text-xs text-red-600" data-testid="schema-error">
                  {parsedText.error}
                </p>
              )}
            </>
          )}
          {empty && inferred.length > 0 && (
            <button type="button" onClick={adoptInferred} className="mt-2 text-xs text-slate-500 hover:underline">
              {t("schemaDialogAdopt")}: <code className="font-mono">{formatSchema(inferred)}</code>
            </button>
          )}
        </div>

        <div className="mt-6 flex items-center justify-end gap-3">
          {node.schema && (
            <button
              type="button"
              onClick={() => onSave(null)}
              className="mr-auto rounded-xl px-4 py-2 text-sm font-medium text-red-600 transition hover:bg-red-50"
            >
              {t("schemaDialogRemove")}
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            className="rounded-xl px-4 py-2 text-sm font-medium text-slate-600 transition hover:bg-slate-100"
          >
            {t("cancel")}
          </button>
          <button
            type="button"
            disabled={!valid}
            onClick={save}
            data-testid="schema-save"
            className="rounded-xl bg-slate-900 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-slate-700 disabled:opacity-40"
          >
            {t("schemaDialogSave")}
          </button>
        </div>
      </div>
    </div>
  );
}
