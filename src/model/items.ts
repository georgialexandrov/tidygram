import type { Diagram } from './types.ts';

/** Selectable things and the source line that declares each, for any diagram type. */
export function sourceItems(diagram: Diagram): { nodes: { id: string; line: number }[]; edges: { id: string; line: number }[] } {
  const s = diagram.special;
  if (s?.type === 'sequence') {
    return {
      nodes: s.participants.map((p) => ({ id: p.id, line: p.line })),
      edges: s.events.flatMap((e) => (e.type === 'message' ? [{ id: e.id, line: e.line }] : [])),
    };
  }
  if (s?.type === 'gantt') return { nodes: s.tasks.map((t) => ({ id: t.id, line: t.line })), edges: [] };
  if (s?.type === 'timing') return { nodes: s.signals.map((t) => ({ id: t.id, line: t.line })), edges: [] };
  return { nodes: diagram.nodes, edges: diagram.edges };
}
