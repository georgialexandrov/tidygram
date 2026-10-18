import type { Diagram } from '../../model/types.ts';
import type { Positions } from '../../scene/containers.ts';
import { nodeShape } from '../../scene/shapes.ts';
import { regionAt, type TemplateScene } from '../../scene/template.ts';
import { themeOf } from '../../scene/theme.ts';
import { chosenEnds, type LayoutFile, type NodeLayout, type Point, type TemplateKind, type TemplateSettings } from '../layout-file.ts';
import { defaultLayer } from './defs.ts';
import { guessLayers, type Guess } from './guess.ts';
import { placeTemplate, type PlaceOptions } from './place.ts';

export { TEMPLATE_LABEL, layersOf, resolveAssignments } from './defs.ts';
export { findViolations, type Violation } from './rules.ts';
export { guessLayers } from './guess.ts';

/**
 * Template operations on a layout. Each returns a new LayoutFile, so the
 * editor can push the old one for undo: applying, switching, turning off,
 * a drop into another layer are one step each.
 */

/** Fresh guesses for every element nobody assigned by hand. */
function guessMap(diagram: Diagram, template: Pick<TemplateSettings, 'kind' | 'layers' | 'assign'>): { guess: Record<string, string>; guesses: Map<string, Guess> } {
  const guesses = guessLayers(diagram, template);
  const guess: Record<string, string> = {};
  for (const [id, g] of guesses) if (!template.assign[id]) guess[id] = g.layer;
  return { guess, guesses };
}

/** Entries for ids no longer in the source survive, as everywhere in the sidecar. */
function orphans(diagram: Diagram, nodes: Record<string, NodeLayout>): Record<string, NodeLayout> {
  const ids = new Set(diagram.nodes.map((n) => n.id));
  return Object.fromEntries(Object.entries(nodes).filter(([id]) => !ids.has(id)));
}

function withPositions(diagram: Diagram, layout: LayoutFile, template: TemplateSettings, positions: Positions, pinned: (id: string) => boolean): LayoutFile {
  const nodes: Record<string, NodeLayout> = orphans(diagram, layout.nodes);
  const snap = (v: number) => Math.round(v);
  for (const n of diagram.nodes) {
    const p = positions[n.id];
    if (!p) continue;
    nodes[n.id] = pinned(n.id) ? { x: snap(p.x), y: snap(p.y), pinned: true } : { x: snap(p.x), y: snap(p.y) };
  }
  return { ...layout, template, nodes };
}

/**
 * Turns a template on (or switches to another): guesses every element's
 * layer, places everything, and keeps the free layout it replaces in
 * `template.free`. Switching kinds keeps the original free layout; the old
 * kind's assignments mean nothing to the new one and are dropped.
 */
export function applyTemplate(diagram: Diagram, layout: LayoutFile, kind: TemplateKind, options: PlaceOptions = {}): LayoutFile {
  const current = layout.template;
  const same = current?.kind === kind;
  const base: TemplateSettings = { kind, assign: same ? { ...current.assign } : {}, guess: {} };
  if (same && current.layers) base.layers = current.layers;
  if (same && current.rules) base.rules = current.rules;
  base.guess = guessMap(diagram, base).guess;
  base.free = current?.free ?? { nodes: layout.nodes, edges: layout.edges };
  const positions = placeTemplate(diagram, base, themeOf(layout.view), options);
  // Bends were drawn for another arrangement.
  return { ...withPositions(diagram, layout, base, positions, () => false), edges: chosenEnds(layout.edges) };
}

/** Turns the template off: the free layout from before comes back (new elements get placed by `ensureLayout`). */
export function removeTemplate(layout: LayoutFile): LayoutFile {
  const { template, ...rest } = layout;
  if (!template) return layout;
  return { ...rest, nodes: template.free ? { ...template.free.nodes } : layout.nodes, edges: template.free ? { ...template.free.edges } : {} };
}

/**
 * Opening a diagram with a template on: re-guess what nobody confirmed (a
 * source edit may have renamed or moved an element), and re-place only if
 * something changed: an element is new, or its guessed layer changed. The
 * rest keeps its order and rough position.
 */
export function refreshTemplate(diagram: Diagram, layout: LayoutFile): LayoutFile {
  const template = layout.template!;
  const { guess } = guessMap(diagram, template);
  const changed = diagram.nodes.filter((n) => !layout.nodes[n.id] || (!template.assign[n.id] && template.guess[n.id] !== guess[n.id])).map((n) => n.id);
  const next: TemplateSettings = { ...template, guess };
  if (!changed.length) {
    const same = Object.keys(guess).length === Object.keys(template.guess).length && Object.entries(guess).every(([id, l]) => template.guess[id] === l);
    return same ? layout : { ...layout, template: next };
  }
  const moved = new Set(changed);
  const hints: Positions = Object.fromEntries(diagram.nodes.filter((n) => layout.nodes[n.id] && !moved.has(n.id)).map((n) => [n.id, layout.nodes[n.id]!]));
  const positions = placeTemplate(diagram, next, themeOf(layout.view), { hints });
  return withPositions(diagram, layout, next, positions, (id) => layout.nodes[id]?.pinned === true);
}

/** Auto layout with a template: everything re-placed by the template; elements placed by hand keep their spot as a hint. */
export function relayoutTemplate(diagram: Diagram, layout: LayoutFile, options: PlaceOptions = {}): LayoutFile {
  const template = { ...layout.template!, guess: guessMap(diagram, layout.template!).guess };
  const hints: Positions = Object.fromEntries(diagram.nodes.filter((n) => layout.nodes[n.id]?.pinned).map((n) => [n.id, layout.nodes[n.id]!]));
  const positions = placeTemplate(diagram, template, themeOf(layout.view), { ...options, hints: options.hints ?? hints });
  return { ...withPositions(diagram, layout, template, positions, (id) => layout.nodes[id]?.pinned === true), edges: chosenEnds(layout.edges) };
}

/**
 * Re-places everything in its current order: what a size change (theme,
 * Size, Text, Icons) needs so the gaps, hexagon and rings fit the new sizes.
 * Pins stay.
 */
export function settleTemplate(diagram: Diagram, layout: LayoutFile, options: PlaceOptions = {}): LayoutFile {
  const hints: Positions = Object.fromEntries(diagram.nodes.filter((n) => layout.nodes[n.id]).map((n) => [n.id, layout.nodes[n.id]!]));
  const positions = placeTemplate(diagram, layout.template!, themeOf(layout.view), { ...options, hints });
  return { ...withPositions(diagram, layout, layout.template!, positions, (id) => layout.nodes[id]?.pinned === true), edges: chosenEnds(layout.edges) };
}

/**
 * Elements dropped into another layer: assigned there by hand (pinned, never
 * re-guessed) and the template re-places around them, everything else
 * staying in its order. `layout` already has the dropped positions.
 */
export function reassign(diagram: Diagram, layout: LayoutFile, ids: string[], layer: string): LayoutFile {
  const template = layout.template!;
  const assign = { ...template.assign };
  const guess = { ...template.guess };
  for (const id of ids) {
    assign[id] = layer;
    delete guess[id];
  }
  const next: TemplateSettings = { ...template, assign, guess };
  const hints: Positions = Object.fromEntries(diagram.nodes.filter((n) => layout.nodes[n.id]).map((n) => [n.id, layout.nodes[n.id]!]));
  const positions = placeTemplate(diagram, next, themeOf(layout.view), { hints });
  const dropped = new Set(ids);
  return withPositions(diagram, layout, next, positions, (id) => dropped.has(id) || layout.nodes[id]?.pinned === true);
}

/**
 * A finished drag with a template on. If the primary element now lies in
 * another layer's band, ring or zone, every dragged element moves there
 * (`reassign`); otherwise undefined: a move within the layer is just a move.
 */
export function dropIntoTemplate(diagram: Diagram, layout: LayoutFile, scene: TemplateScene, ids: string[], primary: string): LayoutFile | undefined {
  const p = layout.nodes[primary];
  const node = diagram.nodes.find((n) => n.id === primary);
  if (!p || !node || !layout.template) return undefined;
  const shape = nodeShape(node, themeOf(layout.view));
  // The anchor is what sits on a hexagon's outline (a port's lollipop), and the thing the pointer holds.
  const at: Point = [p.x + shape.anchor.dx, p.y + shape.anchor.dy];
  const band = layout.template.kind === 'hexagonal' ? Math.max(12, Math.min(shape.anchor.w, shape.anchor.h) * 0.75) : 0;
  const region = regionAt(scene, at, band);
  if (!region || region === scene.assigned.get(primary)) return undefined;
  return reassign(diagram, layout, ids, region);
}

/** Elements no signal placed: they sit in the default layer until someone drags them. */
export function unassigned(diagram: Diagram, template: TemplateSettings): string[] {
  const guesses = guessLayers(diagram, template);
  return diagram.nodes.filter((n) => !template.assign[n.id] && guesses.get(n.id)?.source === 'default').map((n) => n.id);
}

export { defaultLayer, placeTemplate };
