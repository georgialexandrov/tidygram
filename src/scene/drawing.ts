import type { LayoutFile, Point } from '../layout/layout-file.ts';
import type { DEdge, DNode, Diagram } from '../model/types.ts';
import { sourceCentre, type Box } from './containers.ts';
import { clipEnd, clipStart, pointAt, simplify } from './geometry.ts';
import { measureText, type TextBlock } from './measure.ts';
import type { Scene, SceneEdge, SceneNode } from './scene.ts';
import { nodeShape } from './shapes.ts';
import { themeOf, type Theme } from './theme.ts';

/**
 * Drawing mode (`Diagram.drawing`): a draw.io file that is a drawing of a
 * sequence, Gantt or timing diagram. Nothing is laid out or routed: every
 * shape sits at its file box (moved by the user's drags), every line runs
 * from its start point through the file's waypoints to its end point, with
 * its label where the file puts it. A line with a moved end is a straight
 * line between its end points.
 */

/** A draw.io style string as a map; bare names (`text`, `ellipse`) map to ''. */
export function drawnStyle(style: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const part of style.split(';')) {
    const t = part.trim();
    if (!t) continue;
    const eq = t.indexOf('=');
    if (eq < 0) map.set(t, '');
    else map.set(t.slice(0, eq).trim(), t.slice(eq + 1).trim());
  }
  return map;
}

export type DrawnShape = 'box' | 'frame' | 'note' | 'hexagon' | 'ellipse' | 'rhombus' | 'line' | 'text' | 'edges';

/** The shapes we draw as the file styles them; anything else (actors, cylinders, ...) is drawn by the theme at the file's box. */
export function drawnShape(style: Map<string, string>): DrawnShape | undefined {
  const shape = style.get('shape');
  if (shape === 'umlFrame') return 'frame';
  if (shape === 'note') return 'note';
  if (shape === 'hexagon') return 'hexagon';
  if (shape === 'partialRectangle') return 'edges';
  if (shape) return undefined;
  if (style.has('text')) return 'text';
  if (style.has('line')) return 'line';
  if (style.has('ellipse')) return 'ellipse';
  if (style.has('rhombus')) return 'rhombus';
  return 'box';
}

const num = (v: string | undefined, fallback = 0) => {
  const n = v === undefined ? NaN : Number(v);
  return Number.isFinite(n) ? n : fallback;
};

export interface DrawnText {
  block: TextBlock;
  /** x of the anchor (left edge, centre or right edge, by `align`) and the top of the first line. */
  x: number;
  top: number;
  align: 'start' | 'middle' | 'end';
  bold: boolean;
  italic: boolean;
  underline: boolean;
  fill: string;
}

/** The label of a shape drawn as the file styles it: its box (moved by the label offset), alignment, spacing, font. */
export function drawnText(node: DNode, box: Box, theme: Theme): DrawnText | undefined {
  const st = drawnStyle(node.drawn?.style ?? '');
  if (!node.label) return undefined;
  const fontStyle = num(st.get('fontStyle'));
  const bold = (fontStyle & 1) !== 0;
  const block = measureText(node.label, num(st.get('fontSize'), theme.size.node), bold, theme.widthFactor);
  let { x, y, w, h } = box;
  if (drawnShape(st) === 'frame') {
    // A UML frame's label sits in its tab.
    w = num(st.get('width'), 40);
    h = num(st.get('height'), 20);
  } else {
    x += node.drawn?.labelAt?.[0] ?? 0;
    y += node.drawn?.labelAt?.[1] ?? 0;
  }
  const left = num(st.get('spacingLeft'));
  const right = num(st.get('spacingRight'));
  const align = drawnShape(st) === 'frame' ? 'center' : (st.get('align') ?? 'center');
  const valign = drawnShape(st) === 'frame' ? 'middle' : (st.get('verticalAlign') ?? 'middle');
  const spaceTop = num(st.get('spacingTop'));
  const spaceBottom = num(st.get('spacingBottom'));
  const at = align === 'left' ? { x: x + left, align: 'start' as const } : align === 'right' ? { x: x + w - right, align: 'end' as const } : { x: x + w / 2 + (left - right) / 2, align: 'middle' as const };
  const top = valign === 'top' ? y + spaceTop : valign === 'bottom' ? y + h - block.height - spaceBottom : y + h / 2 - block.height / 2 + (spaceTop - spaceBottom) / 2;
  return { block, ...at, top, bold, italic: (fontStyle & 2) !== 0, underline: (fontStyle & 4) !== 0, fill: st.get('fontColor') && st.get('fontColor') !== 'none' ? st.get('fontColor')! : theme.colors.text };
}

/** The theme with the file's page background, one object per pair so memoised views stay put. */
const themes = new Map<Theme, Map<string, Theme>>();
function onBackground(theme: Theme, background: string | undefined): Theme {
  if (!background || background === 'none') return theme;
  let byBackground = themes.get(theme);
  if (!byBackground) themes.set(theme, (byBackground = new Map()));
  let themed = byBackground.get(background);
  if (!themed) byBackground.set(background, (themed = { ...theme, colors: { ...theme.colors, background } }));
  return themed;
}

export function buildDrawingScene(diagram: Diagram, layout: LayoutFile): Scene {
  // The view's scale belongs to laid-out diagrams: a drawing keeps the file's sizes.
  const theme = onBackground(themeOf({ theme: layout.view?.theme }), diagram.background);
  const moved = new Map<string, [number, number]>();
  const refs = new Map<string, Box>();
  const nodes: SceneNode[] = diagram.nodes.map((n) => {
    const shape = nodeShape(n, theme);
    const sb = n.sourceBox ?? { x: 0, y: 0, w: shape.w, h: shape.h };
    const home = sourceCentre({ ...n, sourceBox: sb }, shape)!;
    const p = layout.nodes[n.id] ?? home;
    const d: [number, number] = [p.x - home.x, p.y - home.y];
    moved.set(n.id, d);
    refs.set(n.id, { x: sb.x + d[0], y: sb.y + d[1], w: sb.w, h: sb.h });
    const plain = n.drawn && drawnShape(drawnStyle(n.drawn.style));
    const box: Box = plain ? refs.get(n.id)! : { x: p.x - shape.w / 2, y: p.y - shape.h / 2, w: shape.w, h: shape.h };
    const anchor = plain ? { cx: box.x + box.w / 2, cy: box.y + box.h / 2, w: box.w, h: box.h, dx: 0, dy: 0, shape: 'rect' as const } : { ...shape.anchor, cx: p.x + shape.anchor.dx, cy: p.y + shape.anchor.dy };
    return { node: n, shape, box, anchor, pinned: layout.nodes[n.id]?.pinned === true };
  });
  const byId = new Map(nodes.map((n) => [n.node.id, n]));

  const edges: SceneEdge[] = [];
  for (const e of diagram.edges) {
    const a = byId.get(e.from);
    const b = byId.get(e.to);
    if (e.hidden || !a || !b) continue;
    edges.push(drawnEdge(e, a, b, refs, moved, theme));
  }

  const all: Box[] = nodes.map((n) => n.box);
  for (const n of nodes) {
    const t = n.node.drawn && drawnShape(drawnStyle(n.node.drawn.style)) ? drawnText(n.node, n.box, theme) : undefined;
    if (t) all.push({ x: t.align === 'start' ? t.x : t.align === 'end' ? t.x - t.block.width : t.x - t.block.width / 2, y: t.top, w: t.block.width, h: t.block.height });
  }
  for (const e of edges) {
    for (const [x, y] of e.points) all.push({ x, y, w: 0, h: 0 });
    if (e.label) all.push({ x: e.label.x - e.label.text.width / 2, y: e.label.y - e.label.text.height / 2, w: e.label.text.width, h: e.label.text.height });
  }
  if (!all.length) all.push({ x: 0, y: 0, w: 0, h: 0 });
  const x0 = Math.min(...all.map((b) => b.x));
  const y0 = Math.min(...all.map((b) => b.y));
  const bounds = { x: x0, y: y0, w: Math.max(...all.map((b) => b.x + b.w)) - x0, h: Math.max(...all.map((b) => b.y + b.h)) - y0 };
  return { kind: 'graph', theme, nodes, containers: [], edges, bounds, drawing: true };
}

function drawnEdge(e: DEdge, a: SceneNode, b: SceneNode, refs: Map<string, Box>, moved: Map<string, [number, number]>, theme: Theme): SceneEdge {
  const still = [a, b].every((n) => Math.hypot(...moved.get(n.node.id)!) < 0.5);
  const end = (n: SceneNode, at: [number, number] | undefined): Point | undefined => {
    const r = refs.get(n.node.id)!;
    return at && n.node.sourceBox ? [r.x + at[0] * r.w, r.y + at[1] * r.h] : undefined;
  };
  const start = end(a, e.sourceFrom);
  const finish = end(b, e.sourceTo);
  // The file's waypoints verbatim; with an end moved, they no longer fit and the line is straight.
  const via = still ? (e.sourceVia ?? []) : [];
  let points: Point[] = [start ?? [a.anchor.cx, a.anchor.cy], ...via, finish ?? [b.anchor.cx, b.anchor.cy]];
  if (!start) points = clipStart(points, a.anchor);
  if (!finish) points = clipEnd(points, b.anchor);
  points = still ? points : simplify(points);
  const out: SceneEdge = { edge: e, kind: e.kind, points, head: e.head, tail: e.tail, dashed: e.dashed, via: [] };
  if (e.label) {
    const st = drawnStyle(e.drawn?.style ?? '');
    const text = measureText(e.label, num(st.get('fontSize'), theme.size.edge), false, theme.widthFactor);
    const [mx, my] = pointAt(points, 0.5);
    const [ox, oy] = e.drawn?.labelAt ?? [0, 0];
    // draw.io centres an edge's label on the line's middle; `verticalAlign=bottom` lifts it clear above, `align=left` starts it at the middle.
    const x = st.get('align') === 'left' ? mx + num(st.get('spacingLeft')) + text.width / 2 : mx;
    const y = st.get('verticalAlign') === 'bottom' ? my - text.height / 2 - 2 : my;
    out.label = { text, x: x + ox, y: y + oy, offset: [x + ox - mx, y + oy - my] };
  }
  return out;
}
