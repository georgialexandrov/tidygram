import type { ViewSettings } from '../layout/layout-file.ts';

/**
 * Visual themes. `classic` mirrors PlantUML; the others follow editorial
 * diagram rules: one accent colour, 1px hairlines, no shadows, quiet type.
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
  containerTitle: 'centered' | 'caps';
  arrow: 'filled' | 'chevron';
  noteFold: boolean;
  /** Show `«include»` as `include` in a chip. */
  plainLabels: boolean;
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
  };
  dash: { dependency: string; note: string };
}

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
  bendRadius: 6,
  containerRadius: 2,
  containerTitle: 'centered',
  arrow: 'filled',
  noteFold: true,
  plainLabels: false,
  colors: {
    background: '#FFFFFF',
    text: '#181818',
    muted: '#181818',
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
  },
  dash: { dependency: '6 4', note: '4 3' },
};

const INTER = "Inter, ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Helvetica, Arial, sans-serif";

const modern: Theme = {
  name: 'modern',
  label: 'Modern (indigo)',
  scale: 1,
  iconScale: 1,
  font: INTER,
  widthFactor: 1.07,
  size: { node: 13, note: 12, edge: 10.5, container: 11, actor: 12 },
  nodeWeight: 500,
  actor: { style: 'avatar', w: 32, h: 32, showStereotype: false },
  usecase: 'pill',
  bendRadius: 10,
  containerRadius: 14,
  containerTitle: 'caps',
  arrow: 'chevron',
  noteFold: false,
  plainLabels: true,
  colors: {
    background: '#FFFFFF',
    text: '#101828',
    muted: '#667085',
    title: '#667085',
    actorText: '#344054',
    line: '#98A2B3',
    lineWidth: 1.25,
    dependency: '#818CF8',
    dependencyLabel: '#4F46E5',
    generalization: '#667085',
    noteLink: '#D0D5DD',
    shapeFill: '#FFFFFF',
    shapeStroke: '#D0D5DD',
    actorFill: '#EEF2FF',
    actorStroke: '#C7D2FE',
    actorGlyph: '#4F46E5',
    systemFill: '#F2F4F7',
    systemStroke: '#D0D5DD',
    systemGlyph: '#475467',
    noteFill: '#FFFCF0',
    noteStroke: '#F2E2A6',
    noteText: '#5C4813',
    containerFill: '#FAFAFB',
    containerStroke: '#E4E7EC',
    nestedFill: '#FFFFFF',
    nestedStroke: '#EAECF0',
    labelFill: '#FFFFFF',
    labelStroke: '#E0E7FF',
  },
  dash: { dependency: '5 4', note: '2 3' },
};

/** The other modern themes share modern's structure and change palette and type. */
function variant(name: string, label: string, colors: Partial<Theme['colors']>, rest: Partial<Omit<Theme, 'colors'>> = {}): Theme {
  return { ...modern, ...rest, name, label, colors: { ...modern.colors, ...colors } };
}

const midnight = variant('midnight', 'Midnight (dark)', {
  background: '#0B0F17',
  text: '#E6E8EC',
  muted: '#8B95A7',
  title: '#8B95A7',
  actorText: '#C9CED8',
  line: '#4A5466',
  dependency: '#22D3EE',
  dependencyLabel: '#67E8F9',
  generalization: '#8B95A7',
  noteLink: '#3A4252',
  shapeFill: '#121826',
  shapeStroke: '#2A3242',
  actorFill: '#0E2A33',
  actorStroke: '#155E75',
  actorGlyph: '#22D3EE',
  systemFill: '#1A2130',
  systemStroke: '#2A3242',
  systemGlyph: '#8B95A7',
  noteFill: '#1E1A12',
  noteStroke: '#4A3F22',
  noteText: '#E9D9A6',
  containerFill: '#0F141F',
  containerStroke: '#1F2737',
  nestedFill: '#0B0F17',
  nestedStroke: '#232C3D',
  labelFill: '#0B0F17',
  labelStroke: '#164E63',
});

const blueprint = variant(
  'blueprint',
  'Blueprint',
  {
    background: '#0E2C4F',
    text: '#EAF3FF',
    muted: '#8FB4DA',
    title: '#8FB4DA',
    actorText: '#D6E7FA',
    line: '#7FA8D4',
    lineWidth: 1,
    dependency: '#FFD166',
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
    containerFill: 'none',
    containerStroke: '#4F79A6',
    nestedFill: 'none',
    nestedStroke: '#3D6893',
    labelFill: '#0E2C4F',
    labelStroke: '#7A6A3A',
  },
  {
    font: "'JetBrains Mono', 'SF Mono', Menlo, Consolas, monospace",
    widthFactor: 1.2,
    nodeWeight: 400,
    size: { node: 12, note: 11, edge: 10, container: 11, actor: 11 },
    containerRadius: 2,
    bendRadius: 0,
    dash: { dependency: '4 3', note: '1 3' },
  },
);

const editorial = variant(
  'editorial',
  'Editorial (warm paper)',
  {
    background: '#FBF8F3',
    text: '#1C1917',
    muted: '#78716C',
    title: '#78716C',
    actorText: '#44403C',
    line: '#A8A29E',
    dependency: '#C2410C',
    dependencyLabel: '#C2410C',
    generalization: '#57534E',
    noteLink: '#D6D3D1',
    shapeFill: '#FFFFFF',
    shapeStroke: '#E2D9CC',
    actorFill: '#FDECDD',
    actorStroke: '#F4C9A6',
    actorGlyph: '#C2410C',
    systemFill: '#F3EEE7',
    systemStroke: '#E2D9CC',
    systemGlyph: '#57534E',
    noteFill: '#FFFFFF',
    noteStroke: '#E2D9CC',
    noteText: '#57534E',
    containerFill: '#F6F1EA',
    containerStroke: '#E7DED1',
    nestedFill: '#FBF8F3',
    nestedStroke: '#E7DED1',
    labelFill: '#FBF8F3',
    labelStroke: '#F4C9A6',
  },
  { font: "'Iowan Old Style', 'Palatino Linotype', Palatino, Georgia, serif", widthFactor: 1.1, nodeWeight: 400 },
);

const mono = variant(
  'mono',
  'Mono (print)',
  {
    background: '#FFFFFF',
    text: '#111111',
    muted: '#6B6B6B',
    title: '#111111',
    actorText: '#111111',
    line: '#9A9A9A',
    lineWidth: 1,
    dependency: '#111111',
    dependencyLabel: '#111111',
    generalization: '#111111',
    noteLink: '#BDBDBD',
    shapeFill: '#FFFFFF',
    shapeStroke: '#111111',
    actorFill: '#111111',
    actorStroke: '#111111',
    actorGlyph: '#FFFFFF',
    systemFill: '#FFFFFF',
    systemStroke: '#111111',
    systemGlyph: '#111111',
    noteFill: '#F5F5F5',
    noteStroke: '#E0E0E0',
    noteText: '#333333',
    containerFill: 'none',
    containerStroke: '#111111',
    nestedFill: 'none',
    nestedStroke: '#C8C8C8',
    labelFill: '#FFFFFF',
    labelStroke: '#111111',
  },
  { containerRadius: 4, bendRadius: 4 },
);

const mint = variant('mint', 'Mint', {
  text: '#0B1F17',
  muted: '#5F7A6E',
  title: '#3F6B58',
  actorText: '#24453A',
  line: '#9DB5AA',
  dependency: '#10B981',
  dependencyLabel: '#047857',
  generalization: '#5F7A6E',
  noteLink: '#CFE3D9',
  shapeStroke: '#CFE3D9',
  actorFill: '#E7F8EF',
  actorStroke: '#A7E3C4',
  actorGlyph: '#059669',
  systemFill: '#F1F5F3',
  systemStroke: '#CFE3D9',
  systemGlyph: '#3F6B58',
  containerFill: '#F7FBF9',
  containerStroke: '#DCEBE3',
  nestedFill: '#FFFFFF',
  nestedStroke: '#E3EFE9',
  labelStroke: '#BDEBD3',
});

export const THEMES: Record<string, Theme> = { classic, modern, midnight, blueprint, editorial, mono, mint };

export function themeFor(name: string | undefined): Theme {
  return THEMES[name ?? ''] ?? classic;
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
