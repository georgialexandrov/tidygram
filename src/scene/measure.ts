/**
 * Deterministic text measurement using Helvetica advance widths (AFM, per
 * 1000 em). The CLI has no DOM to measure with, and positions in layout.json
 * must mean the same thing in the browser and on the command line, so both
 * use this table instead of the real font metrics.
 */
const HELVETICA: Record<string, number> = {
  ' ': 278, '!': 278, '"': 355, '#': 556, $: 556, '%': 889, '&': 667, "'": 191, '(': 333, ')': 333,
  '*': 389, '+': 584, ',': 278, '-': 333, '.': 278, '/': 278, ':': 278, ';': 278, '<': 584, '=': 584,
  '>': 584, '?': 556, '@': 1015, A: 667, B: 667, C: 722, D: 722, E: 667, F: 611, G: 778, H: 722,
  I: 278, J: 500, K: 667, L: 556, M: 833, N: 722, O: 778, P: 667, Q: 778, R: 722, S: 667, T: 611,
  U: 722, V: 667, W: 944, X: 667, Y: 667, Z: 611, '[': 278, '\\': 278, ']': 278, '^': 469, _: 556,
  '`': 333, a: 556, b: 556, c: 500, d: 556, e: 556, f: 278, g: 556, h: 556, i: 222, j: 222, k: 500,
  l: 222, m: 833, n: 556, o: 556, p: 556, q: 556, r: 333, s: 500, t: 278, u: 556, v: 500, w: 722,
  x: 500, y: 500, z: 500, '{': 334, '|': 260, '}': 334, '~': 584, '«': 556, '»': 556,
};

export const LINE_HEIGHT = 1.25;

export function textWidth(text: string, size: number, bold = false, factor = 1): number {
  let units = 0;
  for (const ch of text) units += HELVETICA[ch] ?? (/\d/.test(ch) ? 556 : 600);
  return (units / 1000) * size * (bold ? 1.08 : 1) * factor;
}

export interface TextBlock {
  lines: string[];
  width: number;
  height: number;
  size: number;
}

export function measureText(text: string, size: number, bold = false, factor = 1): TextBlock {
  const lines = text.split('\n');
  const width = Math.max(0, ...lines.map((l) => textWidth(l, size, bold, factor)));
  return { lines, width, height: lines.length * size * LINE_HEIGHT, size };
}
