import type { ElkExtendedEdge, ElkNode } from 'elkjs/lib/elk.bundled.js';
import { elk } from './elk.ts';
import type { DNode, Diagram } from '../model/types.ts';
import { ancestry, containerBoxes, nodeBox, overlaps, type Box, type Positions } from '../scene/containers.ts';
import { containerPad, nodeShape, type NodeShape, type Pad } from '../scene/shapes.ts';
import { measureText } from '../scene/measure.ts';
import { themeFor, themeOf, type Theme } from '../scene/theme.ts';
import type { LayoutFile } from './layout-file.ts';

const GAP = 24;

// Wider than twice the router's shape buffer, or libavoid has no corridor between neighbours.
const SPACING = {
  'elk.spacing.nodeNode': '32',
  'elk.layered.spacing.nodeNodeBetweenLayers': '70',
  'elk.spacing.edgeNode': '16',
};

export function shapesFor(diagram: Diagram, theme: Theme = themeFor(undefined)): Map<string, NodeShape> {
  return new Map(diagram.nodes.map((n) => [n.id, nodeShape(n, theme)]));
}

export interface ElkVariant {
  direction: 'RIGHT' | 'DOWN';
  /** `separate` lays out each container on its own, so containers can run in another direction than the whole. */
  hierarchy: 'include' | 'separate';
  innerDirection?: 'RIGHT' | 'DOWN';
  /** ELK's graph wrapping: cuts a long layered graph into rows/columns to approach `aspectRatio`. */
  wrapping?: boolean;
  aspectRatio?: number;
  /** Gap between elements in the same layer, and between layers. */
  spacing?: { node: number; layer: number };
}

/** Full automatic layout with ELK's layered algorithm, containers as compound nodes. */
export async function elkPositions(
  diagram: Diagram,
  shapes: Map<string, NodeShape>,
  theme: Theme = themeFor(undefined),
  variant: ElkVariant = { direction: diagram.direction === 'LR' ? 'RIGHT' : 'DOWN', hierarchy: 'include' },
): Promise<Positions> {
  const elkNodes = new Map<string, ElkNode>();
  const spacing: Record<string, string> = variant.spacing
    ? { ...SPACING, 'elk.spacing.nodeNode': String(variant.spacing.node), 'elk.layered.spacing.nodeNodeBetweenLayers': String(variant.spacing.layer) }
    : SPACING;
  const wrapping: Record<string, string> = variant.wrapping
    ? { 'elk.layered.wrapping.strategy': 'MULTI_EDGE', 'elk.aspectRatio': String(variant.aspectRatio ?? 1.6) }
    : {};
  const root: ElkNode = {
    id: 'root',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': variant.direction,
      'elk.hierarchyHandling': variant.hierarchy === 'include' ? 'INCLUDE_CHILDREN' : 'SEPARATE_CHILDREN',
      'elk.edgeRouting': 'ORTHOGONAL',
      ...spacing,
      ...wrapping,
      'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
      'elk.edgeLabels.placement': 'CENTER',
      ...(variant.aspectRatio ? { 'elk.aspectRatio': String(variant.aspectRatio) } : {}),
    },
    children: [],
    edges: [],
  };
  const inner: Record<string, string> =
    variant.hierarchy === 'separate'
      ? { 'elk.algorithm': 'layered', 'elk.direction': variant.innerDirection ?? variant.direction }
      : {};
  for (const c of diagram.containers) {
    elkNodes.set(`c:${c.id}`, {
      id: `c:${c.id}`,
      // Spacing must be set per compound node; the root's options don't reach inside.
      layoutOptions: { 'elk.padding': `[top=${44 * theme.scale},left=${24 * theme.scale},bottom=${24 * theme.scale},right=${24 * theme.scale}]`, ...spacing, ...inner },
      children: [],
      width: 120,
      height: 60,
    });
  }
  for (const n of diagram.nodes) {
    const s = shapes.get(n.id)!;
    elkNodes.set(`n:${n.id}`, { id: `n:${n.id}`, width: s.w, height: s.h });
  }
  const parentOf = (parent: string | undefined) => (parent && elkNodes.get(`c:${parent}`)) || root;
  for (const c of diagram.containers) parentOf(c.parent).children!.push(elkNodes.get(`c:${c.id}`)!);
  for (const n of diagram.nodes) parentOf(n.parent).children!.push(elkNodes.get(`n:${n.id}`)!);

  diagram.edges.forEach((e, i) => {
    if (e.from === e.to) return;
    const edge: ElkExtendedEdge = { id: `e${i}`, sources: [`n:${e.from}`], targets: [`n:${e.to}`] };
    if (e.label) {
      const t = measureText(e.label, theme.size.edge, false, theme.widthFactor);
      edge.labels = [{ text: e.label, width: t.width, height: t.height }];
    }
    root.edges!.push(edge);
  });

  const result = await elk().layout(root);
  const positions: Positions = {};
  const walk = (node: ElkNode, ox: number, oy: number) => {
    for (const child of node.children ?? []) {
      const x = ox + (child.x ?? 0);
      const y = oy + (child.y ?? 0);
      if (child.id.startsWith('n:')) {
        positions[child.id.slice(2)] = { x: x + (child.width ?? 0) / 2, y: y + (child.height ?? 0) / 2 };
      }
      walk(child, x, y);
    }
  };
  walk(result, 0, 0);
  return positions;
}

/**
 * Boxes a node at `parent` must not overlap: every placed node, plus every
 * container that is not one of its own ancestors.
 */
function obstaclesFor(diagram: Diagram, node: DNode, positions: Positions, shapes: Map<string, NodeShape>, pad: Pad): Box[] {
  const boxes: Box[] = [];
  for (const [id, p] of Object.entries(positions)) {
    if (id === node.id) continue;
    const s = shapes.get(id);
    if (s) boxes.push(nodeBox(p, s));
  }
  const own = new Set(ancestry(diagram, node.parent));
  for (const [id, box] of containerBoxes(diagram, positions, shapes, pad)) if (!own.has(id)) boxes.push(box);
  return boxes;
}

/** Nearest spot to `start` (spiral search) where the node fits without overlaps. */
function freeSpot(start: { x: number; y: number }, shape: NodeShape, obstacles: Box[]): { x: number; y: number } {
  const fits = (p: { x: number; y: number }) => !obstacles.some((o) => overlaps(nodeBox(p, shape), o, GAP));
  if (fits(start)) return start;
  for (let ring = 1; ring < 200; ring++) {
    const radius = ring * 20;
    const steps = 8 * ring;
    for (let k = 0; k < steps; k++) {
      const a = (k / steps) * Math.PI * 2;
      const p = { x: start.x + Math.cos(a) * radius, y: start.y + Math.sin(a) * radius };
      if (fits(p)) return p;
    }
  }
  return start;
}

/** Initial guess for a node without a stored position: next to whatever it connects to. */
function seedPosition(diagram: Diagram, node: DNode, positions: Positions, shapes: Map<string, NodeShape>) {
  const shape = shapes.get(node.id)!;
  if (node.attachedTo && positions[node.attachedTo.id]) {
    const t = positions[node.attachedTo.id]!;
    const ts = shapes.get(node.attachedTo.id)!;
    const dx = (ts.w + shape.w) / 2 + GAP;
    const dy = (ts.h + shape.h) / 2 + GAP;
    const offsets = { right: [dx, 0], left: [-dx, 0], top: [0, -dy], bottom: [0, dy] } as const;
    const [ox, oy] = offsets[node.attachedTo.side];
    return { x: t.x + ox, y: t.y + oy };
  }
  const neighbours = diagram.edges
    .flatMap((e) => (e.from === node.id ? [e.to] : e.to === node.id ? [e.from] : []))
    .map((id) => positions[id])
    .filter((p) => p !== undefined);
  const siblings = diagram.nodes.filter((n) => n.parent === node.parent && n.id !== node.id).map((n) => positions[n.id]).filter((p) => p !== undefined);
  const pool = neighbours.length ? neighbours : siblings;
  if (pool.length) {
    return { x: pool.reduce((s, p) => s + p.x, 0) / pool.length, y: pool.reduce((s, p) => s + p.y, 0) / pool.length };
  }
  const all = Object.values(positions);
  if (!all.length) return { x: 0, y: 0 };
  return { x: Math.max(...all.map((p) => p.x)) + 160, y: Math.min(...all.map((p) => p.y)) };
}

/** Places nodes missing from `positions`, most-connected first, without moving anything already placed. */
export function placeMissing(diagram: Diagram, positions: Positions, shapes: Map<string, NodeShape>, pad: Pad): Positions {
  const result: Positions = { ...positions };
  const missing = diagram.nodes.filter((n) => !result[n.id]);
  const placedNeighbours = (n: DNode) =>
    diagram.edges.filter((e) => (e.from === n.id && result[e.to]) || (e.to === n.id && result[e.from])).length + (n.attachedTo && result[n.attachedTo.id] ? 10 : 0);
  while (missing.length) {
    missing.sort((a, b) => placedNeighbours(b) - placedNeighbours(a));
    const node = missing.shift()!;
    const seed = seedPosition(diagram, node, result, shapes);
    result[node.id] = freeSpot(seed, shapes.get(node.id)!, obstaclesFor(diagram, node, result, shapes, pad));
  }
  return result;
}

export type LayoutMode =
  /** Keep every stored position, place only new nodes. */
  | 'fill'
  /** Re-run auto layout for everything except pinned nodes. */
  | 'auto'
  /** Discard the stored layout and start over. */
  | 'reset';

export async function ensureLayout(diagram: Diagram, layout: LayoutFile, mode: LayoutMode = 'fill'): Promise<LayoutFile> {
  const theme = themeOf(layout.view);
  const shapes = shapesFor(diagram, theme);
  const pad = containerPad(theme);
  const known = diagram.nodes.filter((n) => layout.nodes[n.id]);
  const next: LayoutFile = { ...layout, nodes: { ...layout.nodes }, edges: { ...layout.edges } };

  if (mode === 'fill' && known.length > 0) {
    const current: Positions = Object.fromEntries(known.map((n) => [n.id, layout.nodes[n.id]!]));
    const placed = placeMissing(diagram, current, shapes, pad);
    for (const n of diagram.nodes) if (!next.nodes[n.id]) next.nodes[n.id] = { x: placed[n.id]!.x, y: placed[n.id]!.y };
    return next;
  }

  const auto = await elkPositions(diagram, shapes, theme);
  const pinned = mode === 'auto' ? known.filter((n) => layout.nodes[n.id]!.pinned) : [];

  // Entries for ids no longer in the source survive (a rename can be undone) unless resetting.
  const orphans = mode === 'reset' ? {} : Object.fromEntries(Object.entries(layout.nodes).filter(([id]) => !shapes.has(id)));

  if (!pinned.length) {
    next.nodes = { ...orphans, ...Object.fromEntries(Object.entries(auto).map(([id, p]) => [id, { x: p.x, y: p.y }])) };
    next.edges = {};
    return next;
  }

  // Shift the ELK result so it lines up with the pinned nodes, then fit the rest around them.
  const dx = pinned.reduce((s, n) => s + layout.nodes[n.id]!.x - auto[n.id]!.x, 0) / pinned.length;
  const dy = pinned.reduce((s, n) => s + layout.nodes[n.id]!.y - auto[n.id]!.y, 0) / pinned.length;
  const fixed: Positions = Object.fromEntries(pinned.map((n) => [n.id, layout.nodes[n.id]!]));
  const free = diagram.nodes
    .filter((n) => !fixed[n.id])
    .sort((a, b) => auto[a.id]!.x - auto[b.id]!.x || auto[a.id]!.y - auto[b.id]!.y);
  const positions: Positions = { ...fixed };
  for (const n of free) {
    const seed = { x: auto[n.id]!.x + dx, y: auto[n.id]!.y + dy };
    positions[n.id] = freeSpot(seed, shapes.get(n.id)!, obstaclesFor(diagram, n, positions, shapes, pad));
  }
  next.nodes = {
    ...orphans,
    ...Object.fromEntries(diagram.nodes.map((n) => [n.id, fixed[n.id] ? layout.nodes[n.id]! : { x: positions[n.id]!.x, y: positions[n.id]!.y }])),
  };
  // Manual routing only survives between nodes that did not move.
  next.edges = Object.fromEntries(
    diagram.edges.filter((e) => fixed[e.from] && fixed[e.to] && layout.edges[e.id]).map((e) => [e.id, layout.edges[e.id]!]),
  );
  return next;
}
