/**
 * Search strategy for graph-based testing: which event to fire next.
 *
 * A pure random walk drifts deep and keeps re-taking the same cheap edges, so
 * the chooser is coverage-guided: it counts (state class, event class) edges
 * and strongly prefers ones never taken. Walks are cut into episodes with a
 * reset to the initial state between them, so breadth near the start is
 * covered too. Everything is driven by a seeded PRNG, so a failing walk is
 * reproduced by its seed alone.
 */

/** mulberry32: tiny, fast, good enough for test exploration. */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class EdgeCoverage {
  private readonly counts = new Map<string, number>();
  private readonly states = new Set<string>();

  private static key(stateClass: string, eventClass: string) {
    return `${stateClass} --${eventClass}-->`;
  }

  count(stateClass: string, eventClass: string): number {
    return this.counts.get(EdgeCoverage.key(stateClass, eventClass)) ?? 0;
  }

  record(stateClass: string, eventClass: string): void {
    const k = EdgeCoverage.key(stateClass, eventClass);
    this.counts.set(k, (this.counts.get(k) ?? 0) + 1);
    this.states.add(stateClass);
  }

  get edgeCount(): number {
    return this.counts.size;
  }

  get stateCount(): number {
    return this.states.size;
  }

  summary(): string {
    return `${this.stateCount} state classes, ${this.edgeCount} distinct edges`;
  }
}

/**
 * Pick one of `events`, weighting never-taken edges far above taken ones
 * (and rarely-taken above often-taken).
 */
export function chooseEvent<E>(
  events: readonly E[],
  rand: () => number,
  weightOf: (ev: E) => number
): E {
  const weights = events.map(weightOf);
  const total = weights.reduce((a, b) => a + b, 0);
  let r = rand() * total;
  for (let i = 0; i < events.length; i++) {
    r -= weights[i];
    if (r < 0) return events[i];
  }
  return events[events.length - 1];
}

/** Weight for an edge taken `n` times so far. */
export const edgeWeight = (n: number): number => (n === 0 ? 20 : 1 / n);
