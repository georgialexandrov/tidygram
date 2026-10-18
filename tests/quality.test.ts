import { isTreeDiagram } from '../src/layout/tree.ts';
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { ensureLayout, type LayoutMode } from '../src/layout/auto.ts';
import { emptyLayout } from '../src/layout/layout-file.ts';
import { parseDiagram } from '../src/model/diagram.ts';
import type { Diagram } from '../src/model/types.ts';
import { loadAvoid, type Avoid } from '../src/scene/avoid.ts';
import { borderCrossings, measureQuality, pathHitsBox, type Quality } from '../src/scene/quality.ts';
import { applyTemplate } from '../src/layout/template/index.ts';
import { pointAt } from '../src/scene/geometry.ts';
import { buildScene } from '../src/scene/scene.ts';

const require = createRequire(import.meta.url);
let avoid: Avoid;
beforeAll(async () => {
  avoid = await loadAvoid(join(dirname(require.resolve('libavoid-js')), 'libavoid.wasm'));
});

const root = new URL('../fixtures/', import.meta.url).pathname;
const FIXTURES = ['', 'mermaid', 'drawio', 'architecture'].flatMap((dir) =>
  readdirSync(join(root, dir))
    .filter((f) => /\.(puml|mmd|drawio)$/.test(f))
    .map((f) => (dir ? `${dir}/${f}` : f)),
);

/** Every graph fixture, laid out from scratch: by ELK, and draw.io files also where the file draws them. */
async function measureAll(): Promise<{ name: string; q: Quality }[]> {
  const out: { name: string; q: Quality }[] = [];
  for (const file of FIXTURES) {
    const { diagram } = parseDiagram(readFileSync(join(root, file), 'utf8'), file);
    // Trees (mindmap, WBS) draw their own curves and elbows: nothing is routed, so there is nothing to measure.
    if (diagram.special || !diagram.nodes.length || isTreeDiagram(diagram)) continue;
    const modes: LayoutMode[] = file.endsWith('.drawio') ? ['reset', 'auto'] : ['auto'];
    for (const mode of modes) {
      const layout = await ensureLayout(diagram, emptyLayout(), mode);
      out.push({ name: `${file} (${mode})`, q: measureQuality(buildScene(diagram, layout, avoid), diagram) });
    }
  }
  return out;
}

describe('picture quality over every fixture', () => {
  let results: { name: string; q: Quality }[];
  beforeAll(async () => {
    results = await measureAll();
  }, 60_000);

  const list = (pick: (q: Quality) => string[]) => results.flatMap((r) => pick(r.q).map((d) => `${r.name}: ${d}`));

  it('lines cross a container border only to reach an element inside it', () => {
    expect(list((q) => q.details.filter((d) => d.startsWith('container:')))).toEqual([]);
  });

  it('lines run round boxes, not through them', () => {
    expect(list((q) => q.details.filter((d) => d.startsWith('node:')))).toEqual([]);
  });

  it('lines take few corners and no tiny steps, and meet boxes square-on', () => {
    const sum = (k: 'bends' | 'jogs' | 'skewEnds') => results.reduce((n, r) => n + r.q[k], 0);
    // Measured 2026-10-18: bends 466, jogs 17, skew ends 9 (actors with many lines); before this pass 571 / 54 / 10.
    // Then (spread ends, actor ports, wrapped rows): bends 479 (the state machine now wraps into rows: +18), jogs 18, skew ends 0.
    expect(sum('bends')).toBeLessThanOrEqual(500);
    expect(sum('jogs')).toBeLessThanOrEqual(20);
    expect(sum('skewEnds')).toBeLessThanOrEqual(1);
  });

  it('auto layout lands near the proportions of a window', () => {
    const off = results.filter((r) => r.name.endsWith('(auto)') && (r.q.aspect < 0.5 || r.q.aspect > 4.5)).map((r) => `${r.name}: ${r.q.aspect.toFixed(2)}`);
    // Left-to-right chains the source asks for stay strips (C4 LAYOUT_LEFT_RIGHT, the JSON tree, a 2-node page).
    expect(off.length).toBeLessThanOrEqual(4);
  });

  it('lines stay off container titles', () => {
    // Two draw.io lanes whose first element sits right under the title leave no room above it.
    expect(list((q) => q.details.filter((d) => d.startsWith('title:'))).length).toBeLessThanOrEqual(2);
  });
});

describe('label placement', () => {
  it('keeps labels off boxes, titles, other labels and (nearly always) other lines', async () => {
    const results = await measureAll();
    const pick = (prefix: string) => results.flatMap((r) => r.q.details.filter((d) => d.startsWith(prefix)).map((d) => `${r.name}: ${d}`));
    expect(pick('label:')).toEqual([]);
    // Ends with a multiplicity get a line of text's room from their neighbours (ports.ts `untangle`).
    expect(pick('label-line:').length).toBeLessThanOrEqual(1);
  }, 60_000);

  it('leaves a dragged label where the user put it, and reports the placed offset otherwise', async () => {
    const file = 'mermaid/er.mmd';
    const { diagram } = parseDiagram(readFileSync(join(root, file), 'utf8'), file);
    const layout = await ensureLayout(diagram, emptyLayout(), 'auto');
    const scene = buildScene(diagram, layout, avoid);
    const e = scene.edges.find((x) => x.label)!;
    // The offset is from the line's middle, so a drag starts from where the label is drawn.
    const [mx, my] = pointAt(e.points, 0.5);
    expect([e.label!.x - mx, e.label!.y - my]).toEqual(e.label!.offset);
    const moved = buildScene(diagram, { ...layout, edges: { ...layout.edges, [e.edge.id]: { label: [5, -40] } } }, avoid);
    const again = moved.edges.find((x) => x.edge.id === e.edge.id)!;
    expect(again.label!.offset).toEqual([5, -40]);
  });
});

describe('container walls', () => {
  // A and B side by side, C between them; P and Q outside, left and right of C.
  const diagram: Diagram = {
    nodes: [
      { id: 'a1', label: 'a1', kind: 'rectangle', parent: 'A' },
      { id: 'a2', label: 'a2', kind: 'rectangle', parent: 'A1' },
      { id: 'b1', label: 'b1', kind: 'rectangle', parent: 'B' },
      { id: 'c1', label: 'c1', kind: 'rectangle', parent: 'C' },
      { id: 'p', label: 'p', kind: 'rectangle' },
      { id: 'q', label: 'q', kind: 'rectangle' },
    ],
    containers: [
      { id: 'A', label: 'Alpha', kind: 'package' },
      { id: 'A1', label: 'Inner', kind: 'package', parent: 'A' },
      { id: 'B', label: 'Beta', kind: 'package' },
      { id: 'C', label: 'Gamma', kind: 'package' },
    ],
    edges: [
      { id: 'p-q', from: 'p', to: 'q', kind: 'association', head: 'arrow', tail: 'none', dashed: false },
      { id: 'a2-b1', from: 'a2', to: 'b1', kind: 'association', head: 'arrow', tail: 'none', dashed: false },
    ],
  } as unknown as Diagram;
  const layout = {
    ...emptyLayout(),
    nodes: { a1: { x: 100, y: 100 }, a2: { x: 100, y: 260 }, c1: { x: 400, y: 180 }, b1: { x: 700, y: 180 }, p: { x: 400, y: 0 }, q: { x: 400, y: 380 } },
  };

  it('keeps unrelated lines out and lets a line from inside A to inside B cross each border once', () => {
    const scene = buildScene(diagram, layout, avoid);
    const box = (id: string) => scene.containers.find((c) => c.id === id)!.box;
    const route = (id: string) => scene.edges.find((e) => e.edge.id === id)!.points;
    expect(borderCrossings(route('p-q'), box('C'))).toBe(0);
    expect(borderCrossings(route('a2-b1'), box('A1'))).toBe(1);
    expect(borderCrossings(route('a2-b1'), box('A'))).toBe(1);
    expect(borderCrossings(route('a2-b1'), box('B'))).toBe(1);
    expect(borderCrossings(route('a2-b1'), box('C'))).toBe(0);
    expect(measureQuality(scene, diagram).titleCrossings).toBe(0);
  });
});

describe('templates', () => {
  const load = async (file: string, kind: 'hexagonal' | 'layered') => {
    const { diagram } = parseDiagram(readFileSync(join(root, file), 'utf8'), file);
    const layout = applyTemplate(diagram, await ensureLayout(diagram, emptyLayout(), 'auto'), kind);
    return { diagram, layout, scene: buildScene(diagram, layout, avoid) };
  };

  it('hexagonal: a line between two outside elements goes round the core, not through it', async () => {
    const { scene } = await load('architecture/hexagonal-order-service.puml', 'hexagonal');
    const core = scene.nodes.filter((n) => ['application', 'domain'].includes(scene.template!.assigned.get(n.node.id) ?? ''));
    const x0 = Math.min(...core.map((n) => n.box.x));
    const x1 = Math.max(...core.map((n) => n.box.x + n.box.w));
    const y0 = Math.min(...core.map((n) => n.box.y));
    const y1 = Math.max(...core.map((n) => n.box.y + n.box.h));
    const outside = scene.edges.filter((e) => [e.edge.from, e.edge.to].every((id) => ['driving', 'driven'].includes(scene.template!.assigned.get(id) ?? '')));
    expect(outside.length).toBeGreaterThan(0);
    for (const e of outside) expect(pathHitsBox(e.points, { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }), e.edge.id).toBe(false);
  });

  it('hexagonal: lines meet a port beside its circle, not through its «port» or name', async () => {
    const { scene } = await load('architecture/hexagonal-order-service.puml', 'hexagonal');
    for (const n of scene.nodes.filter((x) => x.node.kind === 'interface')) {
      for (const e of scene.edges.filter((x) => x.edge.from === n.node.id || x.edge.to === n.node.id)) {
        const end = e.edge.to === n.node.id ? e.points[e.points.length - 1]! : e.points[0]!;
        expect(Math.abs(end[1] - n.anchor.cy), `${e.edge.id} at ${n.node.id}`).toBeLessThan(1);
      }
    }
  });

  it('layered: lines within a band read left to right', async () => {
    const { scene, diagram } = await load('architecture/c4-container.puml', 'layered');
    const at = new Map(scene.nodes.map((n) => [n.node.id, n]));
    const layer = scene.template!.assigned;
    const backwards = diagram.edges.filter((e) => {
      const [a, b] = [at.get(e.from), at.get(e.to)];
      return a && b && layer.get(e.from) === layer.get(e.to) && Math.abs(a.anchor.cy - b.anchor.cy) < 1 && a.anchor.cx > b.anchor.cx;
    });
    expect(backwards.map((e) => e.id)).toEqual([]);
  });
});
