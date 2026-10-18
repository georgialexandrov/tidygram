import { bandsKind, type LayerDef, type Point, type TemplateKind, type TemplateSettings } from '../layout/layout-file.ts';
import { layersOf, resolveAssignments } from '../layout/template/defs.ts';
import { findViolations, type Violation } from '../layout/template/rules.ts';
import type { Diagram } from '../model/types.ts';
import type { Box } from './containers.ts';
import { capsBlock, LINE_HEIGHT, measureText, type TextBlock } from './measure.ts';
import type { Theme } from './theme.ts';

/**
 * Template backgrounds: bands, a hexagon with adapter panels, or rings.
 * Derived from where the members are, the way containers fit their children,
 * so a drag, a size change or a fit can never leave an element outside its
 * layer. Placement (`layout/template/place.ts`) uses the same functions, so
 * right after placing, the derived geometry is exactly the planned one.
 */

export interface TemplateTitle {
  text: TextBlock;
  /** Left edge (`start`) or centre (`middle`) of the text, and its top. */
  x: number;
  y: number;
  align: 'start' | 'middle';
}

export interface TemplateBand {
  id: string;
  box: Box;
  fill: string;
  title: TemplateTitle;
}

export interface TemplateHexagon {
  id: string;
  cx: number;
  cy: number;
  /** Circumradius of the flat-topped hexagon (vertices left and right). */
  r: number;
  fill: string;
  title: TemplateTitle;
}

export interface TemplateRing extends RingShape {
  id: string;
  /** The ring inside (zeros for the core). */
  inner: RingShape;
  fill: string;
  title: TemplateTitle;
}

export interface TemplateScene {
  kind: TemplateKind;
  layers: LayerDef[];
  /** Element id → layer id, as resolved for this build (assignments, guesses, default). */
  assigned: Map<string, string>;
  /** Layered: one band per layer, top to bottom. Hexagonal: the driving and driven panels. */
  bands: TemplateBand[];
  /** Hexagonal: the application hexagon, then the domain hexagon inside it (if any). */
  hexagons: TemplateHexagon[];
  /** Clean: rings inside out, all around one centre. */
  rings: TemplateRing[];
  center?: Point;
  violations: Violation[];
  bounds: Box;
}

/** Spacing for templates, in theme pixels: everything grows with the theme's scale. */
export function templateMetrics(theme: Theme) {
  const k = theme.scale;
  const size = theme.size.container;
  return {
    k,
    /** Room between a band's (ring's, panel's) edge and its members. */
    pad: 20 * k,
    /** Between two bands. */
    gap: 10 * k,
    /** Height of a band, thickness of a ring with nothing in it. */
    empty: 48 * k,
    /** Between elements in a row, and between rows in a band. */
    nodeGap: 48 * k,
    rowGap: 36 * k,
    /** Between the hexagon and the adapter columns, and between columns. */
    colGap: 72 * k,
    titleSize: size,
    titleHeight: size * LINE_HEIGHT,
  };
}

export type TemplateMetrics = ReturnType<typeof templateMetrics>;

/** A layer title as drawn: caps with tracking in the modern themes, bold in classic. */
export function titleBlock(label: string, theme: Theme): TextBlock {
  const size = theme.size.container;
  if (theme.containerTitle !== 'caps') return measureText(label, size, true, theme.widthFactor);
  return capsBlock(label, size, theme);
}

const fillAt = (theme: Theme, i: number, n: number) => {
  const fills = theme.colors.layerFills;
  // Spread the ramp over the layers: the first gets the lightest, the last the darkest.
  const at = n <= 1 ? 0 : Math.round((i / (n - 1)) * (fills.length - 1));
  return fills[Math.min(fills.length - 1, at)]!;
};

const union = (boxes: Box[]): Box | undefined => {
  if (!boxes.length) return undefined;
  const x0 = Math.min(...boxes.map((b) => b.x));
  const y0 = Math.min(...boxes.map((b) => b.y));
  const x1 = Math.max(...boxes.map((b) => b.x + b.w));
  const y1 = Math.max(...boxes.map((b) => b.y + b.h));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
};

// ---- layered ----------------------------------------------------------------------------------

/** Width of the title column on the left of every band. */
export function bandGutter(layers: LayerDef[], theme: Theme): number {
  const m = templateMetrics(theme);
  return Math.max(...layers.map((l) => titleBlock(l.label, theme).width)) + m.pad * 1.5;
}

/**
 * Bands top to bottom, as wide as the widest content plus the title gutter.
 * A band spans its members (plus padding); bands that would overlap split
 * the difference; an empty band gets a minimum height in its slot.
 */
export function layeredBands(layers: LayerDef[], members: Map<string, Box[]>, theme: Theme): TemplateBand[] {
  const m = templateMetrics(theme);
  const all = union([...members.values()].flat());
  if (!all) return [];
  const gutter = bandGutter(layers, theme);
  const x = all.x - m.pad - gutter;
  const w = all.w + m.pad * 2 + gutter;
  const spans: ({ y0: number; y1: number } | undefined)[] = layers.map((l) => {
    const b = union(members.get(l.id) ?? []);
    return b && { y0: b.y - m.pad, y1: b.y + b.h + m.pad };
  });
  // Non-empty neighbours that overlap meet halfway.
  let prev: { y0: number; y1: number } | undefined;
  for (const s of spans) {
    if (!s) continue;
    if (prev && s.y0 < prev.y1 + m.gap) {
      const mid = (prev.y1 + s.y0) / 2;
      prev.y1 = Math.max(prev.y0 + m.titleHeight, mid - m.gap / 2);
      s.y0 = Math.max(prev.y1 + m.gap, mid + m.gap / 2);
      s.y1 = Math.max(s.y1, s.y0 + m.titleHeight);
    }
    prev = s;
  }
  // Empty bands go into their slot: after the band above, or before the band below.
  const out: { y0: number; y1: number }[] = [];
  for (let i = 0; i < layers.length; i++) {
    const s = spans[i];
    if (s) {
      out.push(s);
      continue;
    }
    const above = out[i - 1];
    if (above) out.push({ y0: above.y1 + m.gap, y1: above.y1 + m.gap + m.empty });
    else {
      const below = spans.slice(i + 1).findIndex(Boolean);
      const empties = below + 1; // this one and the empty ones between it and the next real band
      const next = spans[i + 1 + below]!;
      const y1 = next.y0 - m.gap - (empties - 1) * (m.empty + m.gap);
      out.push({ y0: y1 - m.empty, y1 });
    }
  }
  return layers.map((l, i) => {
    const s = out[i]!;
    const text = titleBlock(l.label, theme);
    return {
      id: l.id,
      box: { x, y: s.y0, w, h: s.y1 - s.y0 },
      fill: fillAt(theme, i, layers.length),
      title: { text, x: x + m.pad * 0.75, y: (s.y0 + s.y1) / 2 - text.height / 2, align: 'start' },
    };
  });
}

// ---- hexagonal ---------------------------------------------------------------------------------

const SQRT3 = Math.sqrt(3);

/** Vertices of a flat-topped hexagon (points left and right), clockwise from the right. */
export function hexPoints(cx: number, cy: number, r: number): Point[] {
  return [0, 1, 2, 3, 4, 5].map((i) => [cx + r * Math.cos((i * Math.PI) / 3), cy + r * Math.sin((i * Math.PI) / 3)]);
}

/** Smallest flat-topped hexagon around a box grown by `pad`, centred on it. */
export function hexAround(box: Box, pad: number): { cx: number; cy: number; r: number } {
  const w = box.w + pad * 2;
  const h = box.h + pad * 2;
  return { cx: box.x + box.w / 2, cy: box.y + box.h / 2, r: Math.max(h / SQRT3, w / 2 + h / (2 * SQRT3)) };
}

/** x of the hexagon's left (`-1`) or right (`1`) outline at height y; clamped to the top/bottom edge. */
export function hexEdgeX(h: { cx: number; cy: number; r: number }, y: number, side: -1 | 1): number {
  const dy = Math.min(Math.abs(y - h.cy), (h.r * SQRT3) / 2);
  return h.cx + side * (h.r - dy / SQRT3);
}

export function insideHex(h: { cx: number; cy: number; r: number }, [x, y]: Point): boolean {
  if (Math.abs(y - h.cy) > (h.r * SQRT3) / 2) return false;
  return x >= hexEdgeX(h, y, -1) && x <= hexEdgeX(h, y, 1);
}

/** How many ports one side of a hexagon of radius r holds, `step` apart vertically: they use the middle 80% of its height. */
export function hexRadiusForPorts(count: number, step: number): number {
  return count <= 1 ? 0 : ((count - 1) * step) / (0.8 * SQRT3);
}

/** Vertical step between ports: the tallest port plus a gap. */
export function portStep(portBoxes: Box[], theme: Theme): number {
  return Math.max(0, ...portBoxes.map((b) => b.h)) + templateMetrics(theme).rowGap * 0.75;
}

/**
 * The application hexagon around the core (application + domain members,
 * the domain in its own inner hexagon), at least big enough for the ports on
 * either side, and the driving / driven panels around the adapters.
 */
export function hexGeometry(layers: LayerDef[], members: Map<string, Box[]>, theme: Theme): { hexagons: TemplateHexagon[]; bands: TemplateBand[] } {
  const m = templateMetrics(theme);
  const label = (id: string) => layers.find((l) => l.id === id)?.label ?? id;
  const get = (id: string) => members.get(id) ?? [];
  const domain = union(get('domain'));
  const inner = domain && hexAround({ ...domain, y: domain.y - m.titleHeight, h: domain.h + m.titleHeight }, m.pad);
  const coreBoxes = [...get('application')];
  if (inner) coreBoxes.push({ x: inner.cx - inner.r, y: inner.cy - (inner.r * SQRT3) / 2, w: inner.r * 2, h: inner.r * SQRT3 });
  const ports = [...get('inbound'), ...get('outbound')];
  const step = portStep(ports, theme);
  const portR = Math.max(hexRadiusForPorts(get('inbound').length, step), hexRadiusForPorts(get('outbound').length, step));
  let core = union(coreBoxes);
  if (!core) {
    // Ports and adapters but no core: a hexagon centred on the ports.
    const p = union(ports) ?? union([...members.values()].flat()) ?? { x: 0, y: 0, w: 0, h: 0 };
    core = { x: p.x + p.w / 2, y: p.y + p.h / 2, w: 0, h: 0 };
  }
  const outer = hexAround({ ...core, y: core.y - m.titleHeight, h: core.h + m.titleHeight }, m.pad * 1.5);
  outer.r = Math.max(outer.r, portR, m.empty * 2);
  const hexTitle = (id: string, h: { cx: number; cy: number; r: number }): TemplateTitle => {
    const text = titleBlock(label(id), theme);
    return { text, x: h.cx, y: h.cy - (h.r * SQRT3) / 2 + m.pad * 0.6, align: 'middle' };
  };
  const hexagons: TemplateHexagon[] = [{ id: 'application', ...outer, fill: theme.colors.layerFills[2]!, title: hexTitle('application', outer) }];
  if (inner) hexagons.push({ id: 'domain', ...inner, fill: theme.colors.layerFills[3]!, title: hexTitle('domain', inner) });

  // Adapter panels: at least as tall as the hexagon, a title strip on top.
  const top = outer.cy - (outer.r * SQRT3) / 2;
  const bottom = outer.cy + (outer.r * SQRT3) / 2;
  const bands: TemplateBand[] = [];
  for (const id of ['driving', 'driven'] as const) {
    const b = union(get(id));
    if (!b) continue;
    const y0 = Math.min(top, b.y - m.pad - m.titleHeight - m.pad * 0.5);
    const y1 = Math.max(bottom, b.y + b.h + m.pad);
    const box = { x: b.x - m.pad, y: y0, w: b.w + m.pad * 2, h: y1 - y0 };
    const text = titleBlock(label(id), theme);
    bands.push({ id, box, fill: theme.colors.layerFills[0]!, title: { text, x: box.x + box.w / 2, y: y0 + m.pad * 0.6, align: 'middle' } });
  }
  return { hexagons, bands };
}

// ---- clean / onion ------------------------------------------------------------------------------

/**
 * A ring is a rounded rectangle: half-width `a`, half-height `b`, corner
 * radius `c` (always `RING_ROUND` of the shorter half), centred on the rings'
 * common centre. Convex, symmetric about both axes, and an offset of one
 * rounded rectangle is another (grow all three by the same amount), so
 * nested rings keep an even band. Each ring takes the smallest `a` and `b`
 * that hold its members (boxes grown by the padding) and the ring inside
 * (grown by the band thickness).
 */
export const RING_ROUND = 0.6;
/** The shape rings are nominally (width over height): placement spreads members in this proportion. */
export const RING_ASPECT = 1.8;

export interface RingShape {
  a: number;
  b: number;
  c: number;
}

export const ringShape = (a: number, b: number): RingShape => ({ a, b, c: RING_ROUND * Math.min(a, b) });

/** Is the point (relative to the centre) inside the shape grown by `d`? */
export function insideRing(s: RingShape, x: number, y: number, d = 0): boolean {
  const c = s.c + d;
  if (c < 0) return false;
  const dx = Math.max(Math.abs(x) - (s.a - s.c), 0);
  const dy = Math.max(Math.abs(y) - (s.b - s.c), 0);
  return dx * dx + dy * dy <= c * c + 1e-9;
}

/** Height (above the centre) of the shape's outline at horizontal offset x. */
export function ringTopAt(s: RingShape, x: number): number {
  const dx = Math.abs(x) - (s.a - s.c);
  if (dx <= 0) return s.b;
  return s.b - s.c + Math.sqrt(Math.max(0, s.c * s.c - dx * dx));
}

/** A point on the outline, going once round as t runs 0..1 (from the right, clockwise on screen). */
export function ringPoint(s: RingShape, t: number): Point {
  const sx = s.a - s.c;
  const sy = s.b - s.c;
  const arc = (Math.PI / 2) * s.c;
  const lens = [sy * 2, arc, sx * 2, arc, sy * 2, arc, sx * 2, arc];
  const total = lens.reduce((p, q) => p + q, 0);
  let d = (((t % 1) + 1) % 1) * total - sy; // start mid-way down the right side
  if (d < 0) d += total;
  const side = [
    (u: number): Point => [s.a, -sy + u],
    (u: number): Point => [sx + s.c * Math.cos(u / s.c), sy + s.c * Math.sin(u / s.c)],
    (u: number): Point => [sx - u, s.b],
    (u: number): Point => [-sx - s.c * Math.sin(u / s.c), sy + s.c * Math.cos(u / s.c)],
    (u: number): Point => [-s.a, sy - u],
    (u: number): Point => [-sx - s.c * Math.cos(u / s.c), -sy - s.c * Math.sin(u / s.c)],
    (u: number): Point => [-sx + u, -s.b],
    (u: number): Point => [sx + s.c * Math.sin(u / s.c), -sy - s.c * Math.cos(u / s.c)],
  ];
  for (let i = 0; i < 8; i++) {
    if (d <= lens[i]! || i === 7) return side[i]!(Math.min(d, lens[i]!));
    d -= lens[i]!;
  }
  return [s.a, 0];
}

/**
 * The smallest half-height `b` of a ring with half-width `r·b` that holds the
 * point (u, v) (both non-negative, relative to the centre): the gauge of the
 * unit rounded rectangle, solved in closed form.
 */
export function ringGauge(u: number, v: number, r: number): number {
  const rho = RING_ROUND * Math.min(r, 1);
  const al = r - rho;
  const be = 1 - rho;
  const fits = (s: number) => {
    const dx = Math.max(u - s * al, 0);
    const dy = Math.max(v - s * be, 0);
    return dx * dx + dy * dy <= s * s * rho * rho * (1 + 1e-12);
  };
  const s0 = Math.max(u / r, v);
  if (fits(s0)) return s0;
  // Beyond the straight sides in both directions: (u - s·al)² + (v - s·be)² = (s·rho)².
  const K = al * al + be * be - rho * rho;
  const P = u * al + v * be;
  const Q = u * u + v * v;
  const roots: number[] = [];
  if (Math.abs(K) < 1e-12) roots.push(Q / (2 * P));
  else {
    const disc = P * P - K * Q;
    if (disc >= 0) roots.push((P - Math.sqrt(disc)) / K, (P + Math.sqrt(disc)) / K);
  }
  let best = Infinity;
  for (const s of roots) if (s >= s0 - 1e-9 && s < best && fits(s * (1 + 1e-9))) best = s;
  if (best < Infinity) return best;
  let hi = s0 * 2;
  while (!fits(hi)) hi *= 2;
  let lo = s0;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (fits(mid)) hi = mid;
    else lo = mid;
  }
  return hi;
}

/** Area of a rounded rectangle. */
export const ringArea = (s: RingShape) => 4 * s.a * s.b - (4 - Math.PI) * s.c * s.c;

/** Keeps the points no other point is beyond in both directions: all a convex symmetric ring needs to hold. */
function frontier(points: Point[]): Point[] {
  const sorted = [...points].sort((p, q) => q[0] - p[0] || q[1] - p[1]);
  const out: Point[] = [];
  let top = -Infinity;
  for (const p of sorted) {
    if (p[1] > top) {
      out.push(p);
      top = p[1];
    }
  }
  return out;
}

/** What a ring has to hold of the ring inside it: its outline grown by the band thickness, sampled (first quadrant). */
export function innerNeeds(inner: RingShape | undefined, m: TemplateMetrics): Point[] {
  if (!inner) return [[m.empty * RING_ASPECT * 0.9, 0], [0, m.empty * 0.9]];
  const R = inner.c + m.empty;
  return Array.from({ length: 7 }, (_, i): Point => [inner.a - inner.c + R * Math.cos((i * Math.PI) / 12), inner.b - inner.c + R * Math.sin((i * Math.PI) / 12)]);
}

/** Corner points a ring must hold for these members (first quadrant): boxes grown by the padding, and room for the title over members under it. */
export function memberNeeds(boxes: Box[], [cx, cy]: Point, m: TemplateMetrics, title?: { width: number; height: number }): Point[] {
  const pts: Point[] = [];
  for (const b of boxes) {
    for (const x of [b.x - m.pad - cx, b.x + b.w + m.pad - cx]) for (const y of [b.y - m.pad - cy, b.y + b.h + m.pad - cy]) pts.push([Math.abs(x), Math.abs(y)]);
    // The title sits at the top centre: members under it need it clear above them.
    if (title && b.y < cy && Math.abs(b.x + b.w / 2 - cx) < title.width / 2 + b.w / 2 + m.pad) pts.push([title.width / 2 + m.pad, cy - b.y + title.height + m.pad * 1.5]);
  }
  return pts;
}

/** The smallest ring holding the points (first quadrant), by area over its proportions. */
export function fitRing(points: Point[]): RingShape {
  const pts = frontier(points);
  let best: { area: number; b: number; r: number } | undefined;
  const STEPS = 28;
  for (let i = 0; i <= STEPS; i++) {
    const r = Math.exp((Math.log(4) * i) / STEPS);
    let b = 0;
    for (const [u, v] of pts) b = Math.max(b, ringGauge(u, v, r));
    const rho = RING_ROUND * Math.min(r, 1) * b;
    const area = 4 * r * b * b - (4 - Math.PI) * rho * rho;
    if (!best || area < best.area - 1e-9) best = { area, b, r };
  }
  return ringShape(best!.r * best!.b, best!.b);
}

/** Box around a ring. */
export function ringBox(s: RingShape, [cx, cy]: Point): Box {
  return { x: cx - s.a, y: cy - s.b, w: s.a * 2, h: s.b * 2 };
}

/** Does a box keep `pad` clear of the inside of a ring (its nearest point to the centre beyond the ring grown by pad)? */
export function clearOfRing(b: Box, [cx, cy]: Point, s: RingShape, pad: number): boolean {
  const nx = Math.max(b.x, Math.min(cx, b.x + b.w)) - cx;
  const ny = Math.max(b.y, Math.min(cy, b.y + b.h)) - cy;
  return !insideRing(s, nx, ny, pad - 1e-6);
}

/**
 * The rings' centre: the mean of the core ring's members (placement puts one
 * element at the centre, or several evenly round it), else of the first ring
 * with at least two members (evenly spaced points average to the centre).
 */
export function ringCenter(layers: LayerDef[], members: Map<string, Box[]>): Point | undefined {
  const mean = (boxes: Box[]): Point => [boxes.reduce((s, b) => s + b.x + b.w / 2, 0) / boxes.length, boxes.reduce((s, b) => s + b.y + b.h / 2, 0) / boxes.length];
  const core = members.get(layers[0]!.id) ?? [];
  if (core.length) return mean(core);
  for (const l of layers) {
    const boxes = members.get(l.id) ?? [];
    if (boxes.length >= 2) return mean(boxes);
  }
  const all = [...members.values()].flat();
  return all.length ? mean(all) : undefined;
}

/** Concentric rings inside out: each the smallest rounded rectangle holding its members (padded) and the ring inside (plus a band), with its title at the top. */
export function cleanRings(layers: LayerDef[], members: Map<string, Box[]>, theme: Theme, center = ringCenter(layers, members)): TemplateRing[] {
  if (!center) return [];
  const m = templateMetrics(theme);
  const rings: TemplateRing[] = [];
  let inner: RingShape | undefined;
  layers.forEach((l, i) => {
    const boxes = members.get(l.id) ?? [];
    const text = titleBlock(l.label, theme);
    const shape = fitRing([...innerNeeds(inner, m), ...memberNeeds(boxes, center, m, { width: text.width, height: m.titleHeight })]);
    rings.push({
      id: l.id,
      ...shape,
      inner: inner ?? { a: 0, b: 0, c: 0 },
      fill: fillAt(theme, layers.length - 1 - i, layers.length),
      title: { text, x: center[0], y: center[1] - ringTopAt(shape, text.width / 2 + m.pad) + m.pad * 0.5, align: 'middle' },
    });
    inner = shape;
  });
  return rings;
}

/** Does the segment p→q touch the box? */
function segmentHits(p: Point, q: Point, b: Box): boolean {
  let t0 = 0;
  let t1 = 1;
  const d = [q[0] - p[0], q[1] - p[1]];
  for (const [lo, hi, o, dd] of [[b.x, b.x + b.w, p[0], d[0]!], [b.y, b.y + b.h, p[1], d[1]!]] as const) {
    if (Math.abs(dd) < 1e-9) {
      if (o < lo || o > hi) return false;
    } else {
      const [a, c] = [(lo - o) / dd, (hi - o) / dd];
      t0 = Math.max(t0, Math.min(a, c));
      t1 = Math.min(t1, Math.max(a, c));
      if (t0 > t1) return false;
    }
  }
  return true;
}

/**
 * Ring titles sit at the top centre of their ring; where a line (or a label,
 * or a member) is in the way they slide along the ring's top to the nearest
 * free spot, following the outline's curve at the corners. Titles with no
 * free spot stay where they are.
 */
export function nudgeRingTitles(t: TemplateScene, lines: Point[][], obstacles: Box[], theme: Theme): TemplateScene {
  if (!t.center || !t.rings.length) return t;
  const [cx, cy] = t.center;
  const m = templateMetrics(theme);
  const grow = (b: Box, d: number): Box => ({ x: b.x - d, y: b.y - d, w: b.w + d * 2, h: b.h + d * 2 });
  const segs = lines.flatMap((pts) => pts.slice(1).map((q, i) => [pts[i]!, q] as const));
  let moved = false;
  const rings = t.rings.map((ring) => {
    const { text } = ring.title;
    const half = text.width / 2 + m.pad;
    const spot = (dx: number) => ({ x: cx + dx, y: cy - ringTopAt(ring, Math.abs(dx) + half) + m.pad * 0.5 });
    const rect = (dx: number): Box => {
      const p = spot(dx);
      return { x: p.x - text.width / 2, y: p.y, w: text.width, h: m.titleHeight };
    };
    const free = (dx: number) => {
      const r = rect(dx);
      const g = grow(r, 3 * theme.scale);
      // Stays in its band: clear of the ring inside.
      for (const [px, py] of [[r.x, r.y + r.h], [r.x + r.w, r.y + r.h], [r.x + r.w / 2, r.y + r.h]] as const) if (ring.inner.a > 0 && insideRing(ring.inner, px - cx, py - cy, 2)) return false;
      if (obstacles.some((o) => o.x < g.x + g.w && g.x < o.x + o.w && o.y < g.y + g.h && g.y < o.y + o.h)) return false;
      return !segs.some(([p, q]) => segmentHits(p, q, g));
    };
    if (free(0)) return ring;
    const room = ring.a - ring.c - text.width / 2;
    for (let step = 8 * theme.scale; step <= room; step += 8 * theme.scale) {
      for (const dx of [step, -step]) {
        if (!free(dx)) continue;
        moved = true;
        const p = spot(dx);
        return { ...ring, title: { ...ring.title, x: p.x, y: p.y } };
      }
    }
    return ring;
  });
  return moved ? { ...t, rings } : t;
}

// ---- the whole backdrop -------------------------------------------------------------------------

/** Members' boxes per layer. */
export function membersByLayer(assigned: Map<string, string>, boxes: Map<string, Box>): Map<string, Box[]> {
  const out = new Map<string, Box[]>();
  for (const [id, box] of boxes) {
    const layer = assigned.get(id);
    if (!layer) continue;
    const list = out.get(layer) ?? [];
    list.push(box);
    out.set(layer, list);
  }
  return out;
}

export function buildTemplateScene(diagram: Diagram, template: TemplateSettings, boxes: Map<string, Box>, theme: Theme): TemplateScene {
  const layers = layersOf(template, diagram);
  const assigned = resolveAssignments(diagram, template);
  const members = membersByLayer(assigned, boxes);
  const scene: TemplateScene = { kind: template.kind, layers, assigned, bands: [], hexagons: [], rings: [], violations: findViolations(diagram, template, assigned), bounds: { x: 0, y: 0, w: 0, h: 0 } };
  const parts: Box[] = [];
  if (bandsKind(template.kind)) {
    scene.bands = layeredBands(layers, members, theme);
  } else if (template.kind === 'hexagonal') {
    Object.assign(scene, hexGeometry(layers, members, theme));
    for (const h of scene.hexagons) parts.push({ x: h.cx - h.r, y: h.cy - (h.r * SQRT3) / 2, w: h.r * 2, h: h.r * SQRT3 });
  } else {
    scene.center = ringCenter(layers, members);
    scene.rings = cleanRings(layers, members, theme, scene.center);
    const outer = scene.rings.at(-1);
    if (outer && scene.center) parts.push(ringBox(outer, scene.center));
  }
  parts.push(...scene.bands.map((b) => b.box));
  scene.bounds = union(parts) ?? scene.bounds;
  return scene;
}

/**
 * The layer a point falls in, for dropping a dragged element: the band
 * whose slot holds its y (the outer bands reach to infinity), the ring at its
 * distance, or the hexagon zone (domain, application, a port on the outline,
 * driving left, driven right).
 */
export function regionAt(t: TemplateScene, [x, y]: Point, portBand = 0): string | undefined {
  if (bandsKind(t.kind)) {
    if (!t.bands.length) return undefined;
    for (let i = 0; i < t.bands.length - 1; i++) {
      const a = t.bands[i]!.box;
      const b = t.bands[i + 1]!.box;
      if (y < (a.y + a.h + b.y) / 2) return t.bands[i]!.id;
    }
    return t.bands.at(-1)!.id;
  }
  if (t.kind === 'clean') {
    if (!t.center || !t.rings.length) return undefined;
    const [dx, dy] = [x - t.center[0], y - t.center[1]];
    return (t.rings.find((r) => insideRing(r, dx, dy)) ?? t.rings.at(-1)!).id;
  }
  const outer = t.hexagons[0];
  if (!outer) return undefined;
  const inner = t.hexagons[1];
  const inside = insideHex(outer, [x, y]);
  const side: -1 | 1 = x < outer.cx ? -1 : 1;
  const edge = hexEdgeX(outer, y, side);
  const onOutline = Math.abs(y - outer.cy) < (outer.r * SQRT3) / 2 && Math.abs(x - edge) <= portBand;
  if (onOutline) return side < 0 ? 'inbound' : 'outbound';
  if (inside) return inner && insideHex(inner, [x, y]) ? 'domain' : 'application';
  return side < 0 ? 'driving' : 'driven';
}
