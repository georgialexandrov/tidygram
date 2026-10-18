import type { Point } from '../layout/layout-file.ts';
import type { DEdge, Diagram } from '../model/types.ts';
import type { AttachSide } from '../layout/layout-file.ts';
import { attachOutline } from './attach.ts';
import type { Box } from './containers.ts';
import type { AnchorShape } from './geometry.ts';

/**
 * Bundled lines. An element with several lines into a container (an actor
 * and the use cases of a package) otherwise sends each line down a channel
 * of its own, since the router keeps parallel lines apart, and a handful of
 * actors make a comb of parallel lines in the gap beside the container.
 *
 * Bundled lines leave their source from one spot (the shape's centre pin,
 * not a port of their own) and are routed with libavoid's
 * `nudgeSharedPathsWithCommonEndPoint` off: lines that share an end and run
 * the same way are not pushed apart, so they run as one trunk until each
 * turns off to its own end. That option is router-wide, so it is only
 * switched on once no other two lines share an end point (`clashingEnds`
 * says which must get ports of their own first).
 *
 * Tried and dropped (2026-10-18): a trunk per source and container to a
 * shared door on the container's border, then branches fanning out inside
 * (food-delivery: bends 84 -> 110, crossings 33 -> 41). Packages leave no
 * room between their border and the first column of use cases, so the fan
 * ran through the gaps between rows and came at each use case from above or
 * below. Merging in the gap outside, each line through its own door, gives
 * 84 -> 74 bends. And a post-pass that rebuilt routed lines into bundles
 * (branch `usecase-bundle-prototype`) left the comb inside the boundary.
 */

/** Where bundling pays: use case diagrams (actors with many lines into packages). */
export function bundlesHelp(diagram: Diagram): boolean {
  return diagram.family === 'description' && diagram.nodes.some((n) => n.kind === 'actor');
}

export interface BundleContext {
  /** True for an element (not a container) in the scene that lines may share a spot on. */
  isNode: (id: string) => boolean;
  /** The element's own container, if it is drawn. */
  parentOf: (id: string) => string | undefined;
  within: (id: string, container: string) => boolean;
  /** Lines left as they are: hand-routed, an end chosen by hand, or a port at the source. */
  keep: (e: DEdge, source: 'from' | 'to') => boolean;
}

/**
 * The bundled lines, each with the end that is its source. A line is
 * bundled when its source has at least one other line of the same kind
 * into the same container (one that doesn't hold the source); all of a
 * source's bundled lines then share its spot, whatever container they go to.
 */
export function planBundles(lines: DEdge[], ctx: BundleContext): Map<string, 'from' | 'to'> {
  const groups = new Map<string, { e: DEdge; end: 'from' | 'to' }[]>();
  for (const e of lines) {
    if (e.from === e.to || !ctx.isNode(e.from) || !ctx.isNode(e.to)) continue;
    for (const [end, source, target] of [['from', e.from, e.to], ['to', e.to, e.from]] as const) {
      const c = ctx.parentOf(target);
      if (!c || ctx.within(source, c) || ctx.keep(e, end)) continue;
      // One look per bundle: the same kind of line, with the same decoration at the source.
      const key = [source, c, e.kind, e.dashed, end === 'from' ? e.tail : e.head].join('\u0000');
      const list = groups.get(key) ?? [];
      list.push({ e, end });
      groups.set(key, list);
      break;
    }
  }
  const out = new Map<string, 'from' | 'to'>();
  for (const list of groups.values()) if (list.length >= 2) for (const { e, end } of list) out.set(e.id, end);
  return out;
}

/** One end of a line as the router sees it: a node's centre pin (`pin`), or a free point. */
export interface RoutedEnd {
  e: DEdge;
  end: 'from' | 'to';
  pin?: string;
  point?: Point;
}

/**
 * Ends that share a spot with another line's end, other than bundled lines
 * sharing their source: with merging on they would run as one. Pinned ones
 * can be given ports of their own (`fixable`); two free points on one spot
 * can't (`stuck`), and then merging stays off.
 */
export function clashingEnds(ends: RoutedEnd[], bundled: Map<string, 'from' | 'to'>): { fixable: RoutedEnd[]; stuck: boolean } {
  const spots = new Map<string, RoutedEnd[]>();
  for (const r of ends) {
    const key = r.pin !== undefined ? `pin:${r.pin}` : `at:${Math.round(r.point![0] * 10)},${Math.round(r.point![1] * 10)}`;
    const list = spots.get(key) ?? [];
    list.push(r);
    spots.set(key, list);
  }
  const fixable: RoutedEnd[] = [];
  let stuck = false;
  for (const list of spots.values()) {
    if (list.length < 2) continue;
    const others = list.filter((r) => bundled.get(r.e.id) !== r.end || r.pin === undefined);
    if (!others.length) continue;
    if (others.some((r) => r.pin === undefined)) stuck = true;
    else fixable.push(...others);
  }
  return { fixable, stuck };
}

/**
 * A port where a drawn line meets its node: `end` is the line's last point
 * there, `next` the one before. The spot is kept on the side the line comes
 * in from, within its flat middle (a route can stop short of the outline).
 */
export function portAt(a: AnchorShape, box: Box, end: Point, next: Point, buffer: number): { outline: Point; route: Point } | undefined {
  const vertical = Math.abs(end[0] - next[0]) < 0.5;
  if (!vertical && Math.abs(end[1] - next[1]) >= 0.5) return undefined; // slanted
  const side: AttachSide = vertical ? (next[1] < end[1] ? 'top' : 'bottom') : next[0] < end[0] ? 'left' : 'right';
  const edge = a.shape === 'rect' ? 0.15 : 0.3;
  const along = (v: number, lo: number, len: number) => Math.min(1 - edge, Math.max(edge, (v - lo) / len));
  const [x0, y0] = [a.cx - a.w / 2, a.cy - a.h / 2];
  const at = vertical ? { x: along(end[0], x0, a.w), y: side === 'top' ? 0 : 1, side } : { x: side === 'left' ? 0 : 1, y: along(end[1], y0, a.h), side };
  const outline = attachOutline(a, at);
  const route: Point = side === 'top' ? [outline[0], box.y - buffer - 1] : side === 'bottom' ? [outline[0], box.y + box.h + buffer + 1] : side === 'left' ? [box.x - buffer - 1, outline[1]] : [box.x + box.w + buffer + 1, outline[1]];
  return { outline, route };
}

/**
 * How busy a set of drawn lines looks: bends, plus crossings counted once
 * per spot (bundled lines cross another line at one spot, and that reads as
 * one crossing however many lines the bundle holds). A crossing weighs as
 * much as three bends. Used to keep the bundled routing only where it helps.
 */
export function busyness(lines: Point[][]): number {
  let bends = 0;
  const horizontal: [number, number, number][] = [];
  const vertical: [number, number, number][] = [];
  for (const pts of lines) {
    bends += Math.max(0, pts.length - 2);
    for (let i = 1; i < pts.length; i++) {
      const [a, b] = [pts[i - 1]!, pts[i]!];
      if (Math.abs(a[1] - b[1]) < 0.5) horizontal.push([Math.min(a[0], b[0]), Math.max(a[0], b[0]), a[1]]);
      else if (Math.abs(a[0] - b[0]) < 0.5) vertical.push([Math.min(a[1], b[1]), Math.max(a[1], b[1]), a[0]]);
    }
  }
  const spots = new Set<string>();
  for (const [x0, x1, y] of horizontal) {
    for (const [y0, y1, x] of vertical) if (x > x0 + 0.5 && x < x1 - 0.5 && y > y0 + 0.5 && y < y1 - 0.5) spots.add(`${Math.round(x)},${Math.round(y)}`);
  }
  return bends + 3 * spots.size;
}
