import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { convert, TARGET_EXTENSION, type ConvertTarget } from '../src/convert/index.ts';
import { ensureLayout } from '../src/layout/auto.ts';
import { emptyLayout, type LayoutFile } from '../src/layout/layout-file.ts';
import { parseDiagram } from '../src/model/diagram.ts';
import { findElement, parseXml, type XmlElement } from '../src/model/xml.ts';
import type { Diagram } from '../src/model/types.ts';
import { buildAnyScene, type AnyScene } from '../src/scene/any.ts';
import { loadAvoid, type Avoid } from '../src/scene/avoid.ts';
import type { Scene } from '../src/scene/scene.ts';
import { FREE_SIZE } from '../src/scene/shapes.ts';
import { composeIds, differences } from './convert-helpers.ts';

const require = createRequire(import.meta.url);
const root = new URL('../fixtures/', import.meta.url);
const FIXTURES = [
  ...readdirSync(root).filter((f) => f.endsWith('.puml')),
  ...readdirSync(new URL('mermaid/', root)).filter((f) => f.endsWith('.mmd')).map((f) => `mermaid/${f}`),
  ...readdirSync(new URL('drawio/', root)).filter((f) => f.endsWith('.drawio')).map((f) => `drawio/${f}`),
].sort();
const TARGETS: ConvertTarget[] = ['puml', 'mermaid', 'drawio'];

/** Fixture × target pairs the target can't express at all. */
const UNSUPPORTED = new Set(['gantt.puml → drawio', 'sequence.puml → drawio', 'timing.puml → drawio', 'timing.puml → mermaid', 'mermaid/gantt.mmd → drawio', 'mermaid/sequence.mmd → drawio']);

/**
 * Every difference between a fixture and its converted, re-read twin, by
 * category. A pair that isn't listed must come back identical (ids through
 * the id map, labels, kinds, ends, heads, members, ...). Stale entries fail
 * too: this is the documented list of what each target loses.
 */
const LOSSES: Record<string, string[]> = {
  // PlantUML description diagrams have no rounded box, diamond or pseudo-state outlines.
  'activity.puml → puml': ['node kind action→rectangle', 'node kind choice→hexagon', 'node kind decision→hexagon', 'node kind final→circle', 'node kind fork→rectangle', 'node kind initial→circle'],
  'activity.puml → mermaid': ['edge kind noteLink→dependency', 'node kind choice→relationship', 'node kind decision→relationship', 'node kind final→attribute', 'node kind fork→rectangle', 'node kind initial→attribute', 'node kind note→card'],
  'activity.puml → drawio': ['edge kind noteLink→dependency', 'node kind choice→relationship', 'node kind decision→relationship', 'node kind final→attribute', 'node kind fork→rectangle', 'node kind initial→attribute'],
  // ArchiMate's filled-dot (assignment) end has no PlantUML arrow token.
  'archimate.puml → puml': ['edge tail dot→circle'],
  'archimate.puml → mermaid': ['edge head diamondFilled→arrow', 'edge head triangle→arrow', 'edge kind composition→association', 'edge kind realization→dependency', 'edge tail dot→arrow', 'node kind circle→attribute', 'stereotype'],
  'archimate.puml → drawio': ['node kind circle→attribute', 'stereotype'],
  'c4.puml → mermaid': ['description', 'node kind container→rectangle', 'node kind person→rectangle', 'node kind system→rectangle'],
  'c4.puml → drawio': ['description', 'node kind container→rectangle', 'node kind person→actor', 'node kind queue→database', 'node kind system→rectangle'],
  'chen.puml → puml': ['node kind attribute→usecase', 'node kind relationship→hexagon'],
  'chen.puml → mermaid': ['node kind circle→attribute'],
  'chen.puml → drawio': ['node kind circle→attribute'],
  // draw.io reads every class box back as an entity table.
  'class.puml → drawio': ['class kind abstract→entity', 'class kind class→entity', 'class kind enum→entity', 'class kind interface→entity', 'stereotype'],
  'component.puml → mermaid': ['node kind actor→rectangle', 'node kind component→rectangle', 'node kind interface→attribute', 'stereotype'],
  'component.puml → drawio': ['node kind queue→database', 'stereotype'],
  'deployment.puml → mermaid': ['node kind artifact→file', 'node kind node→rectangle'],
  'deployment.puml → drawio': ['node kind artifact→file', 'node kind queue→database', 'node kind storage→action'],
  // Mermaid ER rows are `type name PK "comment"`: the text is reformatted.
  'er.puml → mermaid': ['members'],
  'food-delivery.puml → mermaid': ['edge head triangle→arrow', 'edge kind generalization→association', 'edge kind noteLink→dependency', 'node kind actor→rectangle', 'node kind note→card', 'node kind usecase→action', 'stereotype'],
  'food-delivery.puml → drawio': ['edge kind noteLink→dependency', 'node kind usecase→attribute', 'stereotype'],
  'gantt.puml → mermaid': ['task colour', 'task completion'],
  'json.puml → puml': ['class kind json→object'],
  'json.puml → mermaid': ['class kind json→class'],
  'json.puml → drawio': ['class kind json→entity'],
  'mindmap.puml → drawio': ['node kind topic→action'],
  'nwdiag.puml → puml': ['description', 'node kind network→rectangle'],
  'nwdiag.puml → mermaid': ['description', 'edge end labels', 'node kind network→rectangle'],
  'nwdiag.puml → drawio': ['description', 'node kind network→rectangle'],
  // Mermaid has no dividers or delays.
  'sequence.puml → mermaid': ['event sequence'],
  'state.puml → drawio': ['description', 'edge kind noteLink→dependency', 'node kind choice→relationship', 'node kind final→attribute', 'node kind fork→rectangle', 'node kind initial→attribute', 'node kind state→action'],
  'yaml.puml → puml': ['class kind json→object'],
  'yaml.puml → mermaid': ['class kind json→class'],
  'yaml.puml → drawio': ['class kind json→entity'],
  'mermaid/class.mmd → drawio': ['class kind abstract→entity', 'class kind class→entity', 'class kind enum→entity', 'class kind interface→entity', 'edge kind noteLink→dependency'],
  'mermaid/flowchart.mmd → puml': ['node kind action→rectangle', 'node kind attribute→usecase', 'node kind relationship→hexagon'],
  'mermaid/flowchart.mmd → drawio': ['edge hidden', 'node kind storage→action'],
  'mermaid/mindmap.mmd → drawio': ['node kind topic→action'],
  'mermaid/state.mmd → drawio': ['description', 'edge kind noteLink→dependency', 'node kind choice→relationship', 'node kind final→attribute', 'node kind fork→rectangle', 'node kind initial→attribute', 'node kind state→action'],
  // A line from a note is a note link to PlantUML; draw.io calls it a dashed dependency.
  'drawio/compressed.drawio → puml': ['edge kind dependency→noteLink', 'node kind action→rectangle', 'node kind attribute→usecase', 'node kind relationship→hexagon'],
  'drawio/compressed.drawio → mermaid': ['node kind actor→rectangle', 'node kind label→rectangle', 'node kind note→card'],
  // Table rows like `PK  id` lose their double space (draw.io HTML labels collapse runs of spaces).
  'drawio/er.drawio → mermaid': ['edge tail crowMany→crowOneMany', 'members'],
  'drawio/er.drawio → drawio': ['members'],
  'drawio/flowchart.drawio → puml': ['edge kind dependency→noteLink', 'node kind action→rectangle', 'node kind attribute→usecase', 'node kind relationship→hexagon'],
  'drawio/flowchart.drawio → mermaid': ['node kind actor→rectangle', 'node kind label→rectangle', 'node kind note→card'],
  'drawio/objects.drawio → puml': ['edge head dot→circle', 'node kind action→rectangle', 'node kind relationship→hexagon'],
  'drawio/objects.drawio → mermaid': [
    'edge end labels', 'edge head diamondFilled→arrow', 'edge head diamond→arrow', 'edge head dot→arrow', 'edge head triangle→arrow',
    'edge kind aggregation→association', 'edge kind composition→association', 'edge kind generalization→association', 'edge kind realization→dependency', 'node kind component→rectangle',
  ],
  'drawio/pages.drawio → puml': ['node kind action→rectangle'],
};

let avoid: Avoid;
beforeAll(async () => {
  avoid = await loadAvoid(join(dirname(require.resolve('libavoid-js')), 'libavoid.wasm'));
});

const read = (name: string) => parseDiagram(readFileSync(new URL(name, root), 'utf8'), name).diagram;

async function prepared(diagram: Diagram): Promise<{ layout: LayoutFile; scene: AnyScene }> {
  const layout = await ensureLayout(diagram, emptyLayout());
  return { layout, scene: buildAnyScene(diagram, layout, avoid) };
}

/** Converts and reads the output back; the output must parse without a single warning. */
function roundTrip(diagram: Diagram, layout: LayoutFile, target: ConvertTarget, scene?: AnyScene) {
  const result = convert(diagram, layout, target, scene);
  const back = parseDiagram(result.source, `converted${TARGET_EXTENSION[target]}`);
  expect(back.warnings).toEqual([]);
  return { result, back: back.diagram };
}

const near = (a: number, b: number) => Math.abs(a - b) <= 1;

describe('conversion round trips', () => {
  for (const fixture of FIXTURES) {
    it(`${fixture} → every target`, async () => {
      const diagram = read(fixture);
      const { layout, scene } = await prepared(diagram);
      for (const target of TARGETS) {
        const key = `${fixture} → ${target}`;
        const result = convert(diagram, layout, target, scene);
        if (UNSUPPORTED.has(key)) {
          expect(result.source, key).toBe('');
          expect(result.warnings.length, key).toBeGreaterThan(0);
          continue;
        }
        expect(result.source, key).not.toBe('');
        const { back } = roundTrip(diagram, layout, target, scene);
        expect(differences(diagram, back, result.ids), key).toEqual(LOSSES[key] ?? []);

        if (diagram.special) {
          // Ordered diagrams: only dragged columns live in the sidecar, under the new participant ids.
          for (const [id, p] of Object.entries(layout.nodes)) expect(result.layout.nodes[result.ids.nodes[id]!], key).toEqual(p);
          continue;
        }
        if (target === 'drawio') {
          // The file is the layout: boxes read back as the scene drew them, and the rebuilt scene matches.
          const graph = scene as Scene;
          const boxes = new Map(back.nodes.map((n) => [n.id, n.sourceBox!]));
          for (const sn of graph.nodes) {
            const box = boxes.get(result.ids.nodes[sn.node.id]!)!;
            const want = FREE_SIZE.has(sn.node.kind) ? { x: sn.anchor.cx - sn.anchor.w / 2, y: sn.anchor.cy - sn.anchor.h / 2, w: sn.anchor.w, h: sn.anchor.h } : sn.box;
            expect([box.x, box.y, box.w, box.h].every((v, i) => near(v, [want.x, want.y, want.w, want.h][i]!)), `${key}: ${sn.node.id}`).toBe(true);
          }
          for (const c of graph.containers) {
            const box = back.containers.find((x) => x.id === result.ids.nodes[c.id])!.sourceBox!;
            expect([box.x, box.y, box.w, box.h].every((v, i) => near(v, [c.box.x, c.box.y, c.box.w, c.box.h][i]!)), `${key}: ${c.id}`).toBe(true);
          }
          const again = buildAnyScene(back, await ensureLayout(back, result.layout), avoid) as Scene;
          const rebuilt = new Map(again.nodes.map((n) => [n.node.id, n]));
          for (const sn of graph.nodes) {
            const other = rebuilt.get(result.ids.nodes[sn.node.id]!)!;
            // The figure lands where it was (a stereotype that didn't survive may change the label block below it).
            if (other.node.kind !== sn.node.kind) continue; // a different kind draws a different figure
            expect(near(sn.anchor.cx, other.anchor.cx) && near(sn.anchor.cy, other.anchor.cy), `${key}: ${sn.node.id} centre`).toBe(true);
          }
        } else {
          // Text formats: the re-keyed sidecar puts every node exactly where it was.
          const relaid = await ensureLayout(back, result.layout);
          for (const n of diagram.nodes) {
            const p = relaid.nodes[result.ids.nodes[n.id]!]!;
            expect(near(p.x, layout.nodes[n.id]!.x) && near(p.y, layout.nodes[n.id]!.y), `${key}: ${n.id}`).toBe(true);
          }
          for (const [id, e] of Object.entries(layout.edges)) expect(result.layout.edges[result.ids.edges[id]!], `${key}: ${id}`).toEqual(e);
        }
      }
    }, 60_000);
  }
});

/** A → B → A: the second trip may not lose anything the first didn't. */
const THERE_AND_BACK: [fixture: string, via: ConvertTarget, back: ConvertTarget, losses: string[]][] = [
  ['component.puml', 'mermaid', 'puml', ['node kind actor→rectangle', 'node kind component→rectangle', 'node kind interface→usecase', 'stereotype']],
  ['class.puml', 'mermaid', 'puml', []],
  ['state.puml', 'mermaid', 'puml', []],
  ['sequence.puml', 'mermaid', 'puml', ['event sequence']],
  ['gantt.puml', 'mermaid', 'puml', ['task colour', 'task completion']],
  ['mermaid/class.mmd', 'puml', 'mermaid', []],
  ['mermaid/flowchart.mmd', 'drawio', 'mermaid', ['edge hidden', 'node kind storage→action']],
  ['mermaid/sequence.mmd', 'puml', 'mermaid', []],
  // Ellipses come home (usecase → ellipse → attribute); rounded boxes and diamonds don't.
  ['drawio/flowchart.drawio', 'puml', 'drawio', ['node kind action→rectangle', 'node kind relationship→hexagon']],
  ['drawio/objects.drawio', 'mermaid', 'drawio', [
    'edge end labels', 'edge head diamondFilled→arrow', 'edge head diamond→arrow', 'edge head dot→arrow', 'edge head triangle→arrow',
    'edge kind aggregation→association', 'edge kind composition→association', 'edge kind generalization→association', 'edge kind realization→dependency', 'node kind component→rectangle',
  ]],
];

describe('there and back again', () => {
  for (const [fixture, via, home, losses] of THERE_AND_BACK) {
    it(`${fixture} → ${via} → ${home}`, async () => {
      const diagram = read(fixture);
      const { layout, scene } = await prepared(diagram);
      const first = roundTrip(diagram, layout, via, scene);
      const middle = first.back.special ? undefined : buildAnyScene(first.back, await ensureLayout(first.back, first.result.layout), avoid);
      const midLayout = first.back.special ? first.result.layout : await ensureLayout(first.back, first.result.layout);
      const second = roundTrip(first.back, midLayout, home, middle);
      const ids = composeIds(first.result.ids, second.result.ids);
      expect(differences(diagram, second.back, ids)).toEqual(losses);
      if (diagram.special) return;
      // Positions survive both trips: figures within a pixel of where they started.
      const finalScene = buildAnyScene(second.back, await ensureLayout(second.back, second.result.layout), avoid) as Scene;
      const centres = new Map(finalScene.nodes.map((n) => [n.node.id, n]));
      for (const sn of (scene as Scene).nodes) {
        const other = centres.get(ids.nodes[sn.node.id]!)!;
        if (other.node.kind !== sn.node.kind) continue;
        expect(near(sn.anchor.cx, other.anchor.cx) && near(sn.anchor.cy, other.anchor.cy), sn.node.id).toBe(true);
      }
    }, 60_000);
  }
});

describe('ids', () => {
  it('keeps every id a PlantUML or Mermaid alias can carry', async () => {
    const diagram = read('component.puml');
    const { layout } = await prepared(diagram);
    for (const target of ['puml', 'mermaid'] as const) {
      const { result } = roundTrip(diagram, layout, target);
      for (const n of diagram.nodes) expect(result.ids.nodes[n.id]).toBe(n.id);
    }
    // PlantUML edge ids are derived from the arrow, so a PlantUML → PlantUML trip keeps those too.
    const { result } = roundTrip(diagram, layout, 'puml');
    for (const e of diagram.edges) expect(result.ids.edges[e.id]).toBe(e.id);
  });

  it('maps ids the target cannot write, and re-keys the sidecar with them', async () => {
    const diagram = read('activity.puml');
    const { layout } = await prepared(diagram);
    const { result } = roundTrip(diagram, layout, 'mermaid');
    const odd = diagram.nodes.find((n) => /[^\w]/.test(n.id))!;
    const mapped = result.ids.nodes[odd.id]!;
    expect(mapped).toMatch(/^[\p{L}\p{N}_-]+$/u);
    expect(result.layout.nodes[mapped]).toEqual(layout.nodes[odd.id]);
    // The same ids survive into PlantUML, quoted.
    expect(roundTrip(diagram, layout, 'puml').result.ids.nodes[odd.id]).toBe(odd.id);
  });

  it('keeps word line ids (draw.io cell ids) in Mermaid with id@', async () => {
    const diagram = read('drawio/pages.drawio');
    const { layout } = await prepared(diagram);
    const { result } = roundTrip(diagram, layout, 'mermaid');
    expect(result.source).toContain('calls@-->');
    for (const e of diagram.edges) expect(result.ids.edges[e.id]).toBe(e.id);
  });
});

describe('PlantUML and Mermaid output', () => {
  it('adds direction hints from the layout and the dominant direction', async () => {
    const diagram = read('component.puml');
    const { layout } = await prepared(diagram);
    // Move one node far to the left of what it points at: its line needs a hint.
    const e = diagram.edges.find((x) => !x.hidden && x.from !== x.to && diagram.nodes.some((n) => n.id === x.from) && diagram.nodes.some((n) => n.id === x.to))!;
    const moved = { ...layout, nodes: { ...layout.nodes, [e.from]: { x: layout.nodes[e.to]!.x - 2000, y: layout.nodes[e.to]!.y } } };
    const source = convert(diagram, moved, 'puml').source;
    expect(source).toMatch(/-(right|left|up)->|\.(right|left|up)\.>/);
    expect(source.includes('left to right direction')).toBe(convert(diagram, layout, 'mermaid').source.startsWith('flowchart LR'));
  });

  it('escapes labels for each target and reads them back', async () => {
    const diagram: Diagram = {
      family: 'description',
      direction: 'TB',
      nodes: [
        { id: 'a', kind: 'component', label: 'List<int> & "quotes"\nsecond line #1', line: 1 },
        { id: 'b', kind: 'rectangle', label: 'Log in as guest', line: 2 },
      ],
      containers: [],
      edges: [{ id: 'a-->b', from: 'a', to: 'b', kind: 'association', dashed: false, head: 'arrow', tail: 'none', hidden: false, label: 'x | y', line: 3 }],
    };
    const { layout, scene } = await prepared(diagram);
    const drawio = roundTrip(diagram, layout, 'drawio', scene);
    expect(drawio.back.nodes.map((n) => n.label)).toEqual(diagram.nodes.map((n) => n.label));
    const mermaid = roundTrip(diagram, layout, 'mermaid');
    expect(mermaid.back.nodes.map((n) => n.label)).toEqual(diagram.nodes.map((n) => n.label));
    expect(mermaid.back.edges[0]!.label).toBe('x | y');
    // PlantUML has no escape for `"` (written as '), and drops ` #word` decorations.
    const puml = roundTrip(diagram, layout, 'puml');
    expect(puml.back.nodes[1]!.label).toBe('Log in as guest');
    expect(puml.back.nodes[0]!.label.startsWith("List<int> & 'quotes'\nsecond line")).toBe(true);
    expect(puml.result.warnings.some((w) => /double quote/.test(w.message))).toBe(true);
  });
});

describe('draw.io output', () => {
  it('is a plain mxfile draw.io can open', async () => {
    const diagram = read('class.puml');
    const { layout, scene } = await prepared(diagram);
    const { source } = convert(diagram, layout, 'drawio', scene);
    const doc = parseXml(source);
    const model = findElement(findElement(findElement(doc, 'mxfile')!, 'diagram')!, 'mxGraphModel')!;
    const cells = findElement(model, 'root')!.children;
    expect(cells[0]!.attrs).toEqual({ id: '0' });
    expect(cells[1]!.attrs).toEqual({ id: '1', parent: '0' });
    const ids = new Set(cells.map((c) => c.attrs.id));
    expect(ids.size).toBe(cells.length);
    for (const c of cells.slice(2)) {
      expect(c.name).toBe('mxCell');
      expect(c.attrs.vertex === '1' || c.attrs.edge === '1').toBe(true);
      expect(ids.has(c.attrs.parent!)).toBe(true);
      const geometry = c.children.find((g: XmlElement) => g.name === 'mxGeometry');
      expect(geometry?.attrs.as).toBe('geometry');
      if (c.attrs.edge === '1') {
        expect(ids.has(c.attrs.source!) && ids.has(c.attrs.target!)).toBe(true);
        expect(c.attrs.style).toContain('edgeStyle=orthogonalEdgeStyle');
      }
    }
    // Children sit relative to their container.
    const pkg = diagram.containers[0]!;
    const child = diagram.nodes.find((n) => n.parent === pkg.id)!;
    const cell = cells.find((c) => c.attrs.id === child.id)!;
    expect(cell.attrs.parent).toBe(pkg.id);
  });

  it('refuses ordered diagrams with a warning', () => {
    const result = convert(read('sequence.puml'), emptyLayout(), 'drawio');
    expect(result.source).toBe('');
    expect(result.warnings[0]!.message).toMatch(/Sequence diagrams can't be converted to draw\.io yet/);
  });
});
