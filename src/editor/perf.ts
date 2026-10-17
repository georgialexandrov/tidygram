/**
 * Timing samples for the editor's hot paths, readable from the console or a
 * test as `window.__perf.summary()`. Cheap enough to leave on.
 */
const samples: Record<string, number[]> = {};

export const perf = {
  inputAt: undefined as number | undefined,
  /** Set when a file starts loading; the first committed scene records `open: total`. */
  openedAt: undefined as number | undefined,
  record(name: string, ms: number) {
    const list = (samples[name] ??= []);
    list.push(ms);
    if (list.length > 500) list.shift();
  },
  reset() {
    for (const k of Object.keys(samples)) delete samples[k];
  },
  summary(): Record<string, { n: number; median: number; p95: number; max: number }> {
    const out: Record<string, { n: number; median: number; p95: number; max: number }> = {};
    for (const [k, list] of Object.entries(samples)) {
      const sorted = [...list].sort((a, b) => a - b);
      const at = (q: number) => Math.round(sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]! * 10) / 10;
      out[k] = { n: sorted.length, median: at(0.5), p95: at(0.95), max: at(1) };
    }
    return out;
  },
};

(globalThis as { __perf?: typeof perf }).__perf = perf;
