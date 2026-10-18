import type { DNode, Diagram } from '../model/types.ts';
import type { Point } from '../layout/layout-file.ts';
import { capsBlock, LINE_HEIGHT, textWidth } from './measure.ts';
import { CONTAINER_PAD, type NodeShape, type Pad } from './shapes.ts';
import type { Theme } from './theme.ts';

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type Positions = Record<string, { x: number; y: number }>;

export function nodeBox(pos: { x: number; y: number }, shape: { w: number; h: number }): Box {
  return { x: pos.x - shape.w / 2, y: pos.y - shape.h / 2, w: shape.w, h: shape.h };
}

export function overlaps(a: Box, b: Box, margin = 0): boolean {
  return a.x < b.x + b.w + margin && b.x < a.x + a.w + margin && a.y < b.y + b.h + margin && b.y < a.y + a.h + margin;
}

/**
 * Where the source draws a node (draw.io): the centre of its file box,
 * shifted so the anchor lands there. For boxes that is the box centre; for
 * an actor the figure sits on the file box and the label hangs below, as in
 * draw.io.
 */
export function sourceCentre(node: DNode, shape: NodeShape): { x: number; y: number } | undefined {
  const b = node.sourceBox;
  if (!b) return undefined;
  return { x: b.x + b.w / 2 - shape.anchor.dx, y: b.y + b.h / 2 - shape.anchor.dy };
}

/**
 * Container boxes grow to fit their children (nodes and nested containers). Empty ones are omitted.
 * A container with a `sourceBox` (draw.io) keeps that box, moved by however
 * far its contents moved, while all of them moved by the same amount (not at
 * all, or dragged together by the title); it still grows to cover children
 * that outgrow it. Once its contents are rearranged it fits them instead.
 */
export function containerBoxes(diagram: Diagram, positions: Positions, shapes: Map<string, NodeShape>, pad: Pad = CONTAINER_PAD): Map<string, Box> {
  const result = new Map<string, Box>();
  const descendants = (id: string): DNode[] => [
    ...diagram.nodes.filter((n) => n.parent === id),
    ...diagram.containers.filter((c) => c.parent === id).flatMap((c) => descendants(c.id)),
  ];
  /** The common displacement of every descendant from where the file puts it, if there is one. */
  const commonShift = (id: string): [number, number] | undefined => {
    let shift: [number, number] | undefined;
    for (const n of descendants(id)) {
      const p = positions[n.id];
      const s = shapes.get(n.id);
      const home = s && sourceCentre(n, s);
      if (!p || !home) return undefined;
      const d: [number, number] = [p.x - home.x, p.y - home.y];
      if (!shift) shift = d;
      else if (Math.abs(d[0] - shift[0]) > 0.5 || Math.abs(d[1] - shift[1]) > 0.5) return undefined;
    }
    return shift;
  };
  const childrenOf = (id: string) => ({
    nodes: diagram.nodes.filter((n) => n.parent === id),
    containers: diagram.containers.filter((c) => c.parent === id),
  });
  const compute = (id: string): Box | undefined => {
    if (result.has(id)) return result.get(id);
    const { nodes, containers } = childrenOf(id);
    const boxes: Box[] = [];
    for (const n of nodes) {
      const p = positions[n.id];
      const s = shapes.get(n.id);
      if (p && s) boxes.push(nodeBox(p, s));
    }
    for (const c of containers) {
      const b = compute(c.id);
      if (b) boxes.push(b);
    }
    if (!boxes.length) return undefined;
    const x0 = Math.min(...boxes.map((b) => b.x));
    const y0 = Math.min(...boxes.map((b) => b.y));
    const x1 = Math.max(...boxes.map((b) => b.x + b.w));
    const y1 = Math.max(...boxes.map((b) => b.y + b.h));
    const source = diagram.containers.find((c) => c.id === id)?.sourceBox;
    const shift = source && commonShift(id);
    if (source && shift) {
      const sx = source.x + shift[0];
      const sy = source.y + shift[1];
      const box = { x: Math.min(sx, x0), y: Math.min(sy, y0), w: 0, h: 0 };
      box.w = Math.max(sx + source.w, x1) - box.x;
      box.h = Math.max(sy + source.h, y1) - box.y;
      result.set(id, box);
      return box;
    }
    const box = {
      x: x0 - pad.side,
      y: y0 - pad.top,
      w: x1 - x0 + pad.side * 2,
      h: y1 - y0 + pad.top + pad.bottom,
    };
    result.set(id, box);
    return box;
  };
  for (const c of diagram.containers) compute(c.id);
  return result;
}

/** Ids of the containers that enclose `parent`, innermost first, including `parent` itself. */
export function ancestry(diagram: Diagram, parent: string | undefined): string[] {
  const chain: string[] = [];
  let current = parent;
  while (current) {
    chain.push(current);
    current = diagram.containers.find((c) => c.id === current)?.parent;
  }
  return chain;
}

/**
 * Where a container's title text sits, mirroring `ContainerTitle` in
 * DiagramSvg: centred under the top edge, or left-aligned small caps. Lines
 * route around it and labels avoid it. Padded by a few pixels so a line
 * doesn't graze the letters.
 */
export function titleBox(kind: string, label: string, box: Box, theme: Theme): Box | undefined {
  if (!label.trim()) return undefined;
  const k = theme.scale;
  const state = kind === 'state';
  const caps = !state && theme.containerTitle === 'caps';
  const size = state ? theme.size.node : theme.size.container;
  // Caps are drawn tracked (and mono, where the theme has it); capsBlock measures both.
  const width = Math.min(box.w - 4 * k, (caps ? capsBlock(label, size, theme).width : textWidth(label, size, true, theme.widthFactor)) * 1.06);
  const height = size * LINE_HEIGHT;
  const d3 = kind === 'node' ? 8 * k : 0;
  const top = state ? box.y + 13 * k - height / 2 : box.y + (caps ? 10 * k + d3 : 6 * k);
  const left = caps ? box.x + 14 * k : box.x + box.w / 2 - width / 2;
  // The title's backing chip reaches 4 px either side and 1 px above and below.
  const mx = 5 * k;
  const my = 2 * k;
  return { x: left - mx, y: top - my, w: width + 2 * mx, h: height + 2 * my };
}

export type Side = 'top' | 'bottom' | 'left' | 'right';

/** An opening in a container's border where a line may cross it: `lo..hi` along the side. */
export interface Door {
  container: string;
  side: Side;
  lo: number;
  hi: number;
}

/** Keeps a door this far from the corners, so lines don't squeeze round them. */
const CORNER = 10;

/** The side of `box` that faces `outer` most: the one `outer` lies furthest beyond. */
export function facingSide(box: Box, outer: Point, inner: Box): Side {
  const [ox, oy] = outer;
  const beyond: [Side, number][] = [
    ['right', ox - (box.x + box.w)],
    ['left', box.x - ox],
    ['bottom', oy - (box.y + box.h)],
    ['top', box.y - oy],
  ];
  beyond.sort((a, b) => b[1] - a[1]);
  if (beyond[0]![1] > 0) return beyond[0]![0];
  // The other end overlaps the container (a hand-made overlap): leave by the side nearest the inner end.
  const near: [Side, number][] = [
    ['right', box.x + box.w - (inner.x + inner.w)],
    ['left', inner.x - box.x],
    ['bottom', box.y + box.h - (inner.y + inner.h)],
    ['top', inner.y - box.y],
  ];
  near.sort((a, b) => a[1] - b[1]);
  return near[0]![0];
}

/**
 * The door a line from `inner` (a box inside the container) to `outer` (a
 * point outside) goes through: on the facing side, straight across from the
 * inner end. Wider doors (up to straight across from the outer end) let
 * unrelated lines in through one door and out through another. Doors never
 * open under the title: the title is part of the wall. `wide` opens the
 * whole side, for a line that found no way through the narrow door.
 */
export function doorFor(container: string, box: Box, inner: Box, outer: Point, title?: Box, wide = false, blocked?: (side: Side) => boolean): Door {
  let side = facingSide(box, outer, inner);
  if (blocked?.(side)) {
    // Something inside stands between the inner end and that side: leave by another side that faces the other end, if one is clear.
    const [ox, oy] = outer;
    const beyond: [Side, number][] = [
      ['right', ox - (inner.x + inner.w)],
      ['left', inner.x - ox],
      ['bottom', oy - (inner.y + inner.h)],
      ['top', inner.y - oy],
    ];
    const other = beyond.filter(([s, d]) => s !== side && d > 0 && !blocked(s)).sort((a, b) => b[1] - a[1])[0];
    if (other) side = other[0];
  }
  const vertical = side === 'top' || side === 'bottom';
  const min = (vertical ? box.x : box.y) + CORNER;
  const max = (vertical ? box.x + box.w : box.y + box.h) - CORNER;
  const clamp = (v: number) => Math.min(max, Math.max(min, v));
  const o = clamp(vertical ? outer[0] : outer[1]);
  let lo = wide ? min : clamp((vertical ? inner.x : inner.y) - 4);
  let hi = wide ? max : clamp((vertical ? inner.x + inner.w : inner.y + inner.h) + 4);
  if (side === 'top' && title && hi > title.x && lo < title.x + title.w) {
    // Keep the larger part beside the title; with none left, open right next to it, on the side towards the line.
    const left: [number, number] = [lo, Math.min(hi, title.x - 6)];
    const right: [number, number] = [Math.max(lo, title.x + title.w + 6), hi];
    const best = left[1] - left[0] >= right[1] - right[0] ? left : right;
    if (best[1] - best[0] >= 16) [lo, hi] = best;
    else if (o < title.x + title.w / 2 && title.x - 34 >= min) [lo, hi] = [title.x - 34, title.x - 6];
    else [lo, hi] = [title.x + title.w + 6, Math.min(max, title.x + title.w + 34)];
  }
  return { container, side, lo, hi };
}

/**
 * A container's border as obstacles, with gaps at its doors and wherever an
 * element already blocks the border (overlapping obstacles confuse
 * libavoid). Lines without a door can't cross it, so a line between two
 * outside elements goes round the container instead of through it.
 *
 * The band reaches `outer` outside the border and `inner` inside (`top`
 * inside along the top, where the title sits): thick enough inside that a
 * line can't run along the border, where it would read as part of it.
 */
export function wallsFor(box: Box, doors: Door[], blockers: Box[], band: { outer: number; inner: number; top: number }): Box[] {
  const { outer, inner, top } = band;
  const walls: Box[] = [];
  // [side, near edge of the band, far edge, from, to]: top and bottom run the full width, the sides between them.
  const sides: [Side, number, number, number, number][] = [
    ['top', box.y - outer, box.y + top, box.x - outer, box.x + box.w + outer],
    ['bottom', box.y + box.h - inner, box.y + box.h + outer, box.x - outer, box.x + box.w + outer],
    ['left', box.x - outer, box.x + inner, box.y + top, box.y + box.h - inner],
    ['right', box.x + box.w - inner, box.x + box.w + outer, box.y + top, box.y + box.h - inner],
  ];
  for (const [side, near, far, from, to] of sides) {
    const vertical = side === 'top' || side === 'bottom';
    const gaps: [number, number][] = doors.filter((d) => d.side === side).map((d) => [d.lo, d.hi]);
    const strip: Box = vertical ? { x: from, y: near, w: to - from, h: far - near } : { x: near, y: from, w: far - near, h: to - from };
    for (const b of blockers) {
      if (overlaps(strip, b)) gaps.push(vertical ? [b.x, b.x + b.w] : [b.y, b.y + b.h]);
    }
    gaps.sort((a, b) => a[0] - b[0]);
    let cursor = from;
    const pieces: [number, number][] = [];
    for (const [lo, hi] of gaps) {
      if (lo > cursor) pieces.push([cursor, lo]);
      cursor = Math.max(cursor, hi);
    }
    if (cursor < to) pieces.push([cursor, to]);
    for (const [lo, hi] of pieces) {
      if (hi - lo < 12) continue;
      walls.push(vertical ? { x: lo, y: near, w: hi - lo, h: far - near } : { x: near, y: lo, w: far - near, h: hi - lo });
    }
  }
  return walls;
}
