import type { Diagram } from '../model/types.ts';
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

/** Container boxes grow to fit their children (nodes and nested containers). Empty ones are omitted. */
export function containerBoxes(diagram: Diagram, positions: Positions, shapes: Map<string, NodeShape>, pad: Pad = CONTAINER_PAD): Map<string, Box> {
  const result = new Map<string, Box>();
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
