import type { ReactNode } from 'react';
import type { NodeKind } from '../model/types.ts';
import type { TextBlock } from '../scene/measure.ts';
import type { SceneNode } from '../scene/scene.ts';
import { BOX_EXTRA } from '../scene/shapes.ts';
import type { Theme } from '../scene/theme.ts';
import { f, Text } from './text.tsx';

/**
 * Draws one element. Every kind gets its outline in the theme's colours;
 * `stroke` overrides the outline colour (selection).
 */
export function NodeBody({ n, theme, stroke, strokeWidth }: { n: SceneNode; theme: Theme; stroke?: string; strokeWidth: number }): ReactNode {
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
      return <circle cx={f(anchor.cx)} cy={f(anchor.cy)} r={anchor.w / 2} fill={stroke ?? c.text} />;
    case 'final':
      return (
        <>
          <circle cx={f(anchor.cx)} cy={f(anchor.cy)} r={anchor.w / 2} fill={c.background} stroke={stroke ?? c.text} strokeWidth={1.5 * Math.sqrt(k)} />
          <circle cx={f(anchor.cx)} cy={f(anchor.cy)} r={anchor.w / 2 - 4 * k} fill={stroke ?? c.text} />
        </>
      );
    case 'history':
      return (
        <>
          <circle cx={f(anchor.cx)} cy={f(anchor.cy)} r={anchor.w / 2} {...props} />
          <Text theme={theme} block={shape.text} cx={anchor.cx} top={anchor.cy - shape.text.height / 2} weight="bold" />
        </>
      );
    case 'choice': {
      const r = anchor.w / 2;
      return <polygon points={`${f(cx)},${f(y)} ${f(x + w)},${f(y + r)} ${f(cx)},${f(y + h)} ${f(x)},${f(y + r)}`} {...props} />;
    }
    case 'fork':
      return <rect x={f(x)} y={f(y)} width={f(w)} height={f(h)} rx={2 * k} fill={stroke ?? c.text} />;
    case 'state':
      return <StateBox n={n} theme={theme} stroke={line} strokeWidth={strokeWidth} />;
    case 'class':
      return <ClassBox n={n} theme={theme} stroke={line} strokeWidth={strokeWidth} />;
    case 'topic':
      return <Topic n={n} theme={theme} stroke={line} strokeWidth={strokeWidth} />;
    case 'action':
      return (
        <>
          <rect x={f(x)} y={f(y)} width={f(w)} height={f(h)} rx={Math.min(h / 2, 12 * k)} {...props} />
          <Text theme={theme} block={shape.text} cx={cx} top={y + h / 2 - shape.text.height / 2} weight={theme.nodeWeight} />
        </>
      );
    case 'decision': {
      const i = Math.min(14 * k, w / 4);
      return (
        <>
          <polygon points={`${f(x + i)},${f(y)} ${f(x + w - i)},${f(y)} ${f(x + w)},${f(y + h / 2)} ${f(x + w - i)},${f(y + h)} ${f(x + i)},${f(y + h)} ${f(x)},${f(y + h / 2)}`} {...props} />
          <Text theme={theme} block={shape.text} cx={cx} top={y + h / 2 - shape.text.height / 2} />
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
          <Text theme={theme} block={shape.text} cx={cx} top={cy - shape.text.height / 2} underline={n.node.key} />
        </>
      );
    }
    case 'relationship': {
      const diamond = (i: number) => `${f(cx)},${f(y + i)} ${f(x + w - i * 1.6)},${f(y + h / 2)} ${f(cx)},${f(y + h - i)} ${f(x + i * 1.6)},${f(y + h / 2)}`;
      return (
        <>
          <polygon points={diamond(0)} {...props} strokeLinejoin="round" />
          {n.node.double && <polygon points={diamond(5 * k)} fill="none" stroke={line} strokeWidth={strokeWidth} strokeLinejoin="round" />}
          <Text theme={theme} block={shape.text} cx={cx} top={y + h / 2 - shape.text.height / 2} weight={600} />
        </>
      );
    }
    case 'network':
      return (
        <>
          <rect x={f(x)} y={f(y)} width={f(w)} height={f(h)} rx={Math.min(h / 2, 4 * k)} fill={c.actorFill} stroke={stroke ?? c.actorStroke} strokeWidth={strokeWidth} />
          <Text theme={theme} block={shape.text} cx={x + 12 * k} top={y + h / 2 - shape.text.height / 2} align="start" weight={600} />
          {shape.desc && <Text theme={theme} block={shape.desc} cx={x + w - 12 * k - shape.desc.width} top={y + h / 2 - shape.desc.height / 2} align="start" fill={c.muted} />}
        </>
      );
    case 'circle':
      if (!shape.icon) {
        // Junction (filled for AND, hollow for OR) or a Chen subclass circle with `d`/`U` inside.
        const solid = !n.node.label && n.node.stereotype !== 'or';
        return (
          <>
            <circle cx={f(anchor.cx)} cy={f(anchor.cy)} r={anchor.w / 2} fill={solid ? line : c.shapeFill} stroke={line} strokeWidth={strokeWidth} />
            {n.node.label && <Text theme={theme} block={shape.text} cx={anchor.cx} top={anchor.cy - shape.text.height / 2} weight="bold" />}
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

function IconElement({ n, theme, stroke, strokeWidth }: { n: SceneNode; theme: Theme; stroke: string; strokeWidth: number }) {
  const { anchor, shape, box } = n;
  const c = theme.colors;
  const k = theme.scale;
  const r = anchor.w / 2;
  const { cx, cy } = anchor;
  const props = { fill: c.shapeFill, stroke, strokeWidth };
  let icon: ReactNode;
  switch (n.node.kind) {
    case 'boundary':
      icon = (
        <>
          <circle cx={f(cx + 4 * k)} cy={f(cy)} r={r - 4 * k} {...props} />
          <path d={`M${f(cx - r)},${f(cy - r + 4 * k)} V${f(cy + r - 4 * k)} M${f(cx - r)},${f(cy)} H${f(cx + 4 * k - (r - 4 * k))}`} fill="none" stroke={stroke} strokeWidth={strokeWidth} />
        </>
      );
      break;
    case 'control':
      icon = (
        <>
          <circle cx={f(cx)} cy={f(cy)} r={r - 2 * k} {...props} />
          <path d={`M${f(cx + 2 * k)},${f(cy - r - 2 * k)} L${f(cx - 4 * k)},${f(cy - r + 2 * k)} L${f(cx + 2 * k)},${f(cy - r + 6 * k)}`} fill="none" stroke={stroke} strokeWidth={strokeWidth} />
        </>
      );
      break;
    case 'entity':
      icon = (
        <>
          <circle cx={f(cx)} cy={f(cy - 2 * k)} r={r - 4 * k} {...props} />
          <path d={`M${f(cx - r + 2 * k)},${f(cy + r - 2 * k)} H${f(cx + r - 2 * k)}`} stroke={stroke} strokeWidth={strokeWidth} />
        </>
      );
      break;
    default:
      icon = <circle cx={f(cx)} cy={f(cy)} r={r} {...props} />;
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

/** Outline path for box kinds, drawn inside x,y,w,h. */
function outline(kind: NodeKind, x: number, y: number, w: number, h: number, k: number, theme: Theme): { d: string; extra?: string } {
  const r = theme.name === 'classic' ? 2 * k : 8 * k;
  const rect = (rx: number) =>
    `M${f(x + rx)},${f(y)} H${f(x + w - rx)} Q${f(x + w)},${f(y)} ${f(x + w)},${f(y + rx)} V${f(y + h - rx)} Q${f(x + w)},${f(y + h)} ${f(x + w - rx)},${f(y + h)} H${f(x + rx)} Q${f(x)},${f(y + h)} ${f(x)},${f(y + h - rx)} V${f(y + rx)} Q${f(x)},${f(y)} ${f(x + rx)},${f(y)} Z`;
  switch (kind) {
    case 'database': {
      const e = 7 * k;
      return {
        d: `M${f(x)},${f(y + e)} A${f(w / 2)},${f(e)} 0 0 1 ${f(x + w)},${f(y + e)} V${f(y + h - e)} A${f(w / 2)},${f(e)} 0 0 1 ${f(x)},${f(y + h - e)} Z`,
        extra: `M${f(x)},${f(y + e)} A${f(w / 2)},${f(e)} 0 0 0 ${f(x + w)},${f(y + e)}`,
      };
    }
    case 'queue': {
      const e = 7 * k;
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
      // Bumps along each side, sized to the box.
      const bumpsX = Math.max(3, Math.round(w / (40 * k)));
      const bumpsY = Math.max(1, Math.round(h / (40 * k)));
      const bx = w / bumpsX;
      const by = h / bumpsY;
      const b = 9 * k;
      let d = `M${f(x)},${f(y)}`;
      for (let i = 0; i < bumpsX; i++) d += ` q${f(bx / 2)},${f(-b)} ${f(bx)},0`;
      for (let i = 0; i < bumpsY; i++) d += ` q${f(b)},${f(by / 2)} 0,${f(by)}`;
      for (let i = 0; i < bumpsX; i++) d += ` q${f(-bx / 2)},${f(b)} ${f(-bx)},0`;
      for (let i = 0; i < bumpsY; i++) d += ` q${f(-b)},${f(-by / 2)} 0,${f(-by)}`;
      return { d: d + ' Z' };
    }
    case 'folder': {
      const tw = Math.min(w * 0.4, 60 * k);
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
      return { d: rect(Math.min(h / 2, 18 * k)) };
    case 'hexagon': {
      const i = 12 * k;
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
        d: `M${f(x)},${f(y + o)} H${f(x + w - o)} V${f(y + h)} H${f(x)} Z`,
        extra: `M${f(x + o)},${f(y + o)} V${f(y)} H${f(x + w)} V${f(y + h - o)} H${f(x + w - o)}`,
      };
    }
    case 'person':
      return { d: rect(14 * k) };
    case 'card':
      return { d: rect(6 * k) };
    case 'system':
    case 'container':
      return { d: rect(theme.name === 'classic' ? 6 * k : 10 * k) };
  }
  return { d: rect(r) };
}

function BoxElement({ n, theme, stroke, strokeWidth }: { n: SceneNode; theme: Theme; stroke?: string; strokeWidth: number }) {
  const c = theme.colors;
  const k = theme.scale;
  const kind = n.node.kind;
  const { x, w } = n.box;
  let { y, h } = n.box;
  const shape = n.shape;
  // C4 elements and people stand out: accent tint for internal, grey for external.
  const emphasis = kind === 'system' || kind === 'container' || kind === 'person';
  const fill = kind === 'label' ? 'none' : emphasis ? (n.node.external ? c.systemFill : c.actorFill) : c.shapeFill;
  const line = kind === 'label' ? 'none' : (stroke ?? (emphasis ? (n.node.external ? c.systemStroke : c.actorStroke) : c.shapeStroke));
  let avatar: ReactNode = null;
  if (kind === 'person') {
    // Head above the body box.
    const r = 13 * k;
    avatar = (
      <g>
        <circle cx={f(x + w / 2)} cy={f(y + r)} r={r} fill={fill} stroke={line} strokeWidth={strokeWidth} />
        <circle cx={f(x + w / 2)} cy={f(y + r - 2 * k)} r={4.5 * k} fill={c.actorGlyph} />
        <path d={`M${f(x + w / 2 - 8 * k)},${f(y + r + 9 * k)} a${f(8 * k)},${f(6.5 * k)} 0 0 1 ${f(16 * k)},0 Z`} fill={c.actorGlyph} />
      </g>
    );
    y += 2 * r - 6 * k;
    h -= 2 * r - 6 * k;
  }
  const o = outline(kind, x, y, w, h, k, theme);
  const extra = BOX_EXTRA[kind] ?? {};
  const top = n.box.y + (extra.top ?? 0) * k;
  const bottom = n.box.y + n.box.h - (extra.bottom ?? 0) * k;
  const left = x + (extra.left ?? 0) * k;
  const right = x + w - (extra.right ?? 0) * k;
  const blocks: { block: TextBlock; weight?: number | 'bold'; fill?: string }[] = [];
  if (shape.stereo) blocks.push({ block: shape.stereo, fill: c.muted });
  blocks.push({ block: shape.text, weight: emphasis || n.node.technology !== undefined ? 600 : theme.nodeWeight });
  if (shape.tech) blocks.push({ block: shape.tech, fill: c.muted });
  if (shape.desc) blocks.push({ block: shape.desc, fill: c.muted });
  const total = blocks.reduce((s, b) => s + b.block.height, 0) + (blocks.length - 1) * 2 * k;
  let cursor = (top + bottom) / 2 - total / 2;
  const mid = (left + right) / 2;
  return (
    <>
      <path d={o.d} fill={fill} stroke={line} strokeWidth={strokeWidth} />
      {o.extra && <path d={o.extra} fill="none" stroke={line} strokeWidth={strokeWidth} />}
      {n.node.double && <path d={outline(kind, x + 4 * k, y + 4 * k, w - 8 * k, h - 8 * k, k, theme).d} fill="none" stroke={line} strokeWidth={strokeWidth} />}
      {kind === 'component' && <ComponentGlyph x={x + w - 20 * k} y={n.box.y + 8 * k} k={k} stroke={line} fill={fill} />}
      {avatar}
      {blocks.map((b, i) => {
        const el = <Text key={i} theme={theme} block={b.block} cx={mid} top={cursor} weight={b.weight} fill={b.fill} />;
        cursor += b.block.height + 2 * k;
        return el;
      })}
    </>
  );
}

function ComponentGlyph({ x, y, k, stroke, fill }: { x: number; y: number; k: number; stroke: string; fill: string }) {
  return (
    <g stroke={stroke} strokeWidth={1} fill={fill}>
      <rect x={f(x + 3 * k)} y={f(y)} width={f(12 * k)} height={f(12 * k)} rx={1} />
      <rect x={f(x)} y={f(y + 2.5 * k)} width={f(6 * k)} height={f(2.5 * k)} />
      <rect x={f(x)} y={f(y + 7 * k)} width={f(6 * k)} height={f(2.5 * k)} />
    </g>
  );
}

function StateBox({ n, theme, stroke, strokeWidth }: { n: SceneNode; theme: Theme; stroke: string; strokeWidth: number }) {
  const c = theme.colors;
  const k = theme.scale;
  const { x, y, w, h } = n.box;
  const s = n.shape;
  const top = y + 7 * k;
  return (
    <>
      <rect x={f(x)} y={f(y)} width={f(w)} height={f(h)} rx={10 * k} fill={c.shapeFill} stroke={stroke} strokeWidth={strokeWidth} />
      {s.stereo && <Text theme={theme} block={s.stereo} cx={x + w / 2} top={top} fill={c.muted} />}
      <Text theme={theme} block={s.text} cx={x + w / 2} top={top + (s.stereo?.height ?? 0)} weight={600} />
      {s.desc && (
        <>
          <path d={`M${f(x)},${f(y + s.header!)} H${f(x + w)}`} stroke={stroke} strokeWidth={strokeWidth} />
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

function ClassBox({ n, theme, stroke, strokeWidth }: { n: SceneNode; theme: Theme; stroke: string; strokeWidth: number }) {
  const c = theme.colors;
  const k = theme.scale;
  const { x, y, w, h } = n.box;
  const s = n.shape;
  const classic = theme.name === 'classic';
  const kind = n.node.classKind ?? 'class';
  const spot = classic && kind !== 'json' ? (SPOT[kind] ?? SPOT.class!) : undefined;
  const nameTop = y + 6 * k + (s.stereo?.height ?? 0);
  const nameWidth = s.text.width;
  const spotR = 9 * k;
  const nameCx = x + w / 2 + (spot ? spotR + 2 * k : 0) / 2;
  let cursor = y + s.header!;
  return (
    <>
      <rect x={f(x)} y={f(y)} width={f(w)} height={f(h)} rx={classic ? 2 : 8 * k} fill={c.shapeFill} stroke={stroke} strokeWidth={strokeWidth} />
      {!classic && s.header! > 0 && <path d={`M${f(x + 8 * k)},${f(y)} H${f(x + w - 8 * k)} Q${f(x + w)},${f(y)} ${f(x + w)},${f(y + 8 * k)} V${f(y + s.header!)} H${f(x)} V${f(y + 8 * k)} Q${f(x)},${f(y)} ${f(x + 8 * k)},${f(y)} Z`} fill={c.containerFill} stroke="none" />}
      {spot && (
        <>
          <circle cx={f(nameCx - nameWidth / 2 - spotR - 4 * k)} cy={f(nameTop + s.text.height / 2)} r={spotR} fill={spot[1]} stroke={c.text} strokeWidth={0.75} />
          <text x={f(nameCx - nameWidth / 2 - spotR - 4 * k)} y={f(nameTop + s.text.height / 2 + 4 * k)} fontFamily={theme.font} fontSize={11 * k} fontWeight="bold" textAnchor="middle" fill={c.text}>
            {spot[0]}
          </text>
        </>
      )}
      {s.stereo && <Text theme={theme} block={s.stereo} cx={x + w / 2} top={y + 5 * k} fill={c.muted} />}
      {s.header! > 0 && <Text theme={theme} block={s.text} cx={nameCx} top={nameTop} weight="bold" italic={kind === 'abstract' || kind === 'interface'} />}
      {s.compartments!.map((block, i) => {
        const emptyRow = block.lines.length === 1 && block.lines[0] === ' ';
        const top = cursor;
        cursor += emptyRow ? 8 * k : block.height + 10 * k;
        return (
          <g key={i}>
            {top > y && <path d={`M${f(x)},${f(top)} H${f(x + w)}`} stroke={stroke} strokeWidth={strokeWidth} />}
            {!emptyRow && <Text theme={theme} block={block} cx={x + 12 * k} top={top + 5 * k} align="start" />}
          </g>
        );
      })}
    </>
  );
}

function Topic({ n, theme, stroke, strokeWidth }: { n: SceneNode; theme: Theme; stroke: string; strokeWidth: number }) {
  const c = theme.colors;
  const k = theme.scale;
  const { x, y, w, h } = n.box;
  const s = n.shape;
  const boxless = n.node.stereotype === 'boxless';
  return (
    <>
      {boxless ? (
        <path d={`M${f(x)},${f(y + h)} H${f(x + w)}`} stroke={stroke} strokeWidth={strokeWidth} />
      ) : (
        <rect x={f(x)} y={f(y)} width={f(w)} height={f(h)} rx={theme.name === 'classic' ? 4 * k : h / 2} fill={c.shapeFill} stroke={stroke} strokeWidth={strokeWidth} />
      )}
      <Text theme={theme} block={s.text} cx={x + w / 2} top={y + h / 2 - s.text.height / 2} weight={theme.nodeWeight} />
    </>
  );
}
