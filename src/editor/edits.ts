import type { LayoutFile, Point } from '../layout/layout-file.ts';
import type { Diagram } from '../model/types.ts';
import { pathLength } from '../scene/geometry.ts';

/** Pure layout edits. Each returns a new LayoutFile; the editor keeps the old one for undo. */

export function moveNodes(
  layout: LayoutFile,
  diagram: Diagram,
  origin: Record<string, { x: number; y: number }>,
  originVia: Record<string, Point[]>,
  dx: number,
  dy: number,
): LayoutFile {
  const nodes = { ...layout.nodes };
  for (const [id, p] of Object.entries(origin)) nodes[id] = { ...nodes[id], x: p.x + dx, y: p.y + dy };
  // Bends on lines whose both ends move travel with them; other bends stay put.
  const edges = { ...layout.edges };
  for (const e of diagram.edges) {
    const via = originVia[e.id];
    if (via && origin[e.from] && origin[e.to]) edges[e.id] = { ...edges[e.id], via: via.map(([x, y]) => [x + dx, y + dy]) };
  }
  return { ...layout, nodes, edges };
}

export function setPinned(layout: LayoutFile, ids: Iterable<string>, pinned: boolean): LayoutFile {
  const nodes = { ...layout.nodes };
  for (const id of ids) {
    const n = nodes[id];
    if (!n) continue;
    nodes[id] = pinned ? { x: n.x, y: n.y, pinned: true } : { x: n.x, y: n.y };
  }
  return { ...layout, nodes };
}

function updateEdge(layout: LayoutFile, id: string, via: Point[] | undefined, label?: Point | null): LayoutFile {
  const current = layout.edges[id] ?? {};
  const next = { ...current };
  if (via !== undefined) {
    if (via.length) next.via = via;
    else delete next.via;
  }
  if (label === null) delete next.label;
  else if (label) next.label = label;
  const edges = { ...layout.edges };
  if (next.via || next.label) edges[id] = next;
  else delete edges[id];
  return { ...layout, edges };
}

/** Inserts a bend where it lengthens the route least, so it lands in the right order. Returns the new index. */
export function insertVia(layout: LayoutFile, diagram: Diagram, id: string, point: Point): { layout: LayoutFile; index: number } {
  const edge = diagram.edges.find((e) => e.id === id);
  const from = edge && layout.nodes[edge.from];
  const to = edge && layout.nodes[edge.to];
  const via = layout.edges[id]?.via ?? [];
  if (!from || !to) return { layout, index: -1 };
  let best = 0;
  let bestLen = Infinity;
  for (let i = 0; i <= via.length; i++) {
    const candidate = [...via.slice(0, i), point, ...via.slice(i)];
    const len = pathLength([[from.x, from.y], ...candidate, [to.x, to.y]]);
    if (len < bestLen) {
      bestLen = len;
      best = i;
    }
  }
  return { layout: updateEdge(layout, id, [...via.slice(0, best), point, ...via.slice(best)]), index: best };
}

export function moveVia(layout: LayoutFile, id: string, index: number, point: Point): LayoutFile {
  const via = [...(layout.edges[id]?.via ?? [])];
  if (index < 0 || index >= via.length) return layout;
  via[index] = point;
  return updateEdge(layout, id, via);
}

export function removeVia(layout: LayoutFile, id: string, index: number): LayoutFile {
  const via = (layout.edges[id]?.via ?? []).filter((_, i) => i !== index);
  return updateEdge(layout, id, via);
}

export function clearVia(layout: LayoutFile, id: string): LayoutFile {
  return updateEdge(layout, id, [], null);
}

export function setLabelOffset(layout: LayoutFile, id: string, offset: Point): LayoutFile {
  const isZero = Math.abs(offset[0]) < 1 && Math.abs(offset[1]) < 1;
  return updateEdge(layout, id, undefined, isZero ? null : offset);
}

export interface Guide {
  axis: 'x' | 'y';
  value: number;
}

/**
 * Snaps a dragged node centre to the centre line of any other node within
 * `threshold`, so rows and columns line up. Returns the adjustment and the guides to draw.
 */
export function alignmentSnap(
  candidate: { x: number; y: number },
  others: { x: number; y: number }[],
  threshold: number,
): { dx: number; dy: number; guides: Guide[] } {
  let bestX: number | undefined;
  let bestY: number | undefined;
  for (const o of others) {
    const ex = o.x - candidate.x;
    const ey = o.y - candidate.y;
    if (Math.abs(ex) <= threshold && (bestX === undefined || Math.abs(ex) < Math.abs(bestX))) bestX = ex;
    if (Math.abs(ey) <= threshold && (bestY === undefined || Math.abs(ey) < Math.abs(bestY))) bestY = ey;
  }
  const guides: Guide[] = [];
  if (bestX !== undefined) guides.push({ axis: 'x', value: candidate.x + bestX });
  if (bestY !== undefined) guides.push({ axis: 'y', value: candidate.y + bestY });
  return { dx: bestX ?? 0, dy: bestY ?? 0, guides };
}
