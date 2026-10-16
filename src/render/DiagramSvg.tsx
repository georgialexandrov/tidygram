import { memo, type MouseEvent, type PointerEvent, type ReactNode } from 'react';
import type { Point } from '../layout/layout-file.ts';
import type { ArrowHead } from '../model/types.ts';
import type { Box } from '../scene/containers.ts';
import { frameRect } from '../scene/frame.ts';
import { roundedPath, trimEnd } from '../scene/geometry.ts';
import { LINE_HEIGHT, type TextBlock } from '../scene/measure.ts';
import type { Scene, SceneContainer, SceneEdge, SceneNode } from '../scene/scene.ts';
import type { Theme } from '../scene/theme.ts';

export const EDITOR_COLORS = {
  selected: '#2F6FEB',
  pinned: '#E8590C',
};

export interface Interaction {
  selectedNodes: ReadonlySet<string>;
  selectedEdge?: string;
  showPins: boolean;
  onNodeDown(id: string, e: PointerEvent): void;
  onContainerDown(id: string, e: PointerEvent): void;
  onEdgeDown(id: string, e: PointerEvent): void;
  onEdgeDoubleClick(id: string, e: MouseEvent): void;
  onLabelDown(id: string, e: PointerEvent): void;
  onViaDown(id: string, index: number, e: PointerEvent): void;
  onViaDoubleClick(id: string, index: number, e: MouseEvent): void;
}

const f = (n: number) => Math.round(n * 10) / 10;

interface TextProps {
  theme: Theme;
  block: TextBlock;
  cx: number;
  top: number;
  align?: 'middle' | 'start';
  weight?: number | 'bold';
  fill?: string;
  caps?: boolean;
}

function Text({ theme, block, cx, top, align = 'middle', weight, fill, caps }: TextProps) {
  const lineH = block.size * LINE_HEIGHT;
  return (
    <text
      fontFamily={theme.font}
      fontSize={block.size}
      fontWeight={weight}
      textAnchor={align}
      fill={fill ?? theme.colors.text}
      letterSpacing={caps ? '0.08em' : undefined}
      style={{ pointerEvents: 'none', userSelect: 'none' }}
    >
      {block.lines.map((line, i) => (
        <tspan key={i} x={f(cx)} y={f(top + i * lineH + (lineH - block.size) / 2 + block.size * 0.8)}>
          {caps ? line.toUpperCase() : line}
        </tspan>
      ))}
    </text>
  );
}

function ActorFigure({ n, theme, stroke, strokeWidth }: { n: SceneNode; theme: Theme; stroke?: string; strokeWidth: number }) {
  const { anchor } = n;
  const c = theme.colors;
  // Glyphs are drawn at design size around (0,0) = figure centre, then scaled; strokes stay thin.
  const k = theme.iconScale;
  const sw = strokeWidth / Math.sqrt(k);
  const w = anchor.w / k;
  const h = anchor.h / k;
  let glyph: ReactNode;
  if (theme.actor.style === 'stick') {
    const t = -h / 2;
    glyph = (
      <>
        <rect x={-w / 2} y={t} width={w} height={h} fill="transparent" />
        <circle cx={0} cy={t + 8} r={7} fill={c.actorFill} stroke={stroke ?? c.actorStroke} strokeWidth={sw} />
        <path
          d={`M0,${t + 15} L0,${t + 32} M-13,${t + 21} L13,${t + 21} M-11,${t + 47} L0,${t + 32} L11,${t + 47}`}
          fill="none"
          stroke={stroke ?? c.actorStroke}
          strokeWidth={sw}
        />
      </>
    );
  } else if (n.node.stereotype === 'system') {
    // External systems: a rounded tile with a server glyph.
    glyph = (
      <>
        <rect x={-w / 2} y={-h / 2} width={w} height={h} rx={8} fill={c.systemFill} stroke={stroke ?? c.systemStroke} strokeWidth={sw} />
        <g fill="none" stroke={c.systemGlyph} strokeWidth={1.25} strokeLinecap="round">
          <rect x={-8} y={-8} width={16} height={7} rx={2} />
          <rect x={-8} y={1} width={16} height={7} rx={2} />
          <path d="M-4.5,-4.5 h1 M-4.5,4.5 h1" />
        </g>
      </>
    );
  } else {
    // People: an avatar disc with a head-and-shoulders glyph.
    glyph = (
      <>
        <circle cx={0} cy={0} r={w / 2} fill={c.actorFill} stroke={stroke ?? c.actorStroke} strokeWidth={sw} />
        <circle cx={0} cy={-3.5} r={4.5} fill={c.actorGlyph} />
        <path d="M-8,9 a8,6.5 0 0 1 16,0 Z" fill={c.actorGlyph} />
      </>
    );
  }
  return <g transform={`translate(${f(anchor.cx)},${f(anchor.cy)}) scale(${k})`}>{glyph}</g>;
}

interface NodeProps {
  n: SceneNode;
  theme: Theme;
  ix?: Interaction;
  selected: boolean;
}

function NodeViewImpl({ n, theme, ix, selected }: NodeProps) {
  const c = theme.colors;
  const sel = selected ? EDITOR_COLORS.selected : undefined;
  const strokeWidth = selected ? 2 : 1;
  const { box, anchor, shape } = n;
  const cx = box.x + box.w / 2;
  const weight = theme.nodeWeight;
  let body: ReactNode;

  if (n.node.kind === 'actor') {
    const labelTop = anchor.cy + anchor.h / 2 + 6 * theme.scale;
    body = (
      <>
        {shape.stereo && <Text theme={theme} block={shape.stereo} cx={cx} top={box.y} fill={c.muted} />}
        <ActorFigure n={n} theme={theme} stroke={sel} strokeWidth={strokeWidth} />
        {/* Lines may leave an actor downwards, under its label; the backing keeps the label readable. */}
        <rect
          x={f(cx - shape.text.width / 2 - 2)}
          y={f(labelTop)}
          width={f(shape.text.width + 4)}
          height={f(shape.text.height)}
          fill={c.background}
          fillOpacity={0.85}
        />
        <Text theme={theme} block={shape.text} cx={cx} top={labelTop} weight={weight} fill={c.actorText} />
      </>
    );
  } else if (n.node.kind === 'usecase') {
    const textH = shape.text.height + (shape.stereo?.height ?? 0);
    const top = anchor.cy - textH / 2;
    const outline =
      anchor.shape === 'pill' ? (
        <rect
          x={f(anchor.cx - anchor.w / 2)}
          y={f(anchor.cy - anchor.h / 2)}
          width={anchor.w}
          height={anchor.h}
          rx={anchor.h / 2}
          fill={c.shapeFill}
          stroke={sel ?? c.shapeStroke}
          strokeWidth={strokeWidth}
        />
      ) : (
        <ellipse cx={f(anchor.cx)} cy={f(anchor.cy)} rx={anchor.w / 2} ry={anchor.h / 2} fill={c.shapeFill} stroke={sel ?? c.shapeStroke} strokeWidth={strokeWidth} />
      );
    body = (
      <>
        {outline}
        {shape.stereo && <Text theme={theme} block={shape.stereo} cx={cx} top={top} fill={c.muted} />}
        <Text theme={theme} block={shape.text} cx={cx} top={top + (shape.stereo?.height ?? 0)} weight={weight} />
      </>
    );
  } else {
    const { x, y, w, h } = box;
    const fold = 10 * theme.scale;
    body = (
      <>
        {theme.noteFold ? (
          <path
            d={`M${f(x)},${f(y)} L${f(x + w - fold)},${f(y)} L${f(x + w)},${f(y + fold)} L${f(x + w)},${f(y + h)} L${f(x)},${f(y + h)} Z M${f(x + w - fold)},${f(y)} L${f(x + w - fold)},${f(y + fold)} L${f(x + w)},${f(y + fold)}`}
            fill={c.noteFill}
            stroke={sel ?? c.noteStroke}
            strokeWidth={strokeWidth}
          />
        ) : (
          <rect x={f(x)} y={f(y)} width={f(w)} height={f(h)} rx={6 * theme.scale} fill={c.noteFill} stroke={sel ?? c.noteStroke} strokeWidth={strokeWidth} />
        )}
        <Text theme={theme} block={shape.text} cx={x + 13 * theme.scale} top={y + 7 * theme.scale} align="start" fill={c.noteText} />
      </>
    );
  }

  return (
    <g data-id={n.node.id} onPointerDown={ix ? (e) => ix.onNodeDown(n.node.id, e) : undefined} style={ix ? { cursor: 'move' } : undefined}>
      {ix && <rect x={box.x} y={box.y} width={box.w} height={box.h} fill="transparent" />}
      {body}
      {ix?.showPins && n.pinned && <circle cx={f(box.x + box.w - 2)} cy={f(box.y + 2)} r={3} fill={EDITOR_COLORS.pinned} />}
    </g>
  );
}

const sameBox = (a: Box, b: Box) => a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;

// Scenes are rebuilt on every move; elements whose geometry didn't change skip rendering.
// `ix` is a stable object in the editor, so it isn't compared.
const NodeView = memo(
  NodeViewImpl,
  (a, b) => a.n.node === b.n.node && sameBox(a.n.box, b.n.box) && a.n.pinned === b.n.pinned && a.theme === b.theme && a.selected === b.selected && !!a.ix === !!b.ix,
);

const ContainerView = memo(
  ContainerViewImpl,
  (a, b) => a.c.id === b.c.id && a.c.label === b.c.label && a.c.depth === b.c.depth && sameBox(a.c.box, b.c.box) && a.theme === b.theme && !!a.ix === !!b.ix,
);

function ContainerViewImpl({ c, theme, ix }: { c: SceneContainer; theme: Theme; ix?: Interaction }) {
  const { x, y, w, h } = c.box;
  const col = theme.colors;
  const nested = c.depth > 0;
  const title: TextBlock = { lines: [c.label], width: 0, height: theme.size.container * LINE_HEIGHT, size: theme.size.container };
  const k = theme.scale;
  const radius = Math.max(2, theme.containerRadius - c.depth * 4 * k);
  return (
    <g data-container={c.id}>
      <rect
        x={f(x)}
        y={f(y)}
        width={f(w)}
        height={f(h)}
        rx={radius}
        fill={nested ? col.nestedFill : col.containerFill}
        stroke={nested ? col.nestedStroke : col.containerStroke}
        strokeWidth={1}
      />
      {/* Only the title strip grabs the pointer, so the inside stays free for nodes and panning. */}
      {ix && <rect x={f(x)} y={f(y)} width={f(w)} height={24 * k} fill="transparent" style={{ cursor: 'move' }} onPointerDown={(e) => ix.onContainerDown(c.id, e)} />}
      {theme.containerTitle === 'caps' ? (
        <Text theme={theme} block={title} cx={x + 16 * k} top={y + 10 * k} align="start" weight={600} fill={col.title} caps />
      ) : (
        <Text theme={theme} block={title} cx={x + w / 2} top={y + 6 * k} weight="bold" fill={col.title} />
      )}
    </g>
  );
}

function arrowHead(theme: Theme, kind: ArrowHead, tip: Point, from: Point, color: string): ReactNode {
  if (kind === 'none') return null;
  const len = Math.hypot(tip[0] - from[0], tip[1] - from[1]) || 1;
  const dx = (tip[0] - from[0]) / len;
  const dy = (tip[1] - from[1]) / len;
  const at = (back: number, side: number) => `${f(tip[0] - dx * back - dy * side)},${f(tip[1] - dy * back + dx * side)}`;
  const t = `${f(tip[0])},${f(tip[1])}`;
  const k = Math.sqrt(theme.scale);
  if (kind === 'triangle') {
    const size = (theme.arrow === 'chevron' ? 12 : 14) * k;
    return <polygon points={`${t} ${at(size, size / 2)} ${at(size, -size / 2)}`} fill={theme.colors.background} stroke={color} strokeLinejoin="round" />;
  }
  if (theme.arrow === 'chevron') {
    return <polyline points={`${at(8 * k, 4.5 * k)} ${t} ${at(8 * k, -4.5 * k)}`} fill="none" stroke={color} strokeWidth={theme.colors.lineWidth} strokeLinecap="round" strokeLinejoin="round" />;
  }
  return <polygon points={`${t} ${at(10 * k, 4 * k)} ${at(7 * k, 0)} ${at(10 * k, -4 * k)}`} fill={color} stroke={color} />;
}

interface EdgeProps {
  e: SceneEdge;
  theme: Theme;
  ix?: Interaction;
  selected: boolean;
}

// Reused (not re-routed) lines keep their SceneEdge object, so identity is enough.
const EdgeView = memo(EdgeViewImpl, (a, b) => a.e === b.e && a.theme === b.theme && a.selected === b.selected && !!a.ix === !!b.ix);

function EdgeViewImpl({ e, theme, ix, selected }: EdgeProps) {
  const id = e.edge.id;
  const c = theme.colors;
  const base = e.kind === 'noteLink' ? c.noteLink : e.kind === 'generalization' ? c.generalization : e.dashed ? c.dependency : c.line;
  const color = selected ? EDITOR_COLORS.selected : base;
  const pts = e.points;
  if (pts.length < 2) return null;
  let line = pts;
  const trim = (theme.arrow === 'chevron' ? 12 : 14) * Math.sqrt(theme.scale);
  if (e.head === 'triangle') line = trimEnd(line, trim);
  if (e.tail === 'triangle') line = trimEnd([...line].reverse(), trim).reverse();
  const d = roundedPath(line, theme.bendRadius);
  const dash = e.kind === 'noteLink' ? theme.dash.note : e.dashed ? theme.dash.dependency : undefined;
  const chip = theme.colors.labelStroke !== 'none';
  const padX = (chip ? 6 : 2) * theme.scale;
  const padY = (chip ? 2 : 0) * theme.scale;
  return (
    <g data-edge={id}>
      {ix && (
        <path
          d={d}
          fill="none"
          stroke="transparent"
          strokeWidth={12}
          style={{ cursor: 'pointer' }}
          onPointerDown={(ev) => ix.onEdgeDown(id, ev)}
          onDoubleClick={(ev) => ix.onEdgeDoubleClick(id, ev)}
        />
      )}
      <path d={d} fill="none" stroke={color} strokeWidth={selected ? 2 : c.lineWidth} strokeDasharray={dash} strokeLinecap="round" style={{ pointerEvents: 'none' }} />
      <g style={{ pointerEvents: 'none' }}>
        {arrowHead(theme, e.head, pts[pts.length - 1]!, pts[pts.length - 2]!, color)}
        {arrowHead(theme, e.tail, pts[0]!, pts[1]!, color)}
      </g>
      {e.label && (
        <g onPointerDown={ix ? (ev) => ix.onLabelDown(id, ev) : undefined} style={ix ? { cursor: 'move' } : undefined}>
          <rect
            x={f(e.label.x - e.label.text.width / 2 - padX)}
            y={f(e.label.y - e.label.text.height / 2 - padY)}
            width={f(e.label.text.width + padX * 2)}
            height={f(e.label.text.height + padY * 2)}
            rx={chip ? 4 * theme.scale : 0}
            fill={c.labelFill}
            fillOpacity={chip ? 1 : 0.85}
            stroke={chip ? c.labelStroke : undefined}
          />
          <Text
            theme={theme}
            block={e.label.text}
            cx={e.label.x}
            top={e.label.y - e.label.text.height / 2}
            fill={e.dashed && e.kind !== 'noteLink' ? c.dependencyLabel : c.text}
            weight={chip ? 500 : undefined}
          />
        </g>
      )}
      {selected &&
        e.via.map(([x, y], i) => (
          <rect
            key={i}
            x={x - 4}
            y={y - 4}
            width={8}
            height={8}
            fill="#FFFFFF"
            stroke={EDITOR_COLORS.selected}
            strokeWidth={1.5}
            style={{ cursor: 'move' }}
            onPointerDown={(ev) => ix?.onViaDown(id, i, ev)}
            onDoubleClick={(ev) => ix?.onViaDoubleClick(id, i, ev)}
          />
        ))}
    </g>
  );
}

/** The diagram content. Containers first, then edges, then nodes, so nodes stay grabbable on top. */
export function DiagramContent({ scene, ix }: { scene: Scene; ix?: Interaction }) {
  const theme = scene.theme;
  return (
    <g>
      {scene.containers.map((c) => (
        <ContainerView key={c.id} c={c} theme={theme} ix={ix} />
      ))}
      {scene.edges.map((e) => (
        <EdgeView key={e.edge.id} e={e} theme={theme} ix={ix} selected={ix?.selectedEdge === e.edge.id} />
      ))}
      {scene.nodes.map((n) => (
        <NodeView key={n.node.id} n={n} theme={theme} ix={ix} selected={ix?.selectedNodes.has(n.node.id) ?? false} />
      ))}
    </g>
  );
}

/** Standalone, non-interactive SVG for export. With a frame, the canvas has exactly that aspect ratio. */
export function DiagramSvg({ scene, frame, margin = 24 }: { scene: Scene; frame?: Point; margin?: number }) {
  const b = scene.bounds;
  const box: Box = frame ? frameRect(b, frame, margin) : { x: b.x - margin, y: b.y - margin, w: b.w + margin * 2, h: b.h + margin * 2 };
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox={`${f(box.x)} ${f(box.y)} ${f(box.w)} ${f(box.h)}`} width={Math.ceil(box.w)} height={Math.ceil(box.h)}>
      <rect x={f(box.x)} y={f(box.y)} width={f(box.w)} height={f(box.h)} fill={scene.theme.colors.background} />
      <DiagramContent scene={scene} />
    </svg>
  );
}
