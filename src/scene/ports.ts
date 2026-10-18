import type { Point } from '../layout/layout-file.ts';
import type { DEdge } from '../model/types.ts';
import type { Box } from './containers.ts';
import { borderCrossings, pathHitsBox } from './quality.ts';
import { inside } from './geometry.ts';
import type { SceneContainer, SceneNode } from './scene.ts';

/**
 * Where a line meets a node, when the centre pin libavoid uses by default
 * would look wrong. `outline` is the drawn end, `route` the point libavoid
 * routes from: straight out from the outline, past the node's clearance.
 *
 * - Bars (fork/join, nwdiag networks): straight across from the other end,
 *   not from the bar's middle (a bar is wide; lines drop onto it).
 * - Diamonds and small circles: at the vertex facing the other end, so a
 *   line never hooks into a slanted side.
 * - Neighbours whose boxes overlap side-on: one straight line between them,
 *   at the narrower one's centre if it can, instead of the jog two
 *   slightly misaligned centres give.
 */
export interface Port {
  route: Point;
  outline: Point;
}

export interface EdgePorts {
  from?: Port;
  to?: Port;
  /** Both ends face each other in a clear line: the route is that segment. */
  straight?: boolean;
}

export type Side = 'top' | 'bottom' | 'left' | 'right';

const out = (p: Point, side: Side, d: number): Point =>
  side === 'top' ? [p[0], p[1] - d] : side === 'bottom' ? [p[0], p[1] + d] : side === 'left' ? [p[0] - d, p[1]] : [p[0] + d, p[1]];

/** The routing start for an outline point: straight out, just past the box's clearance (on it, libavoid counts it as inside). */
const past = (p: Point, side: Side, box: Box, buffer: number): Point =>
  side === 'top' ? [p[0], box.y - buffer - 1] : side === 'bottom' ? [p[0], box.y + box.h + buffer + 1] : side === 'left' ? [box.x - buffer - 1, p[1]] : [box.x + box.w + buffer + 1, p[1]];

const anchorBox = (n: SceneNode): Box => ({ x: n.anchor.cx - n.anchor.w / 2, y: n.anchor.cy - n.anchor.h / 2, w: n.anchor.w, h: n.anchor.h });

/** The drawn figure is the whole box (no label hanging below an icon). */
const figureIsBox = (n: SceneNode) => Math.abs(n.anchor.w - n.box.w) < 1 && Math.abs(n.anchor.h - n.box.h) < 1 && Math.abs(n.anchor.cx - (n.box.x + n.box.w / 2)) < 1 && Math.abs(n.anchor.cy - (n.box.y + n.box.h / 2)) < 1;

const isBar = (n: SceneNode) => n.node.kind === 'network' || n.node.kind === 'fork';
const isVertexShape = (n: SceneNode) => n.node.kind !== 'actor' && (n.anchor.shape === 'diamond' || (n.anchor.shape === 'ellipse' && n.anchor.w <= 32 && n.anchor.h <= 32));

/** A port on a node by itself (bars, diamonds, circles), facing `other`. */
function endPort(n: SceneNode, other: Point, buffer: number, outgoing: boolean, lr: boolean, used: Set<string>): Port | undefined {
  const b = n.box;
  if (isBar(n) && figureIsBox(n)) {
    if (b.w >= b.h) {
      const x = Math.min(Math.max(other[0], b.x + 6), b.x + b.w - 6);
      const side: Side = other[1] < b.y + b.h / 2 ? 'top' : 'bottom';
      const outline: Point = [x, side === 'top' ? b.y : b.y + b.h];
      return { outline, route: past(outline, side, b, buffer) };
    }
    const y = Math.min(Math.max(other[1], b.y + 6), b.y + b.h - 6);
    const side: Side = other[0] < b.x + b.w / 2 ? 'left' : 'right';
    const outline: Point = [side === 'left' ? b.x : b.x + b.w, y];
    return { outline, route: past(outline, side, b, buffer) };
  }
  if (isVertexShape(n)) {
    // An icon with its name underneath (a lollipop interface), or a «stereotype» above, can't be reached from there.
    const labelBelow = n.box.y + n.box.h > n.anchor.cy + n.anchor.h / 2 + 2;
    const labelAbove = n.box.y < n.anchor.cy - n.anchor.h / 2 - 2;
    let side = vertexSide(n, other, outgoing, lr, (s) => used.has(`${n.node.id}:${s}`));
    if ((labelBelow && side === 'bottom') || (labelAbove && side === 'top')) side = other[0] < n.anchor.cx ? 'left' : 'right';
    used.add(`${n.node.id}:${side}`);
    const { cx, cy, w, h } = n.anchor;
    const outline: Point = side === 'top' ? [cx, cy - h / 2] : side === 'bottom' ? [cx, cy + h / 2] : side === 'left' ? [cx - w / 2, cy] : [cx + w / 2, cy];
    return { outline, route: past(outline, side, b, buffer) };
  }
  return undefined;
}

/**
 * Which vertex of a diamond (or circle) a line uses, reading the flow
 * downwards (or rightwards with `lr`): lines leave a decision at the bottom
 * when they go on down, come in at the top from straight above, and use the
 * left or right vertex for everything else, so lines in and out don't share
 * a vertex and nothing hooks round to come in from below.
 */
function vertexSide(n: SceneNode, other: Point, outgoing: boolean, lr: boolean, taken: (s: Side) => boolean): Side {
  const { cx, cy, w, h } = n.anchor;
  // Work in flow coordinates: `along` grows downstream, `across` sideways.
  const along = lr ? other[0] - cx : other[1] - cy;
  const across = lr ? other[1] - cy : other[0] - cx;
  const [alongSize, acrossSize] = lr ? [w, h] : [h, w];
  const [start, end, before, after]: Side[] = lr ? ['left', 'right', 'top', 'bottom'] : ['top', 'bottom', 'left', 'right'];
  const sideways = across < 0 ? before! : after!;
  const otherway = across < 0 ? after! : before!;
  // Lines out go on downstream from the far vertex; back upstream, from a side no line comes in at.
  if (outgoing) return along > alongSize / 2 ? end! : !taken(sideways) ? sideways : !taken(otherway) ? otherway : end!;
  if (along < -alongSize / 2 && Math.abs(across) <= acrossSize) return start!;
  if (Math.abs(across) < 1) return along < 0 ? start! : end!;
  return sideways;
}

/** How far in from a box's corners a straight line may attach: the outline must be flat there. */
function inset(n: SceneNode, horizontal: boolean): number {
  const a = n.anchor;
  const span = horizontal ? a.w : a.h;
  if (a.shape === 'rect') return Math.min(10, span / 4);
  if (a.shape === 'pill') return horizontal ? Math.min(a.w, a.h) / 2 + 2 : span / 2 - 1;
  return span / 2 - 1; // ellipse, diamond: only the middle
}

export interface PortContext {
  nodes: Map<string, SceneNode>;
  containers: SceneContainer[];
  /** True when `id` sits somewhere inside container `c`. */
  within(id: string, c: string): boolean;
  buffer: number;
  /** Hand-placed bends of a line, if any: its ends head for the first and last of them. */
  via?(id: string): Point[] | undefined;
  /** Ends chosen by hand (sidecar `from`/`to`), already as ports: they win and take their spot on the side. */
  fixed?: Map<string, EdgePorts>;
  /** Line width scale (theme scale): spacing between spread ends. */
  scale?: number;
}

/**
 * True when the straight segment misses every other box (with clearance),
 * every title, and crosses container borders only as the ends' nesting
 * requires.
 */
function clearPath(seg: Point[], e: DEdge, a: SceneNode, b: SceneNode, ctx: PortContext): boolean {
  const clear = ctx.buffer - 2;
  for (const n of ctx.nodes.values()) {
    if (n === a || n === b) continue;
    if (pathHitsBox(seg, { x: n.box.x - clear, y: n.box.y - clear, w: n.box.w + 2 * clear, h: n.box.h + 2 * clear }, 0)) return false;
  }
  for (const c of ctx.containers) {
    if (c.title && pathHitsBox(seg, c.title, 0)) return false;
    if (c.kind === 'swimlane') continue;
    if (borderCrossings(seg, c.box) !== (ctx.within(e.from, c.id) !== ctx.within(e.to, c.id) ? 1 : 0)) return false;
  }
  return true;
}

/**
 * A straight line between two nodes that overlap side-on, or undefined.
 * The segment must miss every other box (with clearance), every title, and
 * cross container borders only as the ends' nesting requires.
 */
function straight(e: DEdge, a: SceneNode, b: SceneNode, ctx: PortContext, taken: Map<string, number[]>): EdgePorts | undefined {
  if (!figureIsBox(a) || !figureIsBox(b) || isBar(a) || isBar(b)) return undefined;
  const A = anchorBox(a);
  const B = anchorBox(b);
  for (const vertical of [true, false]) {
    const [aLo, aHi, bLo, bHi] = vertical ? [A.y, A.y + A.h, B.y, B.y + B.h] : [A.x, A.x + A.w, B.x, B.x + B.w];
    const aFirst = aHi <= bLo;
    if (!aFirst && bHi > aLo) continue; // overlap along the flow axis: no straight gap
    const ia = inset(a, vertical);
    const ib = inset(b, vertical);
    const [sa0, sa1] = vertical ? [A.x + ia, A.x + A.w - ia] : [A.y + ia, A.y + A.h - ia];
    const [sb0, sb1] = vertical ? [B.x + ib, B.x + B.w - ib] : [B.y + ib, B.y + B.h - ib];
    const lo = Math.max(sa0, sb0);
    const hi = Math.min(sa1, sb1);
    if (hi < lo) continue;
    const [ca, cb] = vertical ? [a.anchor.cx, b.anchor.cx] : [a.anchor.cy, b.anchor.cy];
    const [narrow, wide] = (vertical ? A.w <= B.w : A.h <= B.h) ? [ca, cb] : [cb, ca];
    const at = narrow >= lo && narrow <= hi ? narrow : wide >= lo && wide <= hi ? wide : (lo + hi) / 2;
    const sideA: Side = vertical ? (aFirst ? 'bottom' : 'top') : aFirst ? 'right' : 'left';
    const sideB: Side = vertical ? (aFirst ? 'top' : 'bottom') : aFirst ? 'left' : 'right';
    // Two lines leaving one side at the same spot would draw as one.
    const key = (n: SceneNode, side: Side) => `${n.node.id}:${side}`;
    if ((taken.get(key(a, sideA)) ?? []).some((v) => Math.abs(v - at) < 8) || (taken.get(key(b, sideB)) ?? []).some((v) => Math.abs(v - at) < 8)) continue;
    const oa: Point = vertical ? [at, aFirst ? aHi : aLo] : [aFirst ? aHi : aLo, at];
    const ob: Point = vertical ? [at, aFirst ? bLo : bHi] : [aFirst ? bLo : bHi, at];
    if (!clearPath([oa, ob], e, a, b, ctx)) return undefined;
    for (const [n, side] of [[a, sideA], [b, sideB]] as const) taken.set(key(n, side), [...(taken.get(key(n, side)) ?? []), at]);
    const gap = Math.abs(vertical ? ob[1] - oa[1] : ob[0] - oa[0]);
    const d = Math.min(ctx.buffer + 1, gap / 2 - 1);
    return { from: { outline: oa, route: out(oa, sideA, d) }, to: { outline: ob, route: out(ob, sideB, d) }, straight: true };
  }
  return undefined;
}

/** Ports for every line that needs them. Lines with hand-placed bends keep the centre pins (unless spread). */
export function planPorts(edges: DEdge[], hasVia: (id: string) => boolean, ctx: PortContext, lr = false): Map<string, EdgePorts> {
  const result = new Map<string, EdgePorts>();
  for (const [id, p] of ctx.fixed ?? []) result.set(id, { ...p });
  const isFixed = (id: string, end: 'from' | 'to') => !!ctx.fixed?.get(id)?.[end];
  const taken = new Map<string, number[]>();
  const centre = (n: SceneNode): Point => [n.anchor.cx, n.anchor.cy];
  const used = new Set<string>();
  // Incoming ends first, so lines going out can keep off the vertices lines come in at.
  for (const outgoing of [false, true]) {
    for (const e of edges) {
      if (e.from === e.to || hasVia(e.id) || isFixed(e.id, outgoing ? 'from' : 'to')) continue;
      const a = ctx.nodes.get(e.from);
      const b = ctx.nodes.get(e.to);
      if (!a || !b) continue;
      const port = outgoing ? endPort(a, centre(b), ctx.buffer, true, lr, used) : endPort(b, centre(a), ctx.buffer, false, lr, used);
      if (!port) continue;
      result.set(e.id, { ...result.get(e.id), [outgoing ? 'from' : 'to']: port });
    }
  }
  // A box opposite a bar or vertex port meets it square-on when its side spans the port: no jog.
  for (const e of edges) {
    const p = result.get(e.id);
    if (!p || (p.from && p.to) || ctx.fixed?.has(e.id)) continue;
    const [port, other, otherKey] = p.from ? [p.from, ctx.nodes.get(e.to)!, 'to' as const] : [p.to!, ctx.nodes.get(e.from)!, 'from' as const];
    if (!figureIsBox(other) || isBar(other) || isVertexShape(other)) continue;
    const o = anchorBox(other);
    const horizontal = Math.abs(port.route[1] - port.outline[1]) < 0.5;
    const at = horizontal ? port.outline[1] : port.outline[0];
    const i = inset(other, !horizontal);
    if (horizontal ? at < o.y + i || at > o.y + o.h - i : at < o.x + i || at > o.x + o.w - i) continue;
    const towards = horizontal ? Math.sign(port.route[0] - port.outline[0]) : Math.sign(port.route[1] - port.outline[1]);
    // The other box must lie beyond the port, on the side it faces.
    const beyond = horizontal ? (towards > 0 ? o.x > port.outline[0] : o.x + o.w < port.outline[0]) : towards > 0 ? o.y > port.outline[1] : o.y + o.h < port.outline[1];
    if (!beyond || !clearPath([port.outline, horizontal ? [o.x + o.w / 2, at] : [at, o.y + o.h / 2]], e, ctx.nodes.get(e.from)!, ctx.nodes.get(e.to)!, ctx)) continue;
    const side: Side = horizontal ? (towards > 0 ? 'left' : 'right') : towards > 0 ? 'top' : 'bottom';
    const outline: Point = horizontal ? [towards > 0 ? o.x : o.x + o.w, at] : [at, towards > 0 ? o.y : o.y + o.h];
    result.set(e.id, { ...p, [otherKey]: { outline, route: past(outline, side, other.box, ctx.buffer) } });
  }
  // Straight lines second, round the ports already handed out; shortest first, as those are the neighbours.
  const rest = edges
    .filter((e) => e.from !== e.to && !hasVia(e.id) && !result.has(e.id) && ctx.nodes.has(e.from) && ctx.nodes.has(e.to))
    .map((e) => {
      const [a, b] = [ctx.nodes.get(e.from)!, ctx.nodes.get(e.to)!];
      return { e, a, b, d: Math.hypot(a.anchor.cx - b.anchor.cx, a.anchor.cy - b.anchor.cy) };
    })
    .sort((x, y) => x.d - y.d);
  for (const { e, a, b } of rest) {
    const s = straight(e, a, b, ctx, taken);
    if (s) result.set(e.id, s);
  }
  return result;
}

/** Order along a side: clockwise round the node, so lines that turn off early sit on the outside and none cross. */
const along = (side: Side, dx: number, dy: number): number =>
  side === 'top' ? Math.atan2(dx, -dy) : side === 'bottom' ? -Math.atan2(dx, dy) : side === 'right' ? Math.atan2(dy, dx) : -Math.atan2(dy, -dx);

/** An icon with its name underneath (actors, external systems): lines keep off the bottom, through the name. */
const isIcon = (n: SceneNode) => !figureIsBox(n) && n.node.kind === 'actor';

/** Half the width of what is drawn at a line's end (at theme scale 1; a multiplicity counts): two ends closer than the sum overlap. */
function decorationHalf(e: DEdge, end: 'from' | 'to'): number {
  // A multiplicity at the end needs a line of text's room beside it.
  if (end === 'to' ? e.toLabel : e.fromLabel) return 10;
  const head = end === 'to' ? e.head : e.tail;
  if (head === 'none') return 0;
  if (head.startsWith('crow')) return 7;
  if (head === 'triangle') return 7;
  if (head === 'diamond' || head === 'diamondFilled' || head === 'arrow') return 5;
  return 4;
}

/** Closest spacing of the ends round an actor (scaled with the theme): its sides are short. */
const ICON_PITCH = 6;

/** One line end on one side of a node: taken (`at`, a port it keeps) or to be placed (`want`, the spot it would like). */
export interface SideMember {
  e: DEdge;
  end: 'from' | 'to';
  /** Clockwise order round the node, for ends that want the same spot. */
  key: number;
  at?: number;
  want?: number;
}

const centreOf = (id: string, ctx: PortContext): Point | undefined => {
  const n = ctx.nodes.get(id);
  if (n) return [n.anchor.cx, n.anchor.cy];
  const c = ctx.containers.find((x) => x.id === id);
  return c ? [c.box.x + c.box.w / 2, c.box.y + c.box.h / 2] : undefined;
};

/** The side a port leaves from: the direction from its outline point to its routing point. */
export const portSide = (port: Port): Side =>
  Math.abs(port.route[0] - port.outline[0]) < 0.5 ? (port.route[1] < port.outline[1] ? 'top' : 'bottom') : port.route[0] < port.outline[0] ? 'left' : 'right';

/** The stretch of a side lines may attach to: off the corners, and only the middle of a round outline or an avatar's disc. */
function sideSpan(n: SceneNode, side: Side, k: number): [number, number] {
  const a = anchorBox(n);
  const horizontal = side === 'top' || side === 'bottom';
  const [lo, len] = horizontal ? [a.x, a.w] : [a.y, a.h];
  const c = lo + len / 2;
  let half: number;
  if (isIcon(n) && side === 'bottom') return [n.box.x + Math.min(10 * Math.sqrt(k), n.box.w / 4), n.box.x + n.box.w - Math.min(10 * Math.sqrt(k), n.box.w / 4)];
  if (isIcon(n)) half = len * 0.4;
  else if (n.anchor.shape === 'rect') half = len / 2 - Math.min(10 * Math.sqrt(k), len / 4);
  else if (n.anchor.shape === 'pill') half = horizontal ? Math.max(len * 0.15, len / 2 - Math.min(a.w, a.h) / 2 - 2) : len * 0.25;
  else half = len * 0.25;
  return [c - half, c + half];
}

/**
 * Spots for the ends on one side: each as close to where it wants to be as
 * the side allows, in order, at least a pitch apart; taken ones stay. Sets
 * the ports of the ends it places and returns their edge ids.
 */
function placeSide(n: SceneNode, side: Side, members: SideMember[], result: Map<string, EdgePorts>, ctx: PortContext): string[] {
  const k = ctx.scale ?? 1;
  if (!members.some((m) => m.at === undefined)) return [];
  const [lo, hi] = sideSpan(n, side, k);
  const order = [...members].sort((a, b) => (a.at ?? a.want!) - (b.at ?? b.want!) || a.key - b.key);
  // Wide ends (crow's feet, triangles) need more room than bare lines.
  const widest = Math.max(...members.map((m) => decorationHalf(m.e, m.end)));
  const pitch = Math.max(isIcon(n) ? ICON_PITCH : 8, 2 * widest + 4) * Math.sqrt(k);
  // Actors: as close to where the router ran each line as a pitch apart allows (keeps its bends).
  // Boxes: evenly between the taken spots (and the side's ends), each gap getting the ends that want to be in it.
  const placed = isIcon(n)
    ? spaceOut(order.map((m) => m.at ?? Math.min(hi, Math.max(lo, m.want!))), order.map((m) => (m.at !== undefined ? 1e6 : 1)), lo, hi, pitch)
    : evenly(order, lo, hi, pitch);
  const changed: string[] = [];
  order.forEach((m, i) => {
    if (m.at !== undefined) return;
    const outline = outlineAt(n, side, placed[i]!);
    result.set(m.e.id, { ...result.get(m.e.id), [m.end]: { outline, route: past(outline, side, n.box, ctx.buffer) } });
    changed.push(m.e.id);
  });
  return changed;
}

/** Spots evenly spread over each gap between taken ones, in order; a gap too narrow for its share falls back to `spaceOut`. */
function evenly(order: SideMember[], lo: number, hi: number, pitch: number): number[] {
  const out: number[] = order.map((m) => m.at ?? NaN);
  let start = 0;
  let a = lo;
  for (let i = 0; i <= order.length; i++) {
    const m = order[i];
    if (m && m.at === undefined) continue;
    const b = m ? m.at! : hi;
    const count = i - start;
    const room = (b - a) / (count + 1);
    for (let j = 0; j < count; j++) out[start + j] = room >= pitch ? a + room * (j + 1) : NaN;
    if (count && room < pitch) {
      const run = order.slice(start, i);
      const packed = spaceOut(run.map((x) => Math.min(b, Math.max(a, x.want!))), run.map(() => 1), a + (m ? pitch : 0), b - (m ? pitch : 0), pitch);
      packed.forEach((v, j) => (out[start + j] = v));
    }
    if (m) a = m.at!;
    start = i + 1;
  }
  return out;
}

/**
 * After routing: ends that landed on the same spot of a side (two lines
 * running into one point, or one line's last stretch on top of another's)
 * get spots of their own: every end on that side spread evenly between the
 * ones that can't move (straight lines, vertices, hand-chosen ends), in the
 * order that keeps them from crossing.
 *
 * Actors: every end gets a spot on the side the router left by, on the
 * figure (top, left, right) or, leaving downwards, under the name (the
 * figure and its name are one thing; a line through the name reads badly).
 * So lines meet the figure square-on instead of fanning out under it, and
 * keep the router's choice of side, which keeps its bends. `lines` are the drawn routes. Returns
 * the lines whose ports changed (to be routed again).
 */
export function untangle(lines: { e: DEdge; points: Point[]; keep?: boolean }[], result: Map<string, EdgePorts>, ctx: PortContext): Set<string> {
  const k = ctx.scale ?? 1;
  const groups = new Map<string, { n: SceneNode; side: Side; members: SideMember[] }>();
  for (const { e, points, keep } of lines) {
    // Straight lines (and every other port, and lines marked `keep`) take part as taken spots.
    if (e.from === e.to || points.length < 2) continue;
    for (const end of ['from', 'to'] as const) {
      const n = ctx.nodes.get(end === 'from' ? e.from : e.to);
      if (!n || isBar(n) || isVertexShape(n) || !(figureIsBox(n) || isIcon(n))) continue;
      const pts = end === 'to' ? points : [...points].reverse();
      const p = pts[pts.length - 1]!;
      const q = pts[pts.length - 2]!;
      const vertical = Math.abs(q[0] - p[0]) < 0.5;
      if (!vertical && Math.abs(q[1] - p[1]) >= 0.5) continue; // slanted: not ours to judge
      const side: Side = vertical ? (q[1] < p[1] ? 'top' : 'bottom') : q[0] < p[0] ? 'left' : 'right';
      const a = anchorBox(n);
      // Only ends that sit on that side of the figure (an actor's lines may start anywhere in its box: all of them move).
      const onSide = side === 'top' ? Math.abs(p[1] - a.y) < 1.5 : side === 'bottom' ? Math.abs(p[1] - a.y - a.h) < 1.5 : side === 'left' ? Math.abs(p[0] - a.x) < 1.5 : Math.abs(p[0] - a.x - a.w) < 1.5;
      if (!onSide && !isIcon(n)) continue;
      const at = vertical ? p[0] : p[1];
      // Which way the line turns after its last stretch (or where it heads): early turns go outside.
      const turn = pts.length >= 3 ? pts[pts.length - 3]! : pts[0]!;
      const key = along(side, turn[0] - p[0], turn[1] - p[1]);
      // A port, or a line that is one straight stretch, stays where it is.
      const m: SideMember = keep || result.get(e.id)?.[end] || (points.length === 2 && !isIcon(n)) ? { e, end, key, at } : { e, end, key, want: at };
      const id = `${n.node.id}:${side}`;
      const g = groups.get(id) ?? { n, side, members: [] };
      g.members.push(m);
      groups.set(id, g);
    }
  }
  const changed = new Set<string>();
  // Closer than this reads as one line (the router nudges parallel lines 10 px apart).
  const close = 6 * Math.sqrt(k);
  for (const { n, side, members } of groups.values()) {
    const spots = members.map((m) => ({ v: m.at ?? m.want!, half: decorationHalf(m.e, m.end) * Math.sqrt(k) })).sort((a, b) => a.v - b.v);
    const clash = spots.some((s, i) => i > 0 && s.v - spots[i - 1]!.v < Math.max(close, s.half + spots[i - 1]!.half + 2 * Math.sqrt(k)));
    if (!isIcon(n) && !clash) continue;
    for (const id of placeSide(n, side, members, result, ctx)) changed.add(id);
  }
  return changed;
}

/**
 * A drawn line with one end moved to `outline` without routing it again:
 * the last stretch shifts sideways to the new spot (the stretch before it
 * runs along the side, so it just gets longer or shorter); a line that is
 * one straight stretch takes a jog halfway. For live spreading while
 * dragging; the full build on release routes it properly.
 */
export function moveEnd(points: Point[], end: 'from' | 'to', outline: Point): Point[] {
  const pts = end === 'to' ? [...points] : [...points].reverse();
  const n = pts.length;
  const last = pts[n - 1]!;
  const prev = pts[n - 2]!;
  const axis = Math.abs(prev[0] - last[0]) < 0.5 ? 0 : 1; // the coordinate that moves along the side
  if (n >= 3) {
    const q: Point = [...prev];
    q[axis] = outline[axis]!;
    pts[n - 2] = q;
    pts[n - 1] = outline;
  } else {
    const mid = (prev[1 - axis]! + last[1 - axis]!) / 2;
    const a: Point = [0, 0];
    const b: Point = [0, 0];
    a[axis] = prev[axis]!;
    a[1 - axis] = mid;
    b[axis] = outline[axis]!;
    b[1 - axis] = mid;
    pts.splice(1, 1, a, b, outline);
  }
  return end === 'to' ? pts : pts.reverse();
}

/**
 * Positions for points that want to be at `want` (sorted), kept in order at
 * least `gap` apart inside [lo, hi], moving them as little as possible
 * (weighted least squares: pool-adjacent-violators on `want − i·gap`).
 * Heavy weights pin a point. When they can't all fit, the gap shrinks.
 */
export function spaceOut(want: number[], weight: number[], lo: number, hi: number, gap: number): number[] {
  const n = want.length;
  if (!n) return [];
  const d = n > 1 ? Math.min(gap, (hi - lo) / (n - 1)) : 0;
  const top = hi - (n - 1) * d;
  const blocks: { sum: number; w: number; count: number }[] = [];
  for (let i = 0; i < n; i++) {
    blocks.push({ sum: (want[i]! - i * d) * weight[i]!, w: weight[i]!, count: 1 });
    while (blocks.length > 1) {
      const b = blocks[blocks.length - 1]!;
      const a = blocks[blocks.length - 2]!;
      if (a.sum / a.w <= b.sum / b.w) break;
      blocks.splice(blocks.length - 2, 2, { sum: a.sum + b.sum, w: a.w + b.w, count: a.count + b.count });
    }
  }
  const out: number[] = [];
  for (const b of blocks) {
    const v = Math.min(top, Math.max(lo, b.sum / b.w));
    for (let j = 0; j < b.count; j++) out.push(v + out.length * d);
  }
  return out;
}

/**
 * Where a port's line really starts once routed. libavoid's nudging can
 * slide the first stretch of a line that starts at a free point sideways (to
 * keep it apart from a neighbour), leaving the route's start off the port.
 * The end then follows along the side to where the line now runs, so it
 * stays one straight stretch, as long as `slideTo` finds a spot there (on
 * the figure, on the container's border); without one (a port chosen by
 * hand, a diamond's vertex) the end stays put and takes a jog instead.
 * Returns the points to draw before the route (outline first) and how many
 * of the route's first points they replace.
 */
export function settleEnd(port: Port, route: Point[], slideTo?: (at: number) => Point | undefined): { lead: Point[]; skip: number } {
  const side = portSide(port);
  const across: 0 | 1 = side === 'left' || side === 'right' ? 1 : 0;
  const along = 1 - across;
  // The route may also start with a tiny sideways step (nudging moved its next stretch): slide past it too.
  const [r0, r1] = [route[0]!, route[1]];
  if (slideTo && r1 && Math.abs(r1[along]! - r0[along]!) < 0.5 && Math.abs(r1[across]! - r0[across]!) < 12) {
    const to = slideTo(port.outline[across]! + r1[across]! - port.route[across]!);
    if (to) return { lead: [to], skip: 1 };
  }
  const d = r0[across]! - port.route[across]!;
  if (Math.abs(d) < 0.5) {
    // Sub-pixel: line the end up exactly, or the end looks like a bend.
    const to = slideTo?.(r0[across]!);
    if (to) return { lead: [to], skip: 0 };
    const o: Point = [...port.outline];
    o[across] = r0[across]!;
    return { lead: [o], skip: 0 };
  }
  const to = slideTo?.(port.outline[across]! + d);
  return to ? { lead: [to], skip: 0 } : { lead: [port.outline, port.route], skip: 0 };
}

/** How a port's end may slide along its node's outline (see `settleEnd`): on the figure, never off a diamond's vertex. */
export function slideOnNode(n: SceneNode, port: Port): ((at: number) => Point | undefined) | undefined {
  if (n.anchor.shape === 'diamond') return undefined;
  const side = portSide(port);
  const a = anchorBox(n);
  const [lo, hi] = side === 'left' || side === 'right' ? [a.y + 2, a.y + a.h - 2] : isIcon(n) && side === 'bottom' ? [n.box.x + 2, n.box.x + n.box.w - 2] : [a.x + 2, a.x + a.w - 2];
  return (at) => (at >= lo && at <= hi ? outlineAt(n, side, at) : undefined);
}

/** The point on a node's drawn outline at `at` along `side` (x for top/bottom, y for left/right). Icons are met from below under their name. */
function outlineAt(n: SceneNode, side: Side, at: number): Point {
  const a = n.anchor;
  if (isIcon(n) && side === 'bottom') return [at, n.box.y + n.box.h];
  if (a.shape === 'rect') {
    const b = anchorBox(n);
    return side === 'top' ? [at, b.y] : side === 'bottom' ? [at, b.y + b.h] : side === 'left' ? [b.x, at] : [b.x + b.w, at];
  }
  // Round outlines: from the centre line straight out to the outline (bisection, as `clipStart` does).
  const vertical = side === 'top' || side === 'bottom';
  let p: Point = vertical ? [at, a.cy] : [a.cx, at];
  const far: Point = side === 'top' ? [at, a.cy - a.h] : side === 'bottom' ? [at, a.cy + a.h] : side === 'left' ? [a.cx - a.w, at] : [a.cx + a.w, at];
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 30; i++) {
    const mid = (lo + hi) / 2;
    const q: Point = [p[0] + (far[0] - p[0]) * mid, p[1] + (far[1] - p[1]) * mid];
    if (inside(a, q)) lo = mid;
    else hi = mid;
  }
  p = [p[0] + (far[0] - p[0]) * hi, p[1] + (far[1] - p[1]) * hi];
  return p;
}
