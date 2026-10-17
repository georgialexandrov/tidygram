import type { ElkExtendedEdge, ElkNode } from 'elkjs/lib/elk.bundled.js';
import { elk } from './elk.ts';
import type { DNode, Diagram } from '../model/types.ts';
import { ancestry, containerBoxes, nodeBox, overlaps, sourceCentre, type Box, type Positions } from '../scene/containers.ts';
import { containerPad, nodeShape, type NodeShape, type Pad } from '../scene/shapes.ts';
import { measureText } from '../scene/measure.ts';
import { themeFor, themeOf, type Theme } from '../scene/theme.ts';
import { emptyLayout, type LayoutFile } from './layout-file.ts';
import { loadedAvoid } from '../scene/avoid.ts';
import { pathLength } from '../scene/geometry.ts';
import { countCrossings, measureQuality } from '../scene/quality.ts';
import { buildScene } from '../scene/scene.ts';
import { refreshTemplate, relayoutTemplate } from './template/index.ts';

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

/**
 * Swimlanes are columns, not boxes: lay the flow out as if they weren't
 * there (so rows follow the flow), then slide each lane's nodes into its own
 * column, keeping their order and spacing within the lane.
 */
async function laneLayout(diagram: Diagram, shapes: Map<string, NodeShape>, theme: Theme, variant: ElkVariant | undefined): Promise<Positions> {
  const lanes = diagram.containers.filter((c) => c.kind === 'swimlane');
  const laneOf = new Map(diagram.nodes.map((n) => [n.id, n.parent && lanes.some((l) => l.id === n.parent) ? n.parent : lanes[0]!.id]));
  const flat: Diagram = {
    ...diagram,
    containers: diagram.containers.filter((c) => c.kind !== 'swimlane').map((c) => (lanes.some((l) => l.id === c.parent) ? { ...c, parent: undefined } : c)),
    nodes: diagram.nodes.map((n) => (lanes.some((l) => l.id === n.parent) ? { ...n, parent: undefined } : n)),
  };
  const raw = await elkPositions(flat, shapes, theme, variant ?? { direction: 'DOWN', hierarchy: 'include' });
  const gap = 40 * theme.scale;
  let cursor = 0;
  const out: Positions = {};
  for (const lane of lanes) {
    const members = diagram.nodes.filter((n) => laneOf.get(n.id) === lane.id && raw[n.id]);
    if (!members.length) continue;
    const left = Math.min(...members.map((n) => raw[n.id]!.x - shapes.get(n.id)!.w / 2));
    const right = Math.max(...members.map((n) => raw[n.id]!.x + shapes.get(n.id)!.w / 2));
    for (const n of members) out[n.id] = { x: cursor + (raw[n.id]!.x - left), y: raw[n.id]!.y };
    cursor += right - left + gap * 2;
  }
  return out;
}

/** Full automatic layout with ELK's layered algorithm, containers as compound nodes. */
export async function elkPositions(
  diagram: Diagram,
  shapes: Map<string, NodeShape>,
  theme: Theme = themeFor(undefined),
  variant: ElkVariant = { direction: diagram.direction === 'LR' ? 'RIGHT' : 'DOWN', hierarchy: 'include' },
): Promise<Positions> {
  if (diagram.containers.some((c) => c.kind === 'swimlane')) return laneLayout(diagram, shapes, theme, variant.direction === 'DOWN' ? variant : undefined);
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
      // Also how unconnected parts are packed: side by side up to this ratio, not stacked.
      'elk.aspectRatio': String(variant.aspectRatio ?? 1.6),
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

  const ref = (id: string) => (elkNodes.has(`n:${id}`) ? `n:${id}` : elkNodes.has(`c:${id}`) ? `c:${id}` : undefined);
  const containerEdges: ElkExtendedEdge[] = [];
  diagram.edges.forEach((e, i) => {
    if (e.from === e.to) return;
    // Layout follows the order the source wrote: `A <|-- B` puts A first (above or left), like PlantUML.
    const [first, second] = e.reversed ? [e.to, e.from] : [e.from, e.to];
    const source = ref(first);
    const target = ref(second);
    if (!source || !target) return;
    const edge: ElkExtendedEdge = { id: `e${i}`, sources: [source], targets: [target] };
    if (e.label) {
      const t = measureText(e.label, theme.size.edge, false, theme.widthFactor);
      edge.labels = [{ text: e.label, width: t.width, height: t.height }];
    }
    (source.startsWith('c:') || target.startsWith('c:') ? containerEdges : root.edges!).push(edge);
  });

  // Lines to a container (a composite state, a boundary) help placement, but ELK rejects some
  // of them (e.g. a container linked to its own child); fall back to laying out without them.
  let result: ElkNode;
  try {
    result = await elk().layout({ ...root, edges: [...root.edges!, ...containerEdges] });
  } catch {
    result = await elk().layout(root);
  }
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

/** The proportions auto layout aims for: a 16:9 window. */
const TARGET = { max: 16 / 9 };

/**
 * Default auto layout. ELK's layered layout in the source's direction tends
 * to one long column (state machines, component stacks) or one long row,
 * which a 16:9 window shows at a fraction of its size. So a few variants are
 * laid out (both directions unless the source fixes one; ELK's graph
 * wrapping; containers in the cross direction) and the one that fits a
 * 4:3–16:9 frame at the largest size wins, with crossings and a change of
 * direction, and long lines counted against it. `left to right direction` (and any explicit
 * Mermaid direction) keeps its direction; only wrapping may reshape it.
 */
export async function autoPositions(diagram: Diagram, shapes: Map<string, NodeShape>, theme: Theme, view?: LayoutFile['view']): Promise<Positions> {
  const own: ElkVariant = { direction: diagram.direction === 'LR' ? 'RIGHT' : 'DOWN', hierarchy: 'include' };
  // Swimlanes are columns by definition; nwdiag reads top-down, network bars across with hosts hanging off them.
  if (diagram.containers.some((c) => c.kind === 'swimlane') || diagram.nodes.some((n) => n.kind === 'network') || diagram.nodes.length < 2) return elkPositions(diagram, shapes, theme, own);
  const fixed = diagram.direction === 'LR' || diagram.directionFixed === true;
  const parentOf = (id: string) => diagram.nodes.find((n) => n.id === id)?.parent ?? diagram.containers.find((c) => c.id === id)?.parent ?? id;
  const directions: ElkVariant['direction'][] = fixed ? [own.direction] : [own.direction, own.direction === 'DOWN' ? 'RIGHT' : 'DOWN'];
  const variants: { variant: ElkVariant; cost: number }[] = [];
  for (const direction of directions) {
    const turn = direction === own.direction ? 1 : 0.9;
    variants.push({ variant: { direction, hierarchy: 'include' }, cost: turn });
    variants.push({ variant: { direction, hierarchy: 'include', wrapping: true, aspectRatio: 1.6 }, cost: turn * 0.7 });
    // Containers in the cross direction reshape a lot, but read against a direction the source asked for.
    if (diagram.containers.length && !fixed) {
      // Laid out container by container, ELK ignores lines that leave a container: the more of those, the worse it places their ends.
      const across = diagram.edges.filter((e) => parentOf(e.from) !== parentOf(e.to)).length / Math.max(1, diagram.edges.length);
      variants.push({ variant: { direction, hierarchy: 'separate', innerDirection: direction === 'DOWN' ? 'RIGHT' : 'DOWN' }, cost: (turn * 0.9) / (1 + across) });
    }
  }
  const results = await Promise.all(variants.map(async ({ variant, cost }) => ({ variant, cost, positions: await elkPositions(diagram, shapes, theme, variant).catch(() => undefined) })));
  const debug = typeof process !== 'undefined' && process.env?.AUTO_DEBUG;
  const scored = results
    .filter((r): r is typeof r & { positions: Positions } => !!r.positions && diagram.nodes.every((n) => r.positions![n.id]))
    .map((r) => ({ ...r, score: proportionScore(diagram, r.positions, shapes, theme) * r.cost }))
    .sort((a, b) => b.score - a.score);
  // Straight lines between centres flatter layouts whose real lines snake (wrapped rows, lines out of
  // containers laid out on their own): route the front runners and judge them on the real thing.
  const avoid = loadedAvoid();
  if (avoid && scored.length > 1) {
    let best = scored[0]!;
    let bestScore = -Infinity;
    for (const c of scored.slice(0, 4)) {
      const trial: LayoutFile = { ...emptyLayout(), view, nodes: Object.fromEntries(Object.entries(c.positions).map(([id, p]) => [id, { x: p.x, y: p.y }])) };
      const scene = buildScene(diagram, trial, avoid);
      const q = measureQuality(scene, diagram);
      const lines = Math.max(1, scene.edges.length);
      const frame = Math.max(scene.bounds.w / TARGET.max, scene.bounds.h);
      const aspect = scene.bounds.w / Math.max(1, scene.bounds.h);
      const off = Math.abs(Math.log(aspect / Math.min(2, Math.max(4 / 3, aspect))));
      const crossings = countCrossings(scene.edges.map((e) => e.points));
      const length = scene.edges.reduce((sum, e) => sum + pathLength(e.points), 0) / lines / frame;
      const faults = q.nodeCrossings + q.containerCrossings + q.titleCrossings + q.labelOverlaps;
      const score = (c.cost * 1000) / frame / (1 + (4 * crossings) / lines) / (1 + (0.15 * q.bends) / lines) / (1 + length) / (1 + off) / (1 + (0.5 * faults) / lines);
      if (debug) console.log(JSON.stringify(c.variant), `proxy ${c.score.toFixed(3)} routed ${score.toFixed(3)} frame ${Math.round(frame)} x ${crossings} bends ${q.bends} len ${length.toFixed(2)} aspect ${aspect.toFixed(2)}`);
      if (score > bestScore) [best, bestScore] = [c, score];
    }
    return best.positions;
  }
  if (debug) for (const c of scored) console.log(JSON.stringify(c.variant), c.score.toFixed(3));
  return scored[0]?.positions ?? elkPositions(diagram, shapes, theme, own);
}

/**
 * How large the layout can be drawn in a frame of the target proportions
 * (relative: 1 / the frame size it needs), discounted for crossings of
 * straight centre-to-centre lines (a cheap stand-in for routed ones).
 */
function proportionScore(diagram: Diagram, positions: Positions, shapes: Map<string, NodeShape>, theme: Theme): number {
  const boxes = diagram.nodes.map((n) => nodeBox(positions[n.id]!, shapes.get(n.id)!));
  boxes.push(...containerBoxes(diagram, positions, shapes, containerPad(theme)).values());
  const w = Math.max(...boxes.map((b) => b.x + b.w)) - Math.min(...boxes.map((b) => b.x));
  const h = Math.max(...boxes.map((b) => b.y + b.h)) - Math.min(...boxes.map((b) => b.y));
  // The height of the 16:9 window that holds the layout: the smaller, the larger it is drawn.
  const frame = Math.max(w / TARGET.max, h);
  const segments: [{ x: number; y: number }, { x: number; y: number }, string, string][] = diagram.edges
    .filter((e) => e.from !== e.to && positions[e.from] && positions[e.to])
    .map((e) => [positions[e.from]!, positions[e.to]!, e.from, e.to]);
  let crossings = 0;
  const orient = (a: { x: number; y: number }, b: { x: number; y: number }, c: { x: number; y: number }) => Math.sign((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x));
  for (let i = 0; i < segments.length; i++) {
    const [a, b, ea, eb] = segments[i]!;
    for (let j = i + 1; j < segments.length; j++) {
      const [c, d, ec, ed] = segments[j]!;
      if (ea === ec || ea === ed || eb === ec || eb === ed) continue;
      if (orient(a, b, c) * orient(a, b, d) < 0 && orient(c, d, a) * orient(c, d, b) < 0) crossings++;
    }
  }
  // Long lines (relative to the frame) are what a layout that ignores lines across containers produces.
  const length = segments.reduce((sum, [a, b]) => sum + Math.abs(a.x - b.x) + Math.abs(a.y - b.y), 0) / Math.max(1, segments.length) / frame;
  // Outside 4:3–2:1 the window shows a strip: count the distance from that band too.
  const aspect = w / Math.max(1, h);
  const off = Math.abs(Math.log(aspect / Math.min(2, Math.max(4 / 3, aspect))));
  return 1000 / frame / (1 + (1.5 * crossings) / Math.max(1, segments.length)) / (1 + length) / (1 + 0.5 * off);
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
  /** Keep every stored position, place only new nodes (draw.io: where the file draws them). */
  | 'fill'
  /** Re-run auto layout for everything except pinned nodes. */
  | 'auto'
  /** Discard the stored layout and start over (draw.io: from the file's layout, not ELK). */
  | 'reset';

/** True when the source carries its own layout (draw.io), which then replaces ELK as the starting point. */
export function hasSourceLayout(diagram: Diagram): boolean {
  return diagram.nodes.some((n) => n.sourceBox);
}

/**
 * Seeds positions from the file (draw.io): every node in `ids` that has a
 * source box goes where the file draws it. Lines whose ends are all new get
 * the file's waypoints; a line between nodes that were already placed keeps
 * whatever the sidecar says, so straightening one sticks across reloads.
 */
function seedFromSource(diagram: Diagram, next: LayoutFile, shapes: Map<string, NodeShape>, pad: Pad, ids: Set<string>, firstTime: boolean) {
  const positions: Positions = Object.fromEntries(diagram.nodes.filter((n) => next.nodes[n.id]).map((n) => [n.id, next.nodes[n.id]!]));
  const seeded = new Set<string>();
  for (const n of diagram.nodes) {
    if (!ids.has(n.id)) continue;
    const home = sourceCentre(n, shapes.get(n.id)!);
    if (!home) continue;
    positions[n.id] = home;
    seeded.add(n.id);
  }
  const placed = placeMissing(diagram, positions, shapes, pad);
  for (const n of diagram.nodes) if (!next.nodes[n.id]) next.nodes[n.id] = { x: placed[n.id]!.x, y: placed[n.id]!.y };
  // Containers have no entries of their own: their ends count as new only on the first layout.
  const fresh = (id: string) => seeded.has(id) || (firstTime && diagram.containers.some((c) => c.id === id));
  for (const e of diagram.edges) {
    if (e.sourceVia && !next.edges[e.id] && fresh(e.from) && fresh(e.to)) next.edges[e.id] = { via: e.sourceVia.map(([x, y]) => [x, y]) };
  }
}

export async function ensureLayout(diagram: Diagram, layout: LayoutFile, mode: LayoutMode = 'fill'): Promise<LayoutFile> {
  // Ordered diagrams (sequence, ...) compute their layout on every build; only dragged columns are stored.
  if (diagram.special) return mode === 'fill' ? layout : { ...layout, nodes: {}, edges: {} };
  // A template owns the arrangement: new elements go into their layer, Auto re-places; Reset drops the template too.
  if (layout.template) {
    if (mode === 'fill') return refreshTemplate(diagram, layout);
    if (mode === 'auto') return relayoutTemplate(diagram, layout);
    const { template: _template, ...rest } = layout;
    layout = rest;
  }
  const theme = themeOf(layout.view);
  const shapes = shapesFor(diagram, theme);
  const pad = containerPad(theme);
  const known = diagram.nodes.filter((n) => layout.nodes[n.id]);
  const next: LayoutFile = { ...layout, nodes: { ...layout.nodes }, edges: { ...layout.edges } };

  if (hasSourceLayout(diagram) && mode !== 'auto') {
    if (mode === 'reset') {
      next.nodes = {};
      next.edges = {};
    }
    const missing = new Set(diagram.nodes.filter((n) => !next.nodes[n.id]).map((n) => n.id));
    seedFromSource(diagram, next, shapes, pad, missing, mode === 'reset' || known.length === 0);
    return next;
  }

  if (mode === 'fill' && known.length > 0) {
    const current: Positions = Object.fromEntries(known.map((n) => [n.id, layout.nodes[n.id]!]));
    const placed = placeMissing(diagram, current, shapes, pad);
    for (const n of diagram.nodes) if (!next.nodes[n.id]) next.nodes[n.id] = { x: placed[n.id]!.x, y: placed[n.id]!.y };
    return next;
  }

  const auto = await autoPositions(diagram, shapes, theme, layout.view);
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
