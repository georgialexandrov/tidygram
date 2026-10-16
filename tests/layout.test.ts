import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ensureLayout, shapesFor } from '../src/layout/auto.ts';
import { emptyLayout, parseLayout, serializeLayout } from '../src/layout/layout-file.ts';
import { parsePuml } from '../src/model/parse.ts';
import { nodeBox, overlaps } from '../src/scene/containers.ts';

const { diagram } = parsePuml(readFileSync(new URL('../fixtures/food-delivery.puml', import.meta.url), 'utf8'));

function overlapping(layout: Awaited<ReturnType<typeof ensureLayout>>) {
  const shapes = shapesFor(diagram);
  const boxes = diagram.nodes.map((n) => [n.id, nodeBox(layout.nodes[n.id]!, shapes.get(n.id)!)] as const);
  const pairs: string[] = [];
  for (let i = 0; i < boxes.length; i++)
    for (let j = i + 1; j < boxes.length; j++) if (overlaps(boxes[i]![1], boxes[j]![1])) pairs.push(`${boxes[i]![0]}/${boxes[j]![0]}`);
  return pairs;
}

describe('layout file', () => {
  it('round-trips with sorted keys and integer coordinates', () => {
    const text = serializeLayout({
      version: 1,
      nodes: { b: { x: 10.4, y: 20.6, pinned: true }, a: { x: 1, y: 2 } },
      edges: { 'a-->b': { via: [[5.5, 6]], label: [0, -8] } },
    });
    expect(text).toBe(
      '{\n  "version": 1,\n  "nodes": {\n    "a": { "x": 1, "y": 2 },\n    "b": { "x": 10, "y": 21, "pinned": true }\n  },\n  "edges": {\n    "a-->b": { "via": [[6, 6]], "label": [0, -8] }\n  }\n}\n',
    );
    expect(parseLayout(text).nodes.b).toEqual({ x: 10, y: 21, pinned: true });
  });

  it('drops malformed entries instead of rejecting the file', () => {
    const layout = parseLayout('{"nodes": {"a": {"x": 1}, "b": {"x": 1, "y": 2}}, "edges": {"e": {"via": [[1], [2, 3]]}}}');
    expect(layout.nodes).toEqual({ b: { x: 1, y: 2 } });
    expect(layout.edges).toEqual({ e: { via: [[2, 3]] } });
  });
});

describe('ensureLayout', () => {
  it('lays out an empty file without overlaps', async () => {
    const layout = await ensureLayout(diagram, emptyLayout());
    expect(Object.keys(layout.nodes).sort()).toEqual(diagram.nodes.map((n) => n.id).sort());
    expect(overlapping(layout)).toEqual([]);
  });

  it('fill mode keeps every stored position and places only new nodes', async () => {
    const full = await ensureLayout(diagram, emptyLayout());
    const partial = { ...full, nodes: { ...full.nodes } };
    delete partial.nodes.UC_Rate;
    delete partial.nodes.Maps;
    const filled = await ensureLayout(diagram, partial, 'fill');
    for (const [id, p] of Object.entries(partial.nodes)) expect(filled.nodes[id]).toEqual(p);
    expect(filled.nodes.UC_Rate).toBeDefined();
    expect(filled.nodes.Maps).toBeDefined();
    expect(overlapping(filled)).toEqual([]);
  });

  it('auto mode leaves pinned nodes exactly where they are', async () => {
    const full = await ensureLayout(diagram, emptyLayout());
    const pinned = { ...full, nodes: { ...full.nodes, Admin: { x: 5000, y: -3000, pinned: true }, PSP: { x: -800, y: 900, pinned: true } } };
    const result = await ensureLayout(diagram, pinned, 'auto');
    expect(result.nodes.Admin).toEqual({ x: 5000, y: -3000, pinned: true });
    expect(result.nodes.PSP).toEqual({ x: -800, y: 900, pinned: true });
    expect(overlapping(result)).toEqual([]);
  });

  it('keeps entries for ids that disappeared from the source (renames are recoverable)', async () => {
    const layout = { ...emptyLayout(), nodes: { Ghost: { x: 1, y: 1, pinned: true as const } } };
    const result = await ensureLayout(diagram, layout, 'fill');
    expect(result.nodes.Ghost).toEqual({ x: 1, y: 1, pinned: true });
  });
});
