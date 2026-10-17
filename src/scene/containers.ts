import type { DNode, Diagram } from '../model/types.ts';
import { CONTAINER_PAD, type NodeShape, type Pad } from './shapes.ts';

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
