/**
 * The published web page's only script (see webpage-view.tsx): starts the
 * theme's WebGL background, moving with the scroll, and reveals each page as it
 * scrolls into view. The page is complete without it — content is only hidden
 * for the entrance once this marks the root `data-animate`.
 */
import { normalizePageTheme } from "./domain/pageTheme";
import { startBackground } from "./lib/parallaxBackground";

const CONFIG_ID = "wp-config";

function start() {
  const root = document.querySelector<HTMLElement>(".wp-root");
  if (!root) return;

  let config: unknown = null;
  try {
    config = JSON.parse(document.getElementById(CONFIG_ID)?.textContent ?? "null");
  } catch {
    // No background; the page still reads.
  }
  const background = normalizePageTheme(config)?.background;
  const canvas = root.querySelector<HTMLCanvasElement>(":scope > .wp-bg");
  if (canvas && background) {
    const handle = startBackground(canvas, background, () => window.scrollY);
    window.addEventListener("scroll", () => handle.invalidate(), { passive: true });
  }

  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (root.dataset.effect === "none" || reduced || !("IntersectionObserver" in window)) return;
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        entry.target.classList.add("wp-in");
        observer.unobserve(entry.target);
      }
    },
    { threshold: 0.12 }
  );
  // Pages already on screen are shown as they are: hiding them for an entrance
  // would make the first view flash out and back in on load.
  const viewport = window.innerHeight;
  root.querySelectorAll(".wp-page").forEach((page) => {
    const { top, bottom } = page.getBoundingClientRect();
    if (top < viewport && bottom > 0) page.classList.add("wp-in");
    else observer.observe(page);
  });
  root.setAttribute("data-animate", "");
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
else start();
