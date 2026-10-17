import type { DContainer, DNode, Diagram, DiagramFamily, NodeKind, ParseWarning, ArrowHead } from './types.ts';
import type { ParseResult } from './parse.ts';
import type { Line } from './puml-util.ts';
import { edgeBuilder, mermaidLines, mmdText, splitStatements, type EdgeStyle } from './mermaid-util.ts';
import { parseMermaidSequence } from './mermaid-sequence.ts';
import { parseMermaidClass, parseMermaidEr, parseMermaidState } from './mermaid-class.ts';
import { parseMermaidGantt } from './mermaid-gantt.ts';

/**
 * Mermaid entry: reads the header line (`flowchart LR`, `sequenceDiagram`,
 * ...) and hands the rest to the reader for that type. Every reader produces
 * the same neutral model as its PlantUML counterpart, so layout, routing and
 * the sidecar work unchanged. Like the PlantUML side, nothing here throws:
 * lines that aren't understood become warnings.
 */

/** Mermaid types we recognise but don't lay out; reported instead of mis-read. */
const UNSUPPORTED: Record<string, string> = {
  pie: 'Pie',
  journey: 'User journey',
  gitgraph: 'Git graph',
  timeline: 'Timeline',
  quadrantchart: 'Quadrant chart',
  'xychart-beta': 'XY chart',
  xychart: 'XY chart',
  'sankey-beta': 'Sankey',
  sankey: 'Sankey',
  requirementdiagram: 'Requirement',
  c4context: 'C4',
  c4container: 'C4',
  c4component: 'C4',
  c4dynamic: 'C4',
  c4deployment: 'C4',
  'block-beta': 'Block',
  block: 'Block',
  'packet-beta': 'Packet',
  packet: 'Packet',
  'architecture-beta': 'Architecture',
  architecture: 'Architecture',
  kanban: 'Kanban',
  zenuml: 'ZenUML',
  'radar-beta': 'Radar',
  'treemap-beta': 'Treemap',
};

const SUPPORTED = /^(flowchart|graph|sequencediagram|classdiagram(-v2)?|statediagram(-v2)?|erdiagram|gantt|mindmap)$/;

/** True when the first meaningful line names a Mermaid diagram type. */
export function looksLikeMermaid(source: string): boolean {
  const kw = mermaidLines(source)[0]?.text.split(/[\s;]/)[0]?.toLowerCase() ?? '';
  return SUPPORTED.test(kw) || kw in UNSUPPORTED;
}

const empty = (family: DiagramFamily, warnings: ParseWarning[]): ParseResult => ({ diagram: { family, direction: 'TB', nodes: [], containers: [], edges: [] }, warnings });

export function parseMermaid(source: string): ParseResult {
  const lines = mermaidLines(source);
  const header = lines[0];
  if (!header) return empty('description', [{ line: 1, text: '', message: 'No Mermaid diagram type found' }]);
  const kw = header.text.split(/[\s;]/)[0]!.toLowerCase();
  const body = lines.slice(1);
  if (UNSUPPORTED[kw]) return { ...empty('description', [{ line: header.no, text: header.raw, message: `${UNSUPPORTED[kw]} diagrams are not supported yet` }]), unsupported: UNSUPPORTED[kw] };
  switch (kw) {
    case 'flowchart':
    case 'graph':
      return parseFlowchart(header, body);
    case 'sequencediagram':
      return parseMermaidSequence(withRest(header, body));
    case 'classdiagram':
    case 'classdiagram-v2':
      return parseMermaidClass(withRest(header, body));
    case 'statediagram':
    case 'statediagram-v2':
      return parseMermaidState(withRest(header, body));
    case 'erdiagram':
      return parseMermaidEr(withRest(header, body));
    case 'gantt':
      return parseMermaidGantt(withRest(header, body));
    case 'mindmap':
      return parseMindmap(body);
  }
  return empty('description', [{ line: header.no, text: header.raw, message: `Unknown Mermaid diagram type "${header.text.split(/\s/)[0]}"` }]);
}

/** Anything after `;` on the header line is a statement too (`sequenceDiagram; A->>B: hi`). */
function withRest(header: Line, body: Line[]): Line[] {
  const rest = splitStatements(header.text).slice(1);
  return [...rest.map((text) => ({ ...header, text })), ...body];
}

const toDirection = (d: string | undefined): Diagram['direction'] => (d && /^(LR|RL)$/i.test(d) ? 'LR' : 'TB');

// ---- flowchart ---------------------------------------------------------------------------------

interface ShapeSpec {
  open: string;
  close: string[];
  kind: NodeKind;
  double?: boolean;
}

/**
 * Node shapes, longest opener first. Mermaid has more outlines than the
 * renderer; the close ones stand in: circles are ellipses, `{ }` is the
 * diamond, `[[ ]]` a double box, parallelograms and trapezoids plain boxes.
 */
const SHAPES: ShapeSpec[] = [
  { open: '(((', close: [')))'], kind: 'attribute', double: true },
  { open: '((', close: ['))'], kind: 'attribute' },
  { open: '([', close: ['])'], kind: 'storage' },
  { open: '[[', close: [']]'], kind: 'rectangle', double: true },
  { open: '[(', close: [')]'], kind: 'database' },
  { open: '[/', close: ['/]', '\\]'], kind: 'rectangle' },
  { open: '[\\', close: ['\\]', '/]'], kind: 'rectangle' },
  { open: '{{', close: ['}}'], kind: 'hexagon' },
  { open: '(', close: [')'], kind: 'action' },
  { open: '[', close: [']'], kind: 'rectangle' },
  { open: '{', close: ['}'], kind: 'relationship' },
  { open: '>', close: [']'], kind: 'process' },
];

/** `A@{ shape: cyl }` names (Mermaid 11) mapped onto the same outlines. */
const NAMED_SHAPES: Record<string, ShapeSpec['kind']> = {
  rect: 'rectangle', proc: 'rectangle', process: 'rectangle', rectangle: 'rectangle',
  rounded: 'action', event: 'action',
  stadium: 'storage', pill: 'storage', terminal: 'storage',
  diam: 'relationship', diamond: 'relationship', decision: 'relationship', question: 'relationship',
  circle: 'attribute', circ: 'attribute', 'sm-circ': 'attribute', 'small-circle': 'attribute', start: 'attribute', 'dbl-circ': 'attribute', 'double-circle': 'attribute',
  cyl: 'database', cylinder: 'database', database: 'database', db: 'database',
  hex: 'hexagon', hexagon: 'hexagon', prepare: 'hexagon',
  subproc: 'rectangle', subroutine: 'rectangle', 'framed-rectangle': 'rectangle',
  doc: 'file', document: 'file', docs: 'file', documents: 'file',
  'lin-cyl': 'database', 'h-cyl': 'queue', das: 'queue', 'horizontal-cylinder': 'queue',
  cloud: 'cloud', flag: 'process', 'notch-pent': 'process', 'tag-rect': 'card', card: 'card', 'notch-rect': 'card',
  'st-rect': 'stack', processes: 'stack', 'stacked-rectangle': 'stack', folder: 'folder',
};

interface NodeRef {
  id: string;
  shape?: { kind: NodeKind; label: string; double?: boolean };
}

interface Link {
  style: EdgeStyle;
  label?: string;
  id?: string;
}

const ID_RE = /[\p{L}\p{N}_](?:[\p{L}\p{N}_]|-(?=[\p{L}\p{N}_]))*/uy;
// `-- text -->`, `-. text .->`, `== text ==>`
const TEXT_LINK_RE = /(<|o|x)?(--|==|-\.)\s+(.*?)\s*(-{2,}|={2,}|\.+-)(>|o(?=\s|$)|x(?=\s|$))?/y;
// `-->`, `---`, `-.->`, `==>`, `<-->`, `--o`, `--x`, `~~~`
const LINK_RE = /(<|o(?=[-=.])|x(?=[-=.]))?(-{2,}|-\.+-|={2,}|~{3,})(>|o(?=[\s|]|$)|x(?=[\s|]|$))?/y;

const LINK_HEADS: Record<string, ArrowHead> = { '>': 'arrow', '<': 'arrow', o: 'circle', x: 'cross' };

/** Reads one flowchart statement into node groups joined by links, without side effects. */
function scanStatement(s: string): { groups: NodeRef[][]; links: Link[] } | undefined {
  let pos = 0;
  const ws = () => {
    while (pos < s.length && /\s/.test(s[pos]!)) pos++;
  };
  const sticky = (re: RegExp) => {
    re.lastIndex = pos;
    const m = re.exec(s);
    if (m) pos = re.lastIndex;
    return m;
  };

  const node = (): NodeRef | undefined => {
    ws();
    const id = sticky(ID_RE);
    if (!id) return undefined;
    const ref: NodeRef = { id: id[0] };
    if (s.startsWith('@{', pos)) {
      const close = s.indexOf('}', pos);
      if (close === -1) return undefined;
      const body = s.slice(pos + 2, close);
      pos = close + 1;
      const shape = /\bshape\s*:\s*([\w-]+)/.exec(body)?.[1];
      const label = /\blabel\s*:\s*("(?:[^"\\]|\\.)*"|[^,}]+)/.exec(body)?.[1];
      if (shape || label) ref.shape = { kind: (shape && NAMED_SHAPES[shape]) || 'rectangle', label: mmdText(label ?? ref.id), double: shape === 'dbl-circ' || shape === 'double-circle' || shape === 'subroutine' || shape === 'subproc' || undefined };
    } else {
      for (const spec of SHAPES) {
        if (!s.startsWith(spec.open, pos)) continue;
        let i = pos + spec.open.length;
        while (s[i] === ' ') i++;
        let end = -1;
        let closer = '';
        if (s[i] === '"') {
          const q = s.indexOf('"', i + 1);
          if (q === -1) continue;
          let j = q + 1;
          while (s[j] === ' ') j++;
          closer = spec.close.find((c) => s.startsWith(c, j)) ?? '';
          if (closer) end = j;
        } else {
          for (const c of spec.close) {
            const at = s.indexOf(c, i);
            if (at !== -1 && (end === -1 || at < end)) [end, closer] = [at, c];
          }
        }
        if (end === -1) continue;
        ref.shape = { kind: spec.kind, label: mmdText(s.slice(pos + spec.open.length, end)), double: spec.double };
        pos = end + closer.length;
        break;
      }
    }
    sticky(/:::[\w-]+/y);
    return ref;
  };

  const link = (): Link | undefined => {
    ws();
    const start = pos;
    const named = sticky(/([\p{L}\p{N}_]+)@(?=[-=.~<ox])/uy);
    let m = sticky(TEXT_LINK_RE);
    const textForm = !!m;
    let label = m?.[3];
    if (!m) m = sticky(LINK_RE);
    if (!m) {
      pos = start;
      return undefined;
    }
    const pipe = sticky(/\s*\|([^|]*)\|/y);
    if (pipe) label = pipe[1];
    const tail = m[1] ?? '';
    const head = (textForm ? m[5] : m[3]) ?? '';
    const style: EdgeStyle = { dashed: textForm ? m[2] === '-.' : m[2]!.includes('.'), head: LINK_HEADS[head] ?? 'none', tail: LINK_HEADS[tail] ?? 'none' };
    if (!textForm && m[2]!.startsWith('~')) style.hidden = true;
    const out: Link = { style };
    if (label?.trim()) out.label = mmdText(label);
    if (named) out.id = named[1]!;
    return out;
  };

  const groups: NodeRef[][] = [];
  const links: Link[] = [];
  for (;;) {
    const group: NodeRef[] = [];
    for (;;) {
      const n = node();
      if (!n) return undefined;
      group.push(n);
      ws();
      if (s[pos] !== '&') break;
      pos++;
    }
    groups.push(group);
    ws();
    if (pos >= s.length) break;
    const l = link();
    if (!l) return undefined;
    links.push(l);
  }
  return { groups, links };
}

function parseFlowchart(header: Line, lines: Line[]): ParseResult {
  const warnings: ParseWarning[] = [];
  const nodes = new Map<string, DNode>();
  const containers = new Map<string, DContainer>();
  const { edges, add } = edgeBuilder();
  const stack: string[] = [];
  /** Nodes only ever mentioned bare, which a later subgraph of the same name replaces. */
  const bare = new Set<string>();
  const [headerText, ...headerRest] = splitStatements(header.text);
  const direction = toDirection(headerText!.split(/\s+/)[1]);
  const explicitIds = new Map<string, number>();
  let skipUntil: RegExp | undefined;

  const statements = [...headerRest.map((text) => ({ ...header, text })), ...lines];
  for (const { no, raw, text: line } of statements) {
    if (skipUntil) {
      if (skipUntil.test(line)) skipUntil = undefined;
      continue;
    }
    for (const text of splitStatements(line)) {
      if (/^(classDef|class|style|linkStyle|click|accTitle|accDescr)\b/.test(text) && !/^(class|style|click)\s*(-|=|\.|&|~|$)/.test(text)) {
        if (/^accDescr\s*\{/.test(text) && !text.includes('}')) skipUntil = /\}/;
        continue;
      }
      if (/^direction\s+(TB|TD|BT|LR|RL)$/i.test(text)) continue; // per-subgraph direction: one direction per layout
      const sub = /^subgraph\s+(.+)$/.exec(text);
      if (sub) {
        const spec = sub[1]!.trim();
        const m = /^([\p{L}\p{N}_-]+)\s*\[(.*)\]$/u.exec(spec);
        const id = m ? m[1]! : mmdText(spec);
        const label = m ? mmdText(m[2]!) : mmdText(spec);
        if (nodes.has(id) && bare.has(id)) nodes.delete(id);
        const container: DContainer = { id, kind: 'rectangle', label, line: no };
        if (stack.length) container.parent = stack[stack.length - 1]!;
        containers.set(id, container);
        stack.push(id);
        continue;
      }
      if (text === 'end') {
        if (!stack.pop()) warnings.push({ line: no, text: raw, message: 'end without subgraph' });
        continue;
      }
      const scanned = scanStatement(text);
      if (!scanned) {
        warnings.push({ line: no, text: raw, message: 'Unsupported line, ignored' });
        continue;
      }
      const parent = stack[stack.length - 1];
      const touch = (ref: NodeRef): string => {
        if (containers.has(ref.id) && !ref.shape) return ref.id;
        let node = nodes.get(ref.id);
        if (!node) {
          node = { id: ref.id, kind: 'rectangle', label: ref.id, line: no };
          nodes.set(ref.id, node);
          bare.add(ref.id);
        }
        if (ref.shape) {
          // The last shaped mention wins, as in Mermaid.
          Object.assign(node, { kind: ref.shape.kind, label: ref.shape.label, line: no });
          if (ref.shape.double) node.double = true;
          else delete node.double;
          bare.delete(ref.id);
        }
        // A node belongs to the subgraph it is mentioned in; the first one wins.
        if (parent && node.parent === undefined && parent !== node.id) node.parent = parent;
        return node.id;
      };
      const ids = scanned.groups.map((g) => g.map(touch));
      scanned.links.forEach((l, i) => {
        for (const from of ids[i]!) {
          for (const to of ids[i + 1]!) {
            const edge = add(from, to, l.style, no, { label: l.label });
            if (l.id) {
              const n = (explicitIds.get(l.id) ?? 0) + 1;
              explicitIds.set(l.id, n);
              edge.id = n === 1 ? l.id : `${l.id}#${n}`;
            }
          }
        }
      });
    }
  }
  if (stack.length) warnings.push({ line: lines.at(-1)?.no ?? header.no, text: '', message: `subgraph ${stack.at(-1)} without end` });
  return { diagram: { family: 'activity', direction, nodes: [...nodes.values()], containers: [...containers.values()], edges }, warnings };
}

// ---- mindmap -----------------------------------------------------------------------------------

/** Mindmap shapes: `[ ]` square, `( )` rounded, `(( ))` circle, `)) ((` bang, `) (` cloud, `{{ }}` hexagon. */
const MINDMAP_SHAPES: [string, string][] = [
  ['((', '))'],
  ['))', '(('],
  ['{{', '}}'],
  ['(', ')'],
  [')', '('],
  ['[', ']'],
];

/** Indentation tree, as the PlantUML mindmap reader produces: topics joined parent to child. */
function parseMindmap(lines: Line[]): ParseResult {
  const nodes: DNode[] = [];
  const { edges } = edgeBuilder();
  const warnings: ParseWarning[] = [];
  const stack: { indent: number; node: DNode }[] = [];
  const ids = new Map<string, number>();
  for (const { no, raw, text } of lines) {
    if (/^::icon\(/.test(text) || /^:::/.test(text)) continue;
    const indent = /^\s*/.exec(raw.replace(/\t/g, '    '))![0].length;
    const body = text.replace(/\s*:::[\w\s-]+$/, '');
    let id: string | undefined;
    let label = body;
    for (const [open, close] of MINDMAP_SHAPES) {
      const at = body.indexOf(open);
      if (at === -1 || !body.endsWith(close) || body.length < at + open.length + close.length) continue;
      const before = body.slice(0, at).trim();
      if (before && !/^[\p{L}\p{N}_-]+$/u.test(before)) continue;
      id = before || undefined;
      label = body.slice(at + open.length, body.length - close.length);
      break;
    }
    label = mmdText(label);
    const base = id ?? (label.replace(/\s+/g, ' ') || `topic ${no}`);
    const count = (ids.get(base) ?? 0) + 1;
    ids.set(base, count);
    const node: DNode = { id: count === 1 ? base : `${base}#${count}`, kind: 'topic', label, line: no };
    while (stack.length && stack[stack.length - 1]!.indent >= indent) stack.pop();
    const parent = stack[stack.length - 1]?.node;
    if (!parent && nodes.length) {
      warnings.push({ line: no, text: raw, message: 'A mindmap has one root; this line is not indented under it' });
      continue;
    }
    nodes.push(node);
    if (parent) edges.push({ id: `${parent.id}--${node.id}`, from: parent.id, to: node.id, kind: 'association', dashed: false, head: 'none', tail: 'none', hidden: false, line: no });
    stack.push({ indent, node });
  }
  return { diagram: { family: 'mindmap', direction: 'LR', nodes, containers: [], edges }, warnings };
}
