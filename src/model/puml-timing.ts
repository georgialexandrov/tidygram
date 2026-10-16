import type { Diagram, ParseWarning, TimingModel, TimingSignal } from './types.ts';
import { parseNameSpec, unescape, type Line } from './puml-util.ts';

/**
 * PlantUML timing diagrams: robust/concise/clock/binary signals, state
 * changes at `@time` (absolute, `@+n` relative, or per-signal `@Signal`
 * blocks), declared state order (`has`), and messages between signals.
 */
export function parseTiming(lines: Line[]): { diagram: Diagram; warnings: ParseWarning[] } {
  const warnings: ParseWarning[] = [];
  const signals = new Map<string, TimingSignal>();
  const declaredStates = new Map<string, string[]>();
  const messages: TimingModel['messages'] = [];
  let now = 0;
  let context: string | undefined;
  let end = 0;

  const find = (name: string) => {
    for (const s of signals.values()) if (s.id === name || s.label === name) return s;
    return undefined;
  };
  const at = (spec: string) => {
    const rel = /^\+(\d+(?:\.\d+)?)$/.exec(spec);
    return rel ? now + Number(rel[1]) : Number(spec);
  };

  for (const { no, raw, text } of lines) {
    if (!text || text.startsWith("'") || text.startsWith('@start') || text.startsWith('@end') || text.startsWith('!')) continue;
    let m: RegExpExecArray | null;
    if ((m = /^(robust|concise|clock|binary)\s+(.+?)(?:\s+with\s+period\s+(\d+)(?:\s+pulse\s+(\d+))?(?:\s+offset\s+(\d+))?)?$/i.exec(text))) {
      const spec = parseNameSpec(m[2]!);
      if (!spec) continue;
      const s: TimingSignal = { id: spec.id, label: spec.label, kind: m[1]!.toLowerCase() as TimingSignal['kind'], changes: [], line: no };
      if (m[3]) s.period = Number(m[3]);
      if (m[4]) s.pulse = Number(m[4]);
      signals.set(s.id, s);
      continue;
    }
    if ((m = /^@(\S+)$/.exec(text))) {
      const target = find(m[1]!);
      if (target) context = target.id;
      else {
        context = undefined;
        now = at(m[1]!);
        end = Math.max(end, now);
      }
      continue;
    }
    if ((m = /^(\w+)\s+has\s+(.+)$/i.exec(text))) {
      declaredStates.set(m[1]!, m[2]!.split(',').map((s) => unescape(s.trim().replace(/^"|"$/g, ''))));
      continue;
    }
    // `WB is Idle`  or, inside an @WB block, `100 is Idle`
    if ((m = /^(\S+)\s+is\s+(.+?)(?:\s*:\s*(.*))?$/i.exec(text))) {
      let signal = find(m[1]!);
      let time = now;
      if (!signal && context && /^[+\d.]/.test(m[1]!)) {
        signal = signals.get(context);
        time = at(m[1]!);
        end = Math.max(end, time);
      }
      if (!signal) {
        warnings.push({ line: no, text: raw, message: 'Unknown signal' });
        continue;
      }
      const state = unescape(m[2]!.replace(/^\{|\}$/g, '').split(',')[0]!.trim().replace(/^"|"$/g, ''));
      signal.changes.push({ time, state: signal.kind === 'binary' ? state.toLowerCase() : state });
      continue;
    }
    // `WB -> WU : URL`   `WB@100 -> WU@120 : x`
    if ((m = /^(\w+)(?:@(\S+))?\s*-+>\s*(\w+)(?:@(\S+))?\s*(?::\s*(.*))?$/.exec(text))) {
      const from = find(m[1]!);
      const to = find(m[3]!);
      if (from && to) {
        const message: TimingModel['messages'][number] = { from: from.id, fromTime: m[2] ? at(m[2]) : now, to: to.id, toTime: m[4] ? at(m[4]) : now, line: no };
        if (m[5]) message.label = unescape(m[5]);
        messages.push(message);
        continue;
      }
    }
    if (/^(highlight|scale|hide|title|skinparam|legend|header|footer|caption|mode|use|manual)/i.test(text) || /^@\S+\s*<->/.test(text)) continue;
    warnings.push({ line: no, text: raw, message: 'Unsupported line, ignored' });
  }

  for (const s of signals.values()) {
    s.changes.sort((a, b) => a.time - b.time);
    const order = declaredStates.get(s.id) ?? declaredStates.get(s.label);
    if (order) s.states = order;
  }
  const lastChange = Math.max(0, ...[...signals.values()].flatMap((s) => s.changes.map((c) => c.time)));
  const model: TimingModel = { type: 'timing', signals: [...signals.values()], messages, end: Math.max(end, lastChange) * 1.15 || 100 };
  return { diagram: { family: 'description', direction: 'LR', nodes: [], containers: [], edges: [], special: model }, warnings };
}
