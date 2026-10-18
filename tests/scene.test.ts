import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { insertVia, moveNodes, removeVia } from '../src/editor/edits.ts';
import { ensureLayout } from '../src/layout/auto.ts';
import { emptyLayout, type LayoutFile } from '../src/layout/layout-file.ts';
import { parsePuml } from '../src/model/parse.ts';
import { loadAvoid, type Avoid } from '../src/scene/avoid.ts';
import { inside } from '../src/scene/geometry.ts';
import { buildScene } from '../src/scene/scene.ts';

const require = createRequire(import.meta.url);
const { diagram } = parsePuml(readFileSync(new URL('../fixtures/food-delivery.puml', import.meta.url), 'utf8'));
let avoid: Avoid;
let base: LayoutFile;

beforeAll(async () => {
  avoid = await loadAvoid(join(dirname(require.resolve('libavoid-js')), 'libavoid.wasm'));
  base = await ensureLayout(diagram, emptyLayout());
});

describe('buildScene', () => {
  it('routes every visible edge orthogonally', () => {
    const scene = buildScene(diagram, base, avoid);
    expect(scene.edges).toHaveLength(diagram.edges.length);
    for (const e of scene.edges) {
      expect(e.points.length).toBeGreaterThanOrEqual(2);
      for (let i = 1; i < e.points.length; i++) {
        const [a, b] = [e.points[i - 1]!, e.points[i]!];
        expect(Math.abs(a[0] - b[0]) < 0.5 || Math.abs(a[1] - b[1]) < 0.5, `${e.edge.id} segment ${i}`).toBe(true);
      }
    }
  });

  it('starts and ends lines on the outline, not inside the shapes', () => {
    const scene = buildScene(diagram, base, avoid);
    const nodes = new Map(scene.nodes.map((n) => [n.node.id, n]));
    for (const e of scene.edges) {
      const from = nodes.get(e.edge.from)!;
      const to = nodes.get(e.edge.to)!;
      expect(inside(from.anchor, e.points[0]!), e.edge.id).toBe(false);
      expect(inside(to.anchor, e.points[e.points.length - 1]!), e.edge.id).toBe(false);
    }
  });

  it('does not route lines through other elements', () => {
    const scene = buildScene(diagram, base, avoid);
    const hits: string[] = [];
    for (const e of scene.edges) {
      for (const n of scene.nodes) {
        if (n.node.id === e.edge.from || n.node.id === e.edge.to) continue;
        const b = n.box;
        for (let i = 1; i < e.points.length; i++) {
          const [a, c] = [e.points[i - 1]!, e.points[i]!];
          for (let t = 0; t <= 1; t += 0.05) {
            const x = a[0] + (c[0] - a[0]) * t;
            const y = a[1] + (c[1] - a[1]) * t;
            if (x > b.x + 1 && x < b.x + b.w - 1 && y > b.y + 1 && y < b.y + b.h - 1) {
              hits.push(`${e.edge.id} through ${n.node.id}`);
              break;
            }
          }
        }
      }
    }
    expect([...new Set(hits)]).toEqual([]);
  });

  it('routes through a manual bend', () => {
    const { layout, index } = insertVia(base, diagram, 'UC_Pay-->PSP', [0, -400]);
    expect(index).toBe(0);
    const edge = buildScene(diagram, layout, avoid).edges.find((e) => e.edge.id === 'UC_Pay-->PSP')!;
    expect(edge.points.some(([x, y]) => Math.abs(x) < 1 && Math.abs(y + 400) < 1) || edge.points.some(([, y]) => Math.abs(y + 400) < 1)).toBe(true);
    expect(removeVia(layout, 'UC_Pay-->PSP', 0).edges['UC_Pay-->PSP']).toBeUndefined();
  });

  it('moves bends with a group only when both ends move', () => {
    const withVia = insertVia(base, diagram, 'Member-->UC_Login', [10, 10]).layout;
    const origin = { Member: withVia.nodes.Member!, UC_Login: withVia.nodes.UC_Login! };
    const both = moveNodes(withVia, diagram, origin, { 'Member-->UC_Login': [[10, 10]] }, 5, 7);
    expect(both.edges['Member-->UC_Login']?.via).toEqual([[15, 17]]);
    const one = moveNodes(withVia, diagram, { Member: origin.Member }, { 'Member-->UC_Login': [[10, 10]] }, 5, 7);
    expect(one.edges['Member-->UC_Login']?.via).toEqual([[10, 10]]);
  });

  it('routes the fixture fast enough to re-route on every pointer move', () => {
    const started = performance.now();
    for (let i = 0; i < 10; i++) buildScene(diagram, base, avoid);
    const perFrame = (performance.now() - started) / 10;
    expect(perFrame).toBeLessThan(process.env.CI ? 150 : 50); // shared CI runners are 2-3x slower
  });
});

describe('drag fast path', () => {
  it('re-routes only lines touching moved nodes and reuses the rest', () => {
    const full = buildScene(diagram, base, avoid);
    const moved = moveNodes(base, diagram, { UC_Login: base.nodes.UC_Login! }, {}, 40, 0);
    const fast = buildScene(diagram, moved, avoid, { previous: full, dirty: { nodes: new Set(['UC_Login']), edges: new Set() } });
    const prior = new Map(full.edges.map((e) => [e.edge.id, e]));
    for (const e of fast.edges) {
      const touches = e.edge.from === 'UC_Login' || e.edge.to === 'UC_Login';
      expect(prior.get(e.edge.id) === e, e.edge.id).toBe(!touches);
    }
  });
});
