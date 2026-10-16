import type { DNode } from '../model/types.ts';
import { measureText, type TextBlock } from './measure.ts';
import type { Theme } from './theme.ts';


/** Where lines attach: the figure for actors, the ellipse/pill for use cases. Offsets are from the node centre. */
export interface Anchor {
  dx: number;
  dy: number;
  w: number;
  h: number;
  shape: 'ellipse' | 'rect' | 'pill';
}

export interface NodeShape {
  w: number;
  h: number;
  anchor: Anchor;
  text: TextBlock;
  stereo?: TextBlock;
}

/** Size of a node's whole box (what layout positions refer to, by centre). */
export function nodeShape(node: DNode, theme: Theme): NodeShape {
  const k = theme.scale;
  const measure = (text: string, size: number, bold = false) => measureText(text, size, bold, theme.widthFactor);
  const showStereo = node.stereotype && (node.kind !== 'actor' || theme.actor.showStereotype);
  const stereo = showStereo ? measure(`«${node.stereotype}»`, theme.size.note) : undefined;
  if (node.kind === 'actor') {
    const figure = theme.actor;
    const text = measure(node.label, theme.size.actor, (theme.nodeWeight ?? 400) >= 500);
    const stereoH = stereo ? 16 * k : 0;
    const w = Math.ceil(Math.max(figure.w + 8 * k, text.width + 8 * k, (stereo?.width ?? 0) + 8 * k));
    const h = Math.ceil(stereoH + figure.h + 6 * k + text.height);
    const figureCy = -h / 2 + stereoH + figure.h / 2;
    return { w, h, text, stereo, anchor: { dx: 0, dy: figureCy, w: figure.w, h: figure.h, shape: 'rect' } };
  }
  if (node.kind === 'usecase') {
    const text = measure(node.label, theme.size.node, (theme.nodeWeight ?? 400) >= 500);
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
  const text = measure(node.label || ' ', theme.size.note);
  const w = Math.ceil(text.width + 26 * k);
  const h = Math.ceil(text.height + 14 * k);
  return { w, h, text, anchor: { dx: 0, dy: 0, w, h, shape: 'rect' } };
}

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
