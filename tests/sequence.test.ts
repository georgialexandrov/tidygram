import { describe, expect, it } from 'vitest';
import { emptyLayout } from '../src/layout/layout-file.ts';
import { parseDiagram } from '../src/model/diagram.ts';
import type { SequenceModel } from '../src/model/types.ts';
import { buildSequenceScene } from '../src/scene/sequence.ts';

const scene = (source: string, name: string) => {
  const model = parseDiagram(source, name).diagram.special as SequenceModel;
  return { model, scene: buildSequenceScene(model, emptyLayout()) };
};

describe('notes and refs over several participants', () => {
  const PUML = [
    '@startuml',
    'participant A',
    'participant B',
    'participant C',
    'A -> B ++ : call',
    'note over A, C : spans three',
    'hnote over B,C : spans two',
    'note over A : one',
    'note across : everything',
    'ref over A, C : shared flow',
    '@enduml',
  ].join('\n');

  it('PlantUML: from the first to the last named lifeline, padded past activation bars', () => {
    const { scene: s } = scene(PUML, 'n.puml');
    const { A, B, C } = s.columns as Record<string, number>;
    const [ac, bc, a, across] = s.notes;
    expect(ac!.box.x).toBeLessThan(A!);
    expect(ac!.box.x + ac!.box.w).toBeGreaterThan(C!);
    // B has an open activation bar: the note clears it on the left as well as the lifeline.
    expect(bc!.box.x).toBeLessThan(B! - 22);
    expect(bc!.box.x + bc!.box.w).toBeGreaterThan(C!);
    expect(a!.box.x + a!.box.w / 2).toBeCloseTo(A!, 0);
    expect(across!.box.x).toBeLessThan(A! - 20);
    expect(across!.box.x + across!.box.w).toBeGreaterThan(C! + 20);
    const ref = s.refs[0]!;
    expect(ref.box.x).toBeLessThan(A!);
    expect(ref.box.x + ref.box.w).toBeGreaterThan(C!);
  });

  it('Mermaid: Note over A,C spans both', () => {
    const { scene: s } = scene(['sequenceDiagram', '  participant A', '  participant B', '  participant C', '  A->>C: x', '  Note over C,A: hello'].join('\n'), 'n.mmd');
    const { A, C } = s.columns as Record<string, number>;
    expect(s.notes[0]!.box.x).toBeLessThan(A!);
    expect(s.notes[0]!.box.x + s.notes[0]!.box.w).toBeGreaterThan(C!);
  });
});
