import type { Diagram, ParseWarning, ParticipantKind, SeqEvent, SeqHead, SeqParticipant, SequenceModel } from './types.ts';
import { parseNameSpec, unescape, type Line } from './puml-util.ts';

/**
 * PlantUML sequence diagrams: participants, messages (sync, async, reply,
 * lost/found, self), activation, create/destroy, return, notes, groups
 * (alt/else/opt/loop/par/break/critical/group), dividers, delays, spacing,
 * refs, autonumber and boxes.
 */

const PARTICIPANT_KINDS: ParticipantKind[] = ['participant', 'actor', 'boundary', 'control', 'entity', 'database', 'collections', 'queue'];
const GROUPS = ['alt', 'opt', 'loop', 'par', 'par2', 'break', 'critical', 'group', 'neg', 'strict', 'seq', 'ignore', 'consider', 'assert'];

// Participant reference: quoted, bare, or the diagram edge for found/lost messages.
const REF = String.raw`(?:"[^"]+"|[\p{L}\p{N}_.$]+|\[|\]|\?)`;
// Arrow: optional heads around a body of - or --, optional [style] inside.
// Heads: > (sync), >> (async), \ or / (half), and a trailing x (lost) or o (circle): `->x`, `->>o`.
const HEAD = String.raw`(?:(?:>>|>|\\\\|\/\/|\\|\/)(?:x|o)?|x|o)`;
const TAIL = String.raw`(?:(?:x|o)?(?:<<|<|\\\\|\/\/|\\|\/)|x|o)`;
const ARROW = String.raw`${TAIL}?-{1,2}(?:\[[^\]]*\])?-?${HEAD}?`;
const MESSAGE_RE = new RegExp(String.raw`^(${REF})?\s*(${ARROW})\s*(${REF})?\s*((?:\+\+|--|\*\*|!!)\s*)*(?::\s*(.*))?$`, 'u');

function head(token: string, _end: boolean): SeqHead {
  if (!token) return 'none';
  if (token.includes('x')) return 'cross';
  if (/o/.test(token)) return 'circle';
  if (token === '>' || token === '<') return 'arrow';
  if (token === '>>' || token === '<<') return 'open';
  if (token === 'x') return 'cross';
  if (token === 'o') return 'circle';
  return 'half';
}

export function parseSequence(lines: Line[]): { diagram: Diagram; warnings: ParseWarning[] } {
  const participants = new Map<string, SeqParticipant>();
  const events: SeqEvent[] = [];
  const boxes: SequenceModel['boxes'] = [];
  const warnings: ParseWarning[] = [];
  const messageIds = new Map<string, number>();
  let hideFootbox = false;
  let autonumber: { next: number; step: number; format?: string } | undefined;
  let openBox: SequenceModel['boxes'][number] | undefined;
  let pending: { kind: 'note' | 'ref'; event: Extract<SeqEvent, { type: 'note' | 'ref' }>; body: string[]; end: RegExp } | undefined;
  let skipUntil: RegExp | undefined;
  let skipDepth = 0;
  /** Callers waiting for a `return`: each activation pushes the message that caused it. */
  const callStack: { caller: string; callee: string }[] = [];

  const participant = (raw: string, line: number, kind: ParticipantKind = 'participant'): string => {
    const id = raw.startsWith('"') ? raw.slice(1, -1) : raw;
    if (!participants.has(id)) {
      participants.set(id, { id, kind, label: unescape(id), line });
      openBox?.participants.push(id);
    }
    return id;
  };

  const resolve = (raw: string, line: number) => {
    const id = raw.startsWith('"') ? raw.slice(1, -1) : raw;
    for (const p of participants.values()) if (p.id === id || p.label === unescape(id)) return p.id;
    return participant(raw, line);
  };

  for (const { no, raw, text } of lines) {
    if (pending) {
      if (pending.end.test(text)) {
        if (pending.event.type === 'note') pending.event.text = pending.body.join('\n').trim();
        else pending.event.text = pending.body.join('\n').trim();
        events.push(pending.event);
        pending = undefined;
      } else pending.body.push(text);
      continue;
    }
    if (skipUntil) {
      if (skipUntil.test(text)) skipUntil = undefined;
      continue;
    }
    if (skipDepth) {
      if (text.endsWith('{')) skipDepth++;
      if (text === '}') skipDepth--;
      continue;
    }
    if (!text || text.startsWith("'") || text.startsWith('@') || text.startsWith('!')) continue;
    if (/^hide\s+footbox$/i.test(text)) {
      hideFootbox = true;
      continue;
    }
    if (/^(skinparam|hide|show|title|header|footer|caption|scale|newpage|mainframe|legend)\b/i.test(text)) {
      if (text.endsWith('{')) skipDepth = 1;
      else if (/^legend\b/i.test(text)) skipUntil = /^end\s*legend$/i;
      else if (/^(title|header|footer)$/i.test(text)) skipUntil = /^end\s*(title|header|footer)$/i;
      continue;
    }

    // Declarations: `participant "Long" as L #red <<stereo>> order 10`
    const decl = new RegExp(`^(${PARTICIPANT_KINDS.join('|')})\\s+(.+?)(?:\\s+order\\s+(-?\\d+))?$`, 'i').exec(text);
    if (decl) {
      const spec = parseNameSpec(decl[2]!);
      if (!spec) continue;
      const kind = decl[1]!.toLowerCase() as ParticipantKind;
      const existing = participants.get(spec.id);
      const p: SeqParticipant = existing ?? { id: spec.id, kind, label: spec.label, line: no };
      Object.assign(p, { kind, label: spec.label, line: no });
      if (spec.stereotype) p.stereotype = spec.stereotype;
      if (decl[3]) p.order = Number(decl[3]);
      if (!existing) {
        participants.set(p.id, p);
        openBox?.participants.push(p.id);
      }
      continue;
    }

    const box = /^box(?:\s+"?([^"#]*)"?)?(?:\s+#\w+)?$/i.exec(text);
    if (box) {
      openBox = { label: unescape(box[1] ?? ''), participants: [], line: no };
      boxes.push(openBox);
      continue;
    }
    if (/^end\s*box$/i.test(text)) {
      openBox = undefined;
      continue;
    }

    const auto = /^autonumber(?:\s+(stop|resume|inc\s+\w+))?(?:\s+(\d+))?(?:\s+(\d+))?(?:\s+"([^"]*)")?$/i.exec(text);
    if (auto) {
      if (auto[1]?.toLowerCase() === 'stop') autonumber = undefined;
      else autonumber = { next: auto[2] ? Number(auto[2]) : (autonumber?.next ?? 1), step: auto[3] ? Number(auto[3]) : 1, format: auto[4] };
      continue;
    }

    // Notes: `note left of A : x`, `note over A, B`, `hnote over A`, `note across: x`, multi-line until `end note`.
    const note = /^(note|hnote|rnote)\s+(left|right|over|across)(?:\s+(?:of\s+)?([^:]+?))?\s*(?::\s*(.*))?$/i.exec(text);
    if (note) {
      const side = note[2]!.toLowerCase() as 'left' | 'right' | 'over' | 'across';
      const over = (note[3] ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
        .map((s) => resolve(s, no));
      // `note left` without a target belongs to the last message's participant.
      if (!over.length && side !== 'across') {
        const last = [...events].reverse().find((e) => e.type === 'message');
        if (last && last.type === 'message') over.push(side === 'left' ? last.from : last.to);
      }
      const event: Extract<SeqEvent, { type: 'note' }> = { type: 'note', side, over, text: '', line: no };
      if (note[4] !== undefined) {
        event.text = unescape(note[4]);
        events.push(event);
      } else {
        pending = { kind: 'note', event, body: [], end: /^end\s*(note|hnote|rnote)$|^end(h|r)note$/i };
      }
      continue;
    }

    const ref = /^ref\s+over\s+([^:]+?)\s*(?::\s*(.*))?$/i.exec(text);
    if (ref) {
      const over = ref[1]!.split(',').map((s) => resolve(s.trim(), no));
      const event: Extract<SeqEvent, { type: 'ref' }> = { type: 'ref', over, text: '', line: no };
      if (ref[2] !== undefined) {
        event.text = unescape(ref[2]);
        events.push(event);
      } else pending = { kind: 'ref', event, body: [], end: /^end\s*ref$/i };
      continue;
    }

    const group = new RegExp(`^(${GROUPS.join('|')})\\b\\s*(.*)$`, 'i').exec(text);
    if (group) {
      events.push({ type: 'groupStart', kind: group[1]!.toLowerCase(), label: unescape(group[2]!.replace(/^\[|\]$/g, '')), line: no });
      continue;
    }
    const elseLine = /^else\b\s*(.*)$/i.exec(text);
    if (elseLine) {
      events.push({ type: 'groupElse', label: unescape(elseLine[1]!), line: no });
      continue;
    }
    if (/^end$/i.test(text)) {
      events.push({ type: 'groupEnd', line: no });
      continue;
    }

    const divider = /^==\s*(.*?)\s*==$/.exec(text);
    if (divider) {
      events.push({ type: 'divider', label: unescape(divider[1]!), line: no });
      continue;
    }
    const delay = /^\.\.\.\s*(.*?)\s*(?:\.\.\.)?$/.exec(text);
    if (delay) {
      events.push({ type: 'delay', label: unescape(delay[1]!), line: no });
      continue;
    }
    const space = /^\|\|(\d*)\|\|?$/.exec(text);
    if (space) {
      events.push({ type: 'space', size: space[1] ? Number(space[1]) : 20, line: no });
      continue;
    }

    const life = /^(activate|deactivate|destroy|create)\s+(?:(participant|actor|database|entity|boundary|control|queue|collections)\s+)?(.+?)(?:\s+#\w+)?$/i.exec(text);
    if (life) {
      const kind = life[1]!.toLowerCase() as 'activate' | 'deactivate' | 'destroy' | 'create';
      const id = life[2] ? participant(life[3]!, no, life[2].toLowerCase() as ParticipantKind) : resolve(life[3]!, no);
      events.push({ type: kind, participant: id, line: no });
      if (kind === 'deactivate') {
        const i = callStack.map((c) => c.callee).lastIndexOf(id);
        if (i >= 0) callStack.splice(i, 1);
      }
      continue;
    }

    const ret = /^return\b\s*(.*)$/i.exec(text);
    if (ret) {
      const call = callStack.pop();
      if (!call) {
        warnings.push({ line: no, text: raw, message: 'return without an activation' });
        continue;
      }
      pushMessage(call.callee, call.caller, { dashed: true, head: 'open', tail: 'none' }, ret[1] || undefined, no);
      events.push({ type: 'deactivate', participant: call.callee, line: no });
      continue;
    }

    const msg = MESSAGE_RE.exec(text);
    if (msg && (msg[1] || msg[3])) {
      const arrow = msg[2]!;
      const body = arrow.replace(/\[[^\]]*\]/, '');
      const m = new RegExp(`^(${TAIL})?(-{1,2})-?(${HEAD})?$`).exec(body);
      if (!m) {
        warnings.push({ line: no, text: raw, message: 'Unsupported arrow, ignored' });
        continue;
      }
      let fromRaw = msg[1] ?? '[';
      let toRaw = msg[3] ?? ']';
      let headTok = m[3] ?? '';
      let tailTok = m[1] ?? '';
      // `A <- B` is B -> A.
      if (tailTok && !headTok && tailTok.startsWith('<')) {
        [fromRaw, toRaw] = [toRaw, fromRaw];
        [headTok, tailTok] = [tailTok.replace(/</g, '>'), ''];
      }
      const edge = (r: string, side: '[' | ']') => (r === '[' || r === ']' || r === '?' ? side : resolve(r, no));
      const from = edge(fromRaw, '[');
      const to = edge(toRaw, ']');
      const dashed = m[2] === '--' || /\bdashed\b/.test(arrow);
      const suffix = msg[4] ?? '';
      // `++` activates the target, `--` deactivates the source, `**` creates, `!!` destroys.
      if (suffix.includes('**')) events.push({ type: 'create', participant: to, line: no });
      pushMessage(from, to, { dashed, head: head(headTok, true), tail: head(tailTok, false) }, msg[5], no);
      if (suffix.includes('++')) {
        events.push({ type: 'activate', participant: to, line: no });
        callStack.push({ caller: from, callee: to });
      }
      if (/(^|\s)--/.test(suffix)) {
        events.push({ type: 'deactivate', participant: from, line: no });
        const i = callStack.map((c) => c.callee).lastIndexOf(from);
        if (i >= 0) callStack.splice(i, 1);
      }
      if (suffix.includes('!!')) events.push({ type: 'destroy', participant: to, line: no });
      continue;
    }

    warnings.push({ line: no, text: raw, message: 'Unsupported line, ignored' });
  }

  // Track activations from explicit `activate X` after a message, for `return`.
  // (`activate` lines are already events; the call stack above covers `++`.)

  function pushMessage(from: string, to: string, style: { dashed: boolean; head: SeqHead; tail: SeqHead }, label: string | undefined, line: number) {
    const base = `${from}->${to}`;
    const count = (messageIds.get(base) ?? 0) + 1;
    messageIds.set(base, count);
    const event: Extract<SeqEvent, { type: 'message' }> = { type: 'message', id: `${base}#${count}`, from, to, ...style, line };
    if (label) event.label = unescape(label);
    if (autonumber) {
      const n = String(autonumber.next);
      event.number = autonumber.format ? autonumber.format.replace(/<\/?b>/g, '').replace(/0+/, (z) => n.padStart(z.length, '0')).replace(/^(?!.*\d)/, n) : n;
      autonumber.next += autonumber.step;
    }
    events.push(event);
    // An `activate X` right after a message to X makes X the callee for `return`.
    const last = lines.find((l) => l.no === line + 1)?.text ?? '';
    const act = /^activate\s+(.+)$/i.exec(last);
    if (act && resolve(act[1]!.trim(), line) === to) callStack.push({ caller: from, callee: to });
  }

  // Explicit `order` first, then declaration order.
  const ordered = [...participants.values()].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const model: SequenceModel = { type: 'sequence', participants: ordered, events, boxes, hideFootbox };
  return { diagram: { family: 'description', direction: 'LR', nodes: [], containers: [], edges: [], special: model }, warnings };
}
