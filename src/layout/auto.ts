import type { ElkExtendedEdge, ElkNode } from 'elkjs/lib/elk.bundled.js';
import { elk } from './elk.ts';
import type { DNode, Diagram } from '../model/types.ts';
import { ancestry, containerBoxes, nodeBox, overlaps, sourceCentre, type Box, type Positions } from '../scene/containers.ts';
import { containerPad, nodeShape, uprightBar, type NodeShape, type Pad } from '../scene/shapes.ts';
import { measureSecondary } from '../scene/measure.ts';
import { themeFor, themeOf, type Theme } from '../scene/theme.ts';
import { chosenEnds, emptyLayout, sideOfFraction, type EdgeLayout, type LayoutFile } from './layout-file.ts';
import { loadedAvoid } from '../scene/avoid.ts';
import { pathLength } from '../scene/geometry.ts';
import { countCrossings, measureQuality } from '../scene/quality.ts';
import { buildScene } from '../scene/scene.ts';
import { isTreeDiagram, treePositions } from './tree.ts';
import { refreshTemplate, relayoutTemplate } from './template/index.ts';
import { isUseCaseDiagram, useCaseLayouts } from './usecase.ts';

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
  /** Node placement by network simplex: lines between layers straighter, at times a wider layout. */
  straight?: boolean;
  /** Not ELK: the use-case layout with these grid shapes (for debugging output only). */
  usecase?: string;
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
    ? {
        'elk.layered.wrapping.strategy': 'MULTI_EDGE',
        'elk.aspectRatio': String(variant.aspectRatio ?? 1.6),
      }
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
      ...(variant.straight ? { 'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX' } : {}),
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
  // State diagrams: notes `left of` / `right of` (`top`/`bottom`) a state ride along with it. ELK sees the
  // state widened by the note, so the room beside it is kept, and the note is put there afterwards (as a
  // node of its own, ELK files it a layer away). Elsewhere a note is a free element and ELK places it.
  const riders = new Map<string, DNode[]>();
  for (const n of diagram.family === 'state' ? diagram.nodes : []) {
    const t = n.kind === 'note' && n.attachedTo ? diagram.nodes.find((x) => x.id === n.attachedTo!.id) : undefined;
    if (t && t.parent === n.parent && t.kind !== 'note') riders.set(t.id, [...(riders.get(t.id) ?? []), n]);
  }
  const riding = new Set([...riders.values()].flat().map((n) => n.id));
  // `note right of` means "beside the flow" in the source's top-down reading. When auto layout turns a
  // top-down source left to right, the right side is where the next state is (the note would sit in its
  // line's way): the layout is transposed, and so are the notes' sides.
  const transposed = variant.direction === 'RIGHT' && diagram.direction !== 'LR';
  const TRANSPOSE = { right: 'bottom', left: 'top', top: 'left', bottom: 'right' } as const;
  const sideOf = (n: DNode) => (transposed ? TRANSPOSE[n.attachedTo!.side] : n.attachedTo!.side);
  const extra = new Map<string, { left: number; right: number; top: number; bottom: number }>();
  for (const [id, notes] of riders) {
    const e = { left: 0, right: 0, top: 0, bottom: 0 };
    for (const n of notes) {
      const s = shapes.get(n.id)!;
      const side = sideOf(n);
      if (side === 'left' || side === 'right') e[side] = Math.max(e[side], s.w + GAP);
      else e[side] = Math.max(e[side], s.h + GAP);
    }
    extra.set(id, e);
  }
  // Fork/join bars stand upright in a left-to-right flow (the scene orients them the same way: `orientBars`).
  const flowOf = (n: DNode) => (variant.hierarchy === 'separate' && n.parent ? (variant.innerDirection ?? variant.direction) : variant.direction);
  for (const n of diagram.nodes) {
    if (riding.has(n.id)) continue;
    const s = n.kind === 'fork' && flowOf(n) === 'RIGHT' ? uprightBar(shapes.get(n.id)!) : shapes.get(n.id)!;
    const e = extra.get(n.id);
    elkNodes.set(`n:${n.id}`, { id: `n:${n.id}`, width: s.w + (e ? e.left + e.right : 0), height: s.h + (e ? e.top + e.bottom : 0) });
  }
  const parentOf = (parent: string | undefined) => (parent && elkNodes.get(`c:${parent}`)) || root;
  for (const c of diagram.containers) parentOf(c.parent).children!.push(elkNodes.get(`c:${c.id}`)!);
  for (const n of diagram.nodes) if (!riding.has(n.id)) parentOf(n.parent).children!.push(elkNodes.get(`n:${n.id}`)!);

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
      const t = measureSecondary(e.label, theme.size.edge, theme);
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
        const id = child.id.slice(2);
        const e = extra.get(id);
        if (!e) {
          positions[id] = { x: x + (child.width ?? 0) / 2, y: y + (child.height ?? 0) / 2 };
        } else {
          // The element in its part of the widened box, each note beside it on its side.
          const s = shapes.get(id)!;
          const c = { x: x + e.left + s.w / 2, y: y + e.top + s.h / 2 };
          positions[id] = c;
          for (const n of riders.get(id)!) {
            const ns = shapes.get(n.id)!;
            const side = sideOf(n);
            positions[n.id] =
              side === 'right' ? { x: c.x + s.w / 2 + GAP + ns.w / 2, y: c.y }
              : side === 'left' ? { x: c.x - s.w / 2 - GAP - ns.w / 2, y: c.y }
              : side === 'top' ? { x: c.x, y: c.y - s.h / 2 - GAP - ns.h / 2 }
              : { x: c.x, y: c.y + s.h / 2 + GAP + ns.h / 2 };
          }
        }
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
  if (isTreeDiagram(diagram)) return treePositions(diagram, shapes, theme);
  // draw.io lanes (titled `swimlane` containers side by side at the top level) are laid out as swimlane
  // columns; as ordinary containers ELK strings them out in one long row.
  const topLanes = diagram.containers.filter((c) => c.kind === 'lane' && !c.parent);
  if (topLanes.length >= 2 && !diagram.containers.some((c) => c.kind === 'swimlane')) {
    return elkPositions({ ...diagram, containers: diagram.containers.map((c) => (c.kind === 'lane' && !c.parent ? { ...c, kind: 'swimlane' } : c)) }, shapes, theme, { direction: 'DOWN', hierarchy: 'include' });
  }
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
    variants.push({ variant: { direction, hierarchy: 'include', straight: true }, cost: turn * 0.95 });
    variants.push({ variant: { direction, hierarchy: 'include', wrapping: true, aspectRatio: 1.6 }, cost: turn * 0.7 });
    // Containers in the cross direction reshape a lot. When the source fixes the direction, the main flow
    // keeps it and only composite interiors turn (a top-down state machine with wide, short composites).
    if (diagram.containers.length && (!fixed || diagram.family === 'state')) {
      // Laid out container by container, ELK ignores lines that leave a container: the more of those, the worse it places their ends.
      const across = diagram.edges.filter((e) => parentOf(e.from) !== parentOf(e.to)).length / Math.max(1, diagram.edges.length);
      variants.push({ variant: { direction, hierarchy: 'separate', innerDirection: direction === 'DOWN' ? 'RIGHT' : 'DOWN' }, cost: (turn * 0.9) / (1 + across) });
    }
  }
  const results: { variant: ElkVariant & { rows?: number; columns?: number }; cost: number; positions: Positions | undefined }[] = await Promise.all(
    variants.map(async ({ variant, cost }) => ({ variant, cost, positions: await elkPositions(diagram, shapes, theme, variant).catch(() => undefined) })),
  );
  // Long columns (top-down layouts) cut the same way into two or three columns side by side, each read
  // top to bottom like a newspaper's. Also when the source fixes top-down: the flow still reads downwards.
  for (const r of [...results]) {
    if (!r.positions || r.variant.direction !== 'DOWN' || r.variant.wrapping) continue;
    for (const cols of [2, 3]) {
      for (const w of wrapColumns(diagram, r.positions, shapes, containerPad(theme), cols, 56 * theme.scale)) {
        results.push({ variant: { ...r.variant, columns: cols }, cost: (r.cost * 0.8) / (1 + w.backwards), positions: w.positions });
      }
    }
  }
  // Long rows cut into two or three, each still reading left to right (ELK's own wrapping can start a row at the right).
  for (const r of [...results]) {
    // Not when the source asks for left to right (C4 LAYOUT_LEFT_RIGHT, `left to right direction`): it wants the strip.
    if (!r.positions || r.variant.direction !== 'RIGHT' || r.variant.wrapping || r.variant.usecase || diagram.direction === 'LR') continue;
    for (const rows of [2, 3]) {
      for (const w of wrapRows(diagram, r.positions, shapes, containerPad(theme), rows, 56 * theme.scale)) {
        results.push({ variant: { ...r.variant, rows }, cost: (r.cost * 0.8) / (1 + w.backwards), positions: w.positions });
      }
    }
  }
  // Use-case diagrams: actors in side columns, use cases in their packages between them (usecase.ts).
  if (isUseCaseDiagram(diagram)) {
    for (const u of useCaseLayouts(diagram, shapes, theme, containerPad(theme))) results.push({ variant: { direction: 'RIGHT', hierarchy: 'include', usecase: u.name }, cost: 1.1, positions: u.positions });
  }
  const debug = typeof process !== 'undefined' && process.env?.AUTO_DEBUG;
  const scored = results
    .filter((r): r is typeof r & { positions: Positions } => !!r.positions && diagram.nodes.every((n) => r.positions![n.id]))
    .map((r) => ({ ...r, score: proportionScore(diagram, r.positions, shapes, theme) * r.cost }))
    .sort((a, b) => b.score - a.score);
  // Straight lines between centres flatter layouts whose real lines snake (wrapped rows, lines out of
  // containers laid out on their own): route the front runners and judge them on the real thing.
  const avoid = loadedAvoid();
  if (avoid && scored.length > 1) {
    // The use-case layout's grid shapes are all routed: their differences only show once routed.
    // So are ELK's own layouts (no rows/columns cut in by us): they are what the stable choice falls back on.
    // And each base layout's best cut into rows/columns (by the proxy), so one family can't crowd out another.
    const base = (v: ElkVariant & { rows?: number; columns?: number }) => JSON.stringify({ ...v, rows: undefined, columns: undefined });
    const bestCut = new Set<unknown>();
    const seenBase = new Set<string>();
    for (const c of scored) {
      if (!c.variant.rows && !c.variant.columns) continue;
      if (seenBase.has(base(c.variant))) continue;
      seenBase.add(base(c.variant));
      bestCut.add(c);
    }
    const finalists = debug === 'all' ? scored : scored.filter((c, i) => i < 4 || c.variant.usecase || (!c.variant.rows && !c.variant.columns) || bestCut.has(c));
    const pick = typeof process !== 'undefined' ? process.env?.AUTO_PICK : undefined;
    const routed = finalists.map((c) => {
      const trial: LayoutFile = { ...emptyLayout(), view, nodes: Object.fromEntries(Object.entries(c.positions).map(([id, p]) => [id, { x: p.x, y: p.y }])) };
      const r = routedScore(diagram, buildScene(diagram, trial, avoid), c.variant.usecase ? undefined : c.variant.direction);
      if (debug) console.log(JSON.stringify(c.variant), `proxy ${c.score.toFixed(3)} routed ${(c.cost * r.score).toFixed(3)} ${r.summary}`);
      return { c, score: c.cost * r.score };
    });
    // Debugging: AUTO_PICK=<text> takes the first candidate whose description contains it.
    const forced = pick ? routed.find((r) => JSON.stringify(r.c.variant).includes(pick)) : undefined;
    if (forced) return forced.c.positions;
    const winner = chooseStable(routed).c;
    return winner.variant.usecase ? winner.positions : polish(diagram, winner.positions, shapes, theme, view, winner.variant.direction);
  }
  if (debug) for (const c of scored) console.log(JSON.stringify(c.variant), c.score.toFixed(3));
  return scored[0]?.positions ?? elkPositions(diagram, shapes, theme, own);
}

/**
 * How good a routed candidate looks, larger is better. The primary criterion is size: how large the
 * picture is drawn in a 16:9 window (1 / the window height it needs). Everything else divides it:
 *
 * - crossings, `1 + 6·crossings/lines` (CROSS): the strongest penalty; a crossing per six lines halves it;
 * - bends, `1 + 0.4·bends/lines`: a layout whose lines snake round things reads worse than a slightly
 *   smaller one with straight lines (0.15 before 2026-10-18 let 32-bend state machines beat 13-bend ones);
 * - line length, `1 + mean length/window`;
 * - long backward runs, `1 + 1.5·Σ(run against the flow beyond half the picture)/picture` (LONG_BACK): a
 *   line from the end of the flow back to its start; wrapped rows' short hand-overs cost nothing. (The
 *   total backward run, printed as `back`, isn't scored: it pushed LR-fixed C4 back into a 7:1 strip.)
 * - proportions, `1 + 2·|log(aspect / clamp(aspect, 4:3, 2:1))|`: outside 4:3–2:1 the window shows a
 *   strip (a 14:1 strip must not tie with a 2:1 wrapped layout however long the latter's lines);
 * - faults, `1 + 0.5·faults/lines` (lines through boxes/containers/titles, labels on boxes).
 *
 * The candidate's prior (`cost`: own direction 1, turned 0.9, wrapped 0.7, use-case layout 1.1, ...)
 * multiplies the result. `chooseStable` then breaks near-ties (MARGIN) by that prior.
 */
export function routedScore(diagram: Diagram, scene: ReturnType<typeof buildScene>, direction?: 'RIGHT' | 'DOWN'): { score: number; summary: string } {
  const q = measureQuality(scene, diagram);
  const lines = Math.max(1, scene.edges.length);
  const frame = Math.max(scene.bounds.w / TARGET.max, scene.bounds.h);
  const aspect = scene.bounds.w / Math.max(1, scene.bounds.h);
  const off = Math.abs(Math.log(aspect / Math.min(2, Math.max(4 / 3, aspect))));
  const crossings = countCrossings(scene.edges.map((e) => e.points));
  const length = scene.edges.reduce((sum, e) => sum + pathLength(e.points), 0) / lines / frame;
  const axis = direction === 'RIGHT' ? 0 : 1;
  const back = direction ? scene.edges.reduce((sum, e) => sum + Math.max(0, e.points[0]![axis]! - e.points[e.points.length - 1]![axis]!), 0) / frame : 0;
  // A line running back more than half the picture against the flow (the end of one row back to a state at
  // the start of another): only the part beyond half counts, so wrapped rows' short hand-overs are free.
  const span = axis === 0 ? scene.bounds.w : scene.bounds.h;
  const longBack = direction ? scene.edges.reduce((sum, e) => sum + Math.max(0, e.points[0]![axis]! - e.points[e.points.length - 1]![axis]! - span / 2), 0) / span : 0;
  const faults = q.nodeCrossings + q.containerCrossings + q.titleCrossings + q.labelOverlaps;
  const score = 1000 / frame / (1 + (CROSS * crossings) / lines) / (1 + (0.4 * q.bends) / lines) / (1 + length) / (1 + 2 * off) / (1 + LONG_BACK * longBack) / (1 + (0.5 * faults) / lines);
  return { score, summary: `frame ${Math.round(frame)} x ${crossings} bends ${q.bends} len ${length.toFixed(2)} back ${back.toFixed(2)} long-back ${longBack.toFixed(2)} aspect ${aspect.toFixed(2)}` };
}

/**
 * The winner, made stable: candidates scoring within `MARGIN` of the best are treated as tied, and the
 * tie goes to the one with the strongest prior (the source's own direction over a turned one, unwrapped
 * over wrapped, the use-case layout over ELK), then to the score. Without it, a routing tweak that moves
 * two very different layouts' scores by a percent flips the picture.
 */
const MARGIN = 0.03;
const LONG_BACK = 1.5;
const CROSS = 6;
function chooseStable<T extends { c: { cost: number }; score: number }>(routed: T[]): T {
  const top = Math.max(...routed.map((r) => r.score));
  const near = routed.filter((r) => r.score >= top * (1 - MARGIN));
  return near.sort((a, b) => b.c.cost - a.c.cost || b.score - a.score)[0]!;
}

/**
 * A left-to-right layout cut into `rows` rows, like a line of text: the
 * top-level elements (a container with everything in it counts as one) are
 * cut where a clean vertical gap runs through the layout, as near as
 * possible to the proportions of a 16:9 window (and, as a second option, to
 * equal widths), and each row is moved under the previous one, starting at
 * the left. Empty when there are no such gaps.
 */
export function wrapRows(diagram: Diagram, positions: Positions, shapes: Map<string, NodeShape>, pad: Pad, rows: number, gap: number): { positions: Positions; backwards: number }[] {
  const top = (id: string): string => {
    // A note travels with what it is attached to.
    const note = diagram.nodes.find((n) => n.id === id && n.kind === 'note' && n.attachedTo);
    if (note && note.attachedTo!.id !== id && diagram.nodes.some((n) => n.id === note.attachedTo!.id && n.parent === note.parent)) id = note.attachedTo!.id;
    let at = id;
    for (let p = diagram.nodes.find((n) => n.id === id)?.parent; p; p = diagram.containers.find((c) => c.id === p)?.parent) at = p;
    return at;
  };
  const boxes = containerBoxes(diagram, positions, shapes, pad);
  const units = new Map<string, Box>();
  for (const n of diagram.nodes) {
    const p = positions[n.id];
    if (!p) continue;
    const id = top(n.id);
    const b = boxes.get(id) ?? nodeBox(p, shapes.get(n.id)!);
    const u = units.get(id);
    units.set(id, u ? union(u, b) : b);
  }
  const list = [...units.entries()].sort((a, b) => a[1].x - b[1].x);
  if (list.length < rows + 1) return [];
  // Clean cuts: after unit i, everything so far ends left of everything after it.
  const cuts: { after: number; x: number }[] = [];
  let reach = -Infinity;
  for (let i = 0; i < list.length - 1; i++) {
    reach = Math.max(reach, list[i]![1].x + list[i]![1].w);
    const next = Math.min(...list.slice(i + 1).map(([, b]) => b.x));
    if (reach <= next) cuts.push({ after: i, x: (reach + next) / 2 });
  }
  if (cuts.length < rows - 1) return [];
  const x0 = list[0]![1].x;
  /** Rows for a choice of cuts: which row each unit is in, and each row's offset (back to the left edge, below the rows before). */
  const arrange = (chosen: number[]) => {
    const rowOf = new Map<string, number>();
    list.forEach(([id], i) => rowOf.set(id, chosen.filter((c) => i > c).length));
    const offsets: { dx: number; dy: number }[] = [];
    let y = Math.min(...list.map(([, b]) => b.y));
    let width = 0;
    for (let r = 0; r < rows; r++) {
      const members = list.filter(([id]) => rowOf.get(id) === r).map(([, b]) => b);
      const minX = Math.min(...members.map((b) => b.x));
      const minY = Math.min(...members.map((b) => b.y));
      const maxY = Math.max(...members.map((b) => b.y + b.h));
      width = Math.max(width, Math.max(...members.map((b) => b.x + b.w)) - minX);
      offsets.push({ dx: x0 - minX, dy: y - minY });
      y += maxY - minY + gap;
    }
    const height = y - gap - Math.min(...list.map(([, b]) => b.y));
    // A line between rows reads like the end of a text line running on: from the right part of its row to
    // the left part of the next. Any other (into the middle of a later row, back up) reads backwards.
    const span = (r: number) => {
      const xs = list.filter(([id]) => rowOf.get(id) === r).map(([, b]) => b);
      return [Math.min(...xs.map((b) => b.x)), Math.max(...xs.map((b) => b.x + b.w))] as const;
    };
    const unitOf = new Map(list);
    let backwards = 0;
    for (const e of diagram.edges) {
      const [a, b] = [top(e.from), top(e.to)];
      const [ra, rb] = [rowOf.get(a), rowOf.get(b)];
      if (ra === undefined || rb === undefined || ra === rb) continue;
      // Where the ends themselves are (a container counts as one unit, but its lines leave from its elements).
      const at = (id: string) => (positions[id] ? nodeBox(positions[id]!, shapes.get(id)!) : (boxes.get(id) ?? unitOf.get(top(id))!));
      const [ua, ub] = [at(e.from), at(e.to)];
      const [la, ha] = span(ra);
      const [lb, hb] = span(rb);
      if (rb !== ra + 1 || ua.x + ua.w < (la + ha) / 2 || ub.x > (lb + hb) / 2) backwards++;
    }
    // Every line from one row to another runs back across the picture: a little against the cut.
    const across = diagram.edges.filter((e) => rowOf.get(top(e.from)) !== rowOf.get(top(e.to))).length;
    return { rowOf, offsets, backwards, cost: Math.max(width / TARGET.max, height) * (1 + 0.02 * across) * (1 + 0.25 * backwards) };
  };
  // Every way to cut (a dozen gaps at most in practice): the one that fits a 16:9 window largest, with the fewest lines between rows.
  let best: ReturnType<typeof arrange> | undefined;
  const pick = (from: number, chosen: number[]) => {
    if (chosen.length === rows - 1) {
      const a = arrange(chosen);
      if (!best || a.cost < best.cost) best = a;
      return;
    }
    for (let i = from; i < cuts.length; i++) pick(i + 1, [...chosen, cuts[i]!.after]);
  };
  if (cuts.length > 24) return [];
  pick(0, []);
  // Also the cuts nearest equal row widths: the estimate above doesn't see labels and the lines between rows.
  const x1 = Math.max(...list.map(([, b]) => b.x + b.w));
  const even: number[] = [];
  for (let r = 1; r < rows; r++) {
    const want = x0 + ((x1 - x0) * r) / rows;
    const c = cuts.filter((c) => !even.length || c.after > even[even.length - 1]!).sort((a, b) => Math.abs(a.x - want) - Math.abs(b.x - want))[0];
    if (c) even.push(c.after);
  }
  const options = [best!];
  if (even.length === rows - 1 && list.every(([id]) => arrange(even).rowOf.get(id) !== undefined)) options.push(arrange(even.sort((a, b) => a - b)));
  const seen = new Set<string>();
  return options.flatMap(({ rowOf, offsets, backwards }) => {
    const key = list.map(([id]) => rowOf.get(id)).join();
    if (seen.has(key) || offsets.some((o) => !Number.isFinite(o.dx))) return [];
    seen.add(key);
    const out: Positions = {};
    for (const [id, p] of Object.entries(positions)) {
      const o = offsets[rowOf.get(top(id)) ?? 0]!;
      out[id] = { x: p.x + o.dx, y: p.y + o.dy };
    }
    return [{ positions: out, backwards }];
  });
}

/**
 * `wrapRows` turned on its side: a top-down layout cut at clean horizontal gaps into `cols` columns, each
 * moved right of the previous one and up to the top. Done by transposing, cutting rows, transposing back.
 */
export function wrapColumns(diagram: Diagram, positions: Positions, shapes: Map<string, NodeShape>, pad: Pad, cols: number, gap: number): { positions: Positions; backwards: number }[] {
  const flip = (p: Positions): Positions => Object.fromEntries(Object.entries(p).map(([id, q]) => [id, { x: q.y, y: q.x }]));
  const turned = new Map([...shapes].map(([id, s]) => [id, { ...s, w: s.h, h: s.w }]));
  // A container's title padding is at the top; turned, it would be at the left: spread it evenly instead.
  const even = (pad.top + pad.bottom) / 2;
  return wrapRows(diagram, flip(positions), turned, { side: even, top: pad.side, bottom: pad.side }, cols, gap).map((w) => ({ ...w, positions: flip(w.positions) }));
}

/**
 * Last pass on the chosen layout of a small diagram: each top-level unit (an element, or a container with
 * everything in it) tries to slide into the free space towards the middle of the picture, all the way or
 * half way, on each axis. A move is kept only when the routed picture has no more crossings, bends or
 * faults than before and scores better (`routedScore`): it closes the holes layered layouts leave without
 * the new crossings a blind compaction makes. Bounded: ≤ 40 elements, ≤ 80 routed tries.
 */
function polish(diagram: Diagram, positions: Positions, shapes: Map<string, NodeShape>, theme: Theme, view: LayoutFile['view'], direction: 'RIGHT' | 'DOWN'): Positions {
  const avoid = loadedAvoid();
  if (!avoid || diagram.nodes.length > 40 || diagram.containers.some((c) => c.kind === 'swimlane')) return positions;
  const pad = containerPad(theme);
  const topOf = (id: string): string => {
    // A note travels with what it annotates.
    const note = diagram.nodes.find((n) => n.id === id && n.kind === 'note' && n.attachedTo);
    if (note && diagram.nodes.some((n) => n.id === note.attachedTo!.id && n.parent === note.parent)) id = note.attachedTo!.id;
    let at = id;
    for (let p = diagram.nodes.find((n) => n.id === id)?.parent; p; p = diagram.containers.find((c) => c.id === p)?.parent) at = p;
    return at;
  };
  const members = new Map<string, string[]>();
  for (const n of diagram.nodes) if (positions[n.id]) members.set(topOf(n.id), [...(members.get(topOf(n.id)) ?? []), n.id]);
  const judge = (at: Positions) => {
    const trial: LayoutFile = { ...emptyLayout(), view, nodes: Object.fromEntries(Object.entries(at).map(([id, p]) => [id, { x: p.x, y: p.y }])) };
    const scene = buildScene(diagram, trial, avoid);
    const q = measureQuality(scene, diagram);
    const aspect = scene.bounds.w / Math.max(1, scene.bounds.h);
    return { off: Math.abs(Math.log(aspect / Math.min(2, Math.max(4 / 3, aspect)))), score: routedScore(diagram, scene, direction).score, crossings: countCrossings(scene.edges.map((e) => e.points)), bends: q.bends, faults: q.nodeCrossings + q.containerCrossings + q.titleCrossings + q.labelOverlaps + q.labelLineOverlaps };
  };
  const unitBoxes = (at: Positions) => {
    const boxes = containerBoxes(diagram, at, shapes, pad);
    const map = new Map<string, Box>();
    for (const [id, list] of members) {
      let b: Box | undefined = boxes.get(id);
      if (!b) for (const m of list) b = b ? union(b, nodeBox(at[m]!, shapes.get(m)!)) : nodeBox(at[m]!, shapes.get(m)!);
      map.set(id, b!);
    }
    return map;
  };
  let at: Positions = Object.fromEntries(Object.entries(positions).map(([id, p]) => [id, { ...p }]));
  let best = judge(at);
  let tries = 0;
  const gap = 40 * theme.scale;
  for (let round = 0; round < 2 && tries < 80; round++) {
    let improved = false;
    for (const id of members.keys()) {
      for (const axis of ['x', 'y'] as const) {
        if (tries >= 80) break;
        const boxes = unitBoxes(at);
        const all = [...boxes.values()];
        const lo = Math.min(...all.map((b) => b[axis]));
        const hi = Math.max(...all.map((b) => b[axis] + (axis === 'x' ? b.w : b.h)));
        const b = boxes.get(id)!;
        const size = axis === 'x' ? b.w : b.h;
        // Towards what it connects to, or else towards the middle of the picture.
        const mine = members.get(id)!;
        const others = diagram.edges.flatMap((e) => (mine.includes(e.from) && !mine.includes(e.to) ? [e.to] : mine.includes(e.to) && !mine.includes(e.from) ? [e.from] : [])).filter((o) => at[o]);
        const mid = others.length ? others.reduce((sum, o) => sum + at[o]![axis], 0) / others.length : (lo + hi) / 2;
        if (Math.abs(b[axis] + size / 2 - mid) < 12 * theme.scale) continue;
        const sign = b[axis] + size / 2 > mid ? -1 : 1;
        // Free run towards the middle: up to the nearest unit sharing a band across the axis.
        const across = (o: Box) => (axis === 'x' ? o.y < b.y + b.h + gap && b.y < o.y + o.h + gap : o.x < b.x + b.w + gap && b.x < o.x + o.w + gap);
        let room = Infinity;
        for (const [oid, o] of boxes) {
          if (oid === id || !across(o)) continue;
          const d = sign < 0 ? b[axis] - (o[axis] + (axis === 'x' ? o.w : o.h)) - gap : o[axis] - (b[axis] + size) - gap;
          if (d > -1) room = Math.min(room, d);
        }
        room = Math.min(room, Math.abs(b[axis] + size / 2 - mid));
        for (const f of [1, 0.5]) {
          const step = sign * room * f;
          if (Math.abs(step) < 12 * theme.scale) continue;
          // Never onto another unit (the quality measure doesn't count overlapping boxes).
          const moved: Box = axis === 'x' ? { ...b, x: b.x + step } : { ...b, y: b.y + step };
          if ([...boxes].some(([oid, o]) => oid !== id && overlaps(moved, o, 16 * theme.scale))) continue;
          const next: Positions = { ...at };
          for (const m of members.get(id)!) next[m] = { ...at[m]!, [axis]: at[m]![axis] + step };
          tries++;
          const r = judge(next);
          if (r.crossings <= best.crossings && r.bends <= best.bends && r.faults <= best.faults && r.off <= best.off + 0.01 && r.score > best.score * 1.005) {
            at = next;
            best = r;
            improved = true;
            break;
          }
        }
      }
    }
    if (!improved) break;
  }
  return at;
}

const union = (a: Box, b: Box): Box => {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
};

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
 * the file's waypoints and fixed connection points; a line between nodes that were already placed keeps
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
    if ((!e.sourceVia && !e.sourceFrom && !e.sourceTo) || next.edges[e.id] || !fresh(e.from) || !fresh(e.to)) continue;
    const entry: EdgeLayout = {};
    // A waypoint on (or in) an end's outline would make the router hook the line into it: drop it.
    const ends = [e.from, e.to].map((id) => diagram.nodes.find((n) => n.id === id)?.sourceBox).filter((b) => b !== undefined);
    const off = (p: [number, number]) => !ends.some((b) => p[0] >= b.x - 2 && p[0] <= b.x + b.w + 2 && p[1] >= b.y - 2 && p[1] <= b.y + b.h + 2);
    const via = e.sourceVia?.filter(off).map(([x, y]): [number, number] => [x, y]);
    if (via?.length) entry.via = via;
    // The file's fixed connection points become hand-chosen ends.
    if (e.sourceFrom) entry.from = { x: e.sourceFrom[0], y: e.sourceFrom[1], side: sideOfFraction(...e.sourceFrom) };
    if (e.sourceTo) entry.to = { x: e.sourceTo[0], y: e.sourceTo[1], side: sideOfFraction(...e.sourceTo) };
    if (entry.via || entry.from || entry.to) next.edges[e.id] = entry;
  }
}

export async function ensureLayout(diagram: Diagram, layout: LayoutFile, mode: LayoutMode = 'fill'): Promise<LayoutFile> {
  // Ordered diagrams (sequence, ...) compute their layout on every build; only dragged columns are stored.
  if (diagram.special) return mode === 'fill' ? layout : { ...layout, nodes: {}, edges: {} };
  // Drawings keep the file's geometry: only dragged shapes are stored; Auto does nothing, Reset goes back to the file.
  if (diagram.drawing) {
    const next: LayoutFile = { ...layout, nodes: mode === 'reset' ? {} : { ...layout.nodes }, edges: {} };
    const shapes = shapesFor(diagram, themeOf(layout.view));
    for (const n of diagram.nodes) {
      const home = n.sourceBox && sourceCentre(n, shapes.get(n.id)!);
      if (home && !next.nodes[n.id]) next.nodes[n.id] = { x: home.x, y: home.y };
    }
    return mode === 'auto' ? layout : next;
  }
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
    next.edges = mode === 'reset' ? {} : chosenEnds(layout.edges);
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
  // Manual routing only survives between nodes that did not move; chosen ends are relative, so they always do.
  next.edges = {
    ...chosenEnds(layout.edges),
    ...Object.fromEntries(diagram.edges.filter((e) => fixed[e.from] && fixed[e.to] && layout.edges[e.id]).map((e) => [e.id, layout.edges[e.id]!])),
  };
  return next;
}

