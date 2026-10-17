import type { Point } from '../layout/layout-file.ts';
import type { DEdge } from '../model/types.ts';
import type { Box } from './containers.ts';
import { borderCrossings, pathHitsBox } from './quality.ts';
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

type Side = 'top' | 'bottom' | 'left' | 'right';

const out = (p: Point, side: Side, d: number): Point =>
  side === 'top' ? [p[0], p[1] - d] : side === 'bottom' ? [p[0], p[1] + d] : side === 'left' ? [p[0] - d, p[1]] : [p[0] + d, p[1]];

/** The routing start for an outline point: straight out, just past the box's clearance (on it, libavoid counts it as inside). */
const past = (p: Point, side: Side, box: Box, buffer: number): Point =>
  side === 'top' ? [p[0], box.y - buffer - 1] : side === 'bottom' ? [p[0], box.y + box.h + buffer + 1] : side === 'left' ? [box.x - buffer - 1, p[1]] : [box.x + box.w + buffer + 1, p[1]];

const anchorBox = (n: SceneNode): Box => ({ x: n.anchor.cx - n.anchor.w / 2, y: n.anchor.cy - n.anchor.h / 2, w: n.anchor.w, h: n.anchor.h });

/** The drawn figure is the whole box (no label hanging below an icon). */
const figureIsBox = (n: SceneNode) => Math.abs(n.anchor.w - n.box.w) < 1 && Math.abs(n.anchor.h - n.box.h) < 1 && Math.abs(n.anchor.cx - (n.box.x + n.box.w / 2)) < 1 && Math.abs(n.anchor.cy - (n.box.y + n.box.h / 2)) < 1;

const isBar = (n: SceneNode) => n.node.kind === 'network' || n.node.kind === 'fork';
const isVertexShape = (n: SceneNode) => n.anchor.shape === 'diamond' || (n.anchor.shape === 'ellipse' && n.anchor.w <= 32 && n.anchor.h <= 32);

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

/** Ports for every line that needs them. Lines with hand-placed bends keep the centre pins. */
export function planPorts(edges: DEdge[], hasVia: (id: string) => boolean, ctx: PortContext, lr = false): Map<string, EdgePorts> {
  const result = new Map<string, EdgePorts>();
  const taken = new Map<string, number[]>();
  const centre = (n: SceneNode): Point => [n.anchor.cx, n.anchor.cy];
  const used = new Set<string>();
  // Incoming ends first, so lines going out can keep off the vertices lines come in at.
  for (const outgoing of [false, true]) {
    for (const e of edges) {
      if (e.from === e.to || hasVia(e.id)) continue;
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
    if (!p || (p.from && p.to)) continue;
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
