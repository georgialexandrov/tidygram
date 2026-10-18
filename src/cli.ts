import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ensureLayout, type LayoutMode } from './layout/auto.ts';
import { emptyLayout, pageLayout, parseLayout, serializeLayout, TEMPLATE_KINDS, withPageLayout, type TemplateKind } from './layout/layout-file.ts';
import { applyTemplate, removeTemplate, unassigned } from './layout/template/index.ts';
import type { TemplateScene } from './scene/template.ts';
import { parseDiagram } from './model/diagram.ts';
import { DiagramSvg } from './render/DiagramSvg.tsx';
import { loadAvoid } from './scene/avoid.ts';
import { THEME_ALIASES, THEMES, themeOf } from './scene/theme.ts';
import { diskCachedFetcher } from './fonts-node.ts';
import { embeddedFontCss } from './scene/fonts.ts';
import { fitToFrame } from './layout/fit.ts';
import { largestScale } from './layout/scale.ts';
import { buildAnyScene } from './scene/any.ts';
import { DIAGRAM_FILE, convertedPathFor, layoutPathFor } from './paths.ts';
import { convert, TARGET_EXTENSION, type ConvertTarget } from './convert/index.ts';

const USAGE = `Usage: pnpm render <diagram.puml|.mmd|.drawio> [-o out.svg] [--relayout | --reset | --fit W:H] [--theme modern] [--scale 1.5|max] [--template layered|hexagonal|clean|none] [--no-write]
       pnpm render <diagram> --to drawio|puml|mermaid [-o out] [--force] [layout options as above]

Reads diagram.layout.json next to the diagram (if any), places nodes that have no
position yet (draw.io: where the file draws them), routes the lines and writes an SVG. The completed layout is written
back unless --no-write is given.

  --relayout   auto-layout everything except pinned nodes
  --reset      discard the stored layout and start over (draw.io: back to the file's layout)
  --fit W:H    re-arrange to fill a frame of that aspect ratio (16:9, 1:1, 210:297)
  --theme X    ${Object.keys(THEMES).join(' | ')} (stored in the layout file)
  --scale N    size of text and icons (1 = 100%), or "max" for the largest that fits
  --template T architecture template: layered (bands), hexagonal (ports & adapters),
               clean (rings), or none (back to the free layout); stored in the layout file.
               Prints the guessed layers, unassigned elements and dependency violations
  --page P     multi-page draw.io: the page to render, by id, name or number (1 = first);
               each page keeps its own layout in the sidecar
  --to X       convert instead of rendering: writes the diagram in another format, with its
               layout (draw.io: in the file; PlantUML/Mermaid: in a sidecar next to it).
               Default output: diagram-<format>.<ext> next to the input, so the two never
               share a sidecar. Existing files are not overwritten without --force.`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    out: { type: 'string', short: 'o' },
    relayout: { type: 'boolean', default: false },
    reset: { type: 'boolean', default: false },
    fit: { type: 'string' },
    theme: { type: 'string' },
    scale: { type: 'string' },
    template: { type: 'string' },
    page: { type: 'string' },
    'no-write': { type: 'boolean', default: false },
    to: { type: 'string' },
    force: { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
});

const file = positionals[0];
if (values.help || !file) {
  console.log(USAGE);
  process.exit(file ? 0 : 1);
}

// `--page 2` is the second page; anything that isn't a plain number is a page id or name.
const pageArg = values.page === undefined ? undefined : /^\d+$/.test(values.page) ? Number(values.page) - 1 : values.page;
const { diagram, warnings, pages, page } = parseDiagram(readFileSync(file, 'utf8'), file, { page: pageArg });
for (const w of warnings) console.warn(`${file}:${w.line}: ${w.message}: ${w.text.trim()}`);
/** The first page's layout is the sidecar's top level; other pages live under `pages` by key. */
const pageKey = pages && page ? pages[page]!.key : undefined;
if (pages) console.log(`page ${page! + 1} of ${pages.length}: ${pages[page!]!.name}`);

const layoutPath = layoutPathFor(file);
const before = existsSync(layoutPath) ? readFileSync(layoutPath, 'utf8') : '';
const mode: LayoutMode = values.reset ? 'reset' : values.relayout ? 'auto' : 'fill';
const require = createRequire(import.meta.url);
const avoid = await loadAvoid(join(dirname(require.resolve('libavoid-js')), 'libavoid.wasm'));

const sidecar = before ? parseLayout(before) : emptyLayout();
let layout = pageLayout(sidecar, pageKey);
if (values.theme) {
  if (!(values.theme in THEMES) && !(values.theme in THEME_ALIASES)) throw new Error(`Unknown theme ${values.theme}; use ${Object.keys(THEMES).join(' or ')}`);
  layout = { ...layout, view: { ...layout.view, theme: values.theme } };
}
layout = await ensureLayout(diagram, layout, mode);
if (values.template) {
  const kind = values.template.toLowerCase();
  if (kind === 'none' || kind === 'off') layout = await ensureLayout(diagram, removeTemplate(layout), 'fill');
  else if ((TEMPLATE_KINDS as string[]).includes(kind)) layout = applyTemplate(diagram, layout, kind as TemplateKind);
  else throw new Error(`--template expects ${TEMPLATE_KINDS.join(', ')} or none, got ${values.template}`);
}
if (values.fit) {
  const m = /^(\d+(?:\.\d+)?)[:x/](\d+(?:\.\d+)?)$/.exec(values.fit);
  if (!m) throw new Error(`--fit expects W:H, got ${values.fit}`);
  const started = performance.now();
  const fit = await fitToFrame(diagram, layout, [Number(m[1]), Number(m[2])], avoid);
  layout = fit.layout;
  console.log(
    `fit ${values.fit}: "${fit.variant}" (best of ${fit.tried}), ratio ${fit.achieved.toFixed(2)}, text ${Math.round(fit.scale * 100)}%, fills ${Math.round(fit.fill * 100)}% of the frame, ${Math.round(performance.now() - started)} ms`,
  );
}

if (values.scale) {
  const scale = values.scale === 'max' ? largestScale(diagram, { ...layout, view: { ...layout.view, scale: 1 } }) : Number(values.scale);
  if (!(scale > 0)) throw new Error(`--scale expects a number or "max", got ${values.scale}`);
  layout = { ...layout, view: { ...layout.view, scale } };
  console.log(`scale ${Math.round(scale * 100)}%`);
}

const scene = buildAnyScene(diagram, layout, avoid);
if (layout.template && scene.kind === 'graph' && scene.template) reportTemplate(scene.template);

if (values.to) writeConverted(values.to, file);
else {
  const out = values.out ?? file.replace(DIAGRAM_FILE, '') + (pageKey ? `-${pageKey.replace(/[^\w.-]+/g, '_')}` : '') + '.svg';
  const fontCss = await embeddedFontCss(themeOf(layout.view).webFonts, diskCachedFetcher());
  writeFileSync(out, renderToStaticMarkup(createElement(DiagramSvg, { scene, frame: layout.view?.frame, fontCss })));
  console.log(`wrote ${out}`);
}

const after = serializeLayout(withPageLayout(sidecar, pageKey, layout));
if (!values['no-write'] && after !== before) {
  writeFileSync(layoutPath, after);
  console.log(`wrote ${layoutPath}`);
}

/** What the template made of the diagram: members per layer, what no signal placed, which lines break the rule. */
function reportTemplate(t: TemplateScene) {
  for (const l of t.layers) {
    const ids = [...t.assigned].filter(([, layer]) => layer === l.id).map(([id]) => id);
    console.log(`  ${l.label.padEnd(22)} ${ids.join(', ') || '-'}`);
  }
  const open = unassigned(diagram, layout.template!);
  if (open.length) console.log(`unassigned (in the default layer): ${open.join(', ')}`);
  console.log(t.violations.length ? `${t.violations.length} violation${t.violations.length > 1 ? 's' : ''}:` : 'no violations');
  for (const v of t.violations) console.log(`  ${v.edge}: ${v.message}`);
}

/** `--to`: the converted source, plus its sidecar for PlantUML and Mermaid, never on top of the input's own files. */
function writeConverted(to: string, file: string) {
  const targets: Record<string, ConvertTarget> = { drawio: 'drawio', puml: 'puml', plantuml: 'puml', mermaid: 'mermaid', mmd: 'mermaid' };
  const target = targets[to.toLowerCase()];
  if (!target) throw new Error(`--to expects drawio, puml or mermaid, got ${to}`);
  const result = convert(diagram, layout, target, scene);
  for (const w of result.warnings) console.warn(`${file}: ${w.message}`);
  if (!result.source) process.exit(1);
  const out = values.out ?? convertedPathFor(file, target, TARGET_EXTENSION[target]);
  const sidecar = target === 'drawio' ? undefined : layoutPathFor(out);
  const files = [out, ...(sidecar ? [sidecar] : [])];
  if (sidecar && sidecar === layoutPath) {
    console.error(`${out} would share ${sidecar} with ${file}; pick another name with -o`);
    process.exit(1);
  }
  const existing = files.filter((f) => existsSync(f));
  if (existing.length && !values.force) {
    console.error(`not overwriting ${existing.join(' and ')} (use --force)`);
    process.exit(1);
  }
  writeFileSync(out, result.source);
  console.log(`wrote ${out}`);
  if (sidecar) {
    writeFileSync(sidecar, serializeLayout(result.layout));
    console.log(`wrote ${sidecar}`);
  }
}
