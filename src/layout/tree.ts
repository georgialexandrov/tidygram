import type { Diagram, DNode } from '../model/types.ts';
import type { Box, Positions } from '../scene/containers.ts';
import type { NodeShape } from '../scene/shapes.ts';
import type { Theme } from '../scene/theme.ts';

/**
 * Tree layouts for mindmaps and WBS: no search, no router. A mindmap is a tidy tree (contour
 * based, Reingold-Tilford style) growing left and right of the root; a WBS is an org chart whose
 * deeper levels hang as indented lists. Lines are derived from the boxes (`treeLine`), so they
 * follow a dragged node for free.
 */

export const isTreeDiagram = (d: Diagram): boolean => (d.family === 'mindmap' || d.family === 'wbs') && d.nodes.length > 0 && !d.containers.length && d.nodes.every((n) => n.kind === 'topic');

interface Tree {
  kids: Map<string, DNode[]>;
  parent: Map<string, string>;
  roots: DNode[];
}

function treeOf(diagram: Diagram): Tree {
  const byId = new Map(diagram.nodes.map((n) => [n.id, n]));
  const kids = new Map<string, DNode[]>();
  const parent = new Map<string, string>();
  for (const e of diagram.edges) {
    const c = byId.get(e.to);
    if (!c || !byId.has(e.from) || parent.has(e.to) || e.from === e.to) continue;
    parent.set(e.to, e.from);
    kids.set(e.from, [...(kids.get(e.from) ?? []), c]);
  }
  for (const list of kids.values()) list.sort((a, b) => diagram.nodes.indexOf(a) - diagram.nodes.indexOf(b));
  return { kids, parent, roots: diagram.nodes.filter((n) => !parent.has(n.id)) };
}

/** A topic and everything under it: what dragging the topic carries along. */
export function subtreeIds(diagram: Diagram, id: string): string[] {
  if (!isTreeDiagram(diagram)) return [id];
  const { kids } = treeOf(diagram);
  const out: string[] = [];
  const walk = (n: string) => {
    out.push(n);
    for (const c of kids.get(n) ?? []) walk(c.id);
  };
  walk(id);
  return out;
}

export function treePositions(diagram: Diagram, shapes: Map<string, NodeShape>, theme: Theme): Positions {
  const tree = treeOf(diagram);
  const out: Positions = {};
  let top = 0;
  for (const root of tree.roots) {
    const local = diagram.family === 'wbs' ? wbs(root, tree, shapes, theme) : mindmap(root, tree, shapes, theme);
    const ys = [...local].map(([id, p]) => [p.y - shapes.get(id)!.h / 2, p.y + shapes.get(id)!.h / 2] as const);
    const lo = Math.min(...ys.map((y) => y[0]));
    const hi = Math.max(...ys.map((y) => y[1]));
    for (const [id, p] of local) out[id] = { x: Math.round(p.x), y: Math.round(p.y - lo + top) };
    top += hi - lo + 60 * theme.scale;
  }
  return out;
}

// ---- mindmap -----------------------------------------------------------------------------------

interface Contour {
  top: number[];
  bot: number[];
}

function leaves(n: DNode, kids: Map<string, DNode[]>): number {
  const c = kids.get(n.id);
  return c?.length ? c.reduce((s, k) => s + leaves(k, kids), 0) : 1;
}

/** Which side of the root each first-level branch goes: the source's marker, else balanced by size and reading order. */
function sides(root: DNode, tree: Tree): Map<string, 'left' | 'right'> {
  const first = tree.kids.get(root.id) ?? [];
  const out = new Map<string, 'left' | 'right'>();
  const weight = new Map(first.map((n) => [n.id, leaves(n, tree.kids)]));
  const marked = first.filter((n) => n.side);
  if (!marked.length) {
    // Clockwise: the first branches go down the right, the rest come back up the left.
    const total = [...weight.values()].reduce((a, b) => a + b, 0);
    let best = 0;
    let bestDiff = Infinity;
    for (let k = 0; k <= first.length; k++) {
      const right = first.slice(0, k).reduce((s, n) => s + weight.get(n.id)!, 0);
      const diff = Math.abs(total - 2 * right) + (k === 0 || k === first.length ? 0.5 : 0);
      if (diff < bestDiff) [best, bestDiff] = [k, diff];
    }
    first.forEach((n, i) => out.set(n.id, i < best ? 'right' : 'left'));
    return out;
  }
  const load = { left: 0, right: 0 };
  for (const n of marked) {
    out.set(n.id, n.side!);
    load[n.side!] += weight.get(n.id)!;
  }
  for (const n of first) {
    if (out.has(n.id)) continue;
    const s = load.right <= load.left ? 'right' : 'left';
    out.set(n.id, s);
    load[s] += weight.get(n.id)!;
  }
  return out;
}

function mindmap(root: DNode, tree: Tree, shapes: Map<string, NodeShape>, theme: Theme): Map<string, { x: number; y: number }> {
  const k = theme.scale;
  const size = (n: DNode) => shapes.get(n.id) ?? shapes.get(root.id)!;
  const h = (n: DNode) => size(n).h;
  const w = (n: DNode) => size(n).w;
  /** Gap between sibling subtrees at a level: wide between the big branches, tight between leaves. */
  const gap = (level: number) => (level <= 1 ? 26 : level === 2 ? 14 : 10) * k;
  const kidsOf = new Map(tree.kids);
  const rel = new Map<string, number>(); // y relative to the parent
  const place = (n: DNode, level: number): Contour => {
    const kids = kidsOf.get(n.id) ?? [];
    const own: Contour = { top: [-h(n) / 2], bot: [h(n) / 2] };
    if (!kids.length) return own;
    const acc: Contour = { top: [], bot: [] };
    const shifts: number[] = [];
    for (const c of kids) {
      const sub = place(c, level + 1);
      let shift = 0;
      if (shifts.length) for (let d = 0; d < Math.min(sub.top.length, acc.bot.length); d++) shift = Math.max(shift, acc.bot[d]! + gap(level + 1) - sub.top[d]!);
      shifts.push(shift);
      rel.set(c.id, shift);
      for (let d = 0; d < sub.top.length; d++) {
        acc.top[d] = d < acc.top.length ? Math.min(acc.top[d]!, sub.top[d]! + shift) : sub.top[d]! + shift;
        acc.bot[d] = sub.bot[d]! + shift;
      }
    }
    const mid = (shifts[0]! + shifts[shifts.length - 1]!) / 2;
    for (const c of kids) rel.set(c.id, rel.get(c.id)! - mid);
    return { top: [own.top[0]!, ...acc.top.map((t) => t - mid)], bot: [own.bot[0]!, ...acc.bot.map((b) => b - mid)] };
  };

  const out = new Map<string, { x: number; y: number }>([[root.id, { x: 0, y: 0 }]]);
  const assigned = sides(root, tree);
  const explicit = (tree.kids.get(root.id) ?? []).some((n) => n.side);
  for (const side of ['right', 'left'] as const) {
    const first = (tree.kids.get(root.id) ?? []).filter((n) => assigned.get(n.id) === side);
    if (!first.length) continue;
    // Each side is a family of its own under a stand-in for the root, so the root sits level with both.
    const stand: DNode = { ...root, id: `\u0000${side}` };
    kidsOf.set(stand.id, side === 'left' && !explicit ? [...first].reverse() : first);
    place(stand, 0);
    // Columns: one per level, as wide as its widest topic.
    const levelOf = new Map<string, number>();
    const column: number[] = [];
    const walk = (n: DNode, level: number) => {
      levelOf.set(n.id, level);
      column[level] = Math.max(column[level] ?? 0, w(n));
      for (const c of kidsOf.get(n.id) ?? []) walk(c, level + 1);
    };
    for (const n of first) walk(n, 1);
    const sign = side === 'right' ? 1 : -1;
    const x: number[] = [];
    let edge = w(root) / 2;
    for (let level = 1; level < column.length; level++) {
      edge += (level === 1 ? 52 : 36) * k;
      x[level] = sign * (edge + column[level]! / 2);
      edge += column[level]!;
    }
    const abs = (n: DNode, parentY: number) => {
      const y = parentY + rel.get(n.id)!;
      out.set(n.id, { x: x[levelOf.get(n.id)!]!, y });
      for (const c of kidsOf.get(n.id) ?? []) abs(c, y);
    };
    for (const n of kidsOf.get(stand.id)!) abs(n, 0);
  }
  return out;
}

// ---- WBS ---------------------------------------------------------------------------------------

function wbs(root: DNode, tree: Tree, shapes: Map<string, NodeShape>, theme: Theme): Map<string, { x: number; y: number }> {
  const k = theme.scale;
  const w = (n: DNode) => shapes.get(n.id)!.w;
  const h = (n: DNode) => shapes.get(n.id)!.h;
  const indent = 26 * k;
  const rowGap = 12 * k;
  const out = new Map<string, { x: number; y: number }>();
  /** A topic with its list under it, laid out from its top-left corner; returns the block's size. */
  const block = (n: DNode, left: number, top: number): { w: number; h: number } => {
    out.set(n.id, { x: left + w(n) / 2, y: top + h(n) / 2 });
    let width = w(n);
    let y = top + h(n) + rowGap;
    for (const c of tree.kids.get(n.id) ?? []) {
      const b = block(c, left + indent, y);
      width = Math.max(width, indent + b.w);
      y += b.h + rowGap;
    }
    return { w: width, h: y - rowGap - top };
  };
  const first = tree.kids.get(root.id) ?? [];
  const rowTop = h(root) + 44 * k;
  let cursor = 0;
  for (const c of first) {
    const b = block(c, cursor, rowTop);
    cursor += b.w + 30 * k;
  }
  if (first.length) {
    const a = out.get(first[0]!.id)!.x;
    const z = out.get(first[first.length - 1]!.id)!.x;
    out.set(root.id, { x: (a + z) / 2, y: h(root) / 2 });
  } else out.set(root.id, { x: 0, y: h(root) / 2 });
  return out;
}

// ---- lines -------------------------------------------------------------------------------------

type P = [number, number];
const r1 = (v: number) => Math.round(v * 10) / 10;

function bezier(p0: P, p1: P, p2: P, p3: P, steps = 10): P[] {
  const pts: P[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const u = 1 - t;
    pts.push([u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0], u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1]]);
  }
  return pts;
}

/** Orthogonal polyline with rounded corners as an SVG path. */
function elbow(pts: P[], radius: number): string {
  let d = `M${r1(pts[0]![0])},${r1(pts[0]![1])}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const a = pts[i - 1]!;
    const b = pts[i]!;
    const c = pts[i + 1]!;
    const r = Math.min(radius, Math.hypot(b[0] - a[0], b[1] - a[1]) / 2, Math.hypot(c[0] - b[0], c[1] - b[1]) / 2);
    const ua: P = [Math.sign(b[0] - a[0]), Math.sign(b[1] - a[1])];
    const uc: P = [Math.sign(c[0] - b[0]), Math.sign(c[1] - b[1])];
    d += ` L${r1(b[0] - ua[0] * r)},${r1(b[1] - ua[1] * r)} Q${r1(b[0])},${r1(b[1])} ${r1(b[0] + uc[0] * r)},${r1(b[1] + uc[1] * r)}`;
  }
  const last = pts[pts.length - 1]!;
  return `${d} L${r1(last[0])},${r1(last[1])}`;
}

/**
 * The line from a topic to its child, from the boxes alone. Mindmap: a cubic with level tangents from the
 * parent's side to the child's (or top to bottom for a child dropped below). WBS: a bus under the root,
 * then a spine down the parent's left with an elbow into each child.
 */
export function treeLine(family: 'mindmap' | 'wbs', a: Box, b: Box, opts: { fromRoot: boolean; boxless?: boolean; scale: number }): { points: P[]; path: string } {
  if (family === 'wbs') {
    const radius = 7 * opts.scale;
    if (opts.fromRoot || b.y <= a.y + a.h) {
      const start: P = [a.x + a.w / 2, a.y + a.h];
      const end: P = [b.x + b.w / 2, b.y];
      const busY = start[1] + Math.max(8, (end[1] - start[1]) / 2);
      const pts: P[] = Math.abs(start[0] - end[0]) < 0.5 ? [start, end] : [start, [start[0], busY], [end[0], busY], end];
      return { points: pts, path: elbow(pts, radius) };
    }
    const spine = a.x + Math.min(13 * opts.scale, a.w / 2);
    const y = b.y + b.h / 2;
    const pts: P[] = [[spine, a.y + a.h], [spine, y], [b.x, y]];
    return { points: pts, path: elbow(pts, radius) };
  }
  const y2 = opts.boxless ? b.y + b.h : b.y + b.h / 2;
  const acx = a.x + a.w / 2;
  const bcx = b.x + b.w / 2;
  let p0: P;
  let p3: P;
  let p1: P;
  let p2: P;
  if (b.x >= a.x + a.w - 1 || b.x + b.w <= a.x + 1) {
    const right = b.x >= a.x + a.w - 1;
    p0 = [right ? a.x + a.w : a.x, a.y + a.h / 2];
    p3 = [right ? b.x : b.x + b.w, y2];
    const mx = (p0[0] + p3[0]) / 2;
    p1 = [mx, p0[1]];
    p2 = [mx, p3[1]];
  } else {
    const down = b.y + b.h / 2 > a.y + a.h / 2;
    p0 = [acx, down ? a.y + a.h : a.y];
    p3 = [bcx, down ? b.y : b.y + b.h];
    const my = (p0[1] + p3[1]) / 2;
    p1 = [p0[0], my];
    p2 = [p3[0], my];
  }
  return { points: bezier(p0, p1, p2, p3), path: `M${r1(p0[0])},${r1(p0[1])} C${r1(p1[0])},${r1(p1[1])} ${r1(p2[0])},${r1(p2[1])} ${r1(p3[0])},${r1(p3[1])}` };
}
