import type { ArrowHead, ClassKind, DContainer, DEdge, DNode, EdgeKind, NodeKind, ParseWarning, SourceBox } from './types.ts';
import type { ParseOptions, ParseResult } from './parse.ts';
import { inflateRaw } from './inflate.ts';
import { decodeEntities, findElement, parseXml, type XmlElement } from './xml.ts';

/**
 * draw.io / diagrams.net input (`.drawio`, `.drawio.xml`, `.xml` with
 * `<mxfile>` or `<mxGraphModel>`). Ids are the mxCell ids, which draw.io keeps
 * stable. Unlike PlantUML and Mermaid the file already carries a hand-made
 * layout, so every element brings its absolute box (`sourceBox`) and every
 * line its waypoints (`sourceVia`): the file's geometry is the default layout
 * and ELK only runs when asked. Colours, fonts and label offsets are ignored
 * (themes own the look). One page is read at a time (`options.page`, the
 * first by default); a multi-page file reports all of them in `pages` so the
 * editor can offer the others.
 */

const DRAWIO_HEAD = /^\s*(?:<\?xml[^>]*\?>\s*)?(?:<!--[\s\S]*?-->\s*)*<(mxfile|mxGraphModel)\b/;

export function looksLikeDrawio(source: string): boolean {
  return DRAWIO_HEAD.test(source);
}

interface Style {
  /** Bare names (`ellipse`, `text`, `swimlane`, `group`, `edgeLabel`, ...). */
  names: Set<string>;
  values: Map<string, string>;
}

function parseStyle(style: string | undefined): Style {
  const names = new Set<string>();
  const values = new Map<string, string>();
  for (const part of (style ?? '').split(';')) {
    const t = part.trim();
    if (!t) continue;
    const eq = t.indexOf('=');
    if (eq < 0) names.add(t);
    else values.set(t.slice(0, eq).trim(), t.slice(eq + 1).trim());
  }
  return { names, values };
}

/**
 * puml-layout's own style keys (draw.io keeps unknown keys), written by our
 * draw.io export: class flavour, stereotype and the label lines folded in
 * for draw.io's eyes (`pumlHead` lines above the name, `pumlTail` under it:
 * a `[technology]` line when `pumlTechnology` is set, then the description).
 */
function readPumlKeys(style: Style, node: DNode): void {
  const v = (k: string) => style.values.get(k);
  const decode = (s: string) => {
    try {
      return decodeURIComponent(s);
    } catch {
      return s;
    }
  };
  const lines = node.label.split('\n');
  const tail = Math.min(Number(v('pumlTail')) || 0, lines.length - 1);
  const under = tail ? lines.splice(lines.length - tail) : [];
  node.label = lines.slice(Math.min(Number(v('pumlHead')) || 0, lines.length - 1)).join('\n');
  if (v('pumlTechnology') !== undefined) {
    node.technology = decode(v('pumlTechnology')!);
    under.shift();
  }
  if (under.length) node.description = under;
  if (v('pumlClassKind')) node.classKind = v('pumlClassKind') as ClassKind;
  if (v('pumlStereotype')) node.stereotype = decode(v('pumlStereotype')!);
}

interface Cell {
  id: string;
  parent?: string;
  value: string;
  style: Style;
  vertex: boolean;
  edge: boolean;
  source?: string;
  target?: string;
  geometry?: XmlElement;
  line: number;
}

/** draw.io label → plain text: HTML (`html=1`) loses its tags, `<br>`/`<div>`/`<p>` become line breaks. */
export function labelText(value: string, html: boolean): string {
  let text = value;
  if (html) {
    text = text
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(div|p|li|tr|h[1-6])\s*>/gi, '\n')
      .replace(/<(div|p|li|tr|h[1-6])(\s[^>]*)?>/gi, '\n')
      .replace(/<[^>]*>/g, '');
    text = decodeEntities(text);
  }
  return text
    .replace(/ /g, ' ')
    .split('\n')
    .map((l) => l.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

/**
 * The XML inside a compressed `<diagram>`: base64 of raw deflate of the
 * URI-encoded XML (draw.io's format since 2016). Older files skip the URI step.
 */
export function decompressPage(payload: string): string {
  const binary = atob(payload.replace(/\s+/g, ''));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const inflated = new TextDecoder().decode(inflateRaw(bytes));
  return inflated.trimStart().startsWith('<') ? inflated : decodeURIComponent(inflated);
}

const num = (v: string | undefined, fallback = 0) => {
  const n = v === undefined ? NaN : Number(v);
  return Number.isFinite(n) ? n : fallback;
};

/** `shape=mxgraph.flowchart.*` stencils with a close match. */
const FLOWCHART: Record<string, NodeKind> = {
  process: 'rectangle',
  decision: 'relationship',
  terminator: 'action',
  start_1: 'attribute',
  start_2: 'attribute',
  on_page_reference: 'attribute',
  or: 'attribute',
  summing_function: 'attribute',
  database: 'database',
  stored_data: 'database',
  direct_data: 'database',
  document: 'file',
  multi_document: 'stack',
  predefined_process: 'process',
  preparation: 'hexagon',
  delay: 'action',
  display: 'action',
  data: 'rectangle',
  manual_input: 'rectangle',
  manual_operation: 'rectangle',
  card: 'card',
  paper_tape: 'rectangle',
  internal_storage: 'rectangle',
  off_page_reference: 'rectangle',
  loop_limit: 'rectangle',
  annotation_1: 'label',
  annotation_2: 'label',
  extract_or_measurement: 'rectangle',
  merge_or_storage: 'rectangle',
  sort: 'relationship',
  collate: 'rectangle',
  sequential_data: 'attribute',
};

/**
 * Plain `shape=` values with a close match. Shapes we only approximate with
 * a box (parallelogram, lifeline, ...) are listed so they don't count as
 * unknown.
 */
const SHAPES: Record<string, NodeKind> = {
  rectangle: 'rectangle',
  rect: 'rectangle',
  label: 'rectangle',
  ellipse: 'attribute',
  doubleEllipse: 'attribute',
  rhombus: 'relationship',
  cylinder: 'database',
  cylinder2: 'database',
  cylinder3: 'database',
  datastore: 'database',
  umlActor: 'actor',
  actor: 'actor',
  cloud: 'cloud',
  hexagon: 'hexagon',
  process: 'process',
  process2: 'process',
  step: 'process',
  note: 'note',
  note2: 'note',
  document: 'file',
  card: 'card',
  folder: 'folder',
  component: 'component',
  module: 'component',
  cube: 'node',
  umlLifeline: 'rectangle',
  parallelogram: 'rectangle',
  trapezoid: 'rectangle',
  triangle: 'rectangle',
  tape: 'rectangle',
  internalStorage: 'rectangle',
  callout: 'note',
  dataStorage: 'database',
  manualInput: 'rectangle',
  delay: 'action',
  display: 'action',
  or: 'attribute',
  xor: 'attribute',
  offPageConnector: 'rectangle',
  partialRectangle: 'rectangle',
  swimlane: 'rectangle',
  umlFrame: 'rectangle',
  umlBoundary: 'boundary',
  umlControl: 'control',
  umlEntity: 'entity',
  providedRequiredInterface: 'interface',
  lollipop: 'interface',
  queue: 'queue',
};

/** Bare style names draw.io's default stylesheet defines. */
const NAMED_STYLES: Record<string, NodeKind> = {
  ellipse: 'attribute',
  rhombus: 'relationship',
  text: 'label',
  swimlane: 'rectangle',
  triangle: 'rectangle',
  line: 'rectangle',
  image: 'rectangle',
  label: 'rectangle',
  icon: 'rectangle',
};

function vertexKind(style: Style): { kind: NodeKind; unknown?: string; double?: boolean } {
  const shape = style.values.get('shape');
  if (shape) {
    if (shape.startsWith('mxgraph.flowchart.')) {
      const kind = FLOWCHART[shape.slice('mxgraph.flowchart.'.length)];
      return kind ? { kind } : { kind: 'rectangle', unknown: shape };
    }
    if (shape === 'image') return { kind: 'rectangle', unknown: 'image' };
    const kind = SHAPES[shape];
    if (kind) return { kind, double: shape === 'doubleEllipse' };
    return { kind: 'rectangle', unknown: shape };
  }
  if (style.names.has('image')) return { kind: 'rectangle', unknown: 'image' };
  for (const name of style.names) {
    const kind = NAMED_STYLES[name];
    if (kind) return { kind };
  }
  return { kind: style.values.get('rounded') === '1' ? 'action' : 'rectangle' };
}

/** draw.io marker → our head. `fill` is `endFill`/`startFill` (default filled). */
function arrowHead(marker: string | undefined, fill: boolean): ArrowHead {
  switch (marker) {
    case undefined:
    case 'classic':
    case 'classicThin':
    case 'open':
    case 'openThin':
    case 'openAsync':
    case 'async':
    case 'dash':
    case 'halfCircle':
      return 'arrow';
    case 'block':
    case 'blockThin':
      return fill ? 'arrow' : 'triangle';
    case 'diamond':
    case 'diamondThin':
      return fill ? 'diamondFilled' : 'diamond';
    case 'oval':
    case 'circle':
      return fill ? 'dot' : 'circle';
    case 'circlePlus':
      return 'circlePlus';
    case 'cross':
      return 'cross';
    case 'box':
      return 'square';
    case 'ERmany':
      return 'crowMany';
    case 'ERone':
    case 'ERmandOne':
      return 'crowOne';
    case 'ERzeroToMany':
      return 'crowZeroMany';
    case 'ERoneToMany':
      return 'crowOneMany';
    case 'ERzeroToOne':
      return 'crowZeroOne';
    case 'none':
    case '':
      return 'none';
  }
  return 'arrow';
}

function edgeKind(head: ArrowHead, tail: ArrowHead, dashed: boolean): EdgeKind {
  const ends = [head, tail];
  if (ends.includes('triangle')) return dashed ? 'realization' : 'generalization';
  if (ends.includes('diamondFilled')) return 'composition';
  if (ends.includes('diamond')) return 'aggregation';
  return dashed ? 'dependency' : 'association';
}

const empty = (warnings: ParseWarning[]): ParseResult => ({ diagram: { family: 'description', direction: 'TB', nodes: [], containers: [], edges: [] }, warnings });

/**
 * Page keys: the page id draw.io writes on every `<diagram>`, else its name,
 * else `#n` (1-based). Made unique, since hand-edited files can repeat them.
 */
export function drawioPageKeys(pages: XmlElement[]): { key: string; name: string }[] {
  const seen = new Set<string>();
  return pages.map((p, i) => {
    let key = p.attrs.id || p.attrs.name || `#${i + 1}`;
    if (seen.has(key)) key = `${key}#${i + 1}`;
    seen.add(key);
    return { key, name: p.attrs.name || `Page-${i + 1}` };
  });
}

export function parseDrawio(source: string, options: ParseOptions = {}): ParseResult {
  const warnings: ParseWarning[] = [];
  const doc = parseXml(source);
  const file = findElement(doc, 'mxfile');
  let model: XmlElement | undefined;
  /** Compressed pages have no line structure of their own: everything points at the `<diagram>`. */
  let fixedLine: number | undefined;
  /** Multi-page files: the page list and which one this is, attached to whatever we return. */
  let paging: Pick<ParseResult, 'pages' | 'page'> = {};
  const withPaging = (r: ParseResult): ParseResult => ({ ...r, ...paging });

  if (file) {
    const pages = file.children.filter((c) => c.name === 'diagram');
    if (!pages.length) return empty([{ line: file.line, text: '', message: 'draw.io file has no pages' }]);
    const keys = drawioPageKeys(pages);
    let index = 0;
    const wanted = options.page;
    if (typeof wanted === 'number') index = wanted >= 0 && wanted < pages.length ? wanted : -1;
    else if (wanted !== undefined) {
      index = keys.findIndex((k) => k.key === wanted);
      if (index < 0) index = keys.findIndex((k) => k.name === wanted);
    }
    if (index < 0) {
      warnings.push({ line: file.line, text: '', message: `No page ${JSON.stringify(wanted)}; showing the first ("${keys[0]!.name}")` });
      index = 0;
    }
    if (pages.length > 1) paging = { pages: keys, page: index };
    const page = pages[index]!;
    model = findElement(page, 'mxGraphModel');
    if (!model && page.text.trim()) {
      try {
        model = findElement(parseXml(decompressPage(page.text.trim())), 'mxGraphModel');
        fixedLine = page.line;
      } catch (e) {
        return withPaging(empty([...warnings, { line: page.line, text: '', message: `Could not decompress the page: ${(e as Error).message}` }]));
      }
    }
  } else {
    model = findElement(doc, 'mxGraphModel');
  }
  const root = model && findElement(model, 'root');
  if (!root) return withPaging(empty([...warnings, { line: 1, text: '', message: 'No <mxGraphModel><root> found' }]));

  // ---- cells -----------------------------------------------------------------------------------
  const cells: Cell[] = [];
  for (const el of root.children) {
    let cellEl: XmlElement | undefined;
    let id: string | undefined;
    let value: string | undefined;
    if (el.name === 'mxCell') {
      cellEl = el;
      id = el.attrs.id;
      value = el.attrs.value;
    } else if (el.name === 'UserObject' || el.name === 'object') {
      // Wrappers carry the id and the label; the inner mxCell carries the rest.
      cellEl = el.children.find((c) => c.name === 'mxCell');
      id = el.attrs.id;
      value = el.attrs.label;
    }
    if (!cellEl || id === undefined) continue;
    if (cellEl.attrs.visible === '0') continue;
    // Our own template backdrop (bands, hexagons, rings): pictures of the layout, not diagram elements.
    if (/(^|;)pumlTemplate=1/.test(cellEl.attrs.style ?? '')) continue;
    cells.push({
      id,
      parent: cellEl.attrs.parent,
      value: value ?? '',
      style: parseStyle(cellEl.attrs.style),
      vertex: cellEl.attrs.vertex === '1',
      edge: cellEl.attrs.edge === '1',
      source: cellEl.attrs.source,
      target: cellEl.attrs.target,
      geometry: cellEl.children.find((c) => c.name === 'mxGeometry'),
      line: fixedLine ?? el.line,
    });
  }
  const byId = new Map(cells.map((c) => [c.id, c]));
  const childrenOf = new Map<string, Cell[]>();
  for (const c of cells) if (c.parent) childrenOf.set(c.parent, [...(childrenOf.get(c.parent) ?? []), c]);
  const vertexChildren = (id: string) => (childrenOf.get(id) ?? []).filter((c) => c.vertex);
  // Root (no parent) and layers (children of the root that are neither vertex nor edge) are not drawn.
  const isLayer = (id: string | undefined): boolean => {
    const c = id === undefined ? undefined : byId.get(id);
    return !c || (!c.vertex && !c.edge);
  };
  const label = (c: Cell) => labelText(c.value, c.style.values.get('html') === '1');

  // ---- absolute geometry ----------------------------------------------------------------------
  const boxCache = new Map<string, SourceBox>();
  const boxOf = (c: Cell): SourceBox => {
    const cached = boxCache.get(c.id);
    if (cached) return cached;
    const g = c.geometry?.attrs ?? {};
    const w = num(g.width);
    const h = num(g.height);
    let x = num(g.x);
    let y = num(g.y);
    const parent = c.parent ? byId.get(c.parent) : undefined;
    if (parent?.vertex) {
      const p = boxOf(parent);
      if (g.relative === '1') {
        // Relative children (ports, badges): fractions of the parent plus an offset.
        const offset = c.geometry?.children.find((e) => e.name === 'mxPoint' && e.attrs.as === 'offset')?.attrs ?? {};
        x = p.x + x * p.w + num(offset.x);
        y = p.y + y * p.h + num(offset.y);
      } else {
        x += p.x;
        y += p.y;
      }
    }
    const box = { x, y, w, h };
    boxCache.set(c.id, box);
    return box;
  };
  /** Offset of a cell's children's coordinates (edge waypoints use their parent's). */
  const originOf = (id: string | undefined): [number, number] => {
    const c = id === undefined ? undefined : byId.get(id);
    if (!c?.vertex) return [0, 0];
    const b = boxOf(c);
    return [b.x, b.y];
  };

  // ---- vertices: nodes, containers, tables ----------------------------------------------------
  const nodes: DNode[] = [];
  const containers: DContainer[] = [];
  /** Cell id → the element that stands for it (rows of a table point at the table). */
  const alias = new Map<string, string>();
  /** Effective parent container for a cell's children (unlabelled groups pass theirs through). */
  const parentFor = new Map<string, string | undefined>();
  const edgeEnds = new Set(cells.filter((c) => c.edge).flatMap((c) => [c.source, c.target]).filter((v): v is string => !!v));
  const unknown = new Map<string, number>();

  const effectiveParent = (c: Cell): string | undefined => {
    if (!c.parent || isLayer(c.parent)) return undefined;
    return parentFor.has(c.parent) ? parentFor.get(c.parent) : c.parent;
  };

  /** Tables: an ER entity as a stack-layout swimlane of text rows, or `shape=table` of rows of cells. */
  const tableRows = (c: Cell): string[][] | undefined => {
    const kids = vertexChildren(c.id);
    if (!kids.length) return undefined;
    if (c.style.values.get('shape') === 'table') {
      return [kids.map((row) => vertexChildren(row.id).map(label).filter(Boolean).join('  ')).filter(Boolean)];
    }
    if (c.style.names.has('swimlane') && c.style.values.get('childLayout') === 'stackLayout' && kids.every((k) => !vertexChildren(k.id).length)) {
      return [kids.map(label).filter(Boolean)];
    }
    return undefined;
  };
  const aliasAll = (from: string, to: string) => {
    alias.set(from, to);
    for (const k of childrenOf.get(from) ?? []) if (k.vertex) aliasAll(k.id, to);
  };

  const visit = (c: Cell) => {
    if (!c.vertex) return;
    const parentCell = c.parent ? byId.get(c.parent) : undefined;
    if (parentCell?.edge) return; // an edge label, attached below
    const box = boxOf(c);
    const kids = vertexChildren(c.id);
    const text = label(c);
    const parent = effectiveParent(c);
    const line = c.line;

    const rows = tableRows(c);
    if (rows) {
      const table: DNode = { id: c.id, kind: 'class', classKind: 'entity', label: text, compartments: rows, parent, sourceBox: box, line };
      readPumlKeys(c.style, table);
      nodes.push(table);
      for (const k of kids) aliasAll(k.id, c.id);
      return;
    }
    if (kids.length) {
      // Unlabelled groups are invisible in draw.io: flatten them unless a line points at one.
      if (c.style.names.has('group') && !text && !edgeEnds.has(c.id)) parentFor.set(c.id, parent);
      else containers.push({ id: c.id, kind: c.style.names.has('swimlane') ? 'lane' : 'group', label: text, parent, sourceBox: box, line });
      for (const k of kids) visit(k);
      return;
    }
    if (c.style.names.has('text') && !text) return; // empty text cell: nothing to draw
    const { kind, unknown: name, double } = vertexKind(c.style);
    if (name) unknown.set(name, (unknown.get(name) ?? 0) + 1);
    const node: DNode = { id: c.id, kind, label: text, parent, sourceBox: box, line };
    if (double) node.double = true;
    if (c.style.values.get('whiteSpace') === 'wrap') node.wrap = true;
    readPumlKeys(c.style, node);
    nodes.push(node);
  };
  for (const c of cells) if (c.vertex && isLayer(c.parent)) visit(c);

  // ---- edges ----------------------------------------------------------------------------------
  const known = new Set([...nodes.map((n) => n.id), ...containers.map((c) => c.id)]);
  const resolve = (id: string | undefined) => {
    if (!id) return undefined;
    const target = alias.get(id) ?? id;
    return known.has(target) ? target : undefined;
  };
  const edges: DEdge[] = [];
  for (const c of cells) {
    if (!c.edge) continue;
    const from = resolve(c.source);
    const to = resolve(c.target);
    if (!from || !to) {
      const missing = !c.source || !c.target ? 'has a loose end' : 'connects to something that is not a shape';
      warnings.push({ line: c.line, text: c.value ? label(c) : c.id, message: `Skipped line ${c.id}: it ${missing}` });
      continue;
    }
    const s = c.style.values;
    const dashed = s.get('dashed') === '1';
    const head = arrowHead(s.get('endArrow'), s.get('endFill') !== '0');
    const tail = s.has('startArrow') ? arrowHead(s.get('startArrow'), s.get('startFill') !== '0') : 'none';
    const edge: DEdge = { id: c.id, from, to, kind: edgeKind(head, tail, dashed), dashed, head, tail, hidden: false, line: c.line };

    // Waypoints are in the coordinates of the edge's parent.
    const [ox, oy] = originOf(c.parent);
    const points = c.geometry?.children.find((e) => e.name === 'Array' && e.attrs.as === 'points');
    const via = (points?.children ?? []).filter((p) => p.name === 'mxPoint').map((p): [number, number] => [num(p.attrs.x) + ox, num(p.attrs.y) + oy]);
    if (via.length) edge.sourceVia = via;
    // Fixed connection points. Our own export also pins the ends the router chose, so draw.io draws
    // the same path; it flags those `pumlAutoExit`/`pumlAutoEntry` and they read back as automatic.
    for (const [which, key] of [['exit', 'sourceFrom'], ['entry', 'sourceTo']] as const) {
      const x = Number(s.get(`${which}X`));
      const y = Number(s.get(`${which}Y`));
      const auto = s.get(`pumlAuto${which === 'exit' ? 'Exit' : 'Entry'}`) === '1';
      if (!auto && s.has(`${which}X`) && s.has(`${which}Y`) && Number.isFinite(x) && Number.isFinite(y)) edge[key] = [Math.min(1, Math.max(0, x)), Math.min(1, Math.max(0, y))];
    }

    // Labels: the edge's own value, plus `edgeLabel` children placed along it (-1 = source end, 1 = target end).
    const middle: string[] = [];
    if (label(c)) middle.push(label(c));
    for (const child of childrenOf.get(c.id) ?? []) {
      if (!child.vertex) continue;
      const text = label(child);
      if (!text) continue;
      const along = num(child.geometry?.attrs.x);
      if (along <= -0.5 && !edge.fromLabel) edge.fromLabel = text;
      else if (along >= 0.5 && !edge.toLabel) edge.toLabel = text;
      else middle.push(text);
    }
    if (middle.length) edge.label = middle.join('\n');
    edges.push(edge);
  }

  if (unknown.size) {
    const total = [...unknown.values()].reduce((a, b) => a + b, 0);
    const names = [...unknown.entries()].map(([name, n]) => (n > 1 ? `${name} ×${n}` : name)).join(', ');
    warnings.push({ line: fixedLine ?? 1, text: '', message: `${total} shape${total > 1 ? 's' : ''} drawn as plain boxes (no matching element kind): ${names}` });
  }
  return withPaging({ diagram: { family: 'description', direction: 'TB', nodes, containers, edges }, warnings });
}
