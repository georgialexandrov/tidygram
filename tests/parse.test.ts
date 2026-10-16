import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parsePuml } from '../src/model/parse.ts';

const fixture = readFileSync(new URL('../fixtures/food-delivery.puml', import.meta.url), 'utf8');

describe('parsePuml', () => {
  it('reads the whole fixture without warnings', () => {
    const { diagram, warnings } = parsePuml(fixture);
    expect(warnings).toEqual([]);
    expect(diagram.direction).toBe('LR');
    expect(diagram.nodes.filter((n) => n.kind === 'actor')).toHaveLength(10);
    expect(diagram.nodes.filter((n) => n.kind === 'usecase')).toHaveLength(24);
    expect(diagram.nodes.filter((n) => n.kind === 'note')).toHaveLength(2);
    expect(diagram.containers.map((c) => c.id)).toEqual(['Platform', 'Ordering', 'Accounts', 'Fulfilment', 'BackOffice']);
    expect(diagram.edges).toHaveLength(45);
  });

  it('nests containers and their use cases', () => {
    const { diagram } = parsePuml(fixture);
    expect(diagram.containers.find((c) => c.id === 'Ordering')?.parent).toBe('Platform');
    expect(diagram.nodes.find((n) => n.id === 'UC_Login')).toMatchObject({ label: 'Log In', parent: 'Accounts' });
    expect(diagram.nodes.find((n) => n.id === 'Customer')?.parent).toBeUndefined();
  });

  it('keys edges by alias and arrow, and classifies them', () => {
    const { diagram } = parsePuml(fixture);
    const byId = new Map(diagram.edges.map((e) => [e.id, e]));
    expect(byId.get('Guest--|>Customer')).toMatchObject({ kind: 'generalization', head: 'triangle' });
    expect(byId.get('UC_Order..>UC_Pay')).toMatchObject({ kind: 'dependency', dashed: true, label: '«include»' });
    expect(byId.get('Member-->UC_Login')).toMatchObject({ kind: 'association', head: 'arrow' });
    expect(byId.get('N_Refund..UC_Refund')).toMatchObject({ kind: 'noteLink' });
    expect(byId.get('note:UC_Assign..UC_Assign')).toMatchObject({ kind: 'noteLink' });
  });

  it('reads stereotypes and attached notes', () => {
    const { diagram } = parsePuml(fixture);
    expect(diagram.nodes.find((n) => n.id === 'PSP')).toMatchObject({ label: 'Payment Gateway', stereotype: 'system' });
    expect(diagram.nodes.find((n) => n.id === 'note:UC_Assign')).toMatchObject({
      attachedTo: { id: 'UC_Assign', side: 'right' },
      parent: 'Fulfilment',
      label: 'Nearest available courier,\nre-assigned after 90 s\nwithout acceptance.',
    });
  });

  it('normalises reversed arrows and numbers duplicates', () => {
    const { diagram } = parsePuml(`
      actor A
      (Do it) as UC
      UC <-- A
      A --> UC
      A <|-- B
    `);
    expect(diagram.edges.map((e) => e.id)).toEqual(['A-->UC', 'A-->UC#2', 'B--|>A']);
  });

  it('creates elements implicitly, like PlantUML', () => {
    const { diagram, warnings } = parsePuml(`
      :Shopper: --> (Buy things)
      Clerk -left-> (Buy things)
      (Buy things) .> (Pay) : <<include>>
    `);
    expect(warnings).toEqual([]);
    expect(diagram.nodes.map((n) => [n.id, n.kind])).toEqual([
      ['Shopper', 'actor'],
      ['Buy things', 'usecase'],
      ['Clerk', 'actor'],
      ['Pay', 'usecase'],
    ]);
    expect(diagram.edges.map((e) => e.id)).toEqual(['Shopper-->Buy things', 'Clerk-->Buy things', 'Buy things..>Pay']);
  });

  it('reports unsupported lines instead of failing', () => {
    const { diagram, warnings } = parsePuml('actor A\nsomething weird here\n');
    expect(diagram.nodes).toHaveLength(1);
    expect(warnings).toEqual([{ line: 2, text: 'something weird here', message: 'Unsupported line, ignored' }]);
  });

  it('skips skinparam blocks and comments', () => {
    const { warnings } = parsePuml("skinparam actor {\n  BorderColor red\n}\n' comment\n/' block\ncomment '/\nactor A\n");
    expect(warnings).toEqual([]);
  });
});
