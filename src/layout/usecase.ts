import type { DEdge, DNode, Diagram } from '../model/types.ts';
import { nodeBox, overlaps, type Box, type Positions } from '../scene/containers.ts';
import type { NodeShape, Pad } from '../scene/shapes.ts';
import type { Theme } from '../scene/theme.ts';
import { pack } from './template/place.ts';

/**
 * Use-case layout. A use-case diagram reads as "who does what": the people
 * who start things on the left, the systems that get called on the right,
 * the use cases in between, grouped by their packages. ELK's layered layout
 * sees actors as ordinary layers and strings the packages out in one row,
 * which turns the picture into a web of long lines. Here:
 *
 * - every top-level actor goes to the left or right column, by how its lines
 *   run (`Actor --> UC` starts something: left; `UC --> Actor` is called:
 *   right) and by role words (`<<system>>`, "Gateway", "Service", ...);
 *   actors related by generalisation stay together, the parent between its
 *   children, so the triangles are short vertical lines;
 * - use cases sit in a grid inside their package, packages in a grid inside
 *   their boundary; slots and package order are chosen to keep lines short
 *   and uncrossed (barycentre ordering against the actor columns, then
 *   pairwise swaps on straight-line length + crossings + lines through
 *   boxes), with include/extend counted double so the included use case
 *   ends up next to its base;
 * - a note rides beside what it annotates (a note outside the target's
 *   package goes just outside the boundary, nearest the target).
 *
 * Several grid shapes are returned; the caller routes and scores them.
 */

/** A use-case diagram: actors and mostly use cases (description family). */
export function isUseCaseDiagram(diagram: Diagram): boolean {
  if (diagram.family !== 'description') return false;
  const actors = diagram.nodes.filter((n) => n.kind === 'actor' && !n.parent).length;
  const middle = diagram.nodes.filter((n) => n.kind !== 'note' && !(n.kind === 'actor' && !n.parent));
  const cases = middle.filter((n) => n.kind === 'usecase').length;
  return actors >= 1 && cases >= 2 && cases >= middle.length * 0.6;
}

/**
 * Role words that mark a supporting system rather than a person starting something: the label's last
 * word ("Payment Gateway", "Maps Service"; not "Bank Clerk") or any word of its stereotype.
 */
const SYSTEM_NOUN = /^(system|systems|service|services|gateway|api|server|provider|backend|database|db|processor|registry|directory|engine|platform|cloud|bus|queue|ldap|erp|crm)$/i;
const SYSTEM_STEREOTYPE = /\b(system|external|service|server|api|gateway|database|backend)\b/i;

export function isSystemActor(n: DNode): boolean {
  const last = n.label.trim().split(/\s+/).at(-1) ?? '';
  return SYSTEM_NOUN.test(last) || SYSTEM_STEREOTYPE.test(n.stereotype ?? '');
}

interface Item {
  id: string;
  /** Footprint of the element plus the notes riding beside it. */
  w: number;
  h: number;
  /** Centre of the element within the footprint (from its top-left). */
  cx: number;
  cy: number;
  /** Riding notes: offsets of their centres from the element's centre. */
  riders: { id: string; dx: number; dy: number }[];
}

interface Grid {
  /** Container id, '' for the top level. */
  key: string;
  items: Map<string, Item>;
  /** Item ids in slot order (row-major). */
  order: string[];
  cols: number;
}

/** A container's blocks: its own grid (`g:`) and child containers (`c:`), in grid order. */
interface Block {
  key: string;
  order: string[];
  cols: number;
}

type ParentAt = 'middle' | 'first' | 'last';

interface State {
  grids: Map<string, Grid>;
  blocks: Map<string, Block>;
  /** Where each generalisation parent sits among its children: 'middle' (default), 'first' or 'last'. */
  parentAt: Map<string, ParentAt>;
  /** Actor centres relative to the middle's top-left, recomputed from the middle each round. */
  actorY: Map<string, number>;
}

export interface UseCaseOptions {
  /** Columns in every package's grid: a number, or 'auto' (about square, leaning wide). */
  cols: number | 'auto';
  /** Columns of packages inside a boundary (and of top-level blocks). */
  blockCols: number;
  /** Which column each actor goes to (default `actorSides`). */
  sides?: Map<string, 'left' | 'right'>;
  /** Wider gaps between rows, packages and related actors (more room for lines, a taller picture). */
  roomy?: boolean;
  /** Only report the starting shape's proportions (width / height) without optimising: `{ aspect }`. */
  probe?: boolean;
}

export function useCaseLayouts(diagram: Diagram, shapes: Map<string, NodeShape>, theme: Theme, pad: Pad, keep = 6): { name: string; positions: Positions }[] {
  const blockCounts = [...childBlocks(diagram).values()].map((b) => b.length);
  const most = Math.max(1, ...blockCounts);
  const blockOptions = [...new Set([1, 2, Math.ceil(most / 2), most].filter((c) => c >= 1 && c <= most))];
  // Every grid shape is cheap to lay out unoptimised; only the `keep` nearest a window's proportions
  // (16:10, between 4:3 and 2:1) are optimised and handed on to be routed.
  const options: (UseCaseOptions & { off: number })[] = [];
  const seen = new Set<string>();
  for (const cols of [1, 2, 3, 4, 'auto'] as const) {
    for (const blockCols of blockOptions) {
      for (const roomy of [false, true]) {
        const { aspect } = useCasePositions(diagram, shapes, theme, pad, { cols, blockCols, roomy, probe: true });
        const key = `${aspect.toFixed(3)}|${roomy}`;
        if (seen.has(key)) continue;
        seen.add(key);
        options.push({ cols, blockCols, roomy, off: Math.abs(Math.log(aspect / 1.6)) });
      }
    }
  }
  const out: { name: string; positions: Positions }[] = [];
  // The best shape for each arrangement of packages first (they differ most), then the next nearest.
  options.sort((a, b) => a.off - b.off);
  const chosen = blockOptions.map((c) => options.find((o) => o.blockCols === c)).filter((o) => o !== undefined);
  for (const o of options) if (chosen.length < keep && !chosen.includes(o)) chosen.push(o);
  for (const o of chosen) {
    const name = `usecase cols=${o.cols} blocks=${o.blockCols}${o.roomy ? ' roomy' : ''}`;
    const positions = useCasePositions(diagram, shapes, theme, pad, o);
    out.push({ name, positions });
    // Sides by where each actor's use cases ended up: with packages side by side, an actor working
    // mostly in the right-hand ones is drawn on the right, so its lines don't cross the left column's.
    const sides = sidesByPlace(diagram, positions);
    if (sides) out.push({ name: `${name} sides`, positions: useCasePositions(diagram, shapes, theme, pad, { ...o, sides }) });
  }
  return out;
}

/**
 * Actor columns from a finished layout: a generalisation family goes to the side its use cases lie
 * towards, when they clearly do (mean in the outer 40% of the middle's width); systems stay right.
 * Undefined when nothing changes.
 */
function sidesByPlace(diagram: Diagram, at: Positions): Map<string, 'left' | 'right'> | undefined {
  const base = actorSides(diagram);
  const actors = diagram.nodes.filter(isActor);
  const ids = new Set(actors.map((a) => a.id));
  const middle = diagram.nodes.filter((n) => !ids.has(n.id) && at[n.id]);
  const x0 = Math.min(...middle.map((n) => at[n.id]!.x));
  const x1 = Math.max(...middle.map((n) => at[n.id]!.x));
  if (!(x1 > x0)) return undefined;
  const root = new Map(actors.map((a) => [a.id, a.id]));
  const find = (id: string): string => (root.get(id) === id ? id : find(root.get(id)!));
  for (const e of diagram.edges) if (e.kind === 'generalization' && ids.has(e.from) && ids.has(e.to)) root.set(find(e.from), find(e.to));
  const xs = new Map<string, number[]>();
  for (const e of diagram.edges) {
    if (e.kind === 'noteLink' || ids.has(e.from) === ids.has(e.to)) continue;
    const [a, o] = ids.has(e.from) ? [e.from, e.to] : [e.to, e.from];
    if (at[o]) xs.set(find(a), [...(xs.get(find(a)) ?? []), (at[o]!.x - x0) / (x1 - x0)]);
  }
  const out = new Map(base);
  let changed = false;
  for (const a of actors) {
    if (isSystemActor(a)) continue;
    const list = xs.get(find(a.id));
    if (!list?.length) continue;
    const m = mean(list);
    const side = m > 0.6 ? 'right' : m < 0.4 ? 'left' : base.get(a.id)!;
    if (side !== base.get(a.id)) [changed] = [true];
    out.set(a.id, side);
  }
  return changed ? out : undefined;
}

/** Child blocks per container key ('' = top level): its own grid if it has middle elements, then child containers that hold any. */
function childBlocks(diagram: Diagram, middle = middleNodes(diagram)): Map<string, string[]> {
  const holds = new Map<string, boolean>();
  const has = (id: string): boolean => {
    if (holds.has(id)) return holds.get(id)!;
    const v = middle.some((n) => n.parent === id) || diagram.containers.some((c) => c.parent === id && has(c.id));
    holds.set(id, v);
    return v;
  };
  const result = new Map<string, string[]>();
  for (const key of ['', ...diagram.containers.map((c) => c.id)]) {
    if (key && !has(key)) continue;
    const list: string[] = [];
    if (middle.some((n) => (n.parent ?? '') === key)) list.push(`g:${key}`);
    for (const c of diagram.containers) if ((c.parent ?? '') === key && has(c.id)) list.push(`c:${c.id}`);
    result.set(key, list);
  }
  return result;
}

const isActor = (n: DNode) => n.kind === 'actor' && !n.parent;

/** Everything that goes into the grids: all but top-level actors and the notes riding along with something. */
function middleNodes(diagram: Diagram): DNode[] {
  const riding = new Set(riders(diagram).keys());
  return diagram.nodes.filter((n) => !isActor(n) && !riding.has(n.id));
}

/** Notes that annotate one element: note id → target and side. */
function riders(diagram: Diagram): Map<string, { target: string; side: 'left' | 'right' | 'top' | 'bottom' }> {
  const out = new Map<string, { target: string; side: 'left' | 'right' | 'top' | 'bottom' }>();
  const byId = new Map(diagram.nodes.map((n) => [n.id, n]));
  for (const n of diagram.nodes) {
    if (n.kind !== 'note') continue;
    let target = n.attachedTo?.id;
    let side = n.attachedTo?.side ?? 'right';
    if (!target) {
      const links = diagram.edges.filter((e) => e.kind === 'noteLink' && (e.from === n.id || e.to === n.id));
      if (links.length === 1) target = links[0]!.from === n.id ? links[0]!.to : links[0]!.from;
      side = 'right';
    }
    const t = target ? byId.get(target) : undefined;
    if (t && t.kind !== 'note' && !isActor(t)) out.set(n.id, { target: t.id, side });
  }
  return out;
}

/** Left or right column for every top-level actor. */
export function actorSides(diagram: Diagram): Map<string, 'left' | 'right'> {
  const actors = diagram.nodes.filter(isActor);
  const ids = new Set(actors.map((a) => a.id));
  const vote = new Map(actors.map((a) => [a.id, 0]));
  for (const e of diagram.edges) {
    if (e.kind === 'noteLink' || e.from === e.to) continue;
    const [fa, ta] = [ids.has(e.from), ids.has(e.to)];
    if (fa === ta) continue;
    const actor = fa ? e.from : e.to;
    // Who starts it: the end without the arrowhead; with no heads, the end written first.
    let starts: boolean;
    if (e.head !== 'none' && e.tail === 'none') starts = e.from === actor;
    else if (e.tail !== 'none' && e.head === 'none') starts = e.to === actor;
    else starts = (e.reversed ? e.to : e.from) === actor;
    vote.set(actor, vote.get(actor)! + (starts ? -1 : 1));
  }
  for (const a of actors) if (isSystemActor(a)) vote.set(a.id, vote.get(a.id)! + 1.5);
  // Generalisation families share a side: the sum of their votes.
  const root = new Map(actors.map((a) => [a.id, a.id]));
  const find = (id: string): string => (root.get(id) === id ? id : find(root.get(id)!));
  for (const e of diagram.edges) if (e.kind === 'generalization' && ids.has(e.from) && ids.has(e.to)) root.set(find(e.from), find(e.to));
  const family = new Map<string, number>();
  for (const a of actors) family.set(find(a.id), (family.get(find(a.id)) ?? 0) + vote.get(a.id)!);
  return new Map(actors.map((a) => [a.id, family.get(find(a.id))! > 0 ? 'right' : 'left']));
}

export function useCasePositions(diagram: Diagram, shapes: Map<string, NodeShape>, theme: Theme, pad: Pad, options: UseCaseOptions & { probe: true }): { aspect: number };
export function useCasePositions(diagram: Diagram, shapes: Map<string, NodeShape>, theme: Theme, pad: Pad, options: UseCaseOptions): Positions;
export function useCasePositions(diagram: Diagram, shapes: Map<string, NodeShape>, theme: Theme, pad: Pad, options: UseCaseOptions): Positions | { aspect: number } {
  const k = theme.scale;
  const roomy = options.roomy ? 1 : 0;
  const gap = { col: 64 * k, row: (30 + 14 * roomy) * k, block: (36 + 12 * roomy) * k, actors: 110 * k, actor: 22 * k, kin: (26 + 14 * roomy) * k, rider: 24 * k, level: 48 * k };
  const middle = middleNodes(diagram);
  const rides = riders(diagram);
  const sides = options.sides ?? actorSides(diagram);
  const actors = diagram.nodes.filter(isActor);
  const byId = new Map(diagram.nodes.map((n) => [n.id, n]));

  // Items: each middle element with the notes riding beside it (same container only; others go outside later).
  const items = new Map<string, Item>();
  for (const n of middle) {
    const s = shapes.get(n.id)!;
    const item: Item = { id: n.id, w: s.w, h: s.h, cx: s.w / 2, cy: s.h / 2, riders: [] };
    for (const [noteId, r] of rides) {
      if (r.target !== n.id || byId.get(noteId)!.parent !== n.parent) continue;
      const ns = shapes.get(noteId)!;
      const along = r.side === 'left' || r.side === 'right';
      const off = along ? s.w / 2 + gap.rider + ns.w / 2 : s.h / 2 + gap.rider + ns.h / 2;
      const sign = r.side === 'left' || r.side === 'top' ? -1 : 1;
      const dx = along ? sign * off : 0;
      const dy = along ? 0 : sign * off;
      item.riders.push({ id: noteId, dx, dy });
      // Grow the footprint to hold the note; the element's centre moves within it.
      const x0 = Math.min(-item.cx, dx - ns.w / 2);
      const x1 = Math.max(item.w - item.cx, dx + ns.w / 2);
      const y0 = Math.min(-item.cy, dy - ns.h / 2);
      const y1 = Math.max(item.h - item.cy, dy + ns.h / 2);
      item.cx = -x0;
      item.cy = -y0;
      item.w = x1 - x0;
      item.h = y1 - y0;
    }
    items.set(n.id, item);
  }

  const blocksOf = childBlocks(diagram, middle);
  const state: State = { grids: new Map(), blocks: new Map(), actorY: new Map(), parentAt: new Map() };
  for (const [key, list] of blocksOf) {
    state.blocks.set(key, { key, order: [...list], cols: Math.min(options.blockCols, list.length) });
    if (list.includes(`g:${key}`)) {
      const own = middle.filter((n) => (n.parent ?? '') === key).sort((a, b) => a.line - b.line);
      const n = own.length;
      const cols = options.cols === 'auto' ? Math.max(1, Math.min(n, Math.round(Math.sqrt(n * 0.6)))) : Math.min(options.cols, n);
      state.grids.set(key, { key, items: new Map(own.map((m) => [m.id, items.get(m.id)!])), order: own.map((m) => m.id), cols });
    }
  }

  // Lines that matter for placement, with weights: include/extend want their ends side by side.
  const links: { a: string; b: string; w: number }[] = [];
  for (const e of diagram.edges) {
    if (e.kind === 'noteLink' || e.from === e.to || e.hidden) continue;
    links.push({ a: e.from, b: e.to, w: isInclude(e) ? 2 : 1 });
  }
  const neighbours = new Map<string, { id: string; w: number }[]>(diagram.nodes.map((n) => [n.id, []]));
  for (const l of links) {
    neighbours.get(l.a)?.push({ id: l.b, w: l.w });
    neighbours.get(l.b)?.push({ id: l.a, w: l.w });
  }

  const actorW = (side: 'left' | 'right') => Math.max(0, ...actors.filter((a) => sides.get(a.id) === side).map((a) => shapes.get(a.id)!.w));
  /**
   * Every element's centre for the current state, the middle's top-left at (0, 0). Actors only depend on
   * the middle, so they are placed here every time: a swap is judged with the actors already following it.
   */
  const positions = (s: State): Positions => {
    const at: Positions = {};
    const size = measureBlock('', s, blocksOf, pad, gap, at, 0, 0);
    const left = -gap.actors - actorW('left') / 2;
    const right = size.w + gap.actors + actorW('right') / 2;
    placeActors(at, s.actorY, size.h / 2, s.parentAt);
    for (const a of actors) at[a.id] = { x: sides.get(a.id) === 'left' ? left : right, y: s.actorY.get(a.id)! };
    return at;
  };

  const unit = 150 * k;
  /** A corner in a line: a bend reads as a small detour. */
  const corner = unit * CORNER;
  /**
   * What a layout will cost once routed orthogonally, estimated without routing: every line as the
   * path the router tends to take (an actor's lines leave along a trunk beside its column, then run
   * across at the use case's height; other lines straight or one corner), scored on length (include
   * and extend double), crossings, runs through other elements, and overlapping actor fans (two
   * actors whose use cases interleave in height cross each other's trunks).
   */
  const cost = (at: Positions): number => {
    let total = 0;
    const horizontal: { y: number; x0: number; x1: number; line: number }[] = [];
    const vertical: { x: number; y0: number; y1: number; line: number }[] = [];
    const fans = new Map<string, number[]>();
    const boxes = middle.map((n) => ({ id: n.id, box: nodeBox(at[n.id]!, shapes.get(n.id)!) }));
    const hits = (a: Pt, b: Pt, skip: string[]) => {
      const [x0, x1, y0, y1] = [Math.min(a.x, b.x), Math.max(a.x, b.x), Math.min(a.y, b.y), Math.max(a.y, b.y)];
      let n = 0;
      for (const o of boxes) {
        const bx = o.box;
        if (bx.x > x1 || bx.x + bx.w < x0 || bx.y > y1 || bx.y + bx.h < y0) continue;
        if (!skip.includes(o.id) && segmentHitsBox(a, b, bx)) n++;
      }
      return n;
    };
    links.forEach((l, line) => {
      const [p, q] = [at[l.a], at[l.b]];
      if (!p || !q) return;
      const [actor, other] = isActorId(l.a) ? [l.a, l.b] : isActorId(l.b) ? [l.b, l.a] : [undefined, undefined];
      const seg = (a: Pt, b: Pt) => {
        if (Math.abs(a.y - b.y) < 1) horizontal.push({ y: a.y, x0: Math.min(a.x, b.x), x1: Math.max(a.x, b.x), line });
        else vertical.push({ x: a.x, y0: Math.min(a.y, b.y), y1: Math.max(a.y, b.y), line });
        total += (Math.abs(a.x - b.x) + Math.abs(a.y - b.y)) * l.w + hits(a, b, [l.a, l.b]) * unit * 0.6;
      };
      if (actor && other && !isActorId(other)) {
        const a = at[actor]!;
        const u = at[other]!;
        const left = sides.get(actor) === 'left';
        const trunk = a.x + (left ? 1 : -1) * gap.actors * 0.5;
        const us = shapes.get(other)!;
        const entry = u.x + ((left ? -1 : 1) * us.w) / 2;
        total += Math.abs(a.x - trunk);
        if (!hits({ x: trunk, y: u.y }, { x: entry, y: u.y }, [other])) {
          // Nothing in the way: straight across at the use case's height.
          total += Math.abs(a.y - u.y) + (Math.abs(a.y - u.y) > 1 ? 2 * corner : 0);
          seg({ x: trunk, y: u.y }, { x: entry, y: u.y });
          fans.set(actor, [...(fans.get(actor) ?? []), u.y]);
          return;
        }
        // Something sits in front of it in its row: the router runs along the gap above or below
        // (the one towards the actor) and drops in.
        const above = a.y < u.y;
        const gy = above ? u.y - us.h / 2 - gap.row / 2 : u.y + us.h / 2 + gap.row / 2;
        total += Math.abs(a.y - gy);
        seg({ x: trunk, y: gy }, { x: u.x, y: gy });
        seg({ x: u.x, y: gy }, { x: u.x, y: above ? u.y - us.h / 2 : u.y + us.h / 2 });
        // Three corners (out of the trunk, along the gap, down into it).
        total += 3 * corner;
        fans.set(actor, [...(fans.get(actor) ?? []), gy]);
        return;
      }
      const [sp, sq] = [shapes.get(l.a)!, shapes.get(l.b)!];
      // Stacked above one another with something in between: the router goes round on the actors' side
      // (seen in every routed picture), crossing their lines on the way.
      if (Math.abs(p.x - q.x) < (sp.w + sq.w) / 2 && Math.abs(p.y - q.y) > 1 && hits(p, { x: p.x, y: q.y }, [l.a, l.b])) {
        const x = Math.min(p.x - sp.w / 2, q.x - sq.w / 2) - 12 * k;
        seg({ x: p.x - sp.w / 2, y: p.y }, { x, y: p.y });
        seg({ x, y: p.y }, { x, y: q.y });
        seg({ x, y: q.y }, { x: q.x - sq.w / 2, y: q.y });
        total += 2 * corner;
        return;
      }
      if (Math.abs(p.y - q.y) < 1 || Math.abs(p.x - q.x) < 1) return seg(p, q);
      // One corner, whichever way passes fewer elements.
      const c1 = { x: q.x, y: p.y };
      const c2 = { x: p.x, y: q.y };
      const h1 = hits(p, c1, [l.a, l.b]) + hits(c1, q, [l.a, l.b]);
      const h2 = hits(p, c2, [l.a, l.b]) + hits(c2, q, [l.a, l.b]);
      const c = h1 <= h2 ? c1 : c2;
      total += corner;
      seg(p, c);
      seg(c, q);
    });
    for (const h of horizontal) {
      for (const v of vertical) {
        if (v.line !== h.line && v.x > h.x0 + 1 && v.x < h.x1 - 1 && h.y > v.y0 + 1 && h.y < v.y1 - 1) total += unit * CROSS;
      }
    }
    // Fans in one column. Each actor's lines leave it, run to a trunk beside the column and branch off
    // at their rows. With A's trunk nearer the column than B's, B's lines cross A's trunk if B sits inside
    // A's span, and A's branches cross B's trunk where A's rows fall inside B's span; the router takes the
    // cheaper order. (Nested fans count: an actor spanning the column crosses all lines of those inside.)
    for (const side of ['left', 'right'] as const) {
      const list = actors.filter((a) => sides.get(a.id) === side && fans.has(a.id)).map((a) => ({ y: at[a.id]!.y, rows: fans.get(a.id)! }));
      const span = (f: { y: number; rows: number[] }) => [Math.min(f.y, ...f.rows), Math.max(f.y, ...f.rows)] as const;
      const within = (y: number, [lo, hi]: readonly [number, number]) => y > lo + 1 && y < hi - 1;
      for (let i = 0; i < list.length; i++) {
        for (let j = i + 1; j < list.length; j++) {
          const [A, B] = [list[i]!, list[j]!];
          const [sa, sb] = [span(A), span(B)];
          const aFirst = (within(B.y, sa) ? B.rows.length : 0) + A.rows.filter((y) => within(y, sb)).length;
          const bFirst = (within(A.y, sb) ? A.rows.length : 0) + B.rows.filter((y) => within(y, sa)).length;
          total += unit * CROSS * Math.min(aFirst, bFirst);
        }
      }
    }
    return total;
  };

  /** Actors at the barycentre of what they connect to, families together, packed in each column. */
  const placeActors = (at: Positions, actorY: Map<string, number>, middleY: number, parentAt: Map<string, ParentAt>) => {
    const ysOf = new Map<string, number[]>();
    for (const a of actors) ysOf.set(a.id, neighbours.get(a.id)!.filter((o) => !isActorId(o.id)).map((o) => at[o.id]?.y).filter((y) => y !== undefined));
    const want = new Map([...ysOf].filter(([, ys]) => ys.length).map(([id, ys]) => [id, median(ys)]));
    for (const side of ['left', 'right'] as const) {
      const column = actors.filter((a) => sides.get(a.id) === side);
      if (!column.length) continue;
      // Families are packed as one rigid stack, so a generalisation stays a short line. A stack sits at the
      // median of its lines, not the mean: an actor with one far use case gets one long line, rather than
      // sitting halfway and crossing everyone's lines with all of them.
      const families = familyOrder(diagram, column, want, actorY, parentAt);
      const stacks = families.map((f) => {
        const offsets: number[] = [];
        let y = 0;
        f.forEach((id, i) => {
          if (i) y += (shapes.get(f[i - 1]!)!.h + shapes.get(id)!.h) / 2 + gap.kin;
          offsets.push(y - 0);
        });
        const rel = offsets.map((o) => o - y / 2);
        const ys = f.flatMap((id, i) => ysOf.get(id)!.map((v) => v - rel[i]!));
        return { f, rel, want: ys.length ? median(ys) : middleY, top: shapes.get(f[0]!)!.h / 2 - rel[0]!, bottom: shapes.get(f.at(-1)!)!.h / 2 + rel.at(-1)! };
      });
      const sep = stacks.map((st, i) => (i ? stacks[i - 1]!.bottom + st.top + gap.actor : 0));
      const ys = pack(stacks.map((st) => st.want), sep);
      // Level each stack with one of its use cases if that is a small move: that line runs straight across.
      for (let i = 0; i < stacks.length; i++) {
        const st = stacks[i]!;
        const lo = i ? ys[i - 1]! + sep[i]! : -Infinity;
        const hi = i < stacks.length - 1 ? ys[i + 1]! - sep[i + 1]! : Infinity;
        let best: number | undefined;
        st.f.forEach((id, j) => {
          for (const y of ysOf.get(id)!) {
            const d = y - (ys[i]! + st.rel[j]!);
            if (Math.abs(d) < gap.level && ys[i]! + d >= lo && ys[i]! + d <= hi && (best === undefined || Math.abs(d) < Math.abs(best))) best = d;
          }
        });
        if (best !== undefined) ys[i]! += best;
      }
      stacks.forEach((st, i) => st.f.forEach((id, j) => actorY.set(id, ys[i]! + st.rel[j]!)));
    }
  };
  const actorIds = new Set(actors.map((a) => a.id));
  const isActorId = (id: string) => actorIds.has(id);

  /** Rows by where the neighbours are (top to bottom), each row's slots by left/right pull. */
  const barycentreOrder = (s: State, g: Grid) => {
    const at = positions(s);
    const pull = (id: string, axis: 'x' | 'y') => {
      const ns = neighbours.get(id)!.filter((o) => at[o.id]);
      if (!ns.length) return at[id]![axis];
      return ns.reduce((sum, o) => sum + at[o.id]![axis] * o.w, 0) / ns.reduce((sum, o) => sum + o.w, 0);
    };
    const ids = g.order.filter((id) => items.has(id));
    const byY = [...ids].sort((a, b) => pull(a, 'y') - pull(b, 'y'));
    const order: string[] = [];
    for (let r = 0; r < byY.length; r += g.cols) order.push(...byY.slice(r, r + g.cols).sort((a, b) => pull(a, 'x') - pull(b, 'x')));
    g.order = order;
  };

  const improve = (s: State, list: string[], apply: (l: string[]) => void) => {
    let best = cost(positions(s));
    // Generalisation parents (actors with specialised actors): between their children, above or below them.
  const parents = [...new Set(diagram.edges.filter((e) => e.kind === 'generalization' && actorIds.has(e.from) && actorIds.has(e.to)).map((e) => e.to))];
  const placeParents = () => {
    for (const p of parents) {
      let best = Infinity;
      let keep: ParentAt = 'middle';
      for (const at of ['middle', 'first', 'last'] as const) {
        state.parentAt.set(p, at);
        const c = cost(positions(state));
        if (c < best - 1e-6) [best, keep] = [c, at];
      }
      state.parentAt.set(p, keep);
    }
  };
  for (let round = 0; round < 2; round++) {
    placeParents();
      let better = false;
      for (let i = 0; i < list.length; i++) {
        for (let j = i + 1; j < list.length; j++) {
          [list[i], list[j]] = [list[j]!, list[i]!];
          apply(list);
          const c = cost(positions(s));
          if (c < best - 1e-6) {
            best = c;
            better = true;
          } else {
            [list[i], list[j]] = [list[j]!, list[i]!];
            apply(list);
          }
        }
      }
      // Moves: take one out and put it elsewhere (a swap can't shift a run by one).
      for (let i = 0; i < (list.length <= 12 ? list.length : 0); i++) {
        for (let j = 0; j < list.length; j++) {
          if (Math.abs(i - j) < 2) continue;
          const saved = [...list];
          const [x] = list.splice(i, 1);
          list.splice(j, 0, x!);
          apply(list);
          const c = cost(positions(s));
          if (c < best - 1e-6) {
            best = c;
            better = true;
          } else {
            list.splice(0, list.length, ...saved);
            apply(list);
          }
        }
      }
      if (!better) break;
    }
  };

  // The starting proportions (the optimisation below barely changes them): lets the caller pick grid shapes cheaply.
  if (options.probe) {
    const at = positions(state);
    const boxes = Object.entries(at).map(([id, p]) => nodeBox(p, shapes.get(id)!));
    const w = Math.max(...boxes.map((b) => b.x + b.w)) - Math.min(...boxes.map((b) => b.x));
    const h = Math.max(...boxes.map((b) => b.y + b.h)) - Math.min(...boxes.map((b) => b.y));
    return { aspect: w / h };
  }
  // Package order decides which actor fans overlap (actors bridging two packages want them adjacent):
  // with few packages, try every order, each with its use cases sorted by barycentre.
  for (const b of state.blocks.values()) {
    if (b.order.length < 2 || b.order.length > 5) continue;
    let best = Infinity;
    let keep: { order: string[]; grids: Map<string, string[]> } | undefined;
    for (const order of permutations(b.order)) {
      b.order = order;
      for (let r = 0; r < 2; r++) for (const g of state.grids.values()) barycentreOrder(state, g);
      const c = cost(positions(state));
      if (c < best || !keep) [best, keep] = [c, { order, grids: new Map([...state.grids].map(([key, g]) => [key, [...g.order]])) }];
    }
    b.order = keep!.order;
    for (const [key, order] of keep!.grids) state.grids.get(key)!.order = order;
  }
  for (let round = 0; round < 2; round++) {
    for (const b of state.blocks.values()) if (b.order.length > 5) improve(state, b.order, (l) => (b.order = l));
    for (const g of state.grids.values()) {
      // Pad the grid with empty slots so swaps can also move an element into a free cell.
      barycentreOrder(state, g);
      const slots = Math.ceil(g.order.length / g.cols) * g.cols;
      while (g.order.length < slots) g.order.push(`~${g.order.length}`);
      improve(state, g.order, (l) => (g.order = l));
    }
  }
  const at = positions(state);

  // Notes for an element in another container (a top-level note on a packaged use case): just outside the
  // outermost container that holds the target but not the note, straight above or below the target.
  for (const [noteId, r] of rides) {
    if (at[noteId] || !at[r.target]) continue;
    const note = byId.get(noteId)!;
    const ns = shapes.get(noteId)!;
    const own = new Set(ancestors(diagram, note.parent));
    const outer = ancestors(diagram, byId.get(r.target)!.parent).filter((c) => !own.has(c)).at(-1);
    const all = Object.entries(at).map(([id, p]) => nodeBox(p, shapes.get(id)!));
    const t = at[r.target]!;
    let seed = { x: t.x, y: t.y };
    if (outer) {
      const box = boundsOf(diagram, outer, at, shapes, pad);
      const up = t.y - box.y < box.y + box.h - t.y;
      seed = { x: t.x, y: up ? box.y - gap.rider - ns.h / 2 : box.y + box.h + gap.rider + ns.h / 2 };
      all.push(box);
    }
    at[noteId] = nudgeFree(seed, ns, all, up(seed, t));
  }
  return at;
}

const up = (seed: { y: number }, t: { y: number }) => (seed.y < t.y ? -1 : 1);

/** First spot from `seed` outwards (away from the target) where the note fits; then sideways. */
function nudgeFree(seed: { x: number; y: number }, shape: NodeShape, boxes: Box[], dir: number): { x: number; y: number } {
  const fits = (p: { x: number; y: number }) => !boxes.some((b) => overlaps(nodeBox(p, shape), b, 12));
  for (let i = 0; i < 40; i++) {
    for (const dx of [0, 1, -1, 2, -2]) {
      const p = { x: seed.x + dx * shape.w * 0.6, y: seed.y + dir * i * 12 };
      if (fits(p)) return p;
    }
  }
  return seed;
}

function ancestors(diagram: Diagram, parent: string | undefined): string[] {
  const chain: string[] = [];
  for (let p = parent; p; p = diagram.containers.find((c) => c.id === p)?.parent) chain.push(p);
  return chain;
}

function boundsOf(diagram: Diagram, container: string, at: Positions, shapes: Map<string, NodeShape>, pad: Pad): Box {
  const inside = diagram.nodes.filter((n) => at[n.id] && ancestors(diagram, n.parent).includes(container));
  const depth = (n: DNode) => ancestors(diagram, n.parent).indexOf(container) + 1;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const n of inside) {
    const b = nodeBox(at[n.id]!, shapes.get(n.id)!);
    const d = depth(n);
    x0 = Math.min(x0, b.x - pad.side * d);
    x1 = Math.max(x1, b.x + b.w + pad.side * d);
    y0 = Math.min(y0, b.y - pad.top * d);
    y1 = Math.max(y1, b.y + b.h + pad.bottom * d);
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** A crossing costs this many `unit`s of line length. */
const CROSS = 3;
const CORNER = 0.3;
const isInclude = (e: DEdge) => e.kind === 'dependency' || /include|extend/i.test(e.label ?? '');

/**
 * Column order: generalisation families stay together (ordered by where their lines pull them), the parent
 * in the middle of its children so each triangle is a short vertical line. Keeps the previous order on ties.
 */
function familyOrder(diagram: Diagram, column: DNode[], want: Map<string, number>, prev: Map<string, number>, parentAt: Map<string, ParentAt>): string[][] {
  const ids = new Set(column.map((a) => a.id));
  const parentOf = new Map<string, string>();
  for (const e of diagram.edges) if (e.kind === 'generalization' && ids.has(e.from) && ids.has(e.to) && !parentOf.has(e.from)) parentOf.set(e.from, e.to);
  const top = (id: string, seen = new Set<string>()): string => {
    const p = parentOf.get(id);
    return p && !seen.has(p) ? top(p, seen.add(id)) : id;
  };
  const key = (id: string) => want.get(id) ?? prev.get(id) ?? 0;
  const arrange = (id: string): string[] => {
    const kids = column.filter((a) => parentOf.get(a.id) === id && a.id !== id).map((a) => a.id);
    const sub = kids.map((c) => ({ list: arrange(c), at: mean(arrange(c).map(key)) })).sort((a, b) => a.at - b.at);
    const at = parentAt.get(id) ?? 'middle';
    const mid = at === 'first' ? 0 : at === 'last' ? sub.length : Math.floor(sub.length / 2);
    return [...sub.slice(0, mid).flatMap((s) => s.list), id, ...sub.slice(mid).flatMap((s) => s.list)];
  };
  const roots = column.filter((a) => top(a.id) === a.id).map((a) => ({ list: arrange(a.id) }));
  // Anything a cycle left out.
  const placed = new Set(roots.flatMap((r) => r.list));
  for (const a of column) if (!placed.has(a.id)) roots.push({ list: [a.id] });
  return roots
    .map((r) => ({ ...r, at: mean(r.list.map(key)) }))
    .sort((a, b) => a.at - b.at)
    .map((r) => r.list);
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

function permutations<T>(xs: T[]): T[][] {
  if (xs.length <= 1) return [xs];
  return xs.flatMap((x, i) => permutations([...xs.slice(0, i), ...xs.slice(i + 1)]).map((rest) => [x, ...rest]));
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

interface Gaps {
  col: number;
  row: number;
  block: number;
}

/**
 * Lays out a container's blocks (its own grid, child containers) at (ox, oy), writing centres into `at`;
 * returns the size of the content. A child container's footprint includes its padding.
 */
function measureBlock(key: string, s: State, blocksOf: Map<string, string[]>, pad: Pad, gap: Gaps, at: Positions, ox: number, oy: number): { w: number; h: number } {
  const block = s.blocks.get(key)!;
  // Sizes first (into a scratch map), then placement in a grid of `cols` columns, rows top-aligned.
  const sizes = block.order.map((b) => {
    if (b.startsWith('g:')) return gridSize(s.grids.get(b.slice(2))!, gap);
    const inner = measureBlock(b.slice(2), s, blocksOf, pad, gap, {}, 0, 0);
    return { w: inner.w + pad.side * 2, h: inner.h + pad.top + pad.bottom };
  });
  const cols = Math.max(1, block.cols);
  const colW: number[] = [];
  const rowH: number[] = [];
  sizes.forEach((sz, i) => {
    const [r, c] = [Math.floor(i / cols), i % cols];
    colW[c] = Math.max(colW[c] ?? 0, sz.w);
    rowH[r] = Math.max(rowH[r] ?? 0, sz.h);
  });
  const xs = offsets(colW, gap.block);
  const ys = offsets(rowH, gap.block);
  block.order.forEach((b, i) => {
    const [r, c] = [Math.floor(i / cols), i % cols];
    const [x, y] = [ox + xs[c]!, oy + ys[r]!];
    if (b.startsWith('g:')) placeGrid(s.grids.get(b.slice(2))!, gap, at, x, y);
    else measureBlock(b.slice(2), s, blocksOf, pad, gap, at, x + pad.side, y + pad.top);
  });
  return { w: total(colW, gap.block), h: total(rowH, gap.block) };
}

function gridShape(g: Grid) {
  const colW: number[] = [];
  const rowH: number[] = [];
  g.order.forEach((id, i) => {
    const it = g.items.get(id);
    if (!it) return;
    const [r, c] = [Math.floor(i / g.cols), i % g.cols];
    colW[c] = Math.max(colW[c] ?? 0, it.w);
    rowH[r] = Math.max(rowH[r] ?? 0, it.h);
  });
  // Empty columns/rows (all slots free) take no room.
  return { colW: Array.from(colW, (w) => w ?? 0), rowH: Array.from(rowH, (h) => h ?? 0) };
}

function gridSize(g: Grid, gap: Gaps) {
  const { colW, rowH } = gridShape(g);
  return { w: total(colW.filter((w) => w > 0), gap.col), h: total(rowH.filter((h) => h > 0), gap.row) };
}

function placeGrid(g: Grid, gap: Gaps, at: Positions, ox: number, oy: number) {
  const { colW, rowH } = gridShape(g);
  const xs = offsets(colW, gap.col);
  const ys = offsets(rowH, gap.row);
  g.order.forEach((id, i) => {
    const it = g.items.get(id);
    if (!it) return;
    const [r, c] = [Math.floor(i / g.cols), i % g.cols];
    // Centred in its cell.
    const x = ox + xs[c]! + (colW[c]! - it.w) / 2 + it.cx;
    const y = oy + ys[r]! + (rowH[r]! - it.h) / 2 + it.cy;
    at[id] = { x, y };
    for (const rd of it.riders) at[rd.id] = { x: x + rd.dx, y: y + rd.dy };
  });
}

/** Start of each cell along an axis; zero-size cells (empty) take no gap. */
function offsets(sizes: number[], gap: number): number[] {
  const out: number[] = [];
  let acc = 0;
  for (const s of sizes) {
    out.push(acc);
    if (s > 0) acc += s + gap;
  }
  return out;
}

const total = (sizes: number[], gap: number) => {
  const used = sizes.filter((s) => s > 0);
  return used.reduce((a, b) => a + b, 0) + Math.max(0, used.length - 1) * gap;
};

type Pt = { x: number; y: number };

function crosses(a: Pt, b: Pt, c: Pt, d: Pt): boolean {
  const o = (p: Pt, q: Pt, r: Pt) => Math.sign((q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x));
  return o(a, b, c) * o(a, b, d) < 0 && o(c, d, a) * o(c, d, b) < 0;
}

/** Does segment a–b pass through the box (shrunk a little, so grazing doesn't count)? */
function segmentHitsBox(a: Pt, b: Pt, box: Box): boolean {
  const m = 4;
  const [x0, y0, x1, y1] = [box.x + m, box.y + m, box.x + box.w - m, box.y + box.h - m];
  // Liang–Barsky clip.
  let t0 = 0;
  let t1 = 1;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  for (const [p, q] of [
    [-dx, a.x - x0],
    [dx, x1 - a.x],
    [-dy, a.y - y0],
    [dy, y1 - a.y],
  ] as const) {
    if (p === 0) {
      if (q < 0) return false;
      continue;
    }
    const t = q / p;
    if (p < 0) t0 = Math.max(t0, t);
    else t1 = Math.min(t1, t);
    if (t0 > t1) return false;
  }
  return true;
}
