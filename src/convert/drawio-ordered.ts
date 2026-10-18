import type { LayoutFile, Point } from '../layout/layout-file.ts';
import { parseDrawio } from '../model/drawio.ts';
import type { GanttModel, ParseWarning, SeqHead, SequenceModel, TimingModel } from '../model/types.ts';
import type { AnyScene } from '../scene/any.ts';
import type { Box } from '../scene/containers.ts';
import { buildGanttScene, buildTimingScene, type GanttScene, type TimingScene } from '../scene/gantt.ts';
import type { SceneNode } from '../scene/scene.ts';
import { buildSequenceScene, type SequenceScene } from '../scene/sequence.ts';
import { pointAt } from '../scene/geometry.ts';
import { FREE_SIZE } from '../scene/shapes.ts';
import { accentTint, mix, type Theme } from '../scene/theme.ts';
import { KindLosses, warn, type ConvertResult, type IdMap } from './common.ts';
import { attr, foldLabel, html, KIND_STYLE, mxfile, r, viewOnly } from './drawio.ts';

/**
 * Sequence, Gantt and timing diagrams → draw.io, as drawings. draw.io has
 * no sequence or time-axis model, so the built scene is drawn shape by shape
 * the way we render it (same geometry, the theme's colours and text sizes),
 * using draw.io's own idioms where they exist: UML frames for fragments,
 * notes, vertical `line` shapes for lifelines, straight edges with
 * `verticalAlign=bottom` for messages. Everything a line ends on is a
 * vertex, so the file reads back without loose ends: participants, tasks
 * and signals become boxes and messages/dependencies become lines between
 * them. Reading it back does not give a sequence (or Gantt
 * or timing) model again; the PlantUML/Mermaid sources stay the editable
 * copy. The file is marked (`pumlDrawing=` on the layer cell), so our reader
 * opens it as a drawing: the file's geometry as it is, no re-layout, no
 * re-routing (`Diagram.drawing`).
 */
export function orderedToDrawio(model: SequenceModel | GanttModel | TimingModel, layout: LayoutFile, given?: AnyScene): ConvertResult {
  const losses = new KindLosses();
  const warnings: ParseWarning[] = [];
  const page = new Page();
  let theme: Theme;
  if (model.type === 'sequence') {
    const scene = given?.kind === 'sequence' ? given : buildSequenceScene(model, layout);
    theme = scene.theme;
    sequenceCells(scene, page);
    warnings.push(warn('Sequence diagram written as a drawing: draw.io has no sequence model, so it reads back as boxes and lines'));
  } else if (model.type === 'gantt') {
    const scene = given?.kind === 'gantt' ? given : buildGanttScene(model, layout);
    theme = scene.theme;
    ganttCells(scene, page);
    warnings.push(warn('Gantt chart written as a drawing: tasks and dependencies read back as boxes and lines, not a schedule'));
  } else {
    const scene = given?.kind === 'timing' ? given : buildTimingScene(model, layout);
    theme = scene.theme;
    timingCells(scene, page);
    warnings.push(warn('Timing diagram written as a drawing: signals and messages read back as boxes and lines, not waveforms'));
  }
  const source = mxfile(page.cells, { background: theme.colors.background, drawing: model.type });

  // Map what reads back: participants/tasks/signals → their box, messages → their line.
  const parsed = parseDrawio(source).diagram;
  const present = new Set(parsed.nodes.map((n) => n.id));
  const presentEdges = new Set(parsed.edges.map((e) => e.id));
  const ids: IdMap = { nodes: {}, edges: {} };
  for (const [from, to] of page.named) if (present.has(to)) ids.nodes[from] = to;
  for (const [from, to] of page.namedEdges) if (presentEdges.has(to)) ids.edges[from] = to;
  return { source, layout: viewOnly(layout, warnings), warnings: [...warnings, ...losses.warnings('draw.io')], ids };
}

// ---- cells ---------------------------------------------------------------------------------------

/** Cells in drawing order (later on top), with one id namespace and the model id → cell id maps. */
class Page {
  cells: string[] = [];
  named = new Map<string, string>();
  namedEdges = new Map<string, string>();
  private used = new Set(['0', '1']);

  id(base: string): string {
    const clean = base || 'cell';
    let id = clean;
    for (let i = 2; this.used.has(id); i++) id = `${clean}-${i}`;
    this.used.add(id);
    return id;
  }

  /** A vertex; `labelAt` moves its label (draw.io's geometry offset) so the text sits where we draw it. */
  vertex(base: string, value: string, style: string, box: Box, labelAt?: Point): string {
    const id = this.id(base);
    const offset = labelAt ? `<mxPoint x="${r(labelAt[0])}" y="${r(labelAt[1])}" as="offset" />` : '';
    const geometry = `<mxGeometry x="${r(box.x)}" y="${r(box.y)}" width="${r(Math.max(box.w, 1))}" height="${r(Math.max(box.h, 1))}" as="geometry">${offset}</mxGeometry>`;
    this.cells.push(`<mxCell id="${attr(id)}" value="${attr(value)}" style="${style}html=1;" vertex="1" parent="1">${geometry}</mxCell>`);
    return id;
  }

  /** Text without a box. */
  text(base: string, value: string, box: Box, style: string): string {
    return this.vertex(base, value, `text;strokeColor=none;fillColor=none;whiteSpace=nowrap;overflow=visible;${style}`, box);
  }

  /** A horizontal or vertical stroke: draw.io's `line` shape (a vertex, so it never reads back as a loose line). */
  line(base: string, x0: number, y0: number, x1: number, y1: number, style: string): string {
    const vertical = Math.abs(x1 - x0) < Math.abs(y1 - y0);
    const box = vertical ? { x: x0 - 4, y: Math.min(y0, y1), w: 8, h: Math.abs(y1 - y0) } : { x: Math.min(x0, x1), y: y0 - 4, w: Math.abs(x1 - x0), h: 8 };
    // draw.io's `line` style is 4px wide by default.
    return this.vertex(base, '', `line;strokeWidth=1;fillColor=none;${vertical ? 'direction=south;' : ''}${style}`, box);
  }

  /** A line between two vertices; `labelOffset` moves its label off the middle (draw.io's geometry offset). */
  edge(base: string, value: string, style: string, source: string, target: string, points: Point[] = [], labelOffset?: Point): string {
    const id = this.id(base);
    const array = points.length ? `<Array as="points">${points.map(([x, y]) => `<mxPoint x="${r(x)}" y="${r(y)}" />`).join('')}</Array>` : '';
    const offset = labelOffset ? `<mxPoint x="${r(labelOffset[0])}" y="${r(labelOffset[1])}" as="offset" />` : '';
    this.cells.push(`<mxCell id="${attr(id)}" value="${attr(value)}" style="${style}html=1;" edge="1" parent="1" source="${attr(source)}" target="${attr(target)}"><mxGeometry relative="1" as="geometry">${array}${offset}</mxGeometry></mxCell>`);
    return id;
  }
}

const font = (theme: Theme, size: number, colour: string) => `fontFamily=Helvetica;fontSize=${Math.round(size * 10) / 10};fontColor=${colour};`;
// Not clamped: a message end a pixel off its bar stays where it is (draw.io takes fractions outside 0..1); four places keep a long lifeline exact.
const frac = (v: number, from: number, size: number) => Math.round((size ? (v - from) / size : 0.5) * 10000) / 10000;
/** Where on a box a line is pinned (`exitX/exitY` or `entryX/entryY`), as fractions of the box. */
const pinAt = (which: 'exit' | 'entry', [x, y]: Point, box: Box) => `${which}X=${frac(x, box.x, box.w)};${which}Y=${frac(y, box.y, box.h)};${which}Dx=0;${which}Dy=0;${which}Perimeter=0;`;

// ---- sequence ------------------------------------------------------------------------------------

/** Our message ends → draw.io markers (`openAsync` is the half arrow of an asynchronous call). */
const SEQ_MARKERS: Record<SeqHead, string> = { arrow: 'block;Fill=1', open: 'open;Fill=0', half: 'openAsync;Fill=0', cross: 'cross;Fill=0', circle: 'oval;Fill=0', none: 'none;Fill=0' };
const seqMarker = (end: 'end' | 'start', head: SeqHead) => {
  const [marker, fill] = SEQ_MARKERS[head].split(';Fill=');
  return `${end}Arrow=${marker};${end}Fill=${fill};`;
};

function sequenceCells(scene: SequenceScene, page: Page): void {
  const { theme } = scene;
  const c = theme.colors;
  const k = theme.scale;
  const edgeFont = font(theme, theme.size.edge, c.text);
  const noteFont = font(theme, theme.size.note, c.noteText);
  const frame = theme.plantuml ? c.shapeStroke : mix(c.shapeStroke, c.text, 0.25);

  // Participant groups (`box`) at the bottom; fragments go over the activation bars, as we draw them.
  for (const b of scene.boxes) {
    page.vertex('box', html(b.label.lines.join('\n')), `rounded=1;arcSize=${Math.round(theme.containerRadius)};absoluteArcSize=1;fillColor=${c.containerFill};strokeColor=${c.containerStroke};verticalAlign=top;spacingTop=6;fontStyle=1;${font(theme, theme.size.container, c.title)}`, b.box);
  }
  for (const d of scene.dividers) {
    page.line('divider', d.x0, d.y - 2 * k, d.x1, d.y - 2 * k, `strokeColor=${c.grid};`);
    page.line('divider', d.x0, d.y + 2 * k, d.x1, d.y + 2 * k, `strokeColor=${c.grid};`);
    const w = d.label.width + 20 * k;
    const h = d.label.height + 8 * k;
    page.vertex('divider-label', html(d.label.lines.join('\n')), `rounded=1;arcSize=50;fillColor=${c.surface};strokeColor=${c.grid};fontStyle=1;${font(theme, theme.size.edge, c.title)}`, { x: (d.x0 + d.x1) / 2 - w / 2, y: d.y - h / 2, w, h });
  }
  for (const d of scene.delays) {
    if (d.label) page.text('delay', html(d.label.lines.join('\n')), { x: d.x - d.label.width / 2 - 4, y: (d.y0 + d.y1) / 2 - d.label.height / 2, w: d.label.width + 8, h: d.label.height }, `align=center;verticalAlign=middle;fontStyle=2;${font(theme, theme.size.edge, c.muted)}`);
  }

  // Lifelines and activation bars: everything a message can end on.
  const anchors: { id: string; box: Box }[] = [];
  const lifelines = new Map<string, { id: string; box: Box }[]>();
  const cuts = [...scene.delays].sort((a, b) => a.y0 - b.y0);
  // Same stroke as SequenceSvg draws: colour, 1 px width and dash.
  const lifeStroke = theme.plantuml ? c.line : mix(c.grid, c.line, 0.5);
  const lifeDash = `dashed=1;strokeWidth=1;dashPattern=${+((theme.plantuml ? 5 : 4) * theme.scale).toFixed(2)} ${+(4 * theme.scale).toFixed(2)};`;
  for (const l of scene.lifelines) {
    // A box whose left border is the lifeline: unlike a rotated `line` shape, its exit/entry fractions aren't turned.
    const segment = (y0: number, y1: number, style: string, name: string) => {
      const box = { x: l.x, y: y0, w: 10, h: Math.max(1, y1 - y0) };
      return { id: page.vertex(name, '', `shape=partialRectangle;top=0;right=0;bottom=0;left=1;fillColor=none;strokeColor=${lifeStroke};${style}`, box), box };
    };
    // A delay cuts the lifeline: dashed above and below, a dotted stretch across it (as we draw it).
    const parts: { id: string; box: Box }[] = [];
    let y = l.y0;
    for (const d of cuts) {
      if (d.y1 <= y || d.y0 >= l.y1) continue;
      const from = Math.max(y, d.y0);
      if (from > y) parts.push(segment(y, from, lifeDash, `${l.id}-lifeline`));
      const to = Math.min(l.y1, d.y1);
      segment(from, to, `dashed=1;dashPattern=${theme.scale} ${4 * theme.scale};strokeWidth=1.5;strokeColor=${lifeStroke};`, `${l.id}-delay`);
      y = to;
    }
    if (l.y1 > y || !parts.length) parts.push(segment(y, l.y1, lifeDash, `${l.id}-lifeline`));
    lifelines.set(l.id, parts);
  }
  const barFill = theme.plantuml ? c.shapeFill : accentTint(theme, 0.12);
  const barStroke = theme.plantuml ? c.shapeStroke : accentTint(theme, 0.35);
  for (const a of scene.activations) {
    anchors.push({ id: page.vertex('activation', '', `rounded=0;fillColor=${barFill};strokeColor=${barStroke};`, a), box: a });
  }
  const tabStyle = `fillColor=none;strokeColor=${frame};swimlaneFillColor=none;${font(theme, theme.size.edge, c.title)}fontStyle=1;`;
  for (const g of [...scene.groups].sort((a, b) => b.box.w * b.box.h - a.box.w * a.box.h)) {
    const tabW = Math.round(theme.size.edge * 0.62 * g.kind.length + 22 * k);
    const tabH = Math.round(20 * k);
    page.vertex(`fragment-${g.kind}`, html(g.kind), `shape=umlFrame;width=${tabW};height=${tabH};${tabStyle}`, g.box);
    if (g.label.lines.join('')) page.text('guard', html(g.label.lines.join('\n')), { x: g.box.x + tabW + 6 * k, y: g.box.y, w: g.label.width + 4, h: tabH }, `align=left;verticalAlign=middle;${edgeFont}fontColor=${c.muted};`);
    for (const e of g.elses) {
      page.line('else', g.box.x, e.y, g.box.x + g.box.w, e.y, `dashed=1;strokeColor=${frame};`);
      if (e.label) page.text('guard', html(e.label.lines.join('\n')), { x: g.box.x + 8 * k, y: e.y + 2 * k, w: e.label.width + 4, h: e.label.height + 4 * k }, `align=left;verticalAlign=top;${edgeFont}fontColor=${c.muted};`);
    }
  }
  for (const n of scene.notes) {
    page.vertex('note', html(n.text.lines.join('\n')), `shape=note;size=${Math.round(8 * k)};fillColor=${c.noteFill};strokeColor=${c.noteStroke};align=left;verticalAlign=top;spacingLeft=${Math.round(12 * k)};spacingTop=${Math.round(5 * k)};${noteFont}`, n.box);
  }
  for (const ref of scene.refs) {
    page.vertex('ref', 'ref', `shape=umlFrame;width=${Math.round(36 * k)};height=${Math.round(20 * k)};${tabStyle}fillColor=${c.shapeFill};`, ref.box);
    page.text('ref-text', html(ref.text.lines.join('\n')), { x: ref.box.x, y: ref.box.y + 20 * k, w: ref.box.w, h: ref.box.h - 20 * k }, `align=center;verticalAlign=middle;${noteFont}fontColor=${c.text};`);
  }

  // Participants on top of their lifelines: head (and foot), figures as draw.io's UML shapes.
  const participant = (n: SceneNode, foot: boolean) => {
    const box = FREE_SIZE.has(n.node.kind) ? { x: n.anchor.cx - n.anchor.w / 2, y: n.anchor.cy - n.anchor.h / 2, w: n.anchor.w, h: n.anchor.h } : n.box;
    const folded = foldLabel(n.node);
    // A plain participant box has the theme's corners, as the render draws it.
    const corners = theme.nodeRadius > 0 ? `rounded=1;arcSize=${Math.round(Math.min(box.h / 2, theme.nodeRadius))};absoluteArcSize=1;` : 'rounded=0;';
    const style = `${n.node.kind === 'rectangle' ? corners : (KIND_STYLE[n.node.kind] ?? 'rounded=0;')}fillColor=${c.shapeFill};strokeColor=${c.shapeStroke};${font(theme, theme.size.node, c.text)}${folded.style}`;
    const id = page.vertex(foot ? `${n.node.id}-foot` : n.node.id, folded.value, style, box);
    if (!foot) {
      page.named.set(n.node.id, id);
      anchors.push({ id, box });
    }
  };
  for (const n of scene.heads) participant(n, false);
  for (const n of scene.feet) participant(n, true);
  for (const d of scene.destroys) page.text('destroy', '✕', { x: d.x - 9 * k, y: d.y - 9 * k, w: 18 * k, h: 18 * k }, `align=center;verticalAlign=middle;fontStyle=1;${font(theme, 16 * k, theme.plantuml ? c.text : c.warning)}`);
  for (const parts of lifelines.values()) anchors.push(...parts);

  /** The vertex a message end sits on: an activation bar, a created participant's head, else the nearest lifeline. */
  const endAt = (x: number, y: number, participantId: string): { id: string; box: Box } => {
    const hit = anchors.find((a) => x >= a.box.x - 1.5 && x <= a.box.x + a.box.w + 1.5 && y >= a.box.y - 1.5 && y <= a.box.y + a.box.h + 1.5);
    if (hit) return hit;
    const own = lifelines.get(participantId);
    if (own) return own.find((p) => y >= p.box.y - 1.5 && y <= p.box.y + p.box.h + 1.5) ?? own[0]!;
    // Lost and found messages: a small dot at the diagram's edge, as UML draws them.
    const box = { x: x - 4 * k, y: y - 4 * k, w: 8 * k, h: 8 * k };
    return { id: page.vertex('gate', '', `ellipse;fillColor=${c.text};strokeColor=none;`, box), box };
  };
  for (const m of scene.messages) {
    const e = m.e;
    const style = `edgeStyle=none;rounded=0;${e.dashed ? 'dashed=1;' : ''}${seqMarker('end', e.head)}${seqMarker('start', e.tail)}strokeColor=${theme.plantuml ? c.line : e.dashed ? c.dependency : mix(c.line, c.text, 0.35)};${edgeFont}fontColor=${e.dashed ? c.dependencyLabel : c.text};labelBackgroundColor=none;`;
    // Modern themes draw the autonumber as a bubble beside the label; PlantUML keeps it in the text.
    const bubble = m.number;
    const label = [e.number && !bubble ? `<b>${html(e.number)}</b>` : '', e.label ? html(e.label) : ''].filter(Boolean).join('&nbsp; ');
    // With a bubble, the label sits where we draw it (draw.io's offset from the line's middle) instead of centred above the line.
    const placed = (points: Point[]): { offset?: Point } => {
      if (!bubble || !m.label) return {};
      const mid = pointAt(points, 0.5);
      const cx = m.label.align === 'start' ? m.label.x + m.label.text.width / 2 : m.label.x;
      return { offset: [cx - mid[0], m.label.y - mid[1]] };
    };
    let id: string;
    if (m.self) {
      const h = 18 * k;
      const from = endAt(m.x1, m.y, e.from);
      const to = endAt(m.x1, m.y + h, e.from);
      const loop: Point[] = [[m.x1, m.y], [m.x2, m.y], [m.x2, m.y + h], [m.x1, m.y + h]];
      const at = placed(loop);
      id = page.edge(e.id, label, `${style}${at.offset ? '' : `align=left;verticalAlign=middle;spacingLeft=${Math.round(6 * k)};`}${pinAt('exit', [m.x1, m.y], from.box)}${pinAt('entry', [m.x1, m.y + h], to.box)}`, from.id, to.id, loop.slice(1, 3), at.offset);
    } else {
      const from = endAt(m.x1, m.y, e.from);
      const to = endAt(m.x2, m.y, e.to);
      const at = placed([[m.x1, m.y], [m.x2, m.y]]);
      id = page.edge(e.id, label, `${style}${at.offset ? '' : 'verticalAlign=bottom;'}${pinAt('exit', [m.x1, m.y], from.box)}${pinAt('entry', [m.x2, m.y], to.box)}`, from.id, to.id, [], at.offset);
    }
    if (bubble) {
      const dashed = e.dashed;
      const size = bubble.r * 2;
      page.vertex(`${e.id}-number`, html(bubble.text), `ellipse;fillColor=${dashed ? c.surface : c.accent};strokeColor=none;fontStyle=1;${font(theme, theme.size.edge * 0.82, dashed ? c.muted : c.onAccent)}spacing=0;`, { x: bubble.x - bubble.r, y: bubble.y - bubble.r, w: size, h: size });
    }
    page.namedEdges.set(e.id, id);
  }
}

// ---- Gantt ---------------------------------------------------------------------------------------

/** Named colours PlantUML users write in `is colored in X` (as the renderer maps them). */
const NAMED: Record<string, string> = { orange: '#F59E0B', red: '#EF4444', green: '#22C55E', blue: '#3B82F6', yellow: '#EAB308', purple: '#A855F7', grey: '#9CA3AF', gray: '#9CA3AF', pink: '#EC4899' };

function ganttCells(scene: GanttScene, page: Page): void {
  const { theme, header } = scene;
  const c = theme.colors;
  const k = theme.scale;
  const monthH = header.months.length ? 20 * k : 0;
  const right = scene.bounds.w - 10 * k;
  const bottom = scene.bounds.h - 8 * k;
  const x0 = scene.labelWidth;
  const small = font(theme, theme.size.edge, c.muted);

  // Closed days, merged into runs: one tinted column per weekend.
  for (let i = 0; i < header.days.length; i++) {
    if (!header.days[i]!.closed) continue;
    let j = i;
    while (j + 1 < header.days.length && header.days[j + 1]!.closed) j++;
    const a = header.days[i]!;
    const b = header.days[j]!;
    page.vertex('closed', '', `rounded=0;fillColor=${c.surface};strokeColor=none;`, { x: a.x, y: monthH, w: b.x + b.w - a.x, h: bottom - monthH });
    i = j;
  }
  for (const g of scene.grid) if (g.strong) page.line('rule', g.x, g.y0, g.x, bottom, `strokeColor=${c.grid};`);
  for (const m of header.months) {
    page.line('month', m.x, 0, m.x, header.height, `strokeColor=${c.grid};`);
    page.text('month', html(m.label.lines.join('')), { x: m.x + 6 * k, y: 2 * k, w: m.label.width + 4, h: 16 * k }, `align=left;verticalAlign=middle;fontStyle=1;${font(theme, theme.size.edge, theme.plantuml ? c.title : c.text)}`);
  }
  for (const d of header.days) {
    if (d.label) page.text('day', html(d.label.lines.join('')), { x: d.x, y: monthH + 2 * k, w: d.w, h: 16 * k }, `align=center;verticalAlign=middle;${small}`);
  }
  page.line('header', 0, header.height, right, header.height, `strokeColor=${theme.plantuml ? c.shapeStroke : c.grid};`);
  page.line('labels', x0, 0, x0, bottom, `strokeColor=${c.grid};`);
  scene.sections.forEach((s, i) => {
    if (i > 0) page.line('section', 0, s.y - 6 * k, right, s.y - 6 * k, `strokeColor=${theme.plantuml ? c.shapeStroke : c.grid};${theme.plantuml ? 'dashed=1;' : ''}`);
    page.text('section', html(theme.plantuml ? s.label.lines.join('') : s.label.lines.join('').toUpperCase()), { x: 8 * k, y: s.y, w: s.label.width + 20 * k, h: s.label.height }, `align=left;verticalAlign=top;fontStyle=1;${font(theme, theme.size.edge, c.title)}`);
  });

  // Tasks: the bar carries the task's name, shown in the label column (a label offset), so a
  // dependency reads back as a line between two named boxes.
  const bars = new Map<string, { id: string; box: Box }>();
  for (const row of scene.rows) {
    const t = row.task;
    const labelX = (theme.plantuml ? 12 : 8) * k + row.indent;
    const nameFont = `${font(theme, theme.size.note, t.milestone && !theme.plantuml ? c.muted : c.text)}${t.milestone && !theme.plantuml ? 'fontStyle=2;' : ''}`;
    const custom = t.color ? (NAMED[t.color.toLowerCase()] ?? t.color) : undefined;
    const ink = custom ?? (theme.plantuml ? c.actorFill : c.accent);
    const hex = /^#[0-9a-f]{6}$/i.test(ink);
    let box: Box;
    let style: string;
    if (t.milestone) {
      const s = row.bar.h * 0.62;
      const cx = row.bar.x + row.bar.w / 2;
      const cy = row.bar.y + row.bar.h / 2;
      box = { x: cx - s, y: cy - s, w: 2 * s, h: 2 * s };
      style = `rhombus;fillColor=${c.text};strokeColor=none;`;
    } else {
      box = row.bar;
      const partial = row.done !== undefined;
      const fill = partial ? (hex ? mix(ink, c.background, theme.plantuml ? 0 : 0.72) : ink) : theme.plantuml || !hex ? ink : mix(ink, c.background, 0.15);
      style = `rounded=1;arcSize=${Math.round(Math.min(row.bar.h / 2, 4 * k))};absoluteArcSize=1;fillColor=${fill};strokeColor=${theme.plantuml ? c.actorStroke : 'none'};`;
    }
    // The label box is the shape's box moved by the offset; left-aligned text starts at its left edge.
    const offset: Point = [labelX - box.x, row.y + row.h / 2 - (box.y + box.h / 2)];
    const id = page.vertex(t.id, html(t.name), `${style}align=left;verticalAlign=middle;spacingLeft=0;labelPosition=center;whiteSpace=nowrap;${nameFont}`, box, offset);
    page.named.set(t.id, id);
    bars.set(t.id, { id, box });
    if (!t.milestone && row.done !== undefined) {
      if (row.done > 0) page.vertex(`${t.id}-done`, '', `rounded=1;arcSize=${Math.round(Math.min(row.bar.h / 2, 4 * k))};absoluteArcSize=1;fillColor=${theme.plantuml ? (custom ?? c.actorGlyph) : ink};strokeColor=none;${theme.plantuml ? 'opacity=55;' : ''}`, { ...row.bar, w: Math.max(row.bar.h / 2, row.bar.w * row.done) });
      if (!theme.plantuml && row.done < 1) page.text(`${t.id}-percent`, `${Math.round(row.done * 100)}%`, { x: row.bar.x + row.bar.w + 6 * k, y: row.bar.y, w: 40 * k, h: row.bar.h }, `align=left;verticalAlign=middle;${small}`);
    }
  }
  // Dependencies: out of the bar's end, down, into the next bar's start.
  const ink = theme.plantuml ? c.line : mix(c.line, c.text, 0.2);
  for (const row of scene.rows) {
    for (const after of row.task.after) {
      const from = bars.get(after);
      const to = bars.get(row.task.id);
      if (!from || !to) continue;
      const a: Point = [from.box.x + from.box.w, from.box.y + from.box.h / 2];
      const b: Point = [to.box.x, to.box.y + to.box.h / 2];
      const style = `edgeStyle=orthogonalEdgeStyle;rounded=1;endArrow=block;endFill=1;endSize=4;strokeColor=${ink};exitX=1;exitY=0.5;exitPerimeter=0;`;
      const id = `${after}->${row.task.id}`;
      if (b[0] - 6 * k >= a[0] + 6 * k || !row.task.milestone) {
        const midX = Math.max(a[0] + 6 * k, b[0] - 6 * k);
        page.edge(id, '', `${style}entryX=0;entryY=0.5;entryPerimeter=0;`, from.id, to.id, [
          [midX, a[1]],
          [midX, b[1]],
        ]);
      } else {
        // A milestone on the day its predecessor ends: drop onto the diamond's top rather than doubling back into its side.
        page.edge(id, '', `${style}entryX=0.5;entryY=0;entryPerimeter=0;`, from.id, to.id, [[to.box.x + to.box.w / 2, a[1]]]);
      }
    }
  }
}

// ---- timing --------------------------------------------------------------------------------------

function timingCells(scene: TimingScene, page: Page): void {
  const { theme } = scene;
  const c = theme.colors;
  const k = theme.scale;
  const X = (t: number) => scene.scale.x0 + t * scene.scale.px;
  const xEnd = X(scene.end);
  const wave = theme.plantuml ? c.actorGlyph : c.accent;
  const area = mix(c.background, wave, 0.1);
  const stroke = `strokeColor=${wave};strokeWidth=${Math.round(1.5 * Math.sqrt(k) * 10) / 10};`;

  for (const t of scene.ticks) {
    page.line('tick', t.x, 0, t.x, scene.bounds.h - 20 * k, `strokeColor=${c.grid};${theme.plantuml ? '' : 'dashed=1;'}`);
    page.text('tick', html(t.label.lines.join('')), { x: t.x - 20 * k, y: scene.bounds.h - 18 * k, w: 40 * k, h: 16 * k }, `align=center;verticalAlign=middle;${font(theme, theme.size.edge, c.muted)}`);
  }
  const lanes = new Map<string, { id: string; box: Box }>();
  for (const lane of scene.lanes) {
    const s = lane.signal;
    const top = lane.y + (s.kind === 'robust' ? 28 : 8) * k;
    const bottom = lane.y + lane.h - 8 * k;
    // The lane is a box holding the signal's name (top left): messages run between lanes.
    const box = { x: 0, y: lane.y, w: xEnd, h: lane.h };
    const id = page.vertex(s.id, html(s.label), `rounded=0;fillColor=none;strokeColor=none;align=left;verticalAlign=top;spacingLeft=${Math.round(8 * k)};spacingTop=${Math.round(2 * k)};fontStyle=1;${font(theme, theme.size.node, c.text)}`, box);
    page.named.set(s.id, id);
    lanes.set(s.id, { id, box });
    page.line('lane', 0, lane.y + lane.h + 5 * k, xEnd, lane.y + lane.h + 5 * k, `strokeColor=${c.grid};`);
    const changes = s.changes.length ? s.changes : [{ time: 0, state: '' }];
    const until = (i: number) => (i + 1 < changes.length ? X(changes[i + 1]!.time) : xEnd);
    /** A waveform as strokes: level runs and the steps between them. */
    const steps = (points: [number, number, number][]) => {
      points.forEach(([a, b, y], i) => {
        if (i > 0 && points[i - 1]![2] !== y) page.line('step', a, points[i - 1]![2], a, y, stroke);
        page.line('level', a, y, b, y, stroke);
      });
    };
    if (s.kind === 'robust') {
      const levels = lane.levels!;
      const levelY = (state: string) => top + (levels.length === 1 ? 0 : (Math.max(0, levels.indexOf(state)) / (levels.length - 1)) * (bottom - top));
      for (const l of levels) {
        if (!theme.plantuml) page.line('level-rule', scene.labelWidth, levelY(l), xEnd, levelY(l), `strokeColor=${c.grid};dashed=1;dashPattern=1 3;`);
        page.text('level', html(l), { x: 0, y: levelY(l) - 8 * k, w: scene.labelWidth - 6 * k, h: 16 * k }, `align=right;verticalAlign=middle;${font(theme, theme.size.edge, c.muted)}`);
      }
      steps(changes.map((ch, i) => [X(ch.time), until(i), levelY(ch.state)]));
    } else if (s.kind === 'concise') {
      changes.forEach((ch, i) => {
        const a = X(ch.time);
        const b = until(i);
        page.vertex('state', html(ch.state), `shape=hexagon;perimeter=hexagonPerimeter2;fixedSize=1;size=${r(Math.min(4 * k, (b - a) / 3))};fillColor=${theme.plantuml ? c.actorFill : accentTint(theme, 0.1)};strokeColor=${theme.plantuml ? c.actorStroke : accentTint(theme, 0.4)};${font(theme, theme.size.edge, c.text)}`, { x: a, y: top, w: b - a, h: bottom - top });
      });
    } else {
      const runs: [number, number, number][] = [];
      if (s.kind === 'clock') {
        page.line('step', X(0), bottom, X(0), top, stroke);
        const period = s.period ?? scene.end / 10;
        const pulse = s.pulse ?? period / 2;
        for (let t = 0; t < scene.end; t += period) {
          runs.push([X(t), X(Math.min(t + pulse, scene.end)), top]);
          if (t + pulse < scene.end) runs.push([X(t + pulse), X(Math.min(t + period, scene.end)), bottom]);
        }
      } else changes.forEach((ch, i) => runs.push([X(ch.time), until(i), ch.state === 'high' ? top : bottom]));
      // High time filled faintly, as we draw it, so duty cycles read at a glance.
      if (!theme.plantuml) for (const [a, b, y] of runs) if (y === top) page.vertex('high', '', `rounded=0;fillColor=${area};strokeColor=none;`, { x: a, y: top, w: b - a, h: bottom - top });
      steps(runs);
    }
  }
  const ink = theme.plantuml ? c.dependency : mix(c.line, c.text, 0.35);
  for (const [i, m] of scene.messages.entries()) {
    const fromLane = [...lanes.values()].find((l) => m.from[1] >= l.box.y && m.from[1] <= l.box.y + l.box.h);
    const toLane = [...lanes.values()].find((l) => m.to[1] >= l.box.y && m.to[1] <= l.box.y + l.box.h);
    if (!fromLane || !toLane) continue;
    const label = m.label ? html(m.label.lines.join('\n')) : '';
    page.edge(`message-${i + 1}`, label, `edgeStyle=none;rounded=0;endArrow=block;endFill=1;strokeColor=${ink};${font(theme, theme.size.edge, c.dependencyLabel)}labelBackgroundColor=${c.labelFill};${pinAt('exit', m.from, fromLane.box)}${pinAt('entry', m.to, toLane.box)}`, fromLane.id, toLane.id, [], [30 * k, 0]);
  }
}
