import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeAll, describe, expect, it } from 'vitest';
import { ensureLayout, hasSourceLayout } from '../src/layout/auto.ts';
import { emptyLayout } from '../src/layout/layout-file.ts';
import { parseDiagram } from '../src/model/diagram.ts';
import { labelText } from '../src/model/drawio.ts';
import type { DEdge, Diagram } from '../src/model/types.ts';
import { DiagramSvg } from '../src/render/DiagramSvg.tsx';
import { loadAvoid, type Avoid } from '../src/scene/avoid.ts';
import { buildScene } from '../src/scene/scene.ts';
import { THEMES } from '../src/scene/theme.ts';
import { layoutPathFor } from '../src/paths.ts';

const require = createRequire(import.meta.url);
const source = (name: string) => readFileSync(new URL(`../fixtures/drawio/${name}.drawio`, import.meta.url), 'utf8');
const parse = (name: string) => parseDiagram(source(name), `${name}.drawio`);
const node = (d: Diagram, id: string) => d.nodes.find((n) => n.id === id)!;
const edge = (d: Diagram, id: string) => d.edges.find((e) => e.id === id)!;
/** The model without line numbers, which differ between a compressed page and an inline one. */
const lineless = (d: Diagram) => JSON.parse(JSON.stringify(d, (k, v) => (k === 'line' ? undefined : v)));

let avoid: Avoid;
beforeAll(async () => {
  avoid = await loadAvoid(join(dirname(require.resolve('libavoid-js')), 'libavoid.wasm'));
});

describe('draw.io fixtures', () => {
  const expected: Record<string, { nodes: number; containers: number; edges: number; warnings: number }> = {
    flowchart: { nodes: 13, containers: 3, edges: 12, warnings: 0 },
    compressed: { nodes: 13, containers: 3, edges: 12, warnings: 0 },
    pages: { nodes: 3, containers: 0, edges: 2, warnings: 0 },
    er: { nodes: 5, containers: 0, edges: 4, warnings: 0 },
    objects: { nodes: 10, containers: 0, edges: 9, warnings: 2 },
  };
  for (const [name, want] of Object.entries(expected)) {
    it(`${name}: parses and renders in every theme`, async () => {
      const { diagram, warnings } = parse(name);
      expect({ nodes: diagram.nodes.length, containers: diagram.containers.length, edges: diagram.edges.length, warnings: warnings.length }).toEqual(want);
      const layout = await ensureLayout(diagram, emptyLayout());
      for (const theme of Object.keys(THEMES)) {
        const scene = buildScene(diagram, { ...layout, view: { theme } }, avoid);
        expect(scene.nodes.length).toBe(diagram.nodes.length);
        expect(scene.edges.length).toBe(diagram.edges.length);
        expect(renderToStaticMarkup(createElement(DiagramSvg, { scene }))).not.toContain('NaN');
      }
    }, 30_000);
  }

  it('reads a compressed page exactly like the same page inline', () => {
    const plain = parse('flowchart');
    const packed = parse('compressed');
    expect(lineless(packed.diagram)).toEqual(lineless(plain.diagram));
    // Compressed pages have no lines of their own: everything points at the <diagram> element.
    expect(new Set(packed.diagram.nodes.map((n) => n.line))).toEqual(new Set([2]));
  });

  it('reads the first page by default and lists every page', () => {
    const { diagram, pages, page, warnings } = parse('pages');
    expect(diagram.nodes.map((n) => n.id)).toEqual(['web', 'api', 'db']);
    expect(pages).toEqual([
      { key: 'p1', name: 'Overview' },
      { key: 'p2', name: 'Details' },
      { key: 'p3', name: 'Notes' },
    ]);
    expect(page).toBe(0);
    expect(warnings).toEqual([]);
  });

  it('reads page N by index, id or name, including compressed pages', () => {
    const text = source('pages');
    const byIndex = parseDiagram(text, 'pages.drawio', { page: 2 });
    expect(byIndex.page).toBe(2);
    expect(byIndex.diagram.nodes.map((n) => n.id)).toEqual(['n1']);
    expect(parseDiagram(text, 'pages.drawio', { page: 'p3' }).diagram.nodes.map((n) => n.id)).toEqual(['n1']);
    expect(parseDiagram(text, 'pages.drawio', { page: 'Notes' }).page).toBe(2);
    // Page 2 is stored compressed.
    const details = parseDiagram(text, 'pages.drawio', { page: 'p2' });
    expect(details.page).toBe(1);
    expect(details.diagram.nodes.length).toBeGreaterThan(0);
    expect(details.warnings).toEqual([]);
  });

  it('falls back to the first page, with a warning, when the page is not there', () => {
    const missing = parseDiagram(source('pages'), 'pages.drawio', { page: 'gone' });
    expect(missing.page).toBe(0);
    expect(missing.diagram.nodes.map((n) => n.id)).toEqual(['web', 'api', 'db']);
    expect(missing.warnings[0]!.message).toContain('No page "gone"');
    expect(parseDiagram(source('pages'), 'pages.drawio', { page: 7 }).page).toBe(0);
  });

  it('leaves single-page files without a page list', () => {
    expect(parse('flowchart').pages).toBeUndefined();
    expect(parse('flowchart').page).toBeUndefined();
  });
});

describe('draw.io model', () => {
  it('turns nested geometry into absolute boxes and waypoints', () => {
    const { diagram } = parse('flowchart');
    expect(node(diagram, 'start').sourceBox).toEqual({ x: 160, y: 90, w: 80, h: 40 });
    // charge sits in payment (320,40) inside lane-shop (140,40).
    expect(node(diagram, 'charge')).toMatchObject({ parent: 'payment', sourceBox: { x: 480, y: 120, w: 130, h: 50 } });
    expect(diagram.containers.map((c) => [c.id, c.parent, c.kind])).toEqual([
      ['lane-shop', undefined, 'lane'],
      ['payment', 'lane-shop', 'group'],
      ['lane-wh', undefined, 'lane'],
    ]);
    expect(diagram.containers.find((c) => c.id === 'payment')!.sourceBox).toEqual({ x: 460, y: 80, w: 170, h: 260 });
    // Waypoints are in the edge's parent's coordinates: e-pay belongs to lane-shop.
    expect(edge(diagram, 'e-pay').sourceVia).toEqual([[440, 310], [440, 145]]);
    expect(edge(diagram, 'e-no').sourceVia).toEqual([[440, 210], [440, 20], [770, 20]]);
  });

  it('maps styles to element kinds', () => {
    const kinds = (name: string) => Object.fromEntries(parse(name).diagram.nodes.map((n) => [n.id, n.kind]));
    expect(kinds('flowchart')).toEqual({
      title: 'label',
      customer: 'actor',
      start: 'attribute',
      receive: 'action',
      'in-stock': 'relationship',
      reserve: 'rectangle',
      charge: 'action',
      receipt: 'action',
      pick: 'rectangle',
      'stock-db': 'database',
      end: 'attribute',
      email: 'cloud',
      'ship-note': 'note',
    });
    expect(kinds('objects')).toEqual({
      'svc-order': 'component',
      'svc-billing': 'hexagon',
      base: 'rectangle',
      invoice: 'file',
      queue: 'process',
      store: 'folder',
      card: 'card',
      lambda: 'rectangle', // unknown stencil, reported once
      start: 'action', // mxgraph.flowchart.terminator
      ok: 'relationship', // mxgraph.flowchart.decision
    });
  });

  it('decodes entities and HTML labels', () => {
    const { diagram } = parse('flowchart');
    expect(node(diagram, 'title').label).toBe('Order flow v2');
    expect(node(diagram, 'receive').label).toBe('Receive\norder');
    expect(node(diagram, 'reserve').label).toBe('Reserve\nitems');
    expect(node(diagram, 'receipt').label).toBe('Send receipt');
    expect(node(diagram, 'pick').label).toBe('Pick & pack');
    expect(node(diagram, 'ship-note').label).toBe('Ships within\n24 hours'); // &#xa; in a plain label
    expect(labelText('a&lt;b&gt;<br/>c &nbsp; d<div><span style="x">e</span></div>', true)).toBe('a<b>\nc d\ne');
    expect(labelText('<b>not html</b>', false)).toBe('<b>not html</b>');
  });

  it('unwraps UserObject/object, attaches edgeLabel children, flattens invisible groups', () => {
    const { diagram, warnings } = parse('objects');
    expect(node(diagram, 'svc-order').label).toBe('Order\nservice');
    expect(node(diagram, 'svc-billing').label).toBe('Billing');
    expect(edge(diagram, 'bills')).toMatchObject({ label: 'bills', fromLabel: '1', toLabel: '0..*' });
    expect(edge(diagram, 'owns').label).toBe('owns');
    expect(node(diagram, 'queue')).toMatchObject({ parent: undefined, sourceBox: { x: 40, y: 220, w: 120, h: 60 } });
    expect(warnings.map((w) => w.message)).toEqual([
      'Skipped line loose: it has a loose end',
      '1 shape drawn as plain boxes (no matching element kind): mxgraph.aws4.lambda_function',
    ]);
  });

  it('maps arrows to heads and line kinds', () => {
    const ends = (e: DEdge) => [e.tail, e.head, e.kind, e.dashed];
    const objects = parse('objects').diagram;
    const want: Record<string, unknown[]> = {
      gen: ['none', 'triangle', 'generalization', false],
      impl: ['none', 'triangle', 'realization', true],
      bills: ['none', 'arrow', 'association', false],
      owns: ['none', 'diamondFilled', 'composition', false],
      emits: ['none', 'diamond', 'aggregation', false],
      archives: ['circle', 'dot', 'association', false],
      tickets: ['none', 'cross', 'dependency', true],
      notify: ['none', 'none', 'association', false],
      flow: ['none', 'arrow', 'association', false],
    };
    for (const [id, w] of Object.entries(want)) expect(ends(edge(objects, id)), id).toEqual(w);

    const er = parse('er').diagram;
    expect(Object.fromEntries(er.edges.map((e) => [e.id, [e.from, e.to, e.tail, e.head]]))).toEqual({
      places: ['customer', 'order', 'crowOne', 'crowZeroMany'],
      // Lines to a table row attach to the table.
      contains: ['order', 'line', 'crowOne', 'crowOneMany'],
      refers: ['line', 'product', 'crowMany', 'crowOne'],
      lives: ['customer', 'address', 'crowOne', 'crowZeroOne'],
    });
    const flow = parse('flowchart').diagram;
    expect(ends(edge(flow, 'e-stock'))).toEqual(['arrow', 'arrow', 'association', false]);
    expect(ends(edge(flow, 'e-note'))).toEqual(['none', 'none', 'dependency', true]);
  });

  it('reads ER tables as entity boxes with their rows', () => {
    const { diagram } = parse('er');
    expect(node(diagram, 'customer')).toMatchObject({ kind: 'class', classKind: 'entity', compartments: [['id: int (PK)', 'name: text', 'email: text <unique>']] });
    expect(node(diagram, 'line').compartments).toEqual([['PK  id', 'FK  order_id', 'FK  product_id']]);
  });

  it('is picked by content or extension, and shares the stem rule for its sidecar', () => {
    const text = source('pages');
    for (const name of ['x.xml', 'x.drawio.xml', undefined]) expect(parseDiagram(text, name).diagram.nodes.length).toBe(3);
    expect(layoutPathFor('a/x.drawio')).toBe('a/x.layout.json');
    expect(layoutPathFor('a/x.drawio.xml')).toBe('a/x.layout.json');
    expect(layoutPathFor('a/x.xml')).toBe('a/x.layout.json');
  });
});

describe('draw.io layout', () => {
  it("places everything where the file draws it, at the file's size", async () => {
    const { diagram } = parse('flowchart');
    expect(hasSourceLayout(diagram)).toBe(true);
    const layout = await ensureLayout(diagram, emptyLayout());
    const scene = buildScene(diagram, layout, avoid);
    for (const n of scene.nodes) {
      const b = n.node.sourceBox!;
      // The anchor (an actor's figure) sits on the centre of the file box.
      expect([n.anchor.cx, n.anchor.cy], n.node.id).toEqual([b.x + b.w / 2, b.y + b.h / 2]);
      // Boxes keep the file's size unless the theme's text needs more (only the cloud's bumps do here).
      if (n.node.kind !== 'actor' && n.node.kind !== 'cloud') expect(n.box, n.node.id).toEqual(b);
    }
    for (const c of scene.containers) expect(c.box, c.id).toEqual(diagram.containers.find((x) => x.id === c.id)!.sourceBox);
    expect(layout.edges['e-pay']).toEqual({ via: [[440, 310], [440, 145]] });
    expect(Object.keys(layout.edges).sort()).toEqual(['e-done', 'e-no', 'e-pay']);
  });

  it('Reset returns to the file; Auto layout runs ELK', async () => {
    const { diagram } = parse('flowchart');
    const initial = await ensureLayout(diagram, emptyLayout());
    const edited = {
      ...initial,
      view: { theme: 'modern' },
      nodes: { ...initial.nodes, pick: { x: 1000, y: 1000, pinned: true }, gone: { x: 1, y: 1 } },
      edges: { ...initial.edges, 'e-pay': { via: [[1, 1]] as [number, number][] } },
    };
    const reset = await ensureLayout(diagram, edited, 'reset');
    // Same as a first load in that theme (the actor's figure, not its label, sits on the file box).
    const fresh = await ensureLayout(diagram, { ...emptyLayout(), view: { theme: 'modern' } });
    expect(reset.nodes).toEqual(fresh.nodes);
    expect(reset.edges).toEqual(initial.edges);
    expect(reset.view).toEqual({ theme: 'modern' });

    const auto = await ensureLayout(diagram, initial, 'auto');
    expect(auto.nodes.start).not.toEqual(initial.nodes.start);
    expect(auto.edges).toEqual({});
  });

  it('keeps edits across reloads: moved nodes, straightened lines, containers dragged by the title', async () => {
    const { diagram } = parse('flowchart');
    const initial = await ensureLayout(diagram, emptyLayout());
    const { 'e-pay': _, ...edges } = initial.edges;
    const reloaded = await ensureLayout(diagram, { ...initial, edges, nodes: { ...initial.nodes, pick: { x: 400, y: 520, pinned: true } } });
    expect(reloaded.edges['e-pay']).toBeUndefined();
    expect(reloaded.nodes.pick).toEqual({ x: 400, y: 520, pinned: true });

    // Dragging Payment by its title moves both children by the same amount: the box follows at its file size.
    const moved = { ...initial, nodes: { ...initial.nodes } };
    for (const id of ['charge', 'receipt']) moved.nodes[id] = { x: initial.nodes[id]!.x + 30, y: initial.nodes[id]!.y + 10 };
    const payment = buildScene(diagram, moved, avoid).containers.find((c) => c.id === 'payment')!;
    expect(payment.box).toEqual({ x: 490, y: 90, w: 170, h: 260 });
    // Moving one child alone rearranges the contents: the box fits them instead.
    moved.nodes.charge = { x: initial.nodes.charge!.x, y: initial.nodes.charge!.y };
    expect(buildScene(diagram, moved, avoid).containers.find((c) => c.id === 'payment')!.box.h).toBeLessThan(260);
  });

  it('new elements from an upstream edit land where the file puts them', async () => {
    const { diagram } = parse('flowchart');
    const initial = await ensureLayout(diagram, emptyLayout());
    const { end: _, ...nodes } = initial.nodes;
    const filled = await ensureLayout(diagram, { ...initial, nodes, edges: {} });
    expect(filled.nodes.end).toEqual({ x: 770, y: 160 });
    // Only lines whose ends are all new get the file's waypoints back.
    expect(Object.keys(filled.edges)).toEqual([]);
  });
});
