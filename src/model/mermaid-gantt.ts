import type { GanttModel, ParseWarning } from './types.ts';
import type { ParseResult } from './parse.ts';
import type { Line } from './puml-util.ts';
import { schedule, type Draft } from './puml-gantt.ts';
import { mmdText } from './mermaid-util.ts';

/**
 * Mermaid Gantt charts onto the PlantUML Gantt model and its scheduler:
 * `dateFormat`, sections, `excludes weekends`/weekday names, tasks written
 * `Name :tags, id, start, end` where start is a date or `after a b` and end
 * is a date, a duration (`3d`, `2w`, `36h`) or `until x`; done/crit/
 * milestone tags. As in Mermaid, end dates are exclusive unless
 * `inclusiveEndDates` is set, and a task with no start follows the previous one.
 */

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const TAGS = new Set(['done', 'active', 'crit', 'milestone']);

/** A dateFormat like `DD-MM-YYYY` as a regex yielding year, month, day. */
function dateReader(format: string): (text: string) => string | undefined {
  const order: ('y' | 'yy' | 'm' | 'd')[] = [];
  const re = format.replace(/YYYY|YY|MM|M|Do|DD|D|HH|H|hh|h|mm|m|SSS|ss|s|A|a|[.*+?^${}()|[\]\\]/g, (tok) => {
    const field = ({ YYYY: 'y', YY: 'yy', MM: 'm', M: 'm', DD: 'd', D: 'd', Do: 'd' } as const)[tok as 'YYYY'];
    if (field) {
      order.push(field);
      return field === 'y' ? '(\\d{4})' : field === 'yy' ? '(\\d{2})' : field === 'd' ? '(\\d{1,2})(?:st|nd|rd|th)?' : '(\\d{1,2})';
    }
    if (/^[HhmsSaA]+$/.test(tok)) return '[\\dAPMapm]+';
    return `\\${tok}`;
  });
  const full = new RegExp(`^${re}$`);
  return (text) => {
    const m = full.exec(text.trim());
    if (!m) return undefined;
    let y = 1970;
    let mo = 1;
    let d = 1;
    order.forEach((what, i) => {
      const v = Number(m[i + 1]);
      if (what === 'y') y = v;
      else if (what === 'yy') y = 2000 + v;
      else if (what === 'm') mo = v;
      else d = v;
    });
    return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  };
}

/** `3d`, `2w`, `36h`, `1.5d` in working days; hours round up to whole days. */
function duration(text: string): number | undefined {
  const m = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d|w)$/.exec(text.trim());
  if (!m) return undefined;
  const n = Number(m[1]);
  const days = { ms: n / 86_400_000, s: n / 86_400, m: n / 1440, h: n / 24, d: n, w: n * 7 }[m[2] as 'd'];
  return Math.ceil(days - 1e-9);
}

const addDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

export function parseMermaidGantt(lines: Line[]): ParseResult {
  const warnings: ParseWarning[] = [];
  const drafts: Draft[] = [];
  const closed = new Set<number>();
  let readDate = dateReader('YYYY-MM-DD');
  let inclusive = false;
  let section: string | undefined;
  let scale: GanttModel['scale'] = 'daily';
  let weekend = [6, 0];
  let excludesWeekends = false;
  /** Raw end dates, resolved once we know whether ends are inclusive. */
  const endDates = new Map<Draft, string>();
  const ids = new Map<string, number>();

  for (const { no, raw, text } of lines) {
    let m: RegExpExecArray | null;
    if ((m = /^dateFormat\s+(.+)$/i.exec(text))) {
      readDate = dateReader(m[1]!.trim());
      continue;
    }
    if (/^inclusiveEndDates$/i.test(text)) {
      inclusive = true;
      continue;
    }
    if ((m = /^tickInterval\s+\d*\s*(day|week|month)/i.exec(text))) {
      scale = m[1]!.toLowerCase() === 'week' ? 'weekly' : m[1]!.toLowerCase() === 'month' ? 'monthly' : 'daily';
      continue;
    }
    if ((m = /^weekend\s+(friday|saturday)$/i.exec(text))) {
      weekend = m[1]!.toLowerCase() === 'friday' ? [5, 6] : [6, 0];
      continue;
    }
    if ((m = /^excludes\s+(.+)$/i.exec(text))) {
      for (const part of m[1]!.split(/[\s,]+/).filter(Boolean)) {
        const day = WEEKDAYS.indexOf(part.toLowerCase());
        if (part.toLowerCase() === 'weekends') excludesWeekends = true;
        else if (day >= 0) closed.add(day);
        else warnings.push({ line: no, text: raw, message: `Excluded date "${part}" is not drawn` });
      }
      continue;
    }
    if (/^(title|axisFormat|todayMarker|includes|topAxis|displayMode|accTitle|accDescr|click|weekday)\b/i.test(text)) continue;
    if ((m = /^section\s+(.*)$/i.exec(text))) {
      section = mmdText(m[1]!);
      continue;
    }

    const task = /^(.+?)\s*:\s*(.+)$/.exec(text);
    if (task) {
      const items = task[2]!.split(',').map((s) => s.trim()).filter(Boolean);
      const tags = new Set<string>();
      while (items.length > 1 && TAGS.has(items[0]!)) tags.add(items.shift()!);
      if (items.length === 1 && TAGS.has(items[0]!)) tags.add(items.shift()!);
      const isStart = (s: string) => /^after\s/.test(s) || readDate(s) !== undefined;
      let id: string | undefined;
      let start: string | undefined;
      let end: string | undefined;
      if (items.length >= 3) [id, start, end] = items;
      else if (items.length === 2) {
        if (isStart(items[0]!)) [start, end] = items;
        else [id, end] = items;
      } else [end] = items;

      const name = mmdText(task[1]!);
      const base = id ?? name;
      const n = (ids.get(base) ?? 0) + 1;
      ids.set(base, n);
      const d: Draft = { task: { id: n === 1 ? base : `${base}#${n}`, name, start: 0, duration: 1, milestone: tags.has('milestone'), after: [], line: no } };
      if (section) d.task.section = section;
      if (tags.has('done')) d.task.completion = 100;
      if (tags.has('crit')) d.task.color = 'red';

      const previous = drafts[drafts.length - 1];
      if (start?.startsWith('after ')) {
        d.startAfter = start.slice(6).trim().split(/\s+/);
        d.task.after.push(...d.startAfter);
      } else if (start) {
        const date = readDate(start);
        if (date) d.startDate = date;
        else warnings.push({ line: no, text: raw, message: `Start "${start}" not understood` });
      } else if (previous) d.startRef = { task: previous.task.id, at: 'end', offset: 0 };

      if (end !== undefined) {
        const until = /^until\s+(\S+)/.exec(end);
        const days = duration(end);
        const date = readDate(end);
        if (until) d.endRef = { task: until[1]!, at: 'start', offset: 0 };
        else if (days !== undefined) d.durationDays = days;
        else if (date) endDates.set(d, date);
        else warnings.push({ line: no, text: raw, message: `End "${end}" not understood` });
      }
      if (d.task.milestone) d.durationDays = 0;
      drafts.push(d);
      continue;
    }

    warnings.push({ line: no, text: raw, message: 'Unsupported line, ignored' });
  }

  if (excludesWeekends) for (const day of weekend) closed.add(day);
  for (const [d, date] of endDates) d.endDate = inclusive ? date : addDays(date, -1);
  const dates = drafts.flatMap((d) => (d.startDate ? [d.startDate] : []));
  const start = dates.sort()[0];
  const tasks = schedule(drafts, start, closed);
  const model: GanttModel = { type: 'gantt', tasks, closed: [...closed].sort(), scale };
  if (start) model.start = start;
  return { diagram: { family: 'description', direction: 'LR', nodes: [], containers: [], edges: [], special: model }, warnings };
}
