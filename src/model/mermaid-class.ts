import type { ArrowHead, ClassKind, DContainer, DNode, Diagram, NodeKind, NotePosition, ParseWarning } from './types.ts';
import type { ParseResult } from './parse.ts';
import type { Line } from './puml-util.ts';
import { edgeBuilder, mmdText } from './mermaid-util.ts';

/**
 * Mermaid class, state and ER diagrams. They land in the same families as
 * their PlantUML counterparts (class boxes with compartments, states with
 * scoped `[*]`, entities with crow's feet), with the same id conventions, so
 * a diagram ported from one format to the other keeps its layout.json.
 */

const IGNORED = /^(classDef|cssClass|style|click|callback|link|title|accTitle|accDescr|scale|hide|show)\b/;

const direction = (text: string): Diagram['direction'] | undefined => {
  const m = /^direction\s+(TB|TD|BT|LR|RL)$/i.exec(text);
  return m ? (/^(LR|RL)$/i.test(m[1]!) ? 'LR' : 'TB') : undefined;
};

/** Mermaid writes generics with tildes: `List~int~` is `List<int>`. */
const generics = (s: string) => s.replace(/~([^~]*)~/g, '<$1>');
const unbacktick = (s: string) => s.replace(/^`(.*)`$/, '$1');

// ---- class -------------------------------------------------------------------------------------

const CLASS_ANNOTATIONS: Record<string, ClassKind> = { interface: 'interface', abstract: 'abstract', enumeration: 'enum', enum: 'enum', struct: 'struct', record: 'record', exception: 'exception' };

const NAME = '(?:`[^`]+`|[\\p{L}\\p{N}_.$]+)(?:~[^~]*~)?';
const REL_RE = new RegExp(
  String.raw`^(${NAME})\s*(?:"([^"]*)")?\s*(<\||\*|o|<|\(\))?(--|\.\.)(\|>|\*|o|>|\(\))?\s*(?:"([^"]*)")?\s*(${NAME})\s*(?::\s*(.*))?$`,
  'u',
);
const CLASS_LEFT: Record<string, ArrowHead> = { '<|': 'triangle', '*': 'diamondFilled', o: 'diamond', '<': 'arrow', '()': 'circle' };
const CLASS_RIGHT: Record<string, ArrowHead> = { '|>': 'triangle', '*': 'diamondFilled', o: 'diamond', '>': 'arrow', '()': 'circle' };

export function parseMermaidClass(lines: Line[]): ParseResult {
  const warnings: ParseWarning[] = [];
  const nodes = new Map<string, DNode>();
  const members = new Map<string, string[]>();
  const containers: DContainer[] = [];
  const { edges, add } = edgeBuilder();
  /** Open `{` blocks: a namespace id, or a class whose body we are reading. */
  const stack: ({ namespace: string } | { body: DNode })[] = [];
  let dir: Diagram['direction'] = 'TB';
  let fixed = false;
  let notes = 0;

  const namespace = () => {
    for (let i = stack.length - 1; i >= 0; i--) {
      const b = stack[i]!;
      if ('namespace' in b) return b.namespace;
    }
    return undefined;
  };
  const idOf = (name: string) => unbacktick(name.replace(/~[^~]*~$/, ''));
  const cls = (name: string, line: number): DNode => {
    const id = idOf(name);
    let node = nodes.get(id);
    if (!node) {
      node = { id, kind: 'class', label: generics(unbacktick(name)), classKind: 'class', line };
      const ns = namespace();
      if (ns) node.parent = ns;
      nodes.set(id, node);
    } else if (/~/.test(name)) node.label = generics(unbacktick(name));
    return node;
  };
  const annotate = (node: DNode, annotation: string) => {
    const a = annotation.trim();
    const kind = CLASS_ANNOTATIONS[a.toLowerCase()];
    if (kind) node.classKind = kind;
    else node.stereotype = a;
  };
  const member = (node: DNode, text: string) => {
    const m = generics(text.trim()).replace(/[$*]$/, '').trim();
    if (!m) return;
    const list = members.get(node.id) ?? [];
    list.push(m);
    members.set(node.id, list);
  };

  for (const { no, raw, text } of lines) {
    const top = stack[stack.length - 1];
    if (top && 'body' in top) {
      if (text === '}') stack.pop();
      else if (/^<<.+>>$/.test(text)) annotate(top.body, text.slice(2, -2));
      else member(top.body, text);
      continue;
    }
    if (text === '}') {
      if (!stack.pop()) warnings.push({ line: no, text: raw, message: 'Unmatched }' });
      continue;
    }
    const d = direction(text);
    if (d) {
      dir = d;
      fixed = true;
      continue;
    }
    if (IGNORED.test(text)) continue;

    const ns = /^namespace\s+(\S+)\s*\{$/.exec(text);
    if (ns) {
      const container: DContainer = { id: ns[1]!, kind: 'namespace', label: ns[1]!, line: no };
      const parent = namespace();
      if (parent) container.parent = parent;
      containers.push(container);
      stack.push({ namespace: ns[1]! });
      continue;
    }

    const decl = new RegExp(String.raw`^class\s+(${NAME})(?:\s*\["([^"]*)"\])?(?::::[\w-]+)?\s*(\{\s*(.*?)\s*(\})?)?$`, 'u').exec(text);
    if (decl) {
      const node = cls(decl[1]!, no);
      node.line = no;
      if (decl[2]) node.label = mmdText(decl[2]);
      if (decl[3]) {
        if (decl[5]) for (const m of (decl[4] ?? '').split(/;/)) member(node, m);
        else stack.push({ body: node });
      }
      continue;
    }

    const annotation = new RegExp(String.raw`^<<(.+)>>\s*(${NAME})$`, 'u').exec(text);
    if (annotation) {
      annotate(cls(annotation[2]!, no), annotation[1]!);
      continue;
    }

    const note = /^note\s+(?:for\s+(\S+)\s+)?"(.*)"$/.exec(text);
    if (note) {
      notes++;
      const target = note[1] ? cls(note[1], no) : undefined;
      const id = target ? `note:${target.id}` : `note#${notes}`;
      const node: DNode = { id: nodes.has(id) ? `${id}#${notes}` : id, kind: 'note', label: mmdText(note[2]!), line: no };
      if (target) {
        node.attachedTo = { id: target.id, side: 'right' };
        if (target.parent) node.parent = target.parent;
      }
      nodes.set(node.id, node);
      if (target) add(node.id, target.id, { dashed: true, head: 'none', tail: 'none' }, no, { note: true });
      continue;
    }

    const rel = REL_RE.exec(text);
    if (rel) {
      const from = cls(rel[1]!, no);
      const to = cls(rel[7]!, no);
      const label = rel[8] ? mmdText(rel[8]) : undefined;
      add(from.id, to.id, { dashed: rel[4] === '..', tail: CLASS_LEFT[rel[3] ?? ''] ?? 'none', head: CLASS_RIGHT[rel[5] ?? ''] ?? 'none' }, no, { label, fromLabel: rel[2], toLabel: rel[6] });
      continue;
    }

    const memberLine = new RegExp(String.raw`^(${NAME})\s*:\s*(.+)$`, 'u').exec(text);
    if (memberLine) {
      const node = cls(memberLine[1]!, no);
      if (/^<<.+>>$/.test(memberLine[2]!.trim())) annotate(node, memberLine[2]!.trim().slice(2, -2));
      else member(node, memberLine[2]!);
      continue;
    }

    warnings.push({ line: no, text: raw, message: 'Unsupported line, ignored' });
  }
  if (stack.length) warnings.push({ line: lines.at(-1)?.no ?? 1, text: '', message: 'Unclosed {' });

  // As PlantUML draws them: fields, then methods, in their own compartments.
  for (const [id, list] of members) {
    const node = nodes.get(id)!;
    const methods = list.filter((m) => m.includes('('));
    const fields = list.filter((m) => !m.includes('('));
    node.compartments = methods.length && node.classKind !== 'enum' ? [fields, methods] : [list];
  }
  return { diagram: { family: 'class', direction: dir, ...(fixed ? { directionFixed: true } : {}), nodes: [...nodes.values()], containers, edges }, warnings };
}

// ---- state -------------------------------------------------------------------------------------

const PSEUDO: Record<string, NodeKind> = { choice: 'choice', fork: 'fork', join: 'fork' };
const STATE_REF = String.raw`(?:\[\*\]|[\p{L}\p{N}_.$-]+?)`;
const TRANSITION_RE = new RegExp(String.raw`^(${STATE_REF})(?::::[\w-]+)?\s*-->\s*(${STATE_REF})(?::::[\w-]+)?\s*(?::\s*(.*))?$`, 'u');

export function parseMermaidState(lines: Line[]): ParseResult {
  const warnings: ParseWarning[] = [];
  const nodes = new Map<string, DNode>();
  const containers = new Map<string, DContainer>();
  const { edges, add } = edgeBuilder();
  const stack: string[] = [];
  /** States only seen in transitions; a later `state X {` turns them into a composite. */
  const implicit = new Set<string>();
  let dir: Diagram['direction'] = 'TB';
  let fixed = false;
  let pendingNote: { node: DNode; body: string[] } | undefined;
  const notes = new Map<string, number>();

  const parent = () => stack[stack.length - 1];
  const state = (id: string, line: number, declared: boolean): DNode | DContainer => {
    const existing = nodes.get(id) ?? containers.get(id);
    if (existing) {
      if (declared) implicit.delete(id);
      return existing;
    }
    const node: DNode = { id, kind: 'state', label: id, line };
    const p = parent();
    if (p) node.parent = p;
    nodes.set(id, node);
    if (!declared) implicit.add(id);
    return node;
  };
  /** `[*]` is scoped per composite: inside `Busy` it is `[*]@Busy`; as a target it is the final state. */
  const ref = (text: string, line: number, end: 'from' | 'to') => {
    if (text !== '[*]') return state(text, line, false);
    const base = end === 'from' ? '[*]' : '[*]end';
    const id = parent() ? `${base}@${parent()}` : base;
    let node = nodes.get(id);
    if (!node) {
      node = { id, kind: end === 'from' ? 'initial' : 'final', label: '', line };
      if (parent()) node.parent = parent();
      nodes.set(id, node);
    }
    return node;
  };

  for (const { no, raw, text } of lines) {
    if (pendingNote) {
      if (/^end\s*note$/i.test(text)) {
        pendingNote.node.label = mmdText(pendingNote.body.join('\n'));
        pendingNote = undefined;
      } else pendingNote.body.push(text);
      continue;
    }
    const d = direction(text);
    if (d) {
      if (!stack.length) {
        dir = d;
        fixed = true;
      }
      continue;
    }
    if (IGNORED.test(text) || /^class\s+[\w,\s]+\s+[\w-]+$/.test(text) || /^(--|\|\|)$/.test(text)) continue;
    if (text === '}') {
      if (!stack.pop()) warnings.push({ line: no, text: raw, message: 'Unmatched }' });
      continue;
    }

    // `state "Long name" as X {`, `state X {`, `state X <<choice>>`, `state "Desc" as X`
    const st = /^state\s+(?:"([^"]*)"\s+as\s+)?([\p{L}\p{N}_.$-]+)(?:\s+as\s+"([^"]*)")?\s*(?:<<(\w+)>>)?\s*(\{)?\s*(?::\s*(.*))?$/u.exec(text);
    if (st) {
      const id = st[2]!;
      const label = mmdText(st[1] ?? st[3] ?? id);
      if (st[5]) {
        if (nodes.has(id) && implicit.has(id)) {
          nodes.delete(id);
          implicit.delete(id);
        }
        const c: DContainer = { id, kind: 'state', label, line: no };
        if (parent()) c.parent = parent();
        containers.set(id, c);
        stack.push(id);
        continue;
      }
      const node = state(id, no, true);
      if ('kind' in node && !containers.has(id)) {
        const n = node as DNode;
        const pseudo = st[4] ? PSEUDO[st[4].toLowerCase()] : undefined;
        n.line = no;
        if (pseudo) Object.assign(n, { kind: pseudo, label: '' });
        else n.label = label;
        if (st[6]) (n.description ??= []).push(mmdText(st[6]));
      }
      continue;
    }

    const note = /^note\s+(left|right|top|bottom)\s+of\s+([\p{L}\p{N}_.$-]+)\s*(?::\s*(.*))?$/iu.exec(text);
    if (note) {
      const target = state(note[2]!, no, false);
      const count = (notes.get(target.id) ?? 0) + 1;
      notes.set(target.id, count);
      const node: DNode = { id: count === 1 ? `note:${target.id}` : `note:${target.id}#${count}`, kind: 'note', label: mmdText(note[3] ?? ''), attachedTo: { id: target.id, side: note[1]!.toLowerCase() as NotePosition }, line: no };
      if (target.parent) node.parent = target.parent;
      nodes.set(node.id, node);
      add(node.id, target.id, { dashed: true, head: 'none', tail: 'none' }, no, { note: true });
      if (note[3] === undefined) pendingNote = { node, body: [] };
      continue;
    }

    const tr = TRANSITION_RE.exec(text);
    if (tr) {
      const from = ref(tr[1]!, no, 'from');
      const to = ref(tr[2]!, no, 'to');
      add(from.id, to.id, { dashed: false, head: 'arrow', tail: 'none' }, no, { label: tr[3] ? mmdText(tr[3]) : undefined });
      continue;
    }

    const desc = /^([\p{L}\p{N}_.$-]+)\s*:\s*(.+)$/u.exec(text);
    if (desc) {
      const node = state(desc[1]!, no, true);
      if ('kind' in node && !containers.has(node.id)) ((node as DNode).description ??= []).push(mmdText(desc[2]!));
      continue;
    }

    // A bare state name declares it.
    if (/^[\p{L}\p{N}_.$-]+(?::::[\w-]+)?$/u.test(text)) {
      state(text.replace(/:::.*$/, ''), no, true);
      continue;
    }

    warnings.push({ line: no, text: raw, message: 'Unsupported line, ignored' });
  }
  if (pendingNote) warnings.push({ line: pendingNote.node.line, text: '', message: 'note without end note' });
  if (stack.length) warnings.push({ line: lines.at(-1)?.no ?? 1, text: '', message: `state ${stack.at(-1)} without }` });
  return { diagram: { family: 'state', direction: dir, ...(fixed ? { directionFixed: true } : {}), nodes: [...nodes.values()], containers: [...containers.values()], edges }, warnings };
}

// ---- ER ----------------------------------------------------------------------------------------

/** Crow's-foot ends, symbol or word form, as seen from the left and the right entity. */
const ER_LEFT: Record<string, ArrowHead> = { '|o': 'crowZeroOne', 'o|': 'crowZeroOne', '||': 'crowOne', '}o': 'crowZeroMany', '}|': 'crowOneMany' };
const ER_RIGHT: Record<string, ArrowHead> = { 'o|': 'crowZeroOne', '|o': 'crowZeroOne', '||': 'crowOne', 'o{': 'crowZeroMany', '|{': 'crowOneMany' };
const ER_WORDS: Record<string, ArrowHead> = {
  'one or zero': 'crowZeroOne',
  'zero or one': 'crowZeroOne',
  'one or more': 'crowOneMany',
  'one or many': 'crowOneMany',
  'many(1)': 'crowOneMany',
  '1+': 'crowOneMany',
  'zero or more': 'crowZeroMany',
  'zero or many': 'crowZeroMany',
  'many(0)': 'crowZeroMany',
  '0+': 'crowZeroMany',
  'only one': 'crowOne',
  '1': 'crowOne',
};
const WORDS = Object.keys(ER_WORDS)
  .sort((a, b) => b.length - a.length)
  .map((w) => w.replace(/[()+]/g, '\\$&'))
  .join('|');
const ENTITY = String.raw`[\p{L}\p{N}_-]+|"[^"]+"`;
const ER_REL_RE = new RegExp(String.raw`^(${ENTITY})\s*(\|o|\|\||\}o|\}\||o\|)(--|\.\.|\.-|-\.)(o\||\|\||o\{|\|\{|\|o)\s*(${ENTITY})\s*(?::\s*(.*))?$`, 'u');
const ER_WORD_RE = new RegExp(String.raw`^(${ENTITY})\s+(${WORDS})\s+(to|optionally to)\s+(${WORDS})\s+(${ENTITY})\s*(?::\s*(.*))?$`, 'u');

export function parseMermaidEr(lines: Line[]): ParseResult {
  const warnings: ParseWarning[] = [];
  const nodes = new Map<string, DNode>();
  const { edges, add } = edgeBuilder();
  let dir: Diagram['direction'] = 'TB';
  let fixed = false;
  let body: { node: DNode; keys: string[]; rest: string[] } | undefined;

  const entity = (name: string, line: number): DNode => {
    const id = name.replace(/^"(.*)"$/, '$1');
    let node = nodes.get(id);
    if (!node) {
      node = { id, kind: 'class', classKind: 'entity', label: id, line };
      nodes.set(id, node);
    }
    return node;
  };

  for (const { no, raw, text } of lines) {
    if (body) {
      if (text === '}') {
        const { node, keys, rest } = body;
        node.compartments = keys.length && rest.length ? [keys, rest] : [[...keys, ...rest]];
        body = undefined;
        continue;
      }
      // type name [PK, FK] ["comment"]
      const a = /^([\p{L}\p{N}_\-()[\],~*]+)\s+([\p{L}\p{N}_\-()[\]*]+)\s*((?:PK|FK|UK)(?:\s*,\s*(?:PK|FK|UK))*)?\s*(?:"([^"]*)")?$/u.exec(text);
      if (!a) {
        warnings.push({ line: no, text: raw, message: 'Unsupported attribute, ignored' });
        continue;
      }
      const keys = a[3]?.replace(/\s+/g, '');
      const row = `${a[2]} : ${generics(a[1]!)}${keys ? ` ${keys.replace(/,/g, ', ')}` : ''}${a[4] ? ` — ${a[4]}` : ''}`;
      (keys?.includes('PK') ? body.keys : body.rest).push(row);
      continue;
    }
    const d = direction(text);
    if (d) {
      dir = d;
      fixed = true;
      continue;
    }
    if (IGNORED.test(text)) continue;

    const block = new RegExp(String.raw`^(${ENTITY})\s*(?:\[\s*"?([^"\]]*)"?\s*\])?\s*\{\s*(\})?$`, 'u').exec(text);
    if (block) {
      const node = entity(block[1]!, no);
      node.line = no;
      if (block[2]) node.label = mmdText(block[2]);
      if (!block[3]) body = { node, keys: [], rest: [] };
      continue;
    }

    const rel = ER_REL_RE.exec(text);
    const words = rel ? undefined : ER_WORD_RE.exec(text);
    if (rel || words) {
      const [left, right] = rel ? [rel[1]!, rel[5]!] : [words![1]!, words![5]!];
      const tail = rel ? ER_LEFT[rel[2]!]! : ER_WORDS[words![2]!]!;
      const head = rel ? ER_RIGHT[rel[4]!]! : ER_WORDS[words![4]!]!;
      const dashed = rel ? rel[3] !== '--' : words![3] === 'optionally to';
      const label = mmdText(rel ? (rel[6] ?? '') : (words![6] ?? ''));
      add(entity(left, no).id, entity(right, no).id, { dashed, head, tail }, no, { label: label || undefined });
      continue;
    }

    const alias = new RegExp(String.raw`^(${ENTITY})\s*\[\s*"?([^"\]]*)"?\s*\]$`, 'u').exec(text);
    if (alias || new RegExp(String.raw`^(${ENTITY})$`, 'u').test(text)) {
      const node = entity(alias?.[1] ?? text, no);
      if (alias) node.label = mmdText(alias[2]!);
      continue;
    }

    warnings.push({ line: no, text: raw, message: 'Unsupported line, ignored' });
  }
  if (body) warnings.push({ line: body.node.line, text: '', message: 'Entity without }' });
  return { diagram: { family: 'class', direction: dir, ...(fixed ? { directionFixed: true } : {}), nodes: [...nodes.values()], containers: [], edges }, warnings };
}
