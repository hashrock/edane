import { describe, it, expect, beforeEach } from "vitest";
import { render } from "vitest-browser-react";
import { page, userEvent } from "vitest/browser";
import MindmapEditor, { type MindmapTestApi } from "./MindmapEditor";
import type { MindMapModel } from "../domain/model";
import { PREFERENCES_KEY } from "../application/editorPreferences";
import {
  allIds,
  bindNewId,
  enabledEvents,
  eventClass,
  observe,
  sameObservation,
  specStep,
  stateClass,
  type Observation,
  type SpecEvent,
  type SpecKey,
  type SpecNode,
  type SpecState,
} from "../application/editorSpec.testHelpers";
import {
  EdgeCoverage,
  chooseEvent,
  edgeWeight,
  prng,
} from "../application/graphExplorer.testHelpers";

/**
 * GRAPH-BASED E2E TEST of the canvas editor.
 *
 * The spec (application/editorSpec.testHelpers.ts) is a state machine of what
 * the keyboard and mouse should do. This test walks it against the real
 * MindmapEditor in chromium: each step picks an event the spec allows
 * (coverage-guided, seeded), fires it as real input, waits for the editor to
 * settle, then compares the observed state with the spec's prediction:
 *
 *   - spec moved, editor did not   → liveness violation (event refused)
 *   - anything else that differs   → safety violation (trace not in spec)
 *
 * Example-based tests pin the scenarios that matter; this one looks for the
 * paths nobody thought to write down. A failure prints the seed and the event
 * trace since the last reset, which is a complete reproduction.
 *
 * Longer / other runs:
 *   VITE_GRAPH_SEED=1234 VITE_GRAPH_STEPS=2000 pnpm vitest run --project browser \
 *     app/components/MindmapEditor.graph.browser.test.tsx
 */

// --- Initial document ---------------------------------------------------------

const INITIAL_ROOTS: SpecNode[] = [
  {
    id: "a",
    text: "alpha",
    children: [
      { id: "a1", text: "one", children: [] },
      {
        id: "a2",
        text: "two",
        children: [{ id: "a2x", text: "deep", children: [] }],
      },
    ],
  },
  {
    id: "b",
    text: "beta",
    children: [{ id: "b1", text: "b1", children: [] }],
  },
];

/** The walk starts after clicking "b" (a click gives the editor the keyboard). */
const INITIAL_STATE: SpecState = {
  roots: INITIAL_ROOTS,
  activeId: "b",
  editing: false,
  caret: 0,
  selEnd: 0,
  lastChild: {},
};

// --- Configuration ----------------------------------------------------------

const env = import.meta.env as Record<string, string | undefined>;
const SEEDS = env.VITE_GRAPH_SEED ? [Number(env.VITE_GRAPH_SEED)] : [1, 2, 3];
const STEPS_PER_SEED = Number(env.VITE_GRAPH_STEPS ?? 150);
/** Reset to the initial document every this many steps (breadth). */
const EPISODE_LENGTH = 40;
/** Waiting for the editor to reach the predicted state. */
const SETTLE_TIMEOUT_MS = 1500;
/** How long a refused event must leave the editor untouched. */
const QUIET_MS = 120;

/**
 * Divergences the exploration has found and that are not fixed yet. Each one
 * removes the offending edge from the walk (so the rest keeps being
 * explored) — delete the entry once the editor matches the spec again.
 */
const KNOWN_DIVERGENCES: { why: string; skip: (s: SpecState, ev: SpecEvent) => boolean }[] = [
];

// --- Driving the real editor -----------------------------------------------

function api(): MindmapTestApi {
  const a = window.__mindmapTest;
  if (!a) throw new Error("__mindmapTest not exposed yet");
  return a;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor<T>(fn: () => T | null | undefined | false, ms = 5000): Promise<T> {
  const start = Date.now();
  for (;;) {
    try {
      const v = fn();
      if (v) return v as T;
    } catch {
      // not ready
    }
    if (Date.now() - start > ms) throw new Error("waitFor: timed out");
    await sleep(20);
  }
}

function canvas(): HTMLElement {
  return document.querySelector<HTMLElement>('[data-testid="mm-canvas"]')!;
}

function toSpecNodes(nodes: readonly MindMapModel[]): SpecNode[] {
  return nodes.map((n) => ({ id: n.id, text: n.text, children: toSpecNodes(n.children) }));
}

/** Abstraction function: the real editor's state, as the spec sees it. */
function observeImpl(): Observation {
  const sel = api().getSelection();
  return {
    roots: toSpecNodes(api().getModel().roots),
    activeId: sel.activeNodeId ?? "(none)",
    editing: sel.editing,
    caret: sel.editing ? sel.cursorPos : null,
    selEnd: sel.editing ? sel.selectionEnd : null,
  };
}

const KEY_INPUT: Record<SpecKey, string> = {
  up: "{ArrowUp}",
  down: "{ArrowDown}",
  left: "{ArrowLeft}",
  right: "{ArrowRight}",
  space: "[Space]",
  enter: "{Enter}",
  tab: "{Tab}",
  shiftTab: "{Shift>}{Tab}{/Shift}",
  backspace: "{Backspace}",
  escape: "{Escape}",
  type: "x",
};

/** Screen point to click a node at, or null when it isn't safely on screen. */
function clickPoint(id: string): { x: number; y: number } | null {
  const p = api().getNodeClickPoint(id);
  if (!p) return null;
  const r = canvas().getBoundingClientRect();
  const w = Math.min(r.width, window.innerWidth);
  const h = Math.min(r.height, window.innerHeight);
  const margin = 8;
  if (p.x < margin || p.y < margin || p.x > w - margin || p.y > h - margin) {
    return null;
  }
  return { x: Math.round(p.x), y: Math.round(p.y) };
}

async function fire(ev: SpecEvent): Promise<void> {
  if (ev.kind === "key") {
    await userEvent.keyboard(KEY_INPUT[ev.key]);
    return;
  }
  const p = clickPoint(ev.id);
  if (!p) throw new Error(`node ${ev.id} is not clickable`);
  await userEvent.click(canvas(), { position: p });
}

/** Mount a fresh editor and bring it to INITIAL_STATE (the article's reset). */
type Unmount = () => Promise<void>;

async function reset(unmount: Unmount | null): Promise<Unmount> {
  await unmount?.();
  localStorage.removeItem(PREFERENCES_KEY);
  const screen = await render(
    <MindmapEditor
      initialContent={JSON.stringify({ version: 2, roots: INITIAL_ROOTS })}
      initialTitle="graph"
    />
  );
  await waitFor(() => api().getModel().roots[0]?.id === "a");
  await waitFor(() => api().getRedrawStats().redrawCount > 0);
  // The first click can land before the layout settles: retry it.
  let seen = observeImpl();
  for (let attempt = 0; attempt < 5 && !sameObservation(seen, observe(INITIAL_STATE)); attempt++) {
    await waitFor(() => clickPoint("b"));
    await fire({ kind: "click", id: "b" });
    ({ seen } = await settle(() => observe(INITIAL_STATE), false));
  }
  if (!sameObservation(seen, observe(INITIAL_STATE))) {
    throw new Error(`reset did not reach the initial state:\n${render2(seen)}`);
  }
  return () => screen.unmount();
}

/**
 * Wait until the editor is in the predicted state, or give up after
 * SETTLE_TIMEOUT_MS. `predict` sees each observation so ids of nodes the
 * spec created can be bound to the real ones. A refused event is given
 * QUIET_MS to (wrongly) change something before it counts as refused.
 */
async function settle(
  predict: (seen: Observation) => Observation,
  refused: boolean
): Promise<{ seen: Observation; expected: Observation }> {
  if (refused) await sleep(QUIET_MS);
  const start = Date.now();
  for (;;) {
    const seen = observeImpl();
    const expected = predict(seen);
    if (sameObservation(seen, expected) || Date.now() - start > SETTLE_TIMEOUT_MS) {
      return { seen, expected };
    }
    await sleep(20);
  }
}

// --- Reporting --------------------------------------------------------------

function describeEvent(ev: SpecEvent): string {
  return ev.kind === "click" ? `click(${ev.id})` : ev.key;
}

function outline(roots: SpecNode[], depth = 0): string[] {
  return roots.flatMap((n) => [
    `${"  ".repeat(depth)}- ${JSON.stringify(n.text)} {${n.id}}`,
    ...outline(n.children, depth + 1),
  ]);
}

function render2(o: Observation): string {
  const mode = o.editing ? `editing caret=${o.caret} selEnd=${o.selEnd}` : "selection";
  return [`active=${o.activeId} (${mode})`, ...outline(o.roots)].join("\n");
}

// --- The walk ---------------------------------------------------------------

beforeEach(async () => {
  await page.viewport(1000, 720);
  const style = document.createElement("style");
  style.textContent = `
    [data-testid="mm-canvas"] {
      position: absolute; left: 0; top: 0; width: 900px; height: 640px;
    }
  `;
  document.head.appendChild(style);
});

describe("MindmapEditor graph-based exploration (spec ⇔ implementation)", () => {
  const coverage = new EdgeCoverage();

  for (const seed of SEEDS) {
    it(
      `seed ${seed}: ${STEPS_PER_SEED} steps stay inside the spec`,
      async () => {
        const rand = prng(seed);
        let unmount: Unmount | null = null;
        let spec = INITIAL_STATE;
        let trace: string[] = [];

        for (let step = 0; step < STEPS_PER_SEED; step++) {
          if (step % EPISODE_LENGTH === 0) {
            unmount = await reset(unmount);
            spec = INITIAL_STATE;
            trace = [];
          }

          // Clicks need the node on screen; keys are always fireable.
          const events = enabledEvents(spec).filter(
            (ev) =>
              (ev.kind === "key" || clickPoint(ev.id) !== null) &&
              !KNOWN_DIVERGENCES.some((d) => d.skip(spec, ev))
          );
          const cls = stateClass(spec);
          const perClass = new Map<string, number>();
          for (const ev of events) {
            perClass.set(eventClass(ev), (perClass.get(eventClass(ev)) ?? 0) + 1);
          }
          const ev = chooseEvent(events, rand, (e) => {
            const c = eventClass(e);
            // Each event CLASS weighs the same, however many clicks there are.
            return edgeWeight(coverage.count(cls, c)) / perClass.get(c)!;
          });

          const before = observeImpl();
          const beforeIds = allIds(before.roots);
          const predicted = specStep(spec, ev);
          const refused = sameObservation(observe(predicted), observe(spec));
          trace.push(describeEvent(ev));

          await fire(ev);
          // A node the spec created gets its id from the editor.
          const { seen } = await settle(
            (o) => observe(bindNewId(predicted, beforeIds, o)),
            refused
          );
          const next = bindNewId(predicted, beforeIds, seen);
          coverage.record(cls, eventClass(ev));

          if (!sameObservation(seen, observe(next))) {
            const implMoved = !sameObservation(seen, before);
            const kind =
              !refused && !implMoved
                ? "LIVENESS violation — the spec accepts this event but the editor refused it"
                : "SAFETY violation — the editor left the spec's traces";
            expect.fail(
              [
                kind,
                `seed=${seed} step=${step} (episode step ${trace.length})`,
                `trace since reset: ${trace.join(" → ")}`,
                `state class: ${cls}`,
                "",
                "--- before ---",
                render2(before),
                "--- spec expects ---",
                render2(observe(next)),
                "--- editor shows ---",
                render2(seen),
              ].join("\n")
            );
          }
          spec = next;
        }
        await unmount?.();
        console.warn(`[graph e2e] seed ${seed}: ${coverage.summary()} (cumulative)`);
      },
      STEPS_PER_SEED * 1500 + 30_000
    );
  }
});
