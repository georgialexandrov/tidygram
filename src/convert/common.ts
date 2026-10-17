import type { LayoutFile } from '../layout/layout-file.ts';
import type { Diagram, NodeKind, ParseWarning } from '../model/types.ts';

/**
 * Shared machinery for the format writers. A writer emits source text line
 * by line, remembering on which line each element of the original diagram is
 * born; it then re-parses its own output with our parser and pairs every
 * original element with the one born on its line. That pairing is the id map
 * (old → new), which re-keys the layout. Ids we choose (node aliases) are
 * kept whenever the target's syntax allows them; ids the target derives
 * itself (`A-->B` edge ids, `note:X`, `[*]@Busy`) come out of the parse, so
 * the map is right by construction instead of by re-implementing each
 * parser's id rules here.
 */

export type ConvertTarget = 'puml' | 'mermaid' | 'drawio';

/** Old id → new id, for nodes (incl. containers, participants, tasks, signals) and edges (incl. messages). */
export interface IdMap {
  nodes: Record<string, string>;
  edges: Record<string, string>;
}

export interface ConvertResult {
  source: string;
  /** The sidecar for the new source: the input layout re-keyed through `ids`. */
  layout: LayoutFile;
  warnings: ParseWarning[];
  ids: IdMap;
}

export const warn = (message: string): ParseWarning => ({ line: 0, text: '', message });

/** Collects "this kind isn't in the target" once per kind, with a count. */
export class KindLosses {
  private counts = new Map<string, number>();
  add(what: string): void {
    this.counts.set(what, (this.counts.get(what) ?? 0) + 1);
  }
  warnings(target: string): ParseWarning[] {
    return [...this.counts].map(([what, n]) => warn(`${n > 1 ? `${n} × ` : ''}${what} (no exact equivalent in ${target})`));
  }
}

export type Category = 'node' | 'container' | 'edge';

/** Output lines plus where each original element is born. */
export class Emitter {
  readonly lines: string[] = [];
  readonly born = new Map<string, { cat: Category; line: number }>();
  /** Appends a line; returns its 1-based number. */
  push(text: string, ...elements: [Category, string][]): number {
    this.lines.push(text);
    const line = this.lines.length;
    for (const [cat, id] of elements) if (!this.born.has(`${cat}:${id}`)) this.born.set(`${cat}:${id}`, { cat, line });
    return line;
  }
  /** Marks an element as born on an existing line (pseudo-states first mentioned in a transition). */
  mark(cat: Category, id: string, line: number): void {
    if (!this.born.has(`${cat}:${id}`)) this.born.set(`${cat}:${id}`, { cat, line });
  }
  bornLine(cat: Category, id: string): number | undefined {
    return this.born.get(`${cat}:${id}`)?.line;
  }
  text(): string {
    return `${this.lines.join('\n')}\n`;
  }
}

/**
 * Allocates target ids: an id the target can write as is stays; anything
 * else becomes a sanitised form, made unique against every other id.
 */
export class IdAllocator {
  private used = new Set<string>();
  private assigned = new Map<string, string>();
  private legal: (id: string) => boolean;
  private sanitise: (id: string) => string;
  constructor(legal: (id: string) => boolean, sanitise: (id: string) => string) {
    this.legal = legal;
    this.sanitise = sanitise;
  }
  /** Reserves the ids that are already legal first, so a sanitised id never takes one of them. */
  reserve(ids: string[]): void {
    for (const id of ids) {
      if (this.legal(id) && !this.used.has(id)) {
        this.used.add(id);
        this.assigned.set(id, id);
      }
    }
  }
  get(id: string): string {
    const known = this.assigned.get(id);
    if (known !== undefined) return known;
    const base = this.sanitise(id) || 'n';
    let candidate = base;
    for (let i = 2; this.used.has(candidate) || !this.legal(candidate); i++) candidate = `${base}_${i}`;
    this.used.add(candidate);
    this.assigned.set(id, candidate);
    return candidate;
  }
}

/** `if: card valid?` → `if_card_valid`: word characters only, runs of anything else as one `_`. */
export const wordId = (id: string) =>
  id
    .replace(/[^\p{L}\p{N}_]+/gu, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/^(\d)/, 'n$1');

/**
 * Pairs the original graph with its re-parse through the lines the writer
 * recorded. On a line with several candidates (a transition that also
 * creates `[*]`), the id we asked for wins, then the same kind, then the
 * same ends (edges), then order.
 */
export function matchGraph(original: Diagram, parsed: Diagram, emitter: Emitter, intended: (id: string) => string | undefined): { ids: IdMap; warnings: ParseWarning[] } {
  const ids: IdMap = { nodes: {}, edges: {} };
  const warnings: ParseWarning[] = [];
  const byLine = <T extends { line: number }>(items: T[]) => {
    const m = new Map<number, T[]>();
    for (const it of items) m.set(it.line, [...(m.get(it.line) ?? []), it]);
    return m;
  };
  const claim = <T extends { id: string; line: number }>(cat: Category, items: Map<number, T[]>, claimed: Set<T>, id: string, score: (c: T) => number) => {
    const line = emitter.bornLine(cat, id);
    if (line === undefined) return undefined;
    const pool = (items.get(line) ?? []).filter((c) => !claimed.has(c));
    if (!pool.length) return undefined;
    const best = pool.map((c, i) => [c, score(c) * 100 - i] as const).sort((a, b) => b[1] - a[1])[0]![0];
    claimed.add(best);
    return best;
  };

  const nodes = byLine(parsed.nodes);
  const containers = byLine(parsed.containers);
  const claimedNodes = new Set<(typeof parsed.nodes)[number]>();
  const claimedContainers = new Set<(typeof parsed.containers)[number]>();
  for (const c of original.containers) {
    const hit = claim('container', containers, claimedContainers, c.id, (p) => (p.id === intended(c.id) ? 2 : 0) + (p.label === c.label ? 1 : 0));
    if (hit) ids.nodes[c.id] = hit.id;
  }
  for (const n of original.nodes) {
    const hit = claim('node', nodes, claimedNodes, n.id, (p) => (p.id === intended(n.id) ? 4 : 0) + (p.kind === n.kind ? 2 : 0) + (p.label === n.label ? 1 : 0));
    if (hit) ids.nodes[n.id] = hit.id;
  }
  const edges = byLine(parsed.edges);
  const claimedEdges = new Set<(typeof parsed.edges)[number]>();
  for (const e of original.edges) {
    const hit = claim('edge', edges, claimedEdges, e.id, (p) => (p.from === ids.nodes[e.from] && p.to === ids.nodes[e.to] ? 2 : 0) + (p.head === e.head ? 1 : 0));
    if (hit) ids.edges[e.id] = hit.id;
  }
  const lostNodes = [
    ...original.containers.filter((c) => emitter.bornLine('container', c.id) !== undefined && !ids.nodes[c.id]),
    ...original.nodes.filter((n) => emitter.bornLine('node', n.id) !== undefined && !ids.nodes[n.id]),
  ];
  const lostEdges = original.edges.filter((e) => emitter.bornLine('edge', e.id) !== undefined && !ids.edges[e.id]);
  if (lostNodes.length) warnings.push(warn(`Not read back from the output: ${lostNodes.map((n) => n.id).join(', ')}`));
  if (lostEdges.length) warnings.push(warn(`Lines not read back from the output: ${lostEdges.map((e) => e.id).join(', ')}`));
  return { ids, warnings };
}

/** The input layout under the new ids; entries for ids that didn't make it are dropped. */
export function rekeyLayout(layout: LayoutFile, ids: IdMap): LayoutFile {
  const next: LayoutFile = { version: 1, nodes: {}, edges: {} };
  if (layout.view) next.view = { ...layout.view };
  for (const [id, entry] of Object.entries(layout.nodes)) {
    const to = ids.nodes[id];
    if (to !== undefined) next.nodes[to] = { ...entry };
  }
  for (const [id, entry] of Object.entries(layout.edges)) {
    const to = ids.edges[id];
    if (to !== undefined) next.edges[to] = { ...entry, ...(entry.via ? { via: entry.via.map(([x, y]) => [x, y] as [number, number]) } : {}) };
  }
  return next;
}

// ---- geometry hints ------------------------------------------------------------------------------

export type Side = 'right' | 'left' | 'down' | 'up';

/** Centre of a node, or of a container's positioned descendants. */
function centre(diagram: Diagram, layout: LayoutFile, id: string): { x: number; y: number } | undefined {
  const p = layout.nodes[id];
  if (p && diagram.nodes.some((n) => n.id === id)) return p;
  if (!diagram.containers.some((c) => c.id === id)) return undefined;
  const inside = new Set([id]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const c of diagram.containers) if (c.parent && inside.has(c.parent) && !inside.has(c.id)) (inside.add(c.id), (grew = true));
  }
  const points = diagram.nodes.filter((n) => n.parent && inside.has(n.parent)).map((n) => layout.nodes[n.id]).filter((q) => q !== undefined);
  if (!points.length) return undefined;
  return { x: points.reduce((s, q) => s + q.x, 0) / points.length, y: points.reduce((s, q) => s + q.y, 0) / points.length };
}

/** Which way a line runs in the stored layout, from its source's centre to its target's. */
export function sideOf(diagram: Diagram, layout: LayoutFile, from: string, to: string): Side | undefined {
  if (from === to) return undefined;
  const a = centre(diagram, layout, from);
  const b = centre(diagram, layout, to);
  if (!a || !b) return undefined;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return undefined;
  return Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : dy > 0 ? 'down' : 'up';
}

/** LR when most lines in the layout run sideways; the model's own direction when nothing is placed. */
export function dominantDirection(diagram: Diagram, layout: LayoutFile): Diagram['direction'] {
  let across = 0;
  let along = 0;
  for (const e of diagram.edges) {
    const side = sideOf(diagram, layout, e.from, e.to);
    if (side === 'left' || side === 'right') across++;
    else if (side) along++;
  }
  return across + along === 0 ? diagram.direction : across > along ? 'LR' : 'TB';
}

/**
 * PlantUML's direction keywords are relative to the rank direction: under
 * `left to right direction` a plain (`down`) arrow runs rightwards and
 * `right` means "same rank", i.e. stacked. So the geometric side is rotated
 * into the keyword that produces it; the default (`down`) is left out.
 */
export function pumlHint(side: Side, direction: Diagram['direction']): Side | undefined {
  const keyword = direction === 'TB' ? side : ({ right: 'down', left: 'up', down: 'right', up: 'left' } as const)[side];
  // `down` is what a plain `-->` already does: no keyword needed.
  return keyword === 'down' ? undefined : keyword;
}

/** Node kinds that only exist as structure in some targets: never worth a per-kind warning. */
export const PSEUDO_KINDS = new Set<NodeKind>(['initial', 'final', 'history', 'choice', 'fork']);
