import type { Diagram } from '../model/types.ts';
import { buildAnyScene } from '../scene/any.ts';
import type { Avoid } from '../scene/avoid.ts';
import { buildScene } from '../scene/scene.ts';
import { containerBoxes, nodeBox, type Box, type Positions } from '../scene/containers.ts';
import type { NodeShape } from '../scene/shapes.ts';
import { scaledTheme, themeFor, themeOf, type Theme } from '../scene/theme.ts';
import { containerPad } from '../scene/shapes.ts';
import { largestScale } from './scale.ts';
import { elkPositions, shapesFor } from './auto.ts';
import type { LayoutFile, Point } from './layout-file.ts';

/**
 * Fit to frame: re-lays out the diagram so it fills a target aspect ratio.
 *
 * 1. Try several ELK configurations (flow direction, wrapping long graphs
 *    into rows, laying containers out in their own direction).
 * 2. Score each by density: the content's area over the area of the
 *    smallest frame of the target ratio that holds it. Higher density means
 *    the diagram can be drawn larger in the frame. With the router at hand,
 *    each candidate's lines are actually routed and crossings and total line
 *    length count against it; density alone rewards tangled layouts.
 * 3. Stretch the winner along its short axis toward the ratio. The frame
 *    doesn't grow (the stretch stays within it); it just moves the empty
 *    margin in between the elements. Scaling centres apart only widens gaps,
 *    so no overlaps. Capped, so diagrams don't turn sparse.
 * Coordinates land on a 4px grid.
 */

export interface FitResult {
  layout: LayoutFile;
  /** Aspect ratio of the result's bounding box. */
  achieved: number;
  /** Size factor for text and icons that the free space allowed. */
  scale: number;
  /** Fraction of the frame's area the diagram's bounding box covers. */
  fill: number;
  variant: string;
  tried: number;
  /** Milliseconds per phase: laying out candidates, routing the finalists, growing the size. */
  timings: { layout: number; route: number; scale: number };
}

const MAX_STRETCH = 1.6;

function bounds(diagram: Diagram, positions: Positions, shapes: Map<string, NodeShape>, theme?: Theme): Box {
  const boxes = diagram.nodes.filter((n) => positions[n.id]).map((n) => nodeBox(positions[n.id]!, shapes.get(n.id)!));
  boxes.push(...containerBoxes(diagram, positions, shapes, theme ? containerPad(theme) : undefined).values());
  const x0 = Math.min(...boxes.map((b) => b.x));
  const y0 = Math.min(...boxes.map((b) => b.y));
  const x1 = Math.max(...boxes.map((b) => b.x + b.w));
  const y1 = Math.max(...boxes.map((b) => b.y + b.h));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

function stretch(positions: Positions, box: Box, sx: number, sy: number): Positions {
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  return Object.fromEntries(Object.entries(positions).map(([id, p]) => [id, { x: cx + (p.x - cx) * sx, y: cy + (p.y - cy) * sy }]));
}

type Candidate = { name: string; scale: number; shapes: Map<string, NodeShape>; theme: Theme; run: () => Promise<Positions> };

// Spacing reshapes a layered layout without changing its order: tight layers + roomy rows make it narrower, and vice versa.
const SPACINGS = [
  { node: 32, layer: 70 },
  { node: 64, layer: 40 },
  { node: 96, layer: 36 },
  { node: 24, layer: 110 },
];

/**
 * Element sizes to lay out at. Line corridors are a fixed number of pixels,
 * so laying out bigger elements makes text larger relative to the whole frame.
 */
const SCALES = [1.6, 2.6];

function candidates(diagram: Diagram, base: Theme, view: LayoutFile['view']): Candidate[] {
  const list: Candidate[] = [];
  for (const scale of SCALES) {
    const theme = scaledTheme(base, scale, view?.text ?? 1, view?.icons ?? 1);
    const shapes = shapesFor(diagram, theme);
    for (const direction of ['RIGHT', 'DOWN'] as const) {
      for (const spacing of SPACINGS) {
        list.push({
          name: `${direction === 'RIGHT' ? 'left→right' : 'top→down'}, gaps ${spacing.node}/${spacing.layer}, size ${Math.round(scale * 100)}%`,
          scale,
          shapes,
          theme,
          run: () => elkPositions(diagram, shapes, theme, { direction, hierarchy: 'include', spacing }),
        });
      }
    }
  }
  return list;
}

/** Crossings between straight centre-to-centre lines: a cheap stand-in for routed crossings. */
function straightCrossings(segments: [Point, Point, string, string][]): number {
  const orient = (a: Point, b: Point, c: Point) => Math.sign((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]));
  let count = 0;
  for (let i = 0; i < segments.length; i++) {
    const [a, b, ea, eb] = segments[i]!;
    for (let j = i + 1; j < segments.length; j++) {
      const [c, d, ec, ed] = segments[j]!;
      if (ea === ec || ea === ed || eb === ec || eb === ed) continue; // sharing an endpoint is not a crossing
      if (orient(a, b, c) * orient(a, b, d) < 0 && orient(c, d, a) * orient(c, d, b) < 0) count++;
    }
  }
  return count;
}

const debug = (...args: unknown[]) => {
  if (typeof process !== 'undefined' && process.env?.FIT_DEBUG) console.log(...args);
};

/** Number of proper crossings between the orthogonal segments of different lines. */
export function countCrossings(lines: Point[][]): number {
  type Seg = { a: Point; b: Point; line: number };
  const horizontal: Seg[] = [];
  const vertical: Seg[] = [];
  lines.forEach((pts, line) => {
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1]!;
      const b = pts[i]!;
      if (Math.abs(a[1] - b[1]) < 0.5) horizontal.push({ a, b, line });
      else if (Math.abs(a[0] - b[0]) < 0.5) vertical.push({ a, b, line });
    }
  });
  let crossings = 0;
  for (const h of horizontal) {
    const [x0, x1] = [Math.min(h.a[0], h.b[0]), Math.max(h.a[0], h.b[0])];
    const y = h.a[1];
    for (const v of vertical) {
      if (v.line === h.line) continue;
      const x = v.a[0];
      const [y0, y1] = [Math.min(v.a[1], v.b[1]), Math.max(v.a[1], v.b[1])];
      if (x > x0 + 0.5 && x < x1 - 0.5 && y > y0 + 0.5 && y < y1 - 0.5) crossings++;
    }
  }
  return crossings;
}

/**
 * Ordered diagrams (sequence, Gantt, timing) have no free positions, only gaps: search size × column gap × row gap and keep
 * the combination whose text ends up largest in the frame. Dragged columns are released.
 */
function fitOrdered(diagram: Diagram, layout: LayoutFile, frame: Point): FitResult {
  const started = performance.now();
  const ratio = frame[0] / frame[1];
  let best: { score: number; view: NonNullable<LayoutFile['view']>; achieved: number; fill: number; name: string } | undefined;
  let tried = 0;
  for (const scale of [1, 1.4, 1.8, 2.4]) {
    for (const gx of [1, 1.5, 2.2, 3.2, 4.5]) {
      for (const gy of [1, 1.4, 2, 2.8]) {
        tried++;
        const view = { ...layout.view, frame, scale, spacing: [gx, gy] as Point };
        const b = buildAnyScene(diagram, { ...layout, view, nodes: {} }, undefined).bounds;
        const frameW = Math.max(b.w, b.h * ratio);
        // Text size as it lands in the frame, with a small bonus for actually using the frame.
        const fill = (b.w * b.h) / (frameW * (frameW / ratio));
        const score = Math.log(scale / frameW) + 0.15 * Math.log(fill);
        if (!best || score > best.score) best = { score, view, achieved: b.w / b.h, fill, name: `size ${Math.round(scale * 100)}%, gaps ${gx}×/${gy}×` };
      }
    }
  }
  const view = { ...best!.view };
  if (view.scale === 1) delete view.scale;
  if (view.spacing![0] === 1 && view.spacing![1] === 1) delete view.spacing;
  return {
    layout: { ...layout, view, nodes: {}, edges: {} },
    achieved: best!.achieved,
    scale: best!.view.scale ?? 1,
    fill: best!.fill,
    variant: best!.name,
    tried,
    timings: { layout: Math.round(performance.now() - started), route: 0, scale: 0 },
  };
}

export async function fitToFrame(diagram: Diagram, layout: LayoutFile, frame: Point, avoid?: Avoid): Promise<FitResult> {
  if (diagram.special) return fitOrdered(diagram, layout, frame);
  const ratio = frame[0] / frame[1];
  const theme = themeFor(layout.view?.theme);
  const shapes = shapesFor(diagram, theme);
  const nodeIds = new Set(diagram.nodes.map((n) => n.id));
  // Lines to containers (composite states, boundaries) have no node position to score with.
  const edges = diagram.edges.filter((e) => e.from !== e.to && nodeIds.has(e.from) && nodeIds.has(e.to));
  const list = candidates(diagram, theme, layout.view);

  // Pass 1: lay out every candidate and score it cheaply (density, straight-line length and crossings).
  type Scored = { positions: Positions; score: number; name: string; density: number; side: number; candidate: Candidate };
  const scored: Scored[] = [];
  // All candidates are independent: start them together (in parallel when ELK runs in workers).
  const started = performance.now();
  const results = await Promise.all(
    list.map((c) =>
      c.run().then(
        (positions) => ({ positions, error: undefined }),
        (error: unknown) => ({ positions: undefined, error }),
      ),
    ),
  );
  const layoutMs = performance.now() - started;
  debug(`laid out ${list.length} candidates in ${Math.round(layoutMs)}ms`);
  for (const [i, candidate] of list.entries()) {
    const { name } = candidate;
    const { positions, error } = results[i]!;
    if (!positions) {
      debug(name, 'failed:', error);
      continue; // some option combinations are rejected by ELK; skip them
    }
    if (diagram.nodes.some((n) => !positions[n.id])) continue;
    const b = bounds(diagram, positions, candidate.shapes, candidate.theme);
    // Content area at this candidate's size over the frame it needs: how large the text ends up in the frame.
    const contentArea = diagram.nodes.reduce((sum, n) => sum + candidate.shapes.get(n.id)!.w * candidate.shapes.get(n.id)!.h, 0);
    const frameArea = b.w / b.h < ratio ? b.h * b.h * ratio : (b.w * b.w) / ratio;
    const density = contentArea / frameArea;
    const side = Math.sqrt(frameArea);
    const segments = edges.map((e): [Point, Point, string, string] => [
      [positions[e.from]!.x, positions[e.from]!.y],
      [positions[e.to]!.x, positions[e.to]!.y],
      e.from,
      e.to,
    ]);
    const length = segments.reduce((sum, [a, b2]) => sum + Math.abs(a[0] - b2[0]) + Math.abs(a[1] - b2[1]), 0) / Math.max(1, edges.length) / side;
    const crossings = straightCrossings(segments);
    const score = Math.log(density) - length - 1.5 * (crossings / Math.max(1, edges.length));
    debug(name.padEnd(72), `density ${density.toFixed(3)} len ${length.toFixed(3)} x ${crossings} → ${score.toFixed(3)}`);
    scored.push({ positions, score, name, density, side, candidate });
  }
  scored.sort((a, b) => b.score - a.score);

  // Pass 2: route the few best for real and judge them on actual crossings and line length.
  const routeStarted = performance.now();
  let best: Scored | undefined;
  if (avoid) {
    let bestScore = -Infinity;
    for (const c of scored.slice(0, 3)) {
      const t0 = performance.now();
      const trial: LayoutFile = { ...layout, view: { ...layout.view, scale: c.candidate.scale }, nodes: Object.fromEntries(Object.entries(c.positions).map(([id, p]) => [id, { x: p.x, y: p.y }])), edges: {} };
      const lines = buildScene(diagram, trial, avoid).edges.map((e) => e.points);
      const length = lines.reduce((sum, pts) => sum + pts.slice(1).reduce((l, p, i) => l + Math.abs(p[0] - pts[i]![0]) + Math.abs(p[1] - pts[i]![1]), 0), 0);
      const crossings = countCrossings(lines);
      const score = Math.log(c.density) - length / Math.max(1, lines.length) / c.side - 1.5 * (crossings / Math.max(1, lines.length));
      debug('routed', c.name.padEnd(64), `${Math.round(performance.now() - t0)}ms crossings ${crossings} → ${score.toFixed(3)}`);
      if (score > bestScore) {
        bestScore = score;
        best = c;
      }
    }
  } else {
    best = scored[0];
  }
  if (!best) throw new Error('No layout variant succeeded');
  const routeMs = performance.now() - routeStarted;

  const b0 = bounds(diagram, best.positions, best.candidate.shapes, best.candidate.theme);
  const r0 = b0.w / b0.h;
  const sx = r0 < ratio ? Math.min(ratio / r0, MAX_STRETCH) : 1;
  const sy = r0 > ratio ? Math.min(r0 / ratio, MAX_STRETCH) : 1;
  const positions = stretch(best.positions, b0, sx, sy);
  const snap = (v: number) => Math.round(v / 4) * 4;
  const nodes: LayoutFile['nodes'] = Object.fromEntries(
    Object.entries(layout.nodes).filter(([id]) => !shapes.has(id)), // keep entries for ids not in the source
  );
  for (const n of diagram.nodes) nodes[n.id] = { x: snap(positions[n.id]!.x), y: snap(positions[n.id]!.y) };
  const { scale: _old, ...view } = layout.view ?? {};
  const fitted: LayoutFile = { ...layout, view: { ...view, frame }, nodes, edges: {} };
  // Then grow text and icons into whatever room the stretch left.
  const scaleStarted = performance.now();
  const scale = Math.max(best.candidate.scale, largestScale(diagram, fitted));
  if (scale !== 1) fitted.view!.scale = scale;
  const scaleMs = performance.now() - scaleStarted;

  const finalTheme = themeOf(fitted.view);
  const b = bounds(diagram, fitted.nodes as Positions, shapesFor(diagram, finalTheme), finalTheme);
  const achieved = b.w / b.h;
  const frameArea = achieved < ratio ? b.h * b.h * ratio : (b.w * b.w) / ratio;
  return {
    layout: fitted,
    achieved,
    scale,
    fill: (b.w * b.h) / frameArea,
    variant: best.name,
    tried: list.length,
    timings: { layout: Math.round(layoutMs), route: Math.round(routeMs), scale: Math.round(scaleMs) },
  };
}
