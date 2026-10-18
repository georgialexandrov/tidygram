import type { ReactNode } from 'react';
import type { GanttScene, TimingScene } from '../scene/gantt.ts';
import { accentTint, mix, type Theme } from '../scene/theme.ts';
import type { Interaction } from './DiagramSvg.tsx';
import { EDITOR_COLORS } from './DiagramSvg.tsx';
import { f, Text } from './text.tsx';

/**
 * Time-axis charts, drawn as bar-chart craft: the bars are the data and take
 * the accent; structure (week rules, weekend shading, headers) stays in
 * hairlines and tints; numbers are tabular so dates line up.
 */

/** Named colours PlantUML users write in `is colored in X`; anything else passes through. */
const NAMED: Record<string, string> = { orange: '#F59E0B', red: '#EF4444', green: '#22C55E', blue: '#3B82F6', yellow: '#EAB308', purple: '#A855F7', grey: '#9CA3AF', gray: '#9CA3AF', pink: '#EC4899' };
const colour = (c?: string) => (c ? (NAMED[c.toLowerCase()] ?? c) : undefined);
/** Only hex colours can be mixed into tints; named CSS colours are used as given. */
const isHex = (c: string) => /^#[0-9a-f]{3}(?:[0-9a-f]{3})?$/i.test(c);

/** Selection tint for a row or lane, readable on light and dark backgrounds. */
const selectedTint = (theme: Theme) => mix(theme.colors.background, EDITOR_COLORS.selected, 0.1);

export function GanttContent({ scene, ix }: { scene: GanttScene; ix?: Interaction }) {
  const { theme } = scene;
  const c = theme.colors;
  const k = theme.scale;
  const { header } = scene;
  const monthH = header.months.length ? 20 * k : 0;
  const right = scene.bounds.w - 10 * k;
  const bottom = scene.bounds.h - 8 * k;
  const x0 = scene.labelWidth;
  const classic = theme.plantuml;
  return (
    <g>
      {/* Weekends and other closed days: a tint down the whole chart, header included. */}
      {header.days.map((d, i) => (d.closed ? <rect key={`c${i}`} x={f(d.x)} y={f(monthH)} width={f(d.w)} height={f(bottom - monthH)} fill={c.surface} opacity={classic ? 1 : 0.8} /> : null))}
      {/* Week and month rules only: a line per day is noise. */}
      {scene.grid.map((g, i) => (g.strong ? <path key={`g${i}`} d={`M${f(g.x)},${f(g.y0)} V${f(bottom)}`} stroke={c.grid} strokeWidth={1} /> : null))}
      {header.months.map((m, i) => (
        <g key={`m${i}`}>
          <path d={`M${f(m.x)},0 V${f(header.height)}`} stroke={c.grid} strokeWidth={1} />
          <Text theme={theme} block={m.label} cx={m.x + 6 * k} top={3 * k} align="start" weight={600} fill={classic ? c.title : c.text} tabular />
        </g>
      ))}
      {header.days.map((d, i) =>
        d.label ? <Text key={`d${i}`} theme={theme} block={d.label} cx={d.x + d.w / 2} top={monthH + 3 * k} fill={d.closed ? mix(c.muted, c.background, 0.35) : c.muted} tabular /> : null,
      )}
      <path d={`M0,${f(header.height)} H${f(right)}`} stroke={classic ? c.shapeStroke : c.grid} />
      <path d={`M${f(x0)},0 V${f(bottom)}`} stroke={c.grid} />
      {scene.sections.map((s, i) => (
        <g key={`s${i}`}>
          {i > 0 && <path d={`M0,${f(s.y - 6 * k)} H${f(right)}`} stroke={classic ? c.shapeStroke : c.grid} strokeDasharray={classic ? `${4 * k} ${3 * k}` : undefined} />}
          <Text theme={theme} block={s.label} cx={8 * k} top={s.y} align="start" weight={700} fill={c.title} caps={!classic} />
        </g>
      ))}
      {scene.deps.map((d, i) => {
        // Out of the bar's end, down, and into the next bar's start; rounded like every other line.
        const midX = Math.max(d.from[0] + 6 * k, d.to[0] - 6 * k);
        const r = Math.min(4 * k, Math.abs(d.to[1] - d.from[1]) / 2);
        const down = d.to[1] >= d.from[1] ? 1 : -1;
        const path =
          d.to[0] - 6 * k >= d.from[0] + 6 * k && r > 0
            ? `M${f(d.from[0])},${f(d.from[1])} H${f(midX - r)} Q${f(midX)},${f(d.from[1])} ${f(midX)},${f(d.from[1] + r * down)} V${f(d.to[1] - r * down)} Q${f(midX)},${f(d.to[1])} ${f(midX + r)},${f(d.to[1])} H${f(d.to[0] - 4 * k)}`
            : `M${f(d.from[0])},${f(d.from[1])} H${f(midX)} V${f(d.to[1])} H${f(d.to[0] - 4 * k)}`;
        return (
          <g key={`dep${i}`}>
            <path d={path} fill="none" stroke={classic ? c.line : mix(c.line, c.text, 0.2)} strokeWidth={c.lineWidth} strokeLinejoin="round" />
            <polygon points={`${f(d.to[0])},${f(d.to[1])} ${f(d.to[0] - 6 * k)},${f(d.to[1] - 3 * k)} ${f(d.to[0] - 6 * k)},${f(d.to[1] + 3 * k)}`} fill={classic ? c.line : mix(c.line, c.text, 0.2)} />
          </g>
        );
      })}
      {scene.rows.map((r) => {
        const selected = ix?.selectedNodes.has(r.task.id);
        const custom = colour(r.task.color);
        const rx = classic ? 1.5 * k : theme.nodeRadius === 0 ? 0 : Math.min(r.bar.h / 2, 4 * k);
        let bar: ReactNode;
        if (r.task.milestone) {
          const cx = r.bar.x + r.bar.w / 2;
          const cy = r.bar.y + r.bar.h / 2;
          const s = r.bar.h * 0.62;
          bar = <polygon points={`${f(cx)},${f(cy - s)} ${f(cx + s)},${f(cy)} ${f(cx)},${f(cy + s)} ${f(cx - s)},${f(cy)}`} fill={selected ? EDITOR_COLORS.selected : c.text} strokeLinejoin="round" />;
        } else {
          // Solid = done. A task with a completion shows done in full colour and the rest as a tint;
          // a task without one is drawn in the full colour (its progress isn't known, not zero).
          const ink = custom ?? (classic ? c.actorFill : c.accent);
          // A theme's `bar` ink carries the plan; the accent is then only the progress made.
          const plan = custom ?? c.bar ?? ink;
          const tint = isHex(plan) ? mix(plan, c.background, classic ? 0 : 0.72) : plan;
          const partial = r.done !== undefined;
          bar = (
            <>
              <rect x={f(r.bar.x)} y={f(r.bar.y)} width={f(r.bar.w)} height={f(r.bar.h)} rx={f(rx)} fill={partial ? tint : classic ? ink : isHex(plan) ? mix(plan, c.background, 0.15) : plan} stroke={selected ? EDITOR_COLORS.selected : classic ? c.actorStroke : 'none'} strokeWidth={selected ? 2 : 1} />
              {partial && r.done! > 0 && (
                <rect x={f(r.bar.x)} y={f(r.bar.y)} width={f(Math.max(rx * 2, r.bar.w * r.done!))} height={f(r.bar.h)} rx={f(rx)} fill={classic ? (custom ?? c.actorGlyph) : ink} fillOpacity={classic ? 0.55 : 1} />
              )}
              {partial && !classic && r.done! < 1 && (
                <Text theme={theme} block={{ lines: [`${Math.round(r.done! * 100)}%`], width: 0, height: theme.size.edge * 1.25, size: theme.size.edge * 0.9 }} cx={r.bar.x + r.bar.w + 6 * k} top={r.bar.y + r.bar.h / 2 - theme.size.edge * 0.56} align="start" fill={c.muted} weight={500} tabular />
              )}
            </>
          );
        }
        return (
          <g key={r.task.id} data-id={r.task.id} onPointerDown={ix ? (e) => ix.onNodeDown(r.task.id, e) : undefined} style={ix ? { cursor: 'pointer' } : undefined}>
            {selected && <rect x={0} y={f(r.y)} width={f(right)} height={f(r.h)} fill={selectedTint(theme)} />}
            <Text theme={theme} block={r.label} cx={(classic ? 12 : 8) * k + r.indent} top={r.y + r.h / 2 - r.label.height / 2} align="start" fill={r.task.milestone && !classic ? c.muted : c.text} italic={r.task.milestone && !classic} />
            {bar}
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
  const classic = theme.plantuml;
  const X = (t: number) => scene.scale.x0 + t * scene.scale.px;
  const xEnd = X(scene.end);
  const wave = classic ? c.actorGlyph : c.accent;
  const area = mix(c.background, wave, 0.1);
  const sw = 1.5 * Math.sqrt(k);
  return (
    <g>
      {scene.ticks.map((t, i) => (
        <g key={`t${i}`}>
          <path d={`M${f(t.x)},0 V${f(scene.bounds.h - 20 * k)}`} stroke={c.grid} strokeWidth={classic ? 0.5 : 1} strokeDasharray={classic ? undefined : `${2 * k} ${3 * k}`} />
          <Text theme={theme} block={t.label} cx={t.x} top={scene.bounds.h - 16 * k} fill={c.muted} tabular />
        </g>
      ))}
      {scene.lanes.map((lane) => {
        const s = lane.signal;
        const top = lane.y + (s.kind === 'robust' ? 28 : 8) * k;
        const bottom = lane.y + lane.h - 8 * k;
        const selected = ix?.selectedNodes.has(s.id);
        let body: ReactNode = null;
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
                <g key={i}>
                  {!classic && <path d={`M${f(scene.labelWidth)},${f(levelY(l))} H${f(xEnd)}`} stroke={c.grid} strokeDasharray={`${1 * k} ${3 * k}`} />}
                  <text x={f(scene.labelWidth - 6 * k)} y={f(levelY(l) + 3.5 * k)} fontFamily={theme.font} fontSize={theme.size.edge} textAnchor="end" fill={c.muted}>
                    {l}
                  </text>
                </g>
              ))}
              <path d={d} fill="none" stroke={wave} strokeWidth={sw} strokeLinejoin="round" />
            </>
          );
        } else if (s.kind === 'concise') {
          body = changes.map((ch, i) => {
            const x0 = X(ch.time);
            const x1 = i + 1 < changes.length ? X(changes[i + 1]!.time) : xEnd;
            const label = { lines: [ch.state], width: 0, height: theme.size.edge * 1.25, size: theme.size.edge };
            const e = Math.min(4 * k, (x1 - x0) / 3);
            return (
              <g key={i}>
                <polygon points={`${f(x0)},${f((top + bottom) / 2)} ${f(x0 + e)},${f(top)} ${f(x1 - e)},${f(top)} ${f(x1)},${f((top + bottom) / 2)} ${f(x1 - e)},${f(bottom)} ${f(x0 + e)},${f(bottom)}`} fill={classic ? c.actorFill : accentTint(theme, 0.1)} stroke={classic ? c.actorStroke : accentTint(theme, 0.4)} strokeLinejoin="round" />
                <Text theme={theme} block={label} cx={(x0 + x1) / 2} top={(top + bottom) / 2 - label.height / 2} weight={classic ? undefined : 500} />
              </g>
            );
          });
        } else {
          // Clock and binary: the waveform, with the high time filled faintly so duty cycles read at a glance.
          let d = '';
          let fill = '';
          if (s.kind === 'clock') {
            const period = s.period ?? scene.end / 10;
            const pulse = s.pulse ?? period / 2;
            d = `M${f(X(0))},${f(bottom)}`;
            for (let t = 0; t < scene.end; t += period) {
              const a = X(t);
              const b = X(Math.min(t + pulse, scene.end));
              d += ` V${f(top)} H${f(b)} V${f(bottom)} H${f(X(Math.min(t + period, scene.end)))}`;
              fill += `M${f(a)},${f(bottom)} V${f(top)} H${f(b)} V${f(bottom)} Z `;
            }
          } else {
            changes.forEach((ch, i) => {
              const high = ch.state === 'high';
              const y = high ? top : bottom;
              const a = X(ch.time);
              const b = i + 1 < changes.length ? X(changes[i + 1]!.time) : xEnd;
              d += i === 0 ? `M${f(a)},${f(y)}` : ` V${f(y)}`;
              d += ` H${f(b)}`;
              if (high) fill += `M${f(a)},${f(bottom)} V${f(top)} H${f(b)} V${f(bottom)} Z `;
            });
          }
          body = (
            <>
              {!classic && fill && <path d={fill} fill={area} />}
              <path d={d} fill="none" stroke={wave} strokeWidth={sw} strokeLinejoin="round" />
            </>
          );
        }
        return (
          <g key={s.id} data-id={s.id} onPointerDown={ix ? (e) => ix.onNodeDown(s.id, e) : undefined}>
            <rect x={0} y={f(lane.y)} width={f(scene.bounds.w)} height={f(lane.h)} fill={selected ? selectedTint(theme) : 'transparent'} />
            <Text theme={theme} block={lane.label} cx={8 * k} top={lane.y + 4 * k} align="start" weight={600} />
            <path d={`M0,${f(lane.y + lane.h + 5 * k)} H${f(xEnd)}`} stroke={c.grid} />
            {body}
          </g>
        );
      })}
      {scene.messages.map((m, i) => {
        const len = Math.hypot(m.to[0] - m.from[0], m.to[1] - m.from[1]) || 1;
        const ux = (m.to[0] - m.from[0]) / len;
        const uy = (m.to[1] - m.from[1]) / len;
        const l = 8 * Math.sqrt(k);
        const w = 3.5 * Math.sqrt(k);
        const ink = classic ? c.dependency : mix(c.line, c.text, 0.35);
        const label = m.label;
        const lx = (m.from[0] + m.to[0]) / 2 + 30 * k;
        const ly = (m.from[1] + m.to[1]) / 2;
        return (
          <g key={`msg${i}`}>
            <path d={`M${f(m.from[0])},${f(m.from[1])} L${f(m.to[0] - ux * l * 0.7)},${f(m.to[1] - uy * l * 0.7)}`} stroke={ink} strokeWidth={c.lineWidth} />
            <polygon points={`${f(m.to[0])},${f(m.to[1])} ${f(m.to[0] - ux * l + uy * w)},${f(m.to[1] - uy * l - ux * w)} ${f(m.to[0] - ux * l - uy * w)},${f(m.to[1] - uy * l + ux * w)}`} fill={ink} />
            {label && (
              <>
                {!classic && <rect x={f(lx - label.width / 2 - 5 * k)} y={f(ly - label.height / 2 - 1.5 * k)} width={f(label.width + 10 * k)} height={f(label.height + 3 * k)} rx={f(3 * k)} fill={c.labelFill} />}
                <Text theme={theme} block={label} cx={lx} top={ly - label.height / 2} fill={c.dependencyLabel} weight={classic ? undefined : 500} />
              </>
            )}
          </g>
        );
      })}
    </g>
  );
}
