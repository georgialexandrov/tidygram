import type { ViewSettings } from '../layout/layout-file.ts';

/**
 * Visual themes. `classic` mirrors PlantUML (crisper). The others follow
 * editorial diagram rules: a quiet neutral structure (hairlines, tinted
 * containers that recede), primary elements on top, one accent colour that
 * means something (people and internal systems in C4, progress in Gantt),
 * a real type scale (caps-tracked container titles, muted secondary text,
 * tabular numerals) and no shadows. `modern` is the default.
 *
 * Themes change sizes too (fonts, actor glyphs), so geometry is built per
 * theme, and `scale` enlarges every size at once.
 */

export interface Theme {
  name: string;
  label: string;
  /** Multiplies every size below (and the paddings in shapes.ts). 1 = as designed. */
  scale: number;
  /** Actor/system glyph size relative to design: `scale` times the icon multiplier. */
  iconScale: number;
  font: string;
  /** Width of the theme's font relative to the Helvetica table used for measuring. */
  widthFactor: number;
  size: { node: number; note: number; edge: number; container: number; actor: number };
  nodeWeight?: number;
  actor: { style: 'stick' | 'avatar'; w: number; h: number; showStereotype: boolean };
  usecase: 'ellipse' | 'pill';
  /** Corner radius where lines bend. */
  bendRadius: number;
  containerRadius: number;
  /** Corner radius of boxes (components, classes, cards); states and actions round more. */
  nodeRadius: number;
  containerTitle: 'centered' | 'caps';
  arrow: 'filled' | 'chevron';
  noteFold: boolean;
  /** Show `«include»` as `include` in a chip. */
  plainLabels: boolean;
  /** Line labels sit on a background chip that knocks the line out (else: a bare halo). */
  labelChip: boolean;
  /** PlantUML-isms: the round C/I/A/E spot in class headers, ref/group tabs as PlantUML draws them. */
  plantuml: boolean;
  colors: {
    background: string;
    text: string;
    muted: string;
    title: string;
    actorText: string;
    line: string;
    lineWidth: number;
    dependency: string;
    dependencyLabel: string;
    generalization: string;
    noteLink: string;
    shapeFill: string;
    shapeStroke: string;
    actorFill: string;
    actorStroke: string;
    actorGlyph: string;
    systemFill: string;
    systemStroke: string;
    systemGlyph: string;
    noteFill: string;
    noteStroke: string;
    noteText: string;
    containerFill: string;
    containerStroke: string;
    nestedFill: string;
    nestedStroke: string;
    labelFill: string;
    labelStroke: string;
    /** Architecture templates: dependency violations (line and marker). */
    warning: string;
    /** Band / ring / hexagon fills, outermost (or top) first, core last. */
    layerFills: string[];
    layerStroke: string;
    layerTitle: string;
    /** The one accent: focus marks, Gantt bars, sequence numbers, timing waveforms. */
    accent: string;
    /** Text on a solid accent fill. */
    onAccent: string;
    /** Quiet panel fill: class header bands, Gantt weekends, sequence boxes, fragment tabs. */
    surface: string;
    /** Hairlines for grids, lifelines and row rules. */
    grid: string;
    /** Edge label text (secondary, so quieter than element names). */
    labelText: string;
    /** C4: people (the start of every story) solid, internal systems tinted, external grey. */
    c4: { personFill: string; personStroke: string; personText: string; personMuted: string; internalFill: string; internalStroke: string; externalFill: string; externalStroke: string };
    /** ArchiMate layer fills; text stays `text` on all of them. */
    archimate: Record<ArchimateLayer, string>;
  };
  dash: { dependency: string; note: string };
}

export type ArchimateLayer = 'strategy' | 'business' | 'application' | 'technology' | 'physical' | 'implementation' | 'motivation' | 'other';

// ---- colour helpers ------------------------------------------------------------------------------

const rgb = (hex: string): [number, number, number] => {
  const h = hex.replace('#', '');
  const v = h.length === 3 ? h.replace(/./g, (c) => c + c) : h.slice(0, 6);
  return [parseInt(v.slice(0, 2), 16), parseInt(v.slice(2, 4), 16), parseInt(v.slice(4, 6), 16)];
};

/** `a` mixed towards `b` by `t` (0 = a, 1 = b), in sRGB, as hex. */
export function mix(a: string, b: string, t: number): string {
  const [x, y] = [rgb(a), rgb(b)];
  return `#${x.map((v, i) => Math.round(v + (y[i]! - v) * t).toString(16).padStart(2, '0')).join('').toUpperCase()}`;
}

/** WCAG 2 contrast ratio between two hex colours (1–21). */
export function contrast(a: string, b: string): number {
  const lum = (hex: string) => {
    const [r, g, bl] = rgb(hex).map((v) => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * bl!;
  };
  const [l1, l2] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (l1! + 0.05) / (l2! + 0.05);
}

// ---- themes --------------------------------------------------------------------------------------

/** PlantUML's own ArchiMate and C4 colours, used by classic. */
const ARCHIMATE_STANDARD: Record<ArchimateLayer, string> = {
  strategy: '#F5DEAA',
  business: '#FFFFB5',
  application: '#B5FFFF',
  technology: '#C9E7B7',
  physical: '#C9E7B7',
  implementation: '#FFE0E0',
  motivation: '#CCCCFF',
  other: '#FFFFFF',
};

/** ArchiMate's layer hues, mixed into a theme's background so they stay a tint. */
const ARCHIMATE_HUES: Record<ArchimateLayer, string> = {
  strategy: '#F59E0B',
  business: '#EAB308',
  application: '#0EA5E9',
  technology: '#22C55E',
  physical: '#16A34A',
  implementation: '#EC4899',
  motivation: '#8B5CF6',
  other: '#94A3B8',
};

const tints = (background: string, amount: number): Record<ArchimateLayer, string> =>
  Object.fromEntries(Object.entries(ARCHIMATE_HUES).map(([k, hue]) => [k, mix(background, hue, amount)])) as Record<ArchimateLayer, string>;

const classic: Theme = {
  name: 'classic',
  label: 'Classic (PlantUML)',
  scale: 1,
  iconScale: 1,
  font: 'Helvetica, Arial, sans-serif',
  widthFactor: 1,
  size: { node: 13, note: 12, edge: 11, container: 13, actor: 13 },
  actor: { style: 'stick', w: 28, h: 48, showStereotype: true },
  usecase: 'ellipse',
  bendRadius: 4,
  containerRadius: 2,
  nodeRadius: 2.5,
  containerTitle: 'centered',
  arrow: 'filled',
  noteFold: true,
  plainLabels: false,
  labelChip: false,
  plantuml: true,
  colors: {
    background: '#FFFFFF',
    text: '#181818',
    muted: '#555555',
    title: '#181818',
    actorText: '#181818',
    line: '#181818',
    lineWidth: 1,
    dependency: '#181818',
    dependencyLabel: '#181818',
    generalization: '#181818',
    noteLink: '#181818',
    shapeFill: '#F1F1F1',
    shapeStroke: '#181818',
    actorFill: '#F1F1F1',
    actorStroke: '#181818',
    actorGlyph: '#181818',
    systemFill: '#F1F1F1',
    systemStroke: '#181818',
    systemGlyph: '#181818',
    noteFill: '#FEFFDD',
    noteStroke: '#181818',
    noteText: '#181818',
    containerFill: 'none',
    containerStroke: '#181818',
    nestedFill: 'none',
    nestedStroke: '#181818',
    labelFill: '#FFFFFF',
    labelStroke: 'none',
    warning: '#C2410C',
    layerFills: ['#FBFBFB', '#F5F5F5', '#EEEEEE', '#E6E6E6'],
    layerStroke: '#B8B8B8',
    layerTitle: '#181818',
    accent: '#181818',
    onAccent: '#FFFFFF',
    surface: '#F1F1F1',
    grid: '#D6D6D6',
    labelText: '#181818',
    // PlantUML's C4 stdlib: person #08427B, container #438DD5, external #999999 — white text.
    c4: { personFill: '#08427B', personStroke: '#073B6F', personText: '#FFFFFF', personMuted: '#E2ECF7', internalFill: '#1168BD', internalStroke: '#0B4884', externalFill: '#6B6B6B', externalStroke: '#4D4D4D' },
    archimate: ARCHIMATE_STANDARD,
  },
  dash: { dependency: '6 4', note: '4 3' },
};

const SYSTEM_SANS = "Inter, ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Helvetica, Arial, sans-serif";

/**
 * The default. Slate neutrals, indigo as the one accent. Elements are white
 * cards with a hairline; containers are tinted panels without weight; lines
 * are a mid grey so boxes read first; labels sit on knock-out chips.
 */
const modern: Theme = {
  name: 'modern',
  label: 'Modern (default)',
  scale: 1,
  iconScale: 1,
  font: SYSTEM_SANS,
  widthFactor: 1.07,
  size: { node: 13, note: 12, edge: 11, container: 10.5, actor: 12 },
  nodeWeight: 500,
  actor: { style: 'avatar', w: 32, h: 32, showStereotype: false },
  usecase: 'pill',
  bendRadius: 8,
  containerRadius: 12,
  nodeRadius: 8,
  containerTitle: 'caps',
  arrow: 'filled',
  noteFold: false,
  plainLabels: true,
  labelChip: true,
  plantuml: false,
  colors: {
    background: '#FFFFFF',
    text: '#0F172A',
    muted: '#5F6E84',
    title: '#5F6E84',
    actorText: '#1E293B',
    line: '#94A3B8',
    lineWidth: 1.25,
    dependency: '#94A3B8',
    dependencyLabel: '#475569',
    generalization: '#64748B',
    noteLink: '#CBD5E1',
    shapeFill: '#FFFFFF',
    shapeStroke: '#CBD5E1',
    actorFill: '#EEF2FF',
    actorStroke: '#C7D2FE',
    actorGlyph: '#4F46E5',
    systemFill: '#F1F5F9',
    systemStroke: '#CBD5E1',
    systemGlyph: '#475569',
    noteFill: '#FFFBEB',
    noteStroke: '#FDE68A',
    noteText: '#713F12',
    containerFill: '#F8FAFC',
    containerStroke: '#E2E8F0',
    nestedFill: '#FFFFFF',
    nestedStroke: '#E2E8F0',
    labelFill: '#FFFFFF',
    labelStroke: 'none',
    warning: '#C2410C',
    layerFills: ['#F8FAFC', '#F1F5FB', '#EAEFFA', '#E2E8F8'],
    layerStroke: '#DCE3EE',
    layerTitle: '#475569',
    accent: '#4F46E5',
    onAccent: '#FFFFFF',
    surface: '#F1F5F9',
    grid: '#E2E8F0',
    labelText: '#475569',
    c4: { personFill: '#4338CA', personStroke: '#3730A3', personText: '#FFFFFF', personMuted: '#E0E7FF', internalFill: '#EEF2FF', internalStroke: '#A5B4FC', externalFill: '#F1F5F9', externalStroke: '#CBD5E1' },
    archimate: tints('#FFFFFF', 0.16),
  },
  dash: { dependency: '5 4', note: '2 3' },
};

/** The other modern themes share modern's structure and change palette and type. */
function variant(name: string, label: string, colors: Partial<Theme['colors']>, rest: Partial<Omit<Theme, 'colors'>> = {}): Theme {
  const merged = { ...modern.colors, ...colors };
  // Tints that weren't given follow the variant's background, so a dark theme gets dark tints.
  if (!colors.archimate) merged.archimate = tints(merged.background, 0.16);
  return { ...modern, ...rest, name, label, colors: merged };
}

/** Dark: deep blue-black, cyan accent. Fills step up in lightness, strokes stay low. */
const midnight = variant('midnight', 'Midnight (dark)', {
  background: '#0B1120',
  text: '#E2E8F0',
  muted: '#94A3B8',
  title: '#94A3B8',
  actorText: '#CBD5E1',
  line: '#52607A',
  dependency: '#52607A',
  dependencyLabel: '#A5B4C8',
  generalization: '#94A3B8',
  noteLink: '#334155',
  shapeFill: '#131C2E',
  shapeStroke: '#2B3A52',
  actorFill: '#0C2A36',
  actorStroke: '#155E75',
  actorGlyph: '#22D3EE',
  systemFill: '#1A2335',
  systemStroke: '#2B3A52',
  systemGlyph: '#94A3B8',
  noteFill: '#211C10',
  noteStroke: '#4A3F22',
  noteText: '#EBDDB0',
  containerFill: '#0F172A',
  containerStroke: '#1E293B',
  nestedFill: '#0B1120',
  nestedStroke: '#243044',
  labelFill: '#0B1120',
  warning: '#FB923C',
  layerFills: ['#0E1626', '#111B2E', '#142037', '#182641'],
  layerStroke: '#26344C',
  layerTitle: '#94A3B8',
  accent: '#22D3EE',
  onAccent: '#082F3A',
  surface: '#141D2F',
  grid: '#1E293B',
  labelText: '#A5B4C8',
  c4: { personFill: '#0E7490', personStroke: '#155E75', personText: '#FFFFFF', personMuted: '#CFFAFE', internalFill: '#0C2A36', internalStroke: '#155E75', externalFill: '#1A2335', externalStroke: '#2B3A52' },
  archimate: tints('#131C2E', 0.2),
});

/** Engineering drawing: navy paper, white linework, mono type, amber accent. */
const blueprint = variant(
  'blueprint',
  'Blueprint',
  {
    background: '#0E2C4F',
    text: '#EAF3FF',
    muted: '#9DBFE3',
    title: '#9DBFE3',
    actorText: '#D6E7FA',
    line: '#7FA8D4',
    lineWidth: 1,
    dependency: '#7FA8D4',
    dependencyLabel: '#FFD166',
    generalization: '#B9D3EE',
    noteLink: '#5D86B3',
    shapeFill: '#0E2C4F',
    shapeStroke: '#B9D3EE',
    actorFill: '#0E2C4F',
    actorStroke: '#B9D3EE',
    actorGlyph: '#EAF3FF',
    systemFill: '#0E2C4F',
    systemStroke: '#FFD166',
    systemGlyph: '#FFD166',
    noteFill: '#123A63',
    noteStroke: '#5D86B3',
    noteText: '#EAF3FF',
    containerFill: '#0E2C4F',
    containerStroke: '#4F79A6',
    nestedFill: '#0E2C4F',
    nestedStroke: '#3D6893',
    labelFill: '#0E2C4F',
    warning: '#FF8A65',
    layerFills: ['#103256', '#12385F', '#153F69', '#184674'],
    layerStroke: '#3D6893',
    layerTitle: '#9DBFE3',
    accent: '#FFD166',
    onAccent: '#0E2C4F',
    surface: '#123A63',
    grid: '#1F4A78',
    labelText: '#D6E7FA',
    c4: { personFill: '#FFD166', personStroke: '#FFD166', personText: '#0E2C4F', personMuted: '#3B4A5C', internalFill: '#123A63', internalStroke: '#B9D3EE', externalFill: '#0E2C4F', externalStroke: '#5D86B3' },
    archimate: tints('#0E2C4F', 0.22),
  },
  {
    font: "'JetBrains Mono', 'SF Mono', Menlo, Consolas, monospace",
    widthFactor: 1.2,
    nodeWeight: 400,
    size: { node: 12, note: 11, edge: 10, container: 10.5, actor: 11 },
    containerRadius: 2,
    nodeRadius: 2,
    bendRadius: 0,
    arrow: 'chevron',
    dash: { dependency: '4 3', note: '1 3' },
  },
);

/** Warm paper, serif type, burnt-orange accent: figures for essays and printed docs. */
const editorial = variant(
  'editorial',
  'Editorial (warm paper)',
  {
    background: '#FBF8F3',
    text: '#1C1917',
    muted: '#6F665F',
    title: '#6F665F',
    actorText: '#44403C',
    line: '#A8A29E',
    dependency: '#A8A29E',
    dependencyLabel: '#57534E',
    generalization: '#57534E',
    noteLink: '#D6D3D1',
    shapeFill: '#FFFFFF',
    shapeStroke: '#DDD3C4',
    actorFill: '#FDECDD',
    actorStroke: '#F4C9A6',
    actorGlyph: '#C2410C',
    systemFill: '#F3EEE7',
    systemStroke: '#DDD3C4',
    systemGlyph: '#57534E',
    noteFill: '#FFFFFF',
    noteStroke: '#E2D9CC',
    noteText: '#57534E',
    containerFill: '#F5F0E8',
    containerStroke: '#E7DED1',
    nestedFill: '#FBF8F3',
    nestedStroke: '#E7DED1',
    labelFill: '#FBF8F3',
    warning: '#B42318',
    layerFills: ['#F8F4EE', '#F3EDE4', '#EDE5D9', '#E7DDCE'],
    layerStroke: '#E2D9CC',
    layerTitle: '#5E564F',
    accent: '#C2410C',
    onAccent: '#FFFFFF',
    surface: '#F3EEE7',
    grid: '#E7DED1',
    labelText: '#57534E',
    c4: { personFill: '#B23A0B', personStroke: '#9A330A', personText: '#FFFFFF', personMuted: '#FDE7D7', internalFill: '#FDF1E7', internalStroke: '#F0C3A0', externalFill: '#F3EEE7', externalStroke: '#DDD3C4' },
  },
  { font: "'Iowan Old Style', 'Palatino Linotype', Palatino, Georgia, serif", widthFactor: 1.1, nodeWeight: 400, containerRadius: 6, nodeRadius: 4 },
);

/** Black on white, no colour at all: for print and for photocopies. */
const mono = variant(
  'mono',
  'Mono (print)',
  {
    background: '#FFFFFF',
    text: '#111111',
    muted: '#595959',
    title: '#111111',
    actorText: '#111111',
    line: '#6B6B6B',
    lineWidth: 1,
    dependency: '#6B6B6B',
    dependencyLabel: '#111111',
    generalization: '#111111',
    noteLink: '#9A9A9A',
    shapeFill: '#FFFFFF',
    shapeStroke: '#111111',
    actorFill: '#111111',
    actorStroke: '#111111',
    actorGlyph: '#FFFFFF',
    systemFill: '#FFFFFF',
    systemStroke: '#111111',
    systemGlyph: '#111111',
    noteFill: '#F5F5F5',
    noteStroke: '#D4D4D4',
    noteText: '#333333',
    containerFill: '#FFFFFF',
    containerStroke: '#111111',
    nestedFill: '#FFFFFF',
    nestedStroke: '#ABABAB',
    labelFill: '#FFFFFF',
    warning: '#111111',
    layerFills: ['#FFFFFF', '#F7F7F7', '#EFEFEF', '#E6E6E6'],
    layerStroke: '#9A9A9A',
    layerTitle: '#111111',
    accent: '#111111',
    onAccent: '#FFFFFF',
    surface: '#F2F2F2',
    grid: '#E0E0E0',
    labelText: '#333333',
    c4: { personFill: '#111111', personStroke: '#111111', personText: '#FFFFFF', personMuted: '#D9D9D9', internalFill: '#FFFFFF', internalStroke: '#111111', externalFill: '#F2F2F2', externalStroke: '#8C8C8C' },
    archimate: { strategy: '#F5F5F5', business: '#FFFFFF', application: '#F2F2F2', technology: '#E6E6E6', physical: '#E6E6E6', implementation: '#F5F5F5', motivation: '#F5F5F5', other: '#FFFFFF' },
  },
  { containerRadius: 4, nodeRadius: 3, bendRadius: 4 },
);

/** Matches the editor chrome: black ink on warm white, primaries only as signals. */
const primary = variant(
  'primary',
  'Primary',
  {
    background: '#FDFCFA',
    text: '#1A1A1A',
    muted: '#4F4C46',
    title: '#1A1A1A',
    actorText: '#1A1A1A',
    line: '#1A1A1A',
    lineWidth: 1,
    dependency: '#1A1A1A',
    dependencyLabel: '#A8340F',
    generalization: '#1A1A1A',
    noteLink: '#A8A49A',
    shapeFill: '#FFFFFF',
    shapeStroke: '#1A1A1A',
    actorFill: '#1F4E9C',
    actorStroke: '#1F4E9C',
    actorGlyph: '#FFFFFF',
    systemFill: '#F2C12E',
    systemStroke: '#1A1A1A',
    systemGlyph: '#1A1A1A',
    noteFill: '#FBF1CF',
    noteStroke: '#C99C12',
    noteText: '#1A1A1A',
    containerFill: '#F3F1EC',
    containerStroke: '#1A1A1A',
    nestedFill: '#FDFCFA',
    nestedStroke: '#A8A49A',
    labelFill: '#FDFCFA',
    // The editor's warning yellow is too light for a line on warm white; its ochre carries it.
    warning: '#B88A00',
    layerFills: ['#FDFCFA', '#F3F1EC', '#E9E6DF', '#DEDBD3'],
    layerStroke: '#A8A49A',
    layerTitle: '#1A1A1A',
    accent: '#CC4116',
    onAccent: '#FFFFFF',
    surface: '#F3F1EC',
    grid: '#E3E0D8',
    labelText: '#1A1A1A',
    c4: { personFill: '#1F4E9C', personStroke: '#1A1A1A', personText: '#FFFFFF', personMuted: '#DCE6F7', internalFill: '#FFFFFF', internalStroke: '#1A1A1A', externalFill: '#F2C12E', externalStroke: '#1A1A1A' },
    archimate: { strategy: '#F7E2B5', business: '#FBF1CF', application: '#DCE6F7', technology: '#E3EEDC', physical: '#E3EEDC', implementation: '#F6DDD5', motivation: '#E7E1F2', other: '#FFFFFF' },
  },
  {
    font: "Futura, 'Futura PT', 'Century Gothic', 'Avenir Next', sans-serif",
    widthFactor: 1.08,
    nodeWeight: 500,
    usecase: 'ellipse',
    containerRadius: 0,
    nodeRadius: 0,
    bendRadius: 0,
    labelChip: false,
    dash: { dependency: '6 4', note: '2 3' },
  },
);

export const THEMES: Record<string, Theme> = { modern, classic, midnight, editorial, blueprint, mono, primary };

/** The theme a layout without `view.theme` gets. */
export const DEFAULT_THEME = 'modern';

/** Retired theme names, read as their nearest survivor so old sidecars still load. */
export const THEME_ALIASES: Record<string, string> = { mint: 'modern' };

export function themeFor(name: string | undefined): Theme {
  const key = name ?? DEFAULT_THEME;
  return THEMES[key] ?? THEMES[THEME_ALIASES[key] ?? DEFAULT_THEME]!;
}

/**
 * The theme with every size multiplied by `s`, text by a further `text` and
 * icons by a further `icons`. Line widths grow slower, so lines stay hairlines.
 */
export function scaledTheme(theme: Theme, s: number, text = 1, icons = 1): Theme {
  if (s === 1 && text === 1 && icons === 1) return theme;
  const size = Object.fromEntries(Object.entries(theme.size).map(([k, v]) => [k, v * s * text])) as Theme['size'];
  return {
    ...theme,
    scale: s,
    iconScale: s * icons,
    size,
    actor: { ...theme.actor, w: theme.actor.w * s * icons, h: theme.actor.h * s * icons },
    bendRadius: theme.bendRadius * s,
    containerRadius: theme.containerRadius * s,
    nodeRadius: theme.nodeRadius * s,
    colors: { ...theme.colors, lineWidth: theme.colors.lineWidth * Math.sqrt(s) },
  };
}

const cache = new Map<string, Theme>();

/** Theme for a layout's view settings: named theme at the stored scale. The same settings give the same object. */
export function themeOf(view: ViewSettings | undefined): Theme {
  const key = `${view?.theme ?? ''}|${view?.scale ?? 1}|${view?.text ?? 1}|${view?.icons ?? 1}`;
  let theme = cache.get(key);
  if (!theme) {
    theme = scaledTheme(themeFor(view?.theme), view?.scale ?? 1, view?.text ?? 1, view?.icons ?? 1);
    cache.set(key, theme);
  }
  return theme;
}

/**
 * The accent as a quiet tint (`t` ≈ 0.1) or a soft outline (≈ 0.35), mixed
 * into the background. For things that should carry the accent without
 * shouting: activation bars, key badges, first-level topics, timing cells.
 * Unlike `actorFill`, which is a solid ink in mono and primary.
 */
export function accentTint(theme: Theme, t: number): string {
  return mix(theme.colors.background, theme.colors.accent, t);
}

/** ArchiMate layer of an element, from the stereotype the parser gives it (`business actor`, `application`). */
export function archimateLayer(stereotype: string | undefined): ArchimateLayer | undefined {
  const first = stereotype?.split(/[\s-]/)[0]?.toLowerCase();
  return first && first in ARCHIMATE_HUES ? (first as ArchimateLayer) : undefined;
}
