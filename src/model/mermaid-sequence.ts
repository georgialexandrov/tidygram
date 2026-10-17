import type { ParseWarning, ParticipantKind, SeqEvent, SeqHead, SeqParticipant, SequenceModel } from './types.ts';
import type { ParseResult } from './parse.ts';
import type { Line } from './puml-util.ts';
import { mmdText } from './mermaid-util.ts';

/**
 * Mermaid sequence diagrams onto the PlantUML sequence model: participants
 * and actors (`as` labels, `@{ "type": "database" }`), messages with `+`/`-`
 * activation, activate/deactivate, create/destroy, notes, loop/alt/opt/par/
 * critical/break groups with their else/and/option branches, `rect`
 * highlights (not drawn), boxes and autonumber.
 */

const KINDS: Record<string, ParticipantKind> = {
  participant: 'participant',
  actor: 'actor',
  boundary: 'boundary',
  control: 'control',
  entity: 'entity',
  database: 'database',
  collections: 'collections',
  queue: 'queue',
};
const GROUPS = ['loop', 'alt', 'opt', 'par', 'critical', 'break'];
const COLOURS = /^(transparent|aqua|purple|gr[ae]y|light\w+|pink|red|green|blue|yellow|orange|white|black|beige|lavender|ivory|khaki|salmon|tan|teal|navy|olive|silver|wheat|linen|coral|cyan|magenta|gold|violet|#[0-9a-f]{3,8}|(rgb|rgba|hsl|hsla)\([^)]*\))$/i;

// Longest arrows first: `<<-->>`, `-->>`, `->>`, `-->`, `->`, `--x`, `-x`, `--)`, `-)`.
const MESSAGE_RE = /^(.+?)\s*(<<--?>>|--?>>|--?>|--?x|--?\))\s*([+-])?\s*([^:]+?)\s*(?::\s?(.*))?$/;

export function parseMermaidSequence(lines: Line[]): ParseResult {
  const warnings: ParseWarning[] = [];
  const participants = new Map<string, SeqParticipant>();
  const events: SeqEvent[] = [];
  const boxes: SequenceModel['boxes'] = [];
  const messageIds = new Map<string, number>();
  /** What each `end` closes. */
  const blocks: ('group' | 'rect' | 'box')[] = [];
  let openBox: SequenceModel['boxes'][number] | undefined;
  let autonumber: { next: number; step: number } | undefined;
  /** `destroy X` comes before the message that destroys X; the mark goes after it. */
  const doomed = new Set<string>();

  const participant = (raw: string, line: number, kind: ParticipantKind = 'participant', label?: string): string => {
    const id = raw.trim();
    let p = participants.get(id);
    if (!p) {
      p = { id, kind, label: label ?? id, line };
      participants.set(id, p);
      openBox?.participants.push(id);
    }
    return id;
  };

  for (const { no, raw, text } of lines) {
    if (/^(title|accTitle|accDescr|links?|properties|details)\b/i.test(text)) continue;

    const decl = /^(create\s+)?(participant|actor)\s+(.+?)$/i.exec(text);
    if (decl) {
      let rest = decl[3]!;
      let kind = KINDS[decl[2]!.toLowerCase()]!;
      const meta = /@\{(.*)\}\s*$/.exec(rest);
      if (meta) {
        rest = rest.slice(0, meta.index);
        const type = /"?type"?\s*:\s*"?(\w+)"?/.exec(meta[1]!)?.[1]?.toLowerCase();
        if (type && KINDS[type]) kind = KINDS[type];
      }
      const as = /^(\S+)\s+as\s+(.+)$/.exec(rest.trim());
      const id = (as ? as[1]! : rest).trim();
      const label = mmdText(as ? as[2]! : id);
      const existing = participants.get(id);
      if (existing) Object.assign(existing, { kind, label, line: no });
      else participant(id, no, kind, label);
      if (decl[1]) events.push({ type: 'create', participant: id, line: no });
      continue;
    }

    const box = /^box(?:\s+(.*))?$/i.exec(text);
    if (box) {
      let label = (box[1] ?? '').trim();
      const first = /^(\S+?(?:\([^)]*\))?)(?:\s+|$)(.*)$/.exec(label);
      if (first && COLOURS.test(first[1]!)) label = first[2]!;
      openBox = { label: mmdText(label), participants: [], line: no };
      boxes.push(openBox);
      blocks.push('box');
      continue;
    }

    if (/^rect\b/i.test(text)) {
      blocks.push('rect');
      continue;
    }
    const group = new RegExp(`^(${GROUPS.join('|')})\\b\\s*(.*)$`, 'i').exec(text);
    if (group) {
      events.push({ type: 'groupStart', kind: group[1]!.toLowerCase(), label: mmdText(group[2]!), line: no });
      blocks.push('group');
      continue;
    }
    const branch = /^(else|and|option)\b\s*(.*)$/i.exec(text);
    if (branch) {
      events.push({ type: 'groupElse', label: mmdText(branch[2]!), line: no });
      continue;
    }
    if (/^end$/i.test(text)) {
      const block = blocks.pop();
      if (block === 'group') events.push({ type: 'groupEnd', line: no });
      else if (block === 'box') openBox = undefined;
      else if (!block) warnings.push({ line: no, text: raw, message: 'end without a block' });
      continue;
    }

    const auto = /^autonumber(?:\s+(off)|(?:\s+(\d+))?(?:\s+(\d+))?)$/i.exec(text);
    if (auto) {
      autonumber = auto[1] ? undefined : { next: auto[2] ? Number(auto[2]) : 1, step: auto[3] ? Number(auto[3]) : 1 };
      continue;
    }

    const note = /^note\s+(left of|right of|over)\s+([^:]+?)\s*:\s?(.*)$/i.exec(text);
    if (note) {
      const side = note[1]!.toLowerCase().split(' ')[0] as 'left' | 'right' | 'over';
      const over = note[2]!.split(',').map((s) => participant(s, no));
      events.push({ type: 'note', side, over, text: mmdText(note[3]!), line: no });
      continue;
    }

    const life = /^(activate|deactivate|destroy)\s+(\S+)$/i.exec(text);
    if (life) {
      const kind = life[1]!.toLowerCase() as 'activate' | 'deactivate' | 'destroy';
      const id = participant(life[2]!, no);
      if (kind === 'destroy') doomed.add(id);
      else events.push({ type: kind, participant: id, line: no });
      continue;
    }

    const msg = MESSAGE_RE.exec(text);
    if (msg) {
      const from = participant(msg[1]!, no);
      const to = participant(msg[4]!, no);
      const arrow = msg[2]!;
      const head: SeqHead = arrow.endsWith('x') ? 'cross' : arrow.endsWith(')') ? 'open' : arrow.endsWith('>>') ? 'arrow' : 'none';
      const base = `${from}->${to}`;
      const count = (messageIds.get(base) ?? 0) + 1;
      messageIds.set(base, count);
      const event: Extract<SeqEvent, { type: 'message' }> = {
        type: 'message',
        id: `${base}#${count}`,
        from,
        to,
        dashed: arrow.replace(/^<</, '').startsWith('--'),
        head,
        tail: arrow.startsWith('<<') ? 'arrow' : 'none',
        line: no,
      };
      if (msg[5]?.trim()) event.label = mmdText(msg[5]);
      if (autonumber) {
        event.number = String(autonumber.next);
        autonumber.next += autonumber.step;
      }
      events.push(event);
      // `+` activates the receiver; `-` ends the sender's activation (`B-->>-A: done`).
      if (msg[3] === '+') events.push({ type: 'activate', participant: to, line: no });
      if (msg[3] === '-') events.push({ type: 'deactivate', participant: from, line: no });
      for (const id of [to, from]) {
        if (doomed.delete(id)) events.push({ type: 'destroy', participant: id, line: no });
      }
      continue;
    }

    warnings.push({ line: no, text: raw, message: 'Unsupported line, ignored' });
  }
  for (const id of doomed) events.push({ type: 'destroy', participant: id, line: participants.get(id)!.line });

  const model: SequenceModel = { type: 'sequence', participants: [...participants.values()], events, boxes, hideFootbox: false };
  return { diagram: { family: 'description', direction: 'LR', nodes: [], containers: [], edges: [], special: model }, warnings };
}
