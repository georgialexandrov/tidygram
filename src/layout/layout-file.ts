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
 */

export type Point = [number, number];

export interface NodeLayout {
  x: number;
  y: number;
  /** Set when a human placed the node; auto layout leaves pinned nodes alone. */
  pinned?: boolean;
}

export interface EdgeLayout {
  /** Checkpoints the route must pass through, in order. */
  via?: Point[];
  /** Label offset from its automatic position. */
  label?: Point;
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

export interface LayoutFile {
  version: 1;
  view?: ViewSettings;
  nodes: Record<string, NodeLayout>;
  edges: Record<string, EdgeLayout>;
  /** Layouts of the other pages of a multi-page draw.io file, by page id. Absent otherwise. */
  pages?: Record<string, PageLayout>;
}

/** One non-first page's layout: a `LayoutFile` without the version or further pages. */
export interface PageLayout {
  view?: ViewSettings;
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
    const { pages: _pages, ...top } = file;
    return top;
  }
  const entry = file.pages?.[page];
  return entry ? { version: 1, ...entry } : emptyLayout();
}

/** The whole sidecar with one page's layout replaced; an emptied page drops out of `pages`. */
export function withPageLayout(file: LayoutFile, page: string | undefined, layout: LayoutFile): LayoutFile {
  const { version: _version, pages: _pages, ...entry } = layout;
  if (page === undefined) return file.pages ? { ...entry, version: 1, pages: file.pages } : { ...entry, version: 1 };
  const pages = { ...file.pages };
  if (entry.view || Object.keys(entry.nodes).length || Object.keys(entry.edges).length) pages[page] = entry;
  else delete pages[page];
  const { pages: _old, ...top } = file;
  return Object.keys(pages).length ? { ...top, pages } : top;
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
  if (raw.pages && typeof raw.pages === 'object') {
    const pages: Record<string, PageLayout> = {};
    for (const [key, value] of Object.entries(raw.pages as Record<string, unknown>)) {
      if (!value || typeof value !== 'object') continue;
      const { version: _version, ...page } = readPage(value as Record<string, unknown>);
      pages[key] = page;
    }
    if (Object.keys(pages).length) layout.pages = pages;
  }
  return layout;
}

function readPage(raw: { nodes?: unknown; edges?: unknown; view?: Record<string, unknown> }): LayoutFile {
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
  if (raw.nodes && typeof raw.nodes === 'object') {
    for (const [id, value] of Object.entries(raw.nodes as Record<string, Record<string, unknown>>)) {
      const x = num(value?.x);
      const y = num(value?.y);
      if (x === undefined || y === undefined) continue;
      layout.nodes[id] = value.pinned === true ? { x, y, pinned: true } : { x, y };
    }
  }
  if (raw.edges && typeof raw.edges === 'object') {
    for (const [id, value] of Object.entries(raw.edges as Record<string, Record<string, unknown>>)) {
      const entry: EdgeLayout = {};
      if (Array.isArray(value?.via)) {
        const via = value.via.map(point).filter((p): p is Point => p !== undefined);
        if (via.length) entry.via = via;
      }
      const label = point(value?.label);
      if (label) entry.label = label;
      if (entry.via || entry.label) layout.edges[id] = entry;
    }
  }
  return layout;
}

const r = (v: number) => Math.round(v);
const sortedKeys = (o: object) => Object.keys(o).sort((a, b) => a.localeCompare(b));

/** One entry per line, sorted keys, integer coordinates: small, stable diffs. Other pages follow, indented one level. */
export function serializeLayout(layout: LayoutFile): string {
  const pages = layout.pages ? sortedKeys(layout.pages).map((key) => `    ${JSON.stringify(key)}: {\n${pageBody(layout.pages![key]!, '      ')}\n    }`) : [];
  const tail = pages.length ? `,\n  "pages": {\n${pages.join(',\n')}\n  }` : '';
  return `{\n  "version": 1,\n${pageBody(layout, '  ')}${tail}\n}\n`;
}

/** `view`, `nodes` and `edges` of one page at the given indent, without the closing newline. */
function pageBody(layout: PageLayout, pad: string): string {
  const nodeLines = sortedKeys(layout.nodes).map((id) => {
    const n = layout.nodes[id]!;
    const parts = [`"x": ${r(n.x)}`, `"y": ${r(n.y)}`];
    if (n.pinned) parts.push('"pinned": true');
    return `${pad}  ${JSON.stringify(id)}: { ${parts.join(', ')} }`;
  });
  const edgeLines = sortedKeys(layout.edges).flatMap((id) => {
    const e = layout.edges[id]!;
    const parts: string[] = [];
    if (e.via?.length) parts.push(`"via": [${e.via.map(([x, y]) => `[${r(x)}, ${r(y)}]`).join(', ')}]`);
    if (e.label) parts.push(`"label": [${r(e.label[0])}, ${r(e.label[1])}]`);
    return parts.length ? [`${pad}  ${JSON.stringify(id)}: { ${parts.join(', ')} }`] : [];
  });
  const block = (lines: string[]) => (lines.length ? `{\n${lines.join(',\n')}\n${pad}}` : '{}');
  const viewParts: string[] = [];
  if (layout.view?.theme) viewParts.push(`"theme": ${JSON.stringify(layout.view.theme)}`);
  if (layout.view?.frame) viewParts.push(`"frame": [${layout.view.frame[0]}, ${layout.view.frame[1]}]`);
  if (layout.view?.scale && layout.view.scale !== 1) viewParts.push(`"scale": ${Math.round(layout.view.scale * 100) / 100}`);
  if (layout.view?.text && layout.view.text !== 1) viewParts.push(`"text": ${Math.round(layout.view.text * 100) / 100}`);
  if (layout.view?.icons && layout.view.icons !== 1) viewParts.push(`"icons": ${Math.round(layout.view.icons * 100) / 100}`);
  if (layout.view?.spacing) viewParts.push(`"spacing": [${layout.view.spacing.map((v) => Math.round(v * 100) / 100).join(', ')}]`);
  const view = viewParts.length ? `${pad}"view": { ${viewParts.join(', ')} },\n` : '';
  return `${view}${pad}"nodes": ${block(nodeLines)},\n${pad}"edges": ${block(edgeLines)}`;
}
