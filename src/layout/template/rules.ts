import type { ArrowHead, DEdge, Diagram } from '../../model/types.ts';
import { bandsKind, type TemplateRules, type TemplateSettings } from '../layout-file.ts';
import { layersOf, resolveAssignments, rulesOf } from './defs.ts';

/**
 * Which way a line depends: `[user, used]`, or undefined when the line has no
 * direction (`A -- B`, crow's feet, note links). An arrow or a triangle points
 * at what is used (`A --> B`, `A --|> B`, `A ..|> B`); a diamond sits on the
 * whole, which uses its parts (`A *-- B`).
 */
export function dependencyOf(e: DEdge): [string, string] | undefined {
  if (e.hidden || e.kind === 'noteLink' || e.from === e.to) return undefined;
  const pointy = (h: ArrowHead) => h === 'arrow' || h === 'triangle';
  const diamond = (h: ArrowHead) => h === 'diamond' || h === 'diamondFilled';
  if (pointy(e.head) && !pointy(e.tail)) return [e.from, e.to];
  if (pointy(e.tail) && !pointy(e.head)) return [e.to, e.from];
  if (diamond(e.tail) && !diamond(e.head)) return [e.from, e.to];
  if (diamond(e.head) && !diamond(e.tail)) return [e.to, e.from];
  return undefined;
}

export interface Violation {
  edge: string;
  /** The two ends in dependency order (user, used). */
  from: string;
  to: string;
  message: string;
}

const CORE = new Set(['application', 'domain']);
const ADAPTERS = new Set(['driving', 'driven']);
const PORTS = new Set(['inbound', 'outbound']);

/**
 * Dependency lines that break the template's rule.
 *
 * - Layered (bands top to bottom): a line pointing up is a violation,
 *   except a realization (implementing a higher layer's interface is
 *   dependency inversion, not a back-reference); `strict` flags those too,
 *   and lines that skip a band.
 * - Hexagonal: an adapter using the core directly (not through a port), and
 *   the core or a port depending on an adapter; also the domain using the
 *   application around it (ports are fine: a domain service may use one);
 *   a driving adapter using an outbound port or a driven adapter using an
 *   inbound one (each side has its own ports); a driving adapter using a
 *   driven one (a controller calling a repository skips the core).
 * - Clean: a dependency pointing outward (inner ring using an outer one).
 *   `relaxed` lets the interface adapters use the frameworks and drivers
 *   ring (a repository talking to its database is what adapters are for);
 *   `strict` flags every outward line.
 */
export function findViolations(diagram: Diagram, template: TemplateSettings, assigned = resolveAssignments(diagram, template)): Violation[] {
  const rules: TemplateRules = rulesOf(template, diagram);
  if (rules === 'off') return [];
  const layers = layersOf(template, diagram);
  const index = new Map(layers.map((l, i) => [l.id, i]));
  const label = new Map(layers.map((l) => [l.id, l.label]));
  const name = (id: string) => diagram.nodes.find((n) => n.id === id)?.label.split('\n')[0] || id;
  const out: Violation[] = [];
  for (const e of diagram.edges) {
    const dep = dependencyOf(e);
    if (!dep) continue;
    const [a, b] = dep;
    const la = assigned.get(a);
    const lb = assigned.get(b);
    if (!la || !lb || la === lb) continue;
    let message: string | undefined;
    if (bandsKind(template.kind)) {
      const ia = index.get(la)!;
      const ib = index.get(lb)!;
      const inverted = e.kind === 'realization' && rules !== 'strict';
      if (ib < ia && !inverted) message = `${label.get(la)} uses ${label.get(lb)}: points up`;
      else if (rules === 'strict' && ib > ia + 1) message = `${label.get(la)} uses ${label.get(lb)}: skips ${layers.slice(ia + 1, ib).map((l) => l.label).join(', ')}`;
    } else if (template.kind === 'hexagonal') {
      if (ADAPTERS.has(la) && CORE.has(lb)) message = `${name(a)} reaches ${name(b)} without a port`;
      else if ((CORE.has(la) || PORTS.has(la)) && ADAPTERS.has(lb)) message = `${name(a)} depends on the adapter ${name(b)}`;
      else if (la === 'domain' && lb === 'application') message = `${label.get('domain')} uses ${label.get(lb)}: points outward`;
      // Each side has its own ports: driving adapters call in, the core calls out through driven ones.
      else if (la === 'driving' && lb === 'outbound') message = `${name(a)} uses the outbound port ${name(b)}: a driving adapter calls in through an inbound port`;
      else if (la === 'driven' && lb === 'inbound') message = `${name(a)} uses the inbound port ${name(b)}: a driven adapter is called by the core, it doesn't call in`;
      // Adapters chain on their own side (UI → controller, repository → database); across, they skip the core.
      else if (la === 'driving' && lb === 'driven') message = `${name(a)} uses the driven adapter ${name(b)} directly, bypassing the core`;
    } else {
      const ia = index.get(la)!;
      const ib = index.get(lb)!;
      const driver = rules !== 'strict' && ia === layers.length - 2 && ib === layers.length - 1;
      if (ib > ia && !driver) message = `${label.get(la)} uses ${label.get(lb)}: points outward`;
    }
    if (message) out.push({ edge: e.id, from: a, to: b, message });
  }
  return out;
}
