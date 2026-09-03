import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "@inertiajs/react";
import {
  renderSiteResponse,
  siteDataModule,
  siteUrl,
  type SiteBuild,
} from "../application/siteTemplate";
import type { SiteNode } from "../application/siteNode";
import { parseSchema, inferSchema, formatSchema, shapeRecords, defaultTemplate } from "../application/siteSchema";
import { effectiveSchema } from "../application/siteAi";
import { t } from "../application/i18n";
import { copyText } from "../lib/clipboard";
import { useLocale } from "./useLocale";
import type { CompileRequest, CompileResponse } from "./siteCompiler.worker";

export interface SiteEditorProps {
  publicationId: string;
  noteId: string;
  /** 公開している枝（/pub/:id.json と同じ内容を薄くしたもの）。 */
  data: SiteNode;
  template: string;
  /** スキーマ文字列（siteSchema.ts の書式）。空なら推定。 */
  schema: string;
  /** サーバーに公開済みのビルドがあるか。 */
  published: boolean;
}

/** fetch → JSON の非同期操作の進行状態（公開・AI 提案で共通）。 */
type AsyncState =
  | { kind: "idle" }
  | { kind: "busy" }
  | { kind: "done" }
  | { kind: "error"; message: string };

/** `/api/sites/:id…` への JSON リクエスト。失敗時は `error` にサーバーの理由か fallback。 */
async function siteApi<T>(
  path: string,
  method: "PUT" | "POST",
  payload: unknown,
  fallback: string
): Promise<{ ok: true; body: T } | { ok: false; error: string }> {
  try {
    const res = await fetch(path, {
      method,
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const body = (await res.json().catch(() => ({}))) as T & { error?: string };
    return res.ok ? { ok: true, body } : { ok: false, error: body.error || fallback };
  } catch {
    return { ok: false, error: fallback };
  }
}

/**
 * 公開サイトの JSX エディタ。左にテンプレート、右にプレビュー（sandbox iframe）。
 * コンパイルは Web Worker（siteCompiler.worker.ts）で行い、「公開する」で
 * ビルド済み HTML/CSS をテンプレートごとサーバーに保存する。
 */
export default function SiteEditor({
  publicationId,
  noteId,
  data,
  template: initialTemplate,
  schema: initialSchema,
  published: initiallyPublished,
}: SiteEditorProps) {
  useLocale();
  const [template, setTemplate] = useState(initialTemplate);
  const [schemaText, setSchemaText] = useState(initialSchema);
  const [build, setBuild] = useState<SiteBuild | null>(null);
  const [compileError, setCompileError] = useState<string | null>(null);
  const [compiling, setCompiling] = useState(false);
  const [publish, setPublish] = useState<AsyncState>({ kind: "idle" });
  const [ai, setAi] = useState<AsyncState>({ kind: "idle" });
  const [aiInstruction, setAiInstruction] = useState("");
  /** AI 提案で上書きする直前のテンプレート（「戻す」用）。 */
  const [aiUndo, setAiUndo] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const published = initiallyPublished || publish.kind === "done";

  // スキーマ: 不正なら直前の有効なものではなく推定にフォールバックし、エラーだけ見せる。
  const inferredText = useMemo(() => formatSchema(inferSchema(data)), [data]);
  const parsedSchema = useMemo(() => parseSchema(schemaText), [schemaText]);
  const schemaError = parsedSchema.ok ? null : parsedSchema.error;
  const schema = useMemo(() => effectiveSchema(schemaText, data), [schemaText, data]);
  const schemaWarnings = useMemo(() => shapeRecords(data, schema).warnings, [data, schema]);
  const dataModule = useMemo(() => siteDataModule(data, schema), [data, schema]);
  const apiBase = `/api/sites/${encodeURIComponent(publicationId)}`;

  const workerRef = useRef<Worker | null>(null);
  const reqIdRef = useRef(0);

  useEffect(() => {
    const worker = new Worker(new URL("./siteCompiler.worker.ts", import.meta.url), {
      type: "module",
    });
    worker.onmessage = (e: MessageEvent<CompileResponse>) => {
      if (e.data.id !== reqIdRef.current) return; // 古い結果は捨てる
      setCompiling(false);
      if (e.data.ok) {
        setBuild({ html: e.data.html, css: e.data.css });
        setCompileError(null);
      } else {
        setCompileError(e.data.error);
      }
    };
    workerRef.current = worker;
    return () => worker.terminate();
  }, []);

  // データモジュール（枝 × スキーマ）が変わったら Worker に送り直してから再コンパイル。
  useEffect(() => {
    const worker = workerRef.current;
    if (!worker) return;
    const init: CompileRequest = { type: "init", dataModule };
    worker.postMessage(init);
    const id = ++reqIdRef.current;
    setCompiling(true);
    const timer = setTimeout(() => {
      const req: CompileRequest = { type: "compile", id, template };
      worker.postMessage(req);
    }, 400);
    return () => clearTimeout(timer);
  }, [template, dataModule]);

  const previewDoc = useMemo(
    () => (build ? renderSiteResponse(build, data.text).body : ""),
    [build, data.text]
  );

  const doPublish = useCallback(async () => {
    if (!build) return;
    setPublish({ kind: "busy" });
    const r = await siteApi(apiBase, "PUT", { template, schema: schemaText, ...build }, t("sitePublishFailed"));
    setPublish(r.ok ? { kind: "done" } : { kind: "error", message: r.error });
  }, [apiBase, build, template, schemaText]);

  const doSuggest = useCallback(async () => {
    setAi({ kind: "busy" });
    const r = await siteApi<{ template?: string }>(
      `${apiBase}/suggest`,
      "POST",
      { instruction: aiInstruction, template, schema: schemaText },
      t("siteAiFailed")
    );
    if (!r.ok || !r.body.template) {
      setAi({ kind: "error", message: r.ok ? t("siteAiFailed") : r.error });
      return;
    }
    setAiUndo(template);
    setTemplate(r.body.template);
    setAi({ kind: "done" });
  }, [apiBase, aiInstruction, template, schemaText]);

  const publicUrl = siteUrl(window.location.origin, publicationId);

  const onTemplateKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Tab") {
      e.preventDefault();
      const el = e.currentTarget;
      const { selectionStart, selectionEnd, value } = el;
      setTemplate(value.slice(0, selectionStart) + "  " + value.slice(selectionEnd));
      requestAnimationFrame(() => {
        el.selectionStart = el.selectionEnd = selectionStart + 2;
      });
    }
  };

  return (
    <div className="flex h-screen flex-col bg-slate-50 text-slate-950">
      <header className="flex items-center gap-3 border-b border-slate-200 bg-white px-4 py-2">
        <Link href={`/notes/${noteId}/edit`} className="text-sm text-slate-500 hover:underline">
          ← {t("siteBackToNote")}
        </Link>
        <h1 className="text-sm font-bold">
          {t("siteEditorTitle")}: <span className="font-normal text-slate-600">{data.text}</span>
        </h1>
        <div className="ml-auto flex items-center gap-2 text-xs">
          {published ? (
            <>
              <a href={publicUrl} target="_blank" rel="noopener" className="text-emerald-700 hover:underline" data-testid="site-url">
                {t("sitePublicUrl")}
              </a>
              <button
                type="button"
                onClick={() => void copyText(publicUrl).then((ok) => setCopied(ok))}
                className="rounded border border-slate-200 px-2 py-1 text-slate-600 hover:bg-slate-100"
              >
                {copied ? t("copied") : t("copy")}
              </button>
            </>
          ) : (
            <span className="text-slate-400">{t("siteNotPublished")}</span>
          )}
          {publish.kind === "error" && <span className="text-red-600">{publish.message}</span>}
          {publish.kind === "done" && <span className="text-emerald-700">{t("sitePublished")}</span>}
          <button
            type="button"
            disabled={!build || compiling || publish.kind === "busy"}
            onClick={() => void doPublish()}
            data-testid="site-publish"
            className="rounded-lg bg-slate-900 px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-40"
          >
            {publish.kind === "busy" ? t("sitePublishing") : t("sitePublish")}
          </button>
        </div>
      </header>
      <p className="border-b border-slate-200 bg-amber-50 px-4 py-1.5 text-xs text-amber-800">
        {t("siteEditorHint")}
      </p>
      <div className="border-b border-slate-200 bg-white px-3 py-1.5">
        <div className="flex items-center gap-2">
          <label className="shrink-0 text-xs font-medium text-slate-600" htmlFor="site-schema">
            {t("siteSchemaLabel")}
          </label>
          <input
            id="site-schema"
            value={schemaText}
            onChange={(e) => setSchemaText(e.target.value)}
            placeholder={t("siteSchemaPlaceholder", { schema: inferredText })}
            spellCheck={false}
            data-testid="site-schema"
            className="min-w-0 flex-1 rounded-lg border border-slate-200 px-2 py-1 font-mono text-xs outline-none focus:border-slate-400"
          />
          {!schemaText && inferredText && (
            <button
              type="button"
              onClick={() => setSchemaText(inferredText)}
              className="shrink-0 text-xs text-slate-500 hover:underline"
            >
              {t("siteSchemaAdopt")}
            </button>
          )}
        </div>
        {schemaError ? (
          <p className="mt-1 text-xs text-red-600" data-testid="site-schema-error">{schemaError}</p>
        ) : (
          <p className="mt-1 text-xs text-slate-400">{t("siteSchemaHint")}</p>
        )}
        {schemaWarnings.length > 0 && (
          <details className="mt-1 text-xs text-amber-700" data-testid="site-schema-warnings">
            <summary className="cursor-pointer">
              {t("siteSchemaWarnings")} ({schemaWarnings.length})
            </summary>
            <ul className="ml-4 list-disc">
              {schemaWarnings.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          </details>
        )}
      </div>
      <div className="flex items-center gap-2 border-b border-slate-200 bg-white px-3 py-1.5">
        <input
          value={aiInstruction}
          onChange={(e) => setAiInstruction(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && ai.kind !== "busy") void doSuggest();
          }}
          placeholder={t("siteAiInstructionPlaceholder")}
          data-testid="site-ai-instruction"
          className="min-w-0 flex-1 rounded-lg border border-slate-200 px-2 py-1 text-xs outline-none focus:border-slate-400"
        />
        <button
          type="button"
          disabled={ai.kind === "busy"}
          onClick={() => void doSuggest()}
          data-testid="site-ai-suggest"
          className="shrink-0 rounded-lg border border-violet-300 bg-violet-50 px-3 py-1 text-xs font-medium text-violet-800 hover:bg-violet-100 disabled:opacity-50"
        >
          {ai.kind === "busy" ? t("siteAiSuggesting") : `✨ ${t("siteAiSuggest")}`}
        </button>
        {aiUndo !== null && (
          <button
            type="button"
            onClick={() => {
              setTemplate(aiUndo);
              setAiUndo(null);
            }}
            className="shrink-0 text-xs text-slate-500 hover:underline"
          >
            {t("siteAiUndo")}
          </button>
        )}
        {ai.kind === "error" && <span className="text-xs text-red-600">{ai.message}</span>}
      </div>
      <div className="grid min-h-0 flex-1 grid-cols-2">
        <section className="flex min-h-0 flex-col border-r border-slate-200">
          <div className="flex items-center justify-between px-3 py-1 text-xs text-slate-500">
            <span>{t("siteTemplateLabel")}</span>
            <button type="button" onClick={() => setTemplate(defaultTemplate(schema))} className="hover:underline">
              {t("siteResetTemplate")}
            </button>
          </div>
          <textarea
            value={template}
            onChange={(e) => setTemplate(e.target.value)}
            onKeyDown={onTemplateKeyDown}
            spellCheck={false}
            data-testid="site-template"
            className="min-h-0 flex-1 resize-none bg-white p-3 font-mono text-xs leading-relaxed text-slate-800 outline-none"
          />
          {compileError && (
            <pre className="max-h-40 overflow-auto border-t border-red-200 bg-red-50 p-2 text-xs text-red-700" data-testid="site-error">
              {compileError}
            </pre>
          )}
        </section>
        <section className="flex min-h-0 flex-col">
          <div className="px-3 py-1 text-xs text-slate-500">
            {t("sitePreviewLabel")}
            {compiling && <span className="ml-2 text-slate-400">{t("siteCompiling")}</span>}
          </div>
          <iframe
            title={t("sitePreviewLabel")}
            sandbox="allow-scripts allow-popups"
            srcDoc={previewDoc}
            data-testid="site-preview"
            className="min-h-0 flex-1 border-0 bg-white"
          />
        </section>
      </div>
    </div>
  );
}
