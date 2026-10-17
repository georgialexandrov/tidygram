import type { DNode, Diagram } from '../../model/types.ts';
import type { LayerDef, TemplateKind, TemplateSettings } from '../layout-file.ts';
import { defaultLayer, layersOf } from './defs.ts';
import { dependencyOf } from './rules.ts';

/**
 * Guessing which layer an element belongs to. The source never says, so the
 * guess reads what it does say, strongest signal first:
 *
 * 1. stereotype (`<<port>>`, `<<domain>>`, ArchiMate `business actor`), first
 *    against the template's own layer names, then as a role;
 * 2. strong kinds: actors/people, databases, queues, storage, interfaces;
 * 3. enclosing containers' names (`package domain`, `adapters.in`,
 *    `infrastructure`), again layer names first;
 * 4. the element's own name, id and C4 technology (`OrderRepository`,
 *    `REST Controller`, `[PostgreSQL]`);
 * 5. weak kinds: clouds and external systems, C4 systems/containers;
 * 6. graph position: an element between known ones goes between them
 *    (sources to the driving side, sinks to the driven side in a hexagon);
 * 7. otherwise the default layer, and it is reported as unassigned.
 *
 * Every signal is first turned into a template-neutral role (ui, api, port,
 * application, domain, store, ...), which each template maps to its layers.
 */

export type Role =
  | 'actor'
  | 'ui'
  | 'api'
  | 'adapter-in'
  | 'port-in'
  | 'port-out'
  | 'port'
  | 'application'
  | 'domain'
  | 'adapter-out'
  | 'adapter'
  | 'store'
  | 'external'
  | 'infra'
  | 'business'
  | 'archimate-application'
  | 'technology';

export type GuessSource = 'stereotype' | 'kind' | 'container' | 'name' | 'graph' | 'default';

export interface Guess {
  layer: string;
  source: GuessSource;
}

/** `RestController`, `adapters.in`, `order_repo` → `rest controller`, `adapters in`, `order repo`. */
export function words(text: string): string {
  return text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .replace(/[^a-z0-9&]+/g, ' ')
    .trim();
}

const compact = (s: string) => words(s).replace(/[^a-z0-9]/g, '');

/** A layer whose id or label appears in `text` as whole words (`package "Domain"` → domain, `usecases` → Use cases). */
function layerNamed(text: string, layers: LayerDef[]): string | undefined {
  const w = words(text).split(' ').filter(Boolean);
  const grams = new Set<string>();
  for (let n = 1; n <= 3; n++) for (let i = 0; i + n <= w.length; i++) grams.add(w.slice(i, i + n).join(''));
  return layers.find((l) => grams.has(compact(l.label)) || grams.has(compact(l.id)))?.id;
}

const PORT_IN = /\b(use ?cases?|usecases?|commands?|query|queries|input|inbound|in|driving|primary|api|facade)\b/;
const PORT_OUT = /\b(repository|repositories|repo|gateway|publisher|sender|notifier|store|client|output|outbound|out|driven|secondary|provider|spi|dao|loader|saver)\b/;

function portSide(text: string): Role {
  if (PORT_OUT.test(text)) return 'port-out';
  if (PORT_IN.test(text)) return 'port-in';
  return 'port';
}

/** Explicit stereotypes: `<<port>>`, `<<adapter>>`, `<<entity>>`, ArchiMate element types. */
function stereotypeRole(node: DNode, diagram: Diagram, name: string): Role | undefined {
  const s = node.stereotype ? words(node.stereotype) : '';
  if (!s) return undefined;
  if (diagram.family === 'archimate') {
    if (/^business\b/.test(s)) return 'business';
    if (/^application\b/.test(s)) return 'archimate-application';
    if (/^(technology|physical|equipment|device|node|system software|communication|artifact)\b/.test(s)) return 'technology';
    return undefined;
  }
  if (/\bport\b/.test(s)) return portSide(`${s} ${name}`);
  if (/\binterface\b/.test(s)) return portSide(name);
  if (/\b(driving|primary|inbound|in) adapter\b/.test(s)) return 'adapter-in';
  if (/\b(driven|secondary|outbound|out) adapter\b/.test(s)) return 'adapter-out';
  if (/\badapter\b/.test(s)) return 'adapter';
  if (/\b(entity|aggregate|aggregate root|value object|value|domain|domain service|domain event)\b/.test(s)) return 'domain';
  if (/\b(use ?case|service|application|interactor|handler)\b/.test(s)) return 'application';
  if (/\b(controller|api|rest|endpoint)\b/.test(s)) return 'api';
  if (/\b(ui|view|page|screen|frontend)\b/.test(s)) return 'ui';
  if (/\b(external|third party|saas)\b/.test(s)) return 'external';
  if (/\b(repository|dao)\b/.test(s)) return node.classKind === 'interface' ? 'port-out' : 'adapter-out';
  if (/\b(database|db|queue|topic|cache|storage)\b/.test(s)) return 'store';
  if (/\b(infrastructure|infra|framework|driver)\b/.test(s)) return 'infra';
  return undefined;
}

/** Container names that name a layer or a side (`domain`, `adapters.in`, `persistence`). Service names don't count. */
function containerRole(text: string): Role | undefined {
  if (/\b(adapters? (in|inbound|driving|primary)|(in|inbound|driving|primary) adapters?|entry ?points?|delivery)\b/.test(text)) return 'adapter-in';
  if (/\b(adapters? (out|outbound|driven|secondary)|(out|outbound|driven|secondary) adapters?)\b/.test(text)) return 'adapter-out';
  if (/\b(domain|model|models|core|entities|entity|business logic)\b/.test(text)) return 'domain';
  if (/\b(application|app layer|use ?cases?|usecases|services|service layer|interactors?)\b/.test(text)) return 'application';
  if (/\b(presentation|ui|web|frontend|front end|clients?|views?)\b/.test(text)) return 'ui';
  if (/\b(api|apis|controllers?|interfaces|endpoints?)\b/.test(text)) return 'api';
  if (/\b(infrastructure|infra|persistence|data|database|storage|gateways|repositories|integrations?)\b/.test(text)) return 'adapter-out';
  if (/\bports?\b/.test(text)) return 'port';
  if (/\badapters?\b/.test(text)) return 'adapter';
  if (/\b(frameworks?|drivers?|platform)\b/.test(text)) return 'infra';
  if (/\b(external|third party|saas|partners?)\b/.test(text)) return 'external';
  return undefined;
}

const DRIVEN_TECH =
  /\b(postgres\w*|pg|mysql|maria\w*|sql|sqlite|jdbc|jpa|hibernate|orm|mongo\w*|dynamo\w*|redis|memcache\w*|elastic\w*|kafka|rabbit\w*|amqp|sqs|sns|pub ?sub|nats|s3|blob|smtp|ses|sendgrid|twilio|stripe|paypal|braintree|adyen|http client|rest client|client|sdk|dao|adapter|publisher|producer|sender|mailer|notifier)\b/;
const UI = /\b(ui|web ?app|webapp|web|frontend|front end|spa|browser|mobile|ios|android|react|angular|vue|svelte|html|views?|pages?|screens?|console|portal|dashboard|storefront|desktop|presenter|view ?model)\b/;
const API = /\b(api|rest|graphql|grpc|controllers?|endpoints?|resources?|webhooks?|router|routes|bff)\b/;
const DRIVING = /\b(cli|command line|consumer|listener|subscriber|scheduler|cron|tests?|specs?|webhook)\b/;
const APPLICATION =
  /\b(services?|use ?cases?|usecases?|interactors?|application|handlers?|commands?|queries|orchestrat\w*|workflows?|sagas?|process manager|facade|managers?|coordinator|engine|workers?|jobs?|processors?|backend|server)\b/;
const DOMAIN = /\b(domain|entity|entities|aggregates?|value objects?|models?|polic(y|ies)|rules?|specifications?|invariants?|core|ledger|events?)\b/;
const STORE = /\b(db|database|datastore|data store|cache|storage|bucket|queue|topic|bus|broker|stream|messaging|file system|filesystem|disk|warehouse|lake|index)\b/;
const INFRA = /\b(infra|infrastructure|persistence|cdn|dns|load balancer|proxy|nginx|k8s|kubernetes|cluster|vm|registry|identity provider|idp|auth0|okta|keycloak|mail|email|smtp)\b/;
const EXTERNAL = /\b(external|third party|3rd party|saas|vendor|partner)\b/;

function nameRole(node: DNode, text: string, raw: string): Role | undefined {
  const isInterface = node.kind === 'interface' || node.classKind === 'interface';
  if (/\bport\b/.test(text) || /^I[A-Z][a-z]/.test(raw)) return portSide(text);
  if (/\bapi gateway\b/.test(text)) return 'api';
  if (/\b(use ?cases?|usecases?|interactors?)\b/.test(text)) return isInterface ? 'port-in' : 'application';
  if (/\b(repository|repositories|repo|gateway|store)\b/.test(text) && !STORE.test(text)) return isInterface ? 'port-out' : 'adapter-out';
  if (isInterface) return portSide(text);
  if (DRIVEN_TECH.test(text)) return 'adapter-out';
  if (DRIVING.test(text)) return 'adapter-in';
  if (UI.test(text)) return 'ui';
  if (API.test(text)) return 'api';
  if (/\b(adapters?|connectors?|integrations?|bridge)\b/.test(text)) return 'adapter';
  if (APPLICATION.test(text)) return 'application';
  if (DOMAIN.test(text)) return 'domain';
  if (STORE.test(text)) return 'store';
  if (INFRA.test(text)) return 'infra';
  if (EXTERNAL.test(text)) return 'external';
  return undefined;
}

/** Roles the kind alone settles: who would call a database "domain"? */
function strongKindRole(node: DNode): Role | undefined {
  if (node.kind === 'actor' || node.kind === 'person') return 'actor';
  if (node.kind === 'database' || node.kind === 'queue' || node.kind === 'storage' || node.kind === 'collections') return 'store';
  if (node.kind === 'interface') return 'port';
  if (node.external) return 'external';
  return undefined;
}

function weakKindRole(node: DNode, diagram: Diagram): Role | undefined {
  if (node.external) return undefined; // already said: external
  if (node.kind === 'cloud') return 'external';
  if (node.kind === 'system' || node.kind === 'container' || node.kind === 'usecase') return 'application';
  if (node.kind === 'node' || node.kind === 'artifact' || node.kind === 'stack') return 'infra';
  if (node.kind === 'class' && (node.classKind === 'entity' || diagram.family === 'class')) return node.classKind === 'interface' ? 'port' : 'domain';
  return undefined;
}

type RoleMap = Partial<Record<Role, string>>;

/** Roles that only say "some adapter" or "some port": a more specific signal overrides them. */
const GENERIC = new Set<Role>(['adapter', 'port', 'infra']);

/** Hexagonal roles whose side (driving/driven, inbound/outbound) the graph decides. */
const SIDELESS = new Set<Role>(['adapter', 'port', 'external']);

const LAYERED_MAP: RoleMap = {
  actor: 'presentation',
  ui: 'presentation',
  api: 'presentation',
  'adapter-in': 'presentation',
  'port-in': 'application',
  'port-out': 'domain',
  port: 'application',
  application: 'application',
  domain: 'domain',
  'adapter-out': 'infrastructure',
  adapter: 'infrastructure',
  store: 'infrastructure',
  external: 'infrastructure',
  infra: 'infrastructure',
  business: 'business',
  'archimate-application': 'application',
  technology: 'technology',
};

/** C4 containers are deployables: the API and the workers are the application tier, not presentation. */
const LAYERED_C4: RoleMap = { ...LAYERED_MAP, api: 'application', 'adapter-in': 'application' };

const HEX_MAP: RoleMap = {
  actor: 'driving',
  ui: 'driving',
  api: 'driving',
  'adapter-in': 'driving',
  'port-in': 'inbound',
  'port-out': 'outbound',
  application: 'application',
  domain: 'domain',
  'adapter-out': 'driven',
  store: 'driven',
  infra: 'driven',
  business: 'domain',
  'archimate-application': 'application',
  technology: 'driven',
};

/** C4: the API and the workers are the application inside the hexagon. */
const HEX_C4: RoleMap = { ...HEX_MAP, api: 'application', 'adapter-in': 'application' };

const CLEAN_MAP: RoleMap = {
  actor: 'frameworks',
  ui: 'frameworks',
  api: 'adapters',
  'adapter-in': 'adapters',
  'port-in': 'usecases',
  'port-out': 'usecases',
  port: 'usecases',
  application: 'usecases',
  domain: 'entities',
  'adapter-out': 'adapters',
  adapter: 'adapters',
  store: 'frameworks',
  external: 'frameworks',
  infra: 'frameworks',
  business: 'entities',
  'archimate-application': 'usecases',
  technology: 'frameworks',
};

function roleMap(kind: TemplateKind, diagram: Diagram): RoleMap {
  if (kind === 'hexagonal') return diagram.family === 'c4' ? HEX_C4 : HEX_MAP;
  if (kind === 'clean') return CLEAN_MAP;
  return diagram.family === 'c4' ? LAYERED_C4 : LAYERED_MAP;
}

/**
 * Guesses for every node. `template.assign` (the user's) is respected as a
 * known neighbour for the graph rules but never changed here.
 */
export function guessLayers(diagram: Diagram, template: Pick<TemplateSettings, 'kind' | 'layers' | 'assign'>): Map<string, Guess> {
  const layers = layersOf(template, diagram);
  const known = new Set(layers.map((l) => l.id));
  const map = roleMap(template.kind, diagram);
  const containers = new Map(diagram.containers.map((c) => [c.id, c]));
  const out = new Map<string, Guess>();
  /** Hexagonal elements whose side (or port side) the graph has to settle. */
  const sideless = new Map<string, Role>();

  /**
   * Signals in priority order; the first specific one wins. Generic roles
   * (adapter, port without a side, infra) say little: a container called
   * "adapters" holding a "Web browser" is a UI, so they only count when
   * nothing more specific follows. A layer named outright (a stereotype or a
   * container called "Domain") wins unless a specific signal came first.
   */
  const settle = (node: DNode): Guess | undefined => {
    const name = words(`${node.label} ${node.id === node.label ? '' : node.id} ${node.technology ?? ''}`);
    const signals: { role: Role; source: GuessSource }[] = [];
    const push = (role: Role | undefined, source: GuessSource) => role && signals.push({ role, source });
    const specific = () => signals.find((x) => !GENERIC.has(x.role) && map[x.role] && known.has(map[x.role]!));
    if (node.stereotype) {
      const named = layerNamed(node.stereotype, layers);
      if (named) return { layer: named, source: 'stereotype' };
    }
    push(stereotypeRole(node, diagram, name), 'stereotype');
    // "port" in a name is as explicit as a stereotype.
    if (/\bport\b/.test(name)) push(portSide(name), 'name');
    const strong = strongKindRole(node);
    // An interface's name says which side it is on; the kind only says it is a port.
    push(strong === 'port' ? portSide(name) : strong, 'kind');
    for (let c = node.parent ? containers.get(node.parent) : undefined; c; c = c.parent ? containers.get(c.parent) : undefined) {
      const text = `${c.label} ${c.id} ${c.stereotype ?? ''}`;
      const named = layerNamed(text, layers);
      if (named && !specific()) return { layer: named, source: 'container' };
      push(containerRole(words(text)), 'container');
    }
    push(nameRole(node, name, node.label), 'name');
    push(weakKindRole(node, diagram), 'kind');
    const pick = specific() ?? signals[0];
    if (!pick) return undefined;
    const layer = map[pick.role];
    if (layer && known.has(layer)) return { layer, source: pick.source };
    if (template.kind === 'hexagonal' && SIDELESS.has(pick.role)) sideless.set(node.id, pick.role);
    return undefined;
  };

  const pending: DNode[] = [];
  for (const n of diagram.nodes) {
    if (n.kind === 'note') continue;
    const g = settle(n);
    if (g) out.set(n.id, g);
    else pending.push(n);
  }

  const layerNow = (id: string) => (template.assign[id] && known.has(template.assign[id]!) ? template.assign[id] : out.get(id)?.layer);
  const deps = diagram.edges.filter((e) => !e.hidden && e.kind !== 'noteLink' && e.from !== e.to);

  if (template.kind === 'hexagonal') hexSides(deps, pending, sideless, layerNow, out);
  else ladder(template.kind, layers, deps, pending, layerNow, out);

  // Notes go with what they annotate.
  const fallback = defaultLayer(template.kind, layers);
  for (const n of diagram.nodes) {
    if (n.kind !== 'note') continue;
    const link = diagram.edges.find((e) => e.kind === 'noteLink' && e.from !== e.to && (e.from === n.id || e.to === n.id));
    const partner = n.attachedTo?.id ?? (link ? (link.from === n.id ? link.to : link.from) : undefined);
    const layer = partner && layerNow(partner);
    out.set(n.id, layer ? { layer, source: 'graph' } : { layer: fallback, source: 'default' });
  }
  for (const n of diagram.nodes) if (!out.has(n.id)) out.set(n.id, { layer: fallback, source: 'default' });
  return out;
}

/**
 * Layered and clean: an element nothing names sits between what it uses and
 * what uses it. In bands, what you use is one band down; in rings, one ring in.
 */
function ladder(kind: TemplateKind, layers: LayerDef[], deps: Diagram['edges'], pending: DNode[], layerNow: (id: string) => string | undefined, out: Map<string, Guess>) {
  const index = new Map(layers.map((l, i) => [l.id, i]));
  const step = kind === 'clean' ? -1 : 1;
  for (let round = 0; round < 3 && pending.length; round++) {
    for (const n of [...pending]) {
      const estimates: number[] = [];
      for (const e of deps) {
        if (e.from !== n.id && e.to !== n.id) continue;
        const other = e.from === n.id ? e.to : e.from;
        const l = layerNow(other);
        if (!l) continue;
        const dep = dependencyOf(e);
        const i = index.get(l)!;
        if (!dep) estimates.push(i);
        else if (dep[0] === other) estimates.push(i + step); // the other uses this one
        else estimates.push(i - step);
      }
      if (!estimates.length) continue;
      const mean = estimates.reduce((a, b) => a + b, 0) / estimates.length;
      const i = Math.min(layers.length - 1, Math.max(0, Math.round(mean)));
      out.set(n.id, { layer: layers[i]!.id, source: 'graph' });
      pending.splice(pending.indexOf(n), 1);
    }
  }
}

const CORE = new Set(['application', 'domain']);

/**
 * Hexagonal: which side a port or an adapter is on. A port the core
 * implements, or that driving adapters use, is inbound; one the core uses or
 * an adapter implements is outbound. An adapter that implements a port is
 * driven; one that uses the core or an inbound port is driving. Whatever is
 * still open goes by graph position: sources drive, sinks are driven.
 */
function hexSides(
  deps: Diagram['edges'],
  pending: DNode[],
  sideless: Map<string, Role>,
  layerNow: (id: string) => string | undefined,
  out: Map<string, Guess>,
) {
  const open = new Map<string, Role | undefined>([...sideless].map(([id, r]) => [id, r]));
  for (const n of pending) if (!open.has(n.id)) open.set(n.id, undefined);
  const isRealization = (e: Diagram['edges'][number]) => e.kind === 'realization' || e.kind === 'generalization';
  for (let round = 0; round < 4 && open.size; round++) {
    for (const [id, role] of [...open]) {
      let inward = 0;
      let outward = 0;
      let touchesCore = false;
      for (const e of deps) {
        if (e.from !== id && e.to !== id) continue;
        const other = e.from === id ? e.to : e.from;
        const l = layerNow(other);
        if (!l) continue;
        const dep = dependencyOf(e);
        const uses = dep?.[0] === id;
        if (CORE.has(l)) {
          touchesCore = true;
          if (role === 'port') {
            if (isRealization(e) && !uses) inward++;
            else if (dep && !uses) outward++;
          } else if (uses) inward++;
          else if (dep) outward++;
        } else if (l === 'driving' || l === 'inbound') inward++;
        else if (l === 'driven' || l === 'outbound') {
          if (role !== 'port' && isRealization(e) && uses) outward += 2;
          else outward++;
        }
      }
      if (!role && touchesCore && inward + outward === 0) {
        out.set(id, { layer: 'application', source: 'graph' });
        open.delete(id);
        continue;
      }
      if (inward === outward) continue;
      const driving = inward > outward;
      const layer = role === 'port' ? (driving ? 'inbound' : 'outbound') : driving ? 'driving' : 'driven';
      out.set(id, { layer, source: role ? 'kind' : 'graph' });
      open.delete(id);
    }
  }
  // Graph position: an element that only uses things drives; one that is only used is driven.
  for (const [id, role] of open) {
    const used = deps.some((e) => dependencyOf(e)?.[1] === id);
    const uses = deps.some((e) => dependencyOf(e)?.[0] === id);
    if (!used && !uses && !role) continue;
    const driving = uses && !used;
    const layer = role === 'port' ? (driving ? 'outbound' : 'inbound') : driving ? 'driving' : 'driven';
    out.set(id, { layer, source: role ? 'kind' : 'graph' });
  }
}
