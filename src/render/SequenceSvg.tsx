import type { ReactNode } from 'react';
import type { SeqHead } from '../model/types.ts';
import type { SeqMessage, SequenceScene } from '../scene/sequence.ts';
import { accentTint, mix, type Theme } from '../scene/theme.ts';
import { EDITOR_COLORS, NodeView, type Interaction } from './DiagramSvg.tsx';
import { f, Text } from './text.tsx';

/**
 * Sequence diagrams. Messages are the content, so they carry the ink;
 * lifelines are hairlines, activations quiet tinted bars, fragments thin
 * frames with a tab, and autonumbers (modern themes) sit in bubbles so the
 * eye can count down the page.
 */

function head(theme: Theme, kind: SeqHead, x: number, y: number, dir: 1 | -1, color: string, sw: number): ReactNode {
  const k = Math.sqrt(theme.scale);
  const l = (theme.plantuml ? 10 : 9) * k * dir;
  const w = (theme.plantuml ? 4.5 : 3.75) * k;
  switch (kind) {
    case 'arrow':
      return <polygon points={`${f(x)},${f(y)} ${f(x - l)},${f(y - w)} ${f(x - l * 0.78)},${f(y)} ${f(x - l)},${f(y + w)}`} fill={color} stroke={color} strokeWidth={0.5} strokeLinejoin="miter" />;
    case 'open':
      return <polyline points={`${f(x - l)},${f(y - w * 1.1)} ${f(x)},${f(y)} ${f(x - l)},${f(y + w * 1.1)}`} fill="none" stroke={color} strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round" />;
    case 'half':
      return <polyline points={`${f(x - l)},${f(y - w)} ${f(x)},${f(y)}`} fill="none" stroke={color} strokeWidth={sw} strokeLinecap="round" />;
    case 'cross':
      return <path d={`M${f(x - 5 * k)},${f(y - 5 * k)} L${f(x + 5 * k)},${f(y + 5 * k)} M${f(x - 5 * k)},${f(y + 5 * k)} L${f(x + 5 * k)},${f(y - 5 * k)}`} stroke={color} strokeWidth={1.5 * k} strokeLinecap="round" />;
    case 'circle':
      return <circle cx={f(x - 4 * k * dir)} cy={f(y)} r={f(4 * k)} fill={theme.colors.background} stroke={color} strokeWidth={sw} />;
  }
  return null;
}

/** Calls in a stronger ink than the graph lines (they are the story); returns quieter and dashed. */
function messageColour(theme: Theme, dashed: boolean): string {
  const c = theme.colors;
  if (theme.plantuml) return c.line;
  return dashed ? c.dependency : mix(c.line, c.text, 0.35);
}

function Message({ m, theme, selected, ix }: { m: SeqMessage; theme: Theme; selected: boolean; ix?: Interaction }) {
  const c = theme.colors;
  const k = theme.scale;
  const color = selected ? EDITOR_COLORS.selected : messageColour(theme, m.e.dashed);
  const dash = m.e.dashed ? theme.dash.dependency : undefined;
  const w = selected ? 2 : c.lineWidth;
  // The line stops where a filled head begins, so its round cap doesn't show through the tip.
  const inset = m.e.head === 'arrow' ? 5 * Math.sqrt(k) : 0;
  let path: string;
  let tip: ReactNode;
  let tail: ReactNode;
  if (m.self) {
    const h = 18 * k;
    const r = Math.min(6 * k, h / 2);
    path = `M${f(m.x1)},${f(m.y)} H${f(m.x2 - r)} Q${f(m.x2)},${f(m.y)} ${f(m.x2)},${f(m.y + r)} V${f(m.y + h - r)} Q${f(m.x2)},${f(m.y + h)} ${f(m.x2 - r)},${f(m.y + h)} H${f(m.x1 + inset)}`;
    tip = head(theme, m.e.head, m.x1, m.y + h, -1, color, w);
    tail = null;
  } else {
    const dir = m.x2 >= m.x1 ? 1 : -1;
    path = `M${f(m.x1)},${f(m.y)} H${f(m.x2 - inset * dir)}`;
    tip = head(theme, m.e.head, m.x2, m.y, dir, color, w);
    tail = head(theme, m.e.tail, m.x1, m.y, dir === 1 ? -1 : 1, color, w);
  }
  const n = m.number;
  return (
    <g data-edge={m.e.id}>
      {ix && (
        <path d={path} fill="none" stroke="transparent" strokeWidth={12} style={{ cursor: 'pointer' }} onPointerDown={(ev) => ix.onEdgeDown(m.e.id, ev)} />
      )}
      <path d={path} fill="none" stroke={color} strokeWidth={w} strokeDasharray={dash} strokeLinecap={dash ? 'butt' : 'round'} style={{ pointerEvents: 'none' }} />
      {tip}
      {tail}
      {n && (
        <g style={{ pointerEvents: 'none' }}>
          <circle cx={f(n.x)} cy={f(n.y)} r={f(n.r)} fill={m.e.dashed ? c.surface : c.accent} />
          <text x={f(n.x)} y={f(n.y + theme.size.edge * 0.3)} fontFamily={theme.font} fontSize={f(theme.size.edge * 0.82 * 100) / 100} fontWeight={700} textAnchor="middle" fill={m.e.dashed ? c.muted : c.onAccent} style={{ fontVariantNumeric: 'tabular-nums' }}>
            {n.text}
          </text>
        </g>
      )}
      {m.label && (
        <Text
          theme={theme}
          block={m.label.text}
          cx={m.label.x}
          top={m.label.y - m.label.text.height / 2}
          align={m.label.align}
          fill={m.e.dashed ? c.dependencyLabel : c.text}
          weight={theme.plantuml || m.e.dashed ? undefined : 500}
        />
      )}
    </g>
  );
}

/** A fragment / ref tab: the keyword in small bold caps on a quiet tint, with PlantUML's cut corner. */
function Tab({ x, y, label, theme }: { x: number; y: number; label: string; theme: Theme }) {
  const c = theme.colors;
  const k = theme.scale;
  const size = theme.size.edge * (theme.plantuml ? 1 : 0.9);
  const w = label.length * size * (theme.plantuml ? 0.62 : 0.72) + 16 * k;
  const h = size * 1.25 + 6 * k;
  const cut = 6 * k;
  return (
    <>
      <path
        d={`M${f(x)},${f(y)} H${f(x + w)} V${f(y + h - cut)} L${f(x + w - cut)},${f(y + h)} H${f(x)} Z`}
        fill={theme.plantuml ? '#EEEEEE' : c.surface}
        stroke={theme.plantuml ? c.shapeStroke : 'none'}
        strokeLinejoin="round"
      />
      <Text theme={theme} block={{ lines: [label], width: 0, height: size * 1.25, size }} cx={x + 8 * k} top={y + 3 * k} align="start" weight={700} fill={theme.plantuml ? c.text : c.title} caps={!theme.plantuml} />
    </>
  );
}

/** Everything in a sequence scene. Fragments draw over activation bars so their tabs and guards stay readable. Headers are draggable (horizontally) through `ix`. */
export function SequenceContent({ scene, ix }: { scene: SequenceScene; ix?: Interaction }) {
  const theme = scene.theme;
  const c = theme.colors;
  const k = theme.scale;
  const r = Math.min(6 * k, theme.nodeRadius);
  const frame = theme.plantuml ? c.shapeStroke : mix(c.shapeStroke, c.muted, 0.25);
  // Lifelines are cut where a delay sits and drawn dotted across it, instead of painting over the boxes.
  const delays = [...scene.delays].sort((a, b) => a.y0 - b.y0);
  const lifeline = (x: number, y0: number, y1: number) => {
    const parts: ReactNode[] = [];
    let y = y0;
    delays.forEach((d, i) => {
      if (d.y1 <= y || d.y0 >= y1) return;
      parts.push(<path key={`s${i}`} d={`M${f(x)},${f(y)} V${f(Math.max(y, d.y0))}`} />);
      parts.push(<path key={`d${i}`} d={`M${f(x)},${f(Math.max(y, d.y0))} V${f(Math.min(y1, d.y1))}`} strokeDasharray={`${1 * k} ${4 * k}`} strokeLinecap="round" strokeWidth={1.5} />);
      y = Math.min(y1, d.y1);
    });
    parts.push(<path key="end" d={`M${f(x)},${f(y)} V${f(y1)}`} />);
    return parts;
  };
  return (
    <g>
      {scene.boxes.map((b, i) => (
        <g key={`box${i}`}>
          <rect x={f(b.box.x)} y={f(b.box.y)} width={f(b.box.w)} height={f(b.box.h)} rx={f(theme.containerRadius)} fill={c.containerFill === 'none' ? c.surface : c.containerFill} stroke={c.containerStroke} />
          <Text theme={theme} block={b.label} cx={b.box.x + b.box.w / 2} top={b.box.y + 5 * k} weight={600} fill={c.title} caps={theme.containerTitle === 'caps'} />
        </g>
      ))}
      {scene.lifelines.map((l) => (
        <g key={l.id} stroke={theme.plantuml ? c.line : mix(c.grid, c.line, 0.5)} strokeWidth={1} strokeDasharray={theme.plantuml ? `${5 * k} ${4 * k}` : `${4 * k} ${4 * k}`} fill="none">
          {lifeline(l.x, l.y0, l.y1)}
        </g>
      ))}
      {scene.delays.map((d, i) => d.label && <Text key={`delay${i}`} theme={theme} block={d.label} cx={d.x} top={(d.y0 + d.y1) / 2 - d.label.height / 2} fill={c.muted} italic />)}
      {scene.activations.map((a, i) => (
        <rect key={`act${i}`} x={f(a.x)} y={f(a.y)} width={f(a.w)} height={f(a.h)} rx={theme.plantuml ? 0 : f(Math.min(2 * k, a.w / 4))} fill={theme.plantuml ? c.shapeFill : accentTint(theme, 0.1)} stroke={theme.plantuml ? c.shapeStroke : accentTint(theme, 0.35)} />
      ))}
      {scene.groups.map((g, i) => (
        <g key={`group${i}`}>
          <rect x={f(g.box.x)} y={f(g.box.y)} width={f(g.box.w)} height={f(g.box.h)} fill="none" stroke={frame} rx={theme.plantuml ? 0 : f(r)} />
          <Tab x={g.box.x} y={g.box.y} label={g.kind} theme={theme} />
          <Text theme={theme} block={g.label} cx={g.box.x + g.kind.length * theme.size.edge * (theme.plantuml ? 0.62 : 0.65) + 24 * k} top={g.box.y + 3 * k} align="start" weight={theme.plantuml ? 600 : 500} fill={c.muted} />
          {g.elses.map((e, j) => (
            <g key={j}>
              <path d={`M${f(g.box.x)},${f(e.y)} H${f(g.box.x + g.box.w)}`} stroke={frame} strokeDasharray={`${5 * k} ${4 * k}`} />
              {e.label && <Text theme={theme} block={e.label} cx={g.box.x + 10 * k} top={e.y + 3 * k} align="start" weight={theme.plantuml ? 600 : 500} fill={c.muted} />}
            </g>
          ))}
        </g>
      ))}
      {scene.dividers.map((d, i) => (
        <g key={`div${i}`}>
          <path d={`M${f(d.x0)},${f(d.y - 2 * k)} H${f(d.x1)} M${f(d.x0)},${f(d.y + 2 * k)} H${f(d.x1)}`} stroke={theme.plantuml ? c.shapeStroke : c.grid} />
          <rect x={f((d.x0 + d.x1) / 2 - d.label.width / 2 - 10 * k)} y={f(d.y - d.label.height / 2 - 4 * k)} width={f(d.label.width + 20 * k)} height={f(d.label.height + 8 * k)} rx={f(Math.min(r, (d.label.height + 8 * k) / 2))} fill={theme.plantuml ? c.shapeFill : c.surface} stroke={theme.plantuml ? c.shapeStroke : c.grid} />
          <Text theme={theme} block={d.label} cx={(d.x0 + d.x1) / 2} top={d.y - d.label.height / 2} weight={600} fill={theme.plantuml ? c.text : c.title} />
        </g>
      ))}
      {scene.messages.map((m) => (
        <Message key={m.e.id} m={m} theme={theme} ix={ix} selected={ix?.selectedEdge === m.e.id} />
      ))}
      {scene.notes.map((n, i) => (
        <g key={`note${i}`}>
          {theme.noteFold ? (
            <path
              d={`M${f(n.box.x)},${f(n.box.y)} H${f(n.box.x + n.box.w - 8 * k)} L${f(n.box.x + n.box.w)},${f(n.box.y + 8 * k)} V${f(n.box.y + n.box.h)} H${f(n.box.x)} Z M${f(n.box.x + n.box.w - 8 * k)},${f(n.box.y)} V${f(n.box.y + 8 * k)} H${f(n.box.x + n.box.w)}`}
              fill={c.noteFill}
              stroke={c.noteStroke}
              strokeLinejoin="round"
            />
          ) : (
            <>
              <rect x={f(n.box.x)} y={f(n.box.y)} width={f(n.box.w)} height={f(n.box.h)} rx={f(r)} fill={c.noteFill} stroke={c.noteStroke} />
              <path d={`M${f(n.box.x + 0.5)},${f(n.box.y + r)} V${f(n.box.y + n.box.h - r)}`} stroke={mix(c.noteStroke, c.noteText, 0.35)} strokeWidth={2.5 * Math.sqrt(k)} strokeLinecap="round" />
            </>
          )}
          <Text theme={theme} block={n.text} cx={n.box.x + 12 * k} top={n.box.y + 7 * k} align="start" fill={c.noteText} />
        </g>
      ))}
      {scene.refs.map((ref, i) => (
        <g key={`ref${i}`}>
          <rect x={f(ref.box.x)} y={f(ref.box.y)} width={f(ref.box.w)} height={f(ref.box.h)} rx={theme.plantuml ? 0 : f(r)} fill={c.shapeFill} stroke={frame} />
          <Tab x={ref.box.x} y={ref.box.y} label="ref" theme={theme} />
          <Text theme={theme} block={ref.text} cx={ref.box.x + ref.box.w / 2} top={ref.box.y + 20 * k} />
        </g>
      ))}
      {scene.destroys.map((d, i) => (
        <path key={`x${i}`} d={`M${f(d.x - 7 * k)},${f(d.y - 7 * k)} L${f(d.x + 7 * k)},${f(d.y + 7 * k)} M${f(d.x - 7 * k)},${f(d.y + 7 * k)} L${f(d.x + 7 * k)},${f(d.y - 7 * k)}`} stroke={theme.plantuml ? c.text : c.warning} strokeWidth={2 * Math.sqrt(k)} strokeLinecap="round" />
      ))}
      {scene.heads.map((n) => (
        <NodeView key={`h:${n.node.id}`} n={n} theme={theme} ix={ix} selected={ix?.selectedNodes.has(n.node.id) ?? false} />
      ))}
      {scene.feet.map((n) => (
        <NodeView key={`f:${n.node.id}`} n={n} theme={theme} selected={false} />
      ))}
    </g>
  );
}
