import type {
  ArrowHead,
  ClassKind,
  DContainer,
  DEdge,
  DNode,
  Diagram,
  DiagramFamily,
  EdgeKind,
  NodeKind,
  NotePosition,
  ParseWarning,
} from './types.ts';
import { parseSequence } from './puml-sequence.ts';
import { parseActivity } from './puml-activity.ts';
import { parseGantt } from './puml-gantt.ts';
import { parseTiming } from './puml-timing.ts';
import { parseData } from './puml-json.ts';
import { parseChen } from './puml-chen.ts';
import { parseNwdiag } from './puml-nwdiag.ts';
import { parseAtom, parseNameSpec, splitArgs, stripDecorations, unescape, unquote, type Line } from './puml-util.ts';

/**
 * PlantUML parser for the box-and-line diagram types: use case, component,
 * deployment, class, object, ER, state, C4, ArchiMate, plus mindmap/WBS
 * trees. JSON/YAML, Chen ER and nwdiag have their own small readers.
 *
 * PlantUML reads some keywords differently per diagram type (`interface` is
 * a lollipop in a component diagram and a class box in a class diagram; `{`
 * opens a container in one and a member list in the other), so the family
 * is detected first. Anything not understood becomes a warning, never an
 * error: a diagram PlantUML accepts must never stop the editor.
 */

export interface ParseResult {
  diagram: Diagram;
  warnings: ParseWarning[];
  /**
   * Set when the file is a diagram type we recognise but have no layout model
   * for (`Salt (wireframe)`, `Pie`, ...): the editor shows a panel saying so
   * instead of an empty canvas, and writes no sidecar.
   */
  unsupported?: string;
  /**
   * Multi-page draw.io files only: every page in file order (`key` is the page
   * id, which keys its layout in the sidecar's `pages`; `name` is what draw.io
   * shows on the tab), and the index of the page that was parsed.
   */
  pages?: { key: string; name: string }[];
  page?: number;
}

/** Which page of a multi-page file to read: a 0-based index, or a page id or name. Default: the first. */
export interface ParseOptions {
  page?: number | string;
}

/** Diagram types that need a different layout model; recognised so we can say so. */
const UNSUPPORTED_TAGS: Record<string, string> = {
  startgantt: 'Gantt',
  startsalt: 'Salt (wireframe)',
  startregex: 'Regex',
  startebnf: 'EBNF',
  startmath: 'Math',
  startlatex: 'LaTeX',
  startditaa: 'Ditaa',
  startchronology: 'Chronology',
  startwire: 'Wire',
  startfiles: 'Files',
  startboard: 'Board',
};

const DESCRIPTION_KINDS: Record<string, NodeKind> = {
  actor: 'actor',
  agent: 'agent',
  artifact: 'artifact',
  boundary: 'boundary',
  card: 'card',
  circle: 'circle',
  cloud: 'cloud',
  collections: 'collections',
  component: 'component',
  control: 'control',
  database: 'database',
  entity: 'entity',
  file: 'file',
  folder: 'folder',
  frame: 'frame',
  hexagon: 'hexagon',
  interface: 'interface',
  label: 'label',
  node: 'node',
  package: 'folder',
  person: 'person',
  process: 'process',
  queue: 'queue',
  rectangle: 'rectangle',
  stack: 'stack',
  storage: 'storage',
  usecase: 'usecase',
};

const CLASS_KINDS: Record<string, ClassKind> = {
  class: 'class',
  'abstract class': 'abstract',
  abstract: 'abstract',
  interface: 'interface',
  enum: 'enum',
  annotation: 'annotation',
  entity: 'entity',
  object: 'object',
  map: 'map',
  struct: 'struct',
  protocol: 'protocol',
  exception: 'exception',
  record: 'record',
  metaclass: 'class',
  stereotype: 'class',
  dataclass: 'class',
};

/** Keywords that open a container with `{` in description/class/state diagrams. */
const CONTAINER_KEYWORDS = ['package', 'namespace', 'rectangle', 'frame', 'folder', 'node', 'cloud', 'database', 'component', 'card', 'hexagon', 'storage', 'artifact', 'file', 'queue', 'stack', 'agent'];

const IGNORED_PREFIXES = ['skinparam', 'title', 'hide', 'show', 'scale', 'caption', 'header', 'footer', 'allowmixing', 'allow_mixing', 'remove', 'restore', 'set', 'sprite', 'mainframe'];

// ---- element references and arrows ----------------------------------------------------------------

const NAME = String.raw`[\p{L}\p{N}_.$:]+(?:<[^>\s]*>)?`;
// [*] | [Component] | () Interface | () "Interface" | (use case) | :actor: | "quoted" | bare
const ELEM = String.raw`(?:\[\*\]|\[H\*?\]|\[[^\]]+\]|\(\)\s*"[^"]*"|\(\)\s*${NAME}|\([^)]*\)|:[^:\s][^:]*:|"[^"]*"|${NAME})`;
const LEFT_HEAD = String.raw`(?:<\||<<|<|\*|o|#|x|\+|\^|\}o|\}\||\|o|\|\||\}|0)`;
const RIGHT_HEAD = String.raw`(?:\|>|>>|>|\*|o|#|x|\+|\^|o\{|\|\{|o\||\|\||\{|0)`;
const BODY = String.raw`[-.=]+(?:\[[^\]]*\])?(?:(?:left|right|up|down|le|ri|do|l|r|u|d)(?=[-.=]))?[-.=]*`;
const ARROW = String.raw`(?:${LEFT_HEAD})?${BODY}(?:${RIGHT_HEAD}(?=[\s"]|$))?`;
const MULT = String.raw`"[^"]*"`;
const RELATION_RE = new RegExp(String.raw`^(${ELEM})\s*(${MULT})?\s*(${ARROW})\s*(${MULT})?\s*(${ELEM})\s*(?::\s*(.*))?$`, 'u');

const LEFT_HEADS: Record<string, ArrowHead> = {
  '<|': 'triangle',
  '<<': 'arrow',
  '<': 'arrow',
  '*': 'diamondFilled',
  o: 'diamond',
  '#': 'square',
  x: 'cross',
  '+': 'circlePlus',
  '^': 'triangle',
  '}o': 'crowZeroMany',
  '}|': 'crowOneMany',
  '|o': 'crowZeroOne',
  '||': 'crowOne',
  '}': 'crowMany',
  '0': 'circle',
};
const RIGHT_HEADS: Record<string, ArrowHead> = {
  '|>': 'triangle',
  '>>': 'arrow',
  '>': 'arrow',
  '*': 'diamondFilled',
  o: 'diamond',
  '#': 'square',
  x: 'cross',
  '+': 'circlePlus',
  '^': 'triangle',
  'o{': 'crowZeroMany',
  '|{': 'crowOneMany',
  'o|': 'crowZeroOne',
  '||': 'crowOne',
  '{': 'crowMany',
  '0': 'circle',
};
/** How a head is written at the end of an arrow (`--|>`) and at its start (`<|--`); used to build edge ids. */
export const HEAD_TOKENS: Record<ArrowHead, [start: string, end: string]> = {
  none: ['', ''],
  arrow: ['<', '>'],
  triangle: ['<|', '|>'],
  diamond: ['o', 'o'],
  diamondFilled: ['*', '*'],
  circle: ['0', '0'],
  circlePlus: ['+', '+'],
  cross: ['x', 'x'],
  square: ['#', '#'],
  dot: ['@', '@'],
  crowZeroOne: ['|o', 'o|'],
  crowOne: ['||', '||'],
  crowZeroMany: ['}o', 'o{'],
  crowOneMany: ['}|', '|{'],
  crowMany: ['}', '{'],
};

interface ParsedArrow {
  dashed: boolean;
  leftHead: ArrowHead;
  rightHead: ArrowHead;
  hidden: boolean;
}

function parseArrow(arrow: string): ParsedArrow {
  const style = /\[([^\]]*)\]/.exec(arrow)?.[1] ?? '';
  const plain = arrow.replace(/\[[^\]]*\]/, '').replace(/(left|right|up|down|le|ri|do|l|r|u|d)(?=[-.=])/, '');
  const m = /^(.*?)([-.=]+)(.*)$/.exec(plain)!;
  const left = m[1] ?? '';
  const right = m[3] ?? '';
  return {
    dashed: m[2]!.includes('.') || /\b(dashed|dotted)\b/.test(style),
    leftHead: LEFT_HEADS[left] ?? 'none',
    rightHead: RIGHT_HEADS[right] ?? 'none',
    hidden: /\bhidden\b/.test(style),
  };
}

// ---- family detection ------------------------------------------------------------------------


function detectFamily(lines: Line[]): DiagramFamily | { unsupported: string } {
  const texts = lines.map((l) => l.text);
  const any = (re: RegExp) => texts.some((t) => re.test(t));
  if (any(/^archimate\s/) || any(/^!include\s*<archimate/i) || any(ARCHIMATE_ELEMENT_RE) || any(ARCHIMATE_REL_RE)) return 'archimate';
  if (any(/^(Person|System|Container|Component|Rel|BiRel|Boundary|System_Boundary|Container_Boundary|Enterprise_Boundary|Deployment_Node)(_\w+)?\s*\(/) || any(/^!include.*C4/i)) return 'c4';
  if (any(/^(participant|activate|deactivate|autonumber|alt\b|loop\b|ref over|note over|group\b|par\b|box\b|newpage|return\b)/)) return { unsupported: 'Sequence' };
  if (any(/^(start|stop|end|endif|endwhile|fork|end fork|repeat|kill|detach)$/) || any(/^:.*;$/) || any(/^(if|while)\s*\(/)) return { unsupported: 'Activity' };
  if (any(/^(robust|concise|clock|binary)\s/)) return { unsupported: 'Timing' };
  if (any(/^state\s/) || any(/\[\*\]/)) return 'state';
  if (any(/^(abstract class|abstract|class|enum|annotation|struct|protocol|exception|metaclass|record|dataclass|object|map)\s/) || any(/^(entity|interface)\s+.*\{\s*$/) || any(/^[\w.$]+\s*:\s*[-+#~]?\s*\w+\s*\(/)) {
    return 'class';
  }
  // A file of bare `A -> B : message` lines is a sequence diagram to PlantUML.
  const declarations = any(new RegExp(`^(${Object.keys(DESCRIPTION_KINDS).join('|')})\\s`)) || any(/[[(]|:\w[^:]*:/);
  if (!declarations && any(/^\S+\s*-+>+\s*\S+\s*:/)) return { unsupported: 'Sequence' };
  return 'description';
}

// ---- main ----------------------------------------------------------------------------------------

export function parsePuml(source: string): ParseResult {
  const nodes = new Map<string, DNode>();
  const containers = new Map<string, DContainer>();
  const edges: DEdge[] = [];
  const warnings: ParseWarning[] = [];
  /** Container ids; '' marks a non-container block such as `together {`. */
  const stack: string[] = [];
  const edgeIdCounts = new Map<string, number>();
  const noteCounts = new Map<string, number>();
  const implicit = new Set<string>();
  let direction: Diagram['direction'] = 'TB';
  let directionFixed = false;

  // Pre-pass: block comments, line continuation, start tag.
  const rawLines = source.split(/\r?\n/);
  const lines: Line[] = [];
  let inBlockComment = false;
  let startTag = 'startuml';
  for (let i = 0; i < rawLines.length; i++) {
    let text = rawLines[i]!.trim();
    if (inBlockComment) {
      const end = text.indexOf("'/");
      if (end === -1) continue;
      inBlockComment = false;
      text = text.slice(end + 2).trim();
    }
    const open = text.indexOf("/'");
    if (open !== -1) {
      const close = text.indexOf("'/", open + 2);
      if (close === -1) {
        inBlockComment = true;
        text = text.slice(0, open).trim();
      } else {
        text = (text.slice(0, open) + text.slice(close + 2)).trim();
      }
    }
    const tag = /^@(start\w+)/.exec(text);
    if (tag) startTag = tag[1]!.toLowerCase();
    lines.push({ no: i + 1, raw: rawLines[i]!, text });
  }

  const empty = (family: DiagramFamily): ParseResult => ({ diagram: { family, direction, nodes: [], containers: [], edges: [] }, warnings });

  if (startTag === 'startgantt') return parseGantt(lines);
  if (startTag === 'startjson' || startTag === 'startyaml') return parseData(lines, startTag === 'startjson' ? 'json' : 'yaml');
  if (startTag === 'startchen') return parseChen(lines);
  if (startTag === 'startnwdiag') return parseNwdiag(lines);
  if (UNSUPPORTED_TAGS[startTag]) {
    warnings.push({ line: 1, text: '', message: `${UNSUPPORTED_TAGS[startTag]} diagrams are not supported yet` });
    return { ...empty('description'), unsupported: UNSUPPORTED_TAGS[startTag] };
  }
  if (startTag === 'startmindmap' || startTag === 'startwbs') return parseTree(lines, startTag === 'startwbs' ? 'wbs' : 'mindmap');

  const detected = detectFamily(lines);
  if (typeof detected !== 'string' && detected.unsupported === 'Sequence') return parseSequence(lines);
  if (typeof detected !== 'string' && detected.unsupported === 'Activity') return parseActivity(lines);
  if (typeof detected !== 'string' && detected.unsupported === 'Timing') return parseTiming(lines);
  if (typeof detected !== 'string') {
    warnings.push({ line: 1, text: '', message: `${detected.unsupported} diagrams are not supported yet` });
    return { ...empty('description'), unsupported: detected.unsupported };
  }
  const family = detected;

  const currentParent = () => {
    for (let i = stack.length - 1; i >= 0; i--) if (stack[i]) return stack[i];
    return undefined;
  };

  const addNode = (node: Omit<DNode, 'parent'> & { parent?: string }): DNode => {
    const existing = nodes.get(node.id);
    if (existing) {
      // A later declaration refines an implicit one (`A --> B` before `class B`).
      if (implicit.has(node.id)) {
        implicit.delete(node.id);
        Object.assign(existing, { ...node, parent: existing.parent ?? node.parent ?? currentParent() });
      }
      return existing;
    }
    const created: DNode = { ...node, parent: node.parent ?? currentParent() };
    if (created.parent === undefined) delete created.parent;
    nodes.set(created.id, created);
    return created;
  };

  const findByLabel = (label: string) => {
    for (const n of nodes.values()) if (n.label === label) return n;
    return undefined;
  };

  /** State pseudo-states are scoped per composite state: `[*]` inside `Busy` is `[*]@Busy`. */
  const pseudoId = (base: string) => (currentParent() ? `${base}@${currentParent()}` : base);

  const defaultKind = (): NodeKind => (family === 'class' ? 'class' : family === 'state' ? 'state' : family === 'archimate' ? 'rectangle' : 'actor');

  /** Resolves an element reference in a relation, creating it implicitly like PlantUML does. */
  const resolveRef = (text: string, line: number, end: 'from' | 'to'): DNode | DContainer => {
    const atom = parseAtom(text);
    if (atom.shape === 'initial') {
      const id = pseudoId(end === 'from' ? '[*]' : '[*]end');
      return addNode({ id, kind: end === 'from' ? 'initial' : 'final', label: '', line });
    }
    if (/^\[H\*?\]$/.test(text.trim())) return addNode({ id: pseudoId(text.trim()), kind: 'history', label: text.trim().slice(1, -1), line });
    const byId = nodes.get(atom.value) ?? containers.get(atom.value);
    if (byId) return byId;
    const byLabel = findByLabel(unescape(atom.value));
    if (byLabel) return byLabel;
    const kind: NodeKind = atom.shape ?? defaultKind();
    const node = addNode({ id: atom.value, kind, label: unescape(atom.value), line });
    if (!atom.shape) implicit.add(node.id);
    if (kind === 'class') node.classKind = 'class';
    return node;
  };

  const nextNoteId = (target: string) => {
    const n = (noteCounts.get(target) ?? 0) + 1;
    noteCounts.set(target, n);
    return n === 1 ? `note:${target}` : `note:${target}#${n}`;
  };

  const isNote = (x: DNode | DContainer) => 'kind' in x && x.kind === 'note';

  const addEdge = (
    from: DNode | DContainer,
    to: DNode | DContainer,
    arrow: ParsedArrow,
    label: string | undefined,
    line: number,
    ends: { from?: string; to?: string } = {},
  ) => {
    let src = from;
    let dst = to;
    let head = arrow.rightHead;
    let tail = arrow.leftHead;
    let fromLabel = ends.from;
    let toLabel = ends.to;
    let reversed = false;
    // Normalise `A <-- B` to `B --> A` so the id and the arrow direction agree.
    if (tail !== 'none' && head === 'none') {
      [src, dst] = [dst, src];
      [head, tail] = [tail, head];
      [fromLabel, toLabel] = [toLabel, fromLabel];
      reversed = true;
    }
    const heads = [head, tail];
    const kind: EdgeKind =
      isNote(src) || isNote(dst)
        ? 'noteLink'
        : heads.includes('triangle')
          ? arrow.dashed
            ? 'realization'
            : 'generalization'
          : heads.includes('diamondFilled')
            ? 'composition'
            : heads.includes('diamond')
              ? 'aggregation'
              : arrow.dashed
                ? 'dependency'
                : 'association';
    const op = HEAD_TOKENS[tail][0] + (arrow.dashed ? '..' : '--') + HEAD_TOKENS[head][1];
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
    if (reversed) edge.reversed = true;
    if (label) edge.label = unescape(label.replace(/^\s*[<>]\s+|\s+[<>]\s*$/g, ''));
    if (fromLabel) edge.fromLabel = unescape(fromLabel);
    if (toLabel) edge.toLabel = unescape(toLabel);
    edges.push(edge);
  };

  const addContainer = (id: string, kind: string, label: string, line: number, stereotype?: string) => {
    // `A --> Busy` before `state Busy {`: the implicit node becomes the container; edges keep pointing at the id.
    if (nodes.has(id) && implicit.has(id)) {
      nodes.delete(id);
      implicit.delete(id);
    }
    const container: DContainer = { id, kind, label, line };
    const parent = currentParent();
    if (parent) container.parent = parent;
    if (stereotype) container.stereotype = stereotype;
    containers.set(id, container);
    stack.push(id);
  };

  let skipBlockDepth = 0;
  let skipUntil: RegExp | undefined;
  let pendingNote: { node: DNode; body: string[] } | undefined;
  let pendingBody: { node: DNode; sections: string[][]; explicit: boolean } | undefined;

  const finishBody = () => {
    if (!pendingBody) return;
    const { node, sections, explicit } = pendingBody;
    const filled = sections.map((s) => s.filter(Boolean));
    if (explicit) node.compartments = filled;
    else {
      // PlantUML puts fields before methods in separate compartments unless told otherwise.
      const all = filled.flat();
      const methods = all.filter((m) => m.includes('('));
      const fields = all.filter((m) => !m.includes('('));
      node.compartments = methods.length && node.classKind !== 'enum' ? [fields, methods] : [all];
    }
    pendingBody = undefined;
  };

  const member = (text: string) => text.replace(/\{(static|abstract|classifier|field|method)\}\s*/g, '').trim();

  const addMember = (node: DNode, text: string) => {
    const m = member(text);
    if (!m) return;
    node.compartments ??= [[], []];
    if (node.compartments.length === 1) node.compartments.push([]);
    (m.includes('(') ? node.compartments[1]! : node.compartments[0]!).push(m);
  };

  for (let i = 0; i < lines.length; i++) {
    const { no: lineNo, raw } = lines[i]!;
    const text = lines[i]!.text;

    if (pendingNote) {
      if (/^end\s*note$/i.test(text)) {
        pendingNote.node.label = pendingNote.body.join('\n').trim();
        pendingNote = undefined;
      } else {
        pendingNote.body.push(text);
      }
      continue;
    }

    if (pendingBody) {
      if (text === '}') {
        finishBody();
        continue;
      }
      if (/^(--|==|\.\.|__)/.test(text)) {
        pendingBody.explicit = true;
        pendingBody.sections.push([]);
        continue;
      }
      const sections = pendingBody.sections;
      const m = member(text);
      if (m) sections[sections.length - 1]!.push(m);
      continue;
    }

    if (skipUntil) {
      if (skipUntil.test(text)) skipUntil = undefined;
      continue;
    }
    if (skipBlockDepth > 0) {
      if (text.endsWith('{')) skipBlockDepth++;
      if (text === '}') skipBlockDepth--;
      continue;
    }

    if (!text || text.startsWith("'") || text.startsWith('@') || text.startsWith('!')) continue;

    const keyword = text.split(/[\s(]+/)[0]!.toLowerCase();
    if (IGNORED_PREFIXES.includes(keyword)) {
      if (text.endsWith('{')) skipBlockDepth = 1;
      else if (/^(title|header|footer|caption)$/i.test(text)) skipUntil = new RegExp(`^end\\s*${keyword}$`, 'i');
      continue;
    }
    if (/^legend\b/i.test(text)) {
      skipUntil = /^end\s*legend$/i;
      continue;
    }
    if (/^LAYOUT_LEFT_RIGHT\b|^LAYOUT_LANDSCAPE\b/.test(text)) {
      direction = 'LR';
      continue;
    }
    if (/^(LAYOUT_|SHOW_|HIDE_|UpdateElementStyle|UpdateRelStyle|AddElementTag|AddRelTag|AddBoundaryTag|SetDefaultLegendEntries|SHOW_LEGEND|LAYOUT)/.test(text)) continue;

    if (/^left\s+to\s+right\s+direction$/i.test(text)) {
      direction = 'LR';
      continue;
    }
    if (/^top\s+to\s+bottom\s+direction$/i.test(text)) {
      direction = 'TB';
      directionFixed = true;
      continue;
    }
    // Concurrent-region separators inside composite states.
    if (family === 'state' && /^(--|\|\|)$/.test(text)) continue;

    if (text === '}') {
      if (stack.length === 0) warnings.push({ line: lineNo, text: raw, message: 'Unmatched }' });
      stack.pop();
      continue;
    }
    if (/^together\s*\{$/i.test(text)) {
      stack.push('');
      continue;
    }

    // ---- C4 ----
    if (family === 'c4') {
      const handled = parseC4(text, lineNo);
      if (handled) continue;
    }

    if (family === 'archimate' && parseArchimate(text, lineNo)) continue;

    // ---- containers: `package "Shop" as Shop {`, `node Server {`, `state Busy {` ----
    const containerMatch = /^([a-z_]+)\s+(.+?)\s*\{$/i.exec(text);
    if (containerMatch) {
      const kw = containerMatch[1]!.toLowerCase();
      const classBody = family === 'class' && (CLASS_KINDS[kw] !== undefined || /^abstract class$/i.test(`${kw} ${containerMatch[2]!.split(' ')[0]}`));
      if (!classBody && (CONTAINER_KEYWORDS.includes(kw) || (family === 'state' && kw === 'state'))) {
        const spec = parseNameSpec(containerMatch[2]!);
        if (!spec) {
          stack.push('');
          continue;
        }
        addContainer(spec.id, kw, spec.label, lineNo, spec.stereotype);
        continue;
      }
    }

    // ---- notes ----
    const noteOf = /^note\s+(left|right|top|bottom)\s+of\s+(.+?)(?:\s*:\s*(.*))?$/i.exec(text);
    if (noteOf) {
      const side = noteOf[1]!.toLowerCase() as NotePosition;
      const target = resolveRef(noteOf[2]!.trim(), lineNo, 'to');
      const id = nextNoteId(target.id);
      const parent = 'kind' in target && (target as DNode).attachedTo === undefined ? (target as DNode).parent : target.parent;
      const node = addNode({ id, kind: 'note', label: unescape(noteOf[3] ?? ''), attachedTo: { id: target.id, side }, parent, line: lineNo });
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
    if (/^note\s+on\s+link/i.test(text)) {
      if (!text.includes(':')) skipUntil = /^end\s*note$/i;
      warnings.push({ line: lineNo, text: raw, message: 'Notes on links are not drawn yet' });
      continue;
    }

    // ---- class-like declarations ----
    if (family === 'class') {
      const cls = /^(abstract\s+class|abstract|class|interface|enum|annotation|entity|object|map|struct|protocol|exception|record|metaclass|stereotype|dataclass)\s+(.+?)(\s*\{\s*(.*?)\s*(\})?)?$/i.exec(text);
      if (cls) {
        const kw = cls[1]!.toLowerCase().replace(/\s+/, ' ');
        let rest = cls[2]!;
        const ext = /\s+(extends|implements)\s+(.+)$/i.exec(rest);
        if (ext) rest = rest.slice(0, ext.index);
        const spec = parseNameSpec(rest);
        if (!spec) continue;
        const node = addNode({ id: spec.id, kind: 'class', label: spec.label, line: lineNo });
        node.classKind = CLASS_KINDS[kw] ?? 'class';
        if (spec.stereotype) node.stereotype = spec.stereotype;
        if (ext) {
          for (const part of ext[0].matchAll(/(extends|implements)\s+([^\s,]+(?:\s*,\s*[^\s,]+)*)/gi)) {
            for (const parentName of part[2]!.split(/\s*,\s*/)) {
              const parent = resolveRef(parentName, lineNo, 'to');
              addEdge(node, parent, { dashed: part[1]!.toLowerCase() === 'implements', leftHead: 'none', rightHead: 'triangle', hidden: false }, undefined, lineNo);
            }
          }
        }
        if (cls[3]) {
          if (cls[5]) {
            // One-line body: `class A { +x; +y() }`
            for (const m of (cls[4] ?? '').split(/;/)) addMember(node, m);
          } else {
            pendingBody = { node, sections: [[]], explicit: false };
          }
        }
        continue;
      }
      // `Class : member`
      const memberLine = /^([\p{L}\p{N}_.$]+)\s*:\s*(.+)$/u.exec(text);
      if (memberLine && !RELATION_RE.test(text)) {
        const node = nodes.get(memberLine[1]!) ?? resolveRef(memberLine[1]!, lineNo, 'from');
        if ('kind' in node && node.kind === 'class') addMember(node as DNode, memberLine[2]!);
        continue;
      }
    }

    // ---- state declarations ----
    if (family === 'state') {
      const st = /^state\s+(.+?)(?:\s*:\s*(.*))?$/i.exec(text);
      if (st) {
        const spec = parseNameSpec(st[1]!);
        if (!spec) continue;
        const pseudo: Record<string, NodeKind> = { choice: 'choice', fork: 'fork', join: 'fork', start: 'initial', end: 'final', history: 'history', 'history*': 'history', entrypoint: 'initial', exitpoint: 'final' };
        const kind = (spec.stereotype && pseudo[spec.stereotype.toLowerCase()]) || 'state';
        const node = addNode({ id: spec.id, kind, label: kind === 'state' ? spec.label : '', line: lineNo });
        if (kind === 'state' && spec.stereotype && !pseudo[spec.stereotype.toLowerCase()]) node.stereotype = spec.stereotype;
        if (st[2]) (node.description ??= []).push(unescape(st[2]));
        continue;
      }
      const desc = /^([\p{L}\p{N}_.$]+)\s*:\s*(.+)$/u.exec(text);
      if (desc && !RELATION_RE.test(text)) {
        const target = nodes.get(desc[1]!) ?? (resolveRef(desc[1]!, lineNo, 'from') as DNode);
        if ('kind' in target) (target.description ??= []).push(unescape(desc[2]!));
        continue;
      }
    }

    // ---- description-family declarations: actor, component, node, database, ... ----
    const decl = /^([a-z_]+)\s+(.+)$/i.exec(text);
    if (decl && family !== 'state') {
      const kw = decl[1]!.toLowerCase();
      const kind = family === 'class' && kw === 'interface' ? undefined : DESCRIPTION_KINDS[kw];
      if (kind && !RELATION_RE.test(text)) {
        const spec = parseNameSpec(decl[2]!);
        if (!spec) continue;
        const node = addNode({ id: spec.id, kind, label: spec.label, line: lineNo });
        if (spec.stereotype) node.stereotype = spec.stereotype;
        continue;
      }
    }

    // ---- relations ----
    const relation = RELATION_RE.exec(text);
    if (relation) {
      const from = resolveRef(relation[1]!, lineNo, 'from');
      const to = resolveRef(relation[5]!, lineNo, 'to');
      addEdge(from, to, parseArrow(relation[3]!), relation[6], lineNo, { from: relation[2] && unquote(relation[2]), to: relation[4] && unquote(relation[4]) });
      continue;
    }

    // ---- shorthand declarations: `[Comp] as C`, `() "If" as I`, `(Use case) as U`, `:Actor: as A` ----
    if (/^(\[|\(|:)/.test(text)) {
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
  if (pendingBody) finishBody();

  // In component/deployment diagrams, undeclared bare names are components, not actors.
  if (family === 'description') {
    const looksLikeUseCase = [...nodes.values()].some((n) => (n.kind === 'usecase' || n.kind === 'actor') && !implicit.has(n.id));
    if (!looksLikeUseCase) for (const id of implicit) nodes.get(id)!.kind = 'component';
  }

  return {
    diagram: { family, direction, ...(directionFixed ? { directionFixed } : {}), nodes: [...nodes.values()], containers: [...containers.values()], edges },
    warnings,
  };

  // ---- C4 macros (hoisted; closes over the parser state above) ----
  function parseC4(text: string, lineNo: number): boolean {
    const call = /^([A-Za-z_]+)\s*\((.*)\)\s*(\{)?$/.exec(text);
    if (!call) return false;
    const name = call[1]!;
    const args = splitArgs(call[2]!);
    const positional = args.filter((a) => !/^\$\w+\s*=/.test(a));
    const named = Object.fromEntries(args.filter((a) => /^\$\w+\s*=/.test(a)).map((a) => [a.slice(1, a.indexOf('=')).trim(), unquote(a.slice(a.indexOf('=') + 1))]));
    const external = /_Ext$/.test(name);
    const base = name.replace(/_Ext$/, '');

    const boundary = /^(System_Boundary|Container_Boundary|Enterprise_Boundary|Boundary|Deployment_Node(_L|_R)?|Node(_L|_R)?)$/.exec(name);
    if (boundary && call[3]) {
      const id = positional[0]!.trim();
      addContainer(id, /Node/.test(name) ? 'node' : 'boundary', unquote(positional[1]) || id, lineNo, named.type);
      return true;
    }

    const elementKinds: Record<string, NodeKind> = {
      Person: 'person',
      System: 'system',
      SystemDb: 'database',
      SystemQueue: 'queue',
      Container: 'container',
      ContainerDb: 'database',
      ContainerQueue: 'queue',
      Component: 'component',
      ComponentDb: 'database',
      ComponentQueue: 'queue',
    };
    const kind = elementKinds[base];
    if (kind) {
      const id = positional[0]!.trim();
      const label = unquote(positional[1]) || id;
      // Person/System: (alias, label, descr); Container/Component: (alias, label, techn, descr).
      const hasTech = /^(Container|Component)/.test(base);
      const node = addNode({ id, kind, label, line: lineNo });
      const tech = hasTech ? unquote(positional[2]) || named.techn : named.techn;
      const descr = hasTech ? unquote(positional[3]) || named.descr : unquote(positional[2]) || named.descr;
      if (tech) node.technology = tech;
      if (descr) node.description = [unescape(descr)];
      if (external) node.external = true;
      return true;
    }

    const rel = /^(Bi)?Rel(_(U|Up|D|Down|L|Left|R|Right|Back|Neighbor|Back_Neighbor))?$/.exec(name);
    const lay = /^Lay_(U|Up|D|Down|L|Left|R|Right|Distance)$/.exec(name);
    if (rel || lay) {
      const from = resolveRef(positional[0]!.trim(), lineNo, 'from');
      const to = resolveRef(positional[1]!.trim(), lineNo, 'to');
      const label = unquote(positional[2]) || named.label;
      const tech = unquote(positional[3]) || named.techn;
      addEdge(
        from,
        to,
        { dashed: true, leftHead: rel?.[1] ? 'arrow' : 'none', rightHead: lay ? 'none' : 'arrow', hidden: !!lay },
        label ? (tech ? `${label}\n[${tech}]` : label) : undefined,
        lineNo,
      );
      return true;
    }
    return false;
  }

  // ---- ArchiMate: `archimate #Layer "Name" as A <<business-actor>>` and the stdlib macros ----
  function parseArchimate(text: string, lineNo: number): boolean {
    const decl = /^archimate\s+(.+)$/i.exec(text);
    if (decl) {
      const spec = parseNameSpec(` ${decl[1]!}`);
      if (!spec) return true;
      const node = addNode({ id: spec.id, kind: 'rectangle', label: spec.label, line: lineNo });
      const layer = /^\s*#(\w+)/.exec(decl[1]!)?.[1];
      const type = spec.stereotype?.replace(/^\$?archimate\//, '');
      if (type || layer) node.stereotype = (type ?? layer!).replace(/-/g, ' ');
      return true;
    }
    const call = /^([A-Za-z_]+)\s*\((.*)\)\s*(\{)?$/.exec(text);
    if (!call) return false;
    const args = splitArgs(call[2]!);
    const name = call[1]!;
    if (/^Group(ing)?$/.test(name) && call[3]) {
      addContainer(args[0]!.trim(), 'boundary', unquote(args[1]) || args[0]!.trim(), lineNo, name === 'Grouping' ? 'grouping' : undefined);
      return true;
    }
    const junction = /^Junction_(And|Or)$/.exec(name);
    if (junction) {
      addNode({ id: args[0]!.trim(), kind: 'circle', label: '', stereotype: junction[1] === 'Or' ? 'or' : undefined, line: lineNo });
      return true;
    }
    const element = ARCHIMATE_ELEMENT_RE.exec(text);
    if (element) {
      const id = args[0]!.trim();
      const node = addNode({ id, kind: 'rectangle', label: unescape(unquote(args[1]) || id), line: lineNo });
      node.stereotype = `${element[1]!.toLowerCase()} ${element[2]!.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase()}`;
      if (args[2]) node.description = [unescape(unquote(args[2]))];
      return true;
    }
    const rel = ARCHIMATE_REL_RE.exec(text);
    if (rel) {
      const style = ARCHIMATE_RELS[rel[1]!.toLowerCase()];
      if (!style) return false;
      const from = resolveRef(args[0]!.trim(), lineNo, 'from');
      const to = resolveRef(args[1]!.trim(), lineNo, 'to');
      addEdge(from, to, { hidden: false, ...style }, unquote(args[2]) || undefined, lineNo);
      return true;
    }
    return false;
  }
}

const ARCHIMATE_ELEMENT_RE = /^(Strategy|Business|Application|Technology|Physical|Implementation|Motivation|Other)_(\w+?)\s*\(/;
const ARCHIMATE_REL_RE = /^Rel_(Composition|Aggregation|Assignment|Realization|Realisation|Serving|Access_rw|Access_r|Access_w|Access|Influence|Triggering|Flow|Specialization|Association_dir|Association)(?:_(?:Up|Down|Left|Right|U|D|L|R))?\s*\(/;

/** How each ArchiMate relationship is drawn; `left` is the source end. */
const ARCHIMATE_RELS: Record<string, Omit<ParsedArrow, 'hidden'>> = {
  composition: { dashed: false, leftHead: 'diamondFilled', rightHead: 'none' },
  aggregation: { dashed: false, leftHead: 'diamond', rightHead: 'none' },
  assignment: { dashed: false, leftHead: 'dot', rightHead: 'arrow' },
  realization: { dashed: true, leftHead: 'none', rightHead: 'triangle' },
  realisation: { dashed: true, leftHead: 'none', rightHead: 'triangle' },
  serving: { dashed: false, leftHead: 'none', rightHead: 'arrow' },
  access: { dashed: true, leftHead: 'none', rightHead: 'none' },
  access_r: { dashed: true, leftHead: 'arrow', rightHead: 'none' },
  access_w: { dashed: true, leftHead: 'none', rightHead: 'arrow' },
  access_rw: { dashed: true, leftHead: 'arrow', rightHead: 'arrow' },
  influence: { dashed: true, leftHead: 'none', rightHead: 'arrow' },
  triggering: { dashed: false, leftHead: 'none', rightHead: 'arrow' },
  flow: { dashed: true, leftHead: 'none', rightHead: 'arrow' },
  specialization: { dashed: false, leftHead: 'none', rightHead: 'triangle' },
  association: { dashed: false, leftHead: 'none', rightHead: 'none' },
  association_dir: { dashed: false, leftHead: 'none', rightHead: 'arrow' },
};

/** Mindmap / WBS: `* root`, `** child`, `+`/`-` for sides, `_` for boxless. A tree of topics. */
function parseTree(lines: Line[], family: 'mindmap' | 'wbs'): ParseResult {
  const nodes: DNode[] = [];
  const edges: DEdge[] = [];
  const warnings: ParseWarning[] = [];
  const stack: DNode[] = [];
  const ids = new Map<string, number>();
  let direction: Diagram['direction'] = family === 'wbs' ? 'TB' : 'LR';
  let directionFixed = false;
  let directive: 'left' | 'right' | undefined;
  let multiline: { node: DNode; body: string[] } | undefined;
  for (const { no, raw, text } of lines) {
    if (multiline) {
      if (text.endsWith(';')) {
        multiline.body.push(text.slice(0, -1));
        multiline.node.label = multiline.body.join('\n').trim();
        multiline = undefined;
      } else multiline.body.push(text);
      continue;
    }
    if (!text || text.startsWith("'") || text.startsWith('@') || text.startsWith('!')) continue;
    const sideLine = /^(left|right)\s+side$/i.exec(text);
    if (sideLine) {
      directive = sideLine[1]!.toLowerCase() as 'left' | 'right';
      continue;
    }
    if (/^top\s+to\s+bottom\s+direction$/i.test(text)) {
      direction = 'TB';
      directionFixed = true;
      continue;
    }
    if (/^left\s+to\s+right\s+direction$/i.test(text)) {
      direction = 'LR';
      directionFixed = true;
      continue;
    }
    const m = /^([*+\-#]+)(_)?(\[#?\w+\])?\s*(.*)$/.exec(text);
    if (!m) {
      warnings.push({ line: no, text: raw, message: 'Unsupported line, ignored' });
      continue;
    }
    const depth = m[1]!.length;
    let label = m[4]!.trim();
    const base = label.startsWith(':') ? 'topic' : label.replace(/\s+/g, ' ') || `topic ${no}`;
    const count = (ids.get(base) ?? 0) + 1;
    ids.set(base, count);
    const id = count === 1 ? base : `${base}#${count}`;
    const node: DNode = { id, kind: 'topic', label: unescape(label), line: no };
    if (label.startsWith(':')) {
      label = label.slice(1);
      if (label.endsWith(';')) node.label = unescape(label.slice(0, -1));
      else multiline = { node, body: [label] };
    }
    if (m[2]) node.stereotype = 'boxless';
    if (family === 'mindmap' && depth === 2) {
      const side = m[1]![0] === '+' ? 'right' : m[1]![0] === '-' ? 'left' : directive;
      if (side) node.side = side;
    }
    nodes.push(node);
    stack.length = depth - 1;
    const parent = stack[depth - 2];
    if (parent) {
      edges.push({ id: `${parent.id}--${node.id}`, from: parent.id, to: node.id, kind: 'association', dashed: false, head: 'none', tail: 'none', hidden: false, line: no });
    }
    stack[depth - 1] = node;
  }
  return { diagram: { family, direction, ...(directionFixed ? { directionFixed } : {}), nodes, containers: [], edges }, warnings };
}
