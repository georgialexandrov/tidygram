import type { Point } from '../layout/layout-file.ts';
import type { Anchor } from './shapes.ts';

export interface AnchorShape extends Anchor {
  cx: number;
  cy: number;
}

export function inside(shape: AnchorShape, [x, y]: Point): boolean {
  if (shape.shape === 'diamond') {
    return Math.abs(x - shape.cx) / (shape.w / 2) + Math.abs(y - shape.cy) / (shape.h / 2) < 1;
  }
  if (shape.shape === 'pill') {
    const r = Math.min(shape.w, shape.h) / 2;
    const dx = Math.max(0, Math.abs(x - shape.cx) - (shape.w / 2 - r));
    const dy = Math.max(0, Math.abs(y - shape.cy) - (shape.h / 2 - r));
    return dx * dx + dy * dy < r * r;
  }
  if (shape.shape === 'ellipse') {
    const nx = (x - shape.cx) / (shape.w / 2);
    const ny = (y - shape.cy) / (shape.h / 2);
    return nx * nx + ny * ny < 1;
  }
  return Math.abs(x - shape.cx) < shape.w / 2 && Math.abs(y - shape.cy) < shape.h / 2;
}

/** Point where the segment a→b leaves the shape (a inside, b outside), by bisection. */
function exitPoint(shape: AnchorShape, a: Point, b: Point): Point {
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 32; i++) {
    const mid = (lo + hi) / 2;
    const p: Point = [a[0] + (b[0] - a[0]) * mid, a[1] + (b[1] - a[1]) * mid];
    if (inside(shape, p)) lo = mid;
    else hi = mid;
  }
  return [a[0] + (b[0] - a[0]) * hi, a[1] + (b[1] - a[1]) * hi];
}

/** Cuts the start of a centre-to-centre route back to the shape's outline. */
export function clipStart(points: Point[], shape: AnchorShape): Point[] {
  if (points.length < 2 || !inside(shape, points[0]!)) return points;
  for (let i = 0; i < points.length - 1; i++) {
    if (!inside(shape, points[i + 1]!)) return [exitPoint(shape, points[i]!, points[i + 1]!), ...points.slice(i + 1)];
  }
  return points;
}

export function clipEnd(points: Point[], shape: AnchorShape): Point[] {
  return clipStart([...points].reverse(), shape).reverse();
}

/** Drops repeated and collinear points. */
export function simplify(points: Point[]): Point[] {
  const out: Point[] = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (last && Math.abs(last[0] - p[0]) < 0.01 && Math.abs(last[1] - p[1]) < 0.01) continue;
    if (out.length >= 2) {
      const a = out[out.length - 2]!;
      const b = out[out.length - 1]!;
      const cross = (b[0] - a[0]) * (p[1] - b[1]) - (b[1] - a[1]) * (p[0] - b[0]);
      if (Math.abs(cross) < 0.01) out.pop();
    }
    out.push(p);
  }
  return out;
}

export function pathLength(points: Point[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) total += Math.hypot(points[i]![0] - points[i - 1]![0], points[i]![1] - points[i - 1]![1]);
  return total;
}

/** Point at fraction `t` of the polyline's length. */
export function pointAt(points: Point[], t: number): Point {
  let remaining = pathLength(points) * t;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (remaining <= len && len > 0) {
      const f = remaining / len;
      return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
    }
    remaining -= len;
  }
  return points[points.length - 1] ?? [0, 0];
}

/** Shortens the polyline's end by `by` pixels (so a hollow arrowhead isn't drawn over the line). */
export function trimEnd(points: Point[], by: number): Point[] {
  const out = [...points];
  let left = by;
  while (out.length >= 2 && left > 0) {
    const b = out[out.length - 1]!;
    const a = out[out.length - 2]!;
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (len > left) {
      const f = (len - left) / len;
      out[out.length - 1] = [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
      return out;
    }
    out.pop();
    left -= len;
  }
  return out;
}

/** SVG path for a polyline with rounded corners. */
export function roundedPath(points: Point[], radius = 6): string {
  if (points.length === 0) return '';
  const f = (n: number) => Math.round(n * 10) / 10;
  let d = `M${f(points[0]![0])},${f(points[0]![1])}`;
  for (let i = 1; i < points.length - 1; i++) {
    const prev = points[i - 1]!;
    const cur = points[i]!;
    const next = points[i + 1]!;
    const lin = Math.hypot(cur[0] - prev[0], cur[1] - prev[1]);
    const lout = Math.hypot(next[0] - cur[0], next[1] - cur[1]);
    const r = Math.min(radius, lin / 2, lout / 2);
    if (r < 0.5) {
      d += ` L${f(cur[0])},${f(cur[1])}`;
      continue;
    }
    const p1: Point = [cur[0] - ((cur[0] - prev[0]) / lin) * r, cur[1] - ((cur[1] - prev[1]) / lin) * r];
    const p2: Point = [cur[0] + ((next[0] - cur[0]) / lout) * r, cur[1] + ((next[1] - cur[1]) / lout) * r];
    d += ` L${f(p1[0])},${f(p1[1])} Q${f(cur[0])},${f(cur[1])} ${f(p2[0])},${f(p2[1])}`;
  }
  const last = points[points.length - 1]!;
  d += ` L${f(last[0])},${f(last[1])}`;
  return d;
}

/** Distance from p to the segment a→b, and the parameter of the closest point. */
export function segmentDistance(p: Point, a: Point, b: Point): { dist: number; t: number } {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2));
  return { dist: Math.hypot(p[0] - (a[0] + dx * t), p[1] - (a[1] + dy * t)), t };
}
