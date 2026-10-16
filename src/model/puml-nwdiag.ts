import type { DContainer, DEdge, DNode, NodeKind, ParseWarning } from './types.ts';
import type { ParseResult } from './parse.ts';
import { splitArgs, unescape, unquote, type Line } from './puml-util.ts';

/**
 * `@startnwdiag`: networks are bars, hosts hang off every network that lists
 * them, with the host's address at the host's end of that line. A host
 * already on an earlier network links down into the later one, so layered
 * layout stacks the bars in source order with shared hosts between them, as
 * nwdiag draws it. `group` becomes a container,
 * `a -- b` a direct peer link. Networks are `net:<name>` and groups
 * `group:<name>` so they can't collide with host names.
 */

const SHAPES: Record<string, NodeKind> = {
  actor: 'actor',
  agent: 'agent',
  artifact: 'artifact',
  boundary: 'boundary',
  card: 'card',
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
  queue: 'queue',
  rectangle: 'rectangle',
  stack: 'stack',
  storage: 'storage',
  usecase: 'usecase',
};

/** `[address = "10.0.0.1", shape = database]` → { address: '10.0.0.1', shape: 'database' }. */
function attributes(text: string | undefined): Record<string, string> {
  if (!text) return {};
  return Object.fromEntries(
    splitArgs(text)
      .map((a) => /^([\w-]+)\s*=\s*(.*)$/.exec(a))
      .filter((m): m is RegExpExecArray => !!m)
      .map((m) => [m[1]!.toLowerCase(), unquote(m[2])]),
  );
}

export function parseNwdiag(lines: Line[]): ParseResult {
  const nodes = new Map<string, DNode>();
  const containers: DContainer[] = [];
  const edges: DEdge[] = [];
  const warnings: ParseWarning[] = [];
  const counts = new Map<string, number>();
  /** What the current `{` opened. */
  const stack: { type: 'nwdiag' | 'network' | 'group' | 'other'; id?: string }[] = [];

  const host = (id: string, line: number) => {
    if (!nodes.has(id)) nodes.set(id, { id, kind: 'rectangle', label: id, line });
    return nodes.get(id)!;
  };

  const applyHost = (node: DNode, attrs: Record<string, string>) => {
    if (attrs.description) node.label = unescape(attrs.description);
    const kind = attrs.shape && SHAPES[attrs.shape.toLowerCase()];
    if (kind) node.kind = kind;
  };

  /** Hosts that are on some network already. */
  const attached = new Set<string>();

  const addEdge = (from: string, to: string, line: number, ends: { fromLabel?: string; toLabel?: string } = {}) => {
    const base = `${from}--${to}`;
    const n = (counts.get(base) ?? 0) + 1;
    counts.set(base, n);
    const edge: DEdge = { id: n === 1 ? base : `${base}#${n}`, from, to, kind: 'association', dashed: false, head: 'none', tail: 'none', hidden: false, line };
    if (ends.fromLabel) edge.fromLabel = ends.fromLabel;
    if (ends.toLabel) edge.toLabel = ends.toLabel;
    edges.push(edge);
  };

  for (const { no, raw, text: full } of lines) {
    const text = full.replace(/;\s*$/, '').trim();
    if (!text || text.startsWith("'") || text.startsWith('@') || text.startsWith('!') || text.startsWith('//')) continue;
    const top = stack[stack.length - 1];

    if (text === '}') {
      if (!stack.length) warnings.push({ line: no, text: raw, message: 'Unmatched }' });
      stack.pop();
      continue;
    }
    if (/^nwdiag\s*\{$/i.test(text)) {
      stack.push({ type: 'nwdiag' });
      continue;
    }
    const block = /^(network|group)(?:\s+([\p{L}\p{N}_.-]+))?\s*\{$/iu.exec(text);
    if (block) {
      const type = block[1]!.toLowerCase() as 'network' | 'group';
      const name = block[2] ?? `${type}${no}`;
      if (type === 'network') {
        const id = `net:${name}`;
        nodes.set(id, { id, kind: 'network', label: name, line: no });
        stack.push({ type, id });
      } else {
        const id = `group:${name}`;
        containers.push({ id, kind: 'rectangle', label: block[2] ?? '', line: no });
        stack.push({ type, id });
      }
      continue;
    }
    if (/\{$/.test(text)) {
      // Anything else that opens a block (`<style>`-like sections, unknown keywords): skip its content.
      stack.push({ type: 'other' });
      continue;
    }
    if (top?.type === 'other') continue;

    // Block properties: `address = "..."`, `color = ...`, `description = ...`, `width = full`.
    const prop = /^([\w-]+)\s*=\s*(.+)$/.exec(text);
    if (prop) {
      const key = prop[1]!.toLowerCase();
      const value = unquote(prop[2]);
      if (top?.type === 'network') {
        const net = nodes.get(top.id!)!;
        if (key === 'address') net.description = [value];
        if (key === 'description') net.label = unescape(value);
      } else if (top?.type === 'group' && key === 'description') {
        containers.find((c) => c.id === top.id)!.label = unescape(value);
      }
      continue;
    }

    // Peer links: `a -- b -- c`.
    if (/\s--\s/.test(text)) {
      const ids = text.split(/\s*--\s*/).map((s) => s.trim());
      for (const id of ids) host(id, no);
      for (let i = 1; i < ids.length; i++) addEdge(ids[i - 1]!, ids[i]!, no);
      continue;
    }

    // Host: `web01`, `web01 [address = "..", shape = database]`, `web01, web02` in groups.
    const hostMatch = /^([\p{L}\p{N}_.-]+(?:\s*,\s*[\p{L}\p{N}_.-]+)*)\s*(?:\[(.*)\])?$/u.exec(text);
    if (hostMatch) {
      const attrs = attributes(hostMatch[2]);
      for (const id of hostMatch[1]!.split(/\s*,\s*/)) {
        const node = host(id, no);
        applyHost(node, attrs);
        if (top?.type === 'network') {
          const address = attrs.address?.replace(/\s*,\s*/g, '\n');
          if (attached.has(id)) addEdge(id, top.id!, no, { fromLabel: address });
          else addEdge(top.id!, id, no, { toLabel: address });
          attached.add(id);
        }
        if (top?.type === 'group') node.parent = top.id;
      }
      continue;
    }

    warnings.push({ line: no, text: raw, message: 'Unsupported line, ignored' });
  }

  return { diagram: { family: 'network', direction: 'TB', nodes: [...nodes.values()], containers, edges }, warnings };
}
