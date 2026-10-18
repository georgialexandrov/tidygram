import type { ReactNode } from 'react';
import type { NodeKind } from '../model/types.ts';
import type { TextBlock } from '../scene/measure.ts';
import type { SceneNode } from '../scene/scene.ts';
import { badgeWidth, BOX_EXTRA, blockGaps, type MemberRow } from '../scene/shapes.ts';
import { accentTint, mix, type Theme } from '../scene/theme.ts';
import { f, Text } from './text.tsx';

/**
 * Draws one element. Every kind gets its outline in the theme's colours;
 * `stroke` overrides the outline colour (selection). `depth` is the tree
 * level for mindmap topics (0 = root), which sets their weight.
 */
export function NodeBody({ n, theme, stroke, strokeWidth, depth }: { n: SceneNode; theme: Theme; stroke?: string; strokeWidth: number; depth?: number }): ReactNode {
  const c = theme.colors;
  const k = theme.scale;
  const { box, anchor, shape } = n;
  const { x, y, w, h } = box;
  const cx = x + w / 2;
  const line = stroke ?? c.shapeStroke;
  const props = { fill: c.shapeFill, stroke: line, strokeWidth };
  const kind = n.node.kind;

  switch (kind) {
    case 'actor':
      return null; // drawn by ActorFigure in DiagramSvg
    case 'note':
      return null; // drawn in DiagramSvg
    case 'initial':
      return <circle cx={f(anchor.cx)} cy={f(anchor.cy)} r={f(anchor.w / 2)} fill={stroke ?? c.text} />;
    case 'final':
      // Bullseye: a ring and a dot with a clear gap, so it never reads as the initial dot.
      return (
        <>
          <circle cx={f(anchor.cx)} cy={f(anchor.cy)} r={f(anchor.w / 2 - 0.75 * k)} fill={c.background} stroke={stroke ?? c.text} strokeWidth={1.5 * Math.sqrt(k)} />
          <circle cx={f(anchor.cx)} cy={f(anchor.cy)} r={f(anchor.w / 2 - 5 * k)} fill={stroke ?? c.text} />
        </>
      );
    case 'history':
      return (
        <>
          <circle cx={f(anchor.cx)} cy={f(anchor.cy)} r={f(anchor.w / 2)} {...props} />
          <Text theme={theme} block={shape.text} cx={anchor.cx} top={anchor.cy - shape.text.height / 2} weight={600} />
        </>
      );
    case 'choice': {
      const r = anchor.w / 2;
      // Merge/choice diamonds are small: they get the line colour so they don't vanish next to white boxes.
      return <polygon points={`${f(cx)},${f(y)} ${f(x + w)},${f(y + r)} ${f(cx)},${f(y + h)} ${f(x)},${f(y + r)}`} {...props} fill={theme.plantuml ? c.shapeFill : c.surface} stroke={stroke ?? (theme.plantuml ? line : c.line)} strokeLinejoin="round" />;
    }
    case 'fork':
      return <rect x={f(x)} y={f(y)} width={f(w)} height={f(h)} rx={f(Math.min(w, h) / 2)} fill={stroke ?? c.text} />;
    case 'state':
      return <StateBox n={n} theme={theme} stroke={line} strokeWidth={strokeWidth} />;
    case 'class':
      return <ClassBox n={n} theme={theme} stroke={line} strokeWidth={strokeWidth} />;
    case 'topic':
      return <Topic n={n} theme={theme} stroke={stroke} strokeWidth={strokeWidth} depth={depth ?? 2} />;
    case 'action':
      return (
        <>
          <rect x={f(x)} y={f(y)} width={f(w)} height={f(h)} rx={f(Math.min(h / 2, theme.plantuml ? 12 * k : Math.max(theme.nodeRadius, 0)))} {...props} />
          <Text theme={theme} block={shape.text} cx={cx} top={y + h / 2 - shape.text.height / 2} weight={theme.nodeWeight} />
        </>
      );
    case 'decision': {
      // A stretched hexagon with the condition inside, as PlantUML draws `if`.
      const i = Math.min(h / 2, w / 4);
      return (
        <>
          <polygon points={`${f(x + i)},${f(y)} ${f(x + w - i)},${f(y)} ${f(x + w)},${f(y + h / 2)} ${f(x + w - i)},${f(y + h)} ${f(x + i)},${f(y + h)} ${f(x)},${f(y + h / 2)}`} {...props} fill={theme.plantuml ? c.shapeFill : c.surface} stroke={stroke ?? (theme.plantuml ? line : c.line)} strokeLinejoin="round" />
          <Text theme={theme} block={shape.text} cx={cx} top={y + h / 2 - shape.text.height / 2} fill={c.text} />
        </>
      );
    }
    case 'attribute': {
      const rx = w / 2;
      const ry = h / 2;
      const cy = y + h / 2;
      const dash = n.node.derived ? theme.dash.dependency : undefined;
      const ring = 4 * k;
      return (
        <>
          <ellipse cx={f(cx)} cy={f(cy)} rx={f(rx)} ry={f(ry)} {...props} strokeDasharray={dash} />
          {n.node.double && <ellipse cx={f(cx)} cy={f(cy)} rx={f(rx - ring)} ry={f(ry - ring)} fill="none" stroke={line} strokeWidth={strokeWidth} strokeDasharray={dash} />}
          <Text theme={theme} block={shape.text} cx={cx} top={cy - shape.text.height / 2} underline={n.node.key} weight={n.node.key ? 600 : undefined} fill={n.node.key ? c.text : c.actorText} />
        </>
      );
    }
    case 'relationship': {
      const diamond = (i: number) => `${f(cx)},${f(y + i)} ${f(x + w - i * 1.6)},${f(y + h / 2)} ${f(cx)},${f(y + h - i)} ${f(x + i * 1.6)},${f(y + h / 2)}`;
      return (
        <>
          <polygon points={diamond(0)} {...props} fill={theme.plantuml ? c.shapeFill : accentTint(theme, 0.1)} stroke={stroke ?? (theme.plantuml ? line : accentTint(theme, 0.4))} strokeLinejoin="round" />
          {n.node.double && <polygon points={diamond(5 * k)} fill="none" stroke={stroke ?? (theme.plantuml ? line : accentTint(theme, 0.4))} strokeWidth={strokeWidth} strokeLinejoin="round" />}
          <Text theme={theme} block={shape.text} cx={cx} top={y + h / 2 - shape.text.height / 2} weight={600} />
        </>
      );
    }
    case 'network':
      // nwdiag: a bus. Solid accent bar, name on it, address range in a quieter weight.
      return (
        <>
          <rect x={f(x)} y={f(y)} width={f(w)} height={f(h)} rx={f(Math.min(h / 2, theme.nodeRadius))} fill={theme.plantuml ? c.actorFill : c.c4.personFill} stroke={stroke ?? (theme.plantuml ? c.actorStroke : c.c4.personStroke)} strokeWidth={strokeWidth} />
          <Text theme={theme} block={shape.text} cx={x + 12 * k} top={y + h / 2 - shape.text.height / 2} align="start" weight={600} fill={theme.plantuml ? c.text : c.c4.personText} />
          {shape.desc && <Text theme={theme} block={shape.desc} cx={x + w - 12 * k} top={y + h / 2 - shape.desc.height / 2} align="end" fill={theme.plantuml ? c.muted : c.c4.personMuted} tabular />}
        </>
      );
    case 'circle':
      if (!shape.icon) {
        // Junction (filled for AND, hollow for OR) or a Chen subclass circle with `d`/`U` inside.
        const solid = !n.node.label && n.node.stereotype !== 'or';
        return (
          <>
            <circle cx={f(anchor.cx)} cy={f(anchor.cy)} r={f(anchor.w / 2)} fill={solid ? (stroke ?? c.text) : c.shapeFill} stroke={stroke ?? c.text} strokeWidth={strokeWidth} />
            {n.node.label && <Text theme={theme} block={shape.text} cx={anchor.cx} top={anchor.cy - shape.text.height / 2} weight={600} />}
          </>
        );
      }
      return <IconElement n={n} theme={theme} stroke={line} strokeWidth={strokeWidth} />;
    case 'interface':
    case 'boundary':
    case 'control':
    case 'entity':
      return <IconElement n={n} theme={theme} stroke={line} strokeWidth={strokeWidth} />;
  }
  return <BoxElement n={n} theme={theme} stroke={stroke} strokeWidth={strokeWidth} />;
}

/** UML robustness icons and the interface lollipop, with the label underneath. */
function IconElement({ n, theme, stroke, strokeWidth }: { n: SceneNode; theme: Theme; stroke: string; strokeWidth: number }) {
  const { anchor, shape, box } = n;
  const c = theme.colors;
  const k = theme.scale;
  const r = anchor.w / 2;
  const { cx, cy } = anchor;
  // Icons are primary elements: the modern themes draw them in the accent tint, like actors.
  const props = { fill: theme.plantuml ? c.shapeFill : c.actorFill, stroke: theme.plantuml ? stroke : (stroke === c.shapeStroke ? c.actorGlyph : stroke), strokeWidth: strokeWidth * 1.25 };
  const ink = props.stroke;
  let icon: ReactNode;
  switch (n.node.kind) {
    case 'boundary':
      icon = (
        <>
          <circle cx={f(cx + 4 * k)} cy={f(cy)} r={f(r - 4 * k)} {...props} />
          <path d={`M${f(cx - r)},${f(cy - r + 4 * k)} V${f(cy + r - 4 * k)} M${f(cx - r)},${f(cy)} H${f(cx + 4 * k - (r - 4 * k))}`} fill="none" stroke={ink} strokeWidth={props.strokeWidth} strokeLinecap="round" />
        </>
      );
      break;
    case 'control':
      icon = (
        <>
          <circle cx={f(cx)} cy={f(cy)} r={f(r - 2 * k)} {...props} />
          <path d={`M${f(cx + 2 * k)},${f(cy - r - 2 * k)} L${f(cx - 4 * k)},${f(cy - r + 2 * k)} L${f(cx + 2 * k)},${f(cy - r + 6 * k)}`} fill="none" stroke={ink} strokeWidth={props.strokeWidth} strokeLinecap="round" strokeLinejoin="round" />
        </>
      );
      break;
    case 'entity':
      icon = (
        <>
          <circle cx={f(cx)} cy={f(cy - 2 * k)} r={f(r - 4 * k)} {...props} />
          <path d={`M${f(cx - r + 2 * k)},${f(cy + r - 2 * k)} H${f(cx + r - 2 * k)}`} stroke={ink} strokeWidth={props.strokeWidth} strokeLinecap="round" />
        </>
      );
      break;
    default:
      icon = <circle cx={f(cx)} cy={f(cy)} r={f(r)} {...props} />;
  }
  const labelTop = anchor.cy + anchor.h / 2 + 6 * k;
  return (
    <>
      {shape.stereo && <Text theme={theme} block={shape.stereo} cx={box.x + box.w / 2} top={box.y} fill={c.muted} />}
      {icon}
      <Text theme={theme} block={shape.text} cx={box.x + box.w / 2} top={labelTop} weight={theme.nodeWeight} fill={c.actorText} />
    </>
  );
}

/** Rounded-rectangle path (quadratic corners, so it matches the other outlines' joins). */
function rectPath(x: number, y: number, w: number, h: number, rx: number): string {
  const r = Math.max(0, Math.min(rx, w / 2, h / 2));
  if (!r) return `M${f(x)},${f(y)} H${f(x + w)} V${f(y + h)} H${f(x)} Z`;
  return `M${f(x + r)},${f(y)} H${f(x + w - r)} Q${f(x + w)},${f(y)} ${f(x + w)},${f(y + r)} V${f(y + h - r)} Q${f(x + w)},${f(y + h)} ${f(x + w - r)},${f(y + h)} H${f(x + r)} Q${f(x)},${f(y + h)} ${f(x)},${f(y + h - r)} V${f(y + r)} Q${f(x)},${f(y)} ${f(x + r)},${f(y)} Z`;
}

/** Outline path for box kinds, drawn inside x,y,w,h. */
function outline(kind: NodeKind, x: number, y: number, w: number, h: number, k: number, theme: Theme): { d: string; extra?: string } {
  const r = theme.nodeRadius;
  switch (kind) {
    case 'database': {
      const e = Math.min(7 * k, h / 5);
      return {
        d: `M${f(x)},${f(y + e)} A${f(w / 2)},${f(e)} 0 0 1 ${f(x + w)},${f(y + e)} V${f(y + h - e)} A${f(w / 2)},${f(e)} 0 0 1 ${f(x)},${f(y + h - e)} Z`,
        extra: `M${f(x)},${f(y + e)} A${f(w / 2)},${f(e)} 0 0 0 ${f(x + w)},${f(y + e)}`,
      };
    }
    case 'queue': {
      const e = Math.min(7 * k, w / 5);
      return {
        d: `M${f(x + e)},${f(y)} H${f(x + w - e)} A${f(e)},${f(h / 2)} 0 0 1 ${f(x + w - e)},${f(y + h)} H${f(x + e)} A${f(e)},${f(h / 2)} 0 0 1 ${f(x + e)},${f(y)} Z`,
        extra: `M${f(x + w - e)},${f(y)} A${f(e)},${f(h / 2)} 0 0 0 ${f(x + w - e)},${f(y + h)}`,
      };
    }
    case 'node': {
      const d = 8 * k;
      return {
        d: `M${f(x)},${f(y + d)} L${f(x + d)},${f(y)} H${f(x + w)} V${f(y + h - d)} L${f(x + w - d)},${f(y + h)} H${f(x)} Z`,
        extra: `M${f(x)},${f(y + d)} H${f(x + w - d)} L${f(x + w)},${f(y)} M${f(x + w - d)},${f(y + d)} V${f(y + h)}`,
      };
    }
    case 'cloud': {
      // Round lobes along each side (arcs, not quadratic bumps), sized to the box.
      const lobesX = Math.max(3, Math.round(w / (34 * k)));
      const lobesY = Math.max(1, Math.round(h / (30 * k)));
      const bx = w / lobesX;
      const by = h / lobesY;
      const i = 6 * k;
      let d = `M${f(x + i)},${f(y + i)}`;
      for (let j = 0; j < lobesX; j++) d += ` A${f(bx / 2)},${f(bx / 2.4)} 0 0 1 ${f(x + i + ((w - 2 * i) * (j + 1)) / lobesX)},${f(y + i)}`;
      for (let j = 0; j < lobesY; j++) d += ` A${f(by / 2.4)},${f(by / 2)} 0 0 1 ${f(x + w - i)},${f(y + i + ((h - 2 * i) * (j + 1)) / lobesY)}`;
      for (let j = 0; j < lobesX; j++) d += ` A${f(bx / 2)},${f(bx / 2.4)} 0 0 1 ${f(x + w - i - ((w - 2 * i) * (j + 1)) / lobesX)},${f(y + h - i)}`;
      for (let j = 0; j < lobesY; j++) d += ` A${f(by / 2.4)},${f(by / 2)} 0 0 1 ${f(x + i)},${f(y + h - i - ((h - 2 * i) * (j + 1)) / lobesY)}`;
      return { d: d + ' Z' };
    }
    case 'folder': {
      const tw = Math.min(w * 0.4, 56 * k);
      const th = 8 * k;
      return { d: `M${f(x)},${f(y)} H${f(x + tw)} L${f(x + tw + th)},${f(y + th)} H${f(x + w)} V${f(y + h)} H${f(x)} Z`, extra: `M${f(x)},${f(y + th)} H${f(x + tw + th)}` };
    }
    case 'artifact':
    case 'file': {
      const fold = 10 * k;
      return {
        d: `M${f(x)},${f(y)} H${f(x + w - fold)} L${f(x + w)},${f(y + fold)} V${f(y + h)} H${f(x)} Z`,
        extra: `M${f(x + w - fold)},${f(y)} V${f(y + fold)} H${f(x + w)}`,
      };
    }
    case 'storage':
      return { d: rectPath(x, y, w, h, Math.min(h / 2, 18 * k)) };
    case 'hexagon': {
      const i = Math.min(12 * k, h / 2);
      return { d: `M${f(x + i)},${f(y)} H${f(x + w - i)} L${f(x + w)},${f(y + h / 2)} L${f(x + w - i)},${f(y + h)} H${f(x + i)} L${f(x)},${f(y + h / 2)} Z` };
    }
    case 'process': {
      const i = 12 * k;
      return { d: `M${f(x)},${f(y)} H${f(x + w - i)} L${f(x + w)},${f(y + h / 2)} L${f(x + w - i)},${f(y + h)} H${f(x)} Z` };
    }
    case 'stack':
    case 'collections': {
      const o = 5 * k;
      return {
        d: rectPath(x, y + o, w - o, h - o, Math.min(r, 4 * k)),
        extra: `M${f(x + o)},${f(y + o)} V${f(y)} H${f(x + w)} V${f(y + h - o)} H${f(x + w - o)}`,
      };
    }
    case 'person':
      return { d: rectPath(x, y, w, h, theme.plantuml ? 14 * k : Math.max(r * 2, 14 * k)) };
    case 'card':
      return { d: rectPath(x, y, w, h, Math.min(r, 6 * k)) };
    case 'system':
    case 'container':
      return { d: rectPath(x, y, w, h, theme.plantuml ? 6 * k : r) };
  }
  return { d: rectPath(x, y, w, h, r) };
}

/** Fill, outline and text colours for a box, by what it is: C4 role, ArchiMate layer, or a plain element. */
function boxColours(n: SceneNode, theme: Theme) {
  const c = theme.colors;
  const kind = n.node.kind;
  if (kind === 'label') return { fill: 'none', stroke: 'none', text: c.text, muted: c.muted };
  if (n.shape.archimate) {
    const fill = c.archimate[n.shape.archimate.layer as keyof typeof c.archimate] ?? c.shapeFill;
    return { fill, stroke: theme.plantuml ? c.shapeStroke : mix(fill, c.text, 0.28), text: c.text, muted: c.muted };
  }
  const c4 = c.c4;
  if (kind === 'person') return n.node.external ? { fill: c4.externalFill, stroke: c4.externalStroke, text: theme.plantuml ? c4.personText : c.text, muted: theme.plantuml ? c4.personMuted : c.muted } : { fill: c4.personFill, stroke: c4.personStroke, text: c4.personText, muted: c4.personMuted };
  const isC4 = kind === 'system' || kind === 'container' || n.node.technology !== undefined;
  if (isC4) {
    if (n.node.external) return { fill: c4.externalFill, stroke: c4.externalStroke, text: theme.plantuml ? c4.personText : c.text, muted: theme.plantuml ? c4.personMuted : c.muted };
    return { fill: c4.internalFill, stroke: c4.internalStroke, text: theme.plantuml ? c4.personText : c.text, muted: theme.plantuml ? c4.personMuted : c.muted };
  }
  return { fill: c.shapeFill, stroke: c.shapeStroke, text: c.text, muted: c.muted };
}

function BoxElement({ n, theme, stroke, strokeWidth }: { n: SceneNode; theme: Theme; stroke?: string; strokeWidth: number }) {
  const k = theme.scale;
  const kind = n.node.kind;
  const { x, w } = n.box;
  let { y, h } = n.box;
  const shape = n.shape;
  const col = boxColours(n, theme);
  const fill = col.fill;
  const line = kind === 'label' ? 'none' : (stroke ?? col.stroke);
  const strong = kind === 'system' || kind === 'container' || kind === 'person' || n.node.technology !== undefined;
  let head: ReactNode = null;
  if (kind === 'person') {
    // C4 person: a head resting on a rounded body, the same colour, cut out by a background ring.
    const r = 13 * k;
    head = <circle cx={f(x + w / 2)} cy={f(y + r)} r={f(r)} fill={fill} stroke={stroke ?? theme.colors.background} strokeWidth={stroke ? strokeWidth : 2.5 * Math.sqrt(k)} />;
    y += 2 * r - 6 * k;
    h -= 2 * r - 6 * k;
  }
  const o = outline(kind, x, y, w, h, k, theme);
  const extra = { ...BOX_EXTRA[kind] };
  if (shape.archimate) extra.right = (extra.right ?? 0) + 18;
  const top = n.box.y + (extra.top ?? 0) * k;
  const bottom = n.box.y + n.box.h - (extra.bottom ?? 0) * k;
  const left = x + (extra.left ?? 0) * k;
  const right = x + w - (extra.right ?? 0) * k;
  const blocks: { block: TextBlock; weight?: number | 'bold'; fill?: string; gap: number }[] = [];
  if (shape.stereo) blocks.push({ block: shape.stereo, fill: col.muted, gap: 2 * k });
  blocks.push({ block: shape.text, weight: strong ? 600 : theme.nodeWeight, fill: col.text, gap: 2 * k });
  if (shape.tech) blocks.push({ block: shape.tech, fill: col.muted, gap: 2 * k });
  if (shape.desc) {
    blocks[blocks.length - 1]!.gap += 4 * k;
    blocks.push({ block: shape.desc, fill: col.muted, gap: 0 });
  }
  const total = blocks.reduce((s, b) => s + b.block.height, 0) + blockGaps(blocks.length, !!shape.desc, k);
  let cursor = (top + bottom) / 2 - total / 2;
  // ArchiMate keeps the label centred on the box, not on the room left of the glyph.
  const mid = shape.archimate ? x + w / 2 : (left + right) / 2;
  return (
    <>
      <path d={o.d} fill={fill} stroke={line} strokeWidth={strokeWidth} strokeLinejoin="round" />
      {o.extra && <path d={o.extra} fill="none" stroke={line} strokeWidth={strokeWidth} strokeLinejoin="round" />}
      {n.node.double && <path d={outline(kind, x + 4 * k, y + 4 * k, w - 8 * k, h - 8 * k, k, theme).d} fill="none" stroke={line} strokeWidth={strokeWidth} />}
      {kind === 'component' && <ComponentGlyph x={x + w - 20 * k} y={n.box.y + 8 * k} k={k} stroke={line === 'none' ? col.muted : line} fill={fill} />}
      {shape.archimate && <ArchimateGlyph type={shape.archimate.type} x={x + w - 8 * k} y={n.box.y + 8 * k} s={14 * k} stroke={col.text} />}
      {head}
      {blocks.map((b, i) => {
        const el = <Text key={i} theme={theme} block={b.block} cx={mid} top={cursor} weight={b.weight} fill={b.fill} />;
        cursor += b.block.height + b.gap;
        return el;
      })}
    </>
  );
}

function ComponentGlyph({ x, y, k, stroke, fill }: { x: number; y: number; k: number; stroke: string; fill: string }) {
  return (
    <g stroke={stroke} strokeWidth={1} fill={fill} strokeLinejoin="round">
      <rect x={f(x + 3 * k)} y={f(y)} width={f(12 * k)} height={f(12 * k)} rx={1.5 * k} />
      <rect x={f(x)} y={f(y + 2.5 * k)} width={f(6 * k)} height={f(2.5 * k)} rx={0.5 * k} />
      <rect x={f(x)} y={f(y + 7 * k)} width={f(6 * k)} height={f(2.5 * k)} rx={0.5 * k} />
    </g>
  );
}

/**
 * The ArchiMate type icons, drawn in an `s`-sized square whose top-right
 * corner is (x, y). Shapes follow the ArchiMate 3 notation; anything without
 * its own icon gets none (the layer colour still says where it belongs).
 */
function ArchimateGlyph({ type, x, y, s, stroke }: { type: string; x: number; y: number; s: number; stroke: string }) {
  const L = x - s;
  const T = y;
  const p = (u: number, v: number) => `${f(L + u * s)},${f(T + v * s)}`;
  const t = type.toLowerCase();
  const word = t.split(' ').pop() ?? t;
  let g: ReactNode;
  if (/actor|stakeholder$/.test(t) && word === 'actor') {
    g = (
      <>
        <circle cx={f(L + 0.5 * s)} cy={f(T + 0.17 * s)} r={f(0.15 * s)} />
        <path d={`M${p(0.5, 0.32)} V${f(T + 0.68 * s)} M${p(0.18, 0.46)} H${f(L + 0.82 * s)} M${p(0.22, 1)} L${p(0.5, 0.68)} L${p(0.78, 1)}`} />
      </>
    );
  } else if (word === 'role' || word === 'stakeholder') {
    g = <path d={`M${p(0.3, 0.2)} H${p(0.8, 0.2).split(',')[0]} A${f(0.18 * s)},${f(0.3 * s)} 0 0 1 ${p(0.8, 0.8)} H${f(L + 0.3 * s)} A${f(0.18 * s)},${f(0.3 * s)} 0 0 1 ${p(0.3, 0.2)} Z M${p(0.8, 0.2)} A${f(0.18 * s)},${f(0.3 * s)} 0 0 0 ${p(0.8, 0.8)}`} />;
  } else if (word === 'collaboration') {
    g = (
      <>
        <circle cx={f(L + 0.36 * s)} cy={f(T + 0.5 * s)} r={f(0.3 * s)} />
        <circle cx={f(L + 0.64 * s)} cy={f(T + 0.5 * s)} r={f(0.3 * s)} />
      </>
    );
  } else if (word === 'interface') {
    g = (
      <>
        <circle cx={f(L + 0.68 * s)} cy={f(T + 0.5 * s)} r={f(0.28 * s)} />
        <path d={`M${p(0, 0.5)} H${f(L + 0.4 * s)}`} />
      </>
    );
  } else if (word === 'process' || word === 'stream') {
    g = <path d={`M${p(0, 0.35)} H${f(L + 0.6 * s)} V${f(T + 0.15 * s)} L${p(1, 0.5)} L${p(0.6, 0.85)} V${f(T + 0.65 * s)} H${f(L)} Z`} />;
  } else if (word === 'function') {
    g = <path d={`M${p(0.15, 0.95)} V${f(T + 0.3 * s)} L${p(0.5, 0.05)} L${p(0.85, 0.3)} V${f(T + 0.95 * s)} L${p(0.5, 0.7)} Z`} />;
  } else if (word === 'interaction') {
    g = <path d={`M${p(0.45, 0.1)} A${f(0.4 * s)},${f(0.4 * s)} 0 0 0 ${p(0.45, 0.9)} Z M${p(0.55, 0.1)} A${f(0.4 * s)},${f(0.4 * s)} 0 0 1 ${p(0.55, 0.9)} Z`} />;
  } else if (word === 'event') {
    g = <path d={`M${p(0, 0.2)} H${f(L + 0.7 * s)} A${f(0.3 * s)},${f(0.3 * s)} 0 0 1 ${p(0.7, 0.8)} H${f(L)} A${f(0.15 * s)},${f(0.3 * s)} 0 0 0 ${p(0, 0.2)} Z`} />;
  } else if (word === 'service') {
    g = <rect x={f(L)} y={f(T + 0.2 * s)} width={f(s)} height={f(0.6 * s)} rx={f(0.3 * s)} />;
  } else if (word === 'object' || word === 'contract' || word === 'representation' || word === 'product' || word === 'deliverable') {
    g = (
      <>
        <rect x={f(L)} y={f(T + 0.15 * s)} width={f(s)} height={f(0.7 * s)} />
        <path d={`M${p(0, 0.38)} H${f(L + s)}`} />
      </>
    );
  } else if (word === 'component') {
    g = (
      <>
        <rect x={f(L + 0.2 * s)} y={f(T + 0.05 * s)} width={f(0.8 * s)} height={f(0.9 * s)} />
        <rect x={f(L)} y={f(T + 0.22 * s)} width={f(0.4 * s)} height={f(0.16 * s)} />
        <rect x={f(L)} y={f(T + 0.6 * s)} width={f(0.4 * s)} height={f(0.16 * s)} />
      </>
    );
  } else if (word === 'node' || word === 'facility' || word === 'equipment') {
    g = <path d={`M${p(0, 0.3)} L${p(0.25, 0.05)} H${f(L + s)} V${f(T + 0.75 * s)} L${p(0.75, 1)} H${f(L)} Z M${p(0, 0.3)} H${f(L + 0.75 * s)} L${p(1, 0.05)} M${p(0.75, 0.3)} V${f(T + s)}`} />;
  } else if (word === 'device') {
    g = (
      <>
        <rect x={f(L)} y={f(T + 0.05 * s)} width={f(s)} height={f(0.65 * s)} rx={f(0.08 * s)} />
        <path d={`M${p(0.3, 0.7)} L${p(0.2, 0.95)} H${f(L + 0.8 * s)} L${p(0.7, 0.7)}`} />
      </>
    );
  } else if (word === 'software') {
    g = (
      <>
        <circle cx={f(L + 0.58 * s)} cy={f(T + 0.42 * s)} r={f(0.36 * s)} />
        <path d={`M${p(0.3, 0.22)} A${f(0.36 * s)},${f(0.36 * s)} 0 1 0 ${p(0.78, 0.7)}`} />
      </>
    );
  } else if (word === 'artifact') {
    g = <path d={`M${p(0.15, 0)} H${f(L + 0.62 * s)} L${p(0.85, 0.25)} V${f(T + s)} H${f(L + 0.15 * s)} Z M${p(0.62, 0)} V${f(T + 0.25 * s)} H${f(L + 0.85 * s)}`} />;
  } else if (word === 'network' || word === 'path') {
    g = <path d={`M${p(0, 0.5)} H${f(L + s)} M${p(0.15, 0.3)} L${p(0, 0.5)} L${p(0.15, 0.7)} M${p(0.85, 0.3)} L${p(1, 0.5)} L${p(0.85, 0.7)}`} />;
  } else if (word === 'goal' || word === 'outcome') {
    g = (
      <>
        <circle cx={f(L + 0.5 * s)} cy={f(T + 0.5 * s)} r={f(0.46 * s)} />
        <circle cx={f(L + 0.5 * s)} cy={f(T + 0.5 * s)} r={f(0.26 * s)} />
        <circle cx={f(L + 0.5 * s)} cy={f(T + 0.5 * s)} r={f(0.07 * s)} />
      </>
    );
  } else if (word === 'requirement' || word === 'constraint') {
    g = <path d={`M${p(0.2, 0.2)} H${f(L + s)} L${p(0.8, 0.8)} H${f(L)} Z${word === 'constraint' ? ` M${p(0.4, 0.2)} L${p(0.2, 0.8)}` : ''}`} />;
  } else if (word === 'principle') {
    g = (
      <>
        <rect x={f(L + 0.1 * s)} y={f(T)} width={f(0.8 * s)} height={f(s)} rx={f(0.08 * s)} />
        <path d={`M${p(0.5, 0.2)} V${f(T + 0.6 * s)} M${p(0.5, 0.78)} V${f(T + 0.8 * s)}`} />
      </>
    );
  } else if (word === 'driver') {
    g = (
      <>
        <circle cx={f(L + 0.5 * s)} cy={f(T + 0.5 * s)} r={f(0.4 * s)} />
        <path d={`M${p(0, 0.5)} H${f(L + s)} M${p(0.5, 0)} V${f(T + s)} M${p(0.15, 0.15)} L${p(0.85, 0.85)} M${p(0.85, 0.15)} L${p(0.15, 0.85)}`} />
      </>
    );
  } else if (word === 'assessment') {
    g = (
      <>
        <circle cx={f(L + 0.6 * s)} cy={f(T + 0.4 * s)} r={f(0.32 * s)} />
        <path d={`M${p(0.37, 0.63)} L${p(0, 1)}`} />
      </>
    );
  } else if (word === 'capability') {
    g = <path d={`M${p(0, 1)} V${f(T + 0.66 * s)} H${f(L + 0.33 * s)} V${f(T + 0.33 * s)} H${f(L + 0.66 * s)} V${f(T)} H${f(L + s)} V${f(T + s)} Z`} />;
  } else if (word === 'resource') {
    g = (
      <>
        <rect x={f(L)} y={f(T + 0.25 * s)} width={f(0.85 * s)} height={f(0.5 * s)} rx={f(0.1 * s)} />
        <path d={`M${p(0.92, 0.4)} V${f(T + 0.6 * s)} M${p(0.25, 0.35)} V${f(T + 0.65 * s)} M${p(0.45, 0.35)} V${f(T + 0.65 * s)}`} />
      </>
    );
  } else if (word === 'location') {
    g = <path d={`M${p(0.5, 1)} C${p(0.1, 0.55)} ${p(0.1, 0)} ${p(0.5, 0)} C${p(0.9, 0)} ${p(0.9, 0.55)} ${p(0.5, 1)} Z`} />;
  } else if (word === 'package') {
    g = <path d={`M${p(0.85, 0.5)} A${f(0.35 * s)},${f(0.35 * s)} 0 1 1 ${p(0.5, 0.15)} H${f(L + 0.85 * s)} M${p(0.7, 0)} L${p(0.85, 0.15)} L${p(0.7, 0.3)}`} />;
  } else if (word === 'plateau') {
    g = <path d={`M${p(0.3, 0.2)} H${f(L + s)} M${p(0.15, 0.5)} H${f(L + 0.85 * s)} M${p(0, 0.8)} H${f(L + 0.7 * s)}`} />;
  } else if (word === 'value' || word === 'meaning') {
    g = <ellipse cx={f(L + 0.5 * s)} cy={f(T + 0.5 * s)} rx={f(0.5 * s)} ry={f(0.3 * s)} />;
  } else return null;
  return (
    <g fill="none" stroke={stroke} strokeWidth={1} strokeLinejoin="round" strokeLinecap="round" opacity={0.8}>
      {g}
    </g>
  );
}

function StateBox({ n, theme, stroke, strokeWidth }: { n: SceneNode; theme: Theme; stroke: string; strokeWidth: number }) {
  const c = theme.colors;
  const k = theme.scale;
  const { x, y, w, h } = n.box;
  const s = n.shape;
  const radius = theme.nodeRadius === 0 ? 0 : Math.min(h / 2, (theme.plantuml ? 10 : 12) * k);
  const stereoH = s.stereo?.height ?? 0;
  // Without a description the name sits in the middle of the state; with one, in the header strip.
  const top = s.desc ? y + 7 * k : y + h / 2 - (s.text.height + stereoH) / 2;
  return (
    <>
      <rect x={f(x)} y={f(y)} width={f(w)} height={f(h)} rx={f(radius)} fill={c.shapeFill} stroke={stroke} strokeWidth={strokeWidth} />
      {s.stereo && <Text theme={theme} block={s.stereo} cx={x + w / 2} top={top} fill={c.muted} />}
      <Text theme={theme} block={s.text} cx={x + w / 2} top={top + stereoH} weight={600} />
      {s.desc && (
        <>
          <path d={`M${f(x)},${f(y + s.header!)} H${f(x + w)}`} stroke={theme.plantuml ? stroke : c.grid} strokeWidth={strokeWidth} />
          <Text theme={theme} block={s.desc} cx={x + 12 * k} top={y + s.header! + 6 * k} align="start" fill={c.muted} />
        </>
      )}
    </>
  );
}

const SPOT: Record<string, [letter: string, colour: string]> = {
  class: ['C', '#ADD1B2'],
  abstract: ['A', '#A9DCDF'],
  interface: ['I', '#B4A7E5'],
  enum: ['E', '#EB937F'],
  annotation: ['@', '#E3664A'],
  entity: ['E', '#ADD1B2'],
  object: ['O', '#ADD1B2'],
  map: ['M', '#ADD1B2'],
  struct: ['S', '#ADD1B2'],
  protocol: ['P', '#B4A7E5'],
  exception: ['X', '#EB937F'],
  record: ['R', '#ADD1B2'],
};

/** PlantUML's visibility icon colours (classic); the modern themes draw them in the muted ink. */
const VIS_COLOUR: Record<string, string> = { '+': '#84BE84', '-': '#C82930', '#': '#B38D22', '~': '#1963A0' };

/** UML visibility as PlantUML draws it: circle public, square private, diamond protected, triangle package; methods filled, fields hollow. */
function Visibility({ row, cx, cy, size, theme }: { row: MemberRow; cx: number; cy: number; size: number; theme: Theme }) {
  const r = size * 0.27;
  const ink = theme.plantuml ? VIS_COLOUR[row.vis!]! : theme.colors.muted;
  const fill = row.method ? ink : 'none';
  const sw = Math.max(0.8, size / 12);
  switch (row.vis) {
    case '+':
      return <circle cx={f(cx)} cy={f(cy)} r={f(r)} fill={fill} stroke={ink} strokeWidth={sw} />;
    case '-':
      return <rect x={f(cx - r)} y={f(cy - r)} width={f(2 * r)} height={f(2 * r)} fill={fill} stroke={ink} strokeWidth={sw} />;
    case '#':
      return <polygon points={`${f(cx)},${f(cy - r * 1.25)} ${f(cx + r * 1.25)},${f(cy)} ${f(cx)},${f(cy + r * 1.25)} ${f(cx - r * 1.25)},${f(cy)}`} fill={fill} stroke={ink} strokeWidth={sw} />;
    default:
      return <polygon points={`${f(cx)},${f(cy - r * 1.2)} ${f(cx + r * 1.2)},${f(cy + r)} ${f(cx - r * 1.2)},${f(cy + r)}`} fill={fill} stroke={ink} strokeWidth={sw} />;
  }
}

function ClassBox({ n, theme, stroke, strokeWidth }: { n: SceneNode; theme: Theme; stroke: string; strokeWidth: number }) {
  const c = theme.colors;
  const k = theme.scale;
  const { x, y, w, h } = n.box;
  const s = n.shape;
  const classic = theme.plantuml;
  const kind = n.node.classKind ?? 'class';
  const json = kind === 'json';
  const spot = classic && !json ? (SPOT[kind] ?? SPOT.class!) : undefined;
  const header = s.header!;
  // Memberless boxes centre the name in the whole box.
  const nameTop = y + (s.members!.rows.some((r) => r.length) || classic ? header : h) / 2 - (s.text.height + (s.stereo?.height ?? 0)) / 2 + (s.stereo?.height ?? 0);
  const nameWidth = s.text.width;
  const spotR = 9 * k;
  const nameCx = x + w / 2 + (spot ? spotR + 2 * k : 0) / 2;
  const r = classic ? 2.5 * k : theme.nodeRadius;
  const m = s.members!;
  const padX = 12 * k;
  const nameX = x + padX + m.marker;
  const typeRight = x + w - padX;
  // JSON tables read as key | value: the value column starts at a fixed x instead of hanging off the right edge.
  const valueX = nameX + m.name + m.gap;
  // A class with no members is just a named box: no band, no rule.
  const banded = !classic && header > 0 && m.rows.some((r) => r.length);
  const keyCentre = x + padX + Math.max(0, m.marker - 6 * k) / 2;
  let cursor = y + header;
  return (
    <>
      <path d={rectPath(x, y, w, h, r)} fill={c.shapeFill} stroke={stroke} strokeWidth={strokeWidth} />
      {/* The header band: a quiet tint so the name reads as a title, not as a member. */}
      {banded && <path d={`${rectTop(x, y, w, header, r)}`} fill={c.surface} stroke="none" />}
      {banded && <path d={`M${f(x)},${f(y + header)} H${f(x + w)}`} stroke={stroke} strokeWidth={strokeWidth} />}
      {spot && (
        <>
          <circle cx={f(nameCx - nameWidth / 2 - spotR - 4 * k)} cy={f(nameTop + s.text.height / 2)} r={f(spotR)} fill={spot[1]} stroke={c.text} strokeWidth={0.75} />
          <text x={f(nameCx - nameWidth / 2 - spotR - 4 * k)} y={f(nameTop + s.text.height / 2 + 4 * k)} fontFamily={theme.font} fontSize={11 * k} fontWeight="bold" textAnchor="middle" fill={c.text}>
            {spot[0]}
          </text>
        </>
      )}
      {s.stereo && <Text theme={theme} block={s.stereo} cx={x + w / 2} top={nameTop - s.stereo.height} fill={c.muted} />}
      {header > 0 && <Text theme={theme} block={s.text} cx={nameCx} top={nameTop} weight={classic ? 'bold' : 600} italic={kind === 'abstract' || kind === 'interface'} />}
      {classic || m.rows.some((r) => r.length) ? m.rows.map((rows, i) => {
        const top = cursor;
        const height = rows.length ? rows.length * m.rowH + m.pad * 2 : 8 * k;
        cursor += height;
        return (
          <g key={i}>
            {i > 0 && (rows.length > 0 || classic) && <path d={`M${f(x)},${f(top)} H${f(x + w)}`} stroke={classic ? stroke : c.grid} strokeWidth={strokeWidth} />}
            {classic && i === 0 && header > 0 && <path d={`M${f(x)},${f(top)} H${f(x + w)}`} stroke={stroke} strokeWidth={strokeWidth} />}
            {/* Zebra rows make long JSON tables and wide ER entities trackable across the gap. */}
            {!classic && (json || kind === 'entity') && rows.length > 3 &&
              rows.map((_, j) => (j % 2 === 1 ? <rect key={`z${j}`} x={f(x + strokeWidth / 2)} y={f(top + m.pad + j * m.rowH)} width={f(w - strokeWidth)} height={f(m.rowH)} fill={c.surface} opacity={0.6} /> : null))}
            {rows.map((row, j) => {
              const rowTop = top + m.pad + j * m.rowH;
              const cy = rowTop + m.rowH / 2;
              const block: TextBlock = { lines: [row.name], width: 0, height: m.size * 1.25, size: m.size };
              const textTop = cy - block.height / 2;
              const pk = row.key?.includes('PK');
              return (
                <g key={j}>
                  {row.key ? (
                    <KeyBadge text={row.key} x={x + padX} cy={cy} size={m.size} theme={theme} primary={!!pk} />
                  ) : row.vis ? (
                    <Visibility row={row} cx={x + padX + m.size * 0.35} cy={cy} size={m.size} theme={theme} />
                  ) : row.required ? (
                    <circle cx={f(m.rows.flat().some((q) => q.key) ? keyCentre : x + padX + m.size * 0.2)} cy={f(cy)} r={f(m.size * 0.14)} fill={c.muted} />
                  ) : null}
                  <Text theme={theme} block={block} cx={nameX} top={textTop} align="start" weight={pk ? 600 : undefined} italic={row.isAbstract} underline={row.isStatic} fill={json ? c.labelText : c.text} />
                  {row.type && (
                    <Text
                      theme={theme}
                      block={{ ...block, lines: [row.type] }}
                      cx={json ? valueX : typeRight}
                      top={textTop}
                      align={json ? 'start' : 'end'}
                      fill={json ? jsonValueColour(row.type, theme) : c.muted}
                      tabular
                    />
                  )}
                </g>
              );
            })}
          </g>
        );
      }) : null}
    </>
  );
}

/** The top of a rounded box down to `h`, square at the bottom: the class header band. */
function rectTop(x: number, y: number, w: number, h: number, r: number): string {
  const q = Math.min(r, h);
  return `M${f(x + q)},${f(y)} H${f(x + w - q)} Q${f(x + w)},${f(y)} ${f(x + w)},${f(y + q)} V${f(y + h)} H${f(x)} V${f(y + q)} Q${f(x)},${f(y)} ${f(x + q)},${f(y)} Z`;
}

/** JSON values: strings in the text colour, numbers/booleans/null in the accent so the shape of the data shows. */
function jsonValueColour(value: string, theme: Theme): string {
  if (/^(-?\d[\d.e+-]*|true|false|null)$/.test(value)) return theme.plantuml ? '#1963A0' : theme.colors.accent;
  if (/^[{[]/.test(value)) return theme.colors.muted;
  return theme.colors.text;
}

/** An ER key: `PK` on the accent, `FK`/`UK` as a hollow chip, small tracked caps. */
function KeyBadge({ text, x, cy, size, theme, primary }: { text: string; x: number; cy: number; size: number; theme: Theme; primary: boolean }) {
  const c = theme.colors;
  const w = badgeWidth(text, size, theme);
  const h = size * 1.05;
  const fs = size * 0.72;
  const fill = primary ? (theme.plantuml ? '#F2D46F' : accentTint(theme, 0.1)) : 'none';
  const ink = primary ? (theme.plantuml ? c.text : mix(c.accent, c.text, 0.3)) : c.muted;
  return (
    <g>
      <rect x={f(x)} y={f(cy - h / 2)} width={f(w)} height={f(h)} rx={f(Math.min(h / 2, 3 * theme.scale))} fill={fill} stroke={primary ? (theme.plantuml ? '#B38D22' : accentTint(theme, 0.35)) : c.grid} strokeWidth={0.75} />
      <text x={f(x + w / 2)} y={f(cy + fs * 0.36)} fontFamily={theme.font} fontSize={f(fs * 100) / 100} fontWeight={700} textAnchor="middle" fill={ink} letterSpacing="0.04em" style={{ pointerEvents: 'none' }}>
        {text}
      </text>
    </g>
  );
}

/**
 * Mindmap / WBS topics by level: the root is a solid accent pill, the first
 * ring a tinted pill, deeper topics quiet surface pills, so the tree reads
 * from the centre out.
 */
function Topic({ n, theme, stroke, strokeWidth, depth }: { n: SceneNode; theme: Theme; stroke?: string; strokeWidth: number; depth: number }) {
  const c = theme.colors;
  const k = theme.scale;
  const { x, y, w, h } = n.box;
  const s = n.shape;
  const boxless = n.node.stereotype === 'boxless';
  const rx = theme.plantuml ? 4 * k : Math.min(h / 2, theme.nodeRadius === 0 ? 0 : h / 2);
  let fill = c.shapeFill;
  let line = stroke ?? c.shapeStroke;
  let ink = c.text;
  let weight: number | undefined = theme.nodeWeight;
  if (!theme.plantuml) {
    if (depth === 0) [fill, line, ink, weight] = [c.c4.personFill, stroke ?? c.c4.personStroke, c.c4.personText, 600];
    else if (depth === 1) [fill, line, weight] = [accentTint(theme, 0.1), stroke ?? accentTint(theme, 0.35), 600];
    else [fill, line, weight] = [c.surface, stroke ?? 'none', undefined];
  }
  return (
    <>
      {boxless ? (
        <path d={`M${f(x)},${f(y + h)} H${f(x + w)}`} stroke={stroke ?? c.line} strokeWidth={strokeWidth} />
      ) : (
        <rect x={f(x)} y={f(y)} width={f(w)} height={f(h)} rx={f(rx)} fill={fill} stroke={line} strokeWidth={strokeWidth} />
      )}
      <Text theme={theme} block={s.text} cx={x + w / 2} top={y + h / 2 - s.text.height / 2} weight={weight} fill={ink} />
    </>
  );
}
