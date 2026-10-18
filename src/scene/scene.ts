import type { EndAttach, LayoutFile, Point } from '../layout/layout-file.ts';
import type { ArrowHead, DEdge, DNode, Diagram, EdgeKind } from '../model/types.ts';
import type { Avoid } from './avoid.ts';
import { containerBoxes, doorFor, facingSide, nodeBox, overlaps, titleBox, wallsFor, type Box, type Door, type Positions, type Side } from './containers.ts';
import { clipEnd, clipStart, pathLength, pointAt, simplify, type AnchorShape } from './geometry.ts';
import { borderCrossings, overlapArea, pathHitsBox } from './quality.ts';
import { planPorts, settleEnd, slideOnNode, untangle, type EdgePorts, type Port } from './ports.ts';
import { attachOutline, outward } from './attach.ts';
import { placeEndLabel, placeMidLabel, type LabelObstacles } from './labels.ts';
import { containerPad, nodeShape, orientBars, type NodeShape } from './shapes.ts';
import { measureSecondary, type TextBlock } from './measure.ts';
import { ROUTING, routeEdges, type RouteShape } from './route.ts';
import { bundlesHelp, busyness, clashingEnds, planBundles, portAt, type RoutedEnd } from './bundle.ts';

/** A container wall for the router: how far it reaches outside and inside the border (see `wallsFor`). */
const WALL = { outer: 7, inner: 8, top: 3 };
import { themeOf, type Theme } from './theme.ts';
import { treeScene } from './tree-scene.ts';
import { isTreeDiagram } from '../layout/tree.ts';
import { buildDrawingScene } from './drawing.ts';
import { buildTemplateScene, nudgeRingTitles, type TemplateScene } from './template.ts';

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
  /** The title's text box: an obstacle for lines and labels. */
  title?: Box;
  /** How far the title was moved right from its usual spot, off the way of a line dropping onto an element under it. */
  titleShift?: number;
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
  /** Tree diagrams (mindmap, WBS): the line as an SVG path (curve or elbow); it is not routed. */
  path?: string;
  /** `offset` is from the line's middle: the user's, or where placement put it (the start of a label drag). */
  label?: { text: TextBlock; x: number; y: number; offset?: Point };
  /** Labels at the ends (multiplicities). */
  fromLabel?: EndLabel;
  toLabel?: EndLabel;
  /** With an architecture template on: why this line breaks the template's dependency rule. */
  violation?: string;
  /** Ends whose attachment was chosen by hand (`EdgeLayout.from` / `to`); absent when neither was. */
  fixedEnds?: { from?: boolean; to?: boolean };
}

export interface Scene {
  kind: 'graph';
  theme: Theme;
  nodes: SceneNode[];
  containers: SceneContainer[];
  edges: SceneEdge[];
  bounds: Box;
  /** Bands, hexagon or rings behind everything, when the layout has a template on. */
  template?: TemplateScene;
  /** A drawing (`Diagram.drawing`): file geometry as it is; the view draws shapes by their file styles, lines over them. */
  drawing?: true;
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
  /**
   * While dragging with a template on: the backdrop from before the drag.
   * Derived bands would stretch to follow the dragged element; frozen, they
   * stay put and the drop is judged against them.
   */
  frozenTemplate?: TemplateScene;
}

/** Turns the parsed model + layout into absolute geometry. Every node must already have a position. */
export function buildScene(diagram: Diagram, layout: LayoutFile, avoid: Avoid, options: BuildOptions = {}): Scene {
  if (diagram.drawing) return buildDrawingScene(diagram, layout); // file geometry, no routing (see drawing.ts)
  const theme = themeOf(layout.view);
  const positions: Positions = {};
  for (const n of diagram.nodes) {
    const p = layout.nodes[n.id];
    if (p) positions[n.id] = { x: p.x, y: p.y };
  }
  // Bars keep their orientation through a drag (their other lines aren't re-routed until it ends).
  const before = options.previous && options.dirty ? new Map(options.previous.nodes.map((n) => [n.node.id, n])) : undefined;
  const shapes = orientBars(diagram, positions, new Map(diagram.nodes.map((n) => [n.id, nodeShape(n, theme)])), before && ((id) => {
    const n = before.get(id);
    return n ? n.box.h > n.box.w : undefined;
  }));

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
  // A template's bands replace the source's grouping: containers are hidden while one is on (their names fed the guesses).
  const boxes = layout.template ? new Map<string, Box>() : containerBoxes(diagram, positions, shapes, containerPad(theme));
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
      return { id, kind: c.kind, label: c.label, box, depth: depthOf(id), title: titleBox(c.kind, c.label, box, theme) };
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
  // Mindmaps and WBS: lines come straight from the boxes, no router.
  if (isTreeDiagram(diagram) && !layout.template) return treeScene(diagram, theme, nodes, visible);
  const template: TemplateScene | undefined = layout.template
    ? (options.frozenTemplate ?? buildTemplateScene(diagram, layout.template, new Map(nodes.map((n) => [n.node.id, n.box])), theme))
    : undefined;
  const fence = template ? templateFence(template, byId) : undefined;
  /** What lines route round: the containers, plus a template's core (see `templateFence`). */
  const fences: SceneContainer[] = fence ? [...containers, fence.container] : containers;
  shiftTitles(containers, nodes, diagram, layout, theme);
  const containerOf = new Map(containers.map((c) => [c.id, c]));
  const parentOf = new Map<string, string | undefined>([...diagram.nodes.map((n) => [n.id, n.parent] as const), ...diagram.containers.map((c) => [c.id, c.parent] as const)]);
  /** True when `id` (a node or container) sits somewhere inside `container`. */
  const within = (id: string, container: string): boolean => {
    if (fence && container === fence.container.id) return fence.members.has(id);
    for (let p = parentOf.get(id); p; p = parentOf.get(p)) if (p === container) return true;
    return false;
  };
  /**
   * Where a line meets a container: on the side facing the other end,
   * straight across from it (so the line comes in square), never on the
   * title. If the other end is inside, the top border beside the title.
   */
  const borderPoint = (id: string, other: string): Point | undefined => {
    const c = containerOf.get(id);
    if (!c) return undefined;
    const b = c.box;
    const o = centreOf(other);
    const clampX = (x: number) => Math.min(Math.max(x, b.x + 12), b.x + b.w - 12);
    const clampY = (y: number) => Math.min(Math.max(y, b.y + 12), b.y + b.h - 12);
    const side = within(other, id) ? 'top' : facingSide(b, o, { x: o[0], y: o[1], w: 0, h: 0 });
    let p: Point = side === 'top' ? [clampX(o[0]), b.y] : side === 'bottom' ? [clampX(o[0]), b.y + b.h] : side === 'left' ? [b.x, clampY(o[1])] : [b.x + b.w, clampY(o[1])];
    const t = c.title;
    if (side === 'top' && t && p[0] > t.x - 8 && p[0] < t.x + t.w + 8) {
      p = [clampX(o[0] < t.x + t.w / 2 && t.x - 12 > b.x + 12 ? t.x - 12 : t.x + t.w + 12), b.y];
    }
    return p;
  };
  const endBox = (id: string): Box => byId.get(id)?.box ?? containerBox.get(id)!;
  /** The box spanned by a line's two ends. */
  const spanOf = (e: DEdge): Box => {
    const [a, b] = [endBox(e.from), endBox(e.to)];
    const x = Math.min(a.x, b.x);
    const y = Math.min(a.y, b.y);
    return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
  };
  const fromPoints = new Map(visible.map((e) => [e.id, borderPoint(e.from, e.to)]));
  const toPoints = new Map(visible.map((e) => [e.id, borderPoint(e.to, e.from)]));
  // Hand-chosen ends win over every automatic port (and over a straight pair, which needs both ends);
  // the planner takes them as given and spreads the other ends round them.
  const fixed = new Map<string, EdgePorts>();
  for (const e of visible) {
    const user = layout.edges[e.id];
    if (!user?.from && !user?.to) continue;
    const p: EdgePorts = {};
    for (const [key, id, points] of [['from', e.from, fromPoints], ['to', e.to, toPoints]] as const) {
      const at = user[key];
      if (!at) continue;
      const n = byId.get(id);
      const c = containerBox.get(id);
      // With an arrowhead (or diamond, crow's foot) there, the straight stretch is at least as long as the head plus a bit.
      const head = key === 'to' ? e.head : e.tail;
      if (n) p[key] = userPort(n, at, head === 'none' ? 0 : 18 * Math.sqrt(theme.scale));
      else if (c) points.set(e.id, attachOutline({ cx: c.x + c.w / 2, cy: c.y + c.h / 2, w: c.w, h: c.h, dx: 0, dy: 0, shape: 'rect' }, at));
    }
    fixed.set(e.id, p);
  }
  const ports = planPorts(
    visible,
    (id) => !!layout.edges[id]?.via?.length,
    { nodes: byId, containers: fences, within, buffer: ROUTING.shapeBuffer, via: (id) => layout.edges[id]?.via, fixed, scale: theme.scale },
    diagram.direction === 'LR',
  );

  /**
   * Walls and titles: every container border is an obstacle with a door
   * for each line that has exactly one end inside it, facing the other end.
   * A line between two elements outside a container goes round it, and a
   * line from inside A to inside B crosses A's and B's borders only.
   * Swimlanes have no walls (flows cross lanes all the time), only titles.
   */
  function containerObstacles(lines: DEdge[], near?: Box, wide?: boolean): Box[] {
    // Walls cost routing time (libavoid's work grows with every obstacle), so a container gets them
    // only where a line being routed has business with it: one that crosses its border (and should
    // do so once, square, not run along it), or one that has to stay out and passes nearby. Lines
    // that still cross one they shouldn't are caught afterwards and routed again with every wall up.
    const guarded = new Set(
      fences
        .filter(
          (c) =>
            wide ||
            lines.some((e) => {
              const [a, b] = [e.from === c.id || within(e.from, c.id), e.to === c.id || within(e.to, c.id)];
              return a !== b || (!a && !b && overlaps(spanOf(e), c.box, 40));
            }),
        )
        .map((c) => c.id),
    );
    const doors = new Map<string, Door[]>();
    const open = (c: SceneContainer, d: Door) => {
      const list = doors.get(c.id) ?? [];
      list.push(d);
      doors.set(c.id, list);
    };
    for (const e of lines) {
      for (const c of fences) {
        if (c.kind === 'swimlane') continue;
        for (const [end, other, point] of [[e.from, e.to, fromPoints.get(e.id)], [e.to, e.from, toPoints.get(e.id)]] as const) {
          if (end === c.id && point) {
            // The line ends on this border: a door around the end point.
            const b = c.box;
            const side: Side = Math.abs(point[1] - b.y) < 0.5 ? 'top' : Math.abs(point[1] - b.y - b.h) < 0.5 ? 'bottom' : Math.abs(point[0] - b.x) < 0.5 ? 'left' : 'right';
            const at = side === 'top' || side === 'bottom' ? point[0] : point[1];
            open(c, { container: c.id, side, lo: at - 12, hi: at + 12 });
          } else if (end !== c.id && other !== c.id && within(end, c.id) && !within(other, c.id)) {
            const target = toPoints.get(e.id) && other === e.to ? toPoints.get(e.id)! : fromPoints.get(e.id) && other === e.from ? fromPoints.get(e.id)! : centreOf(other);
            const inner = endBox(end);
            /** Another element of the container in the way, straight out from the inner end to that side. */
            const blocked = (side: Side) => {
              const lane: Box =
                side === 'top' ? { x: inner.x, y: c.box.y, w: inner.w, h: inner.y - c.box.y }
                : side === 'bottom' ? { x: inner.x, y: inner.y + inner.h, w: inner.w, h: c.box.y + c.box.h - inner.y - inner.h }
                : side === 'left' ? { x: c.box.x, y: inner.y, w: inner.x - c.box.x, h: inner.h }
                : { x: inner.x + inner.w, y: inner.y, w: c.box.x + c.box.w - inner.x - inner.w, h: inner.h };
              return nodes.some((n) => n.node.id !== end && within(n.node.id, c.id) && overlapArea(n.box, lane) > 0);
            };
            open(c, doorFor(c.id, c.box, inner, target, c.title, wide, blocked));
          }
        }
      }
    }
    const buffer = ROUTING.shapeBuffer;
    const padded = nodes.map((n) => ({ x: n.box.x - buffer, y: n.box.y - buffer, w: n.box.w + 2 * buffer, h: n.box.h + 2 * buffer }));
    const out: Box[] = [];
    for (const c of fences) {
      if (near && !overlaps(near, c.box)) continue;
      if (c.kind !== 'swimlane' && guarded.has(c.id)) out.push(...wallsFor(c.box, doors.get(c.id) ?? [], padded, WALL));
      const t = c.title;
      if (!t) continue;
      // Overlapping obstacles confuse libavoid: trim the title above any element's clearance.
      let bottom = t.y + t.h;
      for (const p of padded) if (p.x < t.x + t.w && t.x < p.x + p.w && p.y < bottom && p.y + p.h > t.y) bottom = Math.min(bottom, p.y + 1);
      if (bottom - t.y >= 4) out.push({ ...t, h: bottom - t.y });
    }
    return out;
  }
  const { previous, dirty } = options;
  const reused = new Map<string, SceneEdge>();
  if (previous && dirty && previous.theme === theme) {
    const prior = new Map(previous.edges.map((e) => [e.edge.id, e]));
    for (const e of visible) {
      const old = prior.get(e.id);
      if (old && !dirty.nodes.has(e.from) && !dirty.nodes.has(e.to) && !dirty.edges.has(e.id)) reused.set(e.id, old);
    }
  }
  const routed = visible.filter((e) => !reused.has(e.id));
  // Lines from one element into a container leave it from one spot and run as one until they part (see bundle.ts).
  const bundled =
    bundlesHelp(diagram) && !layout.template
      ? planBundles(routed, {
          isNode: (id) => byId.has(id),
          parentOf: (id) => {
            const p = parentOf.get(id);
            return p && containerOf.has(p) ? p : undefined;
          },
          within,
          keep: (e, end) => !!layout.edges[e.id]?.via?.length || !!layout.edges[e.id]?.[end] || !!ports.get(e.id)?.[end],
        })
      : new Map<string, 'from' | 'to'>();
  // Drag fast path: only the walls near the lines being re-routed (each wall is another obstacle to route round).
  let near: Box | undefined;
  if (reused.size && routed.length) {
    const ends = routed.flatMap((e) => [endBox(e.from), endBox(e.to)]);
    const x0 = Math.min(...ends.map((b) => b.x)) - 120;
    const y0 = Math.min(...ends.map((b) => b.y)) - 120;
    near = { x: x0, y: y0, w: Math.max(...ends.map((b) => b.x + b.w)) + 120 - x0, h: Math.max(...ends.map((b) => b.y + b.h)) + 120 - y0 };
  }
  const obstacles = !routed.length ? [] : containerObstacles(routed, near);
  /**
   * A line that ends on a container's border is routed to a point just off
   * it (outside, or inside when the other end is in the container) and drawn
   * on to the border, so it meets the border square instead of running
   * along it into the end point.
   */
  const stubs = new Map<string, Port>();
  for (const e of routed) {
    for (const [key, id, other, p] of [['from', e.from, e.to, fromPoints.get(e.id)], ['to', e.to, e.from, toPoints.get(e.id)]] as const) {
      const b = containerBox.get(id);
      if (!p || !b) continue;
      const side: Side = Math.abs(p[1] - b.y) < 0.5 ? 'top' : Math.abs(p[1] - b.y - b.h) < 0.5 ? 'bottom' : Math.abs(p[0] - b.x) < 0.5 ? 'left' : 'right';
      stubs.set(`${e.id}:${key}`, { outline: p, route: outward(p, side, (within(other, id) ? -1 : 1) * (ROUTING.shapeBuffer + 1)) });
    }
  }
  /** Where a border end may slide to: along its side, off the corners and the title. */
  const slideOnBorder = (id: string, p: Port) => {
    const c = containerOf.get(id);
    if (!c) return undefined;
    const b = c.box;
    const vertical = Math.abs(p.route[0] - p.outline[0]) < 0.5;
    return (at: number): Point | undefined => {
      const [lo, hi] = vertical ? [b.x + 12, b.x + b.w - 12] : [b.y + 12, b.y + b.h - 12];
      if (at < lo || at > hi) return undefined;
      if (vertical && c.title && p.outline[1] === b.y && at > c.title.x - 8 && at < c.title.x + c.title.w + 8) return undefined;
      return vertical ? [at, p.outline[1]] : [p.outline[0], at];
    };
  };
  /** Bundled lines run together (`bundled`): only once no two other lines share an end. */
  let merge = false;
  const ends = (lines: DEdge[]): RoutedEnd[] =>
    lines.flatMap((e) =>
      e.from === e.to
        ? []
        : (['from', 'to'] as const).map((end) => {
            const point = stubs.get(`${e.id}:${end}`)?.route ?? ports.get(e.id)?.[end]?.route;
            return point ? { e, end, point } : { e, end, pin: end === 'from' ? e.from : e.to };
          }),
    );
  /** Routes `lines` with the current ports, then routes the ones that went wrong again (see below). */
  const routeLines = (lines: DEdge[]): Map<string, Point[]> => {
    const requests = (lines: DEdge[]) =>
      lines.map((e) => ({
        id: e.id,
        from: e.from,
        to: e.to,
        via: layout.edges[e.id]?.via,
        fromPoint: stubs.get(`${e.id}:from`)?.route ?? ports.get(e.id)?.from?.route,
        toPoint: stubs.get(`${e.id}:to`)?.route ?? ports.get(e.id)?.to?.route,
      }));
    const routes = routeEdges(avoid, routeShapes, requests(lines), obstacles, { mergeSharedEnds: merge });
    // Two kinds of failure: libavoid draws a straight line through everything when no route exists
    // (a door it can't reach), and a line can slip into a container through one line's door and out
    // through another's. Route those again on their own, so only their own doors are open, opened to the
    // whole side.
    if (obstacles.length) {
      const nodeBoxes = new Map(nodes.map((n) => [n.node.id, n.box]));
      /** What's wrong with a route: obstacles it runs through, plus containers it slips in and out of. */
      const faults = (e: DEdge, pts: Point[], walls: readonly Box[]) =>
        // A slanted segment is libavoid giving up (a straight line through everything): worse than any detour.
        10 * pts.slice(1).filter((p, i) => Math.abs(p[0] - pts[i]![0]) > 0.5 && Math.abs(p[1] - pts[i]![1]) > 0.5).length +
        walls.filter((o) => pathHitsBox(pts, o, 0.5)).length +
        2 * nodes.filter((n) => n.node.id !== e.from && n.node.id !== e.to && pathHitsBox(pts, nodeBoxes.get(n.node.id)!, 2)).length +
        fences.filter((c) => c.kind !== 'swimlane' && e.from !== c.id && e.to !== c.id && borderCrossings(pts, c.box) > (within(e.from, c.id) !== within(e.to, c.id) ? 1 : 0)).length;
      const stuck = lines.filter((e) => routes.get(e.id) && faults(e, routes.get(e.id)!, obstacles) > 0);
      if (stuck.length) {
        const ids = new Set(stuck.map((e) => e.id));
        const walls = containerObstacles(stuck, near, true);
        const again = routeEdges(avoid, routeShapes, requests(stuck), walls, { mergeSharedEnds: merge });
        const choose = (e: DEdge, candidates: [Point[] | undefined, readonly Box[]][]) => {
          let best = routes.get(e.id)!;
          let worst = faults(e, best, obstacles);
          for (const [pts, against] of candidates) {
            const n = pts ? faults(e, pts, against) : Infinity;
            if (pts && n < worst) [best, worst] = [pts, n];
          }
          routes.set(e.id, best);
          return worst;
        };
        const still = stuck.filter((e) => choose(e, [[again.get(e.id), walls]]) > 0);
        // Last resort, the router as it was before walls: round the boxes, through the containers.
        if (still.length) {
          const bare = routeEdges(avoid, routeShapes, requests(still), [], { mergeSharedEnds: merge });
          for (const e of still) choose(e, [[bare.get(e.id), []]]);
        }
      }
    }
    return routes;
  };
  /** A line as drawn: the route with its ports' outline points, or clipped to the end shapes. */
  const drawn = (e: DEdge, routes: Map<string, Point[]>): Point[] => {
    const from = byId.get(e.from);
    const to = byId.get(e.to);
    let points = routes.get(e.id) ?? [centreOf(e.from), centreOf(e.to)];
    const port = ports.get(e.id);
    if (port?.straight) points = [port.from!.outline, port.to!.outline];
    else if (routes.has(e.id) && points.length) {
      const user = layout.edges[e.id];
      const fromPort = port?.from ?? stubs.get(`${e.id}:from`);
      const toPort = port?.to ?? stubs.get(`${e.id}:to`);
      const slide = (id: string, p: Port, keep: boolean) => (keep ? undefined : byId.has(id) ? slideOnNode(byId.get(id)!, p) : slideOnBorder(id, p));
      if (fromPort) {
        const { lead, skip } = settleEnd(fromPort, points, slide(e.from, fromPort, !!user?.from));
        points = [...lead, ...points.slice(skip)];
      }
      if (toPort) {
        const { lead, skip } = settleEnd(toPort, [...points].reverse(), slide(e.to, toPort, !!user?.to));
        points = [...points.slice(0, points.length - skip), ...lead.reverse()];
      }
    }
    // Merged routing can slide a shared stretch off a pinned end's centre: run on into the centre first.
    if (merge && routes.has(e.id)) {
      if (from && !port?.from) points = [...toCentre([...points].reverse(), from).reverse()];
      if (to && !port?.to) points = toCentre(points, to);
    }
    if (from && !port?.from) points = clipStart(points, from.anchor);
    if (to && !port?.to) points = clipEnd(points, to.anchor);
    return simplify(points);
  };
  // While dragging there is no second routing: bundle the dragged lines only if nothing else would merge.
  if (bundled.size && reused.size) {
    const clash = clashingEnds(ends(routed), bundled);
    merge = !clash.stuck && !clash.fixable.length;
  }
  let routes = routeLines(routed);
  /**
   * Full builds: routes the bundles merged (see bundle.ts), after the first untangling, in place of the
   * plain re-route. Kept only where the drawn lines read better than `plain` (the first routing, as
   * drawn); true when kept.
   */
  const routeBundled = (plain: { e: DEdge; points: Point[] }[]): boolean => {
    // The bundles leave their sources from one spot (the centre pin, no port), and every other end that
    // shares a spot gets a port where its line already meets the node; then the bundles merge.
    const before = new Map(ports);
    for (const [id, end] of bundled) {
      const p = ports.get(id);
      if (p?.[end]) ports.set(id, { ...p, [end]: undefined });
    }
    const clash = clashingEnds(ends(routed), bundled);
    const frozen = clash.stuck ? undefined : clash.fixable.map((r) => {
      const pts = plain.find((l) => l.e === r.e)!.points;
      const [end, next] = r.end === 'from' ? [pts[0], pts[1]] : [pts[pts.length - 1], pts[pts.length - 2]];
      const n = byId.get(r.pin!);
      return { r, port: end && next && n ? portAt(n.anchor, n.box, end, next, ROUTING.shapeBuffer) : undefined };
    });
    let better = false;
    if (frozen?.every((f) => f.port)) {
      for (const { r, port } of frozen) ports.set(r.e.id, { ...ports.get(r.e.id), [r.end]: port });
      merge = true;
      const merged = routeLines(routed);
      // Kept only where it reads better: drawn lines, crossings once per spot.
      better = busyness(routed.map((e) => drawn(e, merged))) < busyness(plain.map((l) => l.points));
      if (better) routes = merged;
      else merge = false;
    }
    if (!better) {
      ports.clear();
      for (const [id, p] of before) ports.set(id, p);
    }
    return better;
  };
  // Lines that ran into one spot get spots of their own, and everything is routed again so nudging sees the
  // new ends. Full builds only: while dragging, the dragged lines keep the plain route until release. (Done
  // live, it needs a second routing of the dragged lines on nearly every frame: +1.3 ms median per drag
  // frame on food-delivery, 8.8 -> 10.1 ms, measured 2026-10-18; reusing last frame's spots instead can
  // lock a line to a stale side for the rest of the drag.)
  if (!reused.size && routed.length > 1) {
    const ctx = { nodes: byId, containers: fences, within, buffer: ROUTING.shapeBuffer, scale: theme.scale };
    // Twice at most: the second routing can bring two other ends together.
    for (let round = 0; round < 2; round++) {
      const lines = routed.map((e) => ({ e, points: drawn(e, routes) }));
      const changed = untangle(lines, ports, ctx);
      if (round === 0 && bundled.size && routeBundled(lines)) break;
      if (!changed.size) break;
      routes = routeLines(routed);
    }
  }

  const edges: SceneEdge[] = visible.map((e) => {
    const kept = reused.get(e.id);
    if (kept) return kept;
    const points = drawn(e, routes);
    return {
      edge: e,
      kind: e.kind,
      points,
      head: e.head,
      tail: e.tail,
      dashed: e.dashed,
      via: layout.edges[e.id]?.via ?? [],
      ...(layout.edges[e.id]?.from || layout.edges[e.id]?.to ? { fixedEnds: { from: !!layout.edges[e.id]!.from, to: !!layout.edges[e.id]!.to } } : {}),
    };
  });
  placeLabels(edges, reused, nodes, containers, layout, theme);

  if (template) {
    const why = new Map(template.violations.map((v) => [v.edge, v.message]));
    for (let i = 0; i < edges.length; i++) {
      const message = why.get(edges[i]!.edge.id);
      // Reused (drag fast path) lines are shared with the previous scene: copy before marking.
      if (message !== edges[i]!.violation) edges[i] = message ? { ...edges[i]!, violation: message } : { ...edges[i]!, violation: undefined };
    }
  }

  const all: Box[] = [...nodes.map((n) => n.box), ...containers.map((c) => c.box)];
  if (template && template.bounds.w > 0) all.push(template.bounds);
  for (const e of edges) for (const [x, y] of e.points) all.push({ x, y, w: 0, h: 0 });
  for (const e of edges) for (const l of [e.fromLabel, e.toLabel]) if (l) all.push({ x: l.x - l.text.width / 2, y: l.y - l.text.height / 2, w: l.text.width, h: l.text.height });
  for (const e of edges) if (e.label) all.push({ x: e.label.x - e.label.text.width / 2 - 6 * theme.scale, y: e.label.y - e.label.text.height / 2 - 2 * theme.scale, w: e.label.text.width + 12 * theme.scale, h: e.label.text.height + 4 * theme.scale });
  if (!all.length) all.push({ x: 0, y: 0, w: 0, h: 0 });
  const x0 = Math.min(...all.map((b) => b.x));
  const y0 = Math.min(...all.map((b) => b.y));
  const x1 = Math.max(...all.map((b) => b.x + b.w));
  const y1 = Math.max(...all.map((b) => b.y + b.h));
  // Ring titles step aside for lines and labels (the backdrop itself is derived from the members alone).
  const label = (e: SceneEdge): Box[] => (e.label ? [{ x: e.label.x - e.label.text.width / 2 - 4 * theme.scale, y: e.label.y - e.label.text.height / 2 - 2 * theme.scale, w: e.label.text.width + 8 * theme.scale, h: e.label.text.height + 4 * theme.scale }] : []);
  const shown = template?.kind === 'clean' ? nudgeRingTitles(template, edges.map((e) => e.points), [...nodes.map((n) => n.box), ...edges.flatMap(label)], theme) : template;
  return { kind: 'graph', theme, nodes, containers, edges, bounds: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }, template: shown };
}

/** A route that should end at `n`'s centre pin, carried on to it square if it stops short. */
function toCentre(points: Point[], n: SceneNode): Point[] {
  const last = points[points.length - 1];
  const c: Point = [n.anchor.cx, n.anchor.cy];
  if (!last || (Math.abs(last[0] - c[0]) < 0.5 && Math.abs(last[1] - c[1]) < 0.5)) return points;
  if (Math.abs(last[0] - c[0]) < 0.5 || Math.abs(last[1] - c[1]) < 0.5) return [...points, c];
  return [...points, [c[0], last[1]], c];
}

/**
 * A hand-chosen end as a port: on the outline at the stored fraction, routed
 * from straight out from there, just past the node's clearance (like the
 * automatic ports), so the line comes in square to the chosen side.
 */
function userPort(n: SceneNode, at: EndAttach, straight: number): Port {
  const outline = attachOutline(n.anchor, at);
  const b = n.box;
  // Past the clearance, and `straight` clear of the outline (the box can sit further out than the figure).
  const gap = at.side === 'top' ? outline[1] - b.y : at.side === 'bottom' ? b.y + b.h - outline[1] : at.side === 'left' ? outline[0] - b.x : b.x + b.w - outline[0];
  const d = Math.max(ROUTING.shapeBuffer + 1, straight - gap);
  const route: Point = at.side === 'top' ? [outline[0], b.y - d] : at.side === 'bottom' ? [outline[0], b.y + b.h + d] : at.side === 'left' ? [b.x - d, outline[1]] : [b.x + b.w + d, outline[1]];
  // A figure reaching past its box (shouldn't happen): step out from the outline instead.
  const ahead = at.side === 'top' ? route[1] < outline[1] : at.side === 'bottom' ? route[1] > outline[1] : at.side === 'left' ? route[0] < outline[0] : route[0] > outline[0];
  return { outline, route: ahead ? route : outward(outline, at.side, d) };
}

/**
 * A left-aligned title sitting right above an element that a line reaches
 * from above (an nwdiag host under its group's name, dropping from the
 * network bar) would make that line detour round the title. The title moves
 * right, past such elements, to the first stretch of the top border no line
 * comes through, if there is one.
 */
function shiftTitles(containers: SceneContainer[], nodes: SceneNode[], diagram: Diagram, layout: LayoutFile, theme: Theme) {
  if (theme.containerTitle !== 'caps') return;
  const byId = new Map(nodes.map((n) => [n.node.id, n]));
  const parentOf = new Map<string, string | undefined>([...diagram.nodes.map((n) => [n.id, n.parent] as const), ...diagram.containers.map((c) => [c.id, c.parent] as const)]);
  const inside = (id: string, c: string) => {
    for (let p = parentOf.get(id); p; p = parentOf.get(p)) if (p === c) return true;
    return false;
  };
  const centreY = (id: string) => byId.get(id)?.anchor.cy ?? containers.find((c) => c.id === id)?.box.y;
  for (const c of containers) {
    const t = c.title;
    if (!t || c.kind === 'state' || c.kind === 'swimlane') continue;
    // Spots on the top border lines come through: elements inside, reached from something above the container.
    const doors: [number, number][] = [];
    for (const e of diagram.edges) {
      if (e.hidden || layout.edges[e.id]?.via?.length) continue;
      for (const [a, b] of [[e.from, e.to], [e.to, e.from]] as const) {
        const n = byId.get(a);
        const oy = centreY(b);
        if (!n || !inside(a, c.id) || inside(b, c.id) || oy === undefined || oy >= c.box.y) continue;
        doors.push([n.box.x + n.box.w / 2 - 12, n.box.x + n.box.w / 2 + 12]);
      }
    }
    const clear = (x: number) => !doors.some(([lo, hi]) => lo < x + t.w && hi > x);
    if (!doors.length || clear(t.x)) continue;
    const starts = doors.map(([, hi]) => hi + 4).filter((x) => x > t.x).sort((a, b) => a - b);
    const x = starts.find((x) => clear(x) && x + t.w <= c.box.x + c.box.w - 8);
    if (x === undefined) continue;
    c.titleShift = x - t.x;
    c.title = { ...t, x };
  }
}

/**
 * A template's core as a routing fence: hexagonal only, the part of the
 * application hexagon between the inbound and outbound ports, holding the
 * application and domain elements. A line between two outside elements (an
 * external system and a driving adapter) goes round the hexagon instead of
 * through the middle of the core; lines to the core come in through doors.
 * Not drawn; bands and rings are crossed by design.
 */
function templateFence(t: TemplateScene, nodes: Map<string, SceneNode>): { container: SceneContainer; members: Set<string> } | undefined {
  const hex = t.hexagons[0];
  if (t.kind !== 'hexagonal' || !hex) return undefined;
  const members = new Set([...t.assigned].filter(([, layer]) => layer === 'application' || layer === 'domain').map(([id]) => id));
  const boxesOf = (layer: string) => [...t.assigned].filter(([, l]) => l === layer).flatMap(([id]) => (nodes.get(id) ? [nodes.get(id)!.box] : []));
  const core = [...members].flatMap((id) => (nodes.get(id) ? [nodes.get(id)!.box] : []));
  if (!core.length) return undefined;
  const half = (hex.r * Math.sqrt(3)) / 2;
  const inbound = boxesOf('inbound');
  const outbound = boxesOf('outbound');
  const coreLeft = Math.min(...core.map((b) => b.x)) - 16;
  const coreRight = Math.max(...core.map((b) => b.x + b.w)) + 16;
  // Between the port columns (they sit on the hexagon's left and right outline), never narrower than the core.
  const left = Math.min(coreLeft, inbound.length ? Math.max(...inbound.map((b) => b.x + b.w)) + 16 : hex.cx - hex.r / 2);
  const right = Math.max(coreRight, outbound.length ? Math.min(...outbound.map((b) => b.x)) - 16 : hex.cx + hex.r / 2);
  const top = Math.min(hex.cy - half, Math.min(...core.map((b) => b.y)) - 16);
  const bottom = Math.max(hex.cy + half, Math.max(...core.map((b) => b.y + b.h)) + 16);
  return { container: { id: 'template:core', kind: 'template', label: '', box: { x: left, y: top, w: right - left, h: bottom - top }, depth: 0 }, members };
}

/**
 * Labels for every line that was (re-)routed. Lines kept by the drag fast
 * path keep theirs; they and everything else are obstacles. End labels go
 * first (they have the least room), then the middle labels, shortest line
 * first. A label the user dragged stays at its offset from the middle.
 */
function placeLabels(edges: SceneEdge[], reused: Map<string, SceneEdge>, nodes: SceneNode[], containers: SceneContainer[], layout: LayoutFile, theme: Theme) {
  const k = theme.scale;
  const obstacles: LabelObstacles = {
    boxes: [...nodes.map((n) => n.box), ...containers.flatMap((c) => (c.title ? [c.title] : []))],
    labels: [],
    lines: new Map(edges.map((e) => [e.edge.id, e.points])),
    borders: containers.map((c) => c.box),
  };
  // Arrowheads (and diamonds, crow's feet) are part of the picture too: a box over each decorated end.
  const head = 14 * Math.sqrt(k);
  for (const e of edges) {
    for (const [kind, line] of [[e.head, e.points], [e.tail, [...e.points].reverse()]] as const) {
      if (kind === 'none' || line.length < 2) continue;
      const [x, y] = pointAt(line.slice(-2), 1 - Math.min(1, head / 2 / (pathLength(line.slice(-2)) || 1)));
      obstacles.boxes.push({ x: x - head / 2, y: y - head / 2, w: head, h: head });
    }
  }
  const chip = (t: TextBlock) => ({ w: t.width + 12 * k, h: t.height + 4 * k });
  const boxAt = (x: number, y: number, w: number, h: number): Box => ({ x: x - w / 2, y: y - h / 2, w, h });
  for (const e of edges) {
    if (!reused.has(e.edge.id)) continue;
    if (e.label) obstacles.labels.push(boxAt(e.label.x, e.label.y, chip(e.label.text).w, chip(e.label.text).h));
    for (const l of [e.fromLabel, e.toLabel]) if (l) obstacles.labels.push(boxAt(l.x, l.y, l.text.width, l.text.height));
  }
  const fresh = edges.filter((e) => !reused.has(e.edge.id));
  for (const e of fresh) {
    const ends: [string | undefined, Point[], ArrowHead, 'fromLabel' | 'toLabel'][] = [
      [e.edge.fromLabel, e.points, e.tail, 'fromLabel'],
      [e.edge.toLabel, [...e.points].reverse(), e.head, 'toLabel'],
    ];
    for (const [text, points, head, key] of ends) {
      if (!text || points.length < 2) continue;
      const block = measureSecondary(text, theme.size.edge, theme);
      const [x, y] = placeEndLabel(obstacles, e.edge.id, points, block, head === 'none' ? 2 * k : 14 * Math.sqrt(k), k);
      e[key] = { text: block, x, y };
      obstacles.labels.push(boxAt(x, y, block.width, block.height));
    }
  }
  // User-dragged labels are fixed: place them first so the others avoid them.
  const withLabel = fresh.filter((e) => e.edge.label).sort((a, b) => Number(!layout.edges[a.edge.id]?.label) - Number(!layout.edges[b.edge.id]?.label) || pathLength(a.points) - pathLength(b.points));
  for (const e of withLabel) {
    const text = measureSecondary(labelText(e.edge.label!, theme), theme.size.edge, theme);
    const { w, h } = chip(text);
    const [mx, my] = pointAt(e.points, 0.5);
    const user = layout.edges[e.edge.id]?.label;
    const [x, y] = user ? [mx + user[0], my + user[1]] : placeMidLabel(obstacles, e.edge.id, e.points, w, h, 18 * k);
    e.label = { text, x, y, offset: [x - mx, y - my] };
    obstacles.labels.push(boxAt(x, y, w, h));
  }
}

export function labelText(label: string, theme: Theme): string {
  return theme.plainLabels ? label.replace(/[«»]/g, '') : label;
}
