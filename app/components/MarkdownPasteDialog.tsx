import { useEffect } from "react";

interface Props {
  open: boolean;
  /** A short preview of the detected Markdown (first lines). */
  preview?: string;
  /** 分解ペースト: split the Markdown into a node subtree. */
  onDecompose: () => void;
  /** Markdownノードとしてペースト: keep it as a single Markdown source node. */
  onAsNode: () => void;
  /** プレーンテキストとして貼り付け: paste verbatim, no Markdown interpretation. */
  onPlain: () => void;
  onCancel: () => void;
}

/**
 * Choice dialog shown when pasted content looks like Markdown. Offers the three
 * paste strategies requested by the feature; Escape (or the backdrop) cancels.
 */
export default function MarkdownPasteDialog({
  open,
  preview,
  onDecompose,
  onAsNode,
  onPlain,
  onCancel,
}: Props) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onCancel();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onCancel]);

  if (!open) return null;

  const options: {
    key: string;
    label: string;
    desc: string;
    onSelect: () => void;
  }[] = [
    {
      key: "decompose",
      label: "分解してペースト",
      desc: "見出しやリストの階層をノードツリーに展開します",
      onSelect: onDecompose,
    },
    {
      key: "node",
      label: "Markdownノードとしてペースト",
      desc: "1つのMarkdownノードとしてそのまま貼り付けます",
      onSelect: onAsNode,
    },
    {
      key: "plain",
      label: "プレーンテキストとして貼り付け",
      desc: "Markdown記法を解釈せず、行のインデントだけでノード化します",
      onSelect: onPlain,
    },
  ];

  return (
    <div
      className="anim-overlay fixed inset-0 z-50 flex items-center justify-center bg-slate-950/40 px-4"
      onClick={onCancel}
      role="dialog"
      aria-modal="true"
      aria-label="Markdownの貼り付け方法"
    >
      <div
        className="anim-modal w-full max-w-md rounded-2xl border border-slate-200 bg-white p-6 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-base font-bold tracking-tight text-slate-950">
          Markdownを検出しました
        </h2>
        <p className="mt-1 text-sm leading-relaxed text-slate-500">
          貼り付け方法を選んでください。
        </p>
        {preview && (
          <pre className="mt-3 max-h-28 overflow-auto rounded-lg bg-slate-50 p-3 text-xs leading-relaxed text-slate-600 whitespace-pre-wrap break-words">
            {preview}
          </pre>
        )}
        <div className="mt-4 flex flex-col gap-2">
          {options.map((o, i) => (
            <button
              key={o.key}
              type="button"
              autoFocus={i === 0}
              onClick={o.onSelect}
              className="rounded-xl border border-slate-200 px-4 py-3 text-left transition hover:border-violet-300 hover:bg-violet-50 focus:outline-none focus:ring-2 focus:ring-violet-200"
            >
              <span className="block text-sm font-semibold text-slate-900">
                {o.label}
              </span>
              <span className="mt-0.5 block text-xs text-slate-500">
                {o.desc}
              </span>
            </button>
          ))}
        </div>
        <div className="mt-4 flex items-center justify-end">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-xl px-4 py-2 text-sm font-medium text-slate-600 transition hover:bg-slate-100"
          >
            キャンセル
          </button>
        </div>
      </div>
    </div>
  );
}
