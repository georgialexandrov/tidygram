import type { LayoutFile, Point } from '../layout/layout-file.ts';
import type { ArrowHead, DEdge, DNode, Diagram, EdgeKind } from '../model/types.ts';
import type { Avoid } from './avoid.ts';
import { containerBoxes, nodeBox, type Box, type Positions } from './containers.ts';
import { clipEnd, clipStart, pointAt, simplify, type AnchorShape } from './geometry.ts';
import { containerPad, nodeShape, type NodeShape } from './shapes.ts';
import { measureText, type TextBlock } from './measure.ts';
import { routeEdges, type RouteShape } from './route.ts';
import { themeOf, type Theme } from './theme.ts';

export interface SceneNode {
  node: DNode;
  shape: NodeShape;
  box: Box;
  anchor: AnchorShape;
  pinned: boolean;
}

export interface SceneContainer {
  id: string;
  kind: string;
  label: string;
  box: Box;
  depth: number;
}

export interface EndLabel {
  text: TextBlock;
  x: number;
  y: number;
}

export interface SceneEdge {
  edge: DEdge;
  kind: EdgeKind;
  points: Point[];
  head: ArrowHead;
  tail: ArrowHead;
  dashed: boolean;
  via: Point[];
  label?: { text: TextBlock; x: number; y: number };
  /** Labels at the ends (multiplicities). */
  fromLabel?: EndLabel;
  toLabel?: EndLabel;
}

export interface Scene {
  kind: 'graph';
  theme: Theme;
  nodes: SceneNode[];
  containers: SceneContainer[];
  edges: SceneEdge[];
  bounds: Box;
}

export interface BuildOptions {
  /**
   * Fast path for dragging: reuse `previous` routes for every line that
   * touches none of `dirty.nodes` and isn't in `dirty.edges`. Only the rest is
   * routed (all shapes are still obstacles), so a move costs a few lines
   * instead of all of them. Untouched lines aren't re-nudged until the next
   * full build, which the editor does when the drag ends.
   */
  previous?: Scene;
  dirty?: { nodes: ReadonlySet<string>; edges: ReadonlySet<string> };
}

/** Turns the parsed model + layout into absolute geometry. Every node must already have a position. */
export function buildScene(diagram: Diagram, layout: LayoutFile, avoid: Avoid, options: BuildOptions = {}): Scene {
  const theme = themeOf(layout.view);
  const shapes = new Map(diagram.nodes.map((n) => [n.id, nodeShape(n, theme)]));
  const positions: Positions = {};
  for (const n of diagram.nodes) {
    const p = layout.nodes[n.id];
    if (p) positions[n.id] = { x: p.x, y: p.y };
  }

  const nodes: SceneNode[] = diagram.nodes
    .filter((n) => positions[n.id])
    .map((n) => {
      const shape = shapes.get(n.id)!;
      const p = positions[n.id]!;
      return {
        node: n,
        shape,
        box: nodeBox(p, shape),
        anchor: { ...shape.anchor, cx: p.x + shape.anchor.dx, cy: p.y + shape.anchor.dy },
        pinned: layout.nodes[n.id]?.pinned === true,
      };
    });
  const byId = new Map(nodes.map((n) => [n.node.id, n]));

  const depthOf = (id: string | undefined): number => {
    let depth = 0;
    let current = diagram.containers.find((c) => c.id === id);
    while (current?.parent) {
      depth++;
      current = diagram.containers.find((c) => c.id === current!.parent);
    }
    return depth;
  };
  const boxes = containerBoxes(diagram, positions, shapes, containerPad(theme));
  // Swimlanes run the full height of the diagram, side by side.
  const lanes = diagram.containers.filter((c) => c.kind === 'swimlane' && boxes.has(c.id));
  if (lanes.length) {
    const laneBoxes = lanes.map((l) => boxes.get(l.id)!);
    const top = Math.min(...laneBoxes.map((b) => b.y));
    const bottom = Math.max(...laneBoxes.map((b) => b.y + b.h));
    for (const b of laneBoxes) Object.assign(b, { y: top, h: bottom - top });
  }
  const containers: SceneContainer[] = [...boxes]
    .map(([id, box]) => {
      const c = diagram.containers.find((x) => x.id === id)!;
      return { id, kind: c.kind, label: c.label, box, depth: depthOf(id) };
    })
    .sort((a, b) => a.depth - b.depth);

  // One centred box per node is what libavoid routes fastest; lines are clipped to the figure/ellipse afterwards.
  const routeShapes = new Map<string, RouteShape>(nodes.map((n) => [n.node.id, { box: n.box }]));
  const containerBox = new Map(containers.map((c) => [c.id, c.box]));
  const has = (id: string) => byId.has(id) || containerBox.has(id);
  const visible = diagram.edges.filter((e) => !e.hidden && has(e.from) && has(e.to));
  const centreOf = (id: string): Point => {
    const n = byId.get(id);
    if (n) return [n.anchor.cx, n.anchor.cy];
    const b = containerBox.get(id)!;
    return [b.x + b.w / 2, b.y + b.h / 2];
  };
  /** Where a line meets a container: the border point facing the other end (the top if the other end is inside). */
  const borderPoint = (id: string, other: string): Point | undefined => {
    const b = containerBox.get(id);
    if (!b) return undefined;
    const [ox, oy] = centreOf(other);
    const cx = b.x + b.w / 2;
    const cy = b.y + b.h / 2;
    if (ox > b.x && ox < b.x + b.w && oy > b.y && oy < b.y + b.h) return [Math.min(Math.max(ox, b.x + 12), b.x + b.w - 12), b.y];
    const dx = ox - cx;
    const dy = oy - cy;
    const t = Math.min(dx ? b.w / 2 / Math.abs(dx) : Infinity, dy ? b.h / 2 / Math.abs(dy) : Infinity);
    return [cx + dx * t, cy + dy * t];
  };
  const { previous, dirty } = options;
  const reused = new Map<string, SceneEdge>();
  if (previous && dirty && previous.theme === theme) {
    const prior = new Map(previous.edges.map((e) => [e.edge.id, e]));
    for (const e of visible) {
      const old = prior.get(e.id);
      if (old && !dirty.nodes.has(e.from) && !dirty.nodes.has(e.to) && !dirty.edges.has(e.id)) reused.set(e.id, old);
    }
  }
  const routes = routeEdges(
    avoid,
    routeShapes,
    visible
      .filter((e) => !reused.has(e.id))
      .map((e) => ({ id: e.id, from: e.from, to: e.to, via: layout.edges[e.id]?.via, fromPoint: borderPoint(e.from, e.to), toPoint: borderPoint(e.to, e.from) })),
  );

  const edges: SceneEdge[] = visible.map((e) => {
    const kept = reused.get(e.id);
    if (kept) return kept;
    const from = byId.get(e.from);
    const to = byId.get(e.to);
    let points = routes.get(e.id) ?? [centreOf(e.from), centreOf(e.to)];
    if (from) points = clipStart(points, from.anchor);
    if (to) points = clipEnd(points, to.anchor);
    points = simplify(points);
    const scene: SceneEdge = {
      edge: e,
      kind: e.kind,
      points,
      head: e.head,
      tail: e.tail,
      dashed: e.dashed,
      via: layout.edges[e.id]?.via ?? [],
    };
    if (e.label) {
      const [mx, my] = pointAt(points, 0.5);
      const [ox, oy] = layout.edges[e.id]?.label ?? [0, 0];
      scene.label = { text: measureText(labelText(e.label, theme), theme.size.edge, false, theme.widthFactor), x: mx + ox, y: my + oy };
    }
    if (e.fromLabel) scene.fromLabel = endLabel(e.fromLabel, points, theme);
    if (e.toLabel) scene.toLabel = endLabel(e.toLabel, [...points].reverse(), theme);
    return scene;
  });

  const all: Box[] = [...nodes.map((n) => n.box), ...containers.map((c) => c.box)];
  for (const e of edges) for (const [x, y] of e.points) all.push({ x, y, w: 0, h: 0 });
  for (const e of edges) for (const l of [e.fromLabel, e.toLabel]) if (l) all.push({ x: l.x - l.text.width / 2, y: l.y - l.text.height / 2, w: l.text.width, h: l.text.height });
  for (const e of edges) if (e.label) all.push({ x: e.label.x - e.label.text.width / 2 - 6 * theme.scale, y: e.label.y - e.label.text.height / 2 - 2 * theme.scale, w: e.label.text.width + 12 * theme.scale, h: e.label.text.height + 4 * theme.scale });
  if (!all.length) all.push({ x: 0, y: 0, w: 0, h: 0 });
  const x0 = Math.min(...all.map((b) => b.x));
  const y0 = Math.min(...all.map((b) => b.y));
  const x1 = Math.max(...all.map((b) => b.x + b.w));
  const y1 = Math.max(...all.map((b) => b.y + b.h));
  return { kind: 'graph', theme, nodes, containers, edges, bounds: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } };
}

/** A multiplicity next to the line's start: a little way along it, set off to one side. */
function endLabel(text: string, points: Point[], theme: Theme): EndLabel {
  const block = measureText(text, theme.size.edge, false, theme.widthFactor);
  const [a, b] = [points[0]!, points[1] ?? points[0]!];
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
  const ux = (b[0] - a[0]) / len;
  const uy = (b[1] - a[1]) / len;
  const along = 10 * theme.scale + block.height / 2;
  const side = 6 * theme.scale + (Math.abs(ux) > 0.5 ? block.height / 2 : block.width / 2);
  return { text: block, x: a[0] + ux * along - uy * side, y: a[1] + uy * along + ux * side };
}

export function labelText(label: string, theme: Theme): string {
  return theme.plainLabels ? label.replace(/[«»]/g, '') : label;
}
