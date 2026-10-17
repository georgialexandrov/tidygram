import type { Point } from '../layout/layout-file.ts';
import type { Diagram } from '../model/types.ts';
import type { Box } from './containers.ts';
import { inside } from './geometry.ts';
import type { Scene, SceneEdge } from './scene.ts';

/**
 * Picture-quality numbers for a built graph scene: the defects that are
 * obvious in a rendered diagram but invisible to "every line was routed".
 * Used by the regression tests and `scripts/engine.ts`; nothing at runtime.
 */
export interface Quality {
  /** Extra container-border crossings: a line that enters and leaves a container it has no end in, or crosses one of its own twice. */
  containerCrossings: number;
  /** Lines through a container's title. */
  titleCrossings: number;
  /** Lines through a box that is neither of their ends. */
  nodeCrossings: number;
  /** Edge or end labels on top of a box, a container title, or another label. */
  labelOverlaps: number;
  /** Labels on top of another edge's line (softer: sometimes unavoidable). */
  labelLineOverlaps: number;
  /** Corners, summed over all lines. */
  bends: number;
  /** Inner segments shorter than 12 px: the router's tiny steps. */
  jogs: number;
  /** Line ends that don't meet the outline square-on (arrowheads come in at an angle or along the side). */
  skewEnds: number;
  /** Width over height of the whole picture. */
  aspect: number;
  /** What was counted, for messages: `kind: edge vs other`. */
  details: string[];
}

const EPS = 1;

/** The part of segment a→b inside `box` (shrunk by `m`), as parameters, or undefined (Liang–Barsky). */
function clipSegment(a: Point, b: Point, box: Box, m = EPS): [number, number] | undefined {
  const x0 = box.x + m;
  const y0 = box.y + m;
  const x1 = box.x + box.w - m;
  const y1 = box.y + box.h - m;
  if (x1 <= x0 || y1 <= y0) return undefined;
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  let t0 = 0;
  let t1 = 1;
  const edges: [number, number][] = [
    [-dx, a[0] - x0],
    [dx, x1 - a[0]],
    [-dy, a[1] - y0],
    [dy, y1 - a[1]],
  ];
  for (const [p, q] of edges) {
    if (p === 0) {
      if (q < 0) return undefined;
      continue;
    }
    const r = q / p;
    if (p < 0) t0 = Math.max(t0, r);
    else t1 = Math.min(t1, r);
    if (t0 > t1) return undefined;
  }
  return t1 - t0 > 1e-6 ? [t0, t1] : undefined;
}

export function pathHitsBox(points: Point[], box: Box, m = EPS): boolean {
  for (let i = 1; i < points.length; i++) if (clipSegment(points[i - 1]!, points[i]!, box, m)) return true;
  return false;
}

/** How often the polyline crosses the box's outline. The box is convex, so per segment: 0, 1 or 2. */
export function borderCrossings(points: Point[], box: Box): number {
  const isIn = ([x, y]: Point) => x > box.x && x < box.x + box.w && y > box.y && y < box.y + box.h;
  let count = 0;
  for (let i = 1; i < points.length; i++) {
    const [a, b] = [points[i - 1]!, points[i]!];
    const [ia, ib] = [isIn(a), isIn(b)];
    if (ia !== ib) count++;
    else if (!ia && clipSegment(a, b, box, 0)) count += 2;
  }
  return count;
}

export function overlapArea(a: Box, b: Box): number {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

/** Every label box of a line: the middle label (with its chip) and the end labels. */
export function labelBoxes(e: SceneEdge, scale: number): { kind: 'label' | 'from' | 'to'; box: Box }[] {
  const out: { kind: 'label' | 'from' | 'to'; box: Box }[] = [];
  if (e.label) {
    const { text, x, y } = e.label;
    out.push({ kind: 'label', box: { x: x - text.width / 2 - 4 * scale, y: y - text.height / 2 - 1 * scale, w: text.width + 8 * scale, h: text.height + 2 * scale } });
  }
  for (const [kind, l] of [['from', e.fromLabel], ['to', e.toLabel]] as const) {
    if (l) out.push({ kind, box: { x: l.x - l.text.width / 2, y: l.y - l.text.height / 2, w: l.text.width, h: l.text.height } });
  }
  return out;
}

/** True when the line's end at `end` meets a rectangular outline perpendicular to the side it lands on. */
function squareEnd(points: Point[], box: Box): boolean {
  const [x, y] = points[points.length - 1]!;
  const [px, py] = points[points.length - 2]!;
  const horizontal = Math.abs(py - y) < 0.5;
  const vertical = Math.abs(px - x) < 0.5;
  const onSide = Math.abs(x - box.x) < 1.5 || Math.abs(x - box.x - box.w) < 1.5;
  const onTopBottom = Math.abs(y - box.y) < 1.5 || Math.abs(y - box.y - box.h) < 1.5;
  if (onSide && onTopBottom) return false; // a corner
  return (onSide && horizontal) || (onTopBottom && vertical);
}

export function measureQuality(scene: Scene, diagram: Diagram): Quality {
  const q: Quality = { containerCrossings: 0, titleCrossings: 0, nodeCrossings: 0, labelOverlaps: 0, labelLineOverlaps: 0, bends: 0, jogs: 0, skewEnds: 0, aspect: scene.bounds.h ? scene.bounds.w / scene.bounds.h : 1, details: [] };
  const parentOf = new Map<string, string | undefined>([...diagram.nodes.map((n) => [n.id, n.parent] as const), ...diagram.containers.map((c) => [c.id, c.parent] as const)]);
  const within = (id: string, container: string): boolean => {
    for (let p = parentOf.get(id); p; p = parentOf.get(p)) if (p === container) return true;
    return false;
  };
  const nodes = new Map(scene.nodes.map((n) => [n.node.id, n]));
  const k = scene.theme.scale;

  for (const e of scene.edges) {
    const pts = e.points;
    const { from, to, id } = e.edge;
    q.bends += Math.max(0, pts.length - 2);
    for (let i = 2; i < pts.length - 1; i++) {
      if (Math.hypot(pts[i]![0] - pts[i - 1]![0], pts[i]![1] - pts[i - 1]![1]) < 12) {
        q.jogs++;
        q.details.push(`jog: ${id}`);
      }
    }
    for (const c of scene.containers) {
      if (c.title && pathHitsBox(pts, c.title, 3 * k)) {
        q.titleCrossings++;
        q.details.push(`title: ${id} through ${c.id}`);
      }
      if (c.kind === 'swimlane' || from === c.id || to === c.id) continue;
      const expected = within(from, c.id) !== within(to, c.id) ? 1 : 0;
      const extra = borderCrossings(pts, c.box) - expected;
      if (extra > 0) {
        q.containerCrossings += extra;
        q.details.push(`container: ${id} through ${c.id}`);
      }
    }
    for (const n of scene.nodes) {
      if (n.node.id === from || n.node.id === to) continue;
      if (pathHitsBox(pts, n.box, 2)) {
        q.nodeCrossings++;
        q.details.push(`node: ${id} through ${n.node.id}`);
      }
    }
    // Ends on box-shaped outlines should come in square; on round ones, at least on the outline.
    for (const [nodeId, line] of [[to, pts], [from, [...pts].reverse()]] as const) {
      const n = nodes.get(nodeId);
      if (!n || line.length < 2) continue;
      const a = n.anchor;
      const ok = a.shape === 'rect' ? squareEnd(line, { x: a.cx - a.w / 2, y: a.cy - a.h / 2, w: a.w, h: a.h }) : onOutline(line, a);
      if (!ok) {
        q.skewEnds++;
        q.details.push(`end: ${id} at ${nodeId}`);
      }
    }
  }

  const labels = scene.edges.flatMap((e) => labelBoxes(e, k).map((l) => ({ ...l, edge: e })));
  for (let i = 0; i < labels.length; i++) {
    const l = labels[i]!;
    for (const n of scene.nodes) {
      if (overlapArea(l.box, n.box) > 2) {
        q.labelOverlaps++;
        q.details.push(`label: ${l.edge.edge.id}.${l.kind} on ${n.node.id}`);
      }
    }
    for (const c of scene.containers) {
      if (c.title && overlapArea(l.box, c.title) > 2) {
        q.labelOverlaps++;
        q.details.push(`label: ${l.edge.edge.id}.${l.kind} on title ${c.id}`);
      }
    }
    for (let j = i + 1; j < labels.length; j++) {
      if (overlapArea(l.box, labels[j]!.box) > 2) {
        q.labelOverlaps++;
        q.details.push(`label: ${l.edge.edge.id}.${l.kind} on ${labels[j]!.edge.edge.id}.${labels[j]!.kind}`);
      }
    }
    for (const e of scene.edges) {
      if (e === l.edge) continue;
      if (pathHitsBox(e.points, l.box, 1)) {
        q.labelLineOverlaps++;
        q.details.push(`label-line: ${l.edge.edge.id}.${l.kind} on ${e.edge.id}`);
      }
    }
  }
  return q;
}

/** A line end on a round outline (ellipse, diamond, pill): just outside, with the point a hair inwards inside. */
function onOutline(line: Point[], a: Parameters<typeof inside>[0]): boolean {
  const [x, y] = line[line.length - 1]!;
  const [px, py] = line[line.length - 2]!;
  const len = Math.hypot(x - px, y - py) || 1;
  const step: Point = [x + ((x - px) / len) * 2, y + ((y - py) / len) * 2];
  return !inside(a, [x, y]) && inside(a, step);
}

/** Number of proper crossings between the orthogonal segments of different lines. */
export function countCrossings(lines: Point[][]): number {
  type Seg = { a: Point; b: Point; line: number };
  const horizontal: Seg[] = [];
  const vertical: Seg[] = [];
  lines.forEach((pts, line) => {
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1]!;
      const b = pts[i]!;
      if (Math.abs(a[1] - b[1]) < 0.5) horizontal.push({ a, b, line });
      else if (Math.abs(a[0] - b[0]) < 0.5) vertical.push({ a, b, line });
    }
  });
  let crossings = 0;
  for (const h of horizontal) {
    const [x0, x1] = [Math.min(h.a[0], h.b[0]), Math.max(h.a[0], h.b[0])];
    const y = h.a[1];
    for (const v of vertical) {
      if (v.line === h.line) continue;
      const x = v.a[0];
      const [y0, y1] = [Math.min(v.a[1], v.b[1]), Math.max(v.a[1], v.b[1])];
      if (x > x0 + 0.5 && x < x1 - 0.5 && y > y0 + 0.5 && y < y1 - 0.5) crossings++;
    }
  }
  return crossings;
}
