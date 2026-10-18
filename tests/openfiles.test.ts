import { describe, expect, it } from 'vitest';
import { kindOf, looksLikeDiagram, openedKey, pairFiles, stemOf, withOpened } from '../src/editor/openFiles.ts';

const f = (name: string) => ({ name });

describe('open files', () => {
  it('classifies names', () => {
    for (const n of ['a.puml', 'a.plantuml', 'a.pu', 'a.mmd', 'a.mermaid', 'a.drawio', 'a.xml', 'a.drawio.xml', 'A.PUML']) expect(kindOf(n)).toBe('diagram');
    expect(kindOf('a.layout.json')).toBe('layout');
    expect(kindOf('a.json')).toBe('other');
    expect(kindOf('a.png')).toBe('other');
  });

  it('only takes plain .xml that is draw.io', () => {
    expect(looksLikeDiagram('pom.xml', '<project/>')).toBe(false);
    expect(looksLikeDiagram('d.xml', '<?xml version="1.0"?><mxfile host="x"></mxfile>')).toBe(true);
    expect(looksLikeDiagram('d.drawio', '<whatever/>')).toBe(true);
    expect(looksLikeDiagram('d.png', '')).toBe(false);
  });

  it('stems and keys', () => {
    expect(stemOf('dir/x.layout.json')).toBe('x');
    expect(stemOf('x.drawio.xml')).toBe('x');
    expect(openedKey('C:\\tmp\\x.puml')).toBe('opened/x.puml');
  });

  it('pairs a diagram with its sidecar', () => {
    const r = pairFiles([f('x.layout.json'), f('x.puml'), f('y.mmd'), f('z.layout.json'), f('notes.txt')]);
    expect(r.pairs.map((p) => [p.diagram.name, p.layout?.name])).toEqual([['x.puml', 'x.layout.json'], ['y.mmd', undefined]]);
    expect(r.strayLayouts.map((x) => x.name)).toEqual(['z.layout.json']);
    expect(r.rejected.map((x) => x.name)).toEqual(['notes.txt']);
  });

  it('shares one sidecar between same-stem diagrams, ignoring case', () => {
    const r = pairFiles([f('X.puml'), f('x.mmd'), f('x.layout.json')]);
    expect(r.pairs.map((p) => p.layout?.name)).toEqual(['x.layout.json', 'x.layout.json']);
    expect(r.strayLayouts).toEqual([]);
  });

  it('lists opened files after the others, once', () => {
    expect(withOpened(['a.puml', 'opened/b.puml'], ['opened/b.puml', 'opened/a.puml'])).toEqual(['a.puml', 'opened/b.puml', 'opened/a.puml']);
  });
});
