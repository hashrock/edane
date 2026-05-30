import { renderToString } from "react-dom/server";
import { Link, Script, ViteClient } from "vite-ssr-components/react";
import { serializePage, type PageObject, type RootView } from "@hono/inertia";

const Document = ({ page }: { page: PageObject }) => (
  <html lang="ja">
    <head>
      <meta charSet="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1.0" />
      <title>Edane</title>
      <link rel="icon" href="/logo.svg" type="image/svg+xml" />
      <ViteClient />
      <Script src="/app/client.tsx" />
      <Link href="/app/styles.css" rel="stylesheet" />
    </head>
    <body className="bg-slate-50 min-h-screen">
      <script
        data-page="app"
        type="application/json"
        dangerouslySetInnerHTML={{ __html: serializePage(page) }}
      />
      <div id="app" />
    </body>
  </html>
);

export const rootView: RootView = (page) =>
  "<!DOCTYPE html>" + renderToString(<Document page={page} />);
