import type { Diagram, GanttModel, GanttTask, ParseWarning } from './types.ts';
import { unescape, type Line } from './puml-util.ts';

/**
 * PlantUML Gantt charts: tasks with durations, start/end constraints on
 * other tasks or dates, milestones, completion, colours, `->` dependencies,
 * `then`, sections (`-- Phase --`) and closed weekdays. Scheduling resolves
 * constraints into calendar-day offsets from the project start.
 */

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

interface Draft {
  task: GanttTask;
  /** Unresolved constraints, applied by `schedule`. */
  startRef?: { task: string; at: 'start' | 'end'; offset: number };
  endRef?: { task: string; at: 'start' | 'end'; offset: number };
  startDate?: string;
  endDate?: string;
  durationDays?: number;
}

const DATE = String.raw`(\d{4})[-/](\d{1,2})[-/](\d{1,2})`;

export function parseGantt(lines: Line[]): { diagram: Diagram; warnings: ParseWarning[] } {
  const warnings: ParseWarning[] = [];
  const drafts = new Map<string, Draft>();
  const aliases = new Map<string, string>();
  const closed = new Set<number>();
  let start: string | undefined;
  let section: string | undefined;
  let previous: string | undefined;
  let scale: GanttModel['scale'] = 'daily';

  const taskRef = (name: string) => aliases.get(name) ?? name;
  const draft = (name: string, line: number): Draft => {
    const id = taskRef(name);
    let d = drafts.get(id);
    if (!d) {
      d = { task: { id, name: unescape(name), start: 0, duration: 1, milestone: false, after: [], line } };
      if (section) d.task.section = section;
      drafts.set(id, d);
    }
    return d;
  };

  for (const { no, raw, text } of lines) {
    if (!text || text.startsWith("'") || text.startsWith('@') || text.startsWith('!')) continue;
    let m: RegExpExecArray | null;
    if ((m = new RegExp(`^project\\s+starts?\\s+(?:the\\s+|on\\s+)?${DATE}$`, 'i').exec(text))) {
      start = `${m[1]}-${m[2]!.padStart(2, '0')}-${m[3]!.padStart(2, '0')}`;
      continue;
    }
    if ((m = /^(\w+)s?\s+(?:are|is)\s+closed$/i.exec(text))) {
      const day = WEEKDAYS.indexOf(m[1]!.toLowerCase().replace(/s$/, ''));
      if (day >= 0) closed.add(day);
      continue;
    }
    if ((m = /^printscale\s+(daily|weekly|monthly)/i.exec(text)) || (m = /^projectscale\s+(daily|weekly|monthly)/i.exec(text))) {
      scale = m[1]!.toLowerCase() as GanttModel['scale'];
      continue;
    }
    if ((m = /^--\s*(.*?)\s*--$/.exec(text))) {
      section = unescape(m[1]!);
      continue;
    }
    if (/^(language|today|hide|show|title|header|footer|caption|legend|skinparam|scale|<style>|saturday|sunday|\d{4}[-/]\d)/i.test(text)) continue;

    // [A] -> [B]   (B starts when A ends)
    if ((m = /^\[([^\]]+)\]\s*->\s*\[([^\]]+)\]$/.exec(text))) {
      const b = draft(m[2]!, no);
      const a = taskRef(m[1]!);
      b.startRef = { task: a, at: 'end', offset: 0 };
      b.task.after.push(a);
      continue;
    }

    // [Task] (as [Alias]) (on {Resource}) clause and clause ...    |    then [Task] ...
    if ((m = /^(then\s+)?\[([^\]]+)\](?:\s+as\s+\[([^\]]+)\])?(?:\s+on\s+((?:\{[^}]+\}\s*)+))?\s+(.+)$/i.exec(text))) {
      const name = m[2]!;
      if (m[3]) aliases.set(m[3], name);
      const d = draft(name, no);
      if (m[4]) d.task.resources = [...m[4].matchAll(/\{([^}:]+)/g)].map((r) => r[1]!.trim());
      if (m[1] && previous) {
        d.startRef = { task: previous, at: 'end', offset: 0 };
        d.task.after.push(previous);
      }
      for (const clause of m[5]!.split(/\s+and\s+/i)) {
        let c: RegExpExecArray | null;
        if ((c = /^(?:lasts|requires)\s+(\d+)\s*(day|days|week|weeks)$/i.exec(clause))) {
          d.durationDays = Number(c[1]) * (/week/i.test(c[2]!) ? 7 : 1);
        } else if ((c = /^(starts|ends|happens)\s+(?:(\d+)\s*days?\s+(after|before)\s+)?(?:at\s+|after\s+)?\[([^\]]+)\]'s\s+(end|start)$/i.exec(clause))) {
          const ref = { task: taskRef(c[4]!), at: c[5]!.toLowerCase() as 'start' | 'end', offset: (c[2] ? Number(c[2]) : 0) * (c[3]?.toLowerCase() === 'before' ? -1 : 1) };
          if (c[1]!.toLowerCase() === 'ends') d.endRef = ref;
          else d.startRef = ref;
          if (c[1]!.toLowerCase() === 'happens') d.task.milestone = true;
          if (!d.task.after.includes(ref.task)) d.task.after.push(ref.task);
        } else if ((c = new RegExp(`^(starts|ends|happens)\\s+(?:at\\s+|on\\s+|the\\s+)?${DATE}$`, 'i').exec(clause))) {
          const date = `${c[2]}-${c[3]!.padStart(2, '0')}-${c[4]!.padStart(2, '0')}`;
          if (c[1]!.toLowerCase() === 'ends') d.endDate = date;
          else d.startDate = date;
          if (c[1]!.toLowerCase() === 'happens') d.task.milestone = true;
        } else if ((c = /^is\s+(\d+)%\s*complete(?:d)?$/i.exec(clause))) {
          d.task.completion = Number(c[1]);
        } else if ((c = /^is\s+colou?red\s+in\s+([#\w]+)/i.exec(clause))) {
          d.task.color = c[1]!;
        } else if (/^(displays on same row as|is deleted|links to|pauses|is closed)/i.test(clause)) {
          // layout hints and calendar details we don't draw
        } else {
          warnings.push({ line: no, text: raw, message: `Unsupported clause "${clause}"` });
        }
      }
      previous = d.task.id;
      continue;
    }

    warnings.push({ line: no, text: raw, message: 'Unsupported line, ignored' });
  }

  const tasks = schedule([...drafts.values()], start, closed);
  const model: GanttModel = { type: 'gantt', tasks, closed: [...closed].sort(), scale };
  if (start) model.start = start;
  return { diagram: { family: 'description', direction: 'LR', nodes: [], containers: [], edges: [], special: model }, warnings };
}

function dayOffset(start: string | undefined, date: string): number {
  if (!start) return 0;
  return Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000);
}

/** Resolves constraints to calendar-day offsets. Closed weekdays don't count toward durations. */
function schedule(drafts: Draft[], start: string | undefined, closed: Set<number>): GanttTask[] {
  const startDay = start ? new Date(`${start}T00:00:00Z`).getUTCDay() : 1;
  const isClosed = (day: number) => closed.size > 0 && closed.has((((startDay + day) % 7) + 7) % 7);
  const nextOpen = (day: number) => {
    let d = day;
    for (let i = 0; i < 14 && isClosed(d); i++) d++;
    return d;
  };
  /** Calendar span covering `work` working days from `day`. */
  const span = (day: number, work: number) => {
    let d = day;
    let left = work;
    while (left > 0) {
      if (!isClosed(d)) left--;
      d++;
    }
    return d - day;
  };
  const byId = new Map(drafts.map((d) => [d.task.id, d]));
  const end = (t: GanttTask) => t.start + t.duration;
  // Constraints usually point backwards, but a few passes settle forward references too.
  for (let pass = 0; pass < 8; pass++) {
    let changed = false;
    for (const d of drafts) {
      const t = d.task;
      let s = t.start;
      if (d.startDate) s = dayOffset(start, d.startDate);
      else if (d.startRef) {
        const ref = byId.get(d.startRef.task)?.task;
        if (ref) s = (d.startRef.at === 'end' ? end(ref) : ref.start) + d.startRef.offset;
      }
      if (!t.milestone) s = nextOpen(s);
      let duration = t.milestone ? 0 : span(s, d.durationDays ?? 1);
      if (d.endDate) duration = Math.max(1, dayOffset(start, d.endDate) - s + 1);
      else if (d.endRef && d.durationDays === undefined) {
        const ref = byId.get(d.endRef.task)?.task;
        if (ref) duration = Math.max(1, (d.endRef.at === 'end' ? end(ref) : ref.start) + d.endRef.offset - s);
      }
      if (s !== t.start || duration !== t.duration) {
        t.start = s;
        t.duration = duration;
        changed = true;
      }
    }
    if (!changed) break;
  }
  return drafts.map((d) => d.task);
}
