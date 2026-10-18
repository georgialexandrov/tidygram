import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { convert } from '../src/convert/index.ts';
import { ensureLayout } from '../src/layout/auto.ts';
import { emptyLayout, type LayoutFile } from '../src/layout/layout-file.ts';
import { parseDiagram } from '../src/model/diagram.ts';
import type { Diagram } from '../src/model/types.ts';
import { buildAnyScene } from '../src/scene/any.ts';
import { loadAvoid, type Avoid } from '../src/scene/avoid.ts';
import type { Scene } from '../src/scene/scene.ts';
import { buildGanttScene, buildTimingScene } from '../src/scene/gantt.ts';
import { buildSequenceScene } from '../src/scene/sequence.ts';

const require = createRequire(import.meta.url);
const root = new URL('../fixtures/', import.meta.url);
let avoid: Avoid;
beforeAll(async () => {
  avoid = await loadAvoid(join(dirname(require.resolve('libavoid-js')), 'libavoid.wasm'));
});

/** Converts a fixture to draw.io and opens the file again: the diagram, its layout and its scene (a drawing). */
async function reopened(name: string) {
  const original = parseDiagram(readFileSync(new URL(name, root), 'utf8'), name).diagram;
  const layout = await ensureLayout(original, emptyLayout());
  const model = original.special!;
  const before = model.type === 'sequence' ? buildSequenceScene(model, layout) : model.type === 'gantt' ? buildGanttScene(model, layout) : buildTimingScene(model, layout);
  const { source } = convert(original, layout, 'drawio', before);
  const opened = parseDiagram(source, 'x.drawio');
  const diagram: Diagram = opened.diagram;
  const back = await ensureLayout(diagram, emptyLayout());
  const scene = buildAnyScene(diagram, back, avoid) as Scene;
  return { source, before, opened, diagram, back, scene };
}

const near = (a: number, b: number) => Math.abs(a - b) <= 1;

describe('drawings of ordered diagrams', () => {
  it('the converted file is marked, and valid draw.io keeps the mark on the layer cell', async () => {
    for (const [name, kind] of [['sequence.puml', 'sequence'], ['gantt.puml', 'gantt'], ['timing.puml', 'timing']] as const) {
      const { source, diagram } = await reopened(name);
      expect(source).toContain(`<mxCell id="1" parent="0" style="pumlDrawing=${kind};" />`);
      expect(diagram.drawing).toBe(kind);
    }
  });

  it('files without the mark are plain graphs', async () => {
    const plain = parseDiagram(readFileSync(new URL('drawio/flowchart.drawio', root), 'utf8'), 'f.drawio').diagram;
    expect(plain.drawing).toBeUndefined();
  });

  it('sequence.puml: every message line is horizontal at its row, lifelines vertical, no warnings', async () => {
    const { before, opened, scene, diagram } = await reopened('sequence.puml');
    if (before.kind !== 'sequence') throw new Error('not a sequence');
    expect(opened.warnings).toEqual([]);
    expect(scene.drawing).toBe(true);
    const lines = new Map(scene.edges.map((e) => [e.edge.id, e]));
    let checked = 0;
    for (const m of before.messages) {
      const e = lines.get(m.e.id);
      expect(e, m.e.id).toBeDefined();
      const pts = e!.points;
      if (m.self) {
        // The loop's own waypoints, verbatim.
        expect(near(pts[0]![0], m.x1) && near(pts[0]![1], m.y), m.e.id).toBe(true);
        expect(pts.some(([x]) => near(x, m.x2)), m.e.id).toBe(true);
        continue;
      }
      expect(pts, m.e.id).toHaveLength(2);
      expect(near(pts[0]![0], m.x1) && near(pts[0]![1], m.y), `${m.e.id} start`).toBe(true);
      expect(near(pts[1]![0], m.x2) && near(pts[1]![1], m.y), `${m.e.id} end`).toBe(true);
      checked++;
    }
    expect(checked).toBeGreaterThan(10);
    for (const l of before.lifelines) {
      const parts = scene.nodes.filter((n) => new RegExp(`^${l.id}-(lifeline|delay)(-\\d+)?$`).test(n.node.id)).map((n) => n.box).sort((a, b) => a.y - b.y);
      expect(near(parts[0]!.x, l.x) && near(parts[0]!.y, l.y0) && near(parts.at(-1)!.y + parts.at(-1)!.h, l.y1), l.id).toBe(true);
      // The pieces meet end to end: a delay cuts the line, it does not leave a hole.
      for (let i = 1; i < parts.length; i++) expect(near(parts[i]!.y, parts[i - 1]!.y + parts[i - 1]!.h), `${l.id} piece ${i}`).toBe(true);
    }
    // Frames are open drawings, not filled boxes that hide what is under them.
    const frames = diagram.nodes.filter((n) => /shape=umlFrame/.test(n.drawn?.style ?? ''));
    expect(frames.length).toBeGreaterThan(1);
    for (const f of frames) expect(f.drawn!.style).toMatch(/fillColor=none/);
  });

  it('sequence.puml: a delay cuts every lifeline and dots it across the gap', async () => {
    const { before, diagram, scene, opened } = await reopened('sequence.puml');
    if (before.kind !== 'sequence') throw new Error('not a sequence');
    expect(before.delays.length).toBeGreaterThan(0);
    expect(opened.warnings).toEqual([]);
    for (const d of before.delays) {
      for (const l of before.lifelines) {
        if (d.y0 < l.y0 || d.y1 > l.y1) continue;
        const dotted = scene.nodes.find((n) => n.node.id.startsWith(`${l.id}-delay`) && near(n.box.y, d.y0) && near(n.box.y + n.box.h, d.y1));
        expect(dotted, `${l.id} across the delay`).toBeDefined();
        expect(diagram.nodes.find((n) => n.id === dotted!.node.id)!.drawn!.style).toMatch(/dashPattern=1 4/);
        // Nothing solid under the gap.
        const solid = scene.nodes.filter((n) => /-lifeline(-\d+)?$/.test(n.node.id) && n.node.id.startsWith(`${l.id}-`) && n.box.y < d.y1 - 1 && n.box.y + n.box.h > d.y0 + 1);
        expect(solid, `${l.id} under the delay`).toEqual([]);
      }
    }
    expect(convert(parseDiagram(readFileSync(new URL('sequence.puml', root), 'utf8'), 'sequence.puml').diagram, emptyLayout(), 'drawio').warnings.some((w) => /lifelines are not cut/.test(w.message))).toBe(false);
  });

  it('sequence.puml: autonumbers reopen as bubbles, not as text in the label', async () => {
    const { before, scene } = await reopened('sequence.puml');
    if (before.kind !== 'sequence') throw new Error('not a sequence');
    const numbered = before.messages.filter((m) => m.number);
    expect(numbered.length).toBeGreaterThan(10);
    for (const m of numbered) {
      const bubble = scene.nodes.find((n) => n.node.id === `${m.e.id}-number`)!;
      expect(bubble, m.e.id).toBeDefined();
      expect(bubble.node.label).toBe(m.number!.text);
      expect(bubble.node.drawn!.style).toMatch(/ellipse/);
      expect(near(bubble.box.x + bubble.box.w / 2, m.number!.x) && near(bubble.box.y + bubble.box.h / 2, m.number!.y), m.e.id).toBe(true);
      expect(near(bubble.box.w, m.number!.r * 2), m.e.id).toBe(true);
      // The label no longer carries the number, and sits where the render puts it.
      const line = scene.edges.find((e) => e.edge.id === m.e.id)!;
      expect(line.label!.text.lines.join(' ')).toBe(m.e.label);
      if (!m.self) expect(near(line.label!.y, m.label!.y), m.e.id).toBe(true);
    }
  });

  it('sequence.puml: participant heads keep the theme corners', async () => {
    const { before, scene, diagram } = await reopened('sequence.puml');
    if (before.kind !== 'sequence') throw new Error('not a sequence');
    const head = before.heads.find((h) => h.node.kind === 'rectangle')!;
    const style = diagram.nodes.find((n) => n.id === head.node.id)!.drawn!.style;
    expect(style).toMatch(/rounded=1/);
    expect(style).toMatch(/absoluteArcSize=1/);
    expect(Number(/arcSize=(\d+)/.exec(style)![1])).toBeGreaterThan(0);
    expect(scene.nodes.find((n) => n.node.id === head.node.id)!.box.w).toBeCloseTo(head.box.w, 0);
  });

  it('gantt.puml: bars at their x positions, no warnings', async () => {
    const { before, opened, scene } = await reopened('gantt.puml');
    if (before.kind !== 'gantt') throw new Error('not a gantt');
    expect(opened.warnings).toEqual([]);
    for (const row of before.rows) {
      const box = scene.nodes.find((n) => n.node.id === row.task.id)!.box;
      // A milestone is a diamond centred on its bar.
      if (row.task.milestone) expect(near(box.x + box.w / 2, row.bar.x + row.bar.w / 2), row.task.id).toBe(true);
      else expect(near(box.x, row.bar.x) && near(box.w, row.bar.w) && near(box.y, row.bar.y), row.task.id).toBe(true);
    }
    expect(scene.edges.length).toBe(before.rows.reduce((n, r) => n + r.task.after.length, 0));
  });

  it('timing.puml: lanes and messages where the render has them', async () => {
    const { before, opened, scene } = await reopened('timing.puml');
    if (before.kind !== 'timing') throw new Error('not timing');
    expect(opened.warnings).toEqual([]);
    for (const lane of before.lanes) expect(near(scene.nodes.find((n) => n.node.id === lane.signal.id)!.box.y, lane.y), lane.signal.id).toBe(true);
    for (const [i, m] of before.messages.entries()) {
      const e = scene.edges[i]!;
      expect(near(e.points[0]![0], m.from[0]) && near(e.points[0]![1], m.from[1]), 'from').toBe(true);
      expect(near(e.points.at(-1)![0], m.to[0]) && near(e.points.at(-1)![1], m.to[1]), 'to').toBe(true);
    }
  });

  it('auto layout does nothing; dragging a shape leaves its lines straight between their ends', async () => {
    const { diagram, back, scene } = await reopened('sequence.puml');
    expect(await ensureLayout(diagram, back, 'auto')).toBe(back);
    const bar = scene.nodes.find((n) => /^activation/.test(n.node.id))!;
    const touched = scene.edges.filter((e) => e.edge.from === bar.node.id || e.edge.to === bar.node.id);
    expect(touched.length).toBeGreaterThan(0);
    const moved: LayoutFile = { ...back, nodes: { ...back.nodes, [bar.node.id]: { x: back.nodes[bar.node.id]!.x + 40, y: back.nodes[bar.node.id]!.y } } };
    const after = buildAnyScene(diagram, moved, avoid) as Scene;
    const first = after.edges.find((e) => e.edge.id === touched[0]!.edge.id)!;
    expect(first.points).toHaveLength(2);
    expect(near(first.points[0]![0], touched[0]!.points[0]![0] + (touched[0]!.edge.from === bar.node.id ? 40 : 0))).toBe(true);
  });
});
