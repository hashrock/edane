import { useEffect, useMemo, useState } from "react";
import type { MindMapDocument, MindMapModel } from "../domain/model";
import { buildSlides, slideIndexOf, type Slide } from "../application/slides";
import { nodeDisplayText } from "../application/nodeUtils";
import { renderMarkdownHtml } from "../lib/markdownHtml";
import { t } from "../application/i18n";

interface Props {
  doc: MindMapDocument;
  /** Node to start from (the editor's selection); its slide opens first. */
  startNodeId: string | null;
  /** Leave the show; hands back the heading of the slide on screen. */
  onExit: (nodeId: string | null) => void;
}

const NEXT_KEYS = new Set(["ArrowRight", "ArrowDown", "PageDown", " ", "Enter"]);
const PREV_KEYS = new Set(["ArrowLeft", "ArrowUp", "PageUp", "Backspace"]);

/**
 * Full-screen presentation of the document (see application/slides.ts for
 * how the tree becomes slides). The 16:9 stage is a size container, so every
 * size below is in `cqw` and the slide looks the same at any window size.
 *
 * Keys are taken in the capture phase and stopped there, so the editor
 * underneath never sees them while the show is up.
 */
export default function SlideShow({ doc, startNodeId, onExit }: Props) {
  const slides = useMemo(() => buildSlides(doc), [doc]);
  const [index, setIndex] = useState(() =>
    startNodeId ? slideIndexOf(slides, doc, startNodeId) : 0
  );
  const slide: Slide | undefined = slides[index];
  const last = slides.length - 1;

  useEffect(() => {
    const exit = () => onExit(slide?.heading.id ?? null);
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.isComposing) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") exit();
      else if (NEXT_KEYS.has(e.key)) setIndex((i) => Math.min(i + 1, last));
      else if (PREV_KEYS.has(e.key)) setIndex((i) => Math.max(i - 1, 0));
      else if (e.key === "Home") setIndex(0);
      else if (e.key === "End") setIndex(last);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [last, slide, onExit]);

  // Clicking the right two thirds advances, the left third goes back —
  // except on links, which keep their own click.
  const onClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest("a")) return;
    const { left, width } = e.currentTarget.getBoundingClientRect();
    const back = e.clientX - left < width / 3;
    setIndex((i) => (back ? Math.max(i - 1, 0) : Math.min(i + 1, last)));
  };

  return (
    <div
      role="dialog"
      aria-label={t("presentTitle")}
      data-testid="slideshow"
      className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-950"
    >
      <div
        data-testid="slide"
        onClick={onClick}
        style={{ containerType: "inline-size", width: "min(100vw, calc(100vh * 16 / 9))" }}
        className="relative aspect-video cursor-pointer overflow-hidden bg-white text-slate-900"
      >
        {slide ? <SlideBody slide={slide} /> : (
          <p className="flex h-full items-center justify-center text-[3cqw] text-slate-400">
            {t("presentEmpty")}
          </p>
        )}
        <div
          className="absolute inset-x-0 bottom-0 h-[0.4cqw] bg-emerald-500 transition-[width]"
          style={{ width: `${slides.length ? ((index + 1) / slides.length) * 100 : 0}%` }}
        />
        <span
          data-testid="slide-counter"
          className="absolute bottom-[1.5cqw] right-[2cqw] text-[1.2cqw] tabular-nums text-slate-400"
        >
          {slides.length ? `${index + 1} / ${slides.length}` : ""}
        </span>
      </div>
      <button
        type="button"
        onClick={() => onExit(slide?.heading.id ?? null)}
        className="absolute right-4 top-4 rounded-lg px-3 py-1.5 text-xs text-slate-400 hover:bg-white/10 hover:text-white"
      >
        {t("presentExit")}
      </button>
    </div>
  );
}

function SlideBody({ slide }: { slide: Slide }) {
  if (slide.kind === "title") {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-[2cqw] px-[8cqw] text-center">
        <div className="text-[5.5cqw] font-bold leading-tight">
          <NodeContent node={slide.heading} />
        </div>
        <div className="h-[0.4cqw] w-[8cqw] bg-emerald-500" />
      </div>
    );
  }
  // Fewer bullets → bigger type, so a short slide doesn't look empty.
  const n = slide.items.length;
  const itemSize = n <= 4 ? "text-[3cqw]" : n <= 7 ? "text-[2.5cqw]" : "text-[2.1cqw]";
  return (
    <div className="flex h-full flex-col px-[6cqw] pb-[5cqw] pt-[4.5cqw]">
      {slide.trail.length > 0 && (
        <div className="mb-[1cqw] truncate text-[1.4cqw] text-slate-400">
          {slide.trail.join(" › ")}
        </div>
      )}
      <h2 className="mb-[2.5cqw] text-[4cqw] font-bold leading-tight">
        <NodeContent node={slide.heading} />
      </h2>
      <ul className={`min-h-0 flex-1 space-y-[0.9cqw] overflow-hidden ${itemSize}`}>
        {slide.items.map(({ node, depth }) => (
          <li
            key={node.id}
            className={`flex gap-[1cqw] leading-snug ${
              slide.kind === "section" ? "font-medium" : depth > 0 ? "text-slate-600" : ""
            }`}
            style={{ marginLeft: `${depth * 3}cqw`, fontSize: depth > 0 ? "0.85em" : undefined }}
          >
            {(node.type ?? "text") !== "image" && (
              <span className="shrink-0 text-emerald-500">{slide.kind === "section" ? "▸" : "•"}</span>
            )}
            <div className="min-w-0">
              <NodeContent node={node} />
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** One node as slide content, by kind. */
function NodeContent({ node }: { node: MindMapModel }) {
  const type = node.type ?? "text";
  if (type === "image") {
    return node.text ? (
      <img src={node.text} alt="" className="max-h-[30cqw] max-w-full rounded-[0.5cqw] object-contain" />
    ) : null;
  }
  if (type === "markdown") {
    return (
      <div
        className="md-body"
        style={{ fontSize: "inherit" }}
        // Sanitized by renderMarkdownHtml (DOMPurify).
        dangerouslySetInnerHTML={{ __html: renderMarkdownHtml(node.text) }}
      />
    );
  }
  const text = nodeDisplayText(node);
  return (
    <span className={`whitespace-pre-wrap break-words ${node.bold ? "font-bold" : ""}`}>
      {node.checked !== undefined && (
        <span className={`mr-[0.6cqw] ${node.checked ? "text-emerald-500" : "text-slate-400"}`}>
          {node.checked ? "☑" : "☐"}
        </span>
      )}
      {type === "link" ? (
        <a href={node.text} target="_blank" rel="noopener noreferrer" className="text-emerald-700 underline">
          {node.favicon && <img src={node.favicon} alt="" className="mr-[0.5cqw] inline h-[1em] w-[1em] align-[-0.1em]" />}
          {text}
        </a>
      ) : (
        text
      )}
    </span>
  );
}
