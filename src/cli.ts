import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ensureLayout, type LayoutMode } from './layout/auto.ts';
import { emptyLayout, parseLayout, serializeLayout } from './layout/layout-file.ts';
import { parsePuml } from './model/parse.ts';
import { DiagramSvg } from './render/DiagramSvg.tsx';
import { loadAvoid } from './scene/avoid.ts';
import { THEMES } from './scene/theme.ts';
import { fitToFrame } from './layout/fit.ts';
import { largestScale } from './layout/scale.ts';
import { buildScene } from './scene/scene.ts';
import { layoutPathFor } from './paths.ts';

const USAGE = `Usage: pnpm render <diagram.puml> [-o out.svg] [--relayout | --reset | --fit W:H] [--theme modern] [--scale 1.5|max] [--no-write]

Reads diagram.layout.json next to the .puml (if any), places nodes that have no
position yet, routes the lines and writes an SVG. The completed layout is written
back unless --no-write is given.

  --relayout   auto-layout everything except pinned nodes
  --reset      discard the stored layout and start over
  --fit W:H    re-arrange to fill a frame of that aspect ratio (16:9, 1:1, 210:297)
  --theme X    ${Object.keys(THEMES).join(' | ')} (stored in the layout file)
  --scale N    size of text and icons (1 = 100%), or "max" for the largest that fits`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    out: { type: 'string', short: 'o' },
    relayout: { type: 'boolean', default: false },
    reset: { type: 'boolean', default: false },
    fit: { type: 'string' },
    theme: { type: 'string' },
    scale: { type: 'string' },
    'no-write': { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
});

const file = positionals[0];
if (values.help || !file) {
  console.log(USAGE);
  process.exit(file ? 0 : 1);
}

const { diagram, warnings } = parsePuml(readFileSync(file, 'utf8'));
for (const w of warnings) console.warn(`${file}:${w.line}: ${w.message}: ${w.text.trim()}`);

const layoutPath = layoutPathFor(file);
const before = existsSync(layoutPath) ? readFileSync(layoutPath, 'utf8') : '';
const mode: LayoutMode = values.reset ? 'reset' : values.relayout ? 'auto' : 'fill';
const require = createRequire(import.meta.url);
const avoid = await loadAvoid(join(dirname(require.resolve('libavoid-js')), 'libavoid.wasm'));

let layout = before ? parseLayout(before) : emptyLayout();
if (values.theme) {
  if (!(values.theme in THEMES)) throw new Error(`Unknown theme ${values.theme}; use ${Object.keys(THEMES).join(' or ')}`);
  layout = { ...layout, view: { ...layout.view, theme: values.theme } };
}
layout = await ensureLayout(diagram, layout, mode);
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

const scene = buildScene(diagram, layout, avoid);

const out = values.out ?? file.replace(/\.puml$/, '') + '.svg';
writeFileSync(out, renderToStaticMarkup(createElement(DiagramSvg, { scene, frame: layout.view?.frame })));
console.log(`wrote ${out}`);

const after = serializeLayout(layout);
if (!values['no-write'] && after !== before) {
  writeFileSync(layoutPath, after);
  console.log(`wrote ${layoutPath}`);
}
