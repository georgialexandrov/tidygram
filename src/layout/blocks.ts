import type { ElkExtendedEdge, ElkNode } from 'elkjs/lib/elk.bundled.js';
import { elk as elkInstance } from './elk.ts';
import type { Diagram } from '../model/types.ts';
import type { Positions } from '../scene/containers.ts';
import { measureText } from '../scene/measure.ts';
import { containerPad, type NodeShape } from '../scene/shapes.ts';
import type { Theme } from '../scene/theme.ts';

/**
 * Bottom-up "block" layout. Each container is laid out on its own first,
 * then treated as one rigid block by the level above. Lines that cross
 * container borders are redirected to the blocks they leave and enter, so a
 * use case deep inside a package still pulls its actor towards that package.
 * This lets every container pick its own flow direction, which is what
 * fitting a diagram into a given aspect ratio needs.
 */

export type Flow = 'RIGHT' | 'DOWN';

export interface BlockChoice {
  /** Flow at the top level (actors, systems, top containers). */
  root: Flow;
  /** Flow inside containers that hold other containers. */
  mid: Flow;
  /** Wrap the mid level into rows/columns toward `ratio`. */
  wrapMid?: boolean;
  /** Flow inside leaf containers; `square` picks whichever is closer to 1:1 per container. */
  leaf: Flow | 'square';
  ratio: number;
}

interface Laid {
  w: number;
  h: number;
  /** Top-left of each child relative to the block's content origin. */
  children: Map<string, { x: number; y: number }>;
}

const SPACING = {
  'elk.spacing.nodeNode': '32',
  'elk.layered.spacing.nodeNodeBetweenLayers': '64',
  'elk.spacing.edgeNode': '16',
};

export async function blockPositions(diagram: Diagram, shapes: Map<string, NodeShape>, theme: Theme, choice: BlockChoice): Promise<Positions> {
  const elk = elkInstance();
  const CONTAINER_PAD = containerPad(theme);
  const parentOf = new Map<string, string>(); // node or container id (prefixed) -> container id ('' = root)
  for (const n of diagram.nodes) parentOf.set(`n:${n.id}`, n.parent ?? '');
  for (const c of diagram.containers) parentOf.set(`c:${c.id}`, c.parent ?? '');
  const chain = (key: string): string[] => {
    const out: string[] = [];
    let p = parentOf.get(key) ?? '';
    while (p) {
      out.unshift(p);
      p = parentOf.get(`c:${p}`) ?? '';
    }
    return out;
  };
  const hasChildContainers = new Set(diagram.containers.filter((c) => c.parent).map((c) => c.parent!));

  // Each diagram edge is assigned to the level of its endpoints' lowest common container.
  const levelEdges = new Map<string, { from: string; to: string; fromNode: string; toNode: string; label?: string }[]>();
  for (const e of diagram.edges) {
    if (e.from === e.to) continue;
    const a = chain(`n:${e.from}`);
    const b = chain(`n:${e.to}`);
    let common = 0;
    while (common < a.length && common < b.length && a[common] === b[common]) common++;
    const level = common ? a[common - 1]! : '';
    const from = a[common] ? `c:${a[common]}` : `n:${e.from}`;
    const to = b[common] ? `c:${b[common]}` : `n:${e.to}`;
    if (from === to) continue;
    const list = levelEdges.get(level) ?? [];
    list.push({ from, to, fromNode: e.from, toNode: e.to, label: e.label });
    levelEdges.set(level, list);
  }

  const cache = new Map<string, Laid>();

  const layoutLevel = async (container: string, flow: Flow, wrap: boolean): Promise<Laid> => {
    const key = `${container}|${flow}|${wrap}`;
    const hit = cache.get(key);
    if (hit) return hit;
    const sizes = new Map<string, { w: number; h: number }>();
    for (const n of diagram.nodes) if ((n.parent ?? '') === container) sizes.set(`n:${n.id}`, shapes.get(n.id)!);
    const laidChildren = new Map<string, Laid>();
    for (const c of diagram.containers) {
      if ((c.parent ?? '') !== container) continue;
      const inner = await layoutContainer(c.id);
      laidChildren.set(`c:${c.id}`, inner);
      nested.set(`c:${c.id}`, inner);
      sizes.set(`c:${c.id}`, { w: inner.w + CONTAINER_PAD.side * 2, h: inner.h + CONTAINER_PAD.top + CONTAINER_PAD.bottom });
    }
    // A line that enters a block gets a port on the block's side at the position of the element it
    // really connects to, so ordering outside the block can follow the layout inside it.
    const levelList = levelEdges.get(container) ?? [];
    const portsByBlock = new Map<string, NonNullable<ElkNode['ports']>>();
    const endpoint = (block: string, node: string, i: number, dir: 'in' | 'out'): string => {
      if (!block.startsWith('c:')) return block;
      const inner = offsetsWithin(block).get(node);
      const size = sizes.get(block)!;
      if (!inner) return block;
      const id = `${block}#${i}${dir}`;
      const side = flow === 'RIGHT' ? (dir === 'in' ? 'WEST' : 'EAST') : dir === 'in' ? 'NORTH' : 'SOUTH';
      const x = flow === 'RIGHT' ? (dir === 'in' ? 0 : size.w) : inner.x;
      const y = flow === 'RIGHT' ? inner.y : dir === 'in' ? 0 : size.h;
      const list = portsByBlock.get(block) ?? [];
      list.push({ id, x, y, width: 1, height: 1, layoutOptions: { 'elk.port.side': side } });
      portsByBlock.set(block, list);
      return id;
    };
    const edges = levelList.map((e, i): ElkExtendedEdge => {
      const edge: ElkExtendedEdge = { id: `e${i}`, sources: [endpoint(e.from, e.fromNode, i, 'out')], targets: [endpoint(e.to, e.toNode, i, 'in')] };
      if (e.label) {
        const t = measureText(e.label, theme.size.edge, false, theme.widthFactor);
        edge.labels = [{ text: e.label, width: t.width + 12, height: t.height + 4 }];
      }
      return edge;
    });
    const graph: ElkNode = {
      id: 'g',
      layoutOptions: {
        'elk.algorithm': 'layered',
        'elk.direction': flow,
        'elk.edgeRouting': 'ORTHOGONAL',
        'elk.padding': '[top=0,left=0,bottom=0,right=0]',
        'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
        'elk.edgeLabels.placement': 'CENTER',
        ...SPACING,
        ...(wrap ? { 'elk.layered.wrapping.strategy': 'MULTI_EDGE', 'elk.aspectRatio': String(choice.ratio) } : {}),
      },
      children: [...sizes].map(([id, s]): ElkNode => {
        const ports = portsByBlock.get(id);
        return ports?.length
          ? { id, width: s.w, height: s.h, ports, layoutOptions: { 'elk.portConstraints': 'FIXED_POS' } }
          : { id, width: s.w, height: s.h };
      }),
      edges,
    };
    const result = await elk.layout(graph);
    const children = new Map<string, { x: number; y: number }>();
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const child of result.children ?? []) {
      const x = child.x ?? 0;
      const y = child.y ?? 0;
      children.set(child.id, { x, y });
      const s = sizes.get(child.id)!;
      x0 = Math.min(x0, x);
      y0 = Math.min(y0, y);
      x1 = Math.max(x1, x + s.w);
      y1 = Math.max(y1, y + s.h);
    }
    // Normalise so the content starts at 0,0 and the block is exactly as big as its children.
    for (const [id, p] of children) children.set(id, { x: p.x - x0, y: p.y - y0 });
    const laid: Laid = { w: Math.max(0, x1 - x0), h: Math.max(0, y1 - y0), children };
    cache.set(key, laid);
    return laid;
  };

  const nested = new Map<string, Laid>();

  /** Centres of every node inside a laid-out container block, relative to the block's top-left corner. */
  const offsetsWithin = (block: string): Map<string, { x: number; y: number }> => {
    const out = new Map<string, { x: number; y: number }>();
    const walk = (laid: Laid, ox: number, oy: number) => {
      for (const [key, p] of laid.children) {
        if (key.startsWith('n:')) {
          const s = shapes.get(key.slice(2))!;
          out.set(key.slice(2), { x: ox + p.x + s.w / 2, y: oy + p.y + s.h / 2 });
        } else {
          const inner = nested.get(key);
          if (inner) walk(inner, ox + p.x + CONTAINER_PAD.side, oy + p.y + CONTAINER_PAD.top);
        }
      }
    };
    const laid = nested.get(block);
    if (laid) walk(laid, CONTAINER_PAD.side, CONTAINER_PAD.top);
    return out;
  };

  const layoutContainer = async (id: string): Promise<Laid> => {
    if (hasChildContainers.has(id)) return layoutLevel(id, choice.mid, choice.wrapMid ?? false);
    if (choice.leaf !== 'square') return layoutLevel(id, choice.leaf, false);
    const right = await layoutLevel(id, 'RIGHT', false);
    const down = await layoutLevel(id, 'DOWN', false);
    const off = (l: Laid) => Math.abs(Math.log((l.w + 1) / (l.h + 1)));
    return off(right) <= off(down) ? right : down;
  };

  const root = await layoutLevel('', choice.root, false);

  // Compose absolute positions top-down.
  const positions: Positions = {};
  const place = (laid: Laid, ox: number, oy: number) => {
    for (const [key, p] of laid.children) {
      if (key.startsWith('n:')) {
        const s = shapes.get(key.slice(2))!;
        positions[key.slice(2)] = { x: ox + p.x + s.w / 2, y: oy + p.y + s.h / 2 };
      } else {
        const inner = nested.get(key);
        if (inner) place(inner, ox + p.x + CONTAINER_PAD.side, oy + p.y + CONTAINER_PAD.top);
      }
    }
  };
  place(root, 0, 0);
  return positions;
}
