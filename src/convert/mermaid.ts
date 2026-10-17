import type { LayoutFile } from '../layout/layout-file.ts';
import { parseMermaid } from '../model/mermaid.ts';
import type { ArrowHead, DEdge, DNode, Diagram, GanttModel, NodeKind, ParseWarning, SequenceModel } from '../model/types.ts';
import { Emitter, IdAllocator, KindLosses, dominantDirection, rekeyLayout, warn, wordId, type ConvertResult, type IdMap } from './common.ts';
import { DEFAULT_GANTT_START, addDays, finishGraph, finishOrdered, treeShape } from './plantuml.ts';

/**
 * Diagram → Mermaid that `parseMermaid` reads back to the same ids. Box and
 * line diagrams become a flowchart (or classDiagram / erDiagram /
 * stateDiagram-v2 / mindmap for those families), with node ids kept as
 * written (`id["Label"]`) and line ids kept with Mermaid's `id@-->` where
 * they are plain words. Mermaid can't hold positions either: the direction
 * line follows the layout, and the sidecar carries the rest.
 */
export function toMermaid(diagram: Diagram, layout: LayoutFile): ConvertResult {
  const special = diagram.special;
  if (special?.type === 'sequence') return sequenceToMermaid(special, layout);
  if (special?.type === 'gantt') return ganttToMermaid(special, layout);
  if (special?.type === 'timing') {
    return { source: '', layout: rekeyLayout(layout, { nodes: {}, edges: {} }), warnings: [warn('Mermaid has no timing diagrams; convert to PlantUML instead')], ids: { nodes: {}, edges: {} } };
  }
  if (diagram.family === 'mindmap' || diagram.family === 'wbs') {
    const tree = mindmapToMermaid(diagram, layout);
    if (tree) return tree;
  }
  if (diagram.family === 'state') return stateToMermaid(diagram, layout);
  const solid = diagram.nodes.filter((n) => n.kind !== 'note');
  if (diagram.family === 'class' || (solid.length > 0 && solid.every((n) => n.kind === 'class'))) {
    return isEr(diagram) ? erToMermaid(diagram, layout) : classToMermaid(diagram, layout);
  }
  return flowchartToMermaid(diagram, layout);
}

// ---- text --------------------------------------------------------------------------------------

/**
 * Label text for Mermaid's quoted labels: line breaks as `<br>`, and the
 * characters its reader would take as markup (`"`, `<`, `>`, `#`, `|`) as
 * `#code;` entities, which it decodes back.
 */
export function mmdLabel(text: string): string {
  return text
    .replace(/[#"<>|]/g, (c) => `#${c.codePointAt(0)};`)
    .replace(/\n/g, '<br>');
}
const quotedLabel = (text: string) => `"${mmdLabel(text)}"`;

const WORD = /^[\p{L}\p{N}_]+$/u;
const DIRECTION_LINE = (d: Diagram['direction']) => (d === 'LR' ? 'LR' : 'TB');

// ---- flowchart ---------------------------------------------------------------------------------

/** Statement keywords: a node with one of these ids would start a different statement. */
const FLOW_RESERVED = new Set(['end', 'subgraph', 'graph', 'flowchart', 'classdef', 'class', 'style', 'linkstyle', 'click', 'acctitle', 'accdescr', 'direction', 'default']);
const FLOW_ID = /^[\p{L}\p{N}_](?:[\p{L}\p{N}_]|-(?=[\p{L}\p{N}_]))*$/u;

/** Outline per kind: bracket pairs where Mermaid has one, `@{ shape }` names for the rest. */
const FLOW_SHAPES: Partial<Record<NodeKind, [string, string] | string>> = {
  rectangle: ['[', ']'],
  action: ['(', ')'],
  storage: ['([', '])'],
  database: ['[(', ')]'],
  hexagon: ['{{', '}}'],
  relationship: ['{', '}'],
  attribute: ['((', '))'],
  process: ['>', ']'],
  file: 'doc',
  queue: 'h-cyl',
  cloud: 'cloud',
  card: 'card',
  stack: 'st-rect',
  folder: 'folder',
};
/** Kinds without an outline of their own and what they become. */
const FLOW_APPROX: Partial<Record<NodeKind, NodeKind>> = {
  decision: 'relationship', choice: 'relationship', usecase: 'action', state: 'action', topic: 'action', initial: 'attribute', final: 'attribute', circle: 'attribute',
  history: 'attribute', interface: 'attribute', component: 'rectangle', node: 'rectangle', artifact: 'file', note: 'card', class: 'rectangle',
};

const FLOW_HEAD: Partial<Record<ArrowHead, [tail: string, head: string]>> = { none: ['', ''], arrow: ['<', '>'], circle: ['o', 'o'], cross: ['x', 'x'] };

function flowchartToMermaid(diagram: Diagram, layout: LayoutFile): ConvertResult {
  const losses = new KindLosses();
  const warnings: ParseWarning[] = [];
  if (diagram.family !== 'activity' && diagram.family !== 'description') warnings.push(warn(`${diagram.family} diagram written as a flowchart`));
  const alloc = new IdAllocator((id) => FLOW_ID.test(id) && !FLOW_RESERVED.has(id.toLowerCase()), wordId);
  alloc.reserve([...diagram.containers.map((c) => c.id), ...diagram.nodes.map((n) => n.id)]);
  const idOf = (id: string) => alloc.get(id);
  const out = new Emitter();
  out.push(`flowchart ${DIRECTION_LINE(dominantDirection(diagram, layout))}`);
  const containerIds = new Set(diagram.containers.map((c) => c.id));
  const parentOf = (p: string | undefined) => (p && containerIds.has(p) ? p : undefined);

  const declare = (n: DNode, indent: string) => {
    let kind = n.kind;
    if (!FLOW_SHAPES[kind]) {
      kind = FLOW_APPROX[kind] ?? 'rectangle';
      losses.add(`${n.kind} drawn as ${kind}`);
    }
    if (n.stereotype && n.stereotype !== 'boxless') losses.add('stereotype');
    if (n.description?.length || n.compartments?.length) losses.add('description or member lines');
    if (n.double && kind !== 'attribute' && kind !== 'rectangle') losses.add('double outline');
    const shape = FLOW_SHAPES[kind]!;
    const id = idOf(n.id);
    let text: string;
    if (typeof shape === 'string') text = `${id}@{ shape: ${shape}, label: ${quotedLabel(n.label)} }`;
    else {
      const [open, close] = n.double ? (kind === 'attribute' ? ['(((', ')))'] : kind === 'rectangle' ? ['[[', ']]'] : shape) : shape;
      text = `${id}${open}${quotedLabel(n.label)}${close}`;
    }
    out.push(`${indent}${text}`, ['node', n.id]);
  };
  const scope = (parent: string | undefined, indent: string) => {
    // Nodes first: Mermaid puts a node in the first subgraph that mentions it.
    for (const n of diagram.nodes.filter((x) => parentOf(x.parent) === parent)) declare(n, indent);
    for (const c of diagram.containers.filter((x) => parentOf(x.parent) === parent)) {
      out.push(`${indent}subgraph ${idOf(c.id)}[${quotedLabel(c.label)}]`, ['container', c.id]);
      scope(c.id, `${indent}  `);
      out.push(`${indent}end`);
    }
  };
  scope(undefined, '  ');

  const explicit = new Set<string>();
  for (const e of diagram.edges) {
    const tail = FLOW_HEAD[e.tail];
    const head = FLOW_HEAD[e.head];
    if (!tail || !head) losses.add(`line end ${(!tail ? e.tail : e.head)} drawn as an arrow`);
    const [t, h] = [(tail ?? FLOW_HEAD.arrow!)[0], (head ?? FLOW_HEAD.arrow!)[1]];
    // A bare `--` would open a text link; an open solid line is `---`.
    const body = e.dashed ? '-.-' : h ? '--' : '---';
    if (e.fromLabel || e.toLabel) losses.add('end labels (multiplicities)');
    if (e.double) losses.add('double line');
    if (e.kind === 'noteLink') losses.add('note link drawn as a dotted line');
    // Word ids that differ from what Mermaid would derive keep themselves with `id@`.
    const name = WORD.test(e.id) && !explicit.has(e.id) ? `${e.id}@` : '';
    if (name) explicit.add(e.id);
    const op = e.hidden ? '~~~' : `${t}${body}${h}`;
    const label = e.label && !e.hidden ? `|${quotedLabel(e.label)}|` : '';
    out.push(`  ${idOf(e.from)} ${name}${op}${label} ${idOf(e.to)}`, ['edge', e.id]);
  }
  return finishGraph(diagram, layout, out, parseMermaid(out.text()).diagram, idOf, [...warnings, ...losses.warnings('a Mermaid flowchart')]);
}

// ---- class -------------------------------------------------------------------------------------

const CLASS_TAIL: Partial<Record<ArrowHead, string>> = { none: '', triangle: '<|', diamondFilled: '*', diamond: 'o', arrow: '<', circle: '()' };
const CLASS_HEAD: Partial<Record<ArrowHead, string>> = { none: '', triangle: '|>', diamondFilled: '*', diamond: 'o', arrow: '>', circle: '()' };
const ANNOTATION: Partial<Record<string, string>> = { interface: 'interface', abstract: 'abstract', enum: 'enumeration', struct: 'struct', record: 'record', exception: 'exception' };
const CLASS_NAME = /^[\p{L}\p{N}_.$]+$/u;

/** Mermaid class names: plain names as they are, anything else in backticks (no backtick or tilde inside). */
const className = (id: string) => (CLASS_NAME.test(id) ? id : `\`${id}\``);

function classToMermaid(diagram: Diagram, layout: LayoutFile): ConvertResult {
  const losses = new KindLosses();
  const alloc = new IdAllocator((id) => !/[`~\s"]/.test(id) && id.length > 0 && !/^note[:#]/.test(id), wordId);
  alloc.reserve([...diagram.containers.map((c) => c.id), ...diagram.nodes.filter((n) => n.kind !== 'note').map((n) => n.id)]);
  const idOf = (id: string) => alloc.get(id);
  const out = new Emitter();
  out.push('classDiagram');
  const direction = dominantDirection(diagram, layout);
  if (direction === 'LR') out.push('  direction LR');
  const containerIds = new Set(diagram.containers.map((c) => c.id));
  const parentOf = (p: string | undefined) => (p && containerIds.has(p) ? p : undefined);

  const declare = (n: DNode, indent: string) => {
    if (n.kind === 'note') return;
    if (n.kind !== 'class') losses.add(`${n.kind} drawn as a class`);
    const name = className(idOf(n.id));
    // An empty label must still be written (`[" "]` reads as empty), or the id would show instead.
    const label = n.label !== idOf(n.id) ? `["${mmdLabel(n.label) || ' '}"]` : '';
    const members = (n.compartments ?? []).flat();
    if ((n.compartments?.length ?? 0) > 2) losses.add('member compartments beyond fields and methods');
    if (members.length) {
      out.push(`${indent}class ${name}${label} {`, ['node', n.id]);
      const annotation = n.classKind && ANNOTATION[n.classKind];
      if (annotation) out.push(`${indent}  <<${annotation}>>`);
      for (const m of members) out.push(`${indent}  ${m.replace(/<([^<>]*)>/g, '~$1~')}`);
      out.push(`${indent}}`);
    } else {
      out.push(`${indent}class ${name}${label}`, ['node', n.id]);
      const annotation = n.classKind && ANNOTATION[n.classKind];
      if (annotation) out.push(`${indent}<<${annotation}>> ${name}`);
    }
    if (n.classKind && n.classKind !== 'class' && !ANNOTATION[n.classKind]) losses.add(`${n.classKind} drawn as a class`);
    if (n.stereotype) out.push(`${indent}<<${n.stereotype}>> ${name}`);
  };
  const scope = (parent: string | undefined, indent: string) => {
    for (const c of diagram.containers.filter((x) => parentOf(x.parent) === parent)) {
      if (c.label !== c.id) losses.add('namespace label (Mermaid shows the id)');
      out.push(`${indent}namespace ${idOf(c.id)} {`, ['container', c.id]);
      scope(c.id, `${indent}  `);
      out.push(`${indent}}`);
    }
    for (const n of diagram.nodes.filter((x) => parentOf(x.parent) === parent)) declare(n, indent);
  };
  scope(undefined, '  ');

  const noteEdges = new Set<string>();
  for (const n of diagram.nodes.filter((x) => x.kind === 'note')) {
    const link = n.attachedTo && diagram.edges.find((e) => e.from === n.id && e.to === n.attachedTo!.id && e.kind === 'noteLink');
    if (link && n.attachedTo) {
      noteEdges.add(link.id);
      if (n.attachedTo.side !== 'right') losses.add('note side (Mermaid notes sit to the right)');
      out.push(`  note for ${className(idOf(n.attachedTo.id))} "${mmdLabel(n.label)}"`, ['node', n.id], ['edge', link.id]);
    } else out.push(`  note "${mmdLabel(n.label)}"`, ['node', n.id]);
  }
  for (const e of diagram.edges) {
    if (noteEdges.has(e.id)) continue;
    if (diagram.nodes.some((n) => n.kind === 'note' && (n.id === e.from || n.id === e.to))) {
      losses.add('line to a note');
      continue;
    }
    const t = CLASS_TAIL[e.tail];
    const h = CLASS_HEAD[e.head];
    if (t === undefined || h === undefined) losses.add(`line end ${t === undefined ? e.tail : e.head}`);
    if (e.hidden) losses.add('hidden line');
    const op = `${t ?? ''}${e.dashed ? '..' : '--'}${h ?? ''}`;
    const fl = e.fromLabel ? ` "${e.fromLabel.replace(/"/g, "'")}"` : '';
    const tl = e.toLabel ? `"${e.toLabel.replace(/"/g, "'")}" ` : '';
    const label = e.label ? ` : ${mmdLabel(e.label)}` : '';
    out.push(`  ${className(idOf(e.from))}${fl} ${op} ${tl}${className(idOf(e.to))}${label}`, ['edge', e.id]);
  }
  return finishGraph(diagram, layout, out, parseMermaid(out.text()).diagram, idOf, losses.warnings('a Mermaid class diagram'));
}

// ---- ER ----------------------------------------------------------------------------------------

const ER_TAIL: Partial<Record<ArrowHead, string>> = { crowZeroOne: '|o', crowOne: '||', crowZeroMany: '}o', crowOneMany: '}|', crowMany: '}|' };
const ER_HEAD: Partial<Record<ArrowHead, string>> = { crowZeroOne: 'o|', crowOne: '||', crowZeroMany: 'o{', crowOneMany: '|{', crowMany: '|{' };

/** Entities with crow's feet on both ends of every line, and nothing else: Mermaid's erDiagram can hold that. */
function isEr(diagram: Diagram): boolean {
  return (
    diagram.nodes.length > 0 &&
    diagram.containers.length === 0 &&
    diagram.nodes.every((n) => n.kind === 'class' && n.classKind === 'entity') &&
    diagram.edges.every((e) => ER_TAIL[e.tail] && ER_HEAD[e.head] && !e.fromLabel && !e.toLabel)
  );
}

/**
 * A table row as Mermaid's `type name [PK, FK] ["comment"]`. Reads the
 * PlantUML way (`* id : bigint <<PK>>`) and our own reading of Mermaid rows
 * (`id : bigint PK — comment`); rows that aren't `name : type` keep their
 * text in the comment.
 */
function erAttribute(row: string, i: number): string {
  const word = (s: string) => s.replace(/[^\p{L}\p{N}_\-()[\],~*]/gu, '_') || '_';
  const comment = (s: string) => (s ? ` "${s.replace(/"/g, "'")}"` : '');
  const m = /^(?:\*\s*)?([\p{L}\p{N}_]+)\s*:\s*(\S+)\s*(.*)$/u.exec(row);
  if (!m) return `string row${i + 1}${comment(row)}`;
  let rest = m[3]!;
  const keys = new Set<string>();
  rest = rest.replace(/(?:<<|«)\s*(PK|FK|UK)\s*(?:>>|»)/g, (_x, k: string) => (keys.add(k), '')).trim();
  const lead = /^((?:PK|FK|UK)(?:\s*,\s*(?:PK|FK|UK))*)\b\s*/.exec(rest);
  if (lead) {
    for (const k of lead[1]!.split(/\s*,\s*/)) keys.add(k);
    rest = rest.slice(lead[0].length);
  }
  rest = rest.replace(/^—\s*/, '').trim();
  return `${word(m[2]!)} ${m[1]}${keys.size ? ` ${[...keys].join(',')}` : ''}${comment(rest)}`;
}

function erToMermaid(diagram: Diagram, layout: LayoutFile): ConvertResult {
  const losses = new KindLosses();
  // Quoted entity names keep any id without a quote.
  const alloc = new IdAllocator((id) => id.length > 0 && !/"/.test(id), wordId);
  alloc.reserve(diagram.nodes.map((n) => n.id));
  const idOf = (id: string) => alloc.get(id);
  const name = (id: string) => (/^[\p{L}\p{N}_-]+$/u.test(idOf(id)) ? idOf(id) : `"${idOf(id)}"`);
  const out = new Emitter();
  out.push('erDiagram');
  if (dominantDirection(diagram, layout) === 'LR') out.push('  direction LR');
  for (const n of diagram.nodes) {
    const label = n.label !== idOf(n.id) ? `["${mmdLabel(n.label).replace(/]/g, '#93;')}"]` : '';
    const rows = (n.compartments ?? []).flat();
    if ((n.compartments?.length ?? 0) > 1) losses.add('key compartment split (Mermaid groups PK rows itself)');
    out.push(`  ${name(n.id)}${label} {`, ['node', n.id]);
    rows.forEach((r, i) => out.push(`    ${erAttribute(r, i)}`));
    out.push('  }');
  }
  for (const e of diagram.edges) {
    if (e.head === 'crowMany' || e.tail === 'crowMany') losses.add('"many" without a minimum written as one-or-many');
    out.push(`  ${name(e.from)} ${ER_TAIL[e.tail]}${e.dashed ? '..' : '--'}${ER_HEAD[e.head]} ${name(e.to)} : ${quotedLabel(e.label ?? '')}`, ['edge', e.id]);
  }
  return finishGraph(diagram, layout, out, parseMermaid(out.text()).diagram, idOf, losses.warnings('a Mermaid ER diagram'));
}

// ---- state -------------------------------------------------------------------------------------

const STATE_ID = /^[\p{L}\p{N}_.$-]+$/u;

function stateToMermaid(diagram: Diagram, layout: LayoutFile): ConvertResult {
  const losses = new KindLosses();
  const isStart = (n: DNode | undefined) => !!n && (n.kind === 'initial' || n.kind === 'final') && n.id.startsWith('[*]');
  const alloc = new IdAllocator((id) => STATE_ID.test(id) && !/^(note|state|end|direction|class|classdef|style)$/i.test(id), wordId);
  alloc.reserve([...diagram.containers.map((c) => c.id), ...diagram.nodes.filter((n) => !isStart(n) && n.kind !== 'note').map((n) => n.id)]);
  const idOf = (id: string) => alloc.get(id);
  const byId = new Map(diagram.nodes.map((n) => [n.id, n]));
  const out = new Emitter();
  out.push('stateDiagram-v2');
  if (dominantDirection(diagram, layout) === 'LR') out.push('  direction LR');
  const containerIds = new Set(diagram.containers.map((c) => c.id));
  const parentOf = (p: string | undefined) => (p && containerIds.has(p) ? p : undefined);
  const ref = (id: string) => (isStart(byId.get(id)) ? '[*]' : idOf(id));

  const declare = (n: DNode, indent: string) => {
    if (n.kind === 'note' || isStart(n)) return;
    const id = idOf(n.id);
    if (n.kind === 'choice' || n.kind === 'fork') return void out.push(`${indent}state ${id} <<${n.kind}>>`, ['node', n.id]);
    if (n.kind !== 'state') losses.add(`${n.kind} drawn as a state`);
    if (n.stereotype) losses.add('stereotype');
    const label = n.label !== id ? `"${n.label.replace(/"/g, "'").replace(/\n/g, '<br>')}" as ` : '';
    out.push(`${indent}state ${label}${id}`, ['node', n.id]);
    for (const d of n.description ?? []) out.push(`${indent}${id} : ${mmdLabel(d)}`);
  };
  const scoped = new Set<string>();
  const edge = (e: DEdge, indent: string) => {
    if (e.head !== 'arrow' || e.tail !== 'none') losses.add('line ends other than one arrow');
    if (e.dashed) losses.add('dashed transition');
    const pseudo = [e.from, e.to].filter((id) => isStart(byId.get(id)));
    out.push(`${indent}${ref(e.from)} --> ${ref(e.to)}${e.label ? ` : ${mmdLabel(e.label)}` : ''}`, ['edge', e.id], ...pseudo.map((id) => ['node', id] as ['node', string]));
  };
  const scope = (parent: string | undefined, indent: string) => {
    for (const c of diagram.containers.filter((x) => parentOf(x.parent) === parent)) {
      const label = c.label !== idOf(c.id) ? `"${c.label.replace(/"/g, "'")}" as ` : '';
      out.push(`${indent}state ${label}${idOf(c.id)} {`, ['container', c.id]);
      scope(c.id, `${indent}  `);
      out.push(`${indent}}`);
    }
    for (const n of diagram.nodes.filter((x) => parentOf(x.parent) === parent)) declare(n, indent);
    for (const e of diagram.edges) {
      const start = [byId.get(e.from), byId.get(e.to)].find(isStart);
      if (start && parentOf(start.parent) === parent && !scoped.has(e.id)) {
        scoped.add(e.id);
        edge(e, indent);
      }
    }
  };
  scope(undefined, '  ');
  const noteEdges = new Set<string>();
  for (const n of diagram.nodes.filter((x) => x.kind === 'note')) {
    const link = n.attachedTo && diagram.edges.find((e) => e.from === n.id && e.to === n.attachedTo!.id && e.kind === 'noteLink');
    if (!link || !n.attachedTo) {
      losses.add('free-standing note');
      continue;
    }
    noteEdges.add(link.id);
    const lines = n.label.split('\n');
    if (lines.length === 1) out.push(`  note ${n.attachedTo.side} of ${ref(n.attachedTo.id)} : ${mmdLabel(n.label)}`, ['node', n.id], ['edge', link.id]);
    else {
      out.push(`  note ${n.attachedTo.side} of ${ref(n.attachedTo.id)}`, ['node', n.id], ['edge', link.id]);
      for (const l of lines) out.push(`    ${mmdLabel(l)}`);
      out.push('  end note');
    }
  }
  for (const e of diagram.edges) if (!scoped.has(e.id) && !noteEdges.has(e.id)) edge(e, '  ');
  return finishGraph(diagram, layout, out, parseMermaid(out.text()).diagram, idOf, losses.warnings('a Mermaid state diagram'));
}

// ---- mindmap -----------------------------------------------------------------------------------

function mindmapToMermaid(diagram: Diagram, layout: LayoutFile): ConvertResult | undefined {
  const tree = treeShape(diagram);
  if (!tree) return undefined;
  const warnings: ParseWarning[] = [];
  if (tree.roots.length > 1) {
    warnings.push(warn('A Mermaid mindmap has one root: written as a flowchart instead'));
    const flow = flowchartToMermaid({ ...diagram, family: 'activity' }, layout);
    return { ...flow, warnings: [...warnings, ...flow.warnings] };
  }
  if (diagram.family === 'wbs') warnings.push(warn('WBS written as a Mermaid mindmap'));
  if (diagram.edges.some((e) => e.label || e.head !== 'none' || e.tail !== 'none' || e.dashed)) warnings.push(warn('Mindmap branches carry no labels, arrows or dashes'));
  const alloc = new IdAllocator((id) => /^[\p{L}\p{N}_-]+$/u.test(id), wordId);
  alloc.reserve(diagram.nodes.map((n) => n.id));
  const idOf = (id: string) => alloc.get(id);
  const edgeTo = new Map(diagram.edges.map((e) => [e.to, e]));
  const out = new Emitter();
  out.push('mindmap');
  const visit = (n: DNode, depth: number) => {
    const edge = edgeTo.get(n.id);
    out.push(`${'  '.repeat(depth)}${idOf(n.id)}[${quotedLabel(n.label)}]`, ['node', n.id], ...(edge ? [['edge', edge.id] as ['edge', string]] : []));
    for (const c of tree.children.get(n.id) ?? []) visit(c, depth + 1);
  };
  visit(tree.roots[0]!, 1);
  return finishGraph(diagram, layout, out, parseMermaid(out.text()).diagram, idOf, warnings);
}

// ---- sequence ----------------------------------------------------------------------------------

const GROUPS = new Set(['loop', 'alt', 'opt', 'par', 'critical', 'break']);

function sequenceToMermaid(model: SequenceModel, layout: LayoutFile): ConvertResult {
  const losses = new KindLosses();
  const alloc = new IdAllocator((id) => WORD.test(id) && !/^(end|participant|actor|note|loop|alt|opt|par|and|else|critical|option|break|rect|box|autonumber|activate|deactivate|create|destroy|title)$/i.test(id), wordId);
  alloc.reserve(model.participants.map((p) => p.id));
  const idOf = (id: string) => alloc.get(id);
  const out = new Emitter();
  out.push('sequenceDiagram');
  if (model.hideFootbox) losses.add('hidden footbox');

  const created = new Set(model.events.flatMap((e) => (e.type === 'create' ? [e.participant] : [])));
  const declaration = (p: SequenceModel['participants'][number]) => {
    const id = idOf(p.id);
    const word = p.kind === 'actor' ? 'actor' : 'participant';
    const label = p.label !== id ? ` as ${mmdLabel(p.label)}` : '';
    const meta = p.kind !== 'actor' && p.kind !== 'participant' ? `@{ "type" : "${p.kind}" }` : '';
    if (p.stereotype) losses.add('participant stereotype');
    return `${word} ${id}${label}${meta}`;
  };
  // Boxes group participants that are declared together.
  const boxOf = new Map<string, SequenceModel['boxes'][number]>();
  for (const b of model.boxes) for (const p of b.participants) boxOf.set(p, b);
  let open: SequenceModel['boxes'][number] | undefined;
  for (const p of model.participants) {
    if (created.has(p.id)) continue; // declared where it is created
    const box = boxOf.get(p.id);
    if (open && box !== open) {
      out.push('  end');
      open = undefined;
    }
    if (box && box !== open) {
      // A leading colour word would be read as the box colour, not the label.
      out.push(`  box transparent ${mmdLabel(box.label)}`);
      open = box;
    }
    out.push(`${open ? '    ' : '  '}${declaration(p)}`, ['node', p.id]);
  }
  if (open) out.push('  end');

  const groups: string[] = [];
  let numbering: number | undefined;
  let lastMessage: { index: number; from: string; to: string } | undefined;
  const lineOf = (text: string) => out.push(`  ${'  '.repeat(groups.length)}${text}`);
  for (const ev of model.events) {
    switch (ev.type) {
      case 'message': {
        if (ev.from === '[' || ev.to === ']' || ev.from === ']' || ev.to === '[') {
          losses.add('message from or to outside the diagram (dropped)');
          break;
        }
        const n = ev.number !== undefined && /^\d+$/.test(ev.number) ? Number(ev.number) : undefined;
        if (n !== undefined && n !== numbering) out.push(n === 1 ? '  autonumber' : `  autonumber ${n}`);
        if (n === undefined && numbering !== undefined) out.push('  autonumber off');
        numbering = n === undefined ? undefined : n + 1;
        const head = ev.head === 'arrow' ? '>>' : ev.head === 'open' ? ')' : ev.head === 'cross' ? 'x' : '>';
        if (ev.head === 'half' || ev.head === 'circle') losses.add(`${ev.head} message head`);
        if (ev.tail !== 'none' && (ev.tail !== 'arrow' || ev.head !== 'arrow')) losses.add('message tail');
        const arrow = `${ev.tail === 'arrow' && ev.head === 'arrow' ? '<<' : ''}${ev.dashed ? '--' : '-'}${head}`;
        const line = out.push(`  ${'  '.repeat(groups.length)}${idOf(ev.from)}${arrow}${idOf(ev.to)}: ${ev.label ? mmdLabel(ev.label) : ''}`, ['edge', ev.id]);
        lastMessage = { index: line - 1, from: ev.from, to: ev.to };
        break;
      }
      case 'note': {
        const over = ev.side === 'across' ? [model.participants[0]!.id, model.participants.at(-1)!.id] : ev.over;
        if (ev.side === 'across') losses.add('note across written over the outer participants');
        const where = ev.side === 'left' || ev.side === 'right' ? `${ev.side} of ${idOf(over[0]!)}` : `over ${[...new Set(over)].map(idOf).join(',')}`;
        lineOf(`Note ${where}: ${mmdLabel(ev.text)}`);
        break;
      }
      case 'ref':
        losses.add('ref written as a note');
        lineOf(`Note over ${ev.over.map(idOf).join(',')}: ref: ${mmdLabel(ev.text)}`);
        break;
      case 'groupStart': {
        const kind = GROUPS.has(ev.kind) ? ev.kind : 'opt';
        if (kind !== ev.kind) losses.add(`${ev.kind} group written as opt`);
        lineOf(`${kind} ${mmdLabel(ev.label)}`.trimEnd());
        groups.push(kind);
        break;
      }
      case 'groupElse': {
        const kind = groups.at(-1);
        groups.pop();
        lineOf(`${kind === 'par' ? 'and' : kind === 'critical' ? 'option' : 'else'} ${mmdLabel(ev.label)}`.trimEnd());
        groups.push(kind ?? 'alt');
        break;
      }
      case 'groupEnd':
        groups.pop();
        lineOf('end');
        break;
      case 'divider':
      case 'delay':
      case 'space':
        losses.add(`${ev.type} (dropped)`);
        break;
      case 'create': {
        const p = model.participants.find((q) => q.id === ev.participant);
        if (p) out.push(`  ${'  '.repeat(groups.length)}create ${declaration(p)}`, ['node', p.id]);
        break;
      }
      case 'destroy':
        // Mermaid writes `destroy X` before the message that ends X.
        if (lastMessage && (lastMessage.from === ev.participant || lastMessage.to === ev.participant) && out.lines[lastMessage.index]) {
          const indent = /^\s*/.exec(out.lines[lastMessage.index]!)![0];
          out.lines.splice(lastMessage.index, 0, `${indent}destroy ${idOf(ev.participant)}`);
          // Everything born from the message on moved down a line.
          for (const v of out.born.values()) if (v.line > lastMessage.index) v.line++;
          lastMessage = undefined;
        } else losses.add('destroy not right after a message');
        break;
      default:
        lineOf(`${ev.type} ${idOf(ev.participant)}`);
    }
  }
  const parsed = parseMermaid(out.text()).diagram.special;
  return finishOrdered(model, parsed?.type === 'sequence' ? parsed : undefined, out, layout, losses.warnings('a Mermaid sequence diagram'));
}

// ---- gantt -------------------------------------------------------------------------------------

function ganttToMermaid(model: GanttModel, layout: LayoutFile): ConvertResult {
  const losses = new KindLosses();
  const warnings: ParseWarning[] = [];
  const alloc = new IdAllocator((id) => /^[\p{L}\p{N}_-]+$/u.test(id), wordId);
  alloc.reserve(model.tasks.map((t) => t.id));
  const idOf = (id: string) => alloc.get(id);
  const start = model.start ?? DEFAULT_GANTT_START;
  if (!model.start) warnings.push(warn(`No project start date: tasks are pinned to dates from ${start}`));
  const out = new Emitter();
  out.push('gantt');
  out.push('  dateFormat YYYY-MM-DD');
  if (model.closed.length) out.push(`  excludes ${model.closed.map((d) => ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'][d]).join(', ')}`);
  if (model.scale !== 'daily') out.push(`  tickInterval 1${model.scale === 'weekly' ? 'week' : 'month'}`);
  const byId = new Map(model.tasks.map((t) => [t.id, t]));
  // As the scheduler does: a task that would start on a closed day starts on the next open one.
  const startDay = new Date(`${start}T00:00:00Z`).getUTCDay();
  const nextOpen = (day: number) => {
    let d = day;
    for (let i = 0; i < 14 && model.closed.includes((((startDay + d) % 7) + 7) % 7); i++) d++;
    return d;
  };
  let section: string | undefined;
  for (const t of model.tasks) {
    if (t.section !== section && t.section !== undefined) {
      out.push(`  section ${mmdLabel(t.section)}`);
      section = t.section;
    } else if (t.section !== section) losses.add('task outside a section after one');
    const tags = [...(t.milestone ? ['milestone'] : []), ...(t.completion === 100 ? ['done'] : []), ...(t.color === 'red' ? ['crit'] : [])];
    if (t.completion !== undefined && t.completion !== 100 && t.completion !== 0) losses.add('partial completion');
    if (t.color && t.color !== 'red') losses.add('task colour');
    if (t.resources?.length) losses.add('resources');
    // `after` keeps the arrows when it gives the same start; Mermaid can't hold both a date and a dependency.
    const refs = t.after.map((a) => byId.get(a)).filter((r) => r !== undefined);
    const afterStart = refs.length === t.after.length && refs.length > 0 ? Math.max(...refs.map((r) => r.start + r.duration)) : undefined;
    let begin: string;
    if (afterStart !== undefined && (t.milestone ? afterStart : nextOpen(afterStart)) === t.start) begin = `after ${t.after.map(idOf).join(' ')}`;
    else {
      if (t.after.length) losses.add('dependency arrow (start pinned to a date instead)');
      begin = addDays(start, t.start);
    }
    const finish = t.milestone ? '0d' : addDays(start, t.start + Math.max(1, t.duration)); // exclusive end
    out.push(`  ${mmdLabel(t.name).replace(/:/g, '#58;')} :${[...tags, idOf(t.id), begin, finish].join(', ')}`, ['node', t.id]);
  }
  const parsed = parseMermaid(out.text()).diagram.special;
  const ids: IdMap = { nodes: {}, edges: {} };
  if (parsed?.type === 'gantt') {
    for (const t of model.tasks) {
      const hit = parsed.tasks.find((q) => q.line === out.bornLine('node', t.id));
      if (hit) ids.nodes[t.id] = hit.id;
    }
  }
  return { source: out.text(), layout: rekeyLayout(layout, ids), warnings: [...warnings, ...losses.warnings('a Mermaid Gantt chart')], ids };
}

