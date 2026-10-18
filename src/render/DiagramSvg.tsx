import { memo, type MouseEvent, type PointerEvent, type ReactNode } from 'react';
import type { Point } from '../layout/layout-file.ts';
import type { ArrowHead } from '../model/types.ts';
import type { Box } from '../scene/containers.ts';
import { frameRect } from '../scene/frame.ts';
import { pointAt, roundedPath, trimEnd } from '../scene/geometry.ts';
import { LINE_HEIGHT, textWidth, type TextBlock } from '../scene/measure.ts';
import type { Scene, SceneContainer, SceneEdge, SceneNode } from '../scene/scene.ts';
import { mix, type Theme } from '../scene/theme.ts';
import { NodeBody } from './nodes.tsx';
import { DrawnBody } from './DrawnNode.tsx';
import { drawnShape, drawnStyle } from '../scene/drawing.ts';
import type { AnyScene } from '../scene/any.ts';
import { SequenceContent } from './SequenceSvg.tsx';
import { GanttContent, TimingContent } from './TimeSvg.tsx';
import { f, Text } from './text.tsx';
import { TemplateBackdrop } from './TemplateSvg.tsx';

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
  /** End handles of the selected line: drag to move where it attaches, double-click to reset. */
  onEndDown?(id: string, end: 'from' | 'to', e: PointerEvent): void;
  onEndDoubleClick?(id: string, end: 'from' | 'to', e: MouseEvent): void;
  /** Pointer over an end handle (or off it: `end` null): the editor shows the outline and its snap points. */
  onEndHover?(id: string, end: 'from' | 'to' | null): void;
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
  /** Mindmap topics: tree level (0 = root). */
  depth?: number;
}

function NodeViewImpl({ n, theme, ix, selected, depth }: NodeProps) {
  const c = theme.colors;
  const sel = selected ? EDITOR_COLORS.selected : undefined;
  const strokeWidth = selected ? 2 : 1;
  const { box, anchor, shape } = n;
  const cx = box.x + box.w / 2;
  const weight = theme.nodeWeight;
  let body: ReactNode;

  if (n.node.drawn && drawnShape(drawnStyle(n.node.drawn.style))) {
    body = <DrawnBody n={n} theme={theme} stroke={sel} strokeWidth={strokeWidth} />;
  } else if (n.node.kind === 'actor') {
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
  } else if (n.node.kind !== 'note') {
    body = <NodeBody n={n} theme={theme} stroke={sel} strokeWidth={strokeWidth} depth={depth} />;
  } else {
    const { x, y, w, h } = box;
    const k = theme.scale;
    const fold = 10 * k;
    body = (
      <>
        {theme.noteFold ? (
          <>
            <path d={`M${f(x)},${f(y)} L${f(x + w - fold)},${f(y)} L${f(x + w)},${f(y + fold)} L${f(x + w)},${f(y + h)} L${f(x)},${f(y + h)} Z`} fill={c.noteFill} stroke={sel ?? c.noteStroke} strokeWidth={strokeWidth} strokeLinejoin="round" />
            <path d={`M${f(x + w - fold)},${f(y)} L${f(x + w - fold)},${f(y + fold)} L${f(x + w)},${f(y + fold)}`} fill={mix(c.noteFill, c.noteStroke, 0.25)} stroke={sel ?? c.noteStroke} strokeWidth={strokeWidth} strokeLinejoin="round" />
          </>
        ) : (
          // A margin note: soft tint, a keyline down the left edge, no box weight.
          <>
            <rect x={f(x)} y={f(y)} width={f(w)} height={f(h)} rx={f(Math.min(6 * k, theme.nodeRadius))} fill={c.noteFill} stroke={sel ?? c.noteStroke} strokeWidth={strokeWidth} />
            <path d={`M${f(x + 0.5)},${f(y + Math.min(6 * k, theme.nodeRadius))} V${f(y + h - Math.min(6 * k, theme.nodeRadius))}`} stroke={sel ?? mix(c.noteStroke, c.noteText, 0.35)} strokeWidth={2.5 * Math.sqrt(k)} strokeLinecap="round" />
          </>
        )}
        <Text theme={theme} block={shape.text} cx={x + 13 * k} top={y + 7 * k} align="start" fill={c.noteText} />
      </>
    );
  }

  return (
    <g data-id={n.node.id} data-selected={selected || undefined} onPointerDown={ix ? (e) => ix.onNodeDown(n.node.id, e) : undefined} style={ix ? { cursor: 'move' } : undefined}>
      {ix && <rect x={box.x} y={box.y} width={box.w} height={box.h} fill="transparent" />}
      {body}
      {/* Editor only: an outline that stays visible at any zoom, so a multi-selection reads at a glance. */}
      {ix && selected && (
        <rect x={f(box.x - 4)} y={f(box.y - 4)} width={f(box.w + 8)} height={f(box.h + 8)} fill="none" stroke={EDITOR_COLORS.selected} strokeWidth={1.5} strokeDasharray="4 3" vectorEffect="non-scaling-stroke" pointerEvents="none" />
      )}
      {ix?.showPins && n.pinned && <circle cx={f(box.x + box.w - 2)} cy={f(box.y + 2)} r={3} fill={EDITOR_COLORS.pinned} />}
    </g>
  );
}

const sameBox = (a: Box, b: Box) => a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;

// Scenes are rebuilt on every move; elements whose geometry didn't change skip rendering.
// `ix` is a stable object in the editor, so it isn't compared.
export const NodeView = memo(
  NodeViewImpl,
  (a, b) => a.n.node === b.n.node && sameBox(a.n.box, b.n.box) && a.n.pinned === b.n.pinned && a.theme === b.theme && a.selected === b.selected && a.depth === b.depth && !!a.ix === !!b.ix,
);

const ContainerView = memo(
  ContainerViewImpl,
  (a, b) => a.c.id === b.c.id && a.c.label === b.c.label && a.c.depth === b.c.depth && sameBox(a.c.box, b.c.box) && a.theme === b.theme && !!a.ix === !!b.ix,
);

/** A container's fill and outline. Containers are structure: tinted, hairline, never heavier than what they hold. */
function containerStyle(c: SceneContainer, theme: Theme) {
  const col = theme.colors;
  const k = theme.scale;
  const nested = c.depth > 0;
  const kind = c.kind;
  if (kind === 'state') return { fill: col.shapeFill, stroke: col.shapeStroke, radius: theme.nodeRadius === 0 ? 0 : 12 * k, dash: undefined };
  const fill = nested ? col.nestedFill : col.containerFill;
  const stroke = nested ? col.nestedStroke : col.containerStroke;
  const radius = theme.containerRadius === 0 ? 0 : Math.max(2 * k, theme.containerRadius - c.depth * 4 * k);
  // Boundaries (C4, ArchiMate grouping) are a dashed frame a little darker than a package outline.
  if (kind === 'boundary') return { fill, stroke: theme.plantuml ? stroke : mix(stroke, col.muted, 0.45), radius, dash: `${5 * k} ${4 * k}` };
  return { fill, stroke, radius, dash: undefined };
}

function ContainerViewImpl({ c, theme, ix }: { c: SceneContainer; theme: Theme; ix?: Interaction }) {
  const { x, y, w, h } = c.box;
  const k = theme.scale;
  const kind = c.kind;
  const st = containerStyle(c, theme);
  const d3 = kind === 'node' ? 8 * k : 0;
  return (
    <g data-container={c.id}>
      <rect x={f(x)} y={f(y + d3)} width={f(w - d3)} height={f(h - d3)} rx={d3 ? 0 : f(st.radius)} fill={st.fill} stroke={st.stroke} strokeWidth={1} strokeDasharray={st.dash} />
      {d3 > 0 && (
        <path
          d={`M${f(x)},${f(y + d3)} L${f(x + d3)},${f(y)} H${f(x + w)} V${f(y + h - d3)} L${f(x + w - d3)},${f(y + h)} M${f(x + w - d3)},${f(y + d3)} L${f(x + w)},${f(y)}`}
          fill="none"
          stroke={st.stroke}
          strokeWidth={1}
          strokeLinejoin="round"
        />
      )}
      {kind === 'state' && <path d={`M${f(x)},${f(y + 26 * k)} H${f(x + w)}`} stroke={theme.plantuml ? st.stroke : theme.colors.grid} strokeWidth={1} />}
      {/* Only the title strip grabs the pointer, so the inside stays free for nodes and panning. */}
      {ix && <rect x={f(x)} y={f(y)} width={f(w)} height={24 * k} fill="transparent" style={{ cursor: 'move' }} onPointerDown={(e) => ix.onContainerDown(c.id, e)} />}
    </g>
  );
}

const ContainerTitle = memo(ContainerTitleImpl, (a, b) => a.c.id === b.c.id && a.c.label === b.c.label && a.c.depth === b.c.depth && sameBox(a.c.box, b.c.box) && a.theme === b.theme);

/**
 * Container titles are drawn above the lines on a chip of the container's own
 * fill, so a line that has to cross a title passes under it instead of
 * striking it through.
 */
function ContainerTitleImpl({ c, theme }: { c: SceneContainer; theme: Theme }) {
  const { x, y, w } = c.box;
  const col = theme.colors;
  const k = theme.scale;
  const kind = c.kind;
  const st = containerStyle(c, theme);
  const back = st.fill === 'none' ? col.background : st.fill;
  const d3 = kind === 'node' ? 8 * k : 0;
  if (!c.label) return null;
  if (kind === 'state') {
    const size = theme.size.node;
    const block: TextBlock = { lines: [c.label], width: 0, height: size * LINE_HEIGHT, size };
    return <Text theme={theme} block={block} cx={x + w / 2} top={y + 13 * k - block.height / 2} weight={600} />;
  }
  const size = theme.size.container;
  const caps = theme.containerTitle === 'caps';
  const block: TextBlock = { lines: [c.label], width: 0, height: size * LINE_HEIGHT, size };
  const textW = textWidth(caps ? c.label.toUpperCase() : c.label, size, true, theme.widthFactor) + (caps ? 0.08 * size * c.label.length : 0);
  const left = (caps ? x + 14 * k : x + w / 2 - textW / 2) + (c.titleShift ?? 0);
  const top = caps ? y + 10 * k + d3 : y + 6 * k;
  return (
    <g style={{ pointerEvents: 'none' }}>
      <rect x={f(left - 4 * k)} y={f(top - 1 * k)} width={f(textW + 8 * k)} height={f(block.height + 2 * k)} rx={f(3 * k)} fill={back} />
      {caps ? (
        <Text theme={theme} block={block} cx={left} top={top} align="start" weight={600} fill={col.title} caps />
      ) : (
        <Text theme={theme} block={block} cx={x + w / 2} top={top} weight="bold" fill={col.title} />
      )}
    </g>
  );
}

/**
 * Line ends. Sizes follow the line weight (a hairline gets a small, sharp
 * head) and scale with the square root of the view size, like the lines.
 */
function arrowHead(theme: Theme, kind: ArrowHead, tip: Point, from: Point, color: string, sw: number): ReactNode {
  if (kind === 'none') return null;
  const len = Math.hypot(tip[0] - from[0], tip[1] - from[1]) || 1;
  const dx = (tip[0] - from[0]) / len;
  const dy = (tip[1] - from[1]) / len;
  // A point `back` along the line from the tip and `side` across it.
  const at = (back: number, side: number) => `${f(tip[0] - dx * back - dy * side)},${f(tip[1] - dy * back + dx * side)}`;
  const xy = (back: number, side: number): [number, number] => [tip[0] - dx * back - dy * side, tip[1] - dy * back + dx * side];
  const t = `${f(tip[0])},${f(tip[1])}`;
  const k = Math.sqrt(theme.scale);
  const bg = theme.colors.background;
  const bar = (back: number) => <polyline points={`${at(back * k, 6 * k)} ${at(back * k, -6 * k)}`} fill="none" stroke={color} strokeWidth={sw} strokeLinecap="round" />;
  const ring = (back: number) => {
    const [cx, cy] = xy(back * k, 0);
    return <circle cx={f(cx)} cy={f(cy)} r={f(4 * k)} fill={bg} stroke={color} strokeWidth={sw} />;
  };
  const crow = <polyline points={`${at(0, 7 * k)} ${at(11 * k, 0)} ${at(0, -7 * k)}`} fill="none" stroke={color} strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round" />;
  switch (kind) {
    case 'triangle': {
      const [l, hw] = theme.plantuml ? [14 * k, 7 * k] : [12 * k, 6 * k];
      return <polygon points={`${t} ${at(l, hw)} ${at(l, -hw)}`} fill={bg} stroke={color} strokeWidth={sw} strokeLinejoin="miter" />;
    }
    case 'diamond':
    case 'diamondFilled':
      return <polygon points={`${t} ${at(7.5 * k, 5 * k)} ${at(15 * k, 0)} ${at(7.5 * k, -5 * k)}`} fill={kind === 'diamondFilled' ? color : bg} stroke={color} strokeWidth={sw} strokeLinejoin="miter" />;
    case 'circle':
      return ring(4);
    case 'dot': {
      const [cx, cy] = xy(4 * k, 0);
      return <circle cx={f(cx)} cy={f(cy)} r={f(3.5 * k)} fill={color} />;
    }
    case 'circlePlus': {
      const [cx, cy] = xy(5 * k, 0);
      return (
        <g stroke={color} strokeWidth={sw}>
          <circle cx={f(cx)} cy={f(cy)} r={f(5 * k)} fill={bg} />
          <path d={`M${f(cx - 5 * k)},${f(cy)} h${f(10 * k)} M${f(cx)},${f(cy - 5 * k)} v${f(10 * k)}`} />
        </g>
      );
    }
    case 'cross':
      return <path d={`M${at(4 * k, 4 * k)} L${at(12 * k, -4 * k)} M${at(4 * k, -4 * k)} L${at(12 * k, 4 * k)}`} stroke={color} strokeWidth={sw} strokeLinecap="round" />;
    case 'square':
      return <polygon points={`${at(0, 4 * k)} ${at(8 * k, 4 * k)} ${at(8 * k, -4 * k)} ${at(0, -4 * k)}`} fill={bg} stroke={color} strokeWidth={sw} />;
    case 'crowOne':
      return (
        <>
          {bar(6)}
          {bar(11)}
        </>
      );
    case 'crowZeroOne':
      return (
        <>
          {bar(6)}
          {ring(15)}
        </>
      );
    case 'crowMany':
      return crow;
    case 'crowOneMany':
      return (
        <>
          {crow}
          {bar(14)}
        </>
      );
    case 'crowZeroMany':
      return (
        <>
          {crow}
          {ring(17)}
        </>
      );
  }
  if (theme.arrow === 'chevron') {
    return <polyline points={`${at(8 * k, 4.5 * k)} ${t} ${at(8 * k, -4.5 * k)}`} fill="none" stroke={color} strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round" />;
  }
  // A slim, notched head: sharp at the tip, light at the back, so it never looks heavier than the line.
  const [l, hw, notch] = theme.plantuml ? [10 * k, 4 * k, 7 * k] : [9 * k, 3.75 * k, 7 * k];
  return <polygon points={`${t} ${at(l, hw)} ${at(notch, 0)} ${at(l, -hw)}`} fill={color} stroke={color} strokeWidth={0.5} strokeLinejoin="miter" />;
}

/** How far the line stops short of the tip so the head isn't drawn over it (or poking out of it). */
function headInset(theme: Theme, kind: ArrowHead): number {
  const k = Math.sqrt(theme.scale);
  if (kind === 'triangle') return (theme.plantuml ? 14 : 12) * k;
  if (kind === 'diamond' || kind === 'diamondFilled') return 15 * k;
  if (kind === 'circle' || kind === 'circlePlus') return 8 * k;
  if (kind === 'arrow') return theme.arrow === 'chevron' ? 0.5 * k : 6 * k;
  if (kind === 'dot') return 4 * k;
  return 0;
}

interface EdgeProps {
  e: SceneEdge;
  theme: Theme;
  ix?: Interaction;
  selected: boolean;
  /** Mindmaps: a smooth branch drawn instead of the routed line, and its weight (by tree level). */
  curve?: string;
  weight?: number;
}

// Reused (not re-routed) lines keep their SceneEdge object, so identity is enough.
const EdgeView = memo(EdgeViewImpl, (a, b) => a.e === b.e && a.theme === b.theme && a.selected === b.selected && a.curve === b.curve && a.weight === b.weight && !!a.ix === !!b.ix);

/** The line colour says what kind of relation it is: structure darker, dependencies and note links quieter. */
function lineColour(e: SceneEdge, theme: Theme): string {
  const c = theme.colors;
  if (e.kind === 'noteLink') return c.noteLink;
  if (e.kind === 'generalization' || e.kind === 'realization' || e.kind === 'composition' || e.kind === 'aggregation') return c.generalization;
  return e.dashed ? c.dependency : c.line;
}

function EdgeViewImpl({ e, theme, ix, selected, curve, weight }: EdgeProps) {
  const id = e.edge.id;
  const c = theme.colors;
  const k = theme.scale;
  const base = lineColour(e, theme);
  const warn = e.violation ? c.warning : undefined;
  const color = selected ? EDITOR_COLORS.selected : (warn ?? base);
  const pts = e.points;
  if (pts.length < 2) return null;
  let line = pts;
  if (headInset(theme, e.head)) line = trimEnd(line, headInset(theme, e.head));
  if (headInset(theme, e.tail)) line = trimEnd([...line].reverse(), headInset(theme, e.tail)).reverse();
  const d = curve ?? roundedPath(line, theme.bendRadius);
  const dash = e.kind === 'noteLink' ? theme.dash.note : e.dashed ? theme.dash.dependency : undefined;
  const width = selected ? 2 : warn ? c.lineWidth * 1.8 : (weight ?? c.lineWidth);
  const chip = theme.labelChip;
  const padX = (chip ? 6 : 2) * k;
  const padY = (chip ? 2 : 0) * k;
  const labelInk = e.dashed && e.kind !== 'noteLink' ? c.dependencyLabel : c.labelText;
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
      <path d={d} fill="none" stroke={color} strokeWidth={width} strokeDasharray={dash} strokeLinecap={dash ? 'butt' : 'round'} strokeLinejoin="round" style={{ pointerEvents: 'none' }} />
      {e.violation && <ViolationMark e={e} theme={theme} />}
      {e.edge.double && (
        // Two parallel lines: a wide stroke with the background drawn down its middle.
        <>
          <path d={d} fill="none" stroke={color} strokeWidth={(selected ? 2 : c.lineWidth) * 2 + 3} style={{ pointerEvents: 'none' }} />
          <path d={d} fill="none" stroke={c.background} strokeWidth={3} style={{ pointerEvents: 'none' }} />
        </>
      )}
      {!curve && (
        <g style={{ pointerEvents: 'none' }}>
          {arrowHead(theme, e.head, pts[pts.length - 1]!, pts[pts.length - 2]!, color, selected ? 1.5 : c.lineWidth)}
          {arrowHead(theme, e.tail, pts[0]!, pts[1]!, color, selected ? 1.5 : c.lineWidth)}
        </g>
      )}
      {e.label && (
        <g onPointerDown={ix ? (ev) => ix.onLabelDown(id, ev) : undefined} style={ix ? { cursor: 'move' } : undefined}>
          <rect
            x={f(e.label.x - e.label.text.width / 2 - padX)}
            y={f(e.label.y - e.label.text.height / 2 - padY)}
            width={f(e.label.text.width + padX * 2)}
            height={f(e.label.text.height + padY * 2)}
            rx={chip ? f(Math.min(4 * k, (e.label.text.height + padY * 2) / 2)) : 0}
            fill={c.labelFill}
            fillOpacity={chip ? 1 : 0.85}
            stroke={c.labelStroke !== 'none' ? c.labelStroke : undefined}
          />
          <Text theme={theme} block={e.label.text} cx={e.label.x} top={e.label.y - e.label.text.height / 2} fill={labelInk} weight={chip ? 500 : undefined} quietBrackets={theme.plantuml ? undefined : c.muted} />
        </g>
      )}
      {[e.fromLabel, e.toLabel].map((l, i) => l && <Text key={i} theme={theme} block={l.text} cx={l.x} top={l.y - l.text.height / 2} fill={c.muted} weight={theme.plantuml ? undefined : 500} tabular halo={c.background} />)}
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

/** End handles of the selected line, drawn above the nodes (an end sits on a node's outline, which would catch the pointer). */
function EndHandles({ e, ix }: { e: SceneEdge; ix: Interaction }) {
  const id = e.edge.id;
  const pts = e.points;
  if (pts.length < 2 || !ix.onEndDown) return null;
  return (
    <g className="end-handles" data-end-handles={id}>
      {(['from', 'to'] as const).map((end) => {
        const [x, y] = end === 'from' ? pts[0]! : pts[pts.length - 1]!;
        const fixed = e.fixedEnds?.[end];
        return (
          <circle
            key={end}
            data-end={end}
            cx={f(x)}
            cy={f(y)}
            r={5}
            // Filled: chosen by hand; hollow: automatic.
            fill={fixed ? EDITOR_COLORS.selected : '#FFFFFF'}
            stroke={EDITOR_COLORS.selected}
            strokeWidth={1.5}
            style={{ cursor: 'crosshair' }}
            onPointerDown={(ev) => ix.onEndDown?.(id, end, ev)}
            onDoubleClick={(ev) => ix.onEndDoubleClick?.(id, end, ev)}
            onPointerEnter={() => ix.onEndHover?.(id, end)}
            onPointerLeave={() => ix.onEndHover?.(id, null)}
          >
            <title>{fixed ? 'Drag to move where the line attaches · double-click: back to automatic' : 'Drag along the outline to choose where the line attaches'}</title>
          </circle>
        );
      })}
    </g>
  );
}

/**
 * A dependency that breaks the template's rule: a warning triangle on the
 * line, a third of the way along (the middle is the label's), with the reason
 * as its tooltip.
 */
function ViolationMark({ e, theme }: { e: SceneEdge; theme: Theme }) {
  const [x, y] = pointAt(e.points, e.label ? 0.3 : 0.5);
  const s = 9 * Math.sqrt(theme.scale);
  const c = theme.colors;
  return (
    <g data-violation={e.edge.id} style={{ pointerEvents: 'none' }}>
      <title>{e.violation}</title>
      <path d={`M${f(x)},${f(y - s)} L${f(x + s * 1.05)},${f(y + s * 0.8)} L${f(x - s * 1.05)},${f(y + s * 0.8)} Z`} fill={c.warning} stroke={c.background} strokeWidth={1.5} strokeLinejoin="round" />
      <path d={`M${f(x)},${f(y - s * 0.38)} V${f(y + s * 0.2)}`} stroke={c.background} strokeWidth={1.6 * Math.sqrt(theme.scale)} strokeLinecap="round" />
      <circle cx={f(x)} cy={f(y + s * 0.5)} r={0.95 * Math.sqrt(theme.scale)} fill={c.background} />
    </g>
  );
}

/**
 * Mindmap trees: each topic's level, and for every topic-to-topic line a
 * smooth branch from the parent's side to the child's, thicker near the root.
 * Lines someone bent by hand keep their route.
 */
function mindmapBranches(scene: Scene): { depth: Map<string, number>; curves: Map<string, { d: string; w: number }> } | undefined {
  if (!scene.nodes.some((n) => n.node.kind === 'topic')) return undefined;
  const byId = new Map(scene.nodes.map((n) => [n.node.id, n]));
  const parent = new Map<string, string>();
  for (const e of scene.edges) if (byId.get(e.edge.from)?.node.kind === 'topic' && byId.get(e.edge.to)?.node.kind === 'topic') parent.set(e.edge.to, e.edge.from);
  const depth = new Map<string, number>();
  const level = (id: string, guard = 0): number => {
    const known = depth.get(id);
    if (known !== undefined) return known;
    const p = parent.get(id);
    const d = p && guard < 64 ? level(p, guard + 1) + 1 : 0;
    depth.set(id, d);
    return d;
  };
  for (const n of scene.nodes) if (n.node.kind === 'topic') level(n.node.id);
  const curves = new Map<string, { d: string; w: number }>();
  const lw = scene.theme.colors.lineWidth;
  for (const e of scene.edges) {
    const a = byId.get(e.edge.from);
    const b = byId.get(e.edge.to);
    if (a?.node.kind !== 'topic' || b?.node.kind !== 'topic' || e.via.length) continue;
    if (e.path) {
      const lv = depth.get(b.node.id) ?? 1;
      curves.set(e.edge.id, { d: e.path, w: lv <= 1 ? lw * 2 : lv === 2 ? lw * 1.4 : lw });
      continue;
    }
    const A = a.box;
    const B = b.box;
    const level = depth.get(b.node.id) ?? 1;
    const w = level <= 1 ? lw * 2 : level === 2 ? lw * 1.4 : lw;
    // Side by side (mindmap): horizontal tangents. Stacked (WBS): keep the routed tree lines.
    if (B.x >= A.x + A.w || B.x + B.w <= A.x) {
      const right = B.x >= A.x + A.w;
      const x1 = right ? A.x + A.w : A.x;
      const x2 = right ? B.x : B.x + B.w;
      const y1 = A.y + A.h / 2;
      const y2 = b.node.stereotype === 'boxless' ? B.y + B.h : B.y + B.h / 2;
      const mx = (x1 + x2) / 2;
      curves.set(e.edge.id, { d: `M${f(x1)},${f(y1)} C${f(mx)},${f(y1)} ${f(mx)},${f(y2)} ${f(x2)},${f(y2)}`, w });
    } else curves.set(e.edge.id, { d: roundedPath(e.points, scene.theme.bendRadius), w });
  }
  return { depth, curves };
}

/**
 * The diagram content. Template backdrop and containers first, then edges,
 * then container titles (over the lines), then nodes, so nodes stay grabbable on top.
 */
export function DiagramContent({ scene, ix }: { scene: Scene; ix?: Interaction }) {
  const theme = scene.theme;
  const tree = mindmapBranches(scene);
  const selectedLine = ix?.selectedEdge ? scene.edges.find((e) => e.edge.id === ix.selectedEdge) : undefined;
  // A drawing is painted in the file's order: shapes, then the lines over them (closed days and bars must not hide a dependency).
  const edgeViews = scene.edges.map((e) => {
    const curve = tree?.curves.get(e.edge.id);
    return <EdgeView key={e.edge.id} e={e} theme={theme} ix={ix} selected={ix?.selectedEdge === e.edge.id} curve={curve?.d} weight={curve?.w} />;
  });
  return (
    <g>
      {scene.template && <TemplateBackdrop t={scene.template} theme={theme} />}
      {scene.containers.map((c) => (
        <ContainerView key={c.id} c={c} theme={theme} ix={ix} />
      ))}
      {!scene.drawing && edgeViews}
      {scene.containers.map((c) => (
        <ContainerTitle key={c.id} c={c} theme={theme} />
      ))}
      {scene.nodes.map((n) => (
        <NodeView key={n.node.id} n={n} theme={theme} ix={ix} selected={ix?.selectedNodes.has(n.node.id) ?? false} depth={tree?.depth.get(n.node.id)} />
      ))}
      {scene.drawing && edgeViews}
      {selectedLine && ix && !scene.drawing && <EndHandles e={selectedLine} ix={ix} />}
    </g>
  );
}

/** Standalone, non-interactive SVG for export. With a frame, the canvas has exactly that aspect ratio. */
export function DiagramSvg({ scene, frame, margin = 24 }: { scene: AnyScene; frame?: Point; margin?: number }) {
  const b = scene.bounds;
  const box: Box = frame ? frameRect(b, frame, margin) : { x: b.x - margin, y: b.y - margin, w: b.w + margin * 2, h: b.h + margin * 2 };
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox={`${f(box.x)} ${f(box.y)} ${f(box.w)} ${f(box.h)}`} width={Math.ceil(box.w)} height={Math.ceil(box.h)}>
      <rect x={f(box.x)} y={f(box.y)} width={f(box.w)} height={f(box.h)} fill={scene.theme.colors.background} />
      <AnyContent scene={scene} />
    </svg>
  );
}

/** Renders whichever kind of scene it gets. */
export function AnyContent({ scene, ix }: { scene: AnyScene; ix?: Interaction }) {
  if (scene.kind === 'sequence') return <SequenceContent scene={scene} ix={ix} />;
  if (scene.kind === 'gantt') return <GanttContent scene={scene} ix={ix} />;
  if (scene.kind === 'timing') return <TimingContent scene={scene} ix={ix} />;
  return <DiagramContent scene={scene} ix={ix} />;
}
