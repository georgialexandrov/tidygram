import type { AttachSide, EndAttach, Point } from '../layout/layout-file.ts';
import type { Box } from './containers.ts';
import { inside, type AnchorShape } from './geometry.ts';

/**
 * Hand-chosen line ends (`EdgeLayout.from` / `to`): from the stored fraction
 * to a point on the drawn outline and back, and the snap points the editor
 * offers while an end handle is dragged. Fractions are of the outline's
 * bounding box (the anchor, not the label hanging below an icon), the same
 * convention draw.io uses for `exitX`/`exitY`.
 */

export interface Attachment {
  /** The fraction, side included, as stored in the sidecar. */
  attach: EndAttach;
  /** Where the line meets the outline. */
  outline: Point;
}

export const anchorBox = (a: AnchorShape): Box => ({ x: a.cx - a.w / 2, y: a.cy - a.h / 2, w: a.w, h: a.h });

const vertical = (side: AttachSide) => side === 'top' || side === 'bottom';

/** One step outwards from the outline along `side`. */
export function outward(p: Point, side: AttachSide, d: number): Point {
  return side === 'top' ? [p[0], p[1] - d] : side === 'bottom' ? [p[0], p[1] + d] : side === 'left' ? [p[0] - d, p[1]] : [p[0] + d, p[1]];
}

/** Bisection between a point inside and one outside: where the outline is crossed. */
function crossing(a: AnchorShape, from: Point, to: Point): Point {
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 30; i++) {
    const mid = (lo + hi) / 2;
    if (inside(a, [from[0] + (to[0] - from[0]) * mid, from[1] + (to[1] - from[1]) * mid])) lo = mid;
    else hi = mid;
  }
  return [from[0] + (to[0] - from[0]) * hi, from[1] + (to[1] - from[1]) * hi];
}

/**
 * The drawn end of a stored attachment. Rectangles: the fraction along the
 * chosen side. Round outlines: the fraction's position across the side's
 * axis, projected onto the outline along `side`, so a line coming in
 * straight from that side lands exactly there.
 */
export function attachOutline(a: AnchorShape, at: EndAttach): Point {
  const b = anchorBox(a);
  const x = b.x + at.x * b.w;
  const y = b.y + at.y * b.h;
  if (a.shape === 'rect') {
    return at.side === 'top' ? [x, b.y] : at.side === 'bottom' ? [x, b.y + b.h] : at.side === 'left' ? [b.x, y] : [b.x + b.w, y];
  }
  // Keep a hair inside the extent, or the projection line misses the shape.
  const v = vertical(at.side);
  const along = v ? Math.min(Math.max(x, b.x + 0.5), b.x + b.w - 0.5) : Math.min(Math.max(y, b.y + 0.5), b.y + b.h - 0.5);
  const from: Point = v ? [along, a.cy] : [a.cx, along];
  if (!inside(a, from)) return v ? [along, at.side === 'top' ? a.cy - 0.01 : a.cy + 0.01] : [at.side === 'left' ? a.cx - 0.01 : a.cx + 0.01, along];
  return crossing(a, from, outward(from, at.side, a.w + a.h));
}

/** Which way a line should leave a round outline at `p`: the axis its outward normal leans to. */
function roundSide(a: AnchorShape, p: Point): AttachSide {
  const dx = p[0] - a.cx;
  const dy = p[1] - a.cy;
  let nx: number;
  let ny: number;
  if (a.shape === 'diamond') [nx, ny] = [dx / (a.w / 2), dy / (a.h / 2)];
  else if (a.shape === 'pill') {
    const r = Math.min(a.w, a.h) / 2;
    [nx, ny] = [Math.sign(dx) * Math.max(0, Math.abs(dx) - (a.w / 2 - r)), Math.sign(dy) * Math.max(0, Math.abs(dy) - (a.h / 2 - r))];
  } else [nx, ny] = [dx / (a.w / 2) ** 2, dy / (a.h / 2) ** 2];
  if (Math.abs(nx) > Math.abs(ny)) return nx < 0 ? 'left' : 'right';
  return ny < 0 ? 'top' : 'bottom';
}

const fraction = (b: Box, p: Point): [number, number] => [b.w ? Math.min(1, Math.max(0, (p[0] - b.x) / b.w)) : 0.5, b.h ? Math.min(1, Math.max(0, (p[1] - b.y) / b.h)) : 0.5];

/** The attachment for an outline point and the side the line leaves in. */
export function attachAt(a: AnchorShape, outline: Point, side: AttachSide): Attachment {
  const [x, y] = fraction(anchorBox(a), outline);
  return { attach: { x, y, side }, outline };
}

/** The outline point nearest to `p` (rectangles), or where the ray from the centre to `p` leaves (round outlines). */
export function nearestAttach(a: AnchorShape, p: Point): Attachment {
  const b = anchorBox(a);
  if (a.shape === 'rect') {
    const x = Math.min(Math.max(p[0], b.x), b.x + b.w);
    const y = Math.min(Math.max(p[1], b.y), b.y + b.h);
    const d: [AttachSide, number][] = [
      ['top', Math.abs(p[1] - b.y)],
      ['bottom', Math.abs(p[1] - b.y - b.h)],
      ['left', Math.abs(p[0] - b.x)],
      ['right', Math.abs(p[0] - b.x - b.w)],
    ];
    // Outside a corner, the side the pointer is furthest beyond wins (it "points" that way).
    const side = d.reduce((m, s) => (s[1] < m[1] ? s : m))[0];
    const outline: Point = side === 'top' ? [x, b.y] : side === 'bottom' ? [x, b.y + b.h] : side === 'left' ? [b.x, y] : [b.x + b.w, y];
    return attachAt(a, outline, side);
  }
  const c: Point = [a.cx, a.cy];
  const len = Math.hypot(p[0] - c[0], p[1] - c[1]);
  const far: Point = len < 1e-6 ? [a.cx, a.cy - a.h] : [c[0] + ((p[0] - c[0]) / len) * (a.w + a.h), c[1] + ((p[1] - c[1]) / len) * (a.w + a.h)];
  const hit = crossing(a, c, far);
  const side = roundSide(a, hit);
  // Re-project along the side so the stored point and the drawn end agree exactly.
  const at = attachAt(a, hit, side);
  return { attach: at.attach, outline: attachOutline(a, at.attach) };
}

/**
 * The points an end handle snaps to: side centres, quarter points and
 * corners on rectangles (a corner is offered once per side it belongs to);
 * every 22.5° round the outline on ellipses, diamonds and pills, with the
 * vertices and compass points among them.
 */
export function snapPoints(a: AnchorShape): Attachment[] {
  const b = anchorBox(a);
  if (a.shape === 'rect') {
    const out: Attachment[] = [];
    for (const t of [0, 0.25, 0.5, 0.75, 1]) {
      out.push(attachAt(a, [b.x + t * b.w, b.y], 'top'), attachAt(a, [b.x + t * b.w, b.y + b.h], 'bottom'));
      out.push(attachAt(a, [b.x, b.y + t * b.h], 'left'), attachAt(a, [b.x + b.w, b.y + t * b.h], 'right'));
    }
    return out;
  }
  const out: Attachment[] = [];
  for (let i = 0; i < 16; i++) {
    const t = (i / 16) * 2 * Math.PI;
    const p: Point = [a.cx + Math.cos(t) * (a.w + a.h), a.cy + Math.sin(t) * (a.w + a.h)];
    out.push(nearestAttach(a, p));
  }
  return out;
}

/**
 * Where a dragged end handle lands: the nearest outline point, pulled to the
 * closest snap point within `threshold` unless `free` (Alt held). Among
 * candidates at one spot (a rectangle's corner) the one on the pointer's
 * side wins.
 */
export function snapAttach(a: AnchorShape, p: Point, threshold: number, free = false): Attachment & { snapped: boolean } {
  const near = nearestAttach(a, p);
  if (free) return { ...near, snapped: false };
  let best: Attachment | undefined;
  let bestD = threshold;
  for (const c of snapPoints(a)) {
    const d = Math.hypot(c.outline[0] - near.outline[0], c.outline[1] - near.outline[1]) + (c.attach.side === near.attach.side ? 0 : 0.01);
    if (d <= bestD) [best, bestD] = [c, d];
  }
  return best ? { ...best, snapped: true } : { ...near, snapped: false };
}
