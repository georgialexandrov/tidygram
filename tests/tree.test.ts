import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { moveSelection } from '../src/editor/edits.ts';
import { ensureLayout } from '../src/layout/auto.ts';
import { emptyLayout } from '../src/layout/layout-file.ts';
import { subtreeIds } from '../src/layout/tree.ts';
import { parseMermaid } from '../src/model/mermaid.ts';
import { parsePuml } from '../src/model/parse.ts';
import type { Diagram } from '../src/model/types.ts';
import { loadAvoid, type Avoid } from '../src/scene/avoid.ts';
import { overlaps } from '../src/scene/containers.ts';
import { buildScene } from '../src/scene/scene.ts';

const require = createRequire(import.meta.url);
const read = (name: string) => readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8');
let avoid: Avoid;
beforeAll(async () => {
  avoid = await loadAvoid(join(dirname(require.resolve('libavoid-js')), 'libavoid.wasm'));
});

const sources: Record<string, () => Diagram> = {
  'mindmap.puml': () => parsePuml(read('mindmap.puml')).diagram,
  'mermaid/mindmap.mmd': () => parseMermaid(read('mermaid/mindmap.mmd')).diagram,
  'wbs.puml': () => parsePuml(read('wbs.puml')).diagram,
};

async function built(name: string, diagram = sources[name]!()) {
  const layout = await ensureLayout(diagram, emptyLayout(), 'reset');
  return { diagram, layout, scene: buildScene(diagram, layout, avoid) };
}

describe('tree layout', () => {
  for (const name of Object.keys(sources)) {
    describe(name, () => {
      it('has no overlaps', async () => {
        const { scene } = await built(name);
        const boxes = scene.nodes.map((n) => n.box);
        for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) expect(overlaps(boxes[i]!, boxes[j]!, 0), `${scene.nodes[i]!.node.id} / ${scene.nodes[j]!.node.id}`).toBe(false);
      });

      it('draws every line as a path of its own, not a routed polyline', async () => {
        const { scene, diagram } = await built(name);
        expect(scene.edges).toHaveLength(diagram.edges.length);
        for (const e of scene.edges) {
          expect(e.path).toBeTruthy();
          if (diagram.family === 'mindmap') {
            expect(e.path).toMatch(/ C/);
            expect(e.path).not.toMatch(/[LHV]/);
          }
        }
      });

      it('centres a parent on its children', async () => {
        const { scene, diagram } = await built(name);
        const at = new Map(scene.nodes.map((n) => [n.node.id, n.anchor]));
        const kids = new Map<string, string[]>();
        for (const e of diagram.edges) kids.set(e.from, [...(kids.get(e.from) ?? []), e.to]);
        for (const [parent, list] of kids) {
          const isRoot = !diagram.edges.some((e) => e.to === parent);
          if (diagram.family === 'wbs' && !isRoot) continue; // WBS lists hang from the parent, indented
          if (diagram.family === 'mindmap' && isRoot) continue; // two sides, checked below
          const ys = list.map((id) => at.get(id)!.cy);
          const xs = list.map((id) => at.get(id)!.cx);
          if (diagram.family === 'wbs') expect(Math.abs((Math.min(...xs) + Math.max(...xs)) / 2 - at.get(parent)!.cx)).toBeLessThanOrEqual(1);
          else expect(Math.abs((Math.min(...ys) + Math.max(...ys)) / 2 - at.get(parent)!.cy)).toBeLessThanOrEqual(1);
        }
      });
    });
  }

  it('mindmap: the root is in the middle and the sides are balanced', async () => {
    for (const name of ['mindmap.puml', 'mermaid/mindmap.mmd']) {
      const { scene, diagram } = await built(name);
      const root = scene.nodes[0]!;
      const first = diagram.edges.filter((e) => e.from === root.node.id).map((e) => scene.nodes.find((n) => n.node.id === e.to)!);
      const left = first.filter((n) => n.anchor.cx < root.anchor.cx);
      const right = first.filter((n) => n.anchor.cx > root.anchor.cx);
      expect(left.length + right.length).toBe(first.length);
      expect(Math.abs(left.length - right.length)).toBeLessThanOrEqual(1);
      // Each side's branches are centred on the root.
      for (const side of [left, right]) {
        const ys = side.map((n) => n.anchor.cy);
        expect(Math.abs((Math.min(...ys) + Math.max(...ys)) / 2 - root.anchor.cy)).toBeLessThanOrEqual(1);
      }
    }
  });

  it('mindmap: honours + / - markers and side directives', async () => {
    const d = parsePuml('@startmindmap\n* R\n++ a\n++ b\n-- c\nleft side\n** d\nright side\n** e\n@endmindmap\n').diagram;
    expect(d.nodes.filter((n) => n.side).map((n) => [n.label, n.side])).toEqual([['a', 'right'], ['b', 'right'], ['c', 'left'], ['d', 'left'], ['e', 'right']]);
    const { scene } = await built('x', d);
    const root = scene.nodes[0]!.anchor.cx;
    const side = (label: string) => (scene.nodes.find((n) => n.node.label === label)!.anchor.cx < root ? 'left' : 'right');
    expect(['a', 'b', 'c', 'd', 'e'].map(side)).toEqual(['right', 'right', 'left', 'left', 'right']);
  });

  it('wbs: root on top, first level in a row, deeper levels below their parent', async () => {
    const { scene, diagram } = await built('wbs.puml');
    const at = (id: string) => scene.nodes.find((n) => n.node.id === id)!.box;
    const root = at('Website relaunch');
    const row = ['Discovery', 'Design', 'Build', 'Launch'].map(at);
    for (const b of row) expect(b.y).toBeGreaterThan(root.y + root.h);
    expect(new Set(row.map((b) => b.y)).size).toBe(1);
    for (const e of diagram.edges) if (e.from !== 'Website relaunch') expect(at(e.to).y).toBeGreaterThan(at(e.from).y + at(e.from).h);
  });

  it('wbs: `left to right direction` puts the root at the left and each level in a column', async () => {
    const src = read('wbs.puml').replace('@startwbs', '@startwbs\nleft to right direction');
    const { scene, diagram } = await built('x', parsePuml(src).diagram);
    const at = (id: string) => scene.nodes.find((n) => n.node.id === id)!.box;
    const root = at('Website relaunch');
    for (const e of diagram.edges) {
      const a = at(e.from);
      const b = at(e.to);
      expect(b.x).toBeGreaterThanOrEqual(a.x + a.w);
    }
    expect(['Discovery', 'Design', 'Build', 'Launch'].every((id) => at(id).x > root.x + root.w)).toBe(true);
    const ys = ['Discovery', 'Design', 'Build', 'Launch'].map((id) => at(id).y);
    expect([...ys].sort((p, q) => p - q)).toEqual(ys);
    const boxes = scene.nodes.map((n) => n.box);
    for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) expect(overlaps(boxes[i]!, boxes[j]!, 0)).toBe(false);
    // Elbow lines leave the right side of the parent.
    expect(scene.edges.every((e) => e.points[0]![0] >= at(e.edge.from).x + at(e.edge.from).w - 0.5)).toBe(true);
  });

  it('mindmap: `top to bottom direction` hangs every branch below the root', async () => {
    const src = read('mindmap.puml').replace(/(@startmindmap[^\n]*)/, '$1\ntop to bottom direction');
    const { scene, diagram } = await built('x', parsePuml(src).diagram);
    const at = (id: string) => scene.nodes.find((n) => n.node.id === id)!.box;
    for (const e of diagram.edges) expect(at(e.to).y).toBeGreaterThanOrEqual(at(e.from).y + at(e.from).h);
    const kids = diagram.edges.filter((e) => e.from === 'Launch plan').map((e) => at(e.to));
    const mid = (kids[0]!.x + kids[kids.length - 1]!.x + kids[kids.length - 1]!.w) / 2;
    expect(Math.abs(mid - (at('Launch plan').x + at('Launch plan').w / 2))).toBeLessThanOrEqual(1);
    const boxes = scene.nodes.map((n) => n.box);
    for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) expect(overlaps(boxes[i]!, boxes[j]!, 0)).toBe(false);
    // Curves leave the bottom of the parent.
    expect(scene.edges.every((e) => Math.abs(e.points[0]![1] - (at(e.edge.from).y + at(e.edge.from).h)) < 0.5)).toBe(true);
  });

  it('dragging a topic carries its branch, in one edit', async () => {
    const { diagram, layout } = await built('mindmap.puml');
    const ids = subtreeIds(diagram, 'Marketing');
    expect(ids).toEqual(['Marketing', 'Blog post', 'Video demo', 'Meetup talk']);
    const moved = moveSelection(layout, diagram, ids, 10, 30);
    for (const id of ids) expect(moved.nodes[id]).toMatchObject({ x: layout.nodes[id]!.x + 10, y: layout.nodes[id]!.y + 30 });
    expect(moved.nodes['Product']).toMatchObject({ x: layout.nodes['Product']!.x, y: layout.nodes['Product']!.y });
    // The lines follow: still curves.
    expect(buildScene(diagram, moved, avoid).edges.every((e) => e.path)).toBe(true);
  });
});
