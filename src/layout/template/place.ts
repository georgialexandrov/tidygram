import type { Diagram } from '../../model/types.ts';
import { nodeBox, type Box, type Positions } from '../../scene/containers.ts';
import { nodeShape, type NodeShape } from '../../scene/shapes.ts';
import { measureSecondary } from '../../scene/measure.ts';
import { cleanRings, clearOfRing, fitRing, hexEdgeX, hexGeometry, innerNeeds, layeredBands, memberNeeds, RING_ASPECT, ringArea, ringCenter, templateMetrics, titleBlock, type RingShape, type TemplateMetrics } from '../../scene/template.ts';
import type { Theme } from '../../scene/theme.ts';
import type { LayerDef, TemplateSettings } from '../layout-file.ts';
import { layersOf, resolveAssignments } from './defs.ts';

/**
 * Template placement: pure functions from the diagram, its assignments and
 * the element sizes to positions. Each one places everything; with `hints`
 * (current positions) it keeps elements in the order and roughly where they
 * are, which is how a drop into another band or a new element re-places
 * without reshuffling the picture.
 */

export interface PlaceOptions {
  /** Keep these elements' order and rough position. Others are placed by their connections. */
  hints?: Positions;
  /** Layered: elements per row before a band wraps into another row. */
  perRow?: number;
  /** Multiplies the gaps between elements (fit to frame tries several). */
  spread?: number;
  /** Skip the search for the smallest rings (clean): a first, cheap arrangement, for scoring many candidates. */
  quick?: boolean;
}

interface Ctx {
  diagram: Diagram;
  layers: LayerDef[];
  assigned: Map<string, string>;
  shapes: Map<string, NodeShape>;
  m: TemplateMetrics;
  theme: Theme;
  hints: Positions;
  /** Undirected neighbours (lines between elements). */
  near: Map<string, string[]>;
  /** Members per layer, in source order. */
  members: Map<string, string[]>;
  spread: number;
  quick: boolean;
  /** Lines as the source reads them (`A <|-- B` puts A first), for left-to-right order within a row. */
  flows: [string, string][];
  /** Widest label on a line between two elements, by `a|b` (both orders): the gap between them must hold it. */
  labels: Map<string, number>;
}

function context(diagram: Diagram, template: TemplateSettings, theme: Theme, options: PlaceOptions): Ctx {
  const layers = layersOf(template, diagram);
  const assigned = resolveAssignments(diagram, template);
  const shapes = new Map(diagram.nodes.map((n) => [n.id, nodeShape(n, theme)]));
  const near = new Map<string, string[]>(diagram.nodes.map((n) => [n.id, []]));
  for (const e of diagram.edges) {
    if (e.hidden || e.from === e.to || !near.has(e.from) || !near.has(e.to)) continue;
    near.get(e.from)!.push(e.to);
    near.get(e.to)!.push(e.from);
  }
  for (const n of diagram.nodes) if (n.attachedTo && near.has(n.attachedTo.id)) near.get(n.id)!.push(n.attachedTo.id), near.get(n.attachedTo.id)!.push(n.id);
  const members = new Map<string, string[]>(layers.map((l) => [l.id, []]));
  for (const n of [...diagram.nodes].sort((a, b) => a.line - b.line)) members.get(assigned.get(n.id)!)?.push(n.id);
  const flows: [string, string][] = [];
  const labels = new Map<string, number>();
  for (const e of diagram.edges) {
    if (e.hidden || e.from === e.to || !near.has(e.from) || !near.has(e.to)) continue;
    flows.push(e.reversed ? [e.to, e.from] : [e.from, e.to]);
    if (e.label) {
      const w = measureSecondary(e.label, theme.size.edge, theme).width;
      for (const key of [`${e.from}|${e.to}`, `${e.to}|${e.from}`]) labels.set(key, Math.max(labels.get(key) ?? 0, w));
    }
  }
  return { diagram, layers, assigned, shapes, m: templateMetrics(theme), theme, hints: options.hints ?? {}, near, members, spread: options.spread ?? 1, quick: options.quick ?? false, flows, labels };
}

/** Centre-to-centre distance of two row neighbours: half of each, plus the gap, wide enough for a label on a line between them. */
function separation(ctx: Ctx, a: string, b: string): number {
  const label = ctx.labels.get(`${a}|${b}`);
  const gap = Math.max(ctx.m.nodeGap * ctx.spread, label ? label + 28 * ctx.theme.scale : 0);
  return (ctx.shapes.get(a)!.w + ctx.shapes.get(b)!.w) / 2 + gap;
}

/**
 * Centres along one axis in a fixed order, as close to `want` as possible
 * (least squares) while consecutive centres stay `sep[i]` apart: isotonic
 * regression (pool adjacent violators) on the wants minus the cumulative gaps.
 */
export function pack(want: number[], sep: number[]): number[] {
  const offset: number[] = [];
  let acc = 0;
  for (let i = 0; i < want.length; i++) {
    if (i > 0) acc += sep[i]!;
    offset.push(acc);
  }
  const blocks: { sum: number; count: number }[] = [];
  for (let i = 0; i < want.length; i++) {
    blocks.push({ sum: want[i]! - offset[i]!, count: 1 });
    while (blocks.length > 1 && blocks.at(-2)!.sum / blocks.at(-2)!.count > blocks.at(-1)!.sum / blocks.at(-1)!.count) {
      const last = blocks.pop()!;
      blocks.at(-1)!.sum += last.sum;
      blocks.at(-1)!.count += last.count;
    }
  }
  const out: number[] = [];
  for (const b of blocks) for (let j = 0; j < b.count; j++) out.push(b.sum / b.count + offset[out.length]!);
  return out;
}

const mean = (values: number[]) => values.reduce((a, b) => a + b, 0) / values.length;

/** Where an element's neighbours are on one axis, if any are placed. */
function barycenter(ctx: Ctx, id: string, at: Positions, axis: 'x' | 'y', only?: (other: string) => boolean): number | undefined {
  const vals = ctx.near.get(id)!.filter((o) => at[o] && (!only || only(o))).map((o) => at[o]![axis]);
  return vals.length ? mean(vals) : undefined;
}

const boxOf = (ctx: Ctx, id: string, p: { x: number; y: number }): Box => nodeBox(p, ctx.shapes.get(id)!);

/** Moves the result so the hinted elements are, on average, where they were: a re-place keeps the picture in place. */
function anchorToHints(ctx: Ctx, out: Positions): Positions {
  const ids = Object.keys(ctx.hints).filter((id) => out[id]);
  if (!ids.length) return out;
  const dx = mean(ids.map((id) => ctx.hints[id]!.x - out[id]!.x));
  const dy = mean(ids.map((id) => ctx.hints[id]!.y - out[id]!.y));
  return Object.fromEntries(Object.entries(out).map(([id, p]) => [id, { x: p.x + dx, y: p.y + dy }]));
}

// ---- layered ----------------------------------------------------------------------------------

/**
 * Bands top to bottom, each a row (or several) of its members. Rows are
 * ordered to keep lines between neighbouring bands short and uncrossed:
 * a few sweeps that put each element under the average of its neighbours
 * in the other bands (closer bands weigh more), then pack the row around
 * those wishes without overlaps.
 */
function placeLayered(ctx: Ctx, options: PlaceOptions): Positions {
  const { m, layers } = ctx;
  const total = [...ctx.members.values()].reduce((s, l) => s + l.length, 0);
  const perRow = Math.max(1, options.perRow ?? Math.max(4, Math.min(7, Math.ceil(Math.sqrt(total * 1.6)))));
  const bandOf = new Map(layers.map((l, i) => [l.id, i]));
  const at: Positions = {};
  // Each band: how many rows, and their centre lines. Rows share the band's tallest height, so any element fits any row.
  let cursor = 0;
  const rowYs = new Map<string, number[]>();
  for (const l of layers) {
    const ids = ctx.members.get(l.id)!;
    if (!ids.length) {
      cursor += m.empty + m.gap;
      continue;
    }
    const rows = Math.ceil(ids.length / perRow);
    const h = Math.max(...ids.map((id) => ctx.shapes.get(id)!.h));
    const ys = Array.from({ length: rows }, (_, r) => cursor + m.pad + h / 2 + r * (h + m.rowGap * ctx.spread));
    cursor = ys.at(-1)! + h / 2 + m.pad + m.gap;
    rowYs.set(l.id, ys);
    ids.forEach((id, i) => (at[id] = { x: ctx.hints[id]?.x ?? 0, y: ys[i % rows]! }));
  }

  const hinted = Object.keys(ctx.hints).length > 0;
  const sweep = (l: LayerDef, wishOf: (id: string) => number) => {
    const ids = ctx.members.get(l.id)!;
    if (!ids.length) return;
    const rowY = rowYs.get(l.id)!;
    const order = ids.map((id, i) => ({ id, i, wish: wishOf(id) })).sort((a, b) => a.wish - b.wish || a.i - b.i);
    // Round robin over the rows, so every row spans the band rather than one row per stretch.
    const rows: string[][] = rowY.map(() => []);
    order.forEach((o, k) => rows[k % rows.length]!.push(o.id));
    rows.forEach((row, r) => {
      const want = row.map((id) => order.find((o) => o.id === id)!.wish);
      const sep = row.map((id, i) => (i ? separation(ctx, row[i - 1]!, id) : 0));
      pack(want, sep).forEach((x, i) => (at[row[i]!] = { x, y: rowY[r]! }));
    });
  };
  const wish = (id: string, fallback: number) => {
    if (ctx.hints[id]) return ctx.hints[id]!.x;
    const own = bandOf.get(ctx.assigned.get(id)!)!;
    let sum = 0;
    let weight = 0;
    for (const o of ctx.near.get(id)!) {
      const band = bandOf.get(ctx.assigned.get(o)!);
      if (band === undefined || !at[o]) continue;
      // Neighbours in the same band pull too, but less: the row is ordered mostly by the bands around it.
      const w = band === own ? 0.5 : 1 / Math.abs(band - own);
      sum += at[o]!.x * w;
      weight += w;
    }
    return weight ? sum / weight : fallback;
  };
  // First pass: rows centred on 0 in source order (or at the hints).
  for (const l of layers) sweep(l, (id) => ctx.hints[id]?.x ?? 0);
  const rounds = hinted ? 2 : 6;
  for (let r = 0; r < rounds; r++) {
    const list = r % 2 === 0 ? layers : [...layers].reverse();
    for (const l of list) sweep(l, (id) => wish(id, at[id]!.x));
  }
  // Averages tie and oscillate on chains inside a band (actor → UI → API): finish with adjacent swaps that shorten the lines.
  if (!hinted) for (const l of layers) refineRows(ctx, at, ctx.members.get(l.id)!);
  return at;
}

/**
 * Total horizontal run of the lines touching `ids`, what an in-row swap
 * should shrink, plus a toll for every line within the row that runs right
 * to left: a row reads left to right (actor → UI → API), even when the
 * reversed order is a little shorter.
 */
function runOf(ctx: Ctx, at: Positions, ids: string[]): number {
  let sum = 0;
  for (const id of ids) for (const o of ctx.near.get(id)!) if (at[o]) sum += Math.abs(at[id]!.x - at[o]!.x);
  const row = new Set(ids);
  for (const [a, b] of ctx.flows) {
    if (row.has(a) && row.has(b) && at[a]!.y === at[b]!.y && at[a]!.x > at[b]!.x) sum += 3 * ctx.m.nodeGap + Math.max(ctx.shapes.get(a)!.w, ctx.shapes.get(b)!.w);
  }
  return sum;
}

/**
 * Hill-climbs each row's order by swapping neighbours and re-packing around
 * the same centre, keeping a swap when the lines touching the row get
 * shorter. Rows are small, so a few passes are cheap.
 */
function refineRows(ctx: Ctx, at: Positions, ids: string[]) {
  const rows = new Map<number, string[]>();
  for (const id of ids) rows.set(at[id]!.y, [...(rows.get(at[id]!.y) ?? []), id]);
  for (const [y, members] of rows) {
    const order = [...members].sort((a, b) => at[a]!.x - at[b]!.x);
    if (order.length < 2) continue;
    const place = (o: string[]) => {
      const centre = mean(o.map((id) => at[id]!.x));
      const sep = o.map((id, i) => (i ? separation(ctx, o[i - 1]!, id) : 0));
      const xs = pack(o.map(() => 0), sep);
      const shift = centre - mean(xs);
      o.forEach((id, i) => (at[id] = { x: xs[i]! + shift, y }));
    };
    // Even spacing first, so swaps compare like with like.
    const wished = order.map((id) => at[id]!.x);
    place(order);
    let best = runOf(ctx, at, order);
    for (let pass = 0; pass < order.length; pass++) {
      let improved = false;
      for (let i = 0; i + 1 < order.length; i++) {
        [order[i], order[i + 1]] = [order[i + 1]!, order[i]!];
        place(order);
        const cost = runOf(ctx, at, order);
        if (cost < best - 0.5) {
          best = cost;
          improved = true;
        } else {
          [order[i], order[i + 1]] = [order[i + 1]!, order[i]!];
          place(order);
        }
      }
      if (!improved) break;
    }
    // Back to the barycentric spacing where it doesn't disturb the new order.
    const sep = order.map((id, i) => (i ? separation(ctx, order[i - 1]!, id) : 0));
    const sorted = [...wished].sort((a, b) => a - b);
    pack(sorted, sep).forEach((x, i) => (at[order[i]!] = { x, y }));
  }
}

// ---- hexagonal ---------------------------------------------------------------------------------

/** Centres for a small grid around (cx, cy), `cols` across, row by row. */
function grid(ctx: Ctx, ids: string[], cols: number, cx: number, cy: number): Positions {
  const { m } = ctx;
  const out: Positions = {};
  if (!ids.length) return out;
  const rows: string[][] = [];
  for (let i = 0; i < ids.length; i += cols) rows.push(ids.slice(i, i + cols));
  const heights = rows.map((r) => Math.max(...r.map((id) => ctx.shapes.get(id)!.h)));
  const total = heights.reduce((a, b) => a + b, 0) + (rows.length - 1) * m.rowGap * ctx.spread;
  let y = cy - total / 2;
  rows.forEach((row, r) => {
    const sep = row.map((id, i) => (i ? (ctx.shapes.get(row[i - 1]!)!.w + ctx.shapes.get(id)!.w) / 2 + m.nodeGap * 0.75 * ctx.spread : 0));
    const xs = pack(row.map(() => 0), sep);
    row.forEach((id, i) => (out[id] = { x: cx + xs[i]!, y: y + heights[r]! / 2 }));
    y += heights[r]! + m.rowGap * ctx.spread;
  });
  return out;
}

/**
 * Ports and adapters: the domain in a small grid at the centre (its own
 * hexagon), the application's elements in rows above and below it, the
 * application hexagon around both, inbound ports on its left outline and
 * outbound ports on its right, adapters in columns outside: the ones that
 * touch a port or the core next to the hexagon, what only they reach (users,
 * databases, external systems) one column further out.
 */
function placeHexagonal(ctx: Ctx): Positions {
  const { m, layers } = ctx;
  const get = (id: string) => ctx.members.get(id) ?? [];
  const byHint = (ids: string[], axis: 'x' | 'y') => (Object.keys(ctx.hints).length ? [...ids].sort((a, b) => (ctx.hints[a]?.[axis] ?? 0) - (ctx.hints[b]?.[axis] ?? 0)) : ids);
  const at: Positions = {};

  // Side preference of a core element: -1 when it talks to the inbound side, +1 to the outbound side.
  const sideOf = (id: string) => {
    let s = 0;
    for (const o of ctx.near.get(id)!) {
      const l = ctx.assigned.get(o);
      if (l === 'inbound' || l === 'driving') s--;
      if (l === 'outbound' || l === 'driven') s++;
    }
    return s;
  };
  const domain = get('domain');
  Object.assign(at, grid(ctx, byHint(domain, 'x'), Math.min(3, Math.max(1, Math.ceil(Math.sqrt(domain.length)))), 0, 0));
  const app = Object.keys(ctx.hints).length ? byHint(get('application'), 'y') : [...get('application')].sort((a, b) => sideOf(a) - sideOf(b));
  if (domain.length) {
    // Application above and below the domain hexagon, at most three to a row.
    const inner = hexGeometry(layers, new Map([['domain', domain.map((id) => boxOf(ctx, id, at[id]!))]]), ctx.theme).hexagons.find((h) => h.id === 'domain')!;
    const top = inner.cy - (inner.r * Math.sqrt(3)) / 2;
    const bottom = inner.cy + (inner.r * Math.sqrt(3)) / 2;
    const above = app.slice(0, Math.ceil(app.length / 2));
    const below = app.slice(above.length);
    const g1 = grid(ctx, above, 3, 0, 0);
    const g2 = grid(ctx, below, 3, 0, 0);
    const span = (g: Positions) => {
      const ys = Object.entries(g).map(([id, p]) => [p.y - ctx.shapes.get(id)!.h / 2, p.y + ctx.shapes.get(id)!.h / 2]);
      return ys.length ? [Math.min(...ys.map((v) => v[0]!)), Math.max(...ys.map((v) => v[1]!))] : [0, 0];
    };
    const [, a1] = span(g1);
    const [b0] = span(g2);
    for (const [id, p] of Object.entries(g1)) at[id] = { x: p.x, y: p.y - a1! + top - m.rowGap * 0.5 * ctx.spread };
    for (const [id, p] of Object.entries(g2)) at[id] = { x: p.x, y: p.y - b0! + bottom + m.rowGap * 0.5 * ctx.spread };
  } else {
    Object.assign(at, grid(ctx, app, Math.min(3, Math.max(1, Math.ceil(Math.sqrt(app.length)))), 0, 0));
  }

  // The hexagon as the scene will derive it (ports only count for their number and height).
  const coreMembers = new Map<string, Box[]>();
  for (const role of ['application', 'domain'] as const) coreMembers.set(role, get(role).map((id) => boxOf(ctx, id, at[id]!)));
  for (const role of ['inbound', 'outbound'] as const) coreMembers.set(role, get(role).map((id) => boxOf(ctx, id, { x: 0, y: 0 })));
  const outer = hexGeometry(layers, coreMembers, ctx.theme).hexagons[0]!;

  // Ports on the outline, ordered by where their core partners are; the anchor (lollipop, box centre) sits on the line.
  const spanY = 0.4 * outer.r * Math.sqrt(3);
  for (const [role, side] of [['inbound', -1], ['outbound', 1]] as const) {
    const ids = get(role)
      .map((id, i) => ({ id, i, wish: ctx.hints[id]?.y ?? barycenter(ctx, id, at, 'y') ?? outer.cy }))
      .sort((a, b) => a.wish - b.wish || a.i - b.i)
      .map((o) => o.id);
    ids.forEach((id, k) => {
      const y = ids.length === 1 ? outer.cy : outer.cy - spanY + (k * 2 * spanY) / (ids.length - 1);
      const a = ctx.shapes.get(id)!.anchor;
      at[id] = { x: hexEdgeX(outer, y, side) - a.dx, y: y - a.dy };
    });
  }

  // Adapters in columns: next to the hexagon what touches it, further out the rest.
  const coreSide = new Set([...get('application'), ...get('domain'), ...get('inbound'), ...get('outbound')]);
  for (const [role, side] of [['driving', -1], ['driven', 1]] as const) {
    const ids = get(role);
    const first = ids.filter((id) => ctx.near.get(id)!.some((o) => coreSide.has(o)));
    const rest = ids.filter((id) => !first.includes(id));
    const columns = first.length && rest.length ? [first, rest] : [ids];
    let edge = outer.cx + side * (outer.r + m.colGap * ctx.spread);
    for (const col of columns) {
      const w = Math.max(...col.map((id) => ctx.shapes.get(id)!.w));
      const x = edge + (side * w) / 2;
      const order = col
        .map((id, i) => ({ id, i, wish: ctx.hints[id]?.y ?? barycenter(ctx, id, at, 'y') ?? outer.cy }))
        .sort((a, b) => a.wish - b.wish || a.i - b.i);
      const sep = order.map((o, i) => (i ? (ctx.shapes.get(order[i - 1]!.id)!.h + ctx.shapes.get(o.id)!.h) / 2 + m.rowGap * ctx.spread : 0));
      // Centre the column on its wishes; the pack keeps it free of overlaps.
      pack(order.map((o) => o.wish), sep).forEach((y, i) => (at[order[i]!.id] = { x, y }));
      edge = x + side * (w / 2 + m.colGap * ctx.spread);
    }
  }
  return at;
}

// ---- clean / onion ------------------------------------------------------------------------------

const wrapAngle = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

/** Circular mean of angles, undefined for none. */
function circularMean(angles: number[]): number | undefined {
  if (!angles.length) return undefined;
  return Math.atan2(mean(angles.map(Math.sin)), mean(angles.map(Math.cos)));
}

/** A candidate arrangement of one ring: angles, the positions they give and the area of the ring's outline. */
interface Arrangement {
  thetas: number[];
  at: { x: number; y: number }[];
  area: number;
  cost: number;
}

/**
 * Concentric rings inside out. Each ring's members keep their angular order
 * (the average direction of what they connect to, inner rings first, then all
 * neighbours; the whole ring rotated to match best), but where they sit is
 * chosen for the ring's size: every member sits as close to the ring inside as
 * its own box allows at its angle (a wide box at the top or bottom costs only
 * its height, at the sides its width), and the arrangement with the smallest
 * outline wins, trading a little area for staying near the wished angles. The
 * core ring (and the first ring with several members when the core is empty)
 * stays evenly spaced on one circle because the rings' centre is its mean.
 */
function placeClean(ctx: Ctx): Positions {
  const { m, layers } = ctx;
  const A = RING_ASPECT;
  const at: Positions = {};
  const angle = new Map<string, number>();
  const hinted = Object.keys(ctx.hints).length > 0;
  const hintCenter = hinted ? ringCenter(layers, new Map(layers.map((l) => [l.id, ctx.members.get(l.id)!.filter((id) => ctx.hints[id]).map((id) => boxOf(ctx, id, ctx.hints[id]!))]))) : undefined;
  // How much staying near the wished angles is worth: a re-place keeps the picture the user has.
  const lambda = hinted ? 6 : 0.1;
  const gap = m.nodeGap * 0.6 * ctx.spread;
  const centreRing = (index: number) => {
    const n = ctx.members.get(layers[index]!.id)!.length;
    if (n < 2) return false;
    return layers.slice(0, index).every((l, i) => (i === 0 ? ctx.members.get(l.id)!.length === 0 : ctx.members.get(l.id)!.length < 2));
  };
  const center: [number, number] = [0, 0];

  const placeRing = (index: number, inner: RingShape | undefined, search: boolean, wishOf: (id: string, k: number, n: number) => number) => {
    const ids = ctx.members.get(layers[index]!.id)!;
    const n = ids.length;
    if (!n) return;
    if (index === 0 && n === 1) {
      at[ids[0]!] = { x: 0, y: 0 };
      angle.set(ids[0]!, -Math.PI / 2);
      return;
    }
    const equal = centreRing(index);
    const title = titleBlock(layers[index]!.label, ctx.theme);
    const titleBox = { width: title.width, height: m.titleHeight };
    const shapes = ids.map((id) => ctx.shapes.get(id)!);
    const innerPts = innerNeeds(inner, m);
    const boxOfAt = (k: number, th: number, d: number): Box => nodeBox({ x: A * d * Math.cos(th), y: d * Math.sin(th) }, shapes[k]!);

    // The smallest distance (squeezed) at which member k at angle th clears the ring inside.
    const clearCache = new Map<string, number>();
    const clearD = (k: number, th: number) => {
      if (!inner) return 0;
      const key = `${k}|${Math.round(th * 1000)}`;
      const hit = clearCache.get(key);
      if (hit !== undefined) return hit;
      let lo = 0;
      let hi = 40;
      while (!clearOfRing(boxOfAt(k, th, hi), center, inner, m.pad) && hi < 20000) (lo = hi), (hi *= 2);
      for (let i = 0; i < 12; i++) {
        const mid = (lo + hi) / 2;
        if (clearOfRing(boxOfAt(k, th, mid), center, inner, m.pad)) hi = mid;
        else lo = mid;
      }
      clearCache.set(key, hi);
      return hi;
    };
    const touching = (boxes: Box[]) => {
      for (let i = 0; i < boxes.length; i++)
        for (let j = i + 1; j < boxes.length; j++) {
          const a = boxes[i]!;
          const b = boxes[j]!;
          if (a.x < b.x + b.w + gap && b.x < a.x + a.w + gap && a.y < b.y + b.h + gap && b.y < a.y + a.h + gap) return true;
        }
      return false;
    };
    const arrange = (thetas: number[], wishes: number[]): Arrangement => {
      let ds = thetas.map((th, k) => clearD(k, th));
      if (equal) ds = ds.map(() => Math.max(...ds));
      const boxesAt = (e: number) => thetas.map((th, k) => boxOfAt(k, th, ds[k]! + e));
      let e = 0;
      if (touching(boxesAt(0))) {
        let lo = 0;
        let hi = 16;
        while (touching(boxesAt(hi)) && hi < 20000) (lo = hi), (hi *= 2);
        for (let i = 0; i < 12; i++) {
          const mid = (lo + hi) / 2;
          if (touching(boxesAt(mid))) lo = mid;
          else hi = mid;
        }
        e = hi;
      }
      const boxes = boxesAt(e);
      const area = ringArea(fitRing([...innerPts, ...memberNeeds(boxes, center, m, titleBox)]));
      const dev = mean(thetas.map((th, k) => Math.abs(wrapAngle(th - wishes[k]!)))) / Math.PI;
      return { thetas, at: thetas.map((th, k) => ({ x: A * (ds[k]! + e) * Math.cos(th), y: (ds[k]! + e) * Math.sin(th) })), area, cost: area * (1 + lambda * dev) };
    };

    const order = ids.map((id, k) => ({ k, wish: wrapAngle(wishOf(id, k, n)) })).sort((a, b) => a.wish - b.wish || a.k - b.k);
    // Everything below works in ids order; `order` says which member is which place in the angular sequence.
    const wishes = ids.map((_, k) => order.find((o) => o.k === k)!.wish);
    const step = (Math.PI * 2) / n;
    const phi0 = circularMean(order.map((o, k) => o.wish - k * step)) ?? -Math.PI / 2;
    let best: Arrangement | undefined;
    const consider = (a: Arrangement) => {
      if (!best || a.cost < best.cost - 1e-6) best = a;
    };
    if (n === 1) {
      consider(arrange([wishes[0]!], wishes));
    } else {
      const tries = !search ? 1 : equal ? 16 : 24;
      for (let off = 0; off < tries; off++)
        for (let shift = 0; shift < (equal || !search ? 1 : n); shift++) {
          const thetas = new Array<number>(n);
          order.forEach((o, k) => (thetas[o.k] = wrapAngle(phi0 + (off * step) / tries + ((k + shift) % n) * step)));
          consider(arrange(thetas, wishes));
        }
      // Free angles: nudge members and swap neighbours while the outline shrinks.
      for (let round = 0; search && !equal && round < 8 && best; round++) {
        const before = best.cost;
        for (let k = 0; k < n; k++)
          for (const delta of [-0.4, -0.15, -0.05, 0.05, 0.15, 0.4]) {
            const thetas = [...best.thetas];
            thetas[k] = wrapAngle(thetas[k]! + delta);
            consider(arrange(thetas, wishes));
          }
        for (let i = 0; i < n; i++)
          for (let j = i + 1; j < n; j++) {
            const thetas = [...best.thetas];
            [thetas[i], thetas[j]] = [thetas[j]!, thetas[i]!];
            consider(arrange(thetas, wishes));
          }
        if (best.cost > before - 1e-6) break;
      }
    }
    const chosen = best!;
    ids.forEach((id, k) => {
      at[id] = chosen.at[k]!;
      angle.set(id, chosen.thetas[k]!);
    });
  };

  const ringsNow = () => cleanRings(layers, new Map(layers.map((l) => [l.id, ctx.members.get(l.id)!.filter((id) => at[id]).map((id) => boxOf(ctx, id, at[id]!))])), ctx.theme, [0, 0]);
  const neighbourAngle = (id: string, inside: (ring: number) => boolean) => {
    const ring = layers.findIndex((l) => l.id === ctx.assigned.get(id));
    const angles = ctx.near.get(id)!.flatMap((o) => {
      const r = layers.findIndex((l) => l.id === ctx.assigned.get(o));
      return angle.has(o) && r !== ring && inside(r) ? [angle.get(o)!] : [];
    });
    return circularMean(angles);
  };
  const hintAngle = (id: string) => (hintCenter && ctx.hints[id] ? Math.atan2(ctx.hints[id]!.y - hintCenter[1], (ctx.hints[id]!.x - hintCenter[0]) / RING_ASPECT) : undefined);
  const even = (k: number, n: number) => -Math.PI / 2 + (k * Math.PI * 2) / n;

  // Inside out, each ring facing what it connects to further in; then again with every neighbour.
  for (let pass = 0; pass < 3; pass++) {
    for (let i = 0; i < layers.length; i++) {
      const inner = i ? ringsNow()[i - 1] : undefined;
      placeRing(i, inner, pass === 2 && !ctx.quick, (id, k, n) => hintAngle(id) ?? neighbourAngle(id, (r) => (pass === 0 ? r < i : true)) ?? (angle.get(id) ?? even(k, n)));
    }
  }
  if (hintCenter) for (const p of Object.values(at)) (p.x += hintCenter[0]), (p.y += hintCenter[1]);
  return at;
}

/** Positions for every node under the template, centres, ready for `layout.nodes`. */
export function placeTemplate(diagram: Diagram, template: TemplateSettings, theme: Theme, options: PlaceOptions = {}): Positions {
  const ctx = context(diagram, template, theme, options);
  if (template.kind === 'clean') return placeClean(ctx); // centred on the hints' centre already
  const placed = template.kind === 'hexagonal' ? placeHexagonal(ctx) : placeLayered(ctx, options);
  return anchorToHints(ctx, placed);
}

/** Exported for tests: the bands this placement produces, from the same function the scene uses. */
export function bandsFor(diagram: Diagram, template: TemplateSettings, theme: Theme, positions: Positions) {
  const ctx = context(diagram, template, theme, {});
  const members = new Map(ctx.layers.map((l) => [l.id, ctx.members.get(l.id)!.map((id) => boxOf(ctx, id, positions[id]!))]));
  return layeredBands(ctx.layers, members, theme);
}
