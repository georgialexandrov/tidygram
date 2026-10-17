import type { LayoutFile } from '../layout/layout-file.ts';
import { HEAD_TOKENS, parsePuml } from '../model/parse.ts';
import type { ArrowHead, ClassKind, DContainer, DEdge, DNode, Diagram, GanttModel, NodeKind, ParseWarning, SeqHead, SequenceModel, TimingModel } from '../model/types.ts';
import { Emitter, IdAllocator, KindLosses, dominantDirection, matchGraph, pumlHint, rekeyLayout, sideOf, warn, wordId, type ConvertResult, type IdMap } from './common.ts';

/**
 * Diagram → PlantUML source that `parsePuml` reads back to the same ids.
 * Node ids are written as aliases (`component "Label" as id`, quoted when
 * they aren't plain words) so they survive; edge ids follow from the arrow
 * as PlantUML defines them. Positions can't live in PlantUML, so each line
 * gets a direction keyword (`-right->`) from the layout and the file a
 * `left to right direction` when most lines run sideways: other renderers
 * get closer to the picture, and the sidecar carries the exact one.
 */
export function toPlantUml(diagram: Diagram, layout: LayoutFile): ConvertResult {
  const special = diagram.special;
  if (special?.type === 'sequence') return sequenceToPuml(special, layout);
  if (special?.type === 'gantt') return ganttToPuml(special, layout);
  if (special?.type === 'timing') return timingToPuml(special, layout);
  if (diagram.family === 'mindmap' || diagram.family === 'wbs') {
    const tree = treeToPuml(diagram, layout);
    if (tree) return tree;
  }
  return graphToPuml(diagram, layout);
}

// ---- shared bits -------------------------------------------------------------------------------

/** Words the reader treats as keywords at the start of a line: never bare ids. */
const RESERVED = new Set(
  (
    'skinparam title hide show scale caption header footer allowmixing allow_mixing remove restore set sprite mainframe legend left right top bottom together note state ' +
    'actor agent artifact boundary card circle cloud collections component control database entity file folder frame hexagon interface label node package person process queue rectangle stack storage usecase ' +
    'class abstract enum annotation object map struct protocol exception record metaclass stereotype dataclass namespace end start stop if while repeat fork split switch kill detach ' +
    'participant activate deactivate destroy create autonumber alt else opt loop par break critical group box return ref robust concise clock binary archimate as'
  ).split(' '),
);

const BARE = /^[\p{L}\p{N}_][\p{L}\p{N}_.]*$/u;
const bareOk = (id: string) => BARE.test(id) && !RESERVED.has(id.toLowerCase());
/** An id the reader keeps verbatim inside quotes (`as "if: ok?"`): no quotes, no decorations it strips. */
const quotableOk = (id: string) => id.length > 0 && id === id.trim() && !/["\n$]|\s#|<<|>>|\s\s|\sas\s|^\[\*\]|^\[H\*?\]/.test(id);

/** A label inside double quotes: line breaks as `\n`; PlantUML has no escape for `"`, so it becomes `'`. */
function quoted(text: string, losses: KindLosses): string {
  if (text.includes('"')) losses.add('double quote in a label, written as \'');
  return `"${text.replace(/"/g, "'").replace(/\n/g, '\\n')}"`;
}
const inline = (text: string) => text.replace(/\n/g, '\\n');

const AS_IN_LABEL = /\sas\s/;
/** `"Label" as id`, `"Label" as "if: x"`, or `id as "a as b"` when the label itself contains ` as `. */
function nameSpec(id: string, label: string, losses: KindLosses): string {
  const bare = bareOk(id);
  if (label === id && bare) return id;
  if (AS_IN_LABEL.test(label) && bare) return `${id} as ${quoted(label, losses)}`;
  return `${quoted(label, losses)} as ${bare ? id : `"${id}"`}`;
}

// ---- graph diagrams ----------------------------------------------------------------------------

type Mode = 'description' | 'class' | 'state' | 'c4';

/** PlantUML keyword for each kind in description diagrams; kinds not listed are approximated. */
const DESC_KEYWORD: Partial<Record<NodeKind, string>> = {
  actor: 'actor', agent: 'agent', artifact: 'artifact', boundary: 'boundary', card: 'card', circle: 'circle', cloud: 'cloud', collections: 'collections',
  component: 'component', control: 'control', database: 'database', entity: 'entity', file: 'file', folder: 'folder', frame: 'frame', hexagon: 'hexagon',
  label: 'label', node: 'node', person: 'person', process: 'process', queue: 'queue', rectangle: 'rectangle', stack: 'stack', storage: 'storage', usecase: 'usecase',
};
/** Closest outline for kinds description diagrams don't have. */
const DESC_APPROX: Partial<Record<NodeKind, string>> = {
  action: 'rectangle', decision: 'hexagon', relationship: 'hexagon', attribute: 'usecase', topic: 'rectangle', system: 'rectangle', container: 'component',
  state: 'rectangle', initial: 'circle', final: 'circle', history: 'circle', choice: 'hexagon', fork: 'rectangle', network: 'rectangle', class: 'rectangle',
};
const CLASS_KEYWORD: Record<ClassKind, string> = {
  class: 'class', abstract: 'abstract class', interface: 'interface', enum: 'enum', annotation: 'annotation', entity: 'entity', object: 'object', map: 'map',
  struct: 'struct', protocol: 'protocol', exception: 'exception', record: 'record', json: 'object',
};
const CONTAINER_KEYWORDS = new Set(['package', 'namespace', 'rectangle', 'frame', 'folder', 'node', 'cloud', 'database', 'component', 'card', 'hexagon', 'storage', 'artifact', 'file', 'queue', 'stack', 'agent']);

function modeFor(diagram: Diagram): Mode {
  if (diagram.family === 'state') return 'state';
  if (diagram.family === 'c4') return 'c4';
  if (diagram.family === 'class') return 'class';
  const solid = diagram.nodes.filter((n) => n.kind !== 'note');
  return solid.length > 0 && solid.every((n) => n.kind === 'class') ? 'class' : 'description';
}

/** State pseudo-states PlantUML names itself (`[*]`, `[*]end@Busy`, `[H]@Busy`): written inline where they are used. */
const isPseudoRef = (n: DNode | undefined): boolean => {
  if (!n) return false;
  if (n.kind === 'initial' || n.kind === 'final') return n.id.startsWith('[*]');
  return n.kind === 'history' && /^\[H\*?\]/.test(n.id);
};

function graphToPuml(diagram: Diagram, layout: LayoutFile): ConvertResult {
  const mode = modeFor(diagram);
  const losses = new KindLosses();
  const warnings: ParseWarning[] = [];
  if (diagram.family === 'activity') warnings.push(warn('Activity flow is written as a component-style graph: PlantUML activity syntax cannot be regenerated from a graph'));
  if (diagram.family === 'json' || diagram.family === 'chen' || diagram.family === 'network' || diagram.family === 'archimate' || diagram.family === 'mindmap' || diagram.family === 'wbs') {
    warnings.push(warn(`${diagram.family} diagram written as a ${mode === 'class' ? 'class' : 'component'}-style graph`));
  }
  const nodeById = new Map(diagram.nodes.map((n) => [n.id, n]));
  const containerIds = new Set(diagram.containers.map((c) => c.id));
  const freeNotes = new Set(diagram.nodes.filter((n) => n.kind === 'note' && !attachedEdge(diagram, n)).map((n) => n.id));
  // `"a as b" as id` would split at the first ` as `; those are written `id as "a as b"`, which needs a bare id.
  const asLabels = new Set([...diagram.nodes, ...diagram.containers].filter((n) => AS_IN_LABEL.test(n.label)).map((n) => n.id));

  // Bare word ids where a line starts with the id (state descriptions, C4 macros, free notes); quoted aliases elsewhere.
  const legal = (id: string) => {
    if (freeNotes.has(id) || mode === 'c4') return /^[\p{L}\p{N}_]+$/u.test(id) && !RESERVED.has(id.toLowerCase());
    if (mode === 'state' || asLabels.has(id)) return bareOk(id);
    return quotableOk(id);
  };
  const alloc = new IdAllocator(legal, wordId);
  alloc.reserve([...diagram.containers.map((c) => c.id), ...diagram.nodes.filter((n) => !isPseudoRef(n)).map((n) => n.id)]);
  const idOf = (id: string) => alloc.get(id);
  const ref = (id: string) => (bareOk(idOf(id)) ? idOf(id) : `"${idOf(id)}"`);
  const spec = (n: { id: string; label: string }) => nameSpec(idOf(n.id), n.label, losses);
  const stereo = (s: string | undefined) => (s ? ` <<${s}>>` : '');

  const direction = dominantDirection(diagram, layout);
  const out = new Emitter();
  out.push('@startuml');
  if (mode === 'c4') out.push('!include <C4/C4_Container>');
  if (direction === 'LR') out.push(mode === 'c4' ? 'LAYOUT_LEFT_RIGHT()' : 'left to right direction');

  // Class files must be recognised as such: a bare `entity X` or `interface X` alone would read as a component diagram.
  const classTrigger = /^(abstract class|abstract|class|enum|annotation|struct|protocol|exception|metaclass|record|dataclass|object|map)$/;
  let needClassTrigger = mode === 'class' && !diagram.nodes.some((n) => n.kind === 'class' && (classTrigger.test(CLASS_KEYWORD[n.classKind ?? 'class']) || n.compartments?.length));

  const declare = (n: DNode) => {
    if (n.kind === 'note') return; // notes come after everything they can point at
    if (mode === 'state' && isPseudoRef(n)) return; // `[*]` / `[H]` are written where they are used
    if (mode === 'class' && n.kind === 'class') return declareClass(n);
    if (mode === 'state') return declareState(n);
    if (mode === 'c4' && declareC4(n)) return;
    if (n.kind === 'interface') return void out.push(`() ${quoted(n.label, losses)} as ${bareOk(idOf(n.id)) ? idOf(n.id) : `"${idOf(n.id)}"`}${stereo(n.stereotype)}`, ['node', n.id]);
    let kw = DESC_KEYWORD[n.kind];
    if (mode === 'class' && n.kind === 'entity') kw = undefined; // `entity` is a class box in class diagrams
    if (!kw) {
      kw = DESC_APPROX[n.kind] ?? 'rectangle';
      losses.add(`${n.kind} drawn as ${kw}`);
    }
    if (n.double) losses.add('double outline');
    if (n.description?.length) losses.add('description lines');
    out.push(`${kw} ${spec(n)}${stereo(n.stereotype)}`, ['node', n.id]);
  };

  const declareClass = (n: DNode) => {
    const kind = n.classKind ?? 'class';
    if (kind === 'json') losses.add('JSON table written as object');
    const head = `${CLASS_KEYWORD[kind]} ${spec(n)}${stereo(n.stereotype)}`;
    const sections = n.compartments ?? [];
    if (!sections.length && !needClassTrigger) return void out.push(head, ['node', n.id]);
    needClassTrigger = false;
    out.push(`${head} {`, ['node', n.id]);
    // Without separators PlantUML splits fields from methods itself; write them only when that wouldn't give the same boxes.
    const flat = sections.flat();
    const methods = flat.filter((m) => m.includes('('));
    const implicit = methods.length && kind !== 'enum' ? [flat.filter((m) => !m.includes('(')), methods] : [flat];
    const explicit = JSON.stringify(implicit) !== JSON.stringify(sections);
    sections.forEach((section, i) => {
      if (explicit && i > 0) out.push('--');
      for (const m of section) out.push(`  ${m}`);
    });
    // One mixed compartment (draw.io rows like `id: int (PK)`) needs a separator to stay in order: a trailing one adds an empty compartment.
    if (explicit && sections.length === 1) out.push('--');
    out.push('}');
  };

  const declareState = (n: DNode) => {
    const id = idOf(n.id);
    const pseudo: Partial<Record<NodeKind, string>> = { choice: 'choice', fork: 'fork', initial: 'start', final: 'end', history: 'history' };
    if (pseudo[n.kind]) return void out.push(`state ${id} <<${pseudo[n.kind]}>>`, ['node', n.id]);
    if (n.kind !== 'state') losses.add(`${n.kind} drawn as state`);
    out.push(`state ${spec(n)}${stereo(n.stereotype)}`, ['node', n.id]);
    for (const d of n.description ?? []) out.push(`${id} : ${inline(d)}`);
  };

  /** C4 macros for the kinds C4 has; anything else falls back to a description keyword. */
  const declareC4 = (n: DNode): boolean => {
    const ext = n.external ? '_Ext' : '';
    const descr = n.description?.join('\n');
    const args = (...xs: (string | undefined)[]) => {
      while (xs.length && !xs[xs.length - 1]) xs.pop();
      return xs.map((x) => quoted(x ?? '', losses)).join(', ');
    };
    const id = idOf(n.id);
    let call: string | undefined;
    if (n.kind === 'person') call = `Person${ext}(${id}, ${args(n.label, descr)})`;
    else if (n.kind === 'system') call = `System${ext}(${id}, ${args(n.label, descr)})`;
    else if (n.kind === 'container') call = `Container${ext}(${id}, ${args(n.label, n.technology, descr)})`;
    else if (n.kind === 'component') call = `Component${ext}(${id}, ${args(n.label, n.technology, descr)})`;
    else if (n.kind === 'database' || n.kind === 'queue') {
      const suffix = n.kind === 'database' ? 'Db' : 'Queue';
      call = n.technology ? `Container${suffix}${ext}(${id}, ${args(n.label, n.technology, descr)})` : `System${suffix}${ext}(${id}, ${args(n.label, descr)})`;
    }
    if (!call) return false;
    out.push(call, ['node', n.id]);
    return true;
  };

  const openContainer = (c: DContainer) => {
    const id = idOf(c.id);
    if (mode === 'c4') {
      const call =
        c.kind === 'node'
          ? `Deployment_Node(${id}, ${quoted(c.label, losses)}${c.stereotype ? `, $type=${quoted(c.stereotype, losses)}` : ''}) {`
          : c.stereotype
            ? `Boundary(${id}, ${quoted(c.label, losses)}, $type=${quoted(c.stereotype, losses)}) {`
            : `System_Boundary(${id}, ${quoted(c.label, losses)}) {`;
      return void out.push(call, ['container', c.id]);
    }
    let kw = mode === 'state' ? 'state' : c.kind;
    if (mode !== 'state' && !CONTAINER_KEYWORDS.has(kw)) {
      kw = c.kind === 'boundary' || c.kind === 'swimlane' || c.kind === 'lane' || c.kind === 'group' ? 'rectangle' : 'package';
      losses.add(`${c.kind} container drawn as ${kw}`);
    }
    out.push(`${kw} ${spec(c)}${stereo(c.stereotype)} {`, ['container', c.id]);
  };

  // ---- edges ----
  const hint = (e: DEdge) => {
    const side = sideOf(diagram, layout, e.from, e.to);
    return side ? pumlHint(side, direction) : undefined;
  };
  const end = (id: string): string => {
    const n = nodeById.get(id);
    if (mode === 'state' && n && isPseudoRef(n)) return n.kind === 'history' ? `[${n.label || 'H'}]` : '[*]';
    return ref(id);
  };
  const headToken = (h: ArrowHead, side: 0 | 1) => {
    if (h === 'dot') {
      losses.add('filled-dot line end written as a circle');
      return HEAD_TOKENS.circle[side];
    }
    return HEAD_TOKENS[h][side];
  };
  const writeEdge = (e: DEdge) => {
    const pseudo = [e.from, e.to].filter((id) => mode === 'state' && isPseudoRef(nodeById.get(id)));
    const h = hint(e);
    if (mode === 'c4' && !e.reversed && c4Edge(e, h, pseudo)) return;
    if (e.double) losses.add('double line');
    const c = e.dashed ? '.' : '-';
    const style = e.hidden ? '[hidden]' : '';
    const body = h || style ? `${c}${style}${h ?? ''}${c}` : `${c}${c}`;
    const op = `${headToken(e.tail, 0)}${body}${headToken(e.head, 1)}`;
    const fromLabel = e.fromLabel ? ` ${quoted(e.fromLabel, losses)}` : '';
    const toLabel = e.toLabel ? `${quoted(e.toLabel, losses)} ` : '';
    const label = e.label ? ` : ${inline(e.label)}` : '';
    out.push(`${end(e.from)}${fromLabel} ${op} ${toLabel}${end(e.to)}${label}`, ['edge', e.id], ...pseudo.map((id) => ['node', id] as ['node', string]));
  };
  const c4Edge = (e: DEdge, h: string | undefined, pseudo: string[]): boolean => {
    const suffix = h ? `_${{ right: 'R', left: 'L', up: 'U', down: 'D' }[h]}` : '';
    if (e.hidden && e.head === 'none' && e.tail === 'none') {
      out.push(`Lay${suffix || '_D'}(${idOf(e.from)}, ${idOf(e.to)})`, ['edge', e.id]);
      return true;
    }
    if (!e.dashed || e.head !== 'arrow' || (e.tail !== 'none' && e.tail !== 'arrow') || e.fromLabel || e.toLabel || pseudo.length) return false;
    const lines = (e.label ?? '').split('\n');
    const tech = lines.length > 1 && /^\[.*\]$/.test(lines.at(-1)!) ? lines.pop()!.slice(1, -1) : undefined;
    const label = lines.join('\n');
    const args = [quoted(label, losses), ...(tech ? [quoted(tech, losses)] : [])].join(', ');
    out.push(`${e.tail === 'arrow' ? 'BiRel' : 'Rel'}${suffix}(${idOf(e.from)}, ${idOf(e.to)}, ${args})`, ['edge', e.id]);
    return true;
  };

  // ---- the tree of containers, with their nodes; state pseudo-transitions in their scope ----
  const parentOf = (p: string | undefined) => (p && containerIds.has(p) ? p : undefined);
  const scoped = new Set<string>();
  const scope = (parent: string | undefined, depth: number) => {
    for (const c of diagram.containers.filter((x) => parentOf(x.parent) === parent)) {
      openContainer(c);
      scope(c.id, depth + 1);
      out.push('}');
    }
    for (const n of diagram.nodes.filter((x) => parentOf(x.parent) === parent)) declare(n);
    if (mode === 'state') {
      for (const e of diagram.edges) {
        const pseudo = [nodeById.get(e.from), nodeById.get(e.to)].find(isPseudoRef);
        if (pseudo && parentOf(pseudo.parent) === parent && !scoped.has(e.id)) {
          scoped.add(e.id);
          writeEdge(e);
        }
      }
    }
  };
  scope(undefined, 0);

  // ---- notes: attached ones with `note <side> of`, free ones by alias ----
  const noteEdges = new Set<string>();
  for (const n of diagram.nodes.filter((x) => x.kind === 'note')) {
    const link = attachedEdge(diagram, n);
    if (link && n.attachedTo) {
      noteEdges.add(link.id);
      out.push(`note ${n.attachedTo.side} of ${end(n.attachedTo.id)} : ${inline(n.label)}`, ['node', n.id], ['edge', link.id]);
    } else {
      out.push(`note ${quoted(n.label, losses)} as ${idOf(n.id)}`, ['node', n.id]);
    }
  }
  for (const e of diagram.edges) if (!scoped.has(e.id) && !noteEdges.has(e.id)) writeEdge(e);
  out.push('@enduml');

  return finishGraph(diagram, layout, out, parsePuml(out.text()).diagram, idOf, [...warnings, ...losses.warnings('PlantUML')]);
}

/** The line that ties an attached note to its target, if the note is one PlantUML writes with `note <side> of`. */
function attachedEdge(diagram: Diagram, n: DNode): DEdge | undefined {
  if (!n.attachedTo) return undefined;
  return diagram.edges.find((e) => e.from === n.id && e.to === n.attachedTo!.id && e.kind === 'noteLink');
}

export function finishGraph(diagram: Diagram, layout: LayoutFile, out: Emitter, parsed: Diagram, idOf: (id: string) => string, warnings: ParseWarning[]): ConvertResult {
  const { ids, warnings: matchWarnings } = matchGraph(diagram, parsed, out, idOf);
  return { source: out.text(), layout: rekeyLayout(layout, ids), warnings: [...warnings, ...matchWarnings], ids };
}

// ---- mindmap / WBS -----------------------------------------------------------------------------

/** Forests only (one parent per topic, plain lines): anything else is written as a graph instead. */
export function treeShape(diagram: Diagram): { roots: DNode[]; children: Map<string, DNode[]> } | undefined {
  if (diagram.containers.length) return undefined;
  const byId = new Map(diagram.nodes.map((n) => [n.id, n]));
  const parent = new Map<string, string>();
  const children = new Map<string, DNode[]>();
  for (const e of diagram.edges) {
    if (parent.has(e.to) || e.from === e.to || !byId.has(e.from) || !byId.has(e.to)) return undefined;
    parent.set(e.to, e.from);
    children.set(e.from, [...(children.get(e.from) ?? []), byId.get(e.to)!]);
  }
  for (const n of diagram.nodes) {
    const seen = new Set<string>();
    for (let at: string | undefined = n.id; at; at = parent.get(at)) {
      if (seen.has(at)) return undefined;
      seen.add(at);
    }
  }
  return { roots: diagram.nodes.filter((n) => !parent.has(n.id)), children };
}

function treeToPuml(diagram: Diagram, layout: LayoutFile): ConvertResult | undefined {
  const tree = treeShape(diagram);
  if (!tree) return undefined;
  const warnings: ParseWarning[] = [];
  if (diagram.edges.some((e) => e.label || e.head !== 'none' || e.tail !== 'none' || e.dashed)) warnings.push(warn('Mindmap branches carry no labels, arrows or dashes'));
  const out = new Emitter();
  const tag = diagram.family === 'wbs' ? 'wbs' : 'mindmap';
  out.push(`@start${tag}`);
  if (tag === 'mindmap' && diagram.direction === 'TB') out.push('top to bottom direction');
  if (tag === 'wbs' && diagram.direction === 'LR') out.push('left to right direction');
  const edgeTo = new Map(diagram.edges.map((e) => [e.to, e]));
  const visit = (n: DNode, depth: number) => {
    const stars = `${'*'.repeat(depth)}${n.stereotype === 'boxless' ? '_' : ''}`;
    const edge = edgeTo.get(n.id);
    const born: ['node' | 'edge', string][] = [['node', n.id], ...(edge ? [['edge', edge.id] as ['edge', string]] : [])];
    const lines = n.label.split('\n');
    if (lines.length > 1 || n.label.startsWith(':') || /^\[#?\w+\]/.test(n.label)) {
      out.push(`${stars}:${lines[0]}${lines.length === 1 ? ';' : ''}`, ...born);
      lines.slice(1).forEach((l, i) => out.push(i === lines.length - 2 ? `${l};` : l));
    } else out.push(`${stars} ${n.label}`, ...born);
    for (const c of tree.children.get(n.id) ?? []) visit(c, depth + 1);
  };
  for (const r of tree.roots) visit(r, 1);
  out.push(`@end${tag}`);
  return finishGraph(diagram, layout, out, parsePuml(out.text()).diagram, (id) => id, warnings);
}

// ---- sequence ----------------------------------------------------------------------------------

const SEQ_HEAD: Record<SeqHead, [tail: string, head: string]> = { arrow: ['<', '>'], open: ['<<', '>>'], half: ['/', '\\'], cross: ['x', '>x'], circle: ['o', '>o'], none: ['', ''] };

function sequenceToPuml(model: SequenceModel, layout: LayoutFile): ConvertResult {
  const warnings: ParseWarning[] = [];
  const losses = new KindLosses();
  // Quoted references keep any id that has no quote, comma or decoration the reader would strip.
  const asLabels = new Set(model.participants.filter((p) => AS_IN_LABEL.test(p.label)).map((p) => p.id));
  const alloc = new IdAllocator((id) => (asLabels.has(id) ? bareOk(id) : quotableOk(id) && !/[,]/.test(id) && !['[', ']', '?'].includes(id)), wordId);
  alloc.reserve(model.participants.map((p) => p.id));
  const idOf = (id: string) => alloc.get(id);
  const ref = (id: string) => (id === '[' || id === ']' ? id : bareOk(idOf(id)) ? idOf(id) : `"${idOf(id)}"`);
  const out = new Emitter();
  out.push('@startuml');
  if (model.hideFootbox) out.push('hide footbox');

  const boxOf = new Map<string, SequenceModel['boxes'][number]>();
  for (const b of model.boxes) for (const p of b.participants) boxOf.set(p, b);
  let open: SequenceModel['boxes'][number] | undefined;
  const opened = new Set<SequenceModel['boxes'][number]>();
  for (const p of model.participants) {
    const box = boxOf.get(p.id);
    if (open && box !== open) {
      out.push('end box');
      open = undefined;
    }
    if (box && box !== open) {
      if (opened.has(box)) losses.add('box split around a participant outside it');
      out.push(box.label ? `box ${quoted(box.label, losses)}` : 'box');
      open = box;
      opened.add(box);
    }
    const id = idOf(p.id);
    const name = p.label === id && !bareOk(id) ? `"${id}"` : nameSpec(id, p.label, losses);
    out.push(`${p.kind} ${name}${p.stereotype ? ` <<${p.stereotype}>>` : ''}`, ['node', p.id]);
  }
  if (open) out.push('end box');

  let next: number | undefined;
  for (const ev of model.events) {
    switch (ev.type) {
      case 'message': {
        const n = ev.number !== undefined && /^\d+$/.test(ev.number) ? Number(ev.number) : undefined;
        if (ev.number !== undefined && n === undefined) losses.add('formatted message number');
        if (n !== undefined && n !== next) out.push(n === 1 && next === undefined ? 'autonumber' : `autonumber ${n}`);
        if (n === undefined && next !== undefined) out.push('autonumber stop');
        next = n === undefined ? undefined : n + 1;
        const arrow = `${SEQ_HEAD[ev.tail][0]}${ev.dashed ? '--' : '-'}${SEQ_HEAD[ev.head][1]}`;
        out.push(`${ref(ev.from)} ${arrow} ${ref(ev.to)}${ev.label ? ` : ${inline(ev.label)}` : ''}`, ['edge', ev.id]);
        break;
      }
      case 'note':
        if (ev.side === 'across') out.push(`note across : ${inline(ev.text)}`);
        else if (ev.side === 'over') out.push(`note over ${ev.over.map(ref).join(', ')} : ${inline(ev.text)}`);
        else out.push(`note ${ev.side} of ${ref(ev.over[0]!)} : ${inline(ev.text)}`);
        break;
      case 'ref':
        out.push(`ref over ${ev.over.map(ref).join(', ')} : ${inline(ev.text)}`);
        break;
      case 'groupStart':
        out.push(`${ev.kind}${ev.label ? ` ${inline(ev.label)}` : ''}`);
        break;
      case 'groupElse':
        out.push(`else${ev.label ? ` ${inline(ev.label)}` : ''}`);
        break;
      case 'groupEnd':
        out.push('end');
        break;
      case 'divider':
        out.push(`== ${inline(ev.label)} ==`);
        break;
      case 'delay':
        out.push(ev.label ? `... ${inline(ev.label)} ...` : '...');
        break;
      case 'space':
        out.push(`||${ev.size}||`);
        break;
      default:
        out.push(`${ev.type} ${ref(ev.participant)}`);
    }
  }
  out.push('@enduml');
  const parsed = parsePuml(out.text()).diagram.special;
  return finishOrdered(model, parsed?.type === 'sequence' ? parsed : undefined, out, layout, [...warnings, ...losses.warnings('PlantUML')]);
}

/** Participants and messages paired by the line they were written on. */
export function finishOrdered(model: SequenceModel, parsed: SequenceModel | undefined, out: Emitter, layout: LayoutFile, warnings: ParseWarning[]): ConvertResult {
  const ids: IdMap = { nodes: {}, edges: {} };
  if (parsed) {
    for (const p of model.participants) {
      const line = out.bornLine('node', p.id);
      const hit = parsed.participants.find((q) => q.line === line);
      if (hit) ids.nodes[p.id] = hit.id;
    }
    for (const ev of model.events) {
      if (ev.type !== 'message') continue;
      const line = out.bornLine('edge', ev.id);
      const hit = parsed.events.find((q) => q.type === 'message' && q.line === line);
      if (hit && hit.type === 'message') ids.edges[ev.id] = hit.id;
    }
  } else warnings.push(warn('The output did not read back as a sequence diagram'));
  return { source: out.text(), layout: rekeyLayout(layout, ids), warnings, ids };
}

// ---- gantt -------------------------------------------------------------------------------------

/** A Monday, so closed weekdays fall where they did when the source had no start date. */
export const DEFAULT_GANTT_START = '2024-01-01';
export const addDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

function ganttToPuml(model: GanttModel, layout: LayoutFile): ConvertResult {
  const warnings: ParseWarning[] = [];
  const start = model.start ?? DEFAULT_GANTT_START;
  if (!model.start) warnings.push(warn(`No project start date: tasks are pinned to dates from ${start}`));
  const out = new Emitter();
  out.push('@startgantt');
  out.push(`Project starts ${start}`);
  if (model.scale !== 'daily') out.push(`printscale ${model.scale}`);
  for (const day of model.closed) out.push(`${WEEKDAYS[day]}s are closed`);
  // PlantUML names a task by its text: duplicates get a suffix, and the id map follows.
  const names = new Map<string, string>();
  const used = new Set<string>();
  for (const t of model.tasks) {
    let name = t.name.replace(/[[\]]/g, '');
    for (let i = 2; used.has(name); i++) name = `${t.name} (${i})`;
    if (name !== t.name) warnings.push(warn(`Task "${t.name}" renamed "${name}"`));
    used.add(name);
    names.set(t.id, name);
  }
  let section: string | undefined;
  for (const t of model.tasks) {
    if (t.section !== section) {
      if (t.section === undefined) warnings.push(warn(`Task "${t.name}" follows a section in PlantUML; it had none`));
      else out.push(`-- ${t.section} --`);
      section = t.section ?? section;
    }
    const clauses = t.milestone ? [`happens ${addDays(start, t.start)}`] : [`starts ${addDays(start, t.start)}`, `ends ${addDays(start, t.start + Math.max(1, t.duration) - 1)}`];
    if (t.completion !== undefined) clauses.push(`is ${t.completion}% complete`);
    if (t.color) clauses.push(`is colored in ${t.color}`);
    const on = t.resources?.length ? ` on ${t.resources.map((r) => `{${r}}`).join(' ')}` : '';
    out.push(`[${names.get(t.id)}]${on} ${clauses.join(' and ')}`, ['node', t.id]);
  }
  // Dates fix the schedule; the arrows only carry the dependencies (dates win over `->`).
  for (const t of model.tasks) for (const a of t.after) if (names.has(a)) out.push(`[${names.get(a)}] -> [${names.get(t.id)}]`);
  out.push('@endgantt');
  const parsed = parsePuml(out.text()).diagram.special;
  const ids: IdMap = { nodes: {}, edges: {} };
  if (parsed?.type === 'gantt') {
    for (const t of model.tasks) {
      const hit = parsed.tasks.find((q) => q.line === out.bornLine('node', t.id));
      if (hit) ids.nodes[t.id] = hit.id;
    }
  }
  return { source: out.text(), layout: rekeyLayout(layout, ids), warnings, ids };
}

// ---- timing ------------------------------------------------------------------------------------

function timingToPuml(model: TimingModel, layout: LayoutFile): ConvertResult {
  const losses = new KindLosses();
  const alloc = new IdAllocator((id) => /^\w+$/.test(id) && !RESERVED.has(id.toLowerCase()), wordId);
  alloc.reserve(model.signals.map((s) => s.id));
  const idOf = (id: string) => alloc.get(id);
  const out = new Emitter();
  out.push('@startuml');
  for (const s of model.signals) {
    const id = idOf(s.id);
    const name = s.label === id ? id : `${quoted(s.label, losses)} as ${id}`;
    const clock = s.kind === 'clock' && s.period ? ` with period ${s.period}${s.pulse ? ` pulse ${s.pulse}` : ''}` : '';
    out.push(`${s.kind} ${name}${clock}`, ['node', s.id]);
  }
  for (const s of model.signals) if (s.states?.length) out.push(`${idOf(s.id)} has ${s.states.map((x) => (/[\s,]/.test(x) ? `"${x}"` : x)).join(',')}`);
  const times = [...new Set(model.signals.flatMap((s) => s.changes.map((c) => c.time)))].sort((a, b) => a - b);
  for (const t of times) {
    out.push(`@${t}`);
    for (const s of model.signals) for (const c of s.changes) if (c.time === t) out.push(`${idOf(s.id)} is ${/[\s,:]/.test(c.state) ? `"${c.state}"` : c.state}`);
  }
  for (const m of model.messages) out.push(`${idOf(m.from)}@${m.fromTime} -> ${idOf(m.to)}@${m.toTime}${m.label ? ` : ${inline(m.label)}` : ''}`);
  out.push('@enduml');
  const parsed = parsePuml(out.text()).diagram.special;
  const ids: IdMap = { nodes: {}, edges: {} };
  if (parsed?.type === 'timing') {
    for (const s of model.signals) {
      const hit = parsed.signals.find((q) => q.line === out.bornLine('node', s.id));
      if (hit) ids.nodes[s.id] = hit.id;
    }
  }
  return { source: out.text(), layout: rekeyLayout(layout, ids), warnings: losses.warnings('PlantUML'), ids };
}
