import { useMemo, useState, useEffect, useRef } from "react";
import { renderMarkdownHtml } from "../lib/markdownHtml";

interface Props {
  /** The markdown source to show / edit. */
  source: string;
  /** Persist an edit to the source. */
  onChange: (next: string) => void;
  /** Close the panel. */
  onClose: () => void;
}

/**
 * Right-side drawer that renders a markdown node's full document as sanitized
 * HTML (view) or exposes the raw source for editing (edit). Only one is ever
 * open, so — unlike an always-on per-node overlay — it needs no canvas position
 * sync: it's a fixed panel, not pinned to the node.
 */
export default function MarkdownPanel({ source, onChange, onClose }: Props) {
  const [mode, setMode] = useState<"view" | "edit">("view");
  const [draft, setDraft] = useState(source);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Keep the draft in sync when the panel is pointed at a different node.
  useEffect(() => {
    setDraft(source);
  }, [source]);

  useEffect(() => {
    if (mode === "edit") textareaRef.current?.focus();
  }, [mode]);

  // Close on Escape from anywhere in the panel.
  const html = useMemo(() => renderMarkdownHtml(source), [source]);

  const commit = (next: string) => {
    setDraft(next);
    onChange(next);
  };

  return (
    <div
      data-testid="md-panel"
      className="absolute right-0 top-0 z-30 flex h-full w-full max-w-[420px] flex-col border-l border-slate-200 bg-white shadow-2xl"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          onClose();
        }
      }}
    >
      <header className="flex shrink-0 items-center gap-2 border-b border-slate-200 px-4 py-2.5">
        <span className="text-sm font-semibold text-slate-700">Markdown</span>
        <div className="ml-auto flex items-center gap-1">
          <div className="flex rounded-lg bg-slate-100 p-0.5 text-xs font-medium">
            <button
              type="button"
              onClick={() => setMode("view")}
              className={`rounded-md px-2.5 py-1 ${
                mode === "view"
                  ? "bg-white text-slate-900 shadow-sm"
                  : "text-slate-500 hover:text-slate-700"
              }`}
            >
              表示
            </button>
            <button
              type="button"
              onClick={() => setMode("edit")}
              className={`rounded-md px-2.5 py-1 ${
                mode === "edit"
                  ? "bg-white text-slate-900 shadow-sm"
                  : "text-slate-500 hover:text-slate-700"
              }`}
            >
              編集
            </button>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="閉じる"
            className="rounded-md px-2 py-1 text-lg leading-none text-slate-400 hover:bg-slate-100 hover:text-slate-600"
          >
            ×
          </button>
        </div>
      </header>

      {mode === "view" ? (
        html ? (
          <div
            data-testid="md-panel-body"
            className="md-body flex-1 overflow-y-auto px-5 py-4"
            // Sanitized by renderMarkdownHtml (DOMPurify) before it reaches here.
            dangerouslySetInnerHTML={{ __html: html }}
          />
        ) : (
          <div className="flex-1 px-5 py-4 text-sm text-slate-400">
            空のMarkdownです。「編集」から内容を追加できます。
          </div>
        )
      ) : (
        <textarea
          ref={textareaRef}
          value={draft}
          onChange={(e) => commit(e.target.value)}
          spellCheck={false}
          className="flex-1 resize-none px-5 py-4 font-mono text-sm text-slate-800 outline-none"
          placeholder="# 見出し&#10;&#10;- 箇条書き"
        />
      )}
    </div>
  );
}
