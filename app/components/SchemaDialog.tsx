import { useEffect, useMemo, useState } from "react";
import { formatSchema, parseSchema } from "../domain/branchSchema";
import { inferSchema } from "../application/siteSchema";
import { toSiteNode } from "../application/siteNode";
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

/**
 * 枝のスキーマ編集ダイアログ。書式は domain/branchSchema.ts。不正な間は保存
 * できず、理由を見せる。空欄のときは既存レコードから推定した下書きを
 * プレースホルダに出し、ワンクリックで採用できる。
 */
export default function SchemaDialog({ node, onSave, onClose }: Props) {
  useLocale();
  const [text, setText] = useState(node.schema ?? "");
  const parsed = useMemo(() => parseSchema(text), [text]);
  const inferred = useMemo(() => formatSchema(inferSchema(toSiteNode(node))), [node]);

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

  const save = () => {
    if (!parsed.ok) return;
    onSave(text.trim() === "" ? null : formatSchema(parsed.schema));
  };

  return (
    <div
      className="anim-overlay fixed inset-0 z-50 flex items-center justify-center bg-slate-950/40 px-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={t("schemaDialogTitle")}
    >
      <div
        className="anim-modal w-full max-w-lg rounded-2xl border border-slate-200 bg-white p-6 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-base font-bold tracking-tight text-slate-950">{t("schemaDialogTitle")}</h2>
        <p className="mt-1 truncate text-sm text-slate-500" title={node.text}>
          {node.text}
        </p>
        <p className="mt-3 text-xs leading-relaxed text-slate-500">{t("schemaDialogHint")}</p>
        <p className="mt-1 text-xs text-slate-400">{t("schemaDialogTypes")}</p>
        <textarea
          autoFocus
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              save();
            }
          }}
          rows={3}
          spellCheck={false}
          placeholder={inferred ? t("schemaDialogPlaceholder", { schema: inferred }) : undefined}
          data-testid="schema-input"
          className="mt-3 w-full resize-none rounded-lg border border-slate-200 px-3 py-2 font-mono text-sm outline-none focus:border-slate-400"
        />
        {!parsed.ok && (
          <p className="mt-1 text-xs text-red-600" data-testid="schema-error">
            {parsed.error}
          </p>
        )}
        {!text.trim() && inferred && (
          <button
            type="button"
            onClick={() => setText(inferred)}
            className="mt-1 text-xs text-slate-500 hover:underline"
          >
            {t("schemaDialogAdopt")}
          </button>
        )}
        <div className="mt-6 flex items-center justify-end gap-3">
          {node.schema && (
            <button
              type="button"
              onClick={() => onSave(null)}
              className="rounded-xl px-4 py-2 text-sm font-medium text-red-600 transition hover:bg-red-50"
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
            disabled={!parsed.ok}
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
