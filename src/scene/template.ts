import type { LayerDef, Point, TemplateKind, TemplateSettings } from '../layout/layout-file.ts';
import { layersOf, resolveAssignments } from '../layout/template/defs.ts';
import { findViolations, type Violation } from '../layout/template/rules.ts';
import type { Diagram } from '../model/types.ts';
import type { Box } from './containers.ts';
import { LINE_HEIGHT, measureText, textWidth, type TextBlock } from './measure.ts';
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

/**
 * Rings are ellipses this much wider than tall: element boxes are wide, and
 * so are slides. All ring maths happens in a space squeezed horizontally by
 * this factor, where the rings are circles.
 */
export const RING_ASPECT = 1.8;

export interface TemplateRing {
  id: string;
  /** Outer radius (vertical; the horizontal one is `RING_ASPECT` times it); the inner one is the previous ring's outer radius (0 for the core). */
  r: number;
  inner: number;
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
  const upper = label.toUpperCase();
  return { lines: [label], width: textWidth(upper, size, true, theme.widthFactor) + 0.08 * size * upper.length, height: size * LINE_HEIGHT, size };
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

/** Farthest corner of a box from a point, in ring space: the radius a ring around that point needs to hold the box. */
export function cornerDistance(box: Box, [cx, cy]: Point): number {
  const dx = Math.max(Math.abs(box.x - cx), Math.abs(box.x + box.w - cx)) / RING_ASPECT;
  const dy = Math.max(Math.abs(box.y - cy), Math.abs(box.y + box.h - cy));
  return Math.hypot(dx, dy);
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

/** Concentric rings inside out; each holds its members' boxes with padding and room for its title at the top. */
export function cleanRings(layers: LayerDef[], members: Map<string, Box[]>, theme: Theme, center = ringCenter(layers, members)): TemplateRing[] {
  if (!center) return [];
  const m = templateMetrics(theme);
  const rings: TemplateRing[] = [];
  let r = 0;
  layers.forEach((l, i) => {
    const boxes = members.get(l.id) ?? [];
    const inner = r;
    const reach = boxes.length ? Math.max(...boxes.map((b) => cornerDistance(b, center))) : 0;
    const text = titleBlock(l.label, theme);
    // The title needs room only at the top, over the members below it; elsewhere the padding is enough.
    const under = boxes.filter((b) => Math.abs(b.x + b.w / 2 - center[0]) < text.width / 2 + b.w / 2 + m.pad && b.y < center[1]);
    const titleRoom = under.length ? Math.max(...under.map((b) => center[1] - b.y)) + m.titleHeight + m.pad * 1.5 : 0;
    r = Math.max(inner + m.empty, boxes.length ? Math.max(reach + m.pad, titleRoom) : 0);
    rings.push({ id: l.id, r, inner, fill: fillAt(theme, layers.length - 1 - i, layers.length), title: { text, x: center[0], y: center[1] - r + m.pad * 0.5, align: 'middle' } });
  });
  return rings;
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
  if (template.kind === 'layered') {
    scene.bands = layeredBands(layers, members, theme);
  } else if (template.kind === 'hexagonal') {
    Object.assign(scene, hexGeometry(layers, members, theme));
    for (const h of scene.hexagons) parts.push({ x: h.cx - h.r, y: h.cy - (h.r * SQRT3) / 2, w: h.r * 2, h: h.r * SQRT3 });
  } else {
    scene.center = ringCenter(layers, members);
    scene.rings = cleanRings(layers, members, theme, scene.center);
    const outer = scene.rings.at(-1);
    if (outer && scene.center) parts.push({ x: scene.center[0] - outer.r * RING_ASPECT, y: scene.center[1] - outer.r, w: outer.r * 2 * RING_ASPECT, h: outer.r * 2 });
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
  if (t.kind === 'layered') {
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
    const d = Math.hypot((x - t.center[0]) / RING_ASPECT, y - t.center[1]);
    return (t.rings.find((r) => d < r.r) ?? t.rings.at(-1)!).id;
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
