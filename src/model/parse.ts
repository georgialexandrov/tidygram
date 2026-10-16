import type {
  ArrowHead,
  DContainer,
  DEdge,
  DNode,
  Diagram,
  EdgeKind,
  NodeKind,
  NotePosition,
  ParseWarning,
} from './types.ts';

/**
 * Parser for the PlantUML use case subset: actors, use cases, containers
 * (rectangle/package/frame/...), notes and relations. Anything else is
 * reported as a warning instead of failing, so a diagram that PlantUML
 * accepts never stops the editor.
 */

export interface ParseResult {
  diagram: Diagram;
  warnings: ParseWarning[];
}

const CONTAINER_KEYWORDS = ['rectangle', 'package', 'frame', 'node', 'folder', 'cloud', 'database'];
const IGNORED_PREFIXES = ['skinparam', 'title', 'hide', 'show', 'scale', 'caption', 'header', 'footer', 'allowmixing', 'together'];

// An element reference inside a relation: (use case), :actor:, "quoted" or a bare identifier.
const ELEM = String.raw`(?:\([^)]*\)|:[^:]+:|"[^"]*"|[\p{L}\p{N}_]+)`;
// Arrow: optional left head, body of - or ., optional [style], optional direction word, right head.
const ARROW = String.raw`(?:<\||<)?[-.]+(?:\[[^\]]*\])?(?:(?:left|right|up|down|le|ri|do|l|r|u|d)[-.]+)?(?:\|>|>)?`;
const RELATION_RE = new RegExp(String.raw`^(${ELEM})\s*(${ARROW})\s*(${ELEM})\s*(?::\s*(.*))?$`, 'u');

interface NameSpec {
  id: string;
  label: string;
  stereotype?: string;
  shape?: 'actor' | 'usecase';
}

function unescape(label: string): string {
  return label
    .replace(/\\n/g, '\n')
    .replace(/<<\s*([^>]*?)\s*>>/g, '«$1»')
    .trim();
}

function stripDecorations(text: string): { rest: string; stereotype?: string } {
  let stereotype: string | undefined;
  const rest = text
    .replace(/<<\s*([^>]*?)\s*>>/g, (_m, s: string) => {
      stereotype = s;
      return ' ';
    })
    .replace(/\s#[\w#;:.]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return { rest, stereotype };
}

function parseAtom(text: string): { value: string; shape?: 'actor' | 'usecase'; quoted: boolean } {
  const t = text.trim();
  if (t.startsWith('"') && t.endsWith('"')) return { value: t.slice(1, -1), quoted: true };
  if (t.startsWith('(') && t.endsWith(')')) return { value: t.slice(1, -1), shape: 'usecase', quoted: true };
  if (t.startsWith(':') && t.endsWith(':') && t.length > 1) return { value: t.slice(1, -1), shape: 'actor', quoted: true };
  return { value: t, quoted: false };
}

/** Parses `"Label" as Alias`, `Alias as "Label"`, `(Label) as A`, `:Label:`, `Name`. */
function parseNameSpec(text: string): NameSpec | undefined {
  const { rest, stereotype } = stripDecorations(text);
  if (!rest) return undefined;
  const asMatch = /^(.*?)\s+as\s+(.*)$/.exec(rest);
  if (asMatch) {
    const left = parseAtom(asMatch[1]!);
    const right = parseAtom(asMatch[2]!);
    // Whichever side is quoted is the label; `A as B` with neither quoted means label A, alias B.
    if (!left.quoted && right.quoted) {
      return { id: left.value, label: unescape(right.value), stereotype, shape: right.shape };
    }
    return { id: right.value, label: unescape(left.value), stereotype, shape: left.shape };
  }
  const atom = parseAtom(rest);
  return { id: atom.value, label: unescape(atom.value), stereotype, shape: atom.shape };
}

interface ParsedArrow {
  dashed: boolean;
  leftHead: ArrowHead;
  rightHead: ArrowHead;
  hidden: boolean;
}

function parseArrow(arrow: string): ParsedArrow {
  const style = /\[([^\]]*)\]/.exec(arrow)?.[1] ?? '';
  const body = arrow.replace(/\[[^\]]*\]/, '');
  const leftHead: ArrowHead = body.startsWith('<|') ? 'triangle' : body.startsWith('<') ? 'arrow' : 'none';
  const rightHead: ArrowHead = body.endsWith('|>') ? 'triangle' : body.endsWith('>') ? 'arrow' : 'none';
  return { dashed: body.includes('.'), leftHead, rightHead, hidden: /\bhidden\b/.test(style) };
}

export function parsePuml(source: string): ParseResult {
  const nodes = new Map<string, DNode>();
  const containers = new Map<string, DContainer>();
  const edges: DEdge[] = [];
  const warnings: ParseWarning[] = [];
  const stack: string[] = [];
  const edgeIdCounts = new Map<string, number>();
  const noteCounts = new Map<string, number>();
  let direction: Diagram['direction'] = 'TB';

  const currentParent = () => stack[stack.length - 1];

  const addNode = (node: Omit<DNode, 'parent'> & { parent?: string }): DNode => {
    const existing = nodes.get(node.id);
    if (existing) return existing;
    const created: DNode = { ...node, parent: node.parent ?? currentParent() };
    if (created.parent === undefined) delete created.parent;
    nodes.set(created.id, created);
    return created;
  };

  const findByLabel = (label: string, kind?: NodeKind) => {
    for (const n of nodes.values()) if (n.label === label && (!kind || n.kind === kind)) return n;
    return undefined;
  };

  /** Resolves an element reference in a relation, creating it implicitly like PlantUML does. */
  const resolveRef = (text: string, line: number): DNode => {
    const atom = parseAtom(text);
    const byId = nodes.get(atom.value);
    if (byId) return byId;
    const byLabel = findByLabel(unescape(atom.value), atom.shape);
    if (byLabel) return byLabel;
    const kind: NodeKind = atom.shape ?? 'actor';
    return addNode({ id: atom.value, kind, label: unescape(atom.value), line });
  };

  const nextNoteId = (target: string) => {
    const n = (noteCounts.get(target) ?? 0) + 1;
    noteCounts.set(target, n);
    return n === 1 ? `note:${target}` : `note:${target}#${n}`;
  };

  const addEdge = (from: DNode, to: DNode, arrow: ParsedArrow, label: string | undefined, line: number) => {
    let src = from;
    let dst = to;
    let head = arrow.rightHead;
    let tail = arrow.leftHead;
    // Normalise `A <-- B` to `B --> A` so the id and the arrow direction agree.
    if (tail !== 'none' && head === 'none') {
      [src, dst] = [dst, src];
      [head, tail] = [tail, head];
    }
    const touchesNote = src.kind === 'note' || dst.kind === 'note';
    const kind: EdgeKind = touchesNote
      ? 'noteLink'
      : head === 'triangle' || tail === 'triangle'
        ? 'generalization'
        : arrow.dashed
          ? 'dependency'
          : 'association';
    const op =
      (tail === 'triangle' ? '<|' : tail === 'arrow' ? '<' : '') +
      (arrow.dashed ? '..' : '--') +
      (head === 'triangle' ? '|>' : head === 'arrow' ? '>' : '');
    const base = `${src.id}${op}${dst.id}`;
    const count = (edgeIdCounts.get(base) ?? 0) + 1;
    edgeIdCounts.set(base, count);
    const edge: DEdge = {
      id: count === 1 ? base : `${base}#${count}`,
      from: src.id,
      to: dst.id,
      kind,
      dashed: arrow.dashed || kind === 'noteLink',
      head,
      tail,
      hidden: arrow.hidden,
      line,
    };
    if (label) edge.label = unescape(label);
    edges.push(edge);
  };

  const lines = source.split(/\r?\n/);
  let inBlockComment = false;
  let skipBlockDepth = 0;
  let pendingNote: { node: DNode; body: string[] } | undefined;

  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1;
    const raw = lines[i]!;
    let text = raw.trim();

    if (inBlockComment) {
      const end = text.indexOf("'/");
      if (end === -1) continue;
      inBlockComment = false;
      text = text.slice(end + 2).trim();
    }
    if (text.startsWith("/'")) {
      if (!text.includes("'/", 2)) inBlockComment = true;
      continue;
    }

    if (pendingNote) {
      if (/^end\s*note$/i.test(text)) {
        pendingNote.node.label = pendingNote.body.join('\n').trim();
        pendingNote = undefined;
      } else {
        pendingNote.body.push(raw.trim());
      }
      continue;
    }

    if (skipBlockDepth > 0) {
      if (text.endsWith('{')) skipBlockDepth++;
      if (text === '}') skipBlockDepth--;
      continue;
    }

    if (!text || text.startsWith("'") || text.startsWith('@') || text.startsWith('!')) continue;

    const keyword = text.split(/\s+/)[0]!.toLowerCase();
    if (IGNORED_PREFIXES.includes(keyword)) {
      if (text.endsWith('{')) skipBlockDepth = 1;
      continue;
    }
    if (/^legend\b/i.test(text)) {
      while (i + 1 < lines.length && !/^end\s*legend$/i.test(lines[i + 1]!.trim())) i++;
      i++;
      continue;
    }

    if (/^left\s+to\s+right\s+direction$/i.test(text)) {
      direction = 'LR';
      continue;
    }
    if (/^top\s+to\s+bottom\s+direction$/i.test(text)) {
      direction = 'TB';
      continue;
    }

    if (text === '}') {
      if (stack.length === 0) warnings.push({ line: lineNo, text: raw, message: 'Unmatched }' });
      stack.pop();
      continue;
    }

    // Containers: `rectangle "Shop" as Shop {`
    if (CONTAINER_KEYWORDS.includes(keyword) && text.endsWith('{')) {
      const spec = parseNameSpec(text.slice(keyword.length, -1));
      if (!spec) {
        warnings.push({ line: lineNo, text: raw, message: 'Container without a name' });
        stack.push(`__anon${lineNo}`);
        continue;
      }
      const container: DContainer = { id: spec.id, kind: keyword, label: spec.label, line: lineNo };
      const parent = currentParent();
      if (parent) container.parent = parent;
      containers.set(spec.id, container);
      stack.push(spec.id);
      continue;
    }

    // Notes.
    const noteOf = /^note\s+(left|right|top|bottom)\s+of\s+(.+?)(?:\s*:\s*(.*))?$/i.exec(text);
    if (noteOf) {
      const side = noteOf[1]!.toLowerCase() as NotePosition;
      const target = resolveRef(noteOf[2]!.trim(), lineNo);
      const id = nextNoteId(target.id);
      const node = addNode({
        id,
        kind: 'note',
        label: unescape(noteOf[3] ?? ''),
        attachedTo: { id: target.id, side },
        parent: target.parent,
        line: lineNo,
      });
      addEdge(node, target, { dashed: true, leftHead: 'none', rightHead: 'none', hidden: false }, undefined, lineNo);
      if (noteOf[3] === undefined) pendingNote = { node, body: [] };
      continue;
    }
    const noteAs = /^note\s+"([^"]*)"\s+as\s+([\p{L}\p{N}_]+)$/iu.exec(text);
    if (noteAs) {
      addNode({ id: noteAs[2]!, kind: 'note', label: unescape(noteAs[1]!), line: lineNo });
      continue;
    }
    const noteBlock = /^note\s+as\s+([\p{L}\p{N}_]+)$/iu.exec(text);
    if (noteBlock) {
      const node = addNode({ id: noteBlock[1]!, kind: 'note', label: '', line: lineNo });
      pendingNote = { node, body: [] };
      continue;
    }

    // Declarations.
    const decl = /^(actor|usecase)\s+(.+)$/i.exec(text);
    if (decl) {
      const spec = parseNameSpec(decl[2]!);
      if (!spec) continue;
      const node = addNode({ id: spec.id, kind: decl[1]!.toLowerCase() as NodeKind, label: spec.label, line: lineNo });
      if (spec.stereotype) node.stereotype = spec.stereotype;
      continue;
    }

    const relation = RELATION_RE.exec(text);
    if (relation) {
      const from = resolveRef(relation[1]!, lineNo);
      const to = resolveRef(relation[3]!, lineNo);
      addEdge(from, to, parseArrow(relation[2]!), relation[4], lineNo);
      continue;
    }

    // Bare `(Use case) as UC` or `:Actor: as A` declarations.
    if (/^[(:]/.test(text)) {
      const spec = parseNameSpec(text);
      if (spec?.shape) {
        const node = addNode({ id: spec.id, kind: spec.shape, label: spec.label, line: lineNo });
        if (spec.stereotype) node.stereotype = spec.stereotype;
        continue;
      }
    }

    warnings.push({ line: lineNo, text: raw, message: 'Unsupported line, ignored' });
  }

  if (pendingNote) warnings.push({ line: pendingNote.node.line, text: '', message: 'note without end note' });

  return {
    diagram: { direction, nodes: [...nodes.values()], containers: [...containers.values()], edges },
    warnings,
  };
}
