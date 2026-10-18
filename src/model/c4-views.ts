import type { DContainer, DEdge, Diagram, DNode } from './types.ts';

/**
 * C4 zoom levels as views of one source. A PlantUML C4 file that nests
 * `Container_Boundary` inside `System_Boundary` holds all three levels at
 * once; a view shows one of them without the source changing:
 *
 * - `context`: people and systems. Every system and container boundary is
 *   collapsed into one box (a system box for `System_Boundary`, a container
 *   box for a `Container_Boundary` outside any system), everything inside it
 *   is hidden, and relations are lifted to the boxes that are left: `web →
 *   orders` inside the shop becomes nothing, `customer → web` becomes
 *   `customer → shop`. Lifted relations between the same two boxes become
 *   one line.
 * - `container:<system>`: that system boundary is open (its containers are
 *   shown, container boundaries inside it collapsed into container boxes),
 *   every other system collapsed, and only what relates to the inside of the
 *   system is kept.
 * - `component:<container>`: that container boundary is open (its
 *   components are shown) inside its system, which is open too; again only
 *   what relates to the inside is kept.
 *
 * Enterprise and plain `Boundary` groupings never collapse: they are drawn
 * around whatever of their contents a view keeps. Collapsed boxes keep the
 * boundary's id, so a sidecar entry and a relation written against the
 * boundary (`Rel(web, api, ...)`) keep meaning the same thing. Each view has
 * its own layout under the sidecar's `views` map (see `layout-file.ts`);
 * the diagram as written stays the top level.
 */

export interface C4ViewInfo {
  /** Sidecar key and CLI/URL value: `context`, `container:<id>`, `component:<id>`. */
  key: string;
  label: string;
}

const collapsible = (c: DContainer) => c.c4Boundary === 'system' || c.c4Boundary === 'container';

/** The views a diagram offers: none unless it is C4 with at least one system or container boundary. */
export function c4Views(diagram: Diagram): C4ViewInfo[] {
  if (diagram.family !== 'c4' || !diagram.containers.some(collapsible)) return [];
  const out: C4ViewInfo[] = [{ key: 'context', label: 'Context' }];
  for (const c of diagram.containers) if (c.c4Boundary === 'system') out.push({ key: `container:${c.id}`, label: `Containers · ${c.label}` });
  for (const c of diagram.containers) if (c.c4Boundary === 'container') out.push({ key: `component:${c.id}`, label: `Components · ${c.label}` });
  return out;
}

/** Splits `container:shop` into level and focus; undefined for anything that isn't a view key. */
export function parseViewKey(key: string): { level: 'context' } | { level: 'container' | 'component'; focus: string } | undefined {
  if (key === 'context') return { level: 'context' };
  const m = /^(container|component):(.+)$/.exec(key);
  return m ? { level: m[1] as 'container' | 'component', focus: m[2]! } : undefined;
}

/**
 * The diagram at one zoom level. Throws on a key the diagram doesn't offer
 * (the CLI reports it; the editor only offers `c4Views`).
 */
export function c4View(diagram: Diagram, key: string): Diagram {
  const view = parseViewKey(key);
  const containers = new Map(diagram.containers.map((c) => [c.id, c]));
  if (!view) throw new Error(`unknown view ${key}; use context, container:<id> or component:<id>`);
  if (view.level !== 'context') {
    const f = containers.get(view.focus);
    if (!f || f.c4Boundary !== (view.level === 'container' ? 'system' : 'container')) {
      const offered = c4Views(diagram).map((v) => v.key);
      throw new Error(`no ${view.level === 'container' ? 'System_Boundary' : 'Container_Boundary'} "${view.focus}"; views: ${offered.join(', ') || 'none'}`);
    }
  }

  /** Ancestor chain, outermost first, of a node's or container's parent. */
  const chain = (parent: string | undefined): DContainer[] => {
    const out: DContainer[] = [];
    for (let p = parent; p; p = containers.get(p)?.parent) {
      const c = containers.get(p);
      if (!c || out.includes(c)) break;
      out.unshift(c);
    }
    return out;
  };

  // Open boundaries: the focus and everything around it. Every other collapsible boundary is closed.
  const open = new Set<string>();
  if (view.level !== 'context') {
    open.add(view.focus);
    for (const c of chain(containers.get(view.focus)!.parent)) open.add(c.id);
  }
  const closed = (c: DContainer) => collapsible(c) && !open.has(c.id);

  /** What an element (node or container id) is drawn as: itself, or the outermost closed boundary around it. */
  const rep = new Map<string, string>();
  // A closed boundary itself is drawn as its box (same id); an open one stays a container.
  const repOf = (id: string, parent: string | undefined): string => chain(parent).find(closed)?.id ?? id;
  for (const n of diagram.nodes) rep.set(n.id, repOf(n.id, n.parent));
  for (const c of diagram.containers) rep.set(c.id, repOf(c.id, c.parent));

  /** Collapsed boundaries that are drawn: closed, not inside another closed one. */
  const boxes = diagram.containers.filter((c) => closed(c) && rep.get(c.id) === c.id);
  const boxIds = new Set(boxes.map((c) => c.id));
  /** Parent in the view: the nearest open container around it (closed ones are boxes or hidden). */
  const viewParent = (parent: string | undefined) => {
    const open = chain(parent).filter((c) => !closed(c));
    return open.length ? open[open.length - 1]!.id : undefined;
  };

  // Lift relations: both ends to what they are drawn as; lines inside one box vanish; same pair → one line.
  const lifted = new Map<string, DEdge[]>();
  const hiddenKept: DEdge[] = [];
  for (const e of diagram.edges) {
    const from = rep.get(e.from) ?? e.from;
    const to = rep.get(e.to) ?? e.to;
    if (from === to) continue;
    if (e.hidden) {
      // Layout hints only mean something between the elements they were written for.
      if (from === e.from && to === e.to) hiddenKept.push(e);
      continue;
    }
    const pair = `${from}\u0000${to}`;
    lifted.set(pair, [...(lifted.get(pair) ?? []), e]);
  }
  const edges: DEdge[] = [...lifted.values()].map((group) => liftEdge(group, rep.get(group[0]!.from) ?? group[0]!.from, rep.get(group[0]!.to) ?? group[0]!.to));

  // Elements drawn before filtering: visible nodes (no closed boundary around them) and the boxes.
  const shownNodes: DNode[] = [
    ...diagram.nodes.filter((n) => rep.get(n.id) === n.id).map((n) => withParent(n, viewParent(n.parent))),
    ...boxes.map((c) => boxNode(c, viewParent(c.parent))),
  ];

  // Container and component views keep only the inside of the focus and what relates to it.
  let keep: Set<string>;
  if (view.level === 'context') keep = new Set(shownNodes.map((n) => n.id));
  else {
    const inside = (id: string) => {
      const n = diagram.nodes.find((x) => x.id === id);
      const c = containers.get(id);
      const parent = n ? n.parent : c?.parent;
      return chain(parent).some((a) => a.id === view.focus);
    };
    const inner = new Set(shownNodes.filter((n) => inside(n.id)).map((n) => n.id));
    inner.add(view.focus);
    const direct = new Set(inner);
    for (const e of edges) {
      if (inner.has(e.from)) direct.add(e.to);
      if (inner.has(e.to)) direct.add(e.from);
    }
    keep = new Set([...direct].filter((id) => shownNodes.some((n) => n.id === id) || id === view.focus));
  }

  const nodes = shownNodes.filter((n) => keep.has(n.id));
  // Open containers that still hold something (or are the focus, or a line ends on them).
  const ends = new Set(edges.flatMap((e) => [e.from, e.to]).filter((id) => keep.has(id)));
  const used = new Set<string>();
  const mark = (parent: string | undefined) => {
    for (const c of chain(parent)) used.add(c.id);
  };
  for (const n of nodes) mark(n.parent);
  for (const c of diagram.containers) {
    if (closed(c) || rep.get(c.id) !== c.id) continue;
    if ((view.level !== 'context' && c.id === view.focus) || ends.has(c.id)) {
      used.add(c.id);
      mark(c.parent);
    }
  }
  const shownContainers = diagram.containers.filter((c) => used.has(c.id) && !closed(c) && rep.get(c.id) === c.id && !boxIds.has(c.id));
  const present = new Set([...nodes.map((n) => n.id), ...shownContainers.map((c) => c.id)]);

  return {
    ...diagram,
    nodes,
    containers: shownContainers.map((c) => withParent(c, viewParent(c.parent))),
    edges: [...edges, ...hiddenKept].filter((e) => present.has(e.from) && present.has(e.to)),
  };
}

function withParent<T extends { parent?: string }>(x: T, parent: string | undefined): T {
  const { parent: _old, ...rest } = x;
  return (parent ? { ...rest, parent } : rest) as T;
}

/** A closed boundary drawn as one box: a system for `System_Boundary`, a container for `Container_Boundary`. */
function boxNode(c: DContainer, parent: string | undefined): DNode {
  const node: DNode = { id: c.id, kind: c.c4Boundary === 'system' ? 'system' : 'container', label: c.label, line: c.line };
  if (parent) node.parent = parent;
  return node;
}

/**
 * One line for every relation between the same two boxes. A single relation
 * keeps its id and label; several get the id the first one would have had
 * between the boxes, and their names merged (`Uses`, `Uses, Calls`,
 * `Uses, Calls and 2 more`), with the technology only when they all share it.
 */
function liftEdge(group: DEdge[], from: string, to: string): DEdge {
  const first = group[0]!;
  const bare = first.id.replace(/#\d+$/, '');
  const op = bare.startsWith(first.from) && bare.endsWith(first.to) ? bare.slice(first.from.length, bare.length - first.to.length) : '..>';
  const id = group.length === 1 && from === first.from && to === first.to ? first.id : `${from}${op}${to}`;
  const edge: DEdge = { ...first, id, from, to };
  if (group.some((e) => e.tail !== 'none')) edge.tail = group.find((e) => e.tail !== 'none')!.tail;
  if (group.length > 1) {
    const split = (label?: string) => {
      const [name = '', ...rest] = (label ?? '').split('\n');
      const tech = rest.find((l) => /^\[.*\]$/.test(l.trim()));
      return { name: name.trim(), tech };
    };
    const parts = group.map((e) => split(e.label));
    const names = [...new Set(parts.map((p) => p.name).filter(Boolean))];
    const techs = new Set(parts.map((p) => p.tech));
    const name = names.length <= 2 ? names.join(', ') : `${names.slice(0, 2).join(', ')} and ${names.length - 2} more`;
    const tech = techs.size === 1 ? [...techs][0] : undefined;
    const label = name ? (tech ? `${name}\n${tech}` : name) : undefined;
    if (label) edge.label = label;
    else delete edge.label;
    delete edge.fromLabel;
    delete edge.toLabel;
  }
  return edge;
}
