import type { IdMap } from '../src/convert/index.ts';
import type { Diagram, GanttModel, SequenceModel, TimingModel } from '../src/model/types.ts';
import { addDays, DEFAULT_GANTT_START } from '../src/convert/plantuml.ts';

/**
 * What changed between a diagram and its converted-and-re-read twin, as
 * sorted category strings ("node kind usecase→attribute", "edge head
 * triangle→arrow", ...). Categories, not counts, so the expected-loss table
 * in the test stays readable and doesn't churn with fixture edits.
 */
export function differences(a: Diagram, b: Diagram, ids: IdMap): string[] {
  const out = new Set<string>();
  const sa = a.special;
  const sb = b.special;
  if (sa || sb) {
    if (sa?.type !== sb?.type) return [`type ${sa?.type ?? 'graph'}→${sb?.type ?? 'graph'}`];
    if (sa!.type === 'sequence') sequenceDiffs(sa as SequenceModel, sb as SequenceModel, ids, out);
    if (sa!.type === 'gantt') ganttDiffs(sa as GanttModel, sb as GanttModel, ids, out);
    if (sa!.type === 'timing') timingDiffs(sa as TimingModel, sb as TimingModel, ids, out);
    return [...out].sort();
  }
  if (a.nodes.length !== b.nodes.length) out.add('count nodes');
  if (a.containers.length !== b.containers.length) out.add('count containers');
  if (a.edges.length !== b.edges.length) out.add('count edges');
  const nodes = new Map(b.nodes.map((n) => [n.id, n]));
  const containers = new Map(b.containers.map((c) => [c.id, c]));
  const edges = new Map(b.edges.map((e) => [e.id, e]));
  const parentOf = (p: string | undefined) => (p === undefined ? undefined : ids.nodes[p]);
  for (const c of a.containers) {
    const d = containers.get(ids.nodes[c.id] ?? '');
    if (!d) {
      out.add('container lost');
      continue;
    }
    if (d.label !== c.label) out.add('container label');
    if (d.parent !== parentOf(c.parent)) out.add('container parent');
  }
  for (const n of a.nodes) {
    const m = nodes.get(ids.nodes[n.id] ?? '');
    if (!m) {
      out.add('node lost');
      continue;
    }
    if (m.kind !== n.kind) out.add(`node kind ${n.kind}→${m.kind}`);
    if (m.label !== n.label) out.add('node label');
    if (m.parent !== parentOf(n.parent)) out.add('node parent');
    if (n.kind === 'class' && m.kind === 'class' && (m.classKind ?? 'class') !== (n.classKind ?? 'class')) out.add(`class kind ${n.classKind}→${m.classKind}`);
    if (JSON.stringify((n.compartments ?? []).flat()) !== JSON.stringify((m.compartments ?? []).flat())) out.add('members');
    if ((n.stereotype ?? '') !== (m.stereotype ?? '')) out.add('stereotype');
    if (JSON.stringify(n.description ?? []) !== JSON.stringify(m.description ?? [])) out.add('description');
  }
  for (const e of a.edges) {
    const f = edges.get(ids.edges[e.id] ?? '');
    if (!f) {
      out.add('edge lost');
      continue;
    }
    if (f.from !== ids.nodes[e.from] || f.to !== ids.nodes[e.to]) out.add('edge ends');
    if (f.head !== e.head) out.add(`edge head ${e.head}→${f.head}`);
    if (f.tail !== e.tail) out.add(`edge tail ${e.tail}→${f.tail}`);
    if (f.dashed !== e.dashed) out.add('edge dashed');
    if (f.hidden !== e.hidden) out.add('edge hidden');
    if ((f.label ?? '') !== (e.label ?? '')) out.add('edge label');
    if ((f.fromLabel ?? '') !== (e.fromLabel ?? '') || (f.toLabel ?? '') !== (e.toLabel ?? '')) out.add('edge end labels');
    if (f.kind !== e.kind) out.add(`edge kind ${e.kind}→${f.kind}`);
  }
  return [...out].sort();
}

function sequenceDiffs(a: SequenceModel, b: SequenceModel, ids: IdMap, out: Set<string>) {
  if (a.participants.length !== b.participants.length) out.add('count participants');
  const order = (m: SequenceModel) => m.participants.map((p) => p.id).join(',');
  if (order(b) !== a.participants.map((p) => ids.nodes[p.id]).join(',')) out.add('participant order');
  for (const p of a.participants) {
    const q = b.participants.find((x) => x.id === ids.nodes[p.id]);
    if (!q) {
      out.add('participant lost');
      continue;
    }
    if (q.kind !== p.kind) out.add(`participant kind ${p.kind}→${q.kind}`);
    if (q.label !== p.label) out.add('participant label');
  }
  const messages = (m: SequenceModel) => m.events.filter((e) => e.type === 'message');
  if (messages(a).length !== messages(b).length) out.add('count messages');
  for (const ev of messages(a)) {
    const f = messages(b).find((x) => x.id === ids.edges[ev.id]);
    if (!f) {
      out.add('message lost');
      continue;
    }
    const end = (id: string) => (id === '[' || id === ']' ? id : ids.nodes[id]);
    if (f.from !== end(ev.from) || f.to !== end(ev.to)) out.add('message ends');
    if (f.head !== ev.head) out.add(`message head ${ev.head}→${f.head}`);
    if (f.tail !== ev.tail) out.add(`message tail ${ev.tail}→${f.tail}`);
    if (f.dashed !== ev.dashed) out.add('message dashed');
    if ((f.label ?? '') !== (ev.label ?? '')) out.add('message label');
    if ((f.number ?? '') !== (ev.number ?? '')) out.add('message number');
  }
  const kinds = (m: SequenceModel) => m.events.map((e) => (e.type === 'groupStart' ? `${e.type}:${e.kind}` : e.type)).join(' ');
  if (kinds(a) !== kinds(b)) out.add('event sequence');
  if (a.boxes.length !== b.boxes.length) out.add('count boxes');
  if (a.hideFootbox !== b.hideFootbox) out.add('footbox');
}

function ganttDiffs(a: GanttModel, b: GanttModel, ids: IdMap, out: Set<string>) {
  if (a.tasks.length !== b.tasks.length) out.add('count tasks');
  const date = (m: GanttModel, day: number) => addDays(m.start ?? DEFAULT_GANTT_START, day);
  for (const t of a.tasks) {
    const u = b.tasks.find((x) => x.id === ids.nodes[t.id]);
    if (!u) {
      out.add('task lost');
      continue;
    }
    if (u.name !== t.name) out.add('task name');
    if (date(b, u.start) !== date(a, t.start)) out.add('task start');
    if (u.duration !== t.duration) out.add('task duration');
    if (u.milestone !== t.milestone) out.add('task milestone');
    if ((u.completion ?? 0) !== (t.completion ?? 0)) out.add('task completion');
    if ((u.color ?? '') !== (t.color ?? '')) out.add('task colour');
    if ((u.section ?? '') !== (t.section ?? '')) out.add('task section');
    if ([...u.after].sort().join() !== t.after.map((x) => ids.nodes[x]).sort().join()) out.add('task dependencies');
  }
  if (a.closed.join() !== b.closed.join()) out.add('closed days');
}

function timingDiffs(a: TimingModel, b: TimingModel, ids: IdMap, out: Set<string>) {
  if (a.signals.length !== b.signals.length) out.add('count signals');
  for (const s of a.signals) {
    const t = b.signals.find((x) => x.id === ids.nodes[s.id]);
    if (!t) {
      out.add('signal lost');
      continue;
    }
    if (t.label !== s.label) out.add('signal label');
    if (t.kind !== s.kind) out.add('signal kind');
    if (JSON.stringify(t.changes) !== JSON.stringify(s.changes)) out.add('signal changes');
    if (JSON.stringify(t.states ?? []) !== JSON.stringify(s.states ?? [])) out.add('signal states');
    if (t.period !== s.period || t.pulse !== s.pulse) out.add('clock');
  }
  const msg = (m: TimingModel['messages'][number], map: (id: string) => string | undefined) => `${map(m.from)}@${m.fromTime}->${map(m.to)}@${m.toTime}:${m.label ?? ''}`;
  if (a.messages.map((m) => msg(m, (id) => ids.nodes[id])).join() !== b.messages.map((m) => msg(m, (id) => id)).join()) out.add('messages');
  if (a.end !== b.end) out.add('end time');
}

/** `a` then `b`: where an id ends up after two conversions. */
export function composeIds(a: IdMap, b: IdMap): IdMap {
  const via = (m: Record<string, string>, n: Record<string, string>) => Object.fromEntries(Object.entries(m).flatMap(([k, v]) => (n[v] !== undefined ? [[k, n[v]!]] : [])));
  return { nodes: via(a.nodes, b.nodes), edges: via(a.edges, b.edges) };
}
