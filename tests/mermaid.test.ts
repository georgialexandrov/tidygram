import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { beforeAll, describe, expect, it } from 'vitest';
import { ensureLayout } from '../src/layout/auto.ts';
import { emptyLayout } from '../src/layout/layout-file.ts';
import { parseDiagram } from '../src/model/diagram.ts';
import { parseMermaid } from '../src/model/mermaid.ts';
import { DiagramSvg } from '../src/render/DiagramSvg.tsx';
import { loadAvoid, type Avoid } from '../src/scene/avoid.ts';
import { buildScene } from '../src/scene/scene.ts';
import { buildAnyScene } from '../src/scene/any.ts';
import { THEMES } from '../src/scene/theme.ts';
import { layoutPathFor } from '../src/paths.ts';

const require = createRequire(import.meta.url);
const fixture = (name: string) => readFileSync(new URL(`../fixtures/mermaid/${name}.mmd`, import.meta.url), 'utf8');
const parse = (name: string) => parseDiagram(fixture(name), `${name}.mmd`);
let avoid: Avoid;
beforeAll(async () => {
  avoid = await loadAvoid(join(dirname(require.resolve('libavoid-js')), 'libavoid.wasm'));
});

describe('Mermaid fixtures', () => {
  const expected: Record<string, { family: string; nodes: number; containers: number; edges: number }> = {
    flowchart: { family: 'activity', nodes: 18, containers: 2, edges: 22 },
    class: { family: 'class', nodes: 12, containers: 1, edges: 13 },
    state: { family: 'state', nodes: 27, containers: 3, edges: 31 },
    er: { family: 'class', nodes: 8, containers: 0, edges: 8 },
    mindmap: { family: 'mindmap', nodes: 17, containers: 0, edges: 16 },
  };
  for (const [name, want] of Object.entries(expected)) {
    it(`${name}: parses cleanly and renders in every theme`, async () => {
      const { diagram, warnings } = parse(name);
      expect(warnings).toEqual([]);
      expect({ family: diagram.family, nodes: diagram.nodes.length, containers: diagram.containers.length, edges: diagram.edges.length }).toEqual(want);
      const layout = await ensureLayout(diagram, emptyLayout());
      for (const theme of Object.keys(THEMES)) {
        const scene = buildScene(diagram, { ...layout, view: { theme } }, avoid);
        expect(scene.edges.length).toBe(diagram.edges.filter((e) => !e.hidden).length);
        expect(renderToStaticMarkup(createElement(DiagramSvg, { scene }))).not.toContain('NaN');
      }
    }, 30_000);
  }

  for (const name of ['sequence', 'gantt']) {
    it(`${name}: parses cleanly and renders in every theme`, () => {
      const { diagram, warnings } = parse(name);
      expect(warnings).toEqual([]);
      expect(diagram.special?.type).toBe(name);
      for (const theme of Object.keys(THEMES)) {
        const scene = buildAnyScene(diagram, { ...emptyLayout(), view: { theme } }, avoid);
        expect(renderToStaticMarkup(createElement(DiagramSvg, { scene }))).not.toContain('NaN');
        expect(scene.bounds.w).toBeGreaterThan(100);
      }
    });
  }
});

describe('dispatch', () => {
  it('reads by content and extension, PlantUML by default', () => {
    expect(parseDiagram('flowchart LR\n  A --> B').diagram.family).toBe('activity');
    expect(parseDiagram('@startuml\nA --> B\n@enduml', 'x.mmd').diagram.edges).toHaveLength(1);
    expect(parseDiagram('actor A\nA --> (Do)', 'x.puml').diagram.nodes.find((n) => n.id === 'A')?.kind).toBe('actor');
    expect(parseDiagram('actor A\nA --> (Do)').diagram.nodes.find((n) => n.id === 'A')?.kind).toBe('actor');
  });
  it('keeps the sidecar next to the source', () => {
    expect(layoutPathFor('a/x.mmd')).toBe('a/x.layout.json');
    expect(layoutPathFor('a/x.mermaid')).toBe('a/x.layout.json');
  });
  it('reports types it does not draw', () => {
    expect(parseMermaid('pie title Pets\n  "Dogs" : 386').warnings[0]?.message).toBe('Pie diagrams are not supported yet');
    expect(parseMermaid('%% c\ngitGraph\n  commit').warnings[0]?.message).toBe('Git graph diagrams are not supported yet');
    expect(parseMermaid('C4Context\n  Person(a, "A")').warnings[0]?.message).toBe('C4 diagrams are not supported yet');
    const odd = parseMermaid('flowchart TD\n  A --> B\n  this is not ( valid');
    expect(odd.warnings).toEqual([{ line: 3, text: '  this is not ( valid', message: 'Unsupported line, ignored' }]);
    expect(odd.diagram.edges).toHaveLength(1);
  });
});

describe('Mermaid flowchart', () => {
  const { diagram } = parse('flowchart');
  const node = (id: string) => diagram.nodes.find((n) => n.id === id);
  const edge = (id: string) => diagram.edges.find((e) => e.id === id);

  it('maps shapes onto element kinds', () => {
    expect(diagram.direction).toBe('LR');
    expect(node('start')).toMatchObject({ kind: 'storage', label: 'Customer opens cart' });
    expect(node('signedIn')).toMatchObject({ kind: 'relationship', label: 'Signed in?' });
    expect(node('login')?.kind).toBe('action');
    expect(node('method')?.kind).toBe('hexagon');
    expect(node('psp')).toMatchObject({ kind: 'rectangle', double: true });
    expect(node('ledger')?.kind).toBe('database');
    expect(node('retry')?.kind).toBe('attribute');
    expect(node('confirm')?.kind).toBe('process');
    expect(node('invoice')).toMatchObject({ kind: 'rectangle', label: 'Invoice PDF' });
  });

  it('nests subgraph members, including nodes first seen outside', () => {
    expect(diagram.containers.map((c) => [c.id, c.label])).toEqual([
      ['pay', 'Payment'],
      ['after', 'After the order'],
    ]);
    expect(node('card')?.parent).toBe('pay');
    expect(node('notify')?.parent).toBe('after');
    expect(node('address')?.parent).toBeUndefined();
  });

  it('reads every link form with PlantUML-style ids', () => {
    expect(edge('signedIn-->login')?.label).toBe('no');
    expect(edge('card-->psp')?.label).toBe('3-D Secure');
    expect(edge('psp..>ledger')).toMatchObject({ dashed: true, label: 'webhook' });
    expect(edge('psp-->ok')).toBeDefined();
    expect(edge('invoice--warehouse')).toMatchObject({ head: 'none', tail: 'none' });
    expect(edge('notify--0archive')?.head).toBe('circle');
    expect(edge('ledger--xfraud')?.head).toBe('cross');
    expect(edge('fraud<-->ledger')).toMatchObject({ head: 'arrow', tail: 'arrow' });
    expect(edge('confirm--archive')?.hidden).toBe(true);
    expect(diagram.edges.filter((e) => e.from === 'method').map((e) => e.to)).toEqual(['card', 'wallet']);
  });

  it('expands chains and & groups, numbers repeats, honours edge ids', () => {
    const { diagram: d, warnings } = parseMermaid('graph TD;\n  A & B --> C --> D & E;\n  A --> C\n  X e1@==> Y; X e1@--> Y');
    expect(warnings).toEqual([]);
    expect(d.direction).toBe('TB');
    expect(d.edges.map((e) => e.id)).toEqual(['A-->C', 'B-->C', 'C-->D', 'C-->E', 'A-->C#2', 'e1', 'e1#2']);
  });

  it('reads quoted labels, entity codes, markdown strings and @{} shapes', () => {
    const { diagram: d, warnings } = parseMermaid('flowchart LR\n  a["Say #quot;hi#quot; (now)"] --> b("`**Bold** text`")\n  c@{ shape: cyl, label: "Store" } -- "uses it" --> a\n  subgraph "Outer box"\n    d\n  end');
    expect(warnings).toEqual([]);
    expect(d.nodes.find((n) => n.id === 'a')?.label).toBe('Say "hi" (now)');
    expect(d.nodes.find((n) => n.id === 'b')?.label).toBe('Bold text');
    expect(d.nodes.find((n) => n.id === 'c')).toMatchObject({ kind: 'database', label: 'Store' });
    expect(d.edges.find((e) => e.from === 'c')?.label).toBe('uses it');
    expect(d.nodes.find((n) => n.id === 'd')?.parent).toBe('Outer box');
  });
});

describe('Mermaid sequence', () => {
  const model = () => {
    const s = parse('sequence').diagram.special;
    if (s?.type !== 'sequence') throw new Error('not a sequence');
    return s;
  };
  it('reads participants, boxes and message styles', () => {
    const m = model();
    expect(m.participants.map((p) => `${p.id}:${p.kind}:${p.label}`)).toEqual([
      'C:actor:Customer',
      'Web:participant:Web app',
      'Pay:participant:Payment service',
      'Ledger:database:Ledger',
      'Stripe:participant:Stripe',
      'Mail:participant:Mailer',
    ]);
    expect(m.boxes).toEqual([{ label: 'Payments', participants: ['Pay', 'Ledger'], line: 6 }]);
    const messages = m.events.filter((e) => e.type === 'message');
    expect(messages).toHaveLength(19);
    expect(messages[3]).toMatchObject({ id: 'Stripe->Pay#1', dashed: true, head: 'arrow', number: '4' });
    expect(messages.find((e) => e.label === 'webhook: succeeded')).toMatchObject({ head: 'open', dashed: false });
    expect(messages.find((e) => e.label === 'Void')).toMatchObject({ head: 'cross', dashed: true });
  });
  it('turns +/- into activations and places destroy after its message', () => {
    const m = model();
    const kinds = m.events.map((e) => (e.type === 'message' ? `msg:${e.label}` : e.type === 'activate' || e.type === 'deactivate' || e.type === 'create' || e.type === 'destroy' ? `${e.type}:${e.participant}` : e.type));
    expect(kinds.slice(0, 4)).toEqual(['msg:Place order', 'activate:Web', 'msg:Authorise 49.90 EUR', 'activate:Pay']);
    expect(kinds).toContain('deactivate:Stripe');
    expect(kinds.slice(kinds.indexOf('create:Mail'), kinds.indexOf('create:Mail') + 4)).toEqual(['create:Mail', 'msg:Queue receipt', 'msg:Sent', 'destroy:Mail']);
    // rect draws nothing, so its end must not close a group.
    expect(m.events.filter((e) => e.type === 'groupStart')).toHaveLength(5);
    expect(m.events.filter((e) => e.type === 'groupEnd')).toHaveLength(5);
    expect(m.events.find((e) => e.type === 'note' && e.side === 'over')).toMatchObject({ over: ['C', 'Web'], text: 'Order page refreshes' });
  });
});

describe('Mermaid class', () => {
  const { diagram } = parse('class');
  const node = (id: string) => diagram.nodes.find((n) => n.id === id);
  const edge = (id: string) => diagram.edges.find((e) => e.id === id);
  it('reads class bodies, annotations, generics and member lines', () => {
    expect(node('Order')).toMatchObject({ parent: 'Ordering', compartments: [['-UUID id', '-Instant placedAt'], ['+total() Money', '+cancel()']] });
    expect(node('OrderStatus')).toMatchObject({ classKind: 'enum', compartments: [['PENDING', 'PAID', 'SHIPPED', 'CANCELLED']] });
    expect(node('PaymentGateway')?.classKind).toBe('interface');
    expect(node('Product')).toMatchObject({ classKind: 'abstract', compartments: [['+String sku'], ['+price() Money']] });
    expect(node('Repository')).toMatchObject({ label: 'Repository<T>', compartments: [[], ['+find(UUID id) T', '+save(T item)']] });
    expect(node('Money')?.label).toBe('Money (value)');
    expect(node('note:StripeGateway')).toMatchObject({ kind: 'note', attachedTo: { id: 'StripeGateway', side: 'right' } });
  });
  it('normalises relations like the PlantUML reader', () => {
    expect(edge('Customer-->Order')).toMatchObject({ fromLabel: '1', toLabel: '*', label: 'places' });
    expect(edge('OrderLine--*Order')).toMatchObject({ kind: 'composition', fromLabel: '1..*', toLabel: '1', reversed: true });
    expect(edge('Book--|>Product')).toMatchObject({ kind: 'generalization', reversed: true });
    expect(edge('StripeGateway..|>PaymentGateway')?.kind).toBe('realization');
    expect(edge('Money--oCustomer')?.kind).toBe('aggregation');
    expect(edge('Order..>Repository')).toMatchObject({ kind: 'dependency', reversed: true });
  });
});

describe('Mermaid state', () => {
  const { diagram } = parse('state');
  it('scopes [*] per composite and turns forward references into composites', () => {
    expect(diagram.nodes.filter((n) => n.kind === 'initial').map((n) => n.id).sort()).toEqual(['[*]', '[*]@Fulfilment', '[*]@Notifications', '[*]@Review']);
    expect(diagram.containers.map((c) => c.id)).toEqual(['Review', 'Fulfilment', 'Notifications']);
    expect(diagram.nodes.some((n) => n.id === 'Review')).toBe(false);
    expect(diagram.edges.find((e) => e.id === 'Submitted-->Review')?.label).toBe('needs review');
    expect(diagram.edges.find((e) => e.id === 'Delivered-->[*]end')).toBeDefined();
  });
  it('reads pseudo-states, descriptions, aliases and notes', () => {
    const node = (id: string) => diagram.nodes.find((n) => n.id === id);
    expect(node('check')?.kind).toBe('choice');
    expect(node('merge')?.kind).toBe('fork');
    expect(node('Paying')?.description).toEqual(['charge card', 'retry 3 times']);
    expect(node('Shipped')?.label).toBe('Out for delivery');
    expect(node('Picking')?.parent).toBe('Fulfilment');
    expect(node('note:Paying')?.label).toBe('Card is charged once;\nretries use the same idempotency key.');
    expect(node('note:Cancelled')).toMatchObject({ label: 'refund if paid', attachedTo: { id: 'Cancelled', side: 'left' } });
  });
});

describe('Mermaid ER', () => {
  const { diagram } = parse('er');
  it('reads crow feet in symbol and word form', () => {
    expect(diagram.edges.find((e) => e.id === 'USER||--o{POST')).toMatchObject({ tail: 'crowOne', head: 'crowZeroMany', label: 'writes' });
    expect(diagram.edges.find((e) => e.id === 'USER|o..o|PROFILE')).toMatchObject({ dashed: true, label: 'may have' });
    expect(diagram.edges.find((e) => e.id === 'POST||--|{POST-TAG')?.head).toBe('crowOneMany');
    expect(diagram.edges.find((e) => e.from === 'TAG')?.label).toBeUndefined();
    expect(diagram.edges.find((e) => e.to === 'TEAM')).toMatchObject({ tail: 'crowOneMany', head: 'crowZeroMany', dashed: true, label: 'joins' });
  });
  it('splits key attributes into their own compartment, as PlantUML entities do', () => {
    const node = (id: string) => diagram.nodes.find((n) => n.id === id);
    expect(node('USER')).toMatchObject({ classKind: 'entity', compartments: [['id : bigint PK'], ['email : text UK — login', 'name : text']] });
    expect(node('POST-TAG')).toMatchObject({ label: 'Post tag', compartments: [['post_id : bigint PK, FK', 'tag_id : bigint PK, FK']] });
    expect(node('TEAM')?.compartments).toBeUndefined();
  });
});

describe('Mermaid gantt', () => {
  it('schedules after-chains around excluded weekends', () => {
    const g = parse('gantt').diagram.special;
    if (g?.type !== 'gantt') throw new Error();
    const t = (id: string) => g.tasks.find((x) => x.id === id)!;
    expect(g.start).toBe('2026-11-02');
    expect(g.closed).toEqual([0, 6]);
    expect([t('interviews').start, t('interviews').duration, t('interviews').completion]).toEqual([0, 5, 100]);
    expect(t('req').start).toBe(7); // the Monday after
    expect(t('signoff')).toMatchObject({ milestone: true, duration: 0, start: 11 });
    expect(t('api').duration).toBe(14); // 10 working days
    expect(t('load')).toMatchObject({ start: 35, after: ['pay', 'web'] }); // after the later of the two
    expect(t('pay').color).toBe('red');
    expect(t('Retro')).toMatchObject({ start: 70, duration: 2 }); // end dates are exclusive
  });
});

describe('Mermaid mindmap', () => {
  it('builds the tree from indentation; explicit ids win over labels', () => {
    const { diagram } = parse('mindmap');
    expect(diagram.nodes[0]).toMatchObject({ id: 'root', label: 'Launch plan', kind: 'topic' });
    expect(diagram.edges.filter((e) => e.from === 'root').map((e) => e.to)).toEqual(['Product', 'Marketing', 'Engineering', 'Support']);
    expect(diagram.edges.find((e) => e.id === 'Support--Docs#2')).toBeDefined();
    expect(diagram.nodes.find((n) => n.id === 'Rollback plan')).toBeDefined();
  });
});
