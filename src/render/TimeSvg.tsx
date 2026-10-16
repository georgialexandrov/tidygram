import type { GanttScene, TimingScene } from '../scene/gantt.ts';
import type { Interaction } from './DiagramSvg.tsx';
import { EDITOR_COLORS } from './DiagramSvg.tsx';
import { f, Text } from './text.tsx';

/** Named colours PlantUML users write in `is colored in X`; anything else passes through. */
const NAMED: Record<string, string> = { orange: '#F59E0B', red: '#EF4444', green: '#22C55E', blue: '#3B82F6', yellow: '#EAB308', purple: '#A855F7', grey: '#9CA3AF', gray: '#9CA3AF', pink: '#EC4899' };
const colour = (c?: string) => (c ? (NAMED[c.toLowerCase()] ?? (c.startsWith('#') ? c : c)) : undefined);

export function GanttContent({ scene, ix }: { scene: GanttScene; ix?: Interaction }) {
  const { theme } = scene;
  const c = theme.colors;
  const k = theme.scale;
  const { header } = scene;
  const monthH = header.months.length ? 20 * k : 0;
  return (
    <g>
      {header.days.map((d, i) => (d.closed ? <rect key={`c${i}`} x={f(d.x)} y={f(header.height)} width={f(d.w)} height={f(scene.bounds.h - header.height)} fill={c.containerFill === 'none' ? '#F3F4F6' : c.containerFill} /> : null))}
      {scene.grid.map((g, i) => (
        <path key={`g${i}`} d={`M${f(g.x)},${f(g.y0)} V${f(g.y1)}`} stroke={c.nestedStroke === 'none' ? '#E5E7EB' : c.nestedStroke} strokeWidth={g.strong ? 1 : 0.5} />
      ))}
      {header.months.map((m, i) => (
        <g key={`m${i}`}>
          <path d={`M${f(m.x)},0 V${f(header.height)}`} stroke={c.shapeStroke} strokeWidth={0.75} />
          <Text theme={theme} block={m.label} cx={m.x + 6 * k} top={3 * k} align="start" weight={600} fill={c.title} />
        </g>
      ))}
      {header.days.map((d, i) =>
        d.label ? <Text key={`d${i}`} theme={theme} block={d.label} cx={d.x + d.w / 2} top={monthH + 3 * k} fill={d.closed ? c.muted : c.text} /> : null,
      )}
      <path d={`M0,${f(header.height)} H${f(scene.bounds.w)}`} stroke={c.shapeStroke} />
      {scene.sections.map((s, i) => (
        <g key={`s${i}`}>
          <path d={`M0,${f(s.y + s.label.height + 4 * k)} H${f(scene.bounds.w)}`} stroke={c.shapeStroke} strokeDasharray={`${4 * k} ${3 * k}`} />
          <Text theme={theme} block={s.label} cx={8 * k} top={s.y} align="start" weight={700} fill={c.title} />
        </g>
      ))}
      {scene.deps.map((d, i) => {
        const midX = Math.max(d.from[0] + 6 * k, d.to[0] - 6 * k);
        return (
          <g key={`dep${i}`}>
            <path d={`M${f(d.from[0])},${f(d.from[1])} H${f(midX)} V${f(d.to[1])} H${f(d.to[0])}`} fill="none" stroke={c.line} strokeWidth={c.lineWidth} />
            <polygon points={`${f(d.to[0])},${f(d.to[1])} ${f(d.to[0] - 6 * k)},${f(d.to[1] - 3.5 * k)} ${f(d.to[0] - 6 * k)},${f(d.to[1] + 3.5 * k)}`} fill={c.line} />
          </g>
        );
      })}
      {scene.rows.map((r) => {
        const selected = ix?.selectedNodes.has(r.task.id);
        const stroke = selected ? EDITOR_COLORS.selected : r.task.milestone ? c.text : c.actorStroke;
        const fill = colour(r.task.color) ?? c.actorFill;
        return (
          <g key={r.task.id} data-id={r.task.id} onPointerDown={ix ? (e) => ix.onNodeDown(r.task.id, e) : undefined} style={ix ? { cursor: 'pointer' } : undefined}>
            <Text theme={theme} block={r.label} cx={12 * k} top={r.y + r.h / 2 - r.label.height / 2} align="start" />
            {r.task.milestone ? (
              <polygon
                points={`${f(r.bar.x + r.bar.w / 2)},${f(r.bar.y)} ${f(r.bar.x + r.bar.w)},${f(r.bar.y + r.bar.h / 2)} ${f(r.bar.x + r.bar.w / 2)},${f(r.bar.y + r.bar.h)} ${f(r.bar.x)},${f(r.bar.y + r.bar.h / 2)}`}
                fill={c.text}
                stroke={stroke}
              />
            ) : (
              <>
                <rect x={f(r.bar.x)} y={f(r.bar.y)} width={f(r.bar.w)} height={f(r.bar.h)} rx={theme.name === 'classic' ? 1 : r.bar.h / 3} fill={fill} stroke={stroke} strokeWidth={selected ? 2 : 1} />
                {r.done !== undefined && (
                  <rect x={f(r.bar.x)} y={f(r.bar.y)} width={f(r.bar.w * r.done)} height={f(r.bar.h)} rx={theme.name === 'classic' ? 1 : r.bar.h / 3} fill={colour(r.task.color) ?? c.actorGlyph} fillOpacity={0.55} />
                )}
              </>
            )}
          </g>
        );
      })}
    </g>
  );
}

export function TimingContent({ scene, ix }: { scene: TimingScene; ix?: Interaction }) {
  const { theme } = scene;
  const c = theme.colors;
  const k = theme.scale;
  const X = (t: number) => scene.scale.x0 + t * scene.scale.px;
  const xEnd = X(scene.end);
  return (
    <g>
      {scene.ticks.map((t, i) => (
        <g key={`t${i}`}>
          <path d={`M${f(t.x)},0 V${f(scene.bounds.h - 18 * k)}`} stroke={c.nestedStroke === 'none' ? '#E5E7EB' : c.nestedStroke} strokeWidth={0.5} />
          <Text theme={theme} block={t.label} cx={t.x} top={scene.bounds.h - 16 * k} fill={c.muted} />
        </g>
      ))}
      {scene.lanes.map((lane) => {
        const s = lane.signal;
        const top = lane.y + (s.kind === 'robust' ? 28 : 8) * k;
        const bottom = lane.y + lane.h - 8 * k;
        const selected = ix?.selectedNodes.has(s.id);
        let body: React.ReactNode = null;
        const changes = s.changes.length ? s.changes : [{ time: 0, state: '' }];
        if (s.kind === 'robust') {
          const levels = lane.levels!;
          const levelY = (state: string) => {
            const i = Math.max(0, levels.indexOf(state));
            return top + (levels.length === 1 ? 0 : (i / (levels.length - 1)) * (bottom - top));
          };
          let d = '';
          changes.forEach((ch, i) => {
            const x = X(ch.time);
            const y = levelY(ch.state);
            d += i === 0 ? `M${f(x)},${f(y)}` : ` V${f(y)}`;
            d += ` H${f(i + 1 < changes.length ? X(changes[i + 1]!.time) : xEnd)}`;
          });
          body = (
            <>
              {levels.map((l, i) => (
                <text key={i} x={f(scene.labelWidth - 6 * k)} y={f(levelY(l) + 3 * k)} fontFamily={theme.font} fontSize={theme.size.edge} textAnchor="end" fill={c.muted}>
                  {l}
                </text>
              ))}
              <path d={d} fill="none" stroke={c.actorGlyph} strokeWidth={1.5 * Math.sqrt(k)} />
            </>
          );
        } else if (s.kind === 'concise') {
          body = changes.map((ch, i) => {
            const x0 = X(ch.time);
            const x1 = i + 1 < changes.length ? X(changes[i + 1]!.time) : xEnd;
            const label = { lines: [ch.state], width: 0, height: theme.size.edge * 1.25, size: theme.size.edge };
            return (
              <g key={i}>
                <polygon points={`${f(x0)},${f((top + bottom) / 2)} ${f(x0 + 4 * k)},${f(top)} ${f(x1 - 4 * k)},${f(top)} ${f(x1)},${f((top + bottom) / 2)} ${f(x1 - 4 * k)},${f(bottom)} ${f(x0 + 4 * k)},${f(bottom)}`} fill={c.actorFill} stroke={c.actorStroke} />
                <Text theme={theme} block={label} cx={(x0 + x1) / 2} top={(top + bottom) / 2 - label.height / 2} />
              </g>
            );
          });
        } else if (s.kind === 'clock') {
          const period = s.period ?? scene.end / 10;
          const pulse = s.pulse ?? period / 2;
          let d = `M${f(X(0))},${f(bottom)}`;
          for (let t = 0; t < scene.end; t += period) d += ` V${f(top)} H${f(X(Math.min(t + pulse, scene.end)))} V${f(bottom)} H${f(X(Math.min(t + period, scene.end)))}`;
          body = <path d={d} fill="none" stroke={c.actorGlyph} strokeWidth={1.25 * Math.sqrt(k)} />;
        } else {
          let d = '';
          changes.forEach((ch, i) => {
            const y = ch.state === 'high' ? top : bottom;
            d += i === 0 ? `M${f(X(ch.time))},${f(y)}` : ` V${f(y)}`;
            d += ` H${f(i + 1 < changes.length ? X(changes[i + 1]!.time) : xEnd)}`;
          });
          body = <path d={d} fill="none" stroke={c.actorGlyph} strokeWidth={1.5 * Math.sqrt(k)} />;
        }
        return (
          <g key={s.id} data-id={s.id} onPointerDown={ix ? (e) => ix.onNodeDown(s.id, e) : undefined}>
            <rect x={0} y={f(lane.y)} width={f(scene.bounds.w)} height={f(lane.h)} fill={selected ? '#EEF2FF' : 'transparent'} />
            <Text theme={theme} block={lane.label} cx={8 * k} top={lane.y + 4 * k} align="start" weight={600} />
            <path d={`M${f(scene.labelWidth)},${f(lane.y + lane.h + 5 * k)} H${f(xEnd)}`} stroke={c.nestedStroke === 'none' ? '#E5E7EB' : c.nestedStroke} />
            {body}
          </g>
        );
      })}
      {scene.messages.map((m, i) => (
        <g key={`msg${i}`}>
          <path d={`M${f(m.from[0])},${f(m.from[1])} L${f(m.to[0])},${f(m.to[1])}`} stroke={c.dependency} strokeWidth={c.lineWidth} />
          {m.label && <Text theme={theme} block={m.label} cx={(m.from[0] + m.to[0]) / 2 + 30 * k} top={(m.from[1] + m.to[1]) / 2 - m.label.height / 2} fill={c.dependencyLabel} />}
        </g>
      ))}
    </g>
  );
}
