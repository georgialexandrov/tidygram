import { describe, expect, it } from 'vitest';
import { moveSelection, sidecarName, viaOf } from '../src/editor/edits.ts';
import { addAll, boxFrom, clickSelect, groupByFolder, marqueeSelect } from '../src/editor/selection.ts';
import type { LayoutFile } from '../src/layout/layout-file.ts';
import { parsePuml } from '../src/model/parse.ts';

const { diagram } = parsePuml('@startuml\nactor A\nactor B\nactor C\nA --> B\nB --> C\n@enduml\n');
const ab = diagram.edges.find((e) => e.from === 'A' && e.to === 'B')!.id;
const bc = diagram.edges.find((e) => e.from === 'B' && e.to === 'C')!.id;
const layout: LayoutFile = {
  version: 1,
  nodes: { A: { x: 0, y: 0 }, B: { x: 100, y: 0, pinned: true }, C: { x: 200, y: 0 } },
  edges: { [ab]: { via: [[50, 40]] }, [bc]: { via: [[150, 40]], label: [0, -8] } },
};

describe('moveSelection', () => {
  it('moves and pins every selected node in one edit, leaving the rest alone', () => {
    const next = moveSelection(layout, diagram, ['A', 'B'], 10, -5);
    expect(next.nodes.A).toEqual({ x: 10, y: -5, pinned: true });
    expect(next.nodes.B).toEqual({ x: 110, y: -5, pinned: true });
    expect(next.nodes.C).toEqual({ x: 200, y: 0 });
    expect(layout.nodes.A).toEqual({ x: 0, y: 0 }); // input untouched: undo keeps it
  });

  it('carries bends of lines inside the selection, keeps bends of lines leaving it', () => {
    const next = moveSelection(layout, diagram, ['A', 'B'], 10, 10);
    expect(next.edges[ab]!.via).toEqual([[60, 50]]);
    expect(next.edges[bc]).toEqual(layout.edges[bc]);
  });

  it('skips ids that have no position yet', () => {
    const next = moveSelection(layout, diagram, ['A', 'Ghost'], 1, 1);
    expect(next.nodes.Ghost).toBeUndefined();
    expect(next.nodes.A).toEqual({ x: 1, y: 1, pinned: true });
  });

  it('viaOf lists stored bends only', () => {
    expect(viaOf(layout)).toEqual({ [ab]: [[50, 40]], [bc]: [[150, 40]] });
  });
});

describe('selection', () => {
  const sel = new Set(['A', 'B']);

  it('toggles with a modifier, replaces without one', () => {
    expect([...clickSelect(sel, 'C', true, true)]).toEqual(['A', 'B', 'C']);
    expect([...clickSelect(sel, 'A', true, true)]).toEqual(['B']);
    expect([...clickSelect(sel, 'C', false, true)]).toEqual(['C']);
  });

  it('keeps the group when clicking one of its members, so the group can be dragged', () => {
    expect([...clickSelect(sel, 'A', false, true)]).toEqual(['A', 'B']);
  });

  it('ordered diagrams always select one', () => {
    expect([...clickSelect(sel, 'C', true, false)]).toEqual(['C']);
    expect([...clickSelect(sel, 'A', false, false)]).toEqual(['A']);
  });

  it('box title adds its contents or replaces', () => {
    expect([...addAll(sel, ['X', 'Y'], false)]).toEqual(['X', 'Y']);
    expect([...addAll(sel, ['X'], true)]).toEqual(['A', 'B', 'X']);
  });

  it('marquee takes elements fully inside the box', () => {
    const candidates = [
      { id: 'in', box: { x: 10, y: 10, w: 20, h: 20 } },
      { id: 'half', box: { x: 90, y: 10, w: 20, h: 20 } },
      { id: 'out', box: { x: 200, y: 10, w: 20, h: 20 } },
    ];
    const box = boxFrom([100, 50], [0, 0]);
    expect(box).toEqual({ x: 0, y: 0, w: 100, h: 50 });
    expect([...marqueeSelect(sel, candidates, box, false)]).toEqual(['in']);
    expect([...marqueeSelect(sel, candidates, box, true)]).toEqual(['A', 'B', 'in']);
  });

  it('groups files by folder with basenames', () => {
    expect(groupByFolder(['fixtures/a.puml', 'top.puml', 'fixtures/b.mmd'])).toEqual([
      { folder: 'fixtures', files: [{ path: 'fixtures/a.puml', name: 'a.puml' }, { path: 'fixtures/b.mmd', name: 'b.mmd' }] },
      { folder: '.', files: [{ path: 'top.puml', name: 'top.puml' }] },
    ]);
  });

  it('names the exported sidecar like the server does', () => {
    expect(sidecarName('fixtures/food-delivery.puml')).toBe('food-delivery.layout.json');
  });
});
