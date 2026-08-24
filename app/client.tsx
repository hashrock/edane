import { createInertiaApp, type ResolvedComponent } from "@inertiajs/react";
import { createRoot } from "react-dom/client";
import { syncDocumentLang } from "./application/i18n";

// SSRの<html>は lang="ja" 固定なので、保存されたUI言語に合わせて起動時に直す。
syncDocumentLang();

createInertiaApp({
  resolve: async (name) => {
    const pages = import.meta.glob<{ default: ResolvedComponent }>(
      "./pages/**/*.tsx"
    );
    const page = await pages[`./pages/${name}.tsx`]();
    return page.default;
  },
  setup({ el, App, props }) {
    createRoot(el).render(<App {...props} />);
  },
});
