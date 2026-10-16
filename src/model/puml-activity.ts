import type { DContainer, DEdge, DNode, Diagram, NodeKind, ParseWarning } from './types.ts';
import { unescape, type Line } from './puml-util.ts';

/**
 * PlantUML activity diagrams (the `:action;` syntax), compiled into the same
 * graph as every other free-layout diagram so dragging, routing and fit all
 * apply. Control flow becomes nodes and edges:
 *
 *   if/elseif/else/endif   decision hexagon, branches, merge diamond
 *   while/endwhile         decision with a back edge
 *   repeat/repeat while    merge diamond at the top, decision at the bottom
 *   fork/split             bars (fork) or a plain fan-out (split)
 *   switch/case            decision with one branch per case
 *   partition, group, |lane|   containers
 *
 * Ids come from the text (`Pay`, `if: card valid?`) so they survive edits
 * elsewhere in the file better than counters would.
 */

type Exit = { from: string; label?: string };

type Frame =
  | { type: 'if'; decision: string; exits: Exit[]; hasElse: boolean; elseLabel?: string }
  | { type: 'while'; decision: string }
  | { type: 'repeat'; start: string }
  | { type: 'fork'; bar?: string; exits: Exit[]; start: Exit[]; kind: 'fork' | 'split' }
  | { type: 'switch'; decision: string; exits: Exit[]; started: boolean };

const ENDINGS = /[;|<>/\]}]$/;

export function parseActivity(lines: Line[]): { diagram: Diagram; warnings: ParseWarning[] } {
  const nodes = new Map<string, DNode>();
  const containers = new Map<string, DContainer>();
  const edges: DEdge[] = [];
  const warnings: ParseWarning[] = [];
  const ids = new Map<string, number>();
  const edgeIds = new Map<string, number>();
  const frames: Frame[] = [];
  const groupStack: string[] = [];
  let lane: string | undefined;
  let pending: Exit[] = [];
  let nextLabel: string | undefined;
  let nextDashed = false;
  let lastNode: string | undefined;

  const parent = () => groupStack[groupStack.length - 1] ?? lane;

  const uniqueId = (base: string) => {
    const n = (ids.get(base) ?? 0) + 1;
    ids.set(base, n);
    return n === 1 ? base : `${base}#${n}`;
  };

  const addNode = (base: string, kind: NodeKind, label: string, line: number): string => {
    const id = uniqueId(base);
    const node: DNode = { id, kind, label, line };
    const p = parent();
    if (p) node.parent = p;
    nodes.set(id, node);
    lastNode = id;
    return id;
  };

  const addEdge = (from: string, to: string, label: string | undefined, line: number, dashed = false) => {
    const base = `${from}-->${to}`;
    const n = (edgeIds.get(base) ?? 0) + 1;
    edgeIds.set(base, n);
    const edge: DEdge = { id: n === 1 ? base : `${base}#${n}`, from, to, kind: dashed ? 'dependency' : 'association', dashed, head: 'arrow', tail: 'none', hidden: false, line };
    if (label) edge.label = unescape(label);
    edges.push(edge);
  };

  /** Connects every dangling exit to `to`; `to` becomes the only exit. */
  const flowTo = (to: string, line: number) => {
    for (const p of pending) addEdge(p.from, to, p.label ?? nextLabel, line, nextDashed);
    nextLabel = undefined;
    nextDashed = false;
    pending = [{ from: to }];
  };

  const merge = (exits: Exit[], base: string, line: number) => {
    if (exits.length > 1) {
      const m = addNode(base, 'choice', '', line);
      for (const e of exits) addEdge(e.from, m, e.label, line);
      pending = [{ from: m }];
    } else pending = exits;
  };

  let multiline: { text: string[]; line: number } | undefined;
  let noteBlock: { node: DNode; body: string[] } | undefined;

  for (const { no, raw, text } of lines) {
    if (noteBlock) {
      if (/^end\s*note$/i.test(text)) {
        noteBlock.node.label = noteBlock.body.join('\n').trim();
        noteBlock = undefined;
      } else noteBlock.body.push(text);
      continue;
    }
    if (multiline) {
      multiline.text.push(text);
      if (ENDINGS.test(text)) {
        const label = multiline.text.join('\n').replace(/^:/, '').replace(ENDINGS, '').trim();
        const id = addNode(label.split('\n')[0]!.slice(0, 60), 'action', unescape(label), multiline.line);
        flowTo(id, multiline.line);
        multiline = undefined;
      }
      continue;
    }
    if (!text || text.startsWith("'") || text.startsWith('@') || text.startsWith('!')) continue;
    if (/^(skinparam|title|header|footer|caption|scale|hide|legend|left to right|top to bottom)\b/i.test(text)) continue;

    let m: RegExpExecArray | null;
    if (/^start$/i.test(text)) {
      flowTo(addNode('start', 'initial', '', no), no);
      continue;
    }
    if (/^(stop|end)$/i.test(text)) {
      const id = addNode(text.toLowerCase(), 'final', '', no);
      flowTo(id, no);
      pending = [];
      continue;
    }
    if (/^(kill|detach|break)$/i.test(text)) {
      pending = [];
      continue;
    }

    // :action;  (possibly over several lines)
    if (text.startsWith(':')) {
      if (ENDINGS.test(text) && text.length > 1) {
        const label = text.slice(1).replace(ENDINGS, '').trim();
        const id = addNode(label.slice(0, 60), 'action', unescape(label), no);
        flowTo(id, no);
      } else multiline = { text: [text], line: no };
      continue;
    }

    // -> label;   -[#red,dashed]-> label;
    if ((m = /^-+(?:\[([^\]]*)\])?-*>\s*(.*?);?$/.exec(text))) {
      nextLabel = m[2] || undefined;
      nextDashed = /dashed|dotted/.test(m[1] ?? '');
      continue;
    }

    if ((m = /^if\s*\((.*?)\)\s*(?:is\s*\((.*?)\)\s*)?then\s*(?:\((.*?)\))?$/i.exec(text))) {
      const d = addNode(`if: ${m[1]}`, 'decision', unescape(m[1]!), no);
      flowTo(d, no);
      pending = [{ from: d, label: m[3] ?? m[2] }];
      frames.push({ type: 'if', decision: d, exits: [], hasElse: false });
      continue;
    }
    if ((m = /^else\s*if\s*\((.*?)\)\s*(?:is\s*\((.*?)\)\s*)?then\s*(?:\((.*?)\))?$/i.exec(text))) {
      const f = frames[frames.length - 1];
      if (f?.type !== 'if') {
        warnings.push({ line: no, text: raw, message: 'elseif outside if' });
        continue;
      }
      f.exits.push(...pending);
      const d = addNode(`if: ${m[1]}`, 'decision', unescape(m[1]!), no);
      addEdge(f.decision, d, undefined, no);
      f.decision = d;
      pending = [{ from: d, label: m[3] ?? m[2] }];
      continue;
    }
    if ((m = /^else\s*(?:\((.*?)\))?$/i.exec(text))) {
      const f = frames[frames.length - 1];
      if (f?.type !== 'if') {
        warnings.push({ line: no, text: raw, message: 'else outside if' });
        continue;
      }
      f.exits.push(...pending);
      f.hasElse = true;
      pending = [{ from: f.decision, label: m[1] }];
      continue;
    }
    if (/^end\s*if$/i.test(text)) {
      const f = frames.pop();
      if (f?.type !== 'if') {
        warnings.push({ line: no, text: raw, message: 'endif without if' });
        continue;
      }
      f.exits.push(...pending);
      if (!f.hasElse) f.exits.push({ from: f.decision });
      merge(f.exits, `endif: ${nodes.get(f.decision)!.label}`, no);
      continue;
    }

    if ((m = /^while\s*\((.*?)\)\s*(?:is\s*\((.*?)\))?$/i.exec(text))) {
      const d = addNode(`while: ${m[1]}`, 'decision', unescape(m[1]!), no);
      flowTo(d, no);
      pending = [{ from: d, label: m[2] }];
      frames.push({ type: 'while', decision: d });
      continue;
    }
    if ((m = /^end\s*while\s*(?:\((.*?)\))?$/i.exec(text))) {
      const f = frames.pop();
      if (f?.type !== 'while') {
        warnings.push({ line: no, text: raw, message: 'endwhile without while' });
        continue;
      }
      for (const p of pending) addEdge(p.from, f.decision, p.label, no);
      pending = [{ from: f.decision, label: m[1] }];
      continue;
    }

    if (/^repeat$/i.test(text) || (m = /^repeat\s*:(.*);$/i.exec(text))) {
      const r = addNode('repeat', 'choice', '', no);
      flowTo(r, no);
      frames.push({ type: 'repeat', start: r });
      if (m?.[1]) flowTo(addNode(m[1].trim(), 'action', unescape(m[1].trim()), no), no);
      continue;
    }
    if ((m = /^repeat\s*while\s*\((.*?)\)\s*(?:is\s*\((.*?)\))?\s*(?:not\s*\((.*?)\))?$/i.exec(text))) {
      const f = frames.pop();
      if (f?.type !== 'repeat') {
        warnings.push({ line: no, text: raw, message: 'repeat while without repeat' });
        continue;
      }
      const d = addNode(`repeat while: ${m[1]}`, 'decision', unescape(m[1]!), no);
      flowTo(d, no);
      addEdge(d, f.start, m[2], no);
      pending = [{ from: d, label: m[3] }];
      continue;
    }
    if ((m = /^backward\s*:(.*);$/i.exec(text))) {
      // Sits on the back edge of the enclosing repeat; drawn as a plain action off the loop.
      addNode(m[1]!.trim(), 'action', unescape(m[1]!.trim()), no);
      continue;
    }

    if (/^(fork|split)$/i.test(text)) {
      const kind = text.toLowerCase() as 'fork' | 'split';
      if (kind === 'fork') {
        const bar = addNode('fork', 'fork', '', no);
        flowTo(bar, no);
        frames.push({ type: 'fork', bar, exits: [], start: [{ from: bar }], kind });
      } else frames.push({ type: 'fork', exits: [], start: pending, kind });
      continue;
    }
    if (/^(fork|split)\s+again$/i.test(text)) {
      const f = frames[frames.length - 1];
      if (f?.type !== 'fork') continue;
      f.exits.push(...pending);
      pending = [...f.start];
      continue;
    }
    if (/^end\s*(fork|merge|split)(\s*\{.*\})?$/i.test(text)) {
      const f = frames.pop();
      if (f?.type !== 'fork') continue;
      f.exits.push(...pending);
      if (f.kind === 'fork' && !/merge/i.test(text)) {
        const join = addNode('join', 'fork', '', no);
        for (const e of f.exits) addEdge(e.from, join, e.label, no);
        pending = [{ from: join }];
      } else merge(f.exits, 'merge', no);
      continue;
    }

    if ((m = /^switch\s*\((.*)\)$/i.exec(text))) {
      const d = addNode(`switch: ${m[1]}`, 'decision', unescape(m[1]!), no);
      flowTo(d, no);
      frames.push({ type: 'switch', decision: d, exits: [], started: false });
      pending = [];
      continue;
    }
    if ((m = /^case\s*\((.*)\)$/i.exec(text))) {
      const f = frames[frames.length - 1];
      if (f?.type !== 'switch') continue;
      if (f.started) f.exits.push(...pending);
      f.started = true;
      pending = [{ from: f.decision, label: m[1] }];
      continue;
    }
    if (/^end\s*switch$/i.test(text)) {
      const f = frames.pop();
      if (f?.type !== 'switch') continue;
      f.exits.push(...pending);
      merge(f.exits, `endswitch: ${nodes.get(f.decision)!.label}`, no);
      continue;
    }

    // Containers: partition/group/package/rectangle/card "Name" {  ...  }   and   group Name ... end group
    if ((m = /^(partition|group|package|rectangle|card)\s+(?:"([^"]+)"|([^{#]+?))(?:\s+#\w+)?\s*(\{)?$/i.exec(text))) {
      const label = (m[2] ?? m[3] ?? '').trim();
      const id = uniqueId(label);
      const c: DContainer = { id, kind: m[1]!.toLowerCase(), label, line: no };
      const p = parent();
      if (p) c.parent = p;
      containers.set(id, c);
      groupStack.push(id);
      continue;
    }
    if (text === '}' || /^end\s*(group|partition)$/i.test(text)) {
      groupStack.pop();
      continue;
    }
    if ((m = /^\|(?:#?\w+\|)?([^|]+)\|$/.exec(text))) {
      const label = m[1]!.trim();
      if (!containers.has(`lane: ${label}`)) containers.set(`lane: ${label}`, { id: `lane: ${label}`, kind: 'swimlane', label, line: no });
      lane = `lane: ${label}`;
      continue;
    }

    if ((m = /^(?:floating\s+)?note\s+(left|right)(?:\s*:\s*(.*))?$/i.exec(text))) {
      const target = lastNode;
      const note = nodes.get(addNode(target ? `note:${target}` : 'note', 'note', unescape(m[2] ?? ''), no))!;
      lastNode = target;
      if (target) {
        note.attachedTo = { id: target, side: m[1]!.toLowerCase() as 'left' | 'right' };
        addEdge(note.id, target, undefined, no, true);
        edges[edges.length - 1]!.kind = 'noteLink';
        edges[edges.length - 1]!.head = 'none';
      }
      if (m[2] === undefined) noteBlock = { node: note, body: [] };
      continue;
    }

    if (/^(detach|kill)$/i.test(text) || /^\(\w\)$/.test(text)) continue;

    warnings.push({ line: no, text: raw, message: 'Unsupported line, ignored' });
  }

  if (frames.length) warnings.push({ line: lines[lines.length - 1]?.no ?? 0, text: '', message: `${frames.length} block(s) not closed` });

  return {
    diagram: { family: 'activity', direction: 'TB', nodes: [...nodes.values()], containers: [...containers.values()], edges },
    warnings,
  };
}
