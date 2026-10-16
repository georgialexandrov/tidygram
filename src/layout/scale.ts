import type { Diagram } from '../model/types.ts';
import { ancestry, containerBoxes, nodeBox, overlaps, type Box, type Positions } from '../scene/containers.ts';
import { containerPad } from '../scene/shapes.ts';
import { scaledTheme, themeFor } from '../scene/theme.ts';
import { shapesFor } from './auto.ts';
import type { LayoutFile } from './layout-file.ts';
import { ROUTING } from '../scene/route.ts';

/**
 * Minimum clearance between elements: the router's buffer on both sides plus
 * a little. Inside it, libavoid's padded shapes overlap, which both blocks
 * line corridors and makes routing 10-30x slower.
 */
export const CLEARANCE = ROUTING.shapeBuffer * 2 + 4;

/**
 * Largest size factor at which text, icons and shapes still fit the layout.
 * Positions are centres and stay put; elements grow into the empty space
 * around them. A size passes when no two elements come closer than a gap
 * the router needs for a line between them, and no
 * container runs into an element or container it doesn't hold. Clashes that
 * already exist at 100% (a hand-made overlap, say) are tolerated only as
 * long as they don't turn into actual overlaps.
 */
export function largestScale(diagram: Diagram, layout: LayoutFile, max = 3): number {
  const base = themeFor(layout.view?.theme);
  const positions: Positions = Object.fromEntries(diagram.nodes.filter((n) => layout.nodes[n.id]).map((n) => [n.id, layout.nodes[n.id]!]));
  const ids = Object.keys(positions);
  const containerIds = new Map(diagram.nodes.map((n) => [n.id, new Set(ancestry(diagram, n.parent))]));
  const containerAncestors = new Map(diagram.containers.map((c) => [c.id, new Set(ancestry(diagram, c.parent))]));

  const clashes = (s: number, gap: number): Set<string> => {
    const theme = scaledTheme(base, s, layout.view?.text ?? 1, layout.view?.icons ?? 1);
    const shapes = shapesFor(diagram, theme);
    const boxes = new Map<string, Box>(ids.map((id) => [id, nodeBox(positions[id]!, shapes.get(id)!)]));
    const containers = containerBoxes(diagram, positions, shapes, containerPad(theme));
    const found = new Set<string>();
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        if (overlaps(boxes.get(ids[i]!)!, boxes.get(ids[j]!)!, gap)) found.add(`${ids[i]}|${ids[j]}`);
      }
      for (const [cid, cbox] of containers) {
        if (!containerIds.get(ids[i]!)!.has(cid) && overlaps(boxes.get(ids[i]!)!, cbox, gap / 2)) found.add(`${ids[i]}|c:${cid}`);
      }
    }
    const cids = [...containers.keys()];
    for (let i = 0; i < cids.length; i++) {
      for (let j = i + 1; j < cids.length; j++) {
        const [a, b] = [cids[i]!, cids[j]!];
        if (containerAncestors.get(a)!.has(b) || containerAncestors.get(b)!.has(a)) continue; // nested
        if (overlaps(containers.get(a)!, containers.get(b)!, gap / 2)) found.add(`c:${a}|c:${b}`);
      }
    }
    return found;
  };

  const close = clashes(1, CLEARANCE);
  const overlapping = clashes(1, 0);
  const fits = (s: number) => [...clashes(s, CLEARANCE)].every((k) => close.has(k)) && [...clashes(s, 0)].every((k) => overlapping.has(k));
  if (!fits(1.05)) return 1;
  let lo = 1.05;
  let hi = max;
  if (fits(hi)) return hi;
  for (let i = 0; i < 14; i++) {
    const mid = (lo + hi) / 2;
    if (fits(mid)) lo = mid;
    else hi = mid;
  }
  return Math.floor(lo * 20) / 20; // whole 5% steps
}
