import type { Point } from '../layout/layout-file.ts';
import type { Box } from './containers.ts';
import { pathLength, pointAt } from './geometry.ts';
import type { TextBlock } from './measure.ts';

/**
 * Label placement: every label tries a handful of spots along its line and
 * takes the one that covers the least (boxes, titles, labels already placed,
 * other lines), preferring the middle for a line's label and the spot right
 * next to the end for a multiplicity. Greedy, in a fixed order, so the same
 * diagram always gets the same answer and a drag moves only what it must.
 */

export interface LabelObstacles {
  /** Node boxes and container titles: a label must not cover them. */
  boxes: Box[];
  /** Labels placed so far (grows as labels are placed). */
  labels: Box[];
  /** Every routed line, by edge id, so a label avoids the others but may sit on its own. */
  lines: Map<string, Point[]>;
  /** Container outlines: a label straddling one reads as belonging to neither side. */
  borders: Box[];
}

interface Candidate {
  /** Label centre. */
  x: number;
  y: number;
  /** Preference: 0 for the ideal spot, growing with distance from it. */
  cost: number;
}

const area = (b: Box) => b.w * b.h;

function overlap(a: Box, b: Box): number {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

/** Whether segment a→b passes through the box (axis-aligned lines are the common case; others are sampled). */
function segmentHits(a: Point, b: Point, box: Box): boolean {
  if (Math.max(a[0], b[0]) < box.x || Math.min(a[0], b[0]) > box.x + box.w || Math.max(a[1], b[1]) < box.y || Math.min(a[1], b[1]) > box.y + box.h) return false;
  if (Math.abs(a[0] - b[0]) < 0.5 || Math.abs(a[1] - b[1]) < 0.5) return true;
  for (let t = 0; t <= 1; t += 0.05) {
    const x = a[0] + (b[0] - a[0]) * t;
    const y = a[1] + (b[1] - a[1]) * t;
    if (x >= box.x && x <= box.x + box.w && y >= box.y && y <= box.y + box.h) return true;
  }
  return false;
}

/** A label partly inside a container outline: it straddles the border line. */
function crossesBorder(box: Box, border: Box): boolean {
  const fullyIn = box.x >= border.x && box.y >= border.y && box.x + box.w <= border.x + border.w && box.y + box.h <= border.y + border.h;
  return !fullyIn && overlap(box, border) > 0;
}

/** How bad it is to put a label of size w×h centred at (x, y), for the line `own`. */
function penalty(o: LabelObstacles, own: string, x: number, y: number, w: number, h: number, ownRest?: Point[]): number {
  const box = { x: x - w / 2, y: y - h / 2, w, h };
  let p = 0;
  for (const b of o.boxes) p += overlap(box, b) * 20;
  for (const l of o.labels) p += overlap(box, l) * 20;
  for (const [id, pts] of o.lines) {
    const line = id === own ? ownRest : pts;
    if (!line) continue;
    for (let i = 1; i < line.length; i++) if (segmentHits(line[i - 1]!, line[i]!, box)) p += 40 + area(box) * 0.5;
  }
  for (const b of o.borders) if (crossesBorder(box, b)) p += 30 + area(box) * 0.3;
  return p;
}

function best(o: LabelObstacles, own: string, w: number, h: number, candidates: Candidate[], ownRest?: Point[]): Candidate {
  let pick = candidates[0]!;
  let score = Infinity;
  for (const c of candidates) {
    const s = c.cost + penalty(o, own, c.x, c.y, w, h, ownRest);
    if (s < score - 1e-6) {
      score = s;
      pick = c;
    }
    if (score === 0) break;
  }
  return pick;
}

/** The direction of the polyline at fraction t: true when that stretch runs horizontally. */
function horizontalAt(points: Point[], t: number): boolean {
  let remaining = pathLength(points) * t;
  for (let i = 1; i < points.length; i++) {
    const [a, b] = [points[i - 1]!, points[i]!];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (remaining <= len) return Math.abs(b[0] - a[0]) >= Math.abs(b[1] - a[1]);
    remaining -= len;
  }
  return true;
}

/**
 * A line's own label: on the line (as a chip that hides the line under it)
 * at the middle if that spot is free, else further along, else beside the line.
 * `w`/`h` include the chip's padding. Keeps clear of both ends' arrowheads.
 */
export function placeMidLabel(o: LabelObstacles, id: string, points: Point[], w: number, h: number, ends: number): Point {
  const len = pathLength(points);
  const candidates: Candidate[] = [];
  const steps = [0.5, 0.42, 0.58, 0.34, 0.66, 0.26, 0.74, 0.18, 0.82, 0.1, 0.9];
  for (const t of steps) {
    const along = len * t;
    if (t !== 0.5 && (along < ends || len - along < ends)) continue;
    const [x, y] = pointAt(points, t);
    const shift = Math.abs(t - 0.5) * len * 0.15 + Math.abs(t - 0.5) * 20;
    candidates.push({ x, y, cost: shift });
    const flat = horizontalAt(points, t);
    const gap = 3;
    if (flat) {
      candidates.push({ x, y: y - h / 2 - gap, cost: shift + 12 });
      candidates.push({ x, y: y + h / 2 + gap, cost: shift + 14 });
    } else {
      candidates.push({ x: x + w / 2 + gap, y, cost: shift + 12 });
      candidates.push({ x: x - w / 2 - gap, y, cost: shift + 14 });
    }
  }
  const c = best(o, id, w, h, candidates);
  return [c.x, c.y];
}

/**
 * A label at a line's end (multiplicity, nwdiag address): beside the line,
 * just past the arrowhead, on whichever side and at whichever distance
 * covers nothing. `points` runs from the end outwards; `node` is the end's
 * box, which the label must not cover either.
 */
export function placeEndLabel(o: LabelObstacles, id: string, points: Point[], text: TextBlock, arrow: number, scale: number): Point {
  const w = text.width + 2 * scale;
  const h = text.height;
  const total = pathLength(points);
  const candidates: Candidate[] = [];
  for (const [k, extra] of [[0, 0], [1, 10], [2, 22], [3, 36], [5, 56], [8, 80]] as const) {
    // Walk along the line, so a short first stretch doesn't leave the label nowhere to go.
    const probe = (along: number) => {
      let left = Math.min(along, total);
      for (let i = 1; i < points.length; i++) {
        const [a, b] = [points[i - 1]!, points[i]!];
        const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
        if (left <= len || i === points.length - 1) {
          const f = len ? Math.min(1, left / len) : 0;
          return { p: [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f] as Point, ux: len ? (b[0] - a[0]) / len : 1, uy: len ? (b[1] - a[1]) / len : 0 };
        }
        left -= len;
      }
      return { p: points[0]!, ux: 1, uy: 0 };
    };
    const first = probe(0);
    // Half the label's extent along and across the line.
    const halfAlong = Math.abs(first.ux) > 0.5 ? w / 2 : h / 2;
    const at = probe(arrow + 3 * scale + halfAlong + k * 10 * scale);
    const halfAcross = Math.abs(at.ux) > 0.5 ? h / 2 : w / 2;
    for (const [side, sideCost] of [[1, 0], [-1, 2]] as const) {
      const across = (5 * scale + halfAcross) * side;
      candidates.push({ x: at.p[0] - at.uy * across, y: at.p[1] + at.ux * across, cost: extra + sideCost });
    }
  }
  // Beside the first stretch is the point; anywhere else on its own line is as bad as on another.
  const c = best(o, id, w, h, candidates, points.slice(1));
  return [c.x, c.y];
}
