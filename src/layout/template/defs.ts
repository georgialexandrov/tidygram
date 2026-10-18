import type { Diagram } from '../../model/types.ts';
import type { LayerDef, TemplateKind, TemplateRules, TemplateSettings } from '../layout-file.ts';

/**
 * Defaults for the architecture templates. Layer ids are what the sidecar's
 * `assign`/`guess` maps refer to, so they are stable words; labels are what
 * the picture shows and can be renamed in layout.json.
 */

export const TEMPLATE_LABEL: Record<TemplateKind, string> = { layered: 'Layered', hexagonal: 'Hexagonal', clean: 'Clean', tiers: 'C4 tiers' };

const LAYERED: LayerDef[] = [
  { id: 'presentation', label: 'Presentation' },
  { id: 'application', label: 'Application' },
  { id: 'domain', label: 'Domain' },
  { id: 'infrastructure', label: 'Infrastructure' },
];

/** ArchiMate's own layers, top to bottom. */
const ARCHIMATE: LayerDef[] = [
  { id: 'business', label: 'Business' },
  { id: 'application', label: 'Application' },
  { id: 'technology', label: 'Technology' },
];

/** Roles, not bands: the order is the order the roles are listed in, left to right through the hexagon. */
const HEXAGONAL: LayerDef[] = [
  { id: 'driving', label: 'Driving adapters' },
  { id: 'inbound', label: 'Inbound ports' },
  { id: 'application', label: 'Application' },
  { id: 'domain', label: 'Domain' },
  { id: 'outbound', label: 'Outbound ports' },
  { id: 'driven', label: 'Driven adapters' },
];

/** Rings, innermost first (Robert C. Martin's four). */
const CLEAN: LayerDef[] = [
  { id: 'entities', label: 'Entities' },
  { id: 'usecases', label: 'Use cases' },
  { id: 'adapters', label: 'Interface adapters' },
  { id: 'frameworks', label: 'Frameworks & drivers' },
];

/** C4 tiers, top to bottom. The middle band takes the system's name when the diagram has exactly one system boundary. */
const TIERS: LayerDef[] = [
  { id: 'people', label: 'People' },
  { id: 'system', label: 'Software system' },
  { id: 'external', label: 'External systems' },
];

export const HEX_ROLES = ['driving', 'inbound', 'application', 'domain', 'outbound', 'driven'] as const;
export type HexRole = (typeof HEX_ROLES)[number];

export function defaultLayers(kind: TemplateKind, diagram?: Diagram): LayerDef[] {
  if (kind === 'hexagonal') return HEXAGONAL;
  if (kind === 'clean') return CLEAN;
  if (kind === 'tiers') {
    const systems = diagram?.containers.filter((c) => c.c4Boundary === 'system') ?? [];
    return systems.length === 1 ? TIERS.map((l) => (l.id === 'system' ? { ...l, label: systems[0]!.label } : l)) : TIERS;
  }
  return diagram?.family === 'archimate' ? ARCHIMATE : LAYERED;
}

/** The template's layers: its own list, or the default. Hexagonal keeps its fixed roles and only takes labels. */
export function layersOf(template: Pick<TemplateSettings, 'kind' | 'layers'>, diagram?: Diagram): LayerDef[] {
  const base = defaultLayers(template.kind, diagram);
  if (!template.layers) return base;
  if (template.kind !== 'hexagonal') return template.layers;
  const labels = new Map(template.layers.map((l) => [l.id, l.label]));
  return base.map((l) => ({ id: l.id, label: labels.get(l.id) ?? l.label }));
}

export function rulesOf(template: Pick<TemplateSettings, 'rules'> & { kind?: TemplateKind }, diagram?: Diagram): TemplateRules {
  // ArchiMate's serving and realization lines point up the layers by design.
  // Tiers: systems notify people and externals call back (webhooks) by design, so nothing is flagged unless asked.
  return template.rules ?? (diagram?.family === 'archimate' || template.kind === 'tiers' ? 'off' : 'relaxed');
}

/** Where an element no signal places goes (and is listed as unassigned). */
export function defaultLayer(kind: TemplateKind, layers: LayerDef[]): string {
  const prefer = kind === 'clean' ? 'usecases' : kind === 'tiers' ? 'system' : 'application';
  return layers.find((l) => l.id === prefer)?.id ?? layers[Math.floor((layers.length - 1) / 2)]!.id;
}

/** Element id → layer id for every node: the user's assignments, then guesses, then the default. Unknown layer ids fall back too. */
export function resolveAssignments(diagram: Diagram, template: TemplateSettings): Map<string, string> {
  const layers = layersOf(template, diagram);
  const known = new Set(layers.map((l) => l.id));
  const fallback = defaultLayer(template.kind, layers);
  const out = new Map<string, string>();
  for (const n of diagram.nodes) {
    const a = template.assign[n.id];
    const g = template.guess[n.id];
    out.set(n.id, a && known.has(a) ? a : g && known.has(g) ? g : fallback);
  }
  return out;
}
