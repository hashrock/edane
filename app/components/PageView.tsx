/**
 * The document drawn as pages with its theme — one markup for every place a
 * page appears: the slideshow (variant `slide`, one 16:9 page at a time), the
 * editor's page preview and the published web page (variant `web`, pages
 * stacked). The look lives in webpage.css under stable `wp-*` class names,
 * which are also what the theme's author CSS styles.
 *
 * Server-safe: no effects or browser APIs outside {@link PageBackground}'s
 * effect, so the published page is this same markup rendered to a string.
 */
import { useEffect, useRef, type CSSProperties, type ReactNode, type RefObject } from "react";
import type { MindMapModel } from "../domain/model";
import type { PageBackground as PageBackgroundOptions, PageTheme } from "../domain/pageTheme";
import type { Slide } from "../application/slides";
import { nodeDisplayText, supportsCheckbox } from "../application/nodeUtils";
import { googleFontsHref, themeVars } from "../application/pageThemeStyle";
import { scopeUserCss } from "../application/scopedCss";
import { renderSafeMarkdown, safePageUrl } from "../lib/safeMarkdown";
import { safeExternalUrl } from "../lib/url";
import { startBackground, type BackgroundHandle } from "../lib/parallaxBackground";

export type PageVariant = "slide" | "web";

/** The selector the theme's author CSS is scoped to. */
export const PAGE_SCOPE = ".wp-root";

/** The theme's font stylesheet and scoped author CSS (render once per document). */
export function PageThemeAssets({ theme }: { theme: PageTheme }) {
  const fonts = googleFontsHref(theme);
  const css = scopeUserCss(theme.css, PAGE_SCOPE);
  return (
    <>
      {fonts && <link rel="stylesheet" href={fonts} />}
      {css && <style data-testid="page-theme-css" dangerouslySetInnerHTML={{ __html: css }} />}
    </>
  );
}

interface RootProps {
  theme: PageTheme;
  variant: PageVariant;
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
  rootRef?: RefObject<HTMLDivElement | null>;
  onClick?: React.MouseEventHandler<HTMLDivElement>;
  testId?: string;
}

/** The themed page container: custom properties, variant, scroll-effect settings. */
export function PageRoot({ theme, variant, children, className, style, rootRef, onClick, testId }: RootProps) {
  return (
    <div
      ref={rootRef}
      data-testid={testId}
      className={`wp-root${className ? ` ${className}` : ""}`}
      data-variant={variant}
      data-effect={theme.scrollEffect}
      data-stagger={theme.stagger ? "" : undefined}
      style={{ ...(themeVars(theme) as CSSProperties), ...style }}
      onClick={onClick}
    >
      {children}
    </div>
  );
}

/** Item size by count: fewer bullets → bigger type, so a short page doesn't look empty. */
function itemSize(n: number): "l" | "m" | "s" {
  return n <= 4 ? "l" : n <= 7 ? "m" : "s";
}

/** One page (slide) of the document. */
export function PageSection({ slide, index }: { slide: Slide; index: number }) {
  if (slide.kind === "title") {
    return (
      <section className="wp-page wp-page-title" data-kind="title" data-index={index}>
        <div className="wp-page-inner">
          <h1 className="wp-heading">
            <NodeContent node={slide.heading} />
          </h1>
          <div className="wp-rule" />
        </div>
      </section>
    );
  }
  return (
    <section className={`wp-page wp-page-${slide.kind}`} data-kind={slide.kind} data-index={index}>
      <div className="wp-page-inner">
        {slide.trail.length > 0 && <div className="wp-trail">{slide.trail.join(" › ")}</div>}
        <h2 className="wp-heading">
          <NodeContent node={slide.heading} />
        </h2>
        <ul className="wp-items" data-size={itemSize(slide.items.length)}>
          {slide.items.map(({ node, depth }, i) => (
            <li
              key={node.id}
              className="wp-item"
              data-depth={depth}
              data-type={node.type ?? "text"}
              style={{ "--wp-depth": depth, "--wp-i": i } as CSSProperties}
            >
              {(node.type ?? "text") !== "image" && (
                <span className="wp-bullet" aria-hidden="true">
                  {slide.kind === "section" ? "▸" : "•"}
                </span>
              )}
              <div className="wp-item-body">
                <NodeContent node={node} />
              </div>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

/** One node as page content, by kind. */
function NodeContent({ node }: { node: MindMapModel }) {
  const type = node.type ?? "text";
  if (type === "image") {
    const src = safePageUrl(node.text);
    return src ? <img className="wp-image" src={src} alt="" /> : null;
  }
  if (type === "markdown") {
    // Sanitized by renderSafeMarkdown (no raw HTML, safe URLs only).
    return <div className="wp-markdown" dangerouslySetInnerHTML={{ __html: renderSafeMarkdown(node.text) }} />;
  }
  const text = nodeDisplayText(node);
  return (
    <span className={`wp-text${node.bold ? " wp-bold" : ""}`}>
      {node.checked !== undefined && supportsCheckbox(type) && (
        <span className="wp-check" data-checked={node.checked ? "" : undefined}>
          {node.checked ? "☑" : "☐"}
        </span>
      )}
      {type === "link" ? (
        <a className="wp-link" href={safeExternalUrl(node.text) ?? undefined} target="_blank" rel="noopener noreferrer">
          {node.favicon && safeExternalUrl(node.favicon) && <img className="wp-favicon" src={safeExternalUrl(node.favicon)!} alt="" />}
          {text}
        </a>
      ) : (
        text
      )}
    </span>
  );
}

/**
 * The animated background canvas (lib/parallaxBackground.ts). `scrollY`
 * reports how far the view is scrolled, in CSS pixels; `scrollKey` changes
 * whenever it does, to redraw.
 */
export function PageBackground({
  background,
  scrollY,
  scrollKey,
  resolution,
}: {
  background: PageBackgroundOptions;
  scrollY?: () => number;
  scrollKey?: unknown;
  /** Drawing-buffer pixels per device pixel (lower for a scaled-down view). */
  resolution?: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const handleRef = useRef<BackgroundHandle | null>(null);
  const scrollRef = useRef(scrollY);
  scrollRef.current = scrollY;
  const none = background.preset === "none";

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || none) return;
    const handle = startBackground(canvas, background, () => scrollRef.current?.() ?? 0, resolution);
    handleRef.current = handle;
    return () => {
      handle.destroy();
      handleRef.current = null;
    };
    // Started once per mount (and per switch to/from `none`); option changes go through update().
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [none]);

  useEffect(() => {
    handleRef.current?.update(background);
  }, [background]);

  useEffect(() => {
    handleRef.current?.invalidate();
  }, [scrollKey]);

  return none ? null : <canvas ref={canvasRef} className="wp-bg" aria-hidden="true" />;
}
