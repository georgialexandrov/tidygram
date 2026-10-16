import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { shapesFor } from '../src/layout/auto.ts';
import { countCrossings, fitToFrame } from '../src/layout/fit.ts';
import { emptyLayout, parseLayout, serializeLayout } from '../src/layout/layout-file.ts';
import { parsePuml } from '../src/model/parse.ts';
import { loadAvoid, type Avoid } from '../src/scene/avoid.ts';
import { nodeBox, overlaps } from '../src/scene/containers.ts';
import { frameRect } from '../src/scene/frame.ts';
import { inside } from '../src/scene/geometry.ts';
import { buildScene } from '../src/scene/scene.ts';
import { THEMES, themeOf } from '../src/scene/theme.ts';

const require = createRequire(import.meta.url);
const { diagram } = parsePuml(readFileSync(new URL('../fixtures/food-delivery.puml', import.meta.url), 'utf8'));
let avoid: Avoid;

beforeAll(async () => {
  avoid = await loadAvoid(join(dirname(require.resolve('libavoid-js')), 'libavoid.wasm'));
});

describe('fitToFrame', () => {
  for (const frame of [
    [16, 9],
    [1, 1],
    [210, 297],
  ] as [number, number][]) {
    it(`fits ${frame[0]}:${frame[1]} without overlaps, on a 4px grid`, async () => {
      const layout = { ...emptyLayout(), view: { theme: 'modern' } };
      const result = await fitToFrame(diagram, layout, frame, avoid);
      const target = frame[0] / frame[1];
      // Bigger text can beat an exact shape, so allow some leftover margin, but the frame must be mostly used.
      expect(Math.abs(Math.log(result.achieved / target))).toBeLessThan(Math.log(1.35));
      expect(result.fill).toBeGreaterThan(0.7);
      expect(result.layout.view).toMatchObject({ theme: 'modern', frame });
      const shapes = shapesFor(diagram, themeOf(result.layout.view));
      const boxes = diagram.nodes.map((n) => nodeBox(result.layout.nodes[n.id]!, shapes.get(n.id)!));
      for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) expect(overlaps(boxes[i]!, boxes[j]!)).toBe(false);
      for (const n of Object.values(result.layout.nodes)) expect([Math.abs(n.x % 4), Math.abs(n.y % 4)]).toEqual([0, 0]);
    }, 30_000);
  }

  it('counts only proper crossings between different lines', () => {
    expect(
      countCrossings([
        [
          [0, 5],
          [10, 5],
        ],
        [
          [5, 0],
          [5, 10],
        ],
        [
          [10, 5],
          [10, 20],
        ], // touches the first line's end: not a crossing
      ]),
    ).toBe(1);
  });
});

describe('frames and themes', () => {
  it('frameRect holds the bounds at the exact ratio', () => {
    const f = frameRect({ x: 0, y: 0, w: 100, h: 100 }, [16, 9], 0);
    expect(f.w / f.h).toBeCloseTo(16 / 9);
    expect(f.h).toBe(100);
    expect(f.x).toBeCloseTo(50 - f.w / 2);
  });

  it('round-trips view settings in layout.json', () => {
    const text = serializeLayout({ ...emptyLayout(), view: { theme: 'modern', frame: [16, 9] } });
    expect(text).toContain('"view": { "theme": "modern", "frame": [16, 9] }');
    expect(parseLayout(text).view).toEqual({ theme: 'modern', frame: [16, 9] });
  });

  it('modern use cases are pills and lines stop on their outline', async () => {
    const { layout } = await fitToFrame(diagram, { ...emptyLayout(), view: { theme: 'modern' } }, [16, 9], avoid);
    const scene = buildScene(diagram, layout, avoid);
    expect(scene.theme.name).toBe('modern');
    const login = scene.nodes.find((n) => n.node.id === 'UC_Login')!;
    expect(login.anchor.shape).toBe('pill');
    for (const e of scene.edges.filter((x) => x.edge.to === 'UC_Login')) expect(inside(login.anchor, e.points.at(-1)!)).toBe(false);
    expect(scene.edges.find((e) => e.edge.id === 'UC_Order..>UC_Pay')?.label?.text.lines).toEqual(['include']);
  }, 30_000);
});

describe('size', () => {
  it('largestScale grows elements into free space without new clashes', async () => {
    const { layout } = await fitToFrame(diagram, { ...emptyLayout(), view: { theme: 'modern' } }, [16, 9], avoid);
    const atOne = { ...layout, view: { ...layout.view, scale: 1 } };
    const { largestScale } = await import('../src/layout/scale.ts');
    const s = largestScale(diagram, atOne);
    expect(s).toBeGreaterThan(1);
    const { scaledTheme } = await import('../src/scene/theme.ts');
    const shapes = shapesFor(diagram, scaledTheme(THEMES.modern!, s));
    const boxes = diagram.nodes.map((n) => nodeBox(layout.nodes[n.id]!, shapes.get(n.id)!));
    for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) expect(overlaps(boxes[i]!, boxes[j]!)).toBe(false);
  }, 30_000);

  it('fit picks a size above 100% and records it', async () => {
    const result = await fitToFrame(diagram, { ...emptyLayout(), view: { theme: 'modern' } }, [16, 9], avoid);
    expect(result.scale).toBeGreaterThan(1);
    expect(result.layout.view?.scale).toBe(result.scale);
    expect(parseLayout(serializeLayout(result.layout)).view?.scale).toBeCloseTo(result.scale, 2);
  }, 30_000);

  it('every theme builds a scene', async () => {
    const { layout } = await fitToFrame(diagram, emptyLayout(), [16, 9], avoid);
    for (const name of Object.keys(THEMES)) {
      const scene = buildScene(diagram, { ...layout, view: { ...layout.view, theme: name } }, avoid);
      expect(scene.theme.name).toBe(name);
      expect(scene.edges).toHaveLength(diagram.edges.length);
    }
  }, 30_000);
});
