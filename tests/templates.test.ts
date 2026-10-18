import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeAll, describe, expect, it } from 'vitest';
import { convert } from '../src/convert/index.ts';
import { ensureLayout } from '../src/layout/auto.ts';
import { fitToFrame } from '../src/layout/fit.ts';
import { emptyLayout, parseLayout, serializeLayout, type LayoutFile, type TemplateKind } from '../src/layout/layout-file.ts';
import { pack } from '../src/layout/template/place.ts';
import { dependencyOf } from '../src/layout/template/rules.ts';
import { applyTemplate, dropIntoTemplate, findViolations, guessLayers, reassign, refreshTemplate, removeTemplate, unassigned } from '../src/layout/template/index.ts';
import { parseDiagram } from '../src/model/diagram.ts';
import { parseDrawio } from '../src/model/drawio.ts';
import type { DEdge, Diagram } from '../src/model/types.ts';
import { DiagramSvg } from '../src/render/DiagramSvg.tsx';
import { loadAvoid, type Avoid } from '../src/scene/avoid.ts';
import { overlaps, type Box } from '../src/scene/containers.ts';
import { buildScene, type Scene } from '../src/scene/scene.ts';
import { cornerDistance, hexEdgeX, insideHex, RING_ASPECT } from '../src/scene/template.ts';
import { THEMES } from '../src/scene/theme.ts';

const require = createRequire(import.meta.url);
let avoid: Avoid;
beforeAll(async () => {
  avoid = await loadAvoid(join(dirname(require.resolve('libavoid-js')), 'libavoid.wasm'));
});

const load = (name: string): Diagram => {
  const path = new URL(`../fixtures/architecture/${name}`, import.meta.url);
  const { diagram, warnings } = parseDiagram(readFileSync(path, 'utf8'), name);
  expect(warnings).toEqual([]);
  return diagram;
};
const HEX = () => load('hexagonal-order-service.puml');
const LAYERED = () => load('layered-web-shop.puml');
const C4 = () => load('c4-container.puml');
const CLEAN = () => load('clean-flowchart.mmd');
const TIERS = () => load('tiers.drawio');

const guessed = (d: Diagram, kind: TemplateKind) => Object.fromEntries([...guessLayers(d, { kind, assign: {} })].map(([id, g]) => [id, g.layer]));
const corners = (b: Box): [number, number][] => [
  [b.x, b.y],
  [b.x + b.w, b.y],
  [b.x, b.y + b.h],
  [b.x + b.w, b.y + b.h],
];
const inside = (inner: Box, outer: Box) => inner.x >= outer.x - 0.5 && inner.y >= outer.y - 0.5 && inner.x + inner.w <= outer.x + outer.w + 0.5 && inner.y + inner.h <= outer.y + outer.h + 0.5;
const noOverlaps = (scene: Scene) => {
  const boxes = scene.nodes.map((n) => n.box);
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) expect(overlaps(boxes[i]!, boxes[j]!), `${scene.nodes[i]!.node.id} / ${scene.nodes[j]!.node.id}`).toBe(false);
};
const sceneOf = (d: Diagram, layout: LayoutFile) => buildScene(d, layout, avoid);

describe('template schema', () => {
  it('round-trips a template through layout.json', () => {
    const text = serializeLayout({
      version: 1,
      view: { theme: 'modern' },
      template: {
        kind: 'layered',
        layers: [
          { id: 'web', label: 'Web' },
          { id: 'core', label: 'Core & rules' },
        ],
        rules: 'strict',
        assign: { Api: 'web' },
        guess: { Cart: 'core' },
        free: { nodes: { Api: { x: 10, y: 20, pinned: true } }, edges: { 'A-->B': { via: [[1, 2]] } } },
      },
      nodes: { Api: { x: 100, y: 50 } },
      edges: {},
    });
    const back = parseLayout(text);
    expect(back.template).toEqual({
      kind: 'layered',
      layers: [
        { id: 'web', label: 'Web' },
        { id: 'core', label: 'Core & rules' },
      ],
      rules: 'strict',
      assign: { Api: 'web' },
      guess: { Cart: 'core' },
      free: { nodes: { Api: { x: 10, y: 20, pinned: true } }, edges: { 'A-->B': { via: [[1, 2]] } } },
    });
    expect(serializeLayout(back)).toBe(text);
    // One assignment per line: small diffs when a drag reassigns one element.
    expect(text).toContain('\n      "Api": "web"');
  });

  it('keeps sidecars without a template exactly as they were', () => {
    const text = readFileSync(new URL('../fixtures/food-delivery.layout.json', import.meta.url), 'utf8');
    const layout = parseLayout(text);
    expect(layout.template).toBeUndefined();
    expect(serializeLayout(layout)).toBe(text);
  });

  it('drops what it cannot read instead of rejecting the file', () => {
    expect(parseLayout('{"version":1,"template":{"kind":"pyramid"},"nodes":{},"edges":{}}').template).toBeUndefined();
    const t = parseLayout('{"version":1,"template":{"kind":"clean","layers":[{"id":"a"},{"id":"a"}],"rules":"loud","assign":{"x":"a","y":3}},"nodes":{},"edges":{}}').template!;
    expect(t).toEqual({ kind: 'clean', assign: { x: 'a' }, guess: {} });
    // Plain strings are layer ids and labels.
    expect(parseLayout('{"version":1,"template":{"kind":"layered","layers":["ui","db"]},"nodes":{},"edges":{}}').template!.layers).toEqual([
      { id: 'ui', label: 'ui' },
      { id: 'db', label: 'db' },
    ]);
  });

  it('keeps a template per draw.io page', () => {
    const file = parseLayout('{"version":1,"nodes":{},"edges":{},"pages":{"p2":{"template":{"kind":"hexagonal","assign":{},"guess":{"a":"driving"}},"nodes":{},"edges":{}}}}');
    expect(file.pages!.p2!.template?.kind).toBe('hexagonal');
    expect(parseLayout(serializeLayout(file)).pages!.p2!.template?.guess).toEqual({ a: 'driving' });
  });
});

describe('guessing layers', () => {
  it('hexagonal: packages, stereotypes, names and graph position', () => {
    expect(guessed(HEX(), 'hexagonal')).toEqual({
      Customer: 'driving',
      BackOffice: 'driving',
      WebUi: 'driving',
      RestController: 'driving',
      AdminCli: 'driving',
      WebhookConsumer: 'driving',
      PlaceOrder: 'inbound',
      TrackOrder: 'inbound',
      ConfirmPayment: 'inbound',
      OrderService: 'application',
      OrderRepo: 'outbound',
      PaymentPort: 'outbound',
      EventPort: 'outbound',
      Order: 'domain',
      Pricing: 'domain',
      PgRepo: 'driven',
      StripeClient: 'driven',
      KafkaPub: 'driven',
      OrdersDb: 'driven',
      Topic: 'driven',
      // A cloud nothing names: driven, because only a driven adapter talks to it.
      Stripe: 'driven',
    });
  });

  it('layered: names and kinds without packages, the domain package by its name', () => {
    const g = guessed(LAYERED(), 'layered');
    expect(g).toMatchObject({ Shopper: 'presentation', Storefront: 'presentation', Api: 'presentation', Checkout: 'application', Cart: 'domain', Pricing: 'domain', ProductRepo: 'infrastructure', Pg: 'infrastructure', Jobs: 'infrastructure', Email: 'infrastructure' });
  });

  it('C4: people on top, the API and workers as the application, stores and external systems below', () => {
    const g = guessed(C4(), 'layered');
    expect(g).toMatchObject({ customer: 'presentation', spa: 'presentation', mobile: 'presentation', api: 'application', worker: 'application', db: 'infrastructure', bus: 'infrastructure', stripe: 'infrastructure', idp: 'infrastructure' });
    expect(guessed(C4(), 'hexagonal')).toMatchObject({ spa: 'driving', api: 'application', stripe: 'driven', mail: 'driven' });
  });

  it('clean: Mermaid subgraphs named like the rings, ports by name', () => {
    expect(guessed(CLEAN(), 'clean')).toEqual({
      Browser: 'frameworks',
      PG: 'frameworks',
      SMTP: 'frameworks',
      Ctl: 'adapters',
      Pres: 'adapters',
      Repo: 'adapters',
      Mail: 'adapters',
      Place: 'usecases',
      InPort: 'usecases',
      OutPort: 'usecases',
      Order: 'entities',
      Line: 'entities',
    });
    // The same subgraphs under the hexagon: "output port" says which side, the subgraph doesn't.
    expect(guessed(CLEAN(), 'hexagonal')).toMatchObject({ InPort: 'inbound', OutPort: 'outbound', Ctl: 'driving', Repo: 'driven', Order: 'domain' });
  });

  it('draw.io: loosely named swimlanes ("Web tier", "Services", "Data") and shapes', () => {
    expect(guessed(TIERS(), 'layered')).toEqual({ user: 'presentation', spa: 'presentation', bff: 'presentation', orders: 'application', billing: 'application', db: 'infrastructure', ledger: 'infrastructure', psp: 'infrastructure' });
  });

  it('ArchiMate: its own three layers from the element types', () => {
    const d = parseDiagram(readFileSync(new URL('../fixtures/archimate.puml', import.meta.url), 'utf8'), 'archimate.puml').diagram;
    expect(guessed(d, 'layered')).toMatchObject({ cust: 'business', order: 'business', shop: 'application', checkout: 'application', k8s: 'technology', pg: 'technology', j: 'application' });
  });

  it('a hand assignment is never re-guessed; an element nothing names is reported', () => {
    const d = LAYERED();
    d.nodes.push({ id: 'Mystery', kind: 'component', label: 'Zorblax', line: 99 });
    const layout = applyTemplate(d, emptyLayout(), 'layered');
    expect(unassigned(d, layout.template!)).toEqual(['Flags', 'Mystery']);
    const moved = reassign(d, layout, ['Mystery'], 'domain');
    expect(moved.template!.assign).toEqual({ Mystery: 'domain' });
    expect(unassigned(d, moved.template!)).toEqual(['Flags']);
    expect(refreshTemplate(d, moved).template!.assign).toEqual({ Mystery: 'domain' });
  });
});

describe('dependency rules', () => {
  const edge = (over: Partial<DEdge>): DEdge => ({ id: 'e', from: 'A', to: 'B', kind: 'dependency', dashed: false, head: 'arrow', tail: 'none', hidden: false, line: 1, ...over });
  it('reads which way a line depends', () => {
    expect(dependencyOf(edge({}))).toEqual(['A', 'B']);
    expect(dependencyOf(edge({ head: 'none', tail: 'arrow' }))).toEqual(['B', 'A']);
    expect(dependencyOf(edge({ head: 'triangle', kind: 'realization' }))).toEqual(['A', 'B']);
    expect(dependencyOf(edge({ head: 'none', tail: 'diamondFilled' }))).toEqual(['A', 'B']);
    expect(dependencyOf(edge({ head: 'none' }))).toBeUndefined();
    expect(dependencyOf(edge({ kind: 'noteLink' }))).toBeUndefined();
  });

  it('layered: the deliberate upward line, and nothing else; strict adds skipped layers', () => {
    const d = LAYERED();
    const t = applyTemplate(d, emptyLayout(), 'layered').template!;
    expect(findViolations(d, t).map((v) => [v.edge, v.message])).toEqual([['Pricing..>Api', 'Domain uses Presentation: points up']]);
    const strict = findViolations(d, { ...t, rules: 'strict' }).map((v) => v.edge);
    expect(strict).toContain('Checkout-->Email'); // application → infrastructure skips the domain
    expect(findViolations(d, { ...t, rules: 'off' })).toEqual([]);
  });

  it('layered: implementing a higher layer’s interface is inversion, not a violation (unless strict)', () => {
    const d = HEX();
    const t = applyTemplate(d, emptyLayout(), 'layered').template!;
    expect(findViolations(d, t).map((v) => v.edge)).toEqual(['Stripe..>WebhookConsumer']);
    expect(findViolations(d, { ...t, rules: 'strict' }).map((v) => v.edge)).toContain('PgRepo..|>OrderRepo');
  });

  it('hexagonal: clean fixture is clean; bypassing a port and using an adapter are flagged', () => {
    const d = HEX();
    const t = applyTemplate(d, emptyLayout(), 'hexagonal').template!;
    expect(findViolations(d, t)).toEqual([]);
    d.edges.push({ id: 'RestController-->OrderService', from: 'RestController', to: 'OrderService', kind: 'dependency', dashed: false, head: 'arrow', tail: 'none', hidden: false, line: 90 });
    d.edges.push({ id: 'Order-->PgRepo', from: 'Order', to: 'PgRepo', kind: 'dependency', dashed: false, head: 'arrow', tail: 'none', hidden: false, line: 91 });
    expect(findViolations(d, t).map((v) => v.message)).toEqual(['REST Controller reaches Order Service without a port', 'Order depends on the adapter Postgres Order Repository']);
  });

  it('hexagonal: each side uses its own ports; driving adapters may not call driven ones', () => {
    const d = HEX();
    const t = applyTemplate(d, emptyLayout(), 'hexagonal').template!;
    const dep = (from: string, to: string, line: number) => d.edges.push({ id: `${from}-->${to}`, from, to, kind: 'dependency', dashed: false, head: 'arrow', tail: 'none', hidden: false, line });
    dep('RestController', 'PaymentPort', 90);
    dep('PgRepo', 'PlaceOrder', 91);
    dep('AdminCli', 'PgRepo', 92);
    expect(findViolations(d, t).map((v) => v.message)).toEqual([
      'REST Controller uses the outbound port PaymentGateway: a driving adapter calls in through an inbound port',
      "Postgres Order Repository uses the inbound port PlaceOrderUseCase: a driven adapter is called by the core, it doesn't call in",
      'Admin CLI uses the driven adapter Postgres Order Repository directly, bypassing the core',
    ]);
  });

  it('clean: lines pointing outward, adapters may use their drivers unless strict', () => {
    const d = CLEAN();
    const t = applyTemplate(d, emptyLayout(), 'clean').template!;
    expect(findViolations(d, t).map((v) => v.edge).sort()).toEqual(['Place-->Mail', 'Place-->Pres']);
    expect(findViolations(d, { ...t, rules: 'strict' }).map((v) => v.edge)).toContain('Repo-->PG');
  });
});

describe('template geometry', () => {
  it('packs centres in order, as close to the wishes as the gaps allow', () => {
    expect(pack([0, 0, 0], [0, 10, 10])).toEqual([-10, 0, 10]);
    expect(pack([0, 100], [0, 10])).toEqual([0, 100]);
    expect(pack([50, 0], [0, 10])).toEqual([20, 30]);
  });

  for (const [name, d] of [
    ['layered web shop', LAYERED],
    ['hexagonal service', HEX],
    ['C4 containers', C4],
    ['draw.io tiers', TIERS],
  ] as const) {
    it(`layered (${name}): every element inside its band, bands stacked in order, no overlaps`, () => {
      const diagram = d();
      const layout = applyTemplate(diagram, { ...emptyLayout(), view: { theme: 'modern' } }, 'layered');
      const scene = sceneOf(diagram, layout);
      const t = scene.template!;
      expect(t.bands.map((b) => b.id)).toEqual(t.layers.map((l) => l.id));
      for (let i = 1; i < t.bands.length; i++) expect(t.bands[i]!.box.y).toBeGreaterThanOrEqual(t.bands[i - 1]!.box.y + t.bands[i - 1]!.box.h);
      for (const n of scene.nodes) expect(inside(n.box, t.bands.find((b) => b.id === t.assigned.get(n.node.id))!.box), n.node.id).toBe(true);
      noOverlaps(scene);
      expect(scene.containers).toEqual([]); // the bands replace the source's packages
    });
  }

  it('hexagonal: core inside the hexagon (domain in its own), ports on the outline, adapters outside on their side', () => {
    const diagram = HEX();
    const layout = applyTemplate(diagram, emptyLayout(), 'hexagonal');
    const scene = sceneOf(diagram, layout);
    const t = scene.template!;
    const [outer, inner] = t.hexagons;
    expect(outer!.id).toBe('application');
    expect(inner!.id).toBe('domain');
    for (const n of scene.nodes) {
      const layer = t.assigned.get(n.node.id)!;
      if (layer === 'application' || layer === 'domain') for (const c of corners(n.box)) expect(insideHex(outer!, c), n.node.id).toBe(true);
      if (layer === 'domain') for (const c of corners(n.box)) expect(insideHex(inner!, c), n.node.id).toBe(true);
      if (layer === 'inbound' || layer === 'outbound') {
        expect(Math.abs(n.anchor.cx - hexEdgeX(outer!, n.anchor.cy, layer === 'inbound' ? -1 : 1)), n.node.id).toBeLessThan(1);
      }
      if (layer === 'driving') expect(n.box.x + n.box.w, n.node.id).toBeLessThan(outer!.cx - outer!.r);
      if (layer === 'driven') expect(n.box.x, n.node.id).toBeGreaterThan(outer!.cx + outer!.r);
    }
    expect(t.bands.map((b) => b.id)).toEqual(['driving', 'driven']);
    noOverlaps(scene);
  });

  it('clean: every element inside its ring and outside the rings within, no overlaps', () => {
    for (const diagram of [CLEAN(), HEX()]) {
      const layout = applyTemplate(diagram, emptyLayout(), 'clean');
      const scene = sceneOf(diagram, layout);
      const t = scene.template!;
      const c = t.center!;
      for (const n of scene.nodes) {
        const ring = t.rings.find((r) => r.id === t.assigned.get(n.node.id))!;
        expect(cornerDistance(n.box, c), n.node.id).toBeLessThan(ring.r);
        // The nearest point of the box to the centre lies beyond the inner ring.
        const nx = Math.max(n.box.x, Math.min(c[0], n.box.x + n.box.w));
        const ny = Math.max(n.box.y, Math.min(c[1], n.box.y + n.box.h));
        expect(Math.hypot((nx - c[0]) / RING_ASPECT, ny - c[1]), n.node.id).toBeGreaterThanOrEqual(ring.inner - 0.5);
      }
      noOverlaps(scene);
    }
  });

  it('renders every template in every theme, violations marked', () => {
    for (const [diagram, kind] of [
      [LAYERED(), 'layered'],
      [HEX(), 'hexagonal'],
      [CLEAN(), 'clean'],
    ] as const) {
      const layout = applyTemplate(diagram, emptyLayout(), kind);
      for (const theme of Object.keys(THEMES)) {
        const scene = sceneOf(diagram, { ...layout, view: { theme } });
        const svg = renderToStaticMarkup(createElement(DiagramSvg, { scene }));
        expect(svg).not.toContain('NaN');
        expect(svg).toContain(`data-template="${kind}"`);
        expect((svg.match(/data-violation=/g) ?? []).length).toBe(scene.template!.violations.length);
      }
    }
  });
});

describe('template operations', () => {
  it('turning a template off brings the free layout back; switching keeps the original one', async () => {
    const d = LAYERED();
    const free = await ensureLayout(d, emptyLayout());
    const layered = applyTemplate(d, free, 'layered');
    expect(layered.template!.free).toEqual({ nodes: free.nodes, edges: free.edges });
    const hex = applyTemplate(d, layered, 'hexagonal');
    expect(hex.template!.kind).toBe('hexagonal');
    expect(hex.template!.free!.nodes).toEqual(free.nodes);
    const off = removeTemplate(hex);
    expect(off.template).toBeUndefined();
    expect(off.nodes).toEqual(free.nodes);
  });

  it('draw.io: turning the template off goes back to the file’s own layout', async () => {
    const d = TIERS();
    const fromFile = await ensureLayout(d, emptyLayout());
    const off = await ensureLayout(d, removeTemplate(applyTemplate(d, fromFile, 'layered')));
    expect(off.nodes).toEqual(fromFile.nodes);
  });

  it('dropping an element into another band reassigns it there, pinned, and re-places around it', () => {
    const d = LAYERED();
    const layout = applyTemplate(d, emptyLayout(), 'layered');
    const before = sceneOf(d, layout).template!;
    const target = before.bands.find((b) => b.id === 'application')!.box;
    const dragged = { ...layout, nodes: { ...layout.nodes, Cart: { x: layout.nodes.Cart!.x, y: target.y + target.h / 2, pinned: true } } };
    const next = dropIntoTemplate(d, dragged, before, ['Cart'], 'Cart')!;
    expect(next.template!.assign).toEqual({ Cart: 'application' });
    expect(next.template!.guess.Cart).toBeUndefined();
    expect(next.nodes.Cart!.pinned).toBe(true);
    const scene = sceneOf(d, next);
    expect(inside(scene.nodes.find((n) => n.node.id === 'Cart')!.box, scene.template!.bands.find((b) => b.id === 'application')!.box)).toBe(true);
    noOverlaps(scene);
    // Within its own band it is just a move.
    const nudged = { ...layout, nodes: { ...layout.nodes, Cart: { x: layout.nodes.Cart!.x + 30, y: layout.nodes.Cart!.y } } };
    expect(dropIntoTemplate(d, nudged, before, ['Cart'], 'Cart')).toBeUndefined();
  });

  it('dropping a port on the other side of the hexagon makes it outbound', () => {
    const d = HEX();
    const layout = applyTemplate(d, emptyLayout(), 'hexagonal');
    const before = sceneOf(d, layout).template!;
    const outer = before.hexagons[0]!;
    const n = sceneOf(d, layout).nodes.find((x) => x.node.id === 'TrackOrder')!;
    const y = outer.cy;
    const dx = n.anchor.cx - layout.nodes.TrackOrder!.x;
    const dy = n.anchor.cy - layout.nodes.TrackOrder!.y;
    const dragged = { ...layout, nodes: { ...layout.nodes, TrackOrder: { x: hexEdgeX(outer, y, 1) - dx, y: y - dy } } };
    expect(dropIntoTemplate(d, dragged, before, ['TrackOrder'], 'TrackOrder')!.template!.assign).toEqual({ TrackOrder: 'outbound' });
  });

  it('opening again changes nothing; an element added upstream lands in its layer', async () => {
    const d = LAYERED();
    const layout = applyTemplate(d, emptyLayout(), 'layered');
    expect(await ensureLayout(d, layout)).toBe(layout);
    d.nodes.push({ id: 'Search', kind: 'component', label: 'Search Service', line: 40 });
    d.edges.push({ id: 'Api-->Search', from: 'Api', to: 'Search', kind: 'association', dashed: false, head: 'arrow', tail: 'none', hidden: false, line: 41 });
    const next = await ensureLayout(d, layout);
    expect(next.template!.guess.Search).toBe('application');
    const scene = sceneOf(d, next);
    expect(inside(scene.nodes.find((n) => n.node.id === 'Search')!.box, scene.template!.bands.find((b) => b.id === 'application')!.box)).toBe(true);
    noOverlaps(scene);
    // Auto re-places under the template; Reset drops it.
    expect((await ensureLayout(d, next, 'auto')).template?.kind).toBe('layered');
    expect((await ensureLayout(d, next, 'reset')).template).toBeUndefined();
  });

  it('fit to frame keeps the template and only chooses size, gaps and row length', async () => {
    const d = LAYERED();
    const layout = applyTemplate(d, { ...emptyLayout(), view: { theme: 'modern' } }, 'layered');
    const fit = await fitToFrame(d, layout, [16, 9], avoid);
    expect(fit.layout.template!.kind).toBe('layered');
    expect(fit.layout.view!.frame).toEqual([16, 9]);
    expect(fit.achieved).toBeGreaterThan(1.2);
    const scene = sceneOf(d, fit.layout);
    for (const n of scene.nodes) expect(inside(n.box, scene.template!.bands.find((b) => b.id === scene.template!.assigned.get(n.node.id))!.box)).toBe(true);
    noOverlaps(scene);
  });

  it('conversion: PlantUML and Mermaid sidecars carry the template, draw.io draws it as a locked background layer', () => {
    const d = HEX();
    const layout = applyTemplate(d, emptyLayout(), 'hexagonal');
    const scene = sceneOf(d, layout);
    const puml = convert(d, layout, 'puml', scene);
    expect(puml.layout.template!.kind).toBe('hexagonal');
    expect(Object.keys(puml.layout.template!.guess).length).toBe(d.nodes.length);
    const drawio = convert(d, layout, 'drawio', scene);
    expect(drawio.source).toContain('pumlTemplate=1');
    expect(drawio.source).toMatch(/shape=hexagon;[^"]*pumlTemplate=1/);
    expect(drawio.warnings.map((w) => w.message).join('\n')).toContain('template written as background shapes');
    // Read back: the backdrop is not part of the diagram.
    const back = parseDrawio(drawio.source).diagram;
    expect(back.nodes.length).toBe(d.nodes.length);
    expect(back.containers.length).toBe(0);
  });
});
