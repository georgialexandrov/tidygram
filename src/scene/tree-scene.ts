import type { DEdge, Diagram } from '../model/types.ts';
import { treeGrowth, treeLine } from '../layout/tree.ts';
import type { Scene, SceneEdge, SceneNode } from './scene.ts';
import type { Theme } from './theme.ts';

/** Scene for a mindmap / WBS: the lines are curves or elbows computed from the boxes, never routed. */
export function treeScene(diagram: Diagram, theme: Theme, nodes: SceneNode[], visible: DEdge[]): Scene {
  const byId = new Map(nodes.map((n) => [n.node.id, n]));
  const hasParent = new Set(visible.map((e) => e.to));
  const family = diagram.family === 'wbs' ? 'wbs' : 'mindmap';
  const growth = treeGrowth(diagram);
  const edges: SceneEdge[] = visible.flatMap((e) => {
    const a = byId.get(e.from);
    const b = byId.get(e.to);
    if (!a || !b) return [];
    const { points, path } = treeLine(family, a.box, b.box, { fromRoot: !hasParent.has(e.from), boxless: b.node.stereotype === 'boxless', scale: theme.scale, growth });
    return [{ edge: e, kind: e.kind, points, path, head: 'none', tail: 'none', dashed: e.dashed, via: [] } satisfies SceneEdge];
  });
  const xs = [...nodes.flatMap((n) => [n.box.x, n.box.x + n.box.w]), ...edges.flatMap((e) => e.points.map((p) => p[0]))];
  const ys = [...nodes.flatMap((n) => [n.box.y, n.box.y + n.box.h]), ...edges.flatMap((e) => e.points.map((p) => p[1]))];
  const x0 = Math.min(...xs, 0);
  const y0 = Math.min(...ys, 0);
  return { kind: 'graph', theme, nodes, containers: [], edges, bounds: { x: x0, y: y0, w: Math.max(...xs, 0) - x0, h: Math.max(...ys, 0) - y0 } };
}
