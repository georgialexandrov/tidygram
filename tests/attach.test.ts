import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { ensureLayout } from '../src/layout/auto.ts';
import { emptyLayout, parseLayout, serializeLayout, type EndAttach, type LayoutFile } from '../src/layout/layout-file.ts';
import { parseDiagram } from '../src/model/diagram.ts';
import type { Diagram } from '../src/model/types.ts';
import { attachOutline, nearestAttach, snapAttach, snapPoints } from '../src/scene/attach.ts';
import { loadAvoid, type Avoid } from '../src/scene/avoid.ts';
import type { AnchorShape } from '../src/scene/geometry.ts';
import { measureQuality } from '../src/scene/quality.ts';
import { buildScene, type Scene } from '../src/scene/scene.ts';
import { clearEnd, clearVia, setEnd } from '../src/editor/edits.ts';

const require = createRequire(import.meta.url);
let avoid: Avoid;
beforeAll(async () => {
  avoid = await loadAvoid(join(dirname(require.resolve('libavoid-js')), 'libavoid.wasm'));
});

const rect: AnchorShape = { cx: 100, cy: 50, w: 80, h: 40, dx: 0, dy: 0, shape: 'rect' };
const ellipse: AnchorShape = { ...rect, shape: 'ellipse' };

describe('attachment geometry', () => {
  it('maps fractions to the chosen side and back', () => {
    expect(attachOutline(rect, { x: 0.25, y: 0, side: 'top' })).toEqual([80, 30]);
    expect(attachOutline(rect, { x: 1, y: 0.5, side: 'right' })).toEqual([140, 50]);
    const near = nearestAttach(rect, [85, 10]);
    expect(near.attach).toEqual({ x: 0.3125, y: 0, side: 'top' });
    expect(near.outline).toEqual([85, 30]);
  });

  it('projects round outlines along the side', () => {
    const p = attachOutline(ellipse, { x: 0.5, y: 0, side: 'top' });
    expect(p[0]).toBeCloseTo(100);
    expect(p[1]).toBeCloseTo(30, 3);
    const a = nearestAttach(ellipse, [200, 0]);
    expect(['top', 'right']).toContain(a.attach.side);
    // The stored attachment draws exactly where the handle was let go.
    const back = attachOutline(ellipse, a.attach);
    expect(Math.hypot(back[0] - a.outline[0], back[1] - a.outline[1])).toBeLessThan(0.5);
  });

  it('snaps to side centres, quarters and corners, and Alt keeps the free point', () => {
    expect(snapPoints(rect)).toHaveLength(20);
    expect(snapAttach(rect, [103, 20], 6).attach).toEqual({ x: 0.5, y: 0, side: 'top' });
    expect(snapAttach(rect, [103, 20], 6, true).attach.x).toBeCloseTo(0.5375);
    // A corner keeps the side the pointer is on.
    expect(snapAttach(rect, [58, 41], 6).attach).toEqual({ x: 0, y: 0.25, side: 'left' });
    expect(snapAttach(rect, [63, 29], 6).attach).toEqual({ x: 0, y: 0, side: 'top' });
    expect(snapPoints(ellipse)).toHaveLength(16);
  });
});

describe('sidecar', () => {
  it('round-trips from/to, and old sidecars stay valid', () => {
    const layout: LayoutFile = { ...emptyLayout(), edges: { 'a-->b': { via: [[1, 2]], from: { x: 0.25, y: 0, side: 'top' }, to: { x: 1, y: 0.3333333, side: 'right' } } } };
    const text = serializeLayout(layout);
    expect(text).toContain('"from": { "x": 0.25, "y": 0, "side": "top" }');
    expect(text).toContain('"to": { "x": 1, "y": 0.333, "side": "right" }');
    expect(parseLayout(text).edges['a-->b']).toEqual({ via: [[1, 2]], from: { x: 0.25, y: 0, side: 'top' }, to: { x: 1, y: 0.333, side: 'right' } });
    const old = '{ "version": 1, "nodes": { "a": { "x": 1, "y": 2 } }, "edges": { "a-->b": { "via": [[3, 4]] } } }';
    expect(serializeLayout(parseLayout(old))).toBe(serializeLayout({ version: 1, nodes: { a: { x: 1, y: 2 } }, edges: { 'a-->b': { via: [[3, 4]] } } }));
  });

  it('is tolerant: clamps fractions, derives a missing side, drops junk', () => {
    const l = parseLayout('{ "version": 1, "nodes": {}, "edges": { "e": { "from": { "x": 1.4, "y": 0.5 }, "to": { "x": "a" } } } }');
    expect(l.edges.e).toEqual({ from: { x: 1, y: 0.5, side: 'right' } });
  });

  it('edits: one end set or cleared; straighten clears ends with the bends', () => {
    const a: EndAttach = { x: 0, y: 0.5, side: 'left' };
    const l1 = setEnd(emptyLayout(), 'e', 'from', a);
    expect(l1.edges.e).toEqual({ from: a });
    expect(clearEnd(l1, 'e', 'from').edges.e).toBeUndefined();
    expect(clearVia(setEnd(l1, 'e', 'to', a), 'e').edges.e).toBeUndefined();
  });
});

const fixture = (file: string): Diagram => parseDiagram(readFileSync(new URL(`../fixtures/${file}`, import.meta.url), 'utf8'), file).diagram;

/** The scene end at `end` of edge `id`, and the segment that leads into it. */
function endOf(scene: Scene, id: string, end: 'from' | 'to') {
  const e = scene.edges.find((x) => x.edge.id === id)!;
  const pts = end === 'to' ? e.points : [...e.points].reverse();
  return { at: pts[pts.length - 1]!, before: pts[pts.length - 2]!, line: e };
}

describe('router honours hand-chosen ends', () => {
  it('ends exactly at the chosen spot and comes in square, through moves and resizes', async () => {
    const diagram = fixture('class.puml');
    const layout = await ensureLayout(diagram, emptyLayout(), 'auto');
    const edge = diagram.edges.find((e) => e.from !== e.to)!;
    const cases: [EndAttach, EndAttach][] = [
      [{ x: 0, y: 0.5, side: 'left' }, { x: 0.25, y: 1, side: 'bottom' }],
      [{ x: 1, y: 0.25, side: 'right' }, { x: 0.75, y: 0, side: 'top' }],
    ];
    for (const [from, to] of cases) {
      for (const shift of [0, 140]) {
        const l: LayoutFile = { ...layout, nodes: { ...layout.nodes, [edge.from]: { x: layout.nodes[edge.from]!.x + shift, y: layout.nodes[edge.from]!.y + shift } }, edges: { [edge.id]: { from, to } } };
        for (const scale of [undefined, 0.8]) {
          const sized = scale ? { ...l, view: { scale } } : l;
          const scene = buildScene(diagram, sized, avoid);
          for (const [key, at, nodeId] of [['from', from, edge.from], ['to', to, edge.to]] as const) {
            const n = scene.nodes.find((x) => x.node.id === nodeId)!;
            const want = attachOutline(n.anchor, at);
            const got = endOf(scene, edge.id, key);
            expect(Math.hypot(got.at[0] - want[0], got.at[1] - want[1])).toBeLessThan(1);
            const vertical = at.side === 'top' || at.side === 'bottom';
            if (vertical) expect(Math.abs(got.before[0] - got.at[0])).toBeLessThan(0.5);
            else expect(Math.abs(got.before[1] - got.at[1])).toBeLessThan(0.5);
            // Coming in from outside, on the chosen side.
            const outwards = at.side === 'top' ? got.at[1] - got.before[1] : at.side === 'bottom' ? got.before[1] - got.at[1] : at.side === 'left' ? got.at[0] - got.before[0] : got.before[0] - got.at[0];
            expect(outwards).toBeGreaterThan(8);
          }
          expect(measureQuality(scene, diagram).details.filter((d) => d.startsWith('node:'))).toEqual([]);
        }
      }
    }
  });

  it('wins over automatic ports (diamond vertices) and keeps the drag fast path working', async () => {
    const diagram = fixture('activity.puml');
    const layout = await ensureLayout(diagram, emptyLayout(), 'auto');
    const scene0 = buildScene(diagram, layout, avoid);
    const diamond = scene0.nodes.find((n) => n.anchor.shape === 'diamond')!;
    const edge = diagram.edges.find((e) => e.to === diamond.node.id)!;
    const at: EndAttach = { x: 0, y: 0.5, side: 'left' };
    const l: LayoutFile = { ...layout, edges: { ...layout.edges, [edge.id]: { ...layout.edges[edge.id], to: at } } };
    const full = buildScene(diagram, l, avoid);
    const want = attachOutline(diamond.anchor, at);
    const got = endOf(full, edge.id, 'to');
    expect(Math.hypot(got.at[0] - want[0], got.at[1] - want[1])).toBeLessThan(1);
    expect(Math.abs(got.before[1] - got.at[1])).toBeLessThan(0.5);
    const fast = buildScene(diagram, l, avoid, { previous: scene0, dirty: { nodes: new Set(), edges: new Set([edge.id]) } });
    const quick = endOf(fast, edge.id, 'to');
    expect(Math.hypot(quick.at[0] - want[0], quick.at[1] - want[1])).toBeLessThan(1);
  });
});

describe('draw.io connection points', () => {
  const file = `<mxfile><diagram id="p1" name="P"><mxGraphModel><root><mxCell id="0" /><mxCell id="1" parent="0" />
<mxCell id="a" value="A" style="rounded=0;" vertex="1" parent="1"><mxGeometry x="0" y="0" width="120" height="60" as="geometry" /></mxCell>
<mxCell id="b" value="B" style="rounded=0;" vertex="1" parent="1"><mxGeometry x="300" y="200" width="120" height="60" as="geometry" /></mxCell>
<mxCell id="ab" style="edgeStyle=orthogonalEdgeStyle;exitX=1;exitY=0.5;exitDx=0;exitDy=0;entryX=0.25;entryY=0;entryDx=0;entryDy=0;" edge="1" parent="1" source="a" target="b"><mxGeometry relative="1" as="geometry" /></mxCell>
<mxCell id="ba" style="edgeStyle=orthogonalEdgeStyle;" edge="1" parent="1" source="b" target="a"><mxGeometry relative="1" as="geometry" /></mxCell>
</root></mxGraphModel></diagram></mxfile>`;

  it('a file with exit/entry points opens with them as hand-chosen ends', async () => {
    const { diagram } = parseDiagram(file, 'x.drawio');
    const layout = await ensureLayout(diagram, emptyLayout(), 'fill');
    expect(layout.edges.ab).toEqual({ from: { x: 1, y: 0.5, side: 'right' }, to: { x: 0.25, y: 0, side: 'top' } });
    expect(layout.edges.ba).toBeUndefined();
    const scene = buildScene(diagram, layout, avoid);
    const b = scene.nodes.find((n) => n.node.id === 'b')!;
    const end = endOf(scene, 'ab', 'to');
    expect(Math.hypot(end.at[0] - (b.anchor.cx - b.anchor.w / 4), end.at[1] - (b.anchor.cy - b.anchor.h / 2))).toBeLessThan(1);
  });

  it('export carries chosen ends; automatic ones read back as automatic', async () => {
    const { toDrawio } = await import('../src/convert/drawio.ts');
    const diagram = fixture('class.puml');
    const base = await ensureLayout(diagram, emptyLayout(), 'auto');
    const edge = diagram.edges.find((e) => e.from !== e.to)!;
    const layout: LayoutFile = { ...base, edges: { [edge.id]: { from: { x: 0, y: 0.5, side: 'left' } } } };
    const scene = buildScene(diagram, layout, avoid);
    const out = toDrawio(diagram, layout, scene);
    const back = parseDiagram(out.source, 'x.drawio').diagram;
    const cell = out.ids.edges[edge.id]!;
    const e = back.edges.find((x) => x.id === cell)!;
    expect(e.sourceFrom![0]).toBeCloseTo(0, 2);
    expect(e.sourceFrom![1]).toBeCloseTo(0.5, 1);
    expect(e.sourceTo).toBeUndefined();
    expect(back.edges.filter((x) => x.sourceFrom || x.sourceTo).map((x) => x.id)).toEqual([cell]);
    const reopened = await ensureLayout(back, emptyLayout(), 'fill');
    expect(reopened.edges[cell]?.from?.side).toBe('left');
  });
});

describe('draw.io waypoints', () => {
  it('drops a waypoint that sits on an end outline (it would hook the line)', async () => {
    const file = `<mxfile><diagram id="p1" name="P"><mxGraphModel><root><mxCell id="0" /><mxCell id="1" parent="0" />
<mxCell id="a" value="A" style="rounded=0;" vertex="1" parent="1"><mxGeometry x="0" y="0" width="120" height="60" as="geometry" /></mxCell>
<mxCell id="b" value="B" style="rounded=0;" vertex="1" parent="1"><mxGeometry x="300" y="200" width="120" height="60" as="geometry" /></mxCell>
<mxCell id="ab" style="edgeStyle=orthogonalEdgeStyle;" edge="1" parent="1" source="a" target="b"><mxGeometry relative="1" as="geometry"><Array as="points"><mxPoint x="200" y="30" /><mxPoint x="300" y="230" /></Array></mxGeometry></mxCell>
</root></mxGraphModel></diagram></mxfile>`;
    const { diagram } = parseDiagram(file, 'x.drawio');
    const layout = await ensureLayout(diagram, emptyLayout(), 'fill');
    expect(layout.edges.ab?.via).toEqual([[200, 30]]);
  });
});
