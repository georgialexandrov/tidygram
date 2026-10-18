import { bandsKind, type LayoutFile, type Point } from '../layout/layout-file.ts';
import { APPROX_KINDS, parseDrawio } from '../model/drawio.ts';
import type { ArrowHead, ClassKind, DNode, Diagram, NodeKind, ParseWarning } from '../model/types.ts';
import type { AnyScene } from '../scene/any.ts';
import { containerBoxes, nodeBox, type Box, type Positions } from '../scene/containers.ts';
import { FREE_SIZE, containerPad, nodeShape } from '../scene/shapes.ts';
import { themeOf, type Theme } from '../scene/theme.ts';
import { ringBox, type TemplateScene } from '../scene/template.ts';
import { KindLosses, warn, type ConvertResult, type IdMap } from './common.ts';
import { orderedToDrawio } from './drawio-ordered.ts';

/**
 * Diagram → draw.io (uncompressed `<mxfile>`). Unlike PlantUML and Mermaid,
 * draw.io holds the whole picture: every node at its box from the built
 * scene, containers as `container=1` cells with their children placed
 * relative to them, and every line with its routed bends as waypoints
 * (orthogonal edge style, ends pinned to where our router attached them),
 * so draw.io shows what we drew and `parseDrawio` reads the same boxes back
 * as `sourceBox`es. Styles are the inverse of the reader's mapping, picked
 * so each kind reads back as itself where draw.io has a matching shape.
 * Ids are ours (draw.io takes any string), except `0` and `1`, which are
 * the root cells.
 */
export function toDrawio(diagram: Diagram, layout: LayoutFile, scene?: AnyScene): ConvertResult {
  if (diagram.special) return orderedToDrawio(diagram.special, layout, scene);
  const losses = new KindLosses();
  const warnings: ParseWarning[] = [];
  const geo = geometry(diagram, layout, scene && scene.kind === 'graph' ? scene : undefined);

  // ---- ids: one namespace for every cell ----
  const used = new Set(['0', '1']);
  const cellId = new Map<string, string>();
  const take = (key: string, id: string) => {
    let candidate = id || 'cell';
    for (let i = 2; used.has(candidate); i++) candidate = `${id || 'cell'}-${i}`;
    used.add(candidate);
    cellId.set(key, candidate);
    return candidate;
  };
  for (const c of diagram.containers) take(`c:${c.id}`, c.id);
  for (const n of diagram.nodes) take(`n:${n.id}`, n.id);
  for (const e of diagram.edges) take(`e:${e.id}`, e.id);
  const fresh = (base: string) => take(`x:${base}:${used.size}`, base);
  const vertexId = (id: string) => cellId.get(`n:${id}`) ?? cellId.get(`c:${id}`);

  const cells: string[] = [];
  /** The template backdrop: its own locked layer under everything (see `templateCells`). */
  const backdrop = scene?.kind === 'graph' && scene.template ? templateCells(scene.template, scene.theme, fresh) : [];
  if (backdrop.length) losses.add('template written as background shapes (the template and its assignments stay in the sidecar only)');
  const violated = new Set(scene?.kind === 'graph' && scene.template ? scene.template.violations.map((v) => v.edge) : []);
  /** Absolute box of each written vertex, for children's offsets and line ends. */
  const written = new Map<string, Box>();
  const containerIds = new Set(diagram.containers.map((c) => c.id));

  const parentCell = (parent: string | undefined): [string, Box | undefined] => {
    if (parent && containerIds.has(parent) && written.has(parent)) return [cellId.get(`c:${parent}`)!, written.get(parent)];
    return ['1', undefined];
  };
  const geometryXml = (box: Box, origin: Box | undefined) =>
    `<mxGeometry x="${r(box.x - (origin?.x ?? 0))}" y="${r(box.y - (origin?.y ?? 0))}" width="${r(box.w)}" height="${r(box.h)}" as="geometry" />`;

  // ---- containers, outermost first ----
  const depth = (id: string): number => {
    const c = diagram.containers.find((x) => x.id === id);
    return c?.parent && containerIds.has(c.parent) ? 1 + depth(c.parent) : 0;
  };
  for (const c of [...diagram.containers].sort((a, b) => depth(a.id) - depth(b.id))) {
    const box = geo.containers.get(c.id);
    if (!box) {
      losses.add('empty container (dropped)');
      continue;
    }
    const [parent, origin] = parentCell(c.parent);
    written.set(c.id, box);
    if (c.kind !== 'group') losses.add(`${c.kind} container written as a plain group`);
    const style = 'rounded=0;html=1;container=1;collapsible=0;verticalAlign=top;align=left;spacingLeft=8;fillColor=none;';
    cells.push(`<mxCell id="${attr(cellId.get(`c:${c.id}`)!)}" value="${attr(html(c.label))}" style="${style}" vertex="1" parent="${attr(parent)}">${geometryXml(box, origin)}</mxCell>`);
  }

  // ---- nodes ----
  for (const n of diagram.nodes) {
    const g = geo.nodes.get(n.id);
    if (!g) {
      losses.add('node without a position (dropped)');
      continue;
    }
    const [parent, origin] = parentCell(n.parent);
    // Icon kinds: the file box is the figure; draw.io hangs the label below it, as we do.
    const box = FREE_SIZE.has(n.kind) ? { x: g.anchor.cx - g.anchor.w / 2, y: g.anchor.cy - g.anchor.h / 2, w: g.anchor.w, h: g.anchor.h } : g.box;
    written.set(n.id, box);
    const id = cellId.get(`n:${n.id}`)!;
    if (n.kind === 'class') {
      cells.push(...tableCells(n, id, parent, box, origin, g.header, fresh));
      continue;
    }
    let style = KIND_STYLE[n.kind];
    if (!style || !EXACT_KINDS.has(n.kind)) losses.add(`${n.kind} drawn as ${APPROX_NAME[n.kind] ?? 'a box'}`);
    style ??= 'rounded=0;';
    if (n.double) {
      if (n.kind === 'attribute') style = 'shape=doubleEllipse;';
      else losses.add('double outline');
    }
    if (n.key) style += 'fontStyle=4;';
    if (n.derived) style += 'dashed=1;';
    if (n.attachedTo) losses.add('note attachment');
    const folded = foldLabel(n);
    cells.push(`<mxCell id="${attr(id)}" value="${attr(folded.value)}" style="${style}html=1;${folded.style}" vertex="1" parent="${attr(parent)}">${geometryXml(box, origin)}</mxCell>`);
  }

  // ---- edges: absolute waypoints under the default layer ----
  for (const e of diagram.edges) {
    const from = vertexId(e.from);
    const to = vertexId(e.to);
    const fromBox = written.get(e.from);
    const toBox = written.get(e.to);
    if (!from || !to || !fromBox || !toBox) {
      losses.add('line to something not drawn (dropped)');
      continue;
    }
    const id = cellId.get(`e:${e.id}`)!;
    const route = geo.edges.get(e.id);
    let style = 'edgeStyle=orthogonalEdgeStyle;rounded=0;orthogonalLoop=1;jettySize=auto;html=1;';
    style += markerStyle('end', e.head);
    if (e.tail !== 'none') style += markerStyle('start', e.tail);
    if (e.dashed) style += 'dashed=1;';
    if (violated.has(e.id) && scene?.kind === 'graph') style += `strokeColor=${scene.theme.colors.warning};strokeWidth=2;`;
    if (e.hidden) {
      style += 'strokeColor=none;';
      losses.add('hidden line written with no stroke');
    }
    if (e.double) losses.add('double line');
    if (e.kind === 'noteLink') losses.add('note link read back as a dashed line');
    // Pin the ends where the router attached them, so draw.io's orthogonal router draws the same path.
    const points = route?.points;
    // Hand-chosen ends (sidecar `from`/`to`) read back as fixed; the router's own are flagged `pumlAuto*`.
    const chosen = layout.edges[e.id];
    if (points && points.length >= 2) {
      style += pin('exit', points[0]!, fromBox) + (chosen?.from ? '' : 'pumlAutoExit=1;') + pin('entry', points[points.length - 1]!, toBox) + (chosen?.to ? '' : 'pumlAutoEntry=1;');
    } else {
      if (chosen?.from) style += pin('exit', [fromBox.x + chosen.from.x * fromBox.w, fromBox.y + chosen.from.y * fromBox.h], fromBox);
      if (chosen?.to) style += pin('entry', [toBox.x + chosen.to.x * toBox.w, toBox.y + chosen.to.y * toBox.h], toBox);
    }
    const bends = points && points.length > 2 ? points.slice(1, -1) : (route?.via ?? []);
    const array = bends.length ? `<Array as="points">${bends.map(([x, y]) => `<mxPoint x="${r(x)}" y="${r(y)}" />`).join('')}</Array>` : '';
    cells.push(
      `<mxCell id="${attr(id)}" value="${attr(html(e.label ?? ''))}" style="${style}" edge="1" parent="1" source="${attr(from)}" target="${attr(to)}"><mxGeometry relative="1" as="geometry">${array}</mxGeometry></mxCell>`,
    );
    for (const [text, along, align] of [
      [e.fromLabel, -0.8, 'left'],
      [e.toLabel, 0.8, 'right'],
    ] as const) {
      if (!text) continue;
      cells.push(
        `<mxCell id="${attr(fresh(`${id}-${along < 0 ? 'from' : 'to'}`))}" value="${attr(html(text))}" style="edgeLabel;resizable=0;html=1;align=${align};verticalAlign=bottom;" vertex="1" connectable="0" parent="${attr(id)}"><mxGeometry x="${along}" relative="1" as="geometry"><mxPoint as="offset" /></mxGeometry></mxCell>`,
      );
    }
  }

  const source = mxfile(cells, { backdrop });

  // Map only what reads back: an id that went missing is a bug worth a warning, not a silent map entry.
  const parsed = parseDrawio(source).diagram;
  const present = new Set([...parsed.nodes.map((n) => n.id), ...parsed.containers.map((c) => c.id)]);
  const presentEdges = new Set(parsed.edges.map((e) => e.id));
  const ids: IdMap = { nodes: {}, edges: {} };
  for (const x of [...diagram.containers, ...diagram.nodes]) {
    const id = vertexId(x.id);
    if (id && present.has(id)) ids.nodes[x.id] = id;
  }
  for (const e of diagram.edges) {
    const id = cellId.get(`e:${e.id}`);
    if (id && presentEdges.has(id)) ids.edges[e.id] = id;
  }

  return { source, layout: viewOnly(layout, warnings), warnings: [...warnings, ...losses.warnings('draw.io')], ids };
}

/** The file carries the layout; the sidecar keeps only the view. Sizes are baked into the geometry. */
export function viewOnly(layout: LayoutFile, warnings: ParseWarning[]): LayoutFile {
  const view = layout.view ? { ...layout.view } : undefined;
  if (view && (view.scale || view.text || view.icons)) {
    warnings.push(warn('Scale settings are baked into the draw.io geometry and dropped from the sidecar'));
    delete view.scale;
    delete view.text;
    delete view.icons;
  }
  const next: LayoutFile = { version: 1, nodes: {}, edges: {} };
  if (view && Object.keys(view).length) next.view = view;
  return next;
}

/** One uncompressed page; `backdrop` cells go before the default layer (drawn under it), `background` is the page colour. */
export function mxfile(cells: string[], options: { backdrop?: string[]; background?: string; drawing?: 'sequence' | 'gantt' | 'timing' } = {}): string {
  const background = options.background ? ` background="${attr(options.background)}"` : '';
  return [
    '<mxfile host="puml-layout">',
    '  <diagram id="page-1" name="Page-1">',
    `    <mxGraphModel grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="0" pageScale="1" math="0" shadow="0"${background}>`,
    '      <root>',
    '        <mxCell id="0" />',
    ...(options.backdrop ?? []).map((c) => `        ${c}`),
    // `pumlDrawing` on the layer: draw.io keeps cell styles, so the mark survives a save there; our reader keeps the file's geometry.
    `        <mxCell id="1" parent="0"${options.drawing ? ` style="pumlDrawing=${options.drawing};"` : ''} />`,
    ...cells.map((c) => `        ${c}`),
    '      </root>',
    '    </mxGraphModel>',
    '  </diagram>',
    '</mxfile>',
    '',
  ].join('\n');
}

// ---- template backdrop ---------------------------------------------------------------------------

/**
 * Bands, hexagons, panels and rings as plain draw.io shapes with their
 * titles, on a locked layer of their own below the diagram (layers draw in
 * document order). Marked `pumlTemplate=1`, which draw.io keeps and our
 * reader skips, so reading the file back gives the same diagram.
 */
function templateCells(t: TemplateScene, theme: Theme, fresh: (base: string) => string): string[] {
  const layer = fresh('template');
  const c = theme.colors;
  const font = `fontColor=${c.layerTitle};fontStyle=1;fontSize=${Math.round(theme.size.container)};`;
  const base = `html=1;pumlTemplate=1;locked=1;strokeColor=${c.layerStroke};${font}`;
  const geo = (b: Box) => `<mxGeometry x="${r(b.x)}" y="${r(b.y)}" width="${r(b.w)}" height="${r(b.h)}" as="geometry" />`;
  const cell = (id: string, label: string, style: string, box: Box) => `<mxCell id="${attr(fresh(id))}" value="${attr(html(label))}" style="${style}" vertex="1" parent="${attr(layer)}">${geo(box)}</mxCell>`;
  const label = (id: string) => t.layers.find((l) => l.id === id)?.label ?? id;
  const out = [`<mxCell id="${attr(layer)}" value="Template" style="locked=1;pumlTemplate=1;" parent="0" />`];
  for (const b of t.bands) {
    const align = bandsKind(t.kind) ? 'align=left;verticalAlign=middle;spacingLeft=12;' : 'align=center;verticalAlign=top;spacingTop=8;';
    out.push(cell(`band-${b.id}`, label(b.id), `rounded=1;arcSize=4;absoluteArcSize=1;fillColor=${b.fill};${align}${base}`, b.box));
  }
  for (const h of t.hexagons) {
    const box = { x: h.cx - h.r, y: h.cy - (h.r * Math.sqrt(3)) / 2, w: h.r * 2, h: h.r * Math.sqrt(3) };
    // draw.io's hexagon with a quarter-width inset is the flat-topped regular one.
    out.push(cell(`hex-${h.id}`, label(h.id), `shape=hexagon;perimeter=hexagonPerimeter2;fixedSize=0;size=0.25;fillColor=${h.fill};verticalAlign=top;spacingTop=8;${base}`, box));
  }
  if (t.center) {
    for (const ring of [...t.rings].reverse()) {
      // A rounded rectangle: draw.io's arcSize is the corner radius as a percentage of the shorter side.
      const arc = Math.round((1000 * ring.c) / (2 * Math.min(ring.a, ring.b))) / 10;
      out.push(cell(`ring-${ring.id}`, label(ring.id), `rounded=1;arcSize=${arc};fillColor=${ring.fill};verticalAlign=top;spacingTop=6;${base}`, ringBox(ring, t.center)));
    }
  }
  return out;
}

// ---- styles ------------------------------------------------------------------------------------

const BELOW = 'verticalLabelPosition=bottom;verticalAlign=top;outlineConnect=0;';

/** Kind → draw.io style, chosen so `parseDrawio` reads the kind back where draw.io has the shape. */
export const KIND_STYLE: Partial<Record<NodeKind, string>> = {
  rectangle: 'rounded=0;',
  action: 'rounded=1;',
  attribute: 'ellipse;',
  relationship: 'rhombus;',
  database: 'shape=cylinder3;boundedLbl=1;backgroundOutline=1;size=12;',
  actor: `shape=umlActor;${BELOW}`,
  cloud: 'ellipse;shape=cloud;',
  hexagon: 'shape=hexagon;perimeter=hexagonPerimeter2;fixedSize=1;size=14;',
  process: 'shape=process;backgroundOutline=1;',
  note: 'shape=note;size=14;',
  file: 'shape=document;boundedLbl=1;',
  card: 'shape=card;size=14;',
  folder: 'shape=folder;tabWidth=40;tabHeight=12;tabPosition=left;',
  component: 'shape=component;align=left;spacingLeft=36;',
  node: 'shape=cube;size=10;',
  boundary: `shape=umlBoundary;${BELOW}`,
  control: `shape=umlControl;${BELOW}`,
  entity: `shape=umlEntity;${BELOW}`,
  interface: `shape=providedRequiredInterface;${BELOW}`,
  stack: 'shape=mxgraph.flowchart.multi_document;',
  label: 'text;',
  // Approximations: draw.io has no shape that reads back as these kinds.
  usecase: 'ellipse;',
  circle: `ellipse;aspect=fixed;${BELOW}`,
  initial: 'ellipse;fillColor=#000000;',
  final: 'shape=doubleEllipse;fillColor=#000000;',
  history: 'ellipse;',
  choice: 'rhombus;',
  decision: 'rhombus;',
  fork: 'rounded=0;fillColor=#000000;',
  storage: 'rounded=1;arcSize=50;',
  queue: 'shape=cylinder3;direction=south;boundedLbl=1;backgroundOutline=1;size=12;',
  person: `shape=umlActor;${BELOW}`,
  artifact: 'shape=document;boundedLbl=1;',
  collections: 'shape=mxgraph.flowchart.multi_document;',
  frame: 'shape=umlFrame;',
  state: 'rounded=1;',
  topic: 'rounded=1;',
  system: 'rounded=0;',
  container: 'rounded=0;',
};
/** Kinds whose style above reads back as the same kind. */
const EXACT_KINDS = new Set<NodeKind>([
  'rectangle', 'action', 'attribute', 'relationship', 'database', 'actor', 'cloud', 'hexagon', 'process', 'note', 'file', 'card', 'folder', 'component', 'node',
  'boundary', 'control', 'entity', 'interface', 'stack', 'label', 'class',
]);
const APPROX_NAME: Partial<Record<NodeKind, string>> = {
  usecase: 'an ellipse', circle: 'an ellipse', initial: 'an ellipse', final: 'an ellipse', history: 'an ellipse', choice: 'a rhombus', decision: 'a rhombus',
  fork: 'a box', storage: 'a rounded box', queue: 'a cylinder', person: 'an actor', artifact: 'a document', collections: 'a stack', state: 'a rounded box', topic: 'a rounded box',
};

/** Our line end → draw.io marker and fill; the inverse of the reader's `arrowHead`. */
const MARKERS: Record<ArrowHead, [marker: string, fill?: 0 | 1]> = {
  none: ['none'],
  arrow: ['classic', 1],
  triangle: ['block', 0],
  diamond: ['diamond', 0],
  diamondFilled: ['diamond', 1],
  circle: ['oval', 0],
  dot: ['oval', 1],
  circlePlus: ['circlePlus', 0],
  cross: ['cross'],
  square: ['box', 0],
  crowZeroOne: ['ERzeroToOne', 0],
  crowOne: ['ERmandOne', 0],
  crowZeroMany: ['ERzeroToMany', 0],
  crowOneMany: ['ERoneToMany', 0],
  crowMany: ['ERmany', 0],
};
function markerStyle(end: 'end' | 'start', head: ArrowHead): string {
  const [marker, fill] = MARKERS[head];
  return `${end}Arrow=${marker};${fill !== undefined ? `${end}Fill=${fill};` : ''}`;
}

/** `exitX=..;exitY=..;exitPerimeter=0;`: where on the box (0..1) a line leaves or arrives. */
function pin(which: 'exit' | 'entry', [x, y]: Point, box: Box): string {
  const fx = box.w ? clamp((x - box.x) / box.w) : 0.5;
  const fy = box.h ? clamp((y - box.y) / box.h) : 0.5;
  return `${which}X=${Math.round(fx * 1000) / 1000};${which}Y=${Math.round(fy * 1000) / 1000};${which}Dx=0;${which}Dy=0;${which}Perimeter=0;`;
}
const clamp = (v: number) => Math.min(1, Math.max(0, v));

/** The «kind» line draw.io's UML shapes put above a class name; plain classes, abstract ones (italic) and tables have none. */
const CLASS_KIND_LINE: Partial<Record<ClassKind, string>> = {
  interface: 'interface', enum: 'enum', annotation: 'annotation', struct: 'struct', protocol: 'protocol', exception: 'exception', record: 'record',
};

/**
 * A node's label as draw.io shows it: «kind» and «stereotype» lines above
 * the name, `[technology]` and description lines under it, both smaller.
 * draw.io keeps unknown style keys, so `pumlHead`/`pumlTail` (how many
 * lines aren't the name), `pumlStereotype`, `pumlTechnology` and
 * `pumlClassKind`, `pumlKind` (the real kind behind an approximate shape) and `pumlExternal` let `parseDrawio` take the label apart again.
 */
export function foldLabel(n: DNode, kindLine?: string): { value: string; style: string } {
  const small = (t: string) => `<font style="font-size:10px">${html(t)}</font>`;
  const stereotype = n.stereotype && n.stereotype !== 'boxless' ? n.stereotype : undefined;
  const head = [kindLine, stereotype].filter((t): t is string => !!t).map((t) => `«${t}»`);
  // draw.io drops empty lines in labels, so blank description lines don't travel.
  const tail = [...(n.technology ? [`[${n.technology}]`] : []), ...(n.description ?? []).filter((l) => l.trim())];
  const enc = (t: string) => encodeURIComponent(t);
  let style = '';
  if (head.length) style += `pumlHead=${head.length};`;
  if (tail.length) style += `pumlTail=${tail.length};`;
  if (stereotype) style += `pumlStereotype=${enc(stereotype)};`;
  if (n.technology) style += `pumlTechnology=${enc(n.technology)};`;
  if (APPROX_KINDS.has(n.kind)) style += `pumlKind=${n.kind};`;
  if (n.external) style += 'pumlExternal=1;';
  if (n.kind === 'class' && n.classKind && n.classKind !== 'entity') style += `pumlClassKind=${n.classKind};`;
  return { value: [...head.map(small), html(n.label), ...tail.map(small)].join('<br>'), style };
}

/**
 * A class box as draw.io's UML class: a stack-layout swimlane (header =
 * name) with one text row per member and a line between compartments.
 * The reader turns that back into a class table; a class with no members
 * gets one empty row so it stays a table.
 */
function tableCells(n: DNode, id: string, parent: string, box: Box, origin: Box | undefined, header: number | undefined, fresh: (base: string) => string): string[] {
  const head = Math.round(header ?? 26);
  const sections = n.compartments?.length ? n.compartments : [[]];
  const separators = sections.length - 1;
  const rows = Math.max(1, sections.reduce((s, c) => s + Math.max(c.length, 0), 0));
  const rowH = Math.max(8, (box.h - head - separators * 8) / rows);
  const folded = foldLabel(n, n.classKind ? CLASS_KIND_LINE[n.classKind] : undefined);
  // UML writes abstract names in italics.
  const font = n.classKind === 'abstract' ? 3 : 1;
  const cells = [
    `<mxCell id="${attr(id)}" value="${attr(folded.value)}" style="swimlane;fontStyle=${font};align=center;verticalAlign=top;childLayout=stackLayout;horizontal=1;startSize=${head};horizontalStack=0;resizeParent=1;resizeParentMax=0;resizeLast=0;collapsible=0;marginBottom=0;html=1;${folded.style}" vertex="1" parent="${attr(parent)}"><mxGeometry x="${r(box.x - (origin?.x ?? 0))}" y="${r(box.y - (origin?.y ?? 0))}" width="${r(box.w)}" height="${r(box.h)}" as="geometry" /></mxCell>`,
  ];
  let y = head;
  const row = (text: string) => {
    cells.push(
      `<mxCell id="${attr(fresh(`${id}-row`))}" value="${attr(html(text))}" style="text;strokeColor=none;fillColor=none;align=left;verticalAlign=top;spacingLeft=4;spacingRight=4;overflow=hidden;rotatable=0;points=[[0,0.5],[1,0.5]];portConstraint=eastwest;html=1;" vertex="1" parent="${attr(id)}"><mxGeometry y="${r(y)}" width="${r(box.w)}" height="${r(rowH)}" as="geometry" /></mxCell>`,
    );
    y += rowH;
  };
  sections.forEach((section, i) => {
    if (i > 0) {
      cells.push(
        `<mxCell id="${attr(fresh(`${id}-line`))}" value="" style="line;strokeWidth=1;fillColor=none;align=left;verticalAlign=middle;spacingTop=-1;spacingLeft=3;spacingRight=3;rotatable=0;labelPosition=right;points=[];portConstraint=eastwest;" vertex="1" parent="${attr(id)}"><mxGeometry y="${r(y)}" width="${r(box.w)}" height="8" as="geometry" /></mxCell>`,
      );
      y += 8;
    }
    for (const m of section) row(m);
  });
  if (rows === 1 && !sections.some((s) => s.length)) row('');
  return cells;
}

// ---- geometry ----------------------------------------------------------------------------------

interface Geometry {
  nodes: Map<string, { box: Box; anchor: { cx: number; cy: number; w: number; h: number }; header?: number }>;
  containers: Map<string, Box>;
  edges: Map<string, { points?: Point[]; via?: Point[] }>;
}

/** Boxes and routes from the built scene; without one, boxes from the layout and lines as their stored checkpoints. */
function geometry(diagram: Diagram, layout: LayoutFile, scene: Extract<AnyScene, { kind: 'graph' }> | undefined): Geometry {
  const geo: Geometry = { nodes: new Map(), containers: new Map(), edges: new Map() };
  if (scene) {
    for (const n of scene.nodes) geo.nodes.set(n.node.id, { box: n.box, anchor: n.anchor, header: n.shape.header });
    for (const c of scene.containers) geo.containers.set(c.id, c.box);
    for (const e of scene.edges) geo.edges.set(e.edge.id, { points: e.points });
    return geo;
  }
  const theme = themeOf(layout.view);
  const shapes = new Map(diagram.nodes.map((n) => [n.id, nodeShape(n, theme)]));
  const positions: Positions = {};
  for (const n of diagram.nodes) {
    const p = layout.nodes[n.id];
    if (!p) continue;
    positions[n.id] = { x: p.x, y: p.y };
    const shape = shapes.get(n.id)!;
    geo.nodes.set(n.id, { box: nodeBox(p, shape), anchor: { cx: p.x + shape.anchor.dx, cy: p.y + shape.anchor.dy, w: shape.anchor.w, h: shape.anchor.h }, header: shape.header });
  }
  for (const [id, box] of containerBoxes(diagram, positions, shapes, containerPad(theme))) geo.containers.set(id, box);
  for (const e of diagram.edges) geo.edges.set(e.id, { via: layout.edges[e.id]?.via ?? e.sourceVia });
  return geo;
}

// ---- text --------------------------------------------------------------------------------------

export const r = (v: number) => Math.round(v * 100) / 100;
/** A label as draw.io HTML (`html=1`): escaped, line breaks as `<br>`. */
export const html = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>');
/** An XML attribute value. */
export const attr = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/\n/g, '&#10;');

