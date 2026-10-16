import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { beforeAll, describe, expect, it } from 'vitest';
import { ensureLayout } from '../src/layout/auto.ts';
import { emptyLayout } from '../src/layout/layout-file.ts';
import { parsePuml } from '../src/model/parse.ts';
import { DiagramSvg } from '../src/render/DiagramSvg.tsx';
import { loadAvoid, type Avoid } from '../src/scene/avoid.ts';
import { buildScene } from '../src/scene/scene.ts';
import { buildAnyScene } from '../src/scene/any.ts';
import { THEMES } from '../src/scene/theme.ts';

const require = createRequire(import.meta.url);
const fixture = (name: string) => readFileSync(new URL(`../fixtures/${name}.puml`, import.meta.url), 'utf8');
let avoid: Avoid;
beforeAll(async () => {
  avoid = await loadAvoid(join(dirname(require.resolve('libavoid-js')), 'libavoid.wasm'));
});

describe('diagram families', () => {
  const expected: Record<string, { family: string; nodes: number; containers: number; edges: number }> = {
    'food-delivery': { family: 'description', nodes: 36, containers: 5, edges: 45 },
    class: { family: 'class', nodes: 13, containers: 3, edges: 12 },
    component: { family: 'description', nodes: 14, containers: 4, edges: 14 },
    deployment: { family: 'description', nodes: 7, containers: 3, edges: 8 },
    state: { family: 'state', nodes: 22, containers: 2, edges: 26 },
    er: { family: 'class', nodes: 5, containers: 0, edges: 5 },
    c4: { family: 'c4', nodes: 9, containers: 1, edges: 8 },
    mindmap: { family: 'mindmap', nodes: 16, containers: 0, edges: 15 },
    activity: { family: 'activity', nodes: 27, containers: 3, edges: 31 },
    json: { family: 'json', nodes: 8, containers: 0, edges: 7 },
    yaml: { family: 'json', nodes: 10, containers: 0, edges: 9 },
    chen: { family: 'chen', nodes: 20, containers: 0, edges: 19 },
    archimate: { family: 'archimate', nodes: 11, containers: 1, edges: 10 },
    nwdiag: { family: 'network', nodes: 8, containers: 1, edges: 8 },
  };
  for (const [name, want] of Object.entries(expected)) {
    it(`${name}: parses cleanly and renders in every theme`, async () => {
      const { diagram, warnings } = parsePuml(fixture(name));
      expect(warnings).toEqual([]);
      expect({ family: diagram.family, nodes: diagram.nodes.length, containers: diagram.containers.length, edges: diagram.edges.length }).toEqual(want);
      const layout = await ensureLayout(diagram, emptyLayout());
      for (const theme of Object.keys(THEMES)) {
        const scene = buildScene(diagram, { ...layout, view: { theme } }, avoid);
        expect(scene.edges.length).toBe(diagram.edges.filter((e) => !e.hidden).length);
        const svg = renderToStaticMarkup(createElement(DiagramSvg, { scene }));
        expect(svg).not.toContain('NaN');
      }
    }, 30_000);
  }

  it('reports types it does not draw instead of mis-reading them', () => {
    expect(parsePuml('@startsalt\n{ [OK] }\n@endsalt').warnings[0]?.message).toBe('Salt (wireframe) diagrams are not supported yet');
    expect(parsePuml('@startregex\n/a+/\n@endregex').warnings[0]?.message).toBe('Regex diagrams are not supported yet');
  });

  for (const name of ['sequence', 'gantt', 'timing']) {
    it(`${name}: parses cleanly and renders in every theme`, () => {
      const { diagram, warnings } = parsePuml(fixture(name));
      expect(warnings).toEqual([]);
      expect(diagram.special?.type).toBe(name);
      for (const theme of Object.keys(THEMES)) {
        const scene = buildAnyScene(diagram, { ...emptyLayout(), view: { theme } }, avoid);
        const svg = renderToStaticMarkup(createElement(DiagramSvg, { scene }));
        expect(svg).not.toContain('NaN');
        expect(scene.bounds.w).toBeGreaterThan(100);
      }
    });
  }
});

describe('class diagrams', () => {
  const { diagram } = parsePuml(fixture('class'));
  const edge = (id: string) => diagram.edges.find((e) => e.id === id);

  it('splits members into fields and methods', () => {
    expect(diagram.nodes.find((n) => n.id === 'Order')?.compartments).toEqual([
      ['-id : UUID', '-placedAt : Instant'],
      ['+total() : Money', '+cancel()'],
    ]);
    expect(diagram.nodes.find((n) => n.id === 'OrderStatus')).toMatchObject({ classKind: 'enum', compartments: [['PENDING', 'PAID', 'SHIPPED', 'DELIVERED', 'CANCELLED']] });
  });

  it('normalises relation direction and keeps multiplicities on the right ends', () => {
    expect(edge('OrderLine--*Order')).toMatchObject({ kind: 'composition', head: 'diamondFilled', fromLabel: '1..*', toLabel: '1', reversed: true });
    expect(edge('StripeGateway..|>PaymentGateway')).toMatchObject({ kind: 'realization' });
    expect(edge('Customer--Order')).toMatchObject({ kind: 'association', fromLabel: '1', toLabel: '*', label: 'places' });
  });

  it('reads extends/implements and one-line bodies', () => {
    const { diagram: d } = parsePuml('class A extends B implements C, D { +x; +y() }');
    expect(d.edges.map((e) => e.id)).toEqual(['A--|>B', 'A..|>C', 'A..|>D']);
    expect(d.nodes[0]!.compartments).toEqual([['+x'], ['+y()']]);
  });
});

describe('state diagrams', () => {
  const { diagram } = parsePuml(fixture('state'));
  it('scopes [*] per composite state and turns forward references into containers', () => {
    expect(diagram.nodes.filter((n) => n.kind === 'initial').map((n) => n.id).sort()).toEqual(['[*]', '[*]@Fulfilment', '[*]@Review']);
    expect(diagram.containers.map((c) => c.id)).toEqual(['Review', 'Fulfilment']);
    expect(diagram.nodes.some((n) => n.id === 'Review')).toBe(false);
    expect(diagram.edges.find((e) => e.id === 'Submitted-->Review')).toBeDefined();
  });

  it('reads pseudo-states and descriptions', () => {
    expect(diagram.nodes.find((n) => n.id === 'check')?.kind).toBe('choice');
    expect(diagram.nodes.find((n) => n.id === 'split')?.kind).toBe('fork');
    expect(diagram.nodes.find((n) => n.id === 'Paying')?.description).toEqual(['charge card', 'retry 3 times']);
  });

  it('routes lines that end on a composite state to its border', async () => {
    const layout = await ensureLayout(diagram, emptyLayout());
    const scene = buildScene(diagram, layout, avoid);
    const review = scene.containers.find((c) => c.id === 'Review')!.box;
    const end = scene.edges.find((e) => e.edge.id === 'Submitted-->Review')!.points.at(-1)!;
    const onBorder = Math.min(Math.abs(end[0] - review.x), Math.abs(end[0] - review.x - review.w), Math.abs(end[1] - review.y), Math.abs(end[1] - review.y - review.h));
    expect(onBorder).toBeLessThan(1);
  });
});

describe('ER, C4, component, mindmap', () => {
  it('ER crow feet', () => {
    const { diagram } = parsePuml(fixture('er'));
    expect(diagram.edges.find((e) => e.id === 'User||--o{Post')).toMatchObject({ tail: 'crowOne', head: 'crowZeroMany', label: 'writes' });
    expect(diagram.nodes.find((n) => n.id === 'User')).toMatchObject({ classKind: 'entity', compartments: [['* id : bigint <<PK>>'], ['* email : text', 'name : text']] });
  });

  it('C4 macros', () => {
    const { diagram } = parsePuml(fixture('c4'));
    expect(diagram.direction).toBe('LR');
    expect(diagram.nodes.find((n) => n.id === 'api')).toMatchObject({ kind: 'container', label: 'API', technology: 'NestJS', description: ['Orders, payments, accounts'], parent: 'shop' });
    expect(diagram.nodes.find((n) => n.id === 'stripe')).toMatchObject({ kind: 'system', external: true });
    expect(diagram.edges.find((e) => e.from === 'api' && e.to === 'db')?.label).toBe('Reads/writes\n[SQL]');
  });

  it('component shorthands and implicit components', () => {
    const { diagram } = parsePuml(fixture('component'));
    expect(diagram.nodes.find((n) => n.id === 'Hooks')).toMatchObject({ kind: 'interface', label: 'Webhooks' });
    expect(diagram.nodes.find((n) => n.id === 'Orders')).toMatchObject({ kind: 'component', parent: 'OrdersNode' });
    expect(diagram.nodes.find((n) => n.id === 'Events')?.kind).toBe('queue');
  });

  it('mindmap tree', () => {
    const { diagram } = parsePuml(fixture('mindmap'));
    expect(diagram.edges.filter((e) => e.from === 'Launch plan').map((e) => e.to)).toEqual(['Product', 'Marketing', 'Engineering', 'Support']);
  });
});

describe('sequence diagrams', () => {
  const model = () => {
    const s = parsePuml(fixture('sequence')).diagram.special;
    if (s?.type !== 'sequence') throw new Error('not a sequence');
    return s;
  };
  it('reads participants, boxes, autonumber, lost messages and return', () => {
    const m = model();
    expect(m.participants.map((p) => `${p.id}:${p.kind}`)).toEqual(['C:actor', 'Web:participant', 'GW:participant', 'Pay:participant', 'Ledger:database', 'Bus:queue', 'Stripe:participant']);
    expect(m.boxes).toEqual([{ label: 'Payments', participants: ['Pay', 'Ledger'], line: 7 }]);
    const messages = m.events.filter((e) => e.type === 'message');
    expect(messages).toHaveLength(17);
    expect(messages.find((e) => e.number === '12')).toMatchObject({ from: 'Pay', to: 'Bus', head: 'cross' });
    expect(messages.find((e) => e.number === '13')).toMatchObject({ from: 'Pay', to: 'GW', dashed: true, label: 'result' });
  });
  it('stores dragged columns and reorders by them', () => {
    const m = model();
    const layout = { ...emptyLayout(), nodes: { Stripe: { x: -200, y: 0, pinned: true as const } } };
    const scene = buildAnyScene({ family: 'description', direction: 'LR', nodes: [], containers: [], edges: [], special: m }, layout, avoid);
    if (scene.kind !== 'sequence') throw new Error();
    expect(scene.columns.Stripe!).toBeLessThan(scene.columns.C!);
  });
});

describe('activity diagrams', () => {
  const { diagram } = parsePuml(fixture('activity'));
  it('compiles control flow into decisions, merges, loops and fork bars', () => {
    const edge = (from: string, to: string) => diagram.edges.find((e) => e.from === from && e.to === to);
    expect(edge('if: address valid?', 'Calculate shipping')?.label).toBe('yes');
    expect(edge('repeat while: declined and attempts < 3?', 'repeat')?.label).toBe('retry');
    expect(edge('Pack item', 'while: items left to pack?')).toBeDefined();
    expect(diagram.nodes.filter((n) => n.kind === 'fork')).toHaveLength(2);
    expect(diagram.nodes.find((n) => n.id === 'Fix address')?.parent).toBe('lane: Customer');
  });
  it('lays swimlanes out as side-by-side columns', async () => {
    const layout = await ensureLayout(diagram, emptyLayout());
    const scene = buildScene(diagram, layout, avoid);
    const lanes = scene.containers.filter((c) => c.kind === 'swimlane').sort((a, b) => a.box.x - b.box.x);
    expect(lanes).toHaveLength(3);
    for (let i = 1; i < lanes.length; i++) expect(lanes[i]!.box.x).toBeGreaterThanOrEqual(lanes[i - 1]!.box.x + lanes[i - 1]!.box.w);
    expect(new Set(lanes.map((l) => Math.round(l.box.h))).size).toBe(1);
  });
});

describe('gantt and timing', () => {
  it('schedules around closed weekends', () => {
    const g = parsePuml(fixture('gantt')).diagram.special;
    if (g?.type !== 'gantt') throw new Error();
    const t = (id: string) => g.tasks.find((x) => x.id === id)!;
    expect([t('Interviews').start, t('Interviews').duration]).toEqual([0, 5]);
    expect(t('Requirements').start).toBe(7); // the Monday after
    expect(t('API').duration).toBe(14); // 10 working days
    expect(t('Load test').start).toBe(35); // skips a weekend
    expect(t('Launch')).toMatchObject({ milestone: true, start: 45 });
  });
  it('reads timing signals and changes', () => {
    const tm = parsePuml(fixture('timing')).diagram.special;
    if (tm?.type !== 'timing') throw new Error();
    expect(tm.signals.map((s) => s.kind)).toEqual(['robust', 'concise', 'clock', 'binary']);
    expect(tm.signals[0]!.states).toEqual(['Idle', 'Waiting', 'Processing']);
    expect(tm.signals[3]!.changes.map((c) => c.state)).toEqual(['low', 'high', 'low']);
  });
});

describe('JSON and YAML', () => {
  it('turns objects and arrays into tables linked by key, with path ids', () => {
    const { diagram } = parsePuml(fixture('json'));
    const node = (id: string) => diagram.nodes.find((n) => n.id === id);
    expect(node('$')?.compartments).toEqual([['order: {…}', 'meta: {…}']]);
    expect(node('$.order.lines[1]')).toMatchObject({ classKind: 'json', label: '', compartments: [['sku: MG-7', 'qty: 1', 'price: 24.5']], line: 11 });
    expect(node('$.order.tags')?.compartments).toEqual([['gift', 'express']]);
    expect(diagram.edges.find((e) => e.to === '$.order.customer')).toMatchObject({ from: '$.order', label: 'customer' });
  });

  it('reports malformed JSON on its line instead of throwing', () => {
    const { warnings } = parsePuml('@startjson\n{\n  "a": 1,\n  "b" 2\n}\n@endjson');
    expect(warnings).toEqual([{ line: 4, text: '', message: 'JSON not understood: expected :' }]);
  });

  it('reads the block YAML that config files use', () => {
    const { diagram } = parsePuml(fixture('yaml'));
    const rows = (id: string) => diagram.nodes.find((n) => n.id === id)?.compartments?.[0];
    expect(rows('$.env[0]')).toEqual(['name: DATABASE_URL', 'valueFrom: {…}']);
    expect(rows('$.env[0].valueFrom')).toEqual(['secret: orders-db']);
    expect(rows('$.ports')).toEqual(['8080', '9090']);
    expect(rows('$.probes.liveness')).toEqual(['path: /healthz', 'period: 10']);
    expect(rows('$')).toContain('notes: Scales on queue depth. ⏎ Owned by the payments team.');
    expect(rows('$.image')).toEqual(['name: registry.local/orders', 'tag: 1.8.2']);
  });
});

describe('Chen ER', () => {
  const { diagram } = parsePuml(fixture('chen'));
  const node = (id: string) => diagram.nodes.find((n) => n.id === id);
  it('reads entities, relationships and owner-scoped attributes with their flags', () => {
    expect(node('RENTED_TO')?.kind).toBe('relationship');
    expect(node('PARENT_OF')).toMatchObject({ kind: 'relationship', double: true });
    expect(node('CHILD')).toMatchObject({ kind: 'rectangle', double: true });
    expect(node('CUSTOMER.Number')).toMatchObject({ kind: 'attribute', key: true, label: 'Number : INTEGER' });
    expect(node('CUSTOMER.Bonus')?.double).toBe(true);
    expect(node('DIRECTOR.Age')?.derived).toBe(true);
    expect(node('DIRECTOR.Name.Fname')).toBeDefined();
    expect(diagram.edges.find((e) => e.id === 'DIRECTOR.Name--DIRECTOR.Name.Fname')).toBeDefined();
  });
  it('labels cardinalities and doubles total participation', () => {
    expect(diagram.edges.find((e) => e.id === 'RENTED_TO-(N,M)-DIRECTOR')?.label).toBe('(N,M)');
    expect(diagram.edges.find((e) => e.id === 'PARENT_OF=N=CHILD')).toMatchObject({ label: 'N', double: true });
    expect(diagram.edges.find((e) => e.id === 'CUSTOMER==CUSTOMER/d')?.double).toBe(true);
    expect(diagram.edges.filter((e) => e.from === 'CUSTOMER/d').map((e) => e.to)).toEqual(['TOURIST', 'MEMBER']);
  });
});

describe('ArchiMate', () => {
  const { diagram } = parsePuml(fixture('archimate'));
  it('reads element macros and the archimate keyword with their types', () => {
    expect(diagram.nodes.find((n) => n.id === 'cust')).toMatchObject({ kind: 'rectangle', label: 'Customer', stereotype: 'business actor' });
    expect(diagram.nodes.find((n) => n.id === 'shop')).toMatchObject({ label: 'Web shop', stereotype: 'application component' });
    expect(diagram.nodes.find((n) => n.id === 'pg')).toMatchObject({ parent: 'infra', stereotype: 'technology system software' });
    expect(diagram.nodes.find((n) => n.id === 'j')?.kind).toBe('circle');
  });
  it('draws each relationship type with its own ends', () => {
    expect(diagram.edges.find((e) => e.from === 'cust' && e.to === 'buyer')).toMatchObject({ tail: 'dot', head: 'arrow', dashed: false });
    expect(diagram.edges.find((e) => e.from === 'order' && e.to === 'ordering')).toMatchObject({ kind: 'realization', head: 'triangle', dashed: true });
    expect(diagram.edges.find((e) => e.to === 'pg' || e.from === 'pg')).toMatchObject({ kind: 'composition' });
    expect(diagram.edges.find((e) => e.from === 'checkout')?.label).toBe('used by');
  });
});

describe('nwdiag', () => {
  const { diagram } = parsePuml(fixture('nwdiag'));
  it('hangs hosts off network bars, shared hosts linking down into later networks', () => {
    expect(diagram.nodes.find((n) => n.id === 'net:dmz')).toMatchObject({ kind: 'network', description: ['210.x.x.x/24'] });
    expect(diagram.edges.find((e) => e.id === 'net:dmz--web01')?.toLabel).toBe('210.x.x.10');
    expect(diagram.edges.find((e) => e.id === 'web01--net:internal')?.fromLabel).toBe('172.16.0.10');
    expect(diagram.edges.find((e) => e.id === 'net:internal--db01')).toBeDefined();
  });
  it('reads shapes, descriptions, groups and peer links', () => {
    expect(diagram.nodes.find((n) => n.id === 'db01')?.kind).toBe('database');
    expect(diagram.nodes.find((n) => n.id === 'backup')?.label).toBe('Backup box');
    expect(diagram.nodes.find((n) => n.id === 'web02')?.parent).toBe('group:web');
    expect(diagram.containers[0]).toMatchObject({ id: 'group:web', label: 'Web tier' });
    expect(diagram.edges.find((e) => e.id === 'inet--router')).toBeDefined();
  });
});
