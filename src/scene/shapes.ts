import type { DNode, NodeKind } from '../model/types.ts';
import { LINE_HEIGHT, measureText, type TextBlock } from './measure.ts';
import { archimateLayer, type Theme } from './theme.ts';

/** Where lines attach, as offsets from the node centre. */
export interface Anchor {
  dx: number;
  dy: number;
  w: number;
  h: number;
  shape: 'ellipse' | 'rect' | 'pill' | 'diamond';
}

/** Box-like kinds draw their text inside an outline; these add room for their outline's extras. */
export const BOX_EXTRA: Partial<Record<NodeKind, { top?: number; bottom?: number; left?: number; right?: number }>> = {
  database: { top: 14, bottom: 6 },
  queue: { left: 8, right: 16 },
  node: { top: 8, right: 8 },
  cloud: { top: 10, bottom: 10, left: 18, right: 18 },
  folder: { top: 10 },
  component: { right: 18 },
  artifact: { right: 10 },
  file: { right: 10 },
  storage: { left: 6, right: 6 },
  hexagon: { left: 14, right: 14 },
  process: { left: 4, right: 14 },
  stack: { top: 6, right: 6 },
  collections: { top: 4, right: 4 },
  person: { top: 26 },
};

/** Kinds drawn as a small icon with the label underneath. */
const ICON_KINDS = new Set<NodeKind>(['actor', 'interface', 'boundary', 'control', 'entity', 'circle']);

export interface NodeShape {
  w: number;
  h: number;
  anchor: Anchor;
  text: TextBlock;
  stereo?: TextBlock;
  /** C4 technology line. */
  tech?: TextBlock;
  /** Description lines (states, C4). */
  desc?: TextBlock;
  /** Class-like boxes: header height and one block per compartment. */
  header?: number;
  compartments?: TextBlock[];
  /** Icon kinds: icon box size; the label sits below it. */
  icon?: { w: number; h: number };
  /** Class-like boxes: member rows split into aligned columns (marker, name, type). */
  members?: MemberLayout;
  /** ArchiMate elements: the layer (fill) and type glyph drawn in the corner instead of a stereotype. */
  archimate?: { layer: string; type: string };
}

/** One class member / ER column / JSON entry, split for column alignment. */
export interface MemberRow {
  /** UML visibility: + public, - private, # protected, ~ package. */
  vis?: '+' | '-' | '#' | '~';
  /** ER keys (PK, FK, UK) as written. */
  key?: string;
  /** IE notation `*`: mandatory. */
  required?: boolean;
  method: boolean;
  isStatic?: boolean;
  isAbstract?: boolean;
  name: string;
  type?: string;
}

export interface MemberLayout {
  rows: MemberRow[][];
  /** Column widths: marker (visibility glyph or key badge), name, gap, type. */
  marker: number;
  name: number;
  gap: number;
  type: number;
  rowH: number;
  /** Vertical padding of each compartment, above and below its rows. */
  pad: number;
  size: number;
}

/**
 * Splits a member line the way it reads: `-id : UUID`, `+total() : Money`,
 * `{static} +of(x) : Money`, `* id : bigint <<PK>>` (PlantUML IE),
 * `id : bigint PK — comment` (Mermaid ER), `key: value` (JSON tables).
 */
export function parseMember(line: string, json = false): MemberRow {
  if (json) {
    const i = line.indexOf(': ');
    return i > 0 ? { method: false, name: line.slice(0, i), type: line.slice(i + 2) } : { method: false, name: line };
  }
  let rest = line.trim();
  const row: MemberRow = { method: false, name: '' };
  for (;;) {
    const m = /^\{(static|classifier|abstract)\}\s*/.exec(rest);
    if (!m) break;
    if (m[1] === 'abstract') row.isAbstract = true;
    else row.isStatic = true;
    rest = rest.slice(m[0].length);
  }
  if (/^\*\s/.test(rest)) {
    row.required = true;
    rest = rest.slice(2).trim();
  }
  const vis = /^([+\-#~])\s*(?=\S)/.exec(rest);
  if (vis && rest.length > 1) {
    row.vis = vis[1] as MemberRow['vis'];
    rest = rest.slice(vis[0].length);
  }
  const keys: string[] = [];
  rest = rest.replace(/\s*<<\s*(PK|FK|UK)\s*>>/g, (_, key: string) => (keys.push(key), ''));
  const mermaidKeys = /\s((?:PK|FK|UK)(?:\s*,\s*(?:PK|FK|UK))*)(?=\s+—|$)/.exec(rest);
  if (mermaidKeys) {
    keys.push(...mermaidKeys[1]!.split(/\s*,\s*/));
    rest = rest.slice(0, mermaidKeys.index) + rest.slice(mermaidKeys.index + mermaidKeys[0].length);
  }
  if (keys.length) row.key = keys.join(' ');
  // `name : type`, split at the last ` : ` outside parentheses (method arguments have their own).
  let depth = 0;
  let split = -1;
  for (let i = 0; i < rest.length; i++) {
    const ch = rest[i];
    if (ch === '(' || ch === '<' || ch === '[') depth++;
    else if (ch === ')' || ch === '>' || ch === ']') depth--;
    else if (ch === ':' && depth === 0 && rest[i - 1] === ' ') split = i;
  }
  row.name = (split > 0 ? rest.slice(0, split) : rest).trim();
  if (split > 0) row.type = rest.slice(split + 1).trim();
  row.method = row.name.includes('(');
  return row;
}


const wrap = (text: string, width = 34) =>
  text
    .split('\n')
    .flatMap((line) => {
      const out: string[] = [];
      let current = '';
      for (const word of line.split(' ')) {
        if (current && current.length + word.length + 1 > width) {
          out.push(current);
          current = word;
        } else current = current ? `${current} ${word}` : word;
      }
      out.push(current);
      return out;
    })
    .join('\n');

/**
 * Size of a node's whole box (what layout positions refer to, by centre).
 * Nodes with a `sourceBox` (draw.io) keep the file's size; see `fileSized`.
 */
export function nodeShape(node: DNode, theme: Theme): NodeShape {
  if (!node.sourceBox || FREE_SIZE.has(node.kind)) return themedShape(node, theme);
  const label = node.wrap ? wrapToWidth(node, theme) : node.label;
  return fileSized(themedShape(label === node.label ? node : { ...node, label }, theme), node, theme);
}

/** Icon kinds draw a figure of the theme's size with the label underneath; a file box can't size them. */
export const FREE_SIZE = new Set<NodeKind>([...ICON_KINDS, 'actor']);

/** How much of a file box's width text may use, by outline: ellipses and diamonds narrow towards the edges. */
const TEXT_SHARE: Record<Anchor['shape'], number> = { rect: 1, pill: 0.85, ellipse: 0.75, diamond: 0.55 };

/**
 * draw.io sizes boxes deliberately, so the file's width and height (times
 * the view scale) are the element's size. They only grow where the theme's
 * text, which is not draw.io's font, needs more room: text plus a small
 * margin, not the theme's minimum box size.
 */
function fileSized(shape: NodeShape, node: DNode, theme: Theme): NodeShape {
  const k = theme.scale;
  const box = node.sourceBox!;
  const extra = BOX_EXTRA[node.kind] ?? {};
  // Kinds with outline extras (cloud bumps, cylinder caps) already reserve their margins.
  const share = extra.left || extra.right || extra.top ? 1 : TEXT_SHARE[shape.anchor.shape];
  let needW: number;
  let needH: number;
  if (shape.compartments) {
    needW = Math.max(shape.text.width + 28 * k, ...shape.compartments.map((c) => c.width + 24 * k));
    needH = shape.h;
  } else {
    const blocks = [shape.stereo, shape.text, shape.tech, shape.desc].filter((b): b is TextBlock => !!b);
    const textW = Math.max(0, ...blocks.map((b) => b.width));
    const textH = blocks.reduce((sum, b) => sum + b.height, 0);
    needW = textW / share + (12 + (extra.left ?? 0) + (extra.right ?? 0)) * k;
    needH = textH / (share === 1 ? 1 : share + 0.15) + (6 + (extra.top ?? 0) + (extra.bottom ?? 0)) * k;
  }
  const w = Math.ceil(Math.max(box.w * k, needW));
  const h = Math.ceil(Math.max(box.h * k, needH));
  return { ...shape, w, h, anchor: { ...shape.anchor, dx: 0, dy: 0, w, h } };
}

/** draw.io `whiteSpace=wrap`: break the label into lines that fit the file box, as draw.io does. */
function wrapToWidth(node: DNode, theme: Theme): string {
  const k = theme.scale;
  const shapeOf = node.kind === 'attribute' ? 'ellipse' : node.kind === 'relationship' ? 'diamond' : 'rect';
  // draw.io wraps to nearly the whole box even in ellipses and diamonds; it lets text touch the outline.
  const room = node.sourceBox!.w * k * Math.min(1, TEXT_SHARE[shapeOf] + 0.2) - 12 * k;
  const size = node.kind === 'attribute' ? theme.size.note : theme.size.node;
  const width = (t: string) => measureText(t, size, false, theme.widthFactor).width;
  return node.label
    .split('\n')
    .flatMap((line) => {
      const out: string[] = [];
      let current = '';
      for (const word of line.split(' ')) {
        const next = current ? `${current} ${word}` : word;
        if (current && width(next) > room) {
          out.push(current);
          current = word;
        } else current = next;
      }
      out.push(current);
      return out;
    })
    .join('\n');
}

function themedShape(node: DNode, theme: Theme): NodeShape {
  const k = theme.scale;
  const strong = (theme.nodeWeight ?? 400) >= 500;
  const measure = (text: string, size: number, bold = false) => measureText(text, size, bold, theme.widthFactor);
  const showStereo = node.stereotype && node.stereotype !== 'boxless' && (node.kind !== 'actor' || theme.actor.showStereotype);
  const stereo = showStereo ? measure(`«${node.stereotype}»`, theme.size.note) : undefined;

  switch (node.kind) {
    case 'actor': {
      const figure = theme.actor;
      const text = measure(node.label, theme.size.actor, strong);
      const stereoH = stereo ? 16 * k : 0;
      const w = Math.ceil(Math.max(figure.w + 8 * k, text.width + 8 * k, (stereo?.width ?? 0) + 8 * k));
      const h = Math.ceil(stereoH + figure.h + 6 * k + text.height);
      const figureCy = -h / 2 + stereoH + figure.h / 2;
      return { w, h, text, stereo, icon: figure, anchor: { dx: 0, dy: figureCy, w: figure.w, h: figure.h, shape: 'rect' } };
    }
    case 'usecase': {
      const text = measure(node.label, theme.size.node, strong);
      const inner = text.height + (stereo ? stereo.height : 0);
      if (theme.usecase === 'pill') {
        const h = Math.ceil(Math.max(32 * k, inner + 14 * k) / 4) * 4;
        const w = Math.ceil(Math.max(72 * k, text.width + 36 * k, (stereo?.width ?? 0) + 36 * k) / 4) * 4;
        return { w, h, text, stereo, anchor: { dx: 0, dy: 0, w, h, shape: 'pill' } };
      }
      const w = Math.ceil(Math.max(70 * k, text.width + 36 * k, (stereo?.width ?? 0) + 36 * k));
      const h = Math.ceil(Math.max(34 * k, inner + 16 * k));
      return { w, h, text, stereo, anchor: { dx: 0, dy: 0, w, h, shape: 'ellipse' } };
    }
    case 'note': {
      const text = measure(node.label || ' ', theme.size.note);
      const w = Math.ceil(text.width + 26 * k);
      const h = Math.ceil(text.height + 14 * k);
      return { w, h, text, anchor: { dx: 0, dy: 0, w, h, shape: 'rect' } };
    }
    case 'initial':
    case 'final':
    case 'history': {
      const d = (node.kind === 'final' ? 24 : node.kind === 'history' ? 26 : 20) * k;
      const text = measure(node.label, theme.size.note, true);
      return { w: d, h: d, text, anchor: { dx: 0, dy: 0, w: d, h: d, shape: 'ellipse' } };
    }
    case 'choice': {
      const d = 28 * k;
      return { w: d, h: d, text: measure('', theme.size.note), anchor: { dx: 0, dy: 0, w: d, h: d, shape: 'diamond' } };
    }
    case 'fork': {
      const w = 90 * k;
      const h = 8 * k;
      return { w, h, text: measure('', theme.size.note), anchor: { dx: 0, dy: 0, w, h, shape: 'rect' } };
    }
    case 'class':
      return classShape(node, theme, measure, stereo);
    case 'state': {
      const text = measure(node.label, theme.size.node, true);
      const desc = node.description?.length ? measure(node.description.join('\n'), theme.size.note) : undefined;
      const w = Math.ceil(Math.max(90 * k, text.width + 32 * k, (desc?.width ?? 0) + 24 * k, (stereo?.width ?? 0) + 24 * k));
      const header = (stereo?.height ?? 0) + text.height + 14 * k;
      const h = Math.ceil(Math.max(38 * k, header + (desc ? desc.height + 12 * k : 0)));
      return { w, h, text, stereo, desc, header, anchor: { dx: 0, dy: 0, w, h, shape: 'rect' } };
    }
    case 'action': {
      const text = measure(node.label, theme.size.node, strong);
      const w = Math.ceil(Math.max(60 * k, text.width + 30 * k));
      const h = Math.ceil(Math.max(34 * k, text.height + 16 * k));
      return { w, h, text, anchor: { dx: 0, dy: 0, w, h, shape: 'rect' } };
    }
    case 'decision': {
      // A stretched hexagon with the condition inside, as PlantUML draws `if`.
      const text = measure(node.label, theme.size.note);
      const w = Math.ceil(Math.max(40 * k, text.width + 40 * k));
      const h = Math.ceil(Math.max(30 * k, text.height + 14 * k));
      return { w, h, text, anchor: { dx: 0, dy: 0, w, h, shape: 'rect' } };
    }
    case 'attribute': {
      // Chen attribute: an ellipse; multi-valued ones get a second ring outside.
      const text = measure(node.label, theme.size.note, false);
      const ring = node.double ? 8 * k : 0;
      const w = Math.ceil(Math.max(60 * k, text.width + 30 * k) + ring);
      const h = Math.ceil(Math.max(30 * k, text.height + 14 * k) + ring);
      return { w, h, text, anchor: { dx: 0, dy: 0, w, h, shape: 'ellipse' } };
    }
    case 'relationship': {
      // A diamond wide enough that the label fits across its middle.
      const text = measure(node.label, theme.size.node, true);
      const ring = node.double ? 10 * k : 0;
      const h = Math.ceil(Math.max(46 * k, text.height + 30 * k) + ring);
      const w = Math.ceil(Math.max(90 * k, text.width + h * 1.2) + ring);
      return { w, h, text, anchor: { dx: 0, dy: 0, w, h, shape: 'diamond' } };
    }
    case 'network': {
      // nwdiag network: a long bar, name on the left, address on the right.
      const text = measure(node.label, theme.size.node, true);
      const desc = node.description?.length ? measure(node.description.join('  '), theme.size.note) : undefined;
      const w = Math.ceil(Math.max(260 * k, text.width + (desc?.width ?? 0) + 60 * k));
      const h = Math.ceil(Math.max(text.height, desc?.height ?? 0) + 10 * k);
      return { w, h, text, desc, anchor: { dx: 0, dy: 0, w, h, shape: 'rect' } };
    }
    case 'circle':
      // Chen subclass circle (`d`/`U`) and ArchiMate junctions: the text, if any, goes inside.
      if (node.label.length <= 2) {
        const d = (node.label ? 26 : 14) * k;
        return { w: d, h: d, text: measure(node.label, theme.size.note, true), anchor: { dx: 0, dy: 0, w: d, h: d, shape: 'ellipse' } };
      }
      break;
    case 'topic': {
      const text = measure(node.label, theme.size.node, strong);
      const boxless = node.stereotype === 'boxless';
      const w = Math.ceil(text.width + (boxless ? 8 : 28) * k);
      const h = Math.ceil(text.height + (boxless ? 6 : 14) * k);
      return { w, h, text, anchor: { dx: 0, dy: 0, w, h, shape: boxless ? 'rect' : 'pill' } };
    }
  }

  if (ICON_KINDS.has(node.kind)) {
    const size = (node.kind === 'interface' || node.kind === 'circle' ? 18 : 30) * k;
    const text = measure(node.label, theme.size.actor, strong);
    const stereoH = stereo ? 16 * k : 0;
    const w = Math.ceil(Math.max(size + 8 * k, text.width + 8 * k, (stereo?.width ?? 0) + 8 * k));
    const h = Math.ceil(stereoH + size + 6 * k + text.height);
    return { w, h, text, stereo, icon: { w: size, h: size }, anchor: { dx: 0, dy: -h / 2 + stereoH + size / 2, w: size, h: size, shape: 'ellipse' } };
  }

  // Box kinds: component, node, database, cloud, queue, rectangle, C4 system/container/person, ...
  const c4 = node.kind === 'system' || node.kind === 'container' || node.kind === 'person' || node.technology !== undefined || node.description !== undefined;
  const layer = node.kind === 'rectangle' ? archimateLayer(node.stereotype) : undefined;
  const text = measure(node.label, theme.size.node, c4 || strong);
  const caption = c4Caption(node, theme);
  const tech = caption ? measure(caption, theme.size.edge) : undefined;
  const desc = node.description?.length ? measure(wrap(node.description.join('\n')), theme.size.note) : undefined;
  const extra = { ...BOX_EXTRA[node.kind] };
  // ArchiMate: the type is a glyph in the top-right corner, not a «stereotype» line.
  if (layer) extra.right = (extra.right ?? 0) + 18;
  const content = [layer ? undefined : stereo, text, tech, desc].filter((b): b is TextBlock => !!b);
  const contentW = Math.max(...content.map((b) => b.width));
  const contentH = content.reduce((sum, b) => sum + b.height, 0) + blockGaps(content.length, !!desc, k);
  // Chen weak entity: room for the inner outline.
  const ring = node.double ? 8 * k : 0;
  const minW = c4 ? 160 : layer ? 120 : 80;
  const w = Math.ceil(Math.max(minW * k, contentW + (28 + (extra.left ?? 0) + (extra.right ?? 0)) * k) + ring);
  const h = Math.ceil(Math.max((c4 ? 68 : layer ? 52 : 40) * k, contentH + (c4 ? 24 : 18 + (extra.top ?? 0) + (extra.bottom ?? 0)) * k + (c4 ? (extra.top ?? 0) * k : 0)) + ring);
  const shape: NodeShape = { w, h, text, stereo: layer ? undefined : stereo, tech, desc, anchor: { dx: 0, dy: 0, w, h, shape: node.kind === 'cloud' ? 'ellipse' : 'rect' } };
  if (layer) shape.archimate = { layer, type: node.stereotype!.slice(layer.length).trim() || layer };
  return shape;
}

/** Space between a box's text blocks: tight under the name, a breath before the description. */
export function blockGaps(count: number, hasDesc: boolean, k: number): number {
  return Math.max(0, count - 1) * 2 * k + (hasDesc ? 4 * k : 0);
}

const C4_WORD: Partial<Record<NodeKind, string>> = { person: 'Person', system: 'Software System', container: 'Container', component: 'Component' };

/**
 * The C4 type line. PlantUML's C4 shows `[technology]`; the modern themes
 * show the element type with it, as Structurizr does (`Container · NestJS`),
 * because in a slide the type is what tells a person from a system.
 */
export function c4Caption(node: DNode, theme: Theme): string | undefined {
  if (theme.plantuml) return node.technology ? `[${node.technology}]` : undefined;
  const isC4 = node.kind === 'system' || node.kind === 'container' || node.kind === 'person' || node.technology !== undefined;
  if (!isC4) return undefined;
  const word = (node.external && node.kind !== 'person' ? 'External ' : '') + (C4_WORD[node.kind] ?? 'Container');
  return node.technology ? `${word} · ${node.technology}` : word;
}

function classShape(node: DNode, theme: Theme, measure: (t: string, s: number, b?: boolean) => TextBlock, stereo: TextBlock | undefined): NodeShape {
  const k = theme.scale;
  const json = node.classKind === 'json';
  const text = measure(node.label, theme.size.node, true);
  // Classic shows PlantUML's round "C/I/A/E" spot left of the name.
  const headless = json && !node.label;
  const spot = theme.plantuml && !json ? 26 * k : 0;
  const kindLabel =
    node.classKind && !['class', 'abstract', 'entity', 'object', 'json'].includes(node.classKind) && !theme.plantuml ? measure(`«${node.classKind}»`, theme.size.note) : undefined;
  const padY = (theme.plantuml ? 6 : 8) * k;
  const header = headless ? 0 : text.height + (stereo?.height ?? 0) + (kindLabel?.height ?? 0) + padY * 2;

  // Members: one row per line, columns aligned across the whole box.
  const size = theme.size.note;
  const rowH = size * (theme.plantuml ? LINE_HEIGHT : 1.55);
  const pad = (theme.plantuml ? 5 : 6) * k;
  const rows = (node.compartments ?? []).map((lines) => lines.filter((l) => l.trim() !== '').map((l) => parseMember(l, json)));
  // PlantUML writes `name : type` inline; the modern themes give the type its own right-hand column.
  if (theme.plantuml) for (const r of rows.flat()) if (r.type) [r.name, r.type] = [`${r.name} : ${r.type}`, undefined];
  const all = rows.flat();
  const w = (t: string, bold = false) => measure(t, size, bold).width;
  const keyW = Math.max(0, ...all.filter((r) => r.key).map((r) => badgeWidth(r.key!, size, theme)));
  const marker = Math.max(all.some((r) => r.vis) ? size * 1.1 : 0, keyW ? keyW + 6 * k : 0, all.some((r) => r.required) && !keyW ? size * 0.8 : 0);
  const nameW = Math.max(0, ...all.map((r) => w(r.name, r.key?.includes('PK'))));
  const typeW = Math.max(0, ...all.map((r) => (r.type ? w(r.type) : 0)));
  const gap = typeW ? (json ? 14 : 20) * k : 0;
  const members: MemberLayout = { rows, marker, name: nameW, gap, type: typeW, rowH, pad, size };
  const contentW = marker + nameW + gap + typeW;
  const compartments = rows.map((r, i): TextBlock => ({ lines: node.compartments![i]!.length ? node.compartments![i]! : [' '], width: contentW, height: r.length * rowH, size }));
  const padX = 12 * k;
  const minW = (headless ? 60 : theme.plantuml ? 100 : 120) * k;
  const width = Math.ceil(Math.max(minW, text.width + spot + 32 * k, (stereo?.width ?? 0) + 24 * k, (kindLabel?.width ?? 0) + 24 * k, contentW + padX * 2));
  // The modern themes draw a memberless class as a plain named box; PlantUML keeps its empty compartments.
  const memberless = !theme.plantuml && rows.every((r) => !r.length);
  const body = memberless ? 4 * k : rows.reduce((sum, r) => sum + (r.length ? r.length * rowH + pad * 2 : 8 * k), 0);
  const h = Math.ceil(header + body);
  return {
    w: width,
    h,
    text,
    stereo: stereo ?? kindLabel,
    header,
    compartments,
    members,
    anchor: { dx: 0, dy: 0, w: width, h, shape: 'rect' },
  };
}

/** Width of an ER key badge (`PK`, `FK`, `PK FK`): small bold caps on a tint. */
export function badgeWidth(key: string, size: number, theme: Theme): number {
  return measureText(key, size * 0.72, true, theme.widthFactor).width + size * 0.7;
}

export { LINE_HEIGHT };

export interface Pad {
  side: number;
  top: number;
  bottom: number;
}

export const CONTAINER_PAD: Pad = { side: 20, top: 34, bottom: 20 };

/** Container padding for a theme; the top holds the title, so it grows with the text. */
export function containerPad(theme: Theme): Pad {
  const k = theme.scale;
  return { side: CONTAINER_PAD.side * k, top: CONTAINER_PAD.top * k, bottom: CONTAINER_PAD.bottom * k };
}
