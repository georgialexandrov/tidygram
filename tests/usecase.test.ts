import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { ensureLayout, shapesFor } from '../src/layout/auto.ts';
import { emptyLayout } from '../src/layout/layout-file.ts';
import { actorSides, isUseCaseDiagram, useCaseLayouts } from '../src/layout/usecase.ts';
import { parseDiagram } from '../src/model/diagram.ts';
import { loadAvoid, type Avoid } from '../src/scene/avoid.ts';
import { pathLength } from '../src/scene/geometry.ts';
import { countCrossings, measureQuality } from '../src/scene/quality.ts';
import { buildScene } from '../src/scene/scene.ts';
import { containerPad } from '../src/scene/shapes.ts';
import { themeOf } from '../src/scene/theme.ts';

const require = createRequire(import.meta.url);
let avoid: Avoid;
beforeAll(async () => {
  avoid = await loadAvoid(join(dirname(require.resolve('libavoid-js')), 'libavoid.wasm'));
});

const root = new URL('../fixtures/', import.meta.url).pathname;
const food = () => parseDiagram(readFileSync(join(root, 'food-delivery.puml'), 'utf8'), 'food-delivery.puml').diagram;

const ATM = `@startuml
left to right direction
actor Customer
actor "Bank Clerk" as Clerk
actor "Bank System" as Bank <<system>>
rectangle ATM {
  usecase "Withdraw Cash" as W
  usecase "Check Balance" as B
  usecase "Authenticate" as A
  usecase "Refill Cash" as R
}
Customer --> W
Customer --> B
Clerk --> R
W ..> A : <<include>>
B ..> A : <<include>>
A --> Bank
note right of R : weekly
@enduml`;

describe('use-case layout', () => {
  it('applies to use-case diagrams only', () => {
    expect(isUseCaseDiagram(food())).toBe(true);
    expect(isUseCaseDiagram(parseDiagram(ATM, 'atm.puml').diagram)).toBe(true);
    for (const f of ['component.puml', 'deployment.puml', 'class.puml', 'architecture/layered-web-shop.puml']) {
      expect(isUseCaseDiagram(parseDiagram(readFileSync(join(root, f), 'utf8'), f).diagram), f).toBe(false);
    }
  });

  it('puts initiating actors left and called systems right (arrow direction, role words, families)', () => {
    const sides = actorSides(food());
    expect([...sides].filter(([, s]) => s === 'right').map(([id]) => id).sort()).toEqual(['Maps', 'PSP']);
    const atm = actorSides(parseDiagram(ATM, 'atm.puml').diagram);
    // "Bank Clerk" is a person: only the label's head noun or a stereotype marks a system.
    expect(Object.fromEntries(atm)).toEqual({ Customer: 'left', Clerk: 'left', Bank: 'right' });
  });

  it('food delivery: actors on the edges, families stacked, includes short, few crossings, window proportions', async () => {
    const diagram = food();
    const layout = await ensureLayout(diagram, emptyLayout(), 'auto');
    const scene = buildScene(diagram, layout, avoid);
    const at = (id: string) => layout.nodes[id]!;
    const platform = scene.containers.find((c) => c.id === 'Platform')!.box;
    const sides = actorSides(diagram);
    for (const [id, side] of sides) {
      if (side === 'left') expect(at(id).x, id).toBeLessThan(platform.x);
      else expect(at(id).x, id).toBeGreaterThan(platform.x + platform.w);
    }
    // Customer with its two specialisations: one column, one stack (no other actor in between).
    const family = ['Guest', 'Customer', 'Member'].map((id) => at(id));
    expect(new Set(family.map((p) => Math.round(p.x))).size).toBe(1);
    const ys = family.map((p) => p.y).sort((a, b) => a - b);
    expect(ys[2]! - ys[0]!).toBeLessThan(300);
    const others = [...sides.keys()].filter((id) => !['Guest', 'Customer', 'Member'].includes(id) && sides.get(id) === 'left');
    for (const id of others) expect(at(id).y > ys[0]! && at(id).y < ys[2]!, id).toBe(false);
    // Within a package, an include/extend joins neighbours.
    for (const e of diagram.edges.filter((x) => x.kind === 'dependency')) {
      const [a, b] = [diagram.nodes.find((n) => n.id === e.from)!, diagram.nodes.find((n) => n.id === e.to)!];
      if (a.parent !== b.parent) continue;
      expect(Math.hypot(at(a.id).x - at(b.id).x, at(a.id).y - at(b.id).y), e.id).toBeLessThan(320);
    }
    const q = measureQuality(scene, diagram);
    // ELK before this layout: 45 crossings, 3.39:1, longest line 0.88 of the width, a web of long lines.
    // 44 until actors were levelled with their figure (not the centre of figure + name) and the refund note
    // got a lane beside the platform (2026-10-18): 33.
    expect(countCrossings(scene.edges.map((e) => e.points))).toBeLessThanOrEqual(38);
    expect(q.aspect).toBeGreaterThan(1.3);
    expect(q.aspect).toBeLessThan(2.5);
    // Now ~44 crossings, 1.4:1, longest 0.82 (Track Order → Calculate Route, an include between packages).
    expect(Math.max(...scene.edges.map((e) => pathLength(e.points))) / scene.bounds.w).toBeLessThan(0.85);
    expect(q.containerCrossings + q.nodeCrossings + q.titleCrossings).toBe(0);
  }, 30_000);

  it('food delivery: a top-level note on a packaged use case sits outside the boundary, next to it', async () => {
    const diagram = food();
    const layout = await ensureLayout(diagram, emptyLayout(), 'auto');
    const scene = buildScene(diagram, layout, avoid);
    const platform = scene.containers.find((c) => c.id === 'Platform')!.box;
    const note = scene.nodes.find((n) => n.node.id === 'N_Refund')!.box;
    const refund = scene.nodes.find((n) => n.node.id === 'UC_Refund')!.box;
    const outside = note.x >= platform.x + platform.w || note.x + note.w <= platform.x || note.y >= platform.y + platform.h || note.y + note.h <= platform.y;
    expect(outside).toBe(true);
    // Was below the platform, a ~600 px dotted line round the Fulfilment package.
    const gapX = Math.max(0, note.x - (refund.x + refund.w), refund.x - (note.x + note.w));
    const gapY = Math.max(0, note.y - (refund.y + refund.h), refund.y - (note.y + note.h));
    expect(gapX + gapY).toBeLessThan(380);
    const link = scene.edges.find((e) => e.edge.id === 'N_Refund..UC_Refund')!;
    expect(pathLength(link.points)).toBeLessThan(500);
  }, 30_000);

  it('a note rides beside what it annotates', () => {
    const { diagram } = parseDiagram(ATM, 'atm.puml');
    const theme = themeOf(undefined);
    const shapes = shapesFor(diagram, theme);
    for (const { positions } of useCaseLayouts(diagram, shapes, theme, containerPad(theme))) {
      const note = diagram.nodes.find((n) => n.kind === 'note')!;
      const [p, r] = [positions[note.id]!, positions.R!];
      expect(Math.abs(p.y - r.y)).toBeLessThan(1);
      expect(p.x).toBeGreaterThan(r.x);
    }
  });

  it('a stored layout wins over the use-case layout', async () => {
    const diagram = food();
    const auto = await ensureLayout(diagram, emptyLayout(), 'auto');
    const moved = { ...auto, nodes: { ...auto.nodes, PSP: { x: -999, y: -999 } } };
    const filled = await ensureLayout(diagram, moved, 'fill');
    expect(filled.nodes.PSP).toEqual({ x: -999, y: -999 });
  }, 30_000);
});
