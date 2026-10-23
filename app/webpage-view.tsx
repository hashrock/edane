/**
 * The published web page (`/w/:id`): the note's pages stacked, with its theme,
 * rendered to static HTML on the server by the same page view the editor
 * previews (components/PageView.tsx). The only script is the small runtime
 * (webpage-runtime.ts: background animation and scroll effects); without it
 * the page still reads in full.
 */
import { renderToString } from "react-dom/server";
import { Link, Script } from "vite-ssr-components/react";
import type { MindMapDocument } from "./domain/model";
import { effectiveTheme } from "./domain/pageTheme";
import { buildSlides } from "./application/slides";
import { nodeDisplayText } from "./application/nodeUtils";
import { PageBackground, PageRoot, PageSection, PageThemeAssets } from "./components/PageView";
import { jsonForScript } from "./lib/escapeHtml";

/** Id of the data block carrying the background options to the runtime. */
export const WEB_PAGE_CONFIG_ID = "wp-config";

/**
 * The page's language, for screen readers and the browser's hyphenation and
 * translation: "ja" when the text has kana or kanji. Otherwise none is declared
 * — a note's language isn't recorded, and a wrong guess is worse than none.
 */
function pageLang(title: string, slides: ReturnType<typeof buildSlides>): string | undefined {
  const japanese = /[\u3040-\u30ff\u3400-\u9fff]/;
  if (japanese.test(title)) return "ja";
  return slides.some(({ heading, items }) => japanese.test(heading.text) || items.some(({ node }) => japanese.test(node.text)))
    ? "ja"
    : undefined;
}

function WebPageDocument({ doc }: { doc: MindMapDocument }) {
  const theme = effectiveTheme(doc.theme);
  const slides = buildSlides(doc);
  const title = doc.title || (doc.roots[0] ? nodeDisplayText(doc.roots[0]) : "");
  return (
    <html lang={pageLang(title, slides)}>
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>{title}</title>
        <meta property="og:title" content={title} />
        <meta property="og:type" content="website" />
        <Link href="/app/components/webpage.css" rel="stylesheet" />
        <PageThemeAssets theme={theme} />
        <Script src="/app/webpage-runtime.ts" />
      </head>
      <body className="wp-body">
        <PageRoot theme={theme} variant="web">
          <PageBackground background={theme.background} />
          <main>
            {slides.map((slide, i) => (
              <PageSection key={`${slide.heading.id}-${slide.kind}`} slide={slide} index={i} />
            ))}
          </main>
        </PageRoot>
        <script
          id={WEB_PAGE_CONFIG_ID}
          type="application/json"
          dangerouslySetInnerHTML={{ __html: jsonForScript({ background: theme.background }) }}
        />
      </body>
    </html>
  );
}

export function renderWebPage(doc: MindMapDocument): string {
  return "<!DOCTYPE html>" + renderToString(<WebPageDocument doc={doc} />);
}
