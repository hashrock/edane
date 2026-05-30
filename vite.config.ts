import { defineConfig } from "vite";
import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import ssrPlugin from "vite-ssr-components/plugin";
import { inertiaPages } from "@hono/inertia/vite";

export default defineConfig({
  plugins: [inertiaPages(), tailwindcss(), cloudflare(), ssrPlugin()],
});
