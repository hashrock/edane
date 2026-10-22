import { renderToString } from "react-dom/server";
import { Link, Script, ViteClient } from "vite-ssr-components/react";
import type { PageObject, RootView } from "@hono/inertia";
import { jsonForScript } from "./lib/escapeHtml";

const Document = ({ page }: { page: PageObject }) => (
  <html lang="ja">
    <head>
      <meta charSet="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1.0" />
      <title>Edane</title>
      <link rel="icon" href="/icon.svg" type="image/svg+xml" />
      <ViteClient />
      <Script src="/app/client.tsx" />
      <Link href="/app/styles.css" rel="stylesheet" />
      {/* hashrock のサービス切り替え（components/ServiceSwitcher.tsx）。repos が落ちても読み込みが失敗するだけ */}
      <script type="module" src="https://repos.hashrock.info/switcher/v1.js" />
    </head>
    <body className="bg-slate-50 min-h-screen">
      <script
        data-page="app"
        type="application/json"
        // Not @hono/inertia's serializePage: it leaves `<`, so `<!--<script` in a public note's text derails the page.
        dangerouslySetInnerHTML={{ __html: jsonForScript(page) }}
      />
      <div id="app" />
    </body>
  </html>
);

export const rootView: RootView = (page) =>
  "<!DOCTYPE html>" + renderToString(<Document page={page} />);
