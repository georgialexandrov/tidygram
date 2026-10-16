/**
 * The sidecar: `diagram.layout.json` next to `diagram.puml`, keyed by the
 * element ids from the PlantUML source. Positions are node centres.
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
}

export interface LayoutFile {
  version: 1;
  view?: ViewSettings;
  nodes: Record<string, NodeLayout>;
  edges: Record<string, EdgeLayout>;
}

export function emptyLayout(): LayoutFile {
  return { version: 1, nodes: {}, edges: {} };
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
  const raw = JSON.parse(text) as { nodes?: unknown; edges?: unknown; view?: Record<string, unknown> };
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
    if (view.theme || view.frame || view.scale || view.text || view.icons) layout.view = view;
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

/** One entry per line, sorted keys, integer coordinates: small, stable diffs. */
export function serializeLayout(layout: LayoutFile): string {
  const nodeLines = sortedKeys(layout.nodes).map((id) => {
    const n = layout.nodes[id]!;
    const parts = [`"x": ${r(n.x)}`, `"y": ${r(n.y)}`];
    if (n.pinned) parts.push('"pinned": true');
    return `    ${JSON.stringify(id)}: { ${parts.join(', ')} }`;
  });
  const edgeLines = sortedKeys(layout.edges).flatMap((id) => {
    const e = layout.edges[id]!;
    const parts: string[] = [];
    if (e.via?.length) parts.push(`"via": [${e.via.map(([x, y]) => `[${r(x)}, ${r(y)}]`).join(', ')}]`);
    if (e.label) parts.push(`"label": [${r(e.label[0])}, ${r(e.label[1])}]`);
    return parts.length ? [`    ${JSON.stringify(id)}: { ${parts.join(', ')} }`] : [];
  });
  const block = (lines: string[]) => (lines.length ? `{\n${lines.join(',\n')}\n  }` : '{}');
  const viewParts: string[] = [];
  if (layout.view?.theme) viewParts.push(`"theme": ${JSON.stringify(layout.view.theme)}`);
  if (layout.view?.frame) viewParts.push(`"frame": [${layout.view.frame[0]}, ${layout.view.frame[1]}]`);
  if (layout.view?.scale && layout.view.scale !== 1) viewParts.push(`"scale": ${Math.round(layout.view.scale * 100) / 100}`);
  if (layout.view?.text && layout.view.text !== 1) viewParts.push(`"text": ${Math.round(layout.view.text * 100) / 100}`);
  if (layout.view?.icons && layout.view.icons !== 1) viewParts.push(`"icons": ${Math.round(layout.view.icons * 100) / 100}`);
  const view = viewParts.length ? `  "view": { ${viewParts.join(', ')} },\n` : '';
  return `{\n  "version": 1,\n${view}  "nodes": ${block(nodeLines)},\n  "edges": ${block(edgeLines)}\n}\n`;
}
