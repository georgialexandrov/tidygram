import type { ReactNode } from 'react';
import type { SeqHead } from '../model/types.ts';
import type { SeqMessage, SequenceScene } from '../scene/sequence.ts';
import type { Theme } from '../scene/theme.ts';
import { EDITOR_COLORS, NodeView, type Interaction } from './DiagramSvg.tsx';
import { f, Text } from './text.tsx';

function head(theme: Theme, kind: SeqHead, x: number, y: number, dir: 1 | -1, color: string): ReactNode {
  const k = Math.sqrt(theme.scale);
  const l = 10 * k * dir;
  const w = 4.5 * k;
  switch (kind) {
    case 'arrow':
      return <polygon points={`${f(x)},${f(y)} ${f(x - l)},${f(y - w)} ${f(x - l)},${f(y + w)}`} fill={color} stroke={color} strokeLinejoin="round" />;
    case 'open':
      return <polyline points={`${f(x - l)},${f(y - w)} ${f(x)},${f(y)} ${f(x - l)},${f(y + w)}`} fill="none" stroke={color} strokeWidth={theme.colors.lineWidth} strokeLinecap="round" />;
    case 'half':
      return <polyline points={`${f(x - l)},${f(y - w)} ${f(x)},${f(y)}`} fill="none" stroke={color} strokeWidth={theme.colors.lineWidth} />;
    case 'cross':
      return <path d={`M${f(x - 5 * k)},${f(y - 5 * k)} L${f(x + 5 * k)},${f(y + 5 * k)} M${f(x - 5 * k)},${f(y + 5 * k)} L${f(x + 5 * k)},${f(y - 5 * k)}`} stroke={color} strokeWidth={1.5 * k} />;
    case 'circle':
      return <circle cx={f(x - 4 * k * dir)} cy={f(y)} r={4 * k} fill={theme.colors.background} stroke={color} />;
  }
  return null;
}

function Message({ m, theme, selected, ix }: { m: SeqMessage; theme: Theme; selected: boolean; ix?: Interaction }) {
  const c = theme.colors;
  const k = theme.scale;
  const color = selected ? EDITOR_COLORS.selected : m.e.dashed ? c.dependency : c.line;
  const dash = m.e.dashed ? theme.dash.dependency : undefined;
  const w = selected ? 2 : c.lineWidth;
  let path: string;
  let tip: ReactNode;
  let tail: ReactNode;
  if (m.self) {
    const h = 18 * k;
    path = `M${f(m.x1)},${f(m.y)} H${f(m.x2)} V${f(m.y + h)} H${f(m.x1)}`;
    tip = head(theme, m.e.head, m.x1, m.y + h, -1, color);
    tail = null;
  } else {
    const dir = m.x2 >= m.x1 ? 1 : -1;
    path = `M${f(m.x1)},${f(m.y)} H${f(m.x2)}`;
    tip = head(theme, m.e.head, m.x2, m.y, dir, color);
    tail = head(theme, m.e.tail, m.x1, m.y, dir === 1 ? -1 : 1, color);
  }
  return (
    <g data-edge={m.e.id}>
      {ix && (
        <path d={path} fill="none" stroke="transparent" strokeWidth={12} style={{ cursor: 'pointer' }} onPointerDown={(ev) => ix.onEdgeDown(m.e.id, ev)} />
      )}
      <path d={path} fill="none" stroke={color} strokeWidth={w} strokeDasharray={dash} style={{ pointerEvents: 'none' }} />
      {tip}
      {tail}
      {m.label && (
        <Text
          theme={theme}
          block={m.label.text}
          cx={m.label.x}
          top={m.label.y - m.label.text.height / 2}
          align={m.label.align}
          fill={m.e.dashed ? c.dependencyLabel : c.text}
        />
      )}
    </g>
  );
}

/** Everything in a sequence scene. Headers are draggable (horizontally) through `ix`. */
export function SequenceContent({ scene, ix }: { scene: SequenceScene; ix?: Interaction }) {
  const theme = scene.theme;
  const c = theme.colors;
  const k = theme.scale;
  const note = (box: { x: number; y: number; w: number; h: number }) => (
    <rect x={f(box.x)} y={f(box.y)} width={f(box.w)} height={f(box.h)} rx={theme.noteFold ? 0 : 6 * k} fill={c.noteFill} stroke={c.noteStroke} />
  );
  return (
    <g>
      {scene.boxes.map((b, i) => (
        <g key={`box${i}`}>
          <rect x={f(b.box.x)} y={f(b.box.y)} width={f(b.box.w)} height={f(b.box.h)} rx={theme.containerRadius} fill={c.containerFill === 'none' ? '#F5F7FA' : c.containerFill} stroke={c.containerStroke} />
          <Text theme={theme} block={b.label} cx={b.box.x + b.box.w / 2} top={b.box.y + 4 * k} weight={600} fill={c.title} />
        </g>
      ))}
      {scene.lifelines.map((l) => (
        <path key={l.id} d={`M${f(l.x)},${f(l.y0)} V${f(l.y1)}`} stroke={c.line} strokeWidth={1} strokeDasharray={`${5 * k} ${4 * k}`} />
      ))}
      {scene.delays.map((d, i) => (
        <g key={`delay${i}`}>
          <rect x={f(d.x - 2000)} y={f(d.y0)} width={4000} height={f(d.y1 - d.y0)} fill={c.background} fillOpacity={0.7} />
          {d.label && <Text theme={theme} block={d.label} cx={d.x} top={(d.y0 + d.y1) / 2 - d.label.height / 2} fill={c.muted} italic />}
        </g>
      ))}
      {scene.activations.map((a, i) => (
        <rect key={`act${i}`} x={f(a.x)} y={f(a.y)} width={f(a.w)} height={f(a.h)} fill={c.shapeFill} stroke={c.shapeStroke} />
      ))}
      {scene.groups.map((g, i) => {
        const kind = { lines: [g.kind], width: 0, height: theme.size.edge * 1.25, size: theme.size.edge };
        const tabW = g.kind.length * theme.size.edge * 0.62 + 18 * k;
        return (
          <g key={`group${i}`}>
            <rect x={f(g.box.x)} y={f(g.box.y)} width={f(g.box.w)} height={f(g.box.h)} fill="none" stroke={c.containerStroke === 'none' ? c.line : c.shapeStroke} rx={theme.name === 'classic' ? 0 : 6 * k} />
            <path
              d={`M${f(g.box.x)},${f(g.box.y)} H${f(g.box.x + tabW)} V${f(g.box.y + 12 * k)} L${f(g.box.x + tabW - 6 * k)},${f(g.box.y + 18 * k)} H${f(g.box.x)} Z`}
              fill={c.containerFill === 'none' ? '#EEEEEE' : c.actorFill}
              stroke={c.shapeStroke}
            />
            <Text theme={theme} block={kind} cx={g.box.x + 8 * k} top={g.box.y + 2 * k} align="start" weight={700} fill={c.text} />
            <Text theme={theme} block={g.label} cx={g.box.x + tabW + 8 * k} top={g.box.y + 3 * k} align="start" weight={600} fill={c.muted} />
            {g.elses.map((e, j) => (
              <g key={j}>
                <path d={`M${f(g.box.x)},${f(e.y)} H${f(g.box.x + g.box.w)}`} stroke={c.shapeStroke} strokeDasharray={`${5 * k} ${4 * k}`} />
                {e.label && <Text theme={theme} block={e.label} cx={g.box.x + 10 * k} top={e.y + 3 * k} align="start" weight={600} fill={c.muted} />}
              </g>
            ))}
          </g>
        );
      })}
      {scene.dividers.map((d, i) => (
        <g key={`div${i}`}>
          <path d={`M${f(d.x0)},${f(d.y - 2 * k)} H${f(d.x1)} M${f(d.x0)},${f(d.y + 2 * k)} H${f(d.x1)}`} stroke={c.shapeStroke} />
          <rect x={f((d.x0 + d.x1) / 2 - d.label.width / 2 - 10 * k)} y={f(d.y - d.label.height / 2 - 4 * k)} width={f(d.label.width + 20 * k)} height={f(d.label.height + 8 * k)} rx={4 * k} fill={c.shapeFill} stroke={c.shapeStroke} />
          <Text theme={theme} block={d.label} cx={(d.x0 + d.x1) / 2} top={d.y - d.label.height / 2} weight={600} />
        </g>
      ))}
      {scene.messages.map((m) => (
        <Message key={m.e.id} m={m} theme={theme} ix={ix} selected={ix?.selectedEdge === m.e.id} />
      ))}
      {scene.notes.map((n, i) => (
        <g key={`note${i}`}>
          {note(n.box)}
          <Text theme={theme} block={n.text} cx={n.box.x + 12 * k} top={n.box.y + 7 * k} align="start" fill={c.noteText} />
        </g>
      ))}
      {scene.refs.map((r, i) => (
        <g key={`ref${i}`}>
          <rect x={f(r.box.x)} y={f(r.box.y)} width={f(r.box.w)} height={f(r.box.h)} fill={c.shapeFill} stroke={c.shapeStroke} />
          <path d={`M${f(r.box.x)},${f(r.box.y + 16 * k)} H${f(r.box.x + 30 * k)} L${f(r.box.x + 36 * k)},${f(r.box.y + 10 * k)} V${f(r.box.y)}`} fill="none" stroke={c.shapeStroke} />
          <text x={f(r.box.x + 5 * k)} y={f(r.box.y + 12 * k)} fontFamily={theme.font} fontSize={theme.size.edge} fontWeight={700} fill={c.text}>
            ref
          </text>
          <Text theme={theme} block={r.text} cx={r.box.x + r.box.w / 2} top={r.box.y + 20 * k} />
        </g>
      ))}
      {scene.destroys.map((d, i) => (
        <path key={`x${i}`} d={`M${f(d.x - 8 * k)},${f(d.y - 8 * k)} L${f(d.x + 8 * k)},${f(d.y + 8 * k)} M${f(d.x - 8 * k)},${f(d.y + 8 * k)} L${f(d.x + 8 * k)},${f(d.y - 8 * k)}`} stroke={c.text} strokeWidth={2 * k} />
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
