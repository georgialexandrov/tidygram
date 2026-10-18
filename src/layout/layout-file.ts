/**
 * The sidecar: `diagram.layout.json` next to `diagram.puml`, keyed by the
 * element ids from the PlantUML source. Positions are node centres.
 *
 * Multi-page draw.io files: the first page's layout is the top level, exactly
 * like a single-page file (so sidecars written before pages existed, and
 * every PlantUML/Mermaid sidecar, stay valid). Every other page gets its own
 * `view`/`nodes`/`edges` under `pages`, keyed by the draw.io page id, which
 * survives renaming the page:
 *
 *     { "version": 1, "nodes": { ... }, "edges": { ... },
 *       "pages": { "p2": { "view": { ... }, "nodes": { ... }, "edges": { ... } } } }
 *
 * Use `pageLayout` / `withPageLayout` to read and write one page; the rest of
 * the code only ever sees a single page's `LayoutFile`.
 *
 * Edges: `via` (absolute checkpoints), `label` (offset), and `from` / `to`,
 * hand-chosen attachment points (see `EndAttach`), relative to the element
 * so they survive moves and resizes:
 *
 *     "edges": { "a-->b": { "from": { "x": 1, "y": 0.5, "side": "right" } } }
 *
 * Auto layout, Fit and templates keep them (`chosenEnds`); Reset and
 * Straighten drop them. Sidecars without them are automatic, as before.
 *
 * Architecture templates (`template`, see `TemplateSettings`): the source
 * can't say which layer an element belongs to and is never written, so the
 * template and the element → layer assignment live here, per page. While a
 * template is on, `nodes` hold the template's arrangement and `template.free`
 * keeps the free layout it replaced. Sidecars without `template` are free
 * layouts, exactly as before.
 *
 * C4 zoom levels (`src/model/c4-views.ts`): the diagram as written is the
 * top level; each view (`context`, `container:<id>`, `component:<id>`) has
 * its own `template`, `nodes` and `edges` under `views`, keyed like the CLI's
 * `--view`. A view without its own `view` settings uses the top level's
 * (theme, frame, ...), and only stores them when they differ:
 *
 *     { "version": 1, "nodes": { ... }, "edges": { ... },
 *       "views": { "context": { "nodes": { ... }, "edges": { ... } } } }
 *
 * `viewLayout` / `withViewLayout` read and write one view; `sliceLayout` /
 * `withSliceLayout` take a page and a view at once.
 */

export type Point = [number, number];

export interface NodeLayout {
  x: number;
  y: number;
  /** Set when a human placed the node; auto layout leaves pinned nodes alone. */
  pinned?: boolean;
}

export type AttachSide = 'top' | 'right' | 'bottom' | 'left';

export const ATTACH_SIDES: AttachSide[] = ['top', 'right', 'bottom', 'left'];

/**
 * Where a line attaches to one of its ends, chosen by hand (the editor's end
 * handles, or a draw.io file's `exitX/exitY`/`entryX/entryY`). Relative to
 * the element's drawn outline so it survives moves and resizes: `x`, `y` are
 * fractions (0..1) of the outline's bounding box (draw.io's convention), and
 * `side` is the direction the line leaves in, so it meets the outline
 * square-on from there. On round shapes the point is projected onto the
 * outline along `side`.
 */
export interface EndAttach {
  x: number;
  y: number;
  side: AttachSide;
}

export interface EdgeLayout {
  /** Checkpoints the route must pass through, in order. */
  via?: Point[];
  /** Label offset from its automatic position. */
  label?: Point;
  /** Hand-chosen attachment at the source end; absent = automatic. */
  from?: EndAttach;
  /** Hand-chosen attachment at the target end; absent = automatic. */
  to?: EndAttach;
}

export interface ViewSettings {
  /** Visual theme (see scene/theme.ts). */
  theme?: string;
  /** Target aspect ratio as [width, height], e.g. [16, 9]. */
  frame?: Point;
  /** Size of text, icons and shapes relative to the theme's design (1 = 100%). */
  scale?: number;
  /** Extra multiplier for text only, on top of `scale`. */
  text?: number;
  /** Extra multiplier for actor/system icons only, on top of `scale`. */
  icons?: number;
  /** Sequence diagrams: column and row gap multipliers. */
  spacing?: Point;
}

/**
 * The architecture templates: one picture where layers are bands (layered), a hexagon (ports & adapters) or rings (clean / onion).
 * `tiers` is C4's reading in bands: people on top, the system in scope in the middle, external systems below.
 */
export type TemplateKind = 'layered' | 'hexagonal' | 'clean' | 'tiers';

export const TEMPLATE_KINDS: TemplateKind[] = ['layered', 'hexagonal', 'clean', 'tiers'];

/** Kinds drawn as horizontal bands (geometry, placement, drop regions, layer rules). */
export const bandsKind = (kind: TemplateKind) => kind === 'layered' || kind === 'tiers';

/** One band, ring or hexagon role. `id` is what assignments refer to; `label` is drawn. */
export interface LayerDef {
  id: string;
  label: string;
}

/**
 * Which dependencies count as violations. Layered: `relaxed` flags lines
 * that point up (a lower layer using a higher one), `strict` also flags lines
 * that skip a layer. Hexagonal and clean have one rule set (`off` disables it).
 */
export type TemplateRules = 'strict' | 'relaxed' | 'off';

export interface TemplateSettings {
  kind: TemplateKind;
  /**
   * Bands top to bottom (layered), rings inside out (clean). Hexagonal has
   * fixed roles (driving, inbound, application, domain, outbound, driven);
   * only their labels can change. Absent: the kind's default (ArchiMate
   * diagrams get business / application / technology).
   */
  layers?: LayerDef[];
  /** Absent: `relaxed` (`off` for ArchiMate, whose serving lines point up by design). */
  rules?: TemplateRules;
  /** Assignments a human made (dragged into a band, ring or zone): element id → layer id. Never re-guessed. */
  assign: Record<string, string>;
  /**
   * Machine guesses (names, stereotypes, containers, kinds, graph position):
   * element id → layer id. Re-guessed whenever the diagram loads, so a source
   * edit can move an element whose layer nobody confirmed.
   */
  guess: Record<string, string>;
  /** The free layout from before the template was applied; turning the template off restores it. */
  free?: { nodes: Record<string, NodeLayout>; edges: Record<string, EdgeLayout> };
}

export interface LayoutFile {
  version: 1;
  view?: ViewSettings;
  /** Architecture template on this page, if any. */
  template?: TemplateSettings;
  nodes: Record<string, NodeLayout>;
  edges: Record<string, EdgeLayout>;
  /** Layouts of the other pages of a multi-page draw.io file, by page id. Absent otherwise. */
  pages?: Record<string, PageLayout>;
  /** Layouts of C4 zoom levels (`context`, `container:<id>`, `component:<id>`), by view key. Absent otherwise. */
  views?: Record<string, PageLayout>;
}

/** One non-first page's layout: a `LayoutFile` without the version or further pages. */
export interface PageLayout {
  view?: ViewSettings;
  template?: TemplateSettings;
  nodes: Record<string, NodeLayout>;
  edges: Record<string, EdgeLayout>;
}

export function emptyLayout(): LayoutFile {
  return { version: 1, nodes: {}, edges: {} };
}

/**
 * The layout of one page. `page` is the page's key (`ParseResult.pages[i].key`);
 * undefined, or the first page's key, means the top level.
 */
export function pageLayout(file: LayoutFile, page?: string): LayoutFile {
  if (page === undefined) {
    const { pages: _pages, views: _views, ...top } = file;
    return top;
  }
  const entry = file.pages?.[page];
  return entry ? { version: 1, ...entry } : emptyLayout();
}

/** The whole sidecar with one page's layout replaced; an emptied page drops out of `pages`. */
export function withPageLayout(file: LayoutFile, page: string | undefined, layout: LayoutFile): LayoutFile {
  const { version: _version, pages: _pages, views: _views, ...entry } = layout;
  if (page === undefined) return { ...entry, version: 1, ...(file.pages ? { pages: file.pages } : {}), ...(file.views ? { views: file.views } : {}) };
  const pages = { ...file.pages };
  if (entry.view || entry.template || Object.keys(entry.nodes).length || Object.keys(entry.edges).length) pages[page] = entry;
  else delete pages[page];
  const { pages: _old, ...top } = file;
  return Object.keys(pages).length ? { ...top, pages } : top;
}

/** One C4 view's layout (undefined: the diagram as written, the top level). Without its own `view` settings it takes the top level's. */
export function viewLayout(file: LayoutFile, view?: string): LayoutFile {
  if (view === undefined) return pageLayout(file);
  const entry = file.views?.[view];
  const settings = entry?.view ?? file.view;
  const out: LayoutFile = { version: 1, ...(settings ? { view: settings } : {}), nodes: entry?.nodes ?? {}, edges: entry?.edges ?? {} };
  if (entry?.template) out.template = entry.template;
  return out;
}

/** The whole sidecar with one view's layout replaced; `view` settings equal to the top level's aren't repeated; an emptied view drops out. */
export function withViewLayout(file: LayoutFile, view: string | undefined, layout: LayoutFile): LayoutFile {
  if (view === undefined) return withPageLayout(file, undefined, layout);
  const { version: _version, pages: _pages, views: _views, view: settings, ...rest } = layout;
  const entry: PageLayout = { ...(settings && JSON.stringify(settings) !== JSON.stringify(file.view ?? {}) ? { view: settings } : {}), ...rest };
  const views = { ...file.views };
  if (entry.view || entry.template || Object.keys(entry.nodes).length || Object.keys(entry.edges).length) views[view] = entry;
  else delete views[view];
  const { views: _old, ...top } = file;
  return Object.keys(views).length ? { ...top, views } : top;
}

/** A page of a draw.io file, or a view of a C4 file (views live at the top level; C4 files have one page). */
export function sliceLayout(file: LayoutFile, page?: string, view?: string): LayoutFile {
  return view === undefined ? pageLayout(file, page) : viewLayout(file, view);
}

export function withSliceLayout(file: LayoutFile, page: string | undefined, view: string | undefined, layout: LayoutFile): LayoutFile {
  return view === undefined ? withPageLayout(file, page, layout) : withViewLayout(file, view, layout);
}

/**
 * Hand-chosen line ends without the bends and label offsets: what Auto
 * layout keeps. Ends are stored relative to their element, so they still
 * mean the same after everything moves; bends are absolute and don't.
 */
export function chosenEnds(edges: LayoutFile['edges']): LayoutFile['edges'] {
  const out: LayoutFile['edges'] = {};
  for (const [id, e] of Object.entries(edges)) {
    if (!e.from && !e.to) continue;
    out[id] = { ...(e.from ? { from: e.from } : {}), ...(e.to ? { to: e.to } : {}) };
  }
  return out;
}

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const point = (v: unknown): Point | undefined => {
  if (!Array.isArray(v) || v.length !== 2) return undefined;
  const x = num(v[0]);
  const y = num(v[1]);
  return x === undefined || y === undefined ? undefined : [x, y];
};

/** Tolerant reader: drops malformed entries instead of rejecting the file, since agents edit it too. */
export function parseLayout(text: string): LayoutFile {
  if (!text.trim()) return emptyLayout();
  const raw = JSON.parse(text) as Record<string, unknown>;
  const layout = readPage(raw);
  const pages = readEntries(raw.pages);
  if (pages) layout.pages = pages;
  const views = readEntries(raw.views);
  if (views) layout.views = views;
  return layout;
}

/** `pages` / `views`: a map of page-shaped entries; malformed ones are dropped. */
function readEntries(raw: unknown): Record<string, PageLayout> | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const out: Record<string, PageLayout> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== 'object') continue;
    const { version: _version, ...page } = readPage(value as Record<string, unknown>);
    out[key] = page;
  }
  return Object.keys(out).length ? out : undefined;
}

function readNodes(raw: unknown): Record<string, NodeLayout> {
  const nodes: Record<string, NodeLayout> = {};
  if (!raw || typeof raw !== 'object') return nodes;
  for (const [id, value] of Object.entries(raw as Record<string, Record<string, unknown>>)) {
    const x = num(value?.x);
    const y = num(value?.y);
    if (x === undefined || y === undefined) continue;
    nodes[id] = value.pinned === true ? { x, y, pinned: true } : { x, y };
  }
  return nodes;
}

function readEdges(raw: unknown): Record<string, EdgeLayout> {
  const edges: Record<string, EdgeLayout> = {};
  if (!raw || typeof raw !== 'object') return edges;
  for (const [id, value] of Object.entries(raw as Record<string, Record<string, unknown>>)) {
    const entry: EdgeLayout = {};
    if (Array.isArray(value?.via)) {
      const via = value.via.map(point).filter((p): p is Point => p !== undefined);
      if (via.length) entry.via = via;
    }
    const label = point(value?.label);
    if (label) entry.label = label;
    const from = readAttach(value?.from);
    if (from) entry.from = from;
    const to = readAttach(value?.to);
    if (to) entry.to = to;
    if (entry.via || entry.label || entry.from || entry.to) edges[id] = entry;
  }
  return edges;
}

/** The side a fraction point lies on: the nearest edge of the unit box (corners: the first of top/bottom, then left/right). */
export function sideOfFraction(x: number, y: number): AttachSide {
  const d: [AttachSide, number][] = [['top', y], ['bottom', 1 - y], ['left', x], ['right', 1 - x]];
  return d.reduce((a, b) => (b[1] < a[1] ? b : a))[0];
}

/** Tolerant: fractions are clamped to 0..1, a missing or unknown side is taken from the point. */
export function readAttach(raw: unknown): EndAttach | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const o = raw as Record<string, unknown>;
  const x = num(o.x);
  const y = num(o.y);
  if (x === undefined || y === undefined) return undefined;
  const cx = Math.min(1, Math.max(0, x));
  const cy = Math.min(1, Math.max(0, y));
  const side = ATTACH_SIDES.includes(o.side as AttachSide) ? (o.side as AttachSide) : sideOfFraction(cx, cy);
  return { x: cx, y: cy, side };
}

const stringMap = (raw: unknown): Record<string, string> =>
  raw && typeof raw === 'object' ? Object.fromEntries(Object.entries(raw as Record<string, unknown>).filter((e): e is [string, string] => typeof e[1] === 'string' && e[1] !== '')) : {};

/** Tolerant like the rest: an unknown kind drops the template, malformed layers fall back to the default. */
function readTemplate(raw: unknown): TemplateSettings | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const t = raw as Record<string, unknown>;
  if (!TEMPLATE_KINDS.includes(t.kind as TemplateKind)) return undefined;
  const template: TemplateSettings = { kind: t.kind as TemplateKind, assign: stringMap(t.assign), guess: stringMap(t.guess) };
  if (Array.isArray(t.layers)) {
    const layers = t.layers.flatMap((l): LayerDef[] => {
      if (typeof l === 'string' && l) return [{ id: l, label: l }];
      const o = l as Record<string, unknown> | null;
      return o && typeof o.id === 'string' && o.id ? [{ id: o.id, label: typeof o.label === 'string' ? o.label : o.id }] : [];
    });
    if (layers.length && new Set(layers.map((l) => l.id)).size === layers.length) template.layers = layers;
  }
  if (t.rules === 'strict' || t.rules === 'relaxed' || t.rules === 'off') template.rules = t.rules;
  if (t.free && typeof t.free === 'object') {
    const f = t.free as Record<string, unknown>;
    template.free = { nodes: readNodes(f.nodes), edges: readEdges(f.edges) };
  }
  return template;
}

function readPage(raw: { nodes?: unknown; edges?: unknown; view?: Record<string, unknown>; template?: unknown }): LayoutFile {
  const layout = emptyLayout();
  if (raw.view && typeof raw.view === 'object') {
    const view: ViewSettings = {};
    if (typeof raw.view.theme === 'string') view.theme = raw.view.theme;
    const frame = point(raw.view.frame);
    if (frame && frame[0] > 0 && frame[1] > 0) view.frame = frame;
    const scale = num(raw.view.scale);
    if (scale !== undefined && scale >= 0.25 && scale <= 6 && scale !== 1) view.scale = scale;
    const text = num(raw.view.text);
    if (text !== undefined && text >= 0.25 && text <= 6 && text !== 1) view.text = text;
    const icons = num(raw.view.icons);
    if (icons !== undefined && icons >= 0.25 && icons <= 6 && icons !== 1) view.icons = icons;
    const spacing = point(raw.view.spacing);
    if (spacing && spacing[0] > 0 && spacing[1] > 0 && (spacing[0] !== 1 || spacing[1] !== 1)) view.spacing = spacing;
    if (view.theme || view.frame || view.scale || view.text || view.icons || view.spacing) layout.view = view;
  }
  const template = readTemplate(raw.template);
  if (template) layout.template = template;
  layout.nodes = readNodes(raw.nodes);
  layout.edges = readEdges(raw.edges);
  return layout;
}

const r = (v: number) => Math.round(v);
/** Attachment fractions: three decimals is a tenth of a pixel on a 100 px box. */
const frac = (v: number) => Math.round(v * 1000) / 1000;
const sortedKeys = (o: object) => Object.keys(o).sort((a, b) => a.localeCompare(b));

/** One entry per line, sorted keys, integer coordinates: small, stable diffs. Other pages follow, indented one level. */
export function serializeLayout(layout: LayoutFile): string {
  const entries = (name: string, map?: Record<string, PageLayout>) => {
    const items = map ? sortedKeys(map).map((key) => `    ${JSON.stringify(key)}: {\n${pageBody(map[key]!, '      ')}\n    }`) : [];
    return items.length ? `,\n  "${name}": {\n${items.join(',\n')}\n  }` : '';
  };
  return `{\n  "version": 1,\n${pageBody(layout, '  ')}${entries('pages', layout.pages)}${entries('views', layout.views)}\n}\n`;
}

const block = (lines: string[], pad: string) => (lines.length ? `{\n${lines.join(',\n')}\n${pad}}` : '{}');

function nodeLines(nodes: Record<string, NodeLayout>, pad: string): string[] {
  return sortedKeys(nodes).map((id) => {
    const n = nodes[id]!;
    const parts = [`"x": ${r(n.x)}`, `"y": ${r(n.y)}`];
    if (n.pinned) parts.push('"pinned": true');
    return `${pad}  ${JSON.stringify(id)}: { ${parts.join(', ')} }`;
  });
}

function edgeLines(edges: Record<string, EdgeLayout>, pad: string): string[] {
  return sortedKeys(edges).flatMap((id) => {
    const e = edges[id]!;
    const parts: string[] = [];
    if (e.via?.length) parts.push(`"via": [${e.via.map(([x, y]) => `[${r(x)}, ${r(y)}]`).join(', ')}]`);
    if (e.label) parts.push(`"label": [${r(e.label[0])}, ${r(e.label[1])}]`);
    for (const end of ['from', 'to'] as const) {
      const a = e[end];
      if (a) parts.push(`"${end}": { "x": ${frac(a.x)}, "y": ${frac(a.y)}, "side": "${a.side}" }`);
    }
    return parts.length ? [`${pad}  ${JSON.stringify(id)}: { ${parts.join(', ')} }`] : [];
  });
}

/** The template block: settings on one line each, one assignment per line, the stashed free layout last. */
function templateBody(t: TemplateSettings, pad: string): string {
  const inner = `${pad}  `;
  const lines = [`${inner}"kind": ${JSON.stringify(t.kind)}`];
  if (t.layers) lines.push(`${inner}"layers": [${t.layers.map((l) => `{ "id": ${JSON.stringify(l.id)}, "label": ${JSON.stringify(l.label)} }`).join(', ')}]`);
  if (t.rules) lines.push(`${inner}"rules": ${JSON.stringify(t.rules)}`);
  const map = (m: Record<string, string>) => block(sortedKeys(m).map((id) => `${inner}  ${JSON.stringify(id)}: ${JSON.stringify(m[id])}`), inner);
  lines.push(`${inner}"assign": ${map(t.assign)}`, `${inner}"guess": ${map(t.guess)}`);
  if (t.free) {
    const p = `${inner}  `;
    lines.push(`${inner}"free": {\n${p}"nodes": ${block(nodeLines(t.free.nodes, p), p)},\n${p}"edges": ${block(edgeLines(t.free.edges, p), p)}\n${inner}}`);
  }
  return `{\n${lines.join(',\n')}\n${pad}}`;
}

/** `view`, `template`, `nodes` and `edges` of one page at the given indent, without the closing newline. */
function pageBody(layout: PageLayout, pad: string): string {
  const viewParts: string[] = [];
  if (layout.view?.theme) viewParts.push(`"theme": ${JSON.stringify(layout.view.theme)}`);
  if (layout.view?.frame) viewParts.push(`"frame": [${layout.view.frame[0]}, ${layout.view.frame[1]}]`);
  if (layout.view?.scale && layout.view.scale !== 1) viewParts.push(`"scale": ${Math.round(layout.view.scale * 100) / 100}`);
  if (layout.view?.text && layout.view.text !== 1) viewParts.push(`"text": ${Math.round(layout.view.text * 100) / 100}`);
  if (layout.view?.icons && layout.view.icons !== 1) viewParts.push(`"icons": ${Math.round(layout.view.icons * 100) / 100}`);
  if (layout.view?.spacing) viewParts.push(`"spacing": [${layout.view.spacing.map((v) => Math.round(v * 100) / 100).join(', ')}]`);
  const view = viewParts.length ? `${pad}"view": { ${viewParts.join(', ')} },\n` : '';
  const template = layout.template ? `${pad}"template": ${templateBody(layout.template, pad)},\n` : '';
  return `${view}${template}${pad}"nodes": ${block(nodeLines(layout.nodes, pad), pad)},\n${pad}"edges": ${block(edgeLines(layout.edges, pad), pad)}`;
}
