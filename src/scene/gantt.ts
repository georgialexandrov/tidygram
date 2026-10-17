import type { LayoutFile } from '../layout/layout-file.ts';
import type { GanttModel, GanttTask, TimingModel, TimingSignal } from '../model/types.ts';
import type { Box } from './containers.ts';
import { measureText, type TextBlock } from './measure.ts';
import { themeOf, type Theme } from './theme.ts';

/**
 * Time-axis layouts. Nothing is placed freely: rows follow the source order
 * and x follows time, so layout.json only contributes size (`view.scale`),
 * gaps (`view.spacing`: day/time width × row height) and the theme.
 */

// ---- Gantt ---------------------------------------------------------------------------------------

export interface GanttScene {
  kind: 'gantt';
  theme: Theme;
  labelWidth: number;
  header: { months: { x: number; w: number; label: TextBlock }[]; days: { x: number; w: number; label?: TextBlock; closed: boolean }[]; height: number };
  rows: { task: GanttTask; y: number; h: number; label: TextBlock; bar: Box; done?: number; indent: number }[];
  sections: { y: number; label: TextBlock }[];
  deps: { from: [number, number]; to: [number, number] }[];
  grid: { x: number; y0: number; y1: number; strong: boolean }[];
  bounds: Box;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function buildGanttScene(model: GanttModel, layout: LayoutFile): GanttScene {
  const theme = themeOf(layout.view);
  const k = theme.scale;
  const [gx, gy] = layout.view?.spacing ?? [1, 1];
  const measure = (t: string, size = theme.size.note, bold = false) => measureText(t, size, bold, theme.widthFactor);
  const total = Math.max(1, ...model.tasks.map((t) => t.start + Math.max(1, t.duration))) + 1;
  // Long projects get narrower days; weekly print scale too.
  const dayW = (model.scale === 'weekly' || total > 120 ? 6 : model.scale === 'monthly' ? 3 : 22) * k * gx;
  const rowH = 28 * k * gy;
  // Tasks under a section are indented under its heading, so the column reads as an outline.
  const indent = model.tasks.some((t) => t.section) ? 12 * k : 0;
  const labelWidth = Math.max(120 * k, ...model.tasks.map((t) => measure(t.name).width + 28 * k + (t.section ? indent : 0)), ...model.tasks.map((t) => (t.section ? measure(t.section.toUpperCase(), theme.size.edge, true).width + 0.08 * theme.size.edge * t.section.length + 28 * k : 0)));
  const x0 = labelWidth;
  const startDate = model.start ? new Date(`${model.start}T00:00:00Z`) : undefined;
  const dateOf = (day: number) => (startDate ? new Date(startDate.getTime() + day * 86_400_000) : undefined);
  const weekday = (day: number) => (startDate ? (startDate.getUTCDay() + day) % 7 : (1 + day) % 7);

  // Header: month band (when dated) and day numbers.
  const months: GanttScene['header']['months'] = [];
  const days: GanttScene['header']['days'] = [];
  const showDays = dayW >= 14 * k;
  for (let d = 0; d < total; d++) {
    const date = dateOf(d);
    const closed = model.closed.includes(weekday(d));
    const label = showDays ? measure(String(date ? date.getUTCDate() : d + 1), theme.size.edge) : undefined;
    days.push({ x: x0 + d * dayW, w: dayW, label, closed });
    if (date && (d === 0 || date.getUTCDate() === 1)) {
      months.push({ x: x0 + d * dayW, w: 0, label: measure(`${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}`, theme.size.edge, true) });
    }
  }
  months.forEach((m, i) => (m.w = (months[i + 1]?.x ?? x0 + total * dayW) - m.x));
  const headerH = (months.length ? 20 * k : 0) + (showDays ? 20 * k : 6 * k);

  // Rows, with a band per section.
  const rows: GanttScene['rows'] = [];
  const sections: GanttScene['sections'] = [];
  let y = headerH + 6 * k;
  let section: string | undefined;
  for (const task of model.tasks) {
    if (task.section !== section && task.section) {
      section = task.section;
      const first = !sections.length;
      sections.push({ y: y + (first ? 6 : 14) * k, label: measure(task.section, theme.size.edge, true) });
      y += (first ? 26 : 34) * k;
    }
    const bx = x0 + task.start * dayW;
    const bh = Math.min(rowH * 0.6, 16 * k * Math.sqrt(gy));
    const bar = task.milestone ? { x: bx - bh / 2, y: y + (rowH - bh) / 2, w: bh, h: bh } : { x: bx + 1, y: y + (rowH - bh) / 2, w: Math.max(4, task.duration * dayW - 2), h: bh };
    const row: GanttScene['rows'][number] = { task, y, h: rowH, label: measure(task.name), bar, indent: task.section ? indent : 0 };
    if (task.completion !== undefined) row.done = task.completion / 100;
    rows.push(row);
    y += rowH;
  }
  const byId = new Map(rows.map((r) => [r.task.id, r]));
  const deps: GanttScene['deps'] = [];
  for (const r of rows) {
    for (const a of r.task.after) {
      const from = byId.get(a);
      if (!from) continue;
      deps.push({ from: [from.bar.x + from.bar.w, from.bar.y + from.bar.h / 2], to: [r.bar.x, r.bar.y + r.bar.h / 2] });
    }
  }
  const grid = days.map((d, i) => ({ x: d.x, y0: headerH, y1: y, strong: !!dateOf(i) && (dateOf(i)!.getUTCDate() === 1 || weekday(i) === 1) }));
  return { kind: 'gantt', theme, labelWidth, header: { months, days, height: headerH }, rows, sections, deps, grid, bounds: { x: 0, y: 0, w: x0 + total * dayW + 10 * k, h: y + 8 * k } };
}

// ---- Timing --------------------------------------------------------------------------------------

export interface TimingScene {
  kind: 'timing';
  theme: Theme;
  labelWidth: number;
  /** x for a time value. */
  scale: { x0: number; px: number };
  lanes: { signal: TimingSignal; y: number; h: number; label: TextBlock; levels?: string[] }[];
  ticks: { x: number; label: TextBlock }[];
  messages: { from: [number, number]; to: [number, number]; label?: TextBlock }[];
  end: number;
  bounds: Box;
}

export function buildTimingScene(model: TimingModel, layout: LayoutFile): TimingScene {
  const theme = themeOf(layout.view);
  const k = theme.scale;
  const [gx, gy] = layout.view?.spacing ?? [1, 1];
  const measure = (t: string, size = theme.size.note, bold = false) => measureText(t, size, bold, theme.widthFactor);
  const labelWidth = Math.max(100 * k, ...model.signals.map((s) => measure(s.label, theme.size.node, true).width + 24 * k));
  const px = ((760 * k) / model.end) * gx;
  const lanes: TimingScene['lanes'] = [];
  let y = 10 * k;
  for (const s of model.signals) {
    const levels = s.kind === 'robust' ? (s.states ?? [...new Set(s.changes.map((c) => c.state))]) : undefined;
    // Robust lanes list their states down the left, so the name sits on its own row above them.
    const h = (s.kind === 'robust' ? Math.max(2, levels!.length) * 18 * k : 30 * k) * gy + 16 * k + (s.kind === 'robust' ? 20 * k : 0);
    const lane: TimingScene['lanes'][number] = { signal: s, y, h, label: measure(s.label, theme.size.node, true) };
    if (levels) lane.levels = levels;
    lanes.push(lane);
    y += h + 10 * k;
  }
  const step = niceStep(model.end / 8);
  const ticks: TimingScene['ticks'] = [];
  for (let t = 0; t <= model.end; t += step) ticks.push({ x: labelWidth + t * px, label: measure(String(t), theme.size.edge) });
  const laneY = new Map(lanes.map((l) => [l.signal.id, l]));
  const messages = model.messages.flatMap((m) => {
    const a = laneY.get(m.from);
    const b = laneY.get(m.to);
    if (!a || !b) return [];
    const out: TimingScene['messages'][number] = { from: [labelWidth + m.fromTime * px, a.y + a.h / 2], to: [labelWidth + m.toTime * px, b.y + b.h / 2] };
    if (m.label) out.label = measure(m.label, theme.size.edge);
    return [out];
  });
  const height = y + 24 * k;
  return { kind: 'timing', theme, labelWidth, scale: { x0: labelWidth, px }, lanes, ticks, messages, end: model.end, bounds: { x: 0, y: 0, w: labelWidth + model.end * px + 20 * k, h: height } };
}

function niceStep(raw: number): number {
  const p = 10 ** Math.floor(Math.log10(Math.max(raw, 1e-9)));
  for (const m of [1, 2, 5, 10]) if (raw <= m * p) return m * p;
  return 10 * p;
}
