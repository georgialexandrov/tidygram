import type { DNode, NodeKind } from '../model/types.ts';
import { LINE_HEIGHT, measureText, type TextBlock } from './measure.ts';
import type { Theme } from './theme.ts';

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

/** Size of a node's whole box (what layout positions refer to, by centre). */
export function nodeShape(node: DNode, theme: Theme): NodeShape {
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
  const text = measure(node.label, theme.size.node, c4 || strong);
  const tech = node.technology ? measure(`[${node.technology}]`, theme.size.edge) : undefined;
  const desc = node.description?.length ? measure(wrap(node.description.join('\n')), theme.size.note) : undefined;
  const extra = BOX_EXTRA[node.kind] ?? {};
  const content = [stereo, text, tech, desc].filter((b): b is TextBlock => !!b);
  const contentW = Math.max(...content.map((b) => b.width));
  const contentH = content.reduce((sum, b) => sum + b.height, 0) + (content.length - 1) * 2 * k;
  // Chen weak entity: room for the inner outline.
  const ring = node.double ? 8 * k : 0;
  const w = Math.ceil(Math.max((c4 ? 150 : 80) * k, contentW + (24 + (extra.left ?? 0) + (extra.right ?? 0)) * k) + ring);
  const h = Math.ceil(Math.max((c4 ? 64 : 40) * k, contentH + (18 + (extra.top ?? 0) + (extra.bottom ?? 0)) * k) + ring);
  return { w, h, text, stereo, tech, desc, anchor: { dx: 0, dy: 0, w, h, shape: node.kind === 'cloud' ? 'ellipse' : 'rect' } };
}

function classShape(node: DNode, theme: Theme, measure: (t: string, s: number, b?: boolean) => TextBlock, stereo: TextBlock | undefined): NodeShape {
  const k = theme.scale;
  const text = measure(node.label, theme.size.node, true);
  const compartments = (node.compartments ?? []).map((lines) => measure(lines.join('\n') || ' ', theme.size.note));
  // Classic shows PlantUML's round "C/I/A/E" spot left of the name.
  const headless = node.classKind === 'json' && !node.label;
  const spot = theme.name === 'classic' && node.classKind !== 'json' ? 26 * k : 0;
  const kindLabel = node.classKind && !['class', 'abstract', 'entity', 'object', 'json'].includes(node.classKind) && theme.name !== 'classic' ? measure(`«${node.classKind}»`, theme.size.note) : undefined;
  const header = headless ? 0 : text.height + (stereo?.height ?? 0) + (kindLabel?.height ?? 0) + 12 * k;
  const w = Math.ceil(Math.max((headless ? 60 : 100) * k, text.width + spot + 28 * k, (stereo?.width ?? 0) + 24 * k, (kindLabel?.width ?? 0) + 24 * k, ...compartments.map((c) => c.width + 24 * k)));
  const body = compartments.reduce((sum, c) => sum + (c.lines.length === 1 && c.lines[0] === ' ' ? 8 * k : c.height + 10 * k), 0);
  const h = Math.ceil(header + body);
  return {
    w,
    h,
    text,
    stereo: stereo ?? kindLabel,
    header,
    compartments,
    anchor: { dx: 0, dy: 0, w, h, shape: 'rect' },
  };
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
