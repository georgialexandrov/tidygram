import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ArrowHead, DNode, NodeKind } from '../src/model/types.ts';
import { DiagramContent } from '../src/render/DiagramSvg.tsx';
import type { Scene, SceneEdge, SceneNode } from '../src/scene/scene.ts';
import { nodeShape, parseMember } from '../src/scene/shapes.ts';
import { contrast, mix, THEME_ALIASES, THEMES, themeFor, themeOf } from '../src/scene/theme.ts';

/** WCAG AA for normal-size text. Diagram text is small (10–13 px), so nothing gets the large-text discount. */
const AA = 4.5;

describe('theme contrast (WCAG AA for every text/background pair a theme draws)', () => {
  for (const theme of Object.values(THEMES)) {
    it(theme.name, () => {
      const c = theme.colors;
      const bg = (fill: string) => (fill === 'none' ? c.background : fill);
      const pairs: [string, string, string][] = [
        ['text on background', c.text, c.background],
        ['muted on background', c.muted, c.background],
        ['actor label on background', c.actorText, c.background],
        ['text on boxes', c.text, c.shapeFill],
        ['muted (types, captions) on boxes', c.muted, c.shapeFill],
        ['container title', c.title, bg(c.containerFill)],
        ['nested container title', c.title, bg(c.nestedFill)],
        ['note text', c.noteText, c.noteFill],
        ['line label', c.labelText, c.labelFill],
        ['dependency label', c.dependencyLabel, c.labelFill],
        ['text on surface (class headers, decisions)', c.text, c.surface],
        ['title on surface (fragment tabs, Gantt sections)', c.title, c.surface],
        ['numbers on the accent (sequence bubbles)', c.onAccent, c.accent],
        ['C4 person name', c.c4.personText, c.c4.personFill],
        ['C4 person caption', c.c4.personMuted, c.c4.personFill],
        ['layer title on every layer', c.layerTitle, c.layerFills[0]!],
        ...c.layerFills.map((f, i): [string, string, string] => [`layer title on layer ${i}`, c.layerTitle, f]),
        ...Object.entries(c.archimate).map(([layer, fill]): [string, string, string] => [`text on ArchiMate ${layer}`, c.text, fill]),
      ];
      // PlantUML's C4 draws white text on its blues; the other themes put dark text on a tint.
      if (theme.plantuml) {
        pairs.push(['C4 internal (white on blue)', c.c4.personText, c.c4.internalFill], ['C4 external (white on grey)', c.c4.personText, c.c4.externalFill], ['C4 internal caption', c.c4.personMuted, c.c4.internalFill]);
      } else {
        pairs.push(['C4 internal name', c.text, c.c4.internalFill], ['C4 internal caption', c.muted, c.c4.internalFill], ['C4 external name', c.text, c.c4.externalFill], ['C4 external caption', c.muted, c.c4.externalFill]);
        pairs.push(['JSON scalars (accent) on boxes', c.accent, c.shapeFill]);
      }
      const failing = pairs.filter(([, fg, back]) => contrast(fg, back) < AA).map(([what, fg, back]) => `${what}: ${fg} on ${back} = ${contrast(fg, back).toFixed(2)}`);
      expect(failing).toEqual([]);
    });
  }

  it('violations stand out from ordinary lines (3:1 against the background)', () => {
    for (const theme of Object.values(THEMES)) expect(contrast(theme.colors.warning, theme.colors.background), theme.name).toBeGreaterThanOrEqual(3);
  });

  it('measures contrast the WCAG way', () => {
    expect(contrast('#000000', '#FFFFFF')).toBeCloseTo(21, 5);
    expect(contrast('#777777', '#FFFFFF')).toBeCloseTo(4.48, 2);
    expect(mix('#000000', '#FFFFFF', 0.5)).toBe('#808080');
  });
});

describe('theme names', () => {
  it('defaults to modern, reads retired names as their nearest survivor', () => {
    expect(themeFor(undefined).name).toBe('modern');
    for (const [old, now] of Object.entries(THEME_ALIASES)) expect(themeOf({ theme: old }).name).toBe(now);
    expect(themeFor('no-such-theme').name).toBe('modern');
    expect(themeFor('classic').name).toBe('classic');
  });
});

const KINDS: NodeKind[] = [
  'actor', 'usecase', 'component', 'interface', 'node', 'database', 'cloud', 'queue', 'artifact', 'folder', 'frame', 'file', 'card', 'rectangle', 'hexagon', 'storage', 'stack', 'collections',
  'boundary', 'control', 'entity', 'person', 'agent', 'label', 'circle', 'process', 'class', 'state', 'initial', 'final', 'choice', 'fork', 'history', 'action', 'decision', 'topic', 'system', 'container',
  'attribute', 'relationship', 'network', 'note',
];
const HEADS: ArrowHead[] = ['none', 'arrow', 'triangle', 'diamond', 'diamondFilled', 'circle', 'circlePlus', 'cross', 'square', 'dot', 'crowZeroOne', 'crowOne', 'crowZeroMany', 'crowOneMany', 'crowMany'];

/** A hand-built scene: one node per kind (with the extras that change how it's drawn) and one line per head. */
function everything(themeName: string): Scene {
  const theme = themeOf({ theme: themeName });
  const extras: Partial<Record<NodeKind, Partial<DNode>>> = {
    class: { classKind: 'entity', compartments: [['* id : bigint <<PK>>'], ['+total() : Money', '-name : String', '{static} #of(x) : T', 'owner_id : bigint FK — note']] },
    state: { description: ['entry / start'] },
    system: { technology: 'Go', description: ['Does things'], external: true },
    container: { technology: 'NestJS', description: ['API'] },
    person: { description: ['A user'] },
    rectangle: { stereotype: 'business actor' },
    network: { description: ['10.0.0.0/24'] },
    attribute: { key: true, double: true, derived: true },
    relationship: { double: true },
    topic: { stereotype: 'boxless' },
  };
  const nodes: SceneNode[] = KINDS.map((kind, i) => {
    const node: DNode = { id: `n${i}`, kind, label: kind === 'circle' ? '' : `${kind} label`, line: i, ...extras[kind] };
    const shape = nodeShape(node, theme);
    const x = (i % 8) * 220;
    const y = Math.floor(i / 8) * 180;
    return { node, shape, box: { x, y, w: shape.w, h: shape.h }, anchor: { ...shape.anchor, cx: x + shape.w / 2 + shape.anchor.dx, cy: y + shape.h / 2 + shape.anchor.dy }, pinned: false };
  });
  const edges: SceneEdge[] = HEADS.map((head, i) => ({
    edge: { id: `e${i}`, from: 'n0', to: 'n1', kind: 'association', dashed: i % 2 === 1, head, tail: HEADS[(i + 3) % HEADS.length]!, hidden: false, line: i, label: 'uses\n[HTTPS]', fromLabel: '1', toLabel: '0..*' },
    kind: 'association',
    points: [[0, 1200 + i * 30], [300, 1200 + i * 30], [300, 1300 + i * 30]],
    head,
    tail: HEADS[(i + 3) % HEADS.length]!,
    dashed: i % 2 === 1,
    via: [],
    label: { text: { lines: ['uses', '[HTTPS]'], width: 40, height: 28, size: theme.size.edge }, x: 150, y: 1200 + i * 30 },
  }));
  return { kind: 'graph', theme, nodes, containers: [{ id: 'c', kind: 'boundary', label: 'Boundary', box: { x: -20, y: -20, w: 2000, h: 1600 }, depth: 0 }], edges, bounds: { x: -20, y: -20, w: 2000, h: 1800 } };
}

describe('every element kind and line end renders in every theme', () => {
  for (const name of Object.keys(THEMES)) {
    it(name, () => {
      const svg = renderToStaticMarkup(createElement('svg', null, createElement(DiagramContent, { scene: everything(name) })));
      expect(svg).not.toContain('NaN');
      expect(svg).not.toContain('undefined');
      for (let i = 0; i < KINDS.length; i++) if (KINDS[i] !== 'label') expect(svg, KINDS[i]).toContain(`data-id="n${i}"`);
      for (let i = 0; i < HEADS.length; i++) expect(svg).toContain(`data-edge="e${i}"`);
    });
  }
});

describe('class members', () => {
  it('splits visibility, keys, name and type the way each source writes them', () => {
    expect(parseMember('-id : UUID')).toEqual({ vis: '-', method: false, name: 'id', type: 'UUID' });
    expect(parseMember('+total(a : Int) : Money')).toEqual({ vis: '+', method: true, name: 'total(a : Int)', type: 'Money' });
    expect(parseMember('{static} +of(x) : Money')).toMatchObject({ isStatic: true, vis: '+', name: 'of(x)', type: 'Money' });
    expect(parseMember('* id : bigint <<PK>>')).toMatchObject({ required: true, key: 'PK', name: 'id', type: 'bigint' });
    expect(parseMember('author_id : bigint FK — the writer')).toMatchObject({ key: 'FK', name: 'author_id', type: 'bigint — the writer' });
    expect(parseMember('PENDING')).toEqual({ method: false, name: 'PENDING' });
    expect(parseMember('total: 48.5', true)).toEqual({ method: false, name: 'total', type: '48.5' });
    expect(parseMember('List<Map<K, V>> : items')).toMatchObject({ name: 'List<Map<K, V>>', type: 'items' });
  });

  it('aligns members in columns wide enough for the longest name and type', () => {
    const theme = themeOf({ theme: 'modern' });
    const shape = nodeShape({ id: 'A', kind: 'class', label: 'A', line: 1, compartments: [['-id : UUID', '-placedAt : Instant']] }, theme);
    const m = shape.members!;
    expect(m.rows[0]!.map((r) => r.name)).toEqual(['id', 'placedAt']);
    expect(shape.w).toBeGreaterThanOrEqual(m.marker + m.name + m.gap + m.type + 24);
  });
});
