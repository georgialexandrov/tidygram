import type { ReactNode } from 'react';
import type { Theme } from '../scene/theme.ts';
import { drawnShape, drawnStyle, drawnText } from '../scene/drawing.ts';
import type { SceneNode } from '../scene/scene.ts';
import { f, Text } from './text.tsx';

/**
 * A shape of a drawing (`Diagram.drawing`) as its draw.io style says: fill,
 * outline, dashes, corners, label alignment. Only the shapes our export
 * writes; the caller draws any other (`drawnShape` undefined) with the theme.
 */
export function DrawnBody({ n, theme, stroke, strokeWidth }: { n: SceneNode; theme: Theme; stroke?: string; strokeWidth: number }): ReactNode {
  const st = drawnStyle(n.node.drawn!.style);
  const shape = drawnShape(st)!;
  const { x, y, w, h } = n.box;
  const colour = (key: string, fallback: string) => {
    const v = st.get(key);
    return v === undefined ? fallback : v;
  };
  const fill = shape === 'text' || shape === 'line' || shape === 'edges' ? 'none' : colour('fillColor', 'none');
  const line = stroke ?? (shape === 'text' ? 'none' : colour('strokeColor', theme.colors.shapeStroke));
  const width = st.has('strokeWidth') ? Number(st.get('strokeWidth')) || 1 : 1;
  const sw = stroke ? strokeWidth : width;
  const dash = st.get('dashed') === '1' ? (st.get('dashPattern') ?? '4 4').split(' ').map((v) => Number(v) * Math.max(1, sw)).join(' ') : undefined;
  const opacity = st.has('opacity') ? Number(st.get('opacity')) / 100 : undefined;
  const common = { fill, stroke: line, strokeWidth: sw, strokeDasharray: dash, opacity };
  const text = n.node.label ? drawnText(n.node, n.box, theme) : undefined;
  const label = text && <Text theme={theme} block={text.block} cx={text.x} top={text.top} align={text.align} weight={text.bold ? 'bold' : undefined} italic={text.italic} underline={text.underline} fill={text.fill} />;

  let body: ReactNode = null;
  if (shape === 'line') {
    const vertical = st.get('direction') === 'south' || h > w;
    body = vertical ? <path d={`M${f(x + w / 2)},${f(y)} V${f(y + h)}`} {...common} fill="none" /> : <path d={`M${f(x)},${f(y + h / 2)} H${f(x + w)}`} {...common} fill="none" />;
  } else if (shape === 'edges') {
    // `partialRectangle`: only the sides that are on (all unless `=0`): a dashed lifeline is the left one.
    const on = (side: string) => st.get(side) !== '0';
    const d = [on('left') && `M${f(x)},${f(y)} V${f(y + h)}`, on('right') && `M${f(x + w)},${f(y)} V${f(y + h)}`, on('top') && `M${f(x)},${f(y)} H${f(x + w)}`, on('bottom') && `M${f(x)},${f(y + h)} H${f(x + w)}`].filter(Boolean).join(' ');
    body = <path d={d} {...common} fill="none" />;
  } else if (shape === 'ellipse') {
    body = <ellipse cx={f(x + w / 2)} cy={f(y + h / 2)} rx={f(w / 2)} ry={f(h / 2)} {...common} />;
  } else if (shape === 'rhombus') {
    body = <polygon points={`${f(x + w / 2)},${f(y)} ${f(x + w)},${f(y + h / 2)} ${f(x + w / 2)},${f(y + h)} ${f(x)},${f(y + h / 2)}`} {...common} />;
  } else if (shape === 'hexagon') {
    const s = Math.min(Number(st.get('size')) || 20, w / 2);
    body = <polygon points={`${f(x + s)},${f(y)} ${f(x + w - s)},${f(y)} ${f(x + w)},${f(y + h / 2)} ${f(x + w - s)},${f(y + h)} ${f(x + s)},${f(y + h)} ${f(x)},${f(y + h / 2)}`} strokeLinejoin="round" {...common} />;
  } else if (shape === 'note') {
    const s = Math.min(Number(st.get('size')) || 10, w, h);
    body = (
      <>
        <path d={`M${f(x)},${f(y)} H${f(x + w - s)} L${f(x + w)},${f(y + s)} V${f(y + h)} H${f(x)} Z`} {...common} strokeLinejoin="round" />
        <path d={`M${f(x + w - s)},${f(y)} V${f(y + s)} H${f(x + w)}`} fill="none" stroke={line} strokeWidth={sw} strokeLinejoin="round" />
      </>
    );
  } else if (shape === 'frame') {
    // The frame is open (a fragment's contents show through); its tab takes the file's fill.
    const tw = Math.min(Number(st.get('width')) || 40, w);
    const th = Math.min(Number(st.get('height')) || 20, h);
    const cut = Math.min(8, th / 2);
    const tabFill = colour('swimlaneFillColor', 'none');
    body = (
      <>
        <rect x={f(x)} y={f(y)} width={f(w)} height={f(h)} {...common} />
        <path d={`M${f(x)},${f(y)} H${f(x + tw)} V${f(y + th - cut)} L${f(x + tw - cut)},${f(y + th)} H${f(x)} Z`} {...common} fill={tabFill} />
      </>
    );
  } else if (shape === 'box') {
    const rounded = st.get('rounded') === '1';
    const arc = Number(st.get('arcSize')) || 15;
    const radius = rounded ? (st.get('absoluteArcSize') === '1' ? arc : (Math.min(w, h) * arc) / 100) : 0;
    body = <rect x={f(x)} y={f(y)} width={f(w)} height={f(h)} rx={f(Math.min(radius, h / 2, w / 2))} {...common} />;
  }
  return (
    <>
      {body}
      {label}
    </>
  );
}
