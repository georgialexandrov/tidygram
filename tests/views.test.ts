import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { ensureLayout } from '../src/layout/auto.ts';
import { emptyLayout, pageLayout, parseLayout, serializeLayout, sliceLayout, viewLayout, withPageLayout, withSliceLayout, withViewLayout } from '../src/layout/layout-file.ts';
import { applyTemplate, findViolations, guessLayers } from '../src/layout/template/index.ts';
import { layersOf, resolveAssignments } from '../src/layout/template/defs.ts';
import { c4View, c4Views } from '../src/model/c4-views.ts';
import { parseDiagram } from '../src/model/diagram.ts';
import type { Diagram } from '../src/model/types.ts';
import { loadAvoid, type Avoid } from '../src/scene/avoid.ts';
import { measureQuality } from '../src/scene/quality.ts';
import { buildScene } from '../src/scene/scene.ts';

const source = readFileSync(new URL('../fixtures/c4/zoom.puml', import.meta.url), 'utf8');
const written = parseDiagram(source, 'zoom.puml');
const at = (view: string) => parseDiagram(source, 'zoom.puml', { view });
const ids = (d: Diagram) => d.nodes.map((n) => n.id).sort();
const lines = (d: Diagram) => Object.fromEntries(d.edges.map((e) => [e.id, e.label]));

describe('C4 views', () => {
  it('offers context, one container view per system and one component view per container boundary', () => {
    expect(written.views?.map((v) => v.key)).toEqual(['context', 'container:shop', 'container:warehouse', 'component:api']);
    expect(written.view).toBeUndefined();
    expect(written.diagram.containers.map((c) => [c.id, c.c4Boundary])).toEqual([
      ['shop', 'system'],
      ['api', 'container'],
      ['warehouse', 'system'],
    ]);
  });

  it('offers nothing for C4 without boundaries or for other families', () => {
    expect(c4Views(parseDiagram('@startuml\nPerson(a, "A")\nSystem(b, "B")\nRel(a, b, "Uses")\n@enduml').diagram)).toEqual([]);
    expect(parseDiagram(readFileSync(new URL('../fixtures/component.puml', import.meta.url), 'utf8'), 'component.puml').views).toBeUndefined();
  });

  it('context: systems collapsed, relations lifted to them and merged per pair', () => {
    const { diagram, view, warnings } = at('context');
    expect(view).toBe('context');
    expect(warnings).toEqual([]);
    expect(ids(diagram)).toEqual(['customer', 'mail', 'picker', 'shop', 'stripe', 'warehouse']);
    expect(diagram.containers).toEqual([]);
    expect(diagram.nodes.find((n) => n.id === 'shop')).toMatchObject({ kind: 'system', label: 'Online Shop' });
    expect(lines(diagram)).toEqual({
      'customer..>shop': 'Uses\n[HTTPS]',
      'shop..>stripe': 'Charges\n[HTTPS]',
      'shop..>warehouse': 'Creates picks\n[REST]',
      // worker → mail and payments → mail: one line, both names, the shared technology.
      'shop..>mail': 'Sends, Sends receipts\n[SMTP]',
      'picker..>warehouse': 'Picks with',
      'warehouse..>shop': 'Reports shipped',
    });
  });

  it('container: one system open, its container boundaries as boxes, unrelated elements dropped', () => {
    const { diagram } = at('container:shop');
    // picker relates only to the warehouse: not in the shop's container view.
    expect(ids(diagram)).toEqual(['api', 'bus', 'customer', 'db', 'mail', 'stripe', 'warehouse', 'web', 'worker']);
    expect(diagram.containers.map((c) => c.id)).toEqual(['shop']);
    expect(diagram.nodes.find((n) => n.id === 'api')).toMatchObject({ kind: 'container', parent: 'shop' });
    const l = lines(diagram);
    // web → api (to the boundary) and web → orders (inside it) are one line now.
    expect(l['web..>api']).toBe('Calls, Places orders\n[JSON/HTTPS]');
    expect(l['api..>db']).toBe('Reads/writes\n[SQL]');
    expect(l['worker..>warehouse']).toBe('Creates picks\n[REST]');
    // Lines inside the API box vanish.
    expect(Object.keys(l).some((id) => /orders|payments|repo/.test(id))).toBe(false);
    expect(diagram.edges).toHaveLength(10);
  });

  it('component: the container open inside its system, neighbours kept, lines to the boundary kept', () => {
    const { diagram } = at('component:api');
    expect(ids(diagram)).toEqual(['bus', 'db', 'mail', 'orders', 'payments', 'repo', 'stripe', 'web']);
    expect(diagram.containers.map((c) => [c.id, c.parent])).toEqual([
      ['shop', undefined],
      ['api', 'shop'],
    ]);
    expect(Object.keys(lines(diagram)).sort()).toEqual(
      ['orders..>bus', 'orders..>payments', 'orders..>repo', 'payments..>mail', 'payments..>stripe', 'repo..>db', 'web..>api', 'web..>orders'].sort(),
    );
  });

  it('merges more than two names into "and n more", drops a technology they do not share, keeps Lay hints only between their own ends', () => {
    const d = c4View(
      parseDiagram(
        [
          '@startuml',
          'Person(u, "U")',
          'System_Boundary(s, "S") {',
          '  Container(a, "A", "x")',
          '  Container(b, "B", "x")',
          '  Container(c, "C", "x")',
          '}',
          'System(t, "T")',
          'Rel(a, t, "One", "HTTP")',
          'Rel(b, t, "Two", "gRPC")',
          'Rel(c, t, "Three")',
          'Rel(u, a, "Uses")',
          'Lay_R(u, t)',
          'Lay_R(a, b)',
          '@enduml',
        ].join('\n'),
      ).diagram,
      'context',
    );
    expect(d.edges.map((e) => [e.id, e.label, e.hidden])).toEqual([
      ['s..>t', 'One, Two and 1 more', false],
      ['u..>s', 'Uses', false],
      ['u..t', undefined, true],
    ]);
  });

  it('an unknown view is a warning and the diagram stays as written', () => {
    const r = at('component:nope');
    expect(r.view).toBeUndefined();
    expect(r.warnings[0]?.message).toMatch(/no such view/);
    expect(ids(r.diagram)).toEqual(ids(written.diagram));
    expect(() => c4View(written.diagram, 'component:shop')).toThrow(/Container_Boundary/);
  });
});

describe('views in the sidecar', () => {
  it('keeps each view under "views", the written diagram at the top level', () => {
    const file = withViewLayout(withViewLayout({ ...emptyLayout(), view: { theme: 'mono' }, nodes: { web: { x: 1, y: 2 } } }, 'context', { version: 1, view: { theme: 'mono' }, nodes: { shop: { x: 5, y: 6 } }, edges: {} }), 'component:api', {
      version: 1,
      view: { theme: 'paper' },
      nodes: { orders: { x: 7, y: 8, pinned: true } },
      edges: { 'web..>orders': { via: [[1, 1]] } },
    });
    const text = serializeLayout(file);
    expect(text).toBe(
      '{\n  "version": 1,\n  "view": { "theme": "mono" },\n  "nodes": {\n    "web": { "x": 1, "y": 2 }\n  },\n  "edges": {},\n  "views": {\n' +
        '    "component:api": {\n      "view": { "theme": "paper" },\n      "nodes": {\n        "orders": { "x": 7, "y": 8, "pinned": true }\n      },\n      "edges": {\n        "web..>orders": { "via": [[1, 1]] }\n      }\n    },\n' +
        '    "context": {\n      "nodes": {\n        "shop": { "x": 5, "y": 6 }\n      },\n      "edges": {}\n    }\n  }\n}\n',
    );
    const back = parseLayout(text);
    expect(back).toEqual(file);
    // A view without its own settings takes the top level's; the top level never sees the views.
    expect(viewLayout(back, 'context')).toEqual({ version: 1, view: { theme: 'mono' }, nodes: { shop: { x: 5, y: 6 } }, edges: {} });
    expect(viewLayout(back, 'component:api').view).toEqual({ theme: 'paper' });
    expect(viewLayout(back, 'container:shop')).toEqual({ version: 1, view: { theme: 'mono' }, nodes: {}, edges: {} });
    expect(pageLayout(back).views).toBeUndefined();
    expect(sliceLayout(back, undefined, 'context')).toEqual(viewLayout(back, 'context'));
  });

  it('writing the top level or a page keeps the views; an emptied view drops out', () => {
    const file = withViewLayout(emptyLayout(), 'context', { version: 1, nodes: { a: { x: 1, y: 1 } }, edges: {} });
    const top = withPageLayout(file, undefined, { version: 1, nodes: { b: { x: 2, y: 2 } }, edges: {} });
    expect(top.views).toEqual(file.views);
    expect(withSliceLayout(top, undefined, undefined, { version: 1, nodes: {}, edges: {} }).views).toEqual(file.views);
    expect(withViewLayout(top, 'context', emptyLayout()).views).toBeUndefined();
  });
});

let avoid: Avoid;
beforeAll(async () => {
  const require = createRequire(import.meta.url);
  avoid = await loadAvoid(join(dirname(require.resolve('libavoid-js')), 'libavoid.wasm'));
});

describe('views lay out and route cleanly', () => {
  it.each(['context', 'container:shop', 'container:warehouse', 'component:api'])('%s: no line through a box or across a border it need not cross', async (key) => {
    const { diagram } = at(key);
    const layout = await ensureLayout(diagram, emptyLayout(), 'auto');
    expect(Object.keys(layout.nodes).sort()).toEqual(ids(diagram));
    const q = measureQuality(buildScene(diagram, layout, avoid), diagram);
    expect(q.details.filter((d) => d.startsWith('node:') || d.startsWith('container:'))).toEqual([]);
  });
});

describe('C4 tiers template', () => {
  const tiers = (d: Diagram) => Object.fromEntries([...guessLayers(d, { kind: 'tiers', assign: {} })].map(([id, g]) => [id, g.layer]));

  it('people on top, the system in scope in the middle (named after it), externals below', () => {
    const d = parseDiagram(readFileSync(new URL('../fixtures/architecture/c4-container.puml', import.meta.url), 'utf8'), 'c4-container.puml').diagram;
    expect(layersOf({ kind: 'tiers' }, d).map((l) => l.label)).toEqual(['People', 'Online Shop', 'External systems']);
    const g = tiers(d);
    expect(g.customer).toBe('people');
    expect(g.staff).toBe('people');
    expect(['spa', 'api', 'db', 'bus'].map((id) => g[id])).toEqual(['system', 'system', 'system', 'system']);
    expect(['stripe', 'mail', 'idp'].map((id) => g[id])).toEqual(['external', 'external', 'external']);
  });

  it('in a container view, another system of the company sits with the externals', () => {
    const g = tiers(at('container:shop').diagram);
    expect(g.warehouse).toBe('external');
    expect(g.api).toBe('system');
    // Context: no boundary is left, so every internal system is in scope.
    const c = tiers(at('context').diagram);
    expect([c.shop, c.warehouse, c.stripe, c.customer]).toEqual(['system', 'system', 'external', 'people']);
    expect(layersOf({ kind: 'tiers' }, at('context').diagram)[1]!.label).toBe('Software system');
  });

  it('flags nothing by default (systems notify people), points-up when asked', () => {
    const d = at('context').diagram;
    const layout = applyTemplate(d, emptyLayout(), 'tiers');
    expect(layout.template?.kind).toBe('tiers');
    expect(findViolations(d, layout.template!, resolveAssignments(d, layout.template!))).toEqual([]);
    const relaxed = { ...layout.template!, rules: 'relaxed' as const };
    expect(findViolations(d, relaxed, resolveAssignments(d, relaxed)).map((v) => v.edge)).toEqual([]);
    const back = { ...relaxed, assign: { stripe: 'people' } };
    expect(findViolations(d, back, resolveAssignments(d, back)).map((v) => v.edge)).toEqual(['shop..>stripe']);
  });

  it('lays out in bands, each element inside its own band', async () => {
    const { diagram } = at('container:shop');
    const layout = applyTemplate(diagram, await ensureLayout(diagram, emptyLayout(), 'auto'), 'tiers');
    const scene = buildScene(diagram, layout, avoid);
    const bands = scene.template!.bands;
    expect(bands.map((b) => b.id)).toEqual(['people', 'system', 'external']);
    for (const n of scene.nodes) {
      const band = bands.find((b) => b.id === scene.template!.assigned.get(n.node.id))!.box;
      expect(n.box.y >= band.y && n.box.y + n.box.h <= band.y + band.h, n.node.id).toBe(true);
    }
  });
});
