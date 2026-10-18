// Renders every graph fixture from scratch (no sidecar is read or written) and prints the
// picture-quality numbers from src/scene/quality.ts, so a layout/routing change can be judged
// across all families at once. Usage: npx tsx scripts/engine.ts <tag> [--png] [filter]
// Writes out/engine/<tag>/<name>.svg (+ .png with --png) and out/engine/<tag>/metrics.json.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ensureLayout, type LayoutMode } from '../src/layout/auto.ts';
import { emptyLayout, type TemplateKind } from '../src/layout/layout-file.ts';
import { applyTemplate } from '../src/layout/template/index.ts';
import { parseDiagram } from '../src/model/diagram.ts';
import { DiagramSvg } from '../src/render/DiagramSvg.tsx';
import { loadAvoid } from '../src/scene/avoid.ts';
import { countCrossings, measureQuality } from '../src/scene/quality.ts';
import { pathLength } from '../src/scene/geometry.ts';
import { buildScene } from '../src/scene/scene.ts';

const args = process.argv.slice(2);
const tag = args.find((a) => !a.startsWith('--')) ?? 'now';
const filter = args.filter((a) => !a.startsWith('--'))[1];
const png = args.includes('--png');
const require = createRequire(import.meta.url);
const avoid = await loadAvoid(join(dirname(require.resolve('libavoid-js')), 'libavoid.wasm'));
const outDir = join('out/engine', tag);
mkdirSync(outDir, { recursive: true });

const TEMPLATES: Record<string, TemplateKind> = {
  'architecture/hexagonal-order-service.puml': 'hexagonal',
  'architecture/layered-web-shop.puml': 'layered',
  'architecture/clean-flowchart.mmd': 'clean',
  'architecture/c4-container.puml': 'layered',
  'architecture/tiers.drawio': 'layered',
};

const files = ['', 'mermaid', 'drawio', 'architecture'].flatMap((dir) =>
  readdirSync(join('fixtures', dir))
    .filter((f) => /\.(puml|mmd|drawio)$/.test(f))
    .map((f) => (dir ? `${dir}/${f}` : f)),
);

const rows: Record<string, unknown>[] = [];
for (const file of files) {
  if (filter && !file.includes(filter)) continue;
  const source = readFileSync(join('fixtures', file), 'utf8');
  const first = parseDiagram(source, file);
  const pages = first.pages?.length ?? 1;
  for (let page = 0; page < pages; page++) {
    const { diagram } = pages > 1 ? parseDiagram(source, file, { page }) : first;
    if (diagram.special || !diagram.nodes.length) continue;
    const runs: [string, LayoutMode, TemplateKind?][] = file.endsWith('.drawio') ? [['file', 'reset'], ['auto', 'auto']] : [['auto', 'auto']];
    if (TEMPLATES[file] && page === 0) runs.push([TEMPLATES[file]!, 'auto', TEMPLATES[file]]);
    for (const [variant, mode, template] of runs) {
      let layout = await ensureLayout(diagram, emptyLayout(), mode);
      if (template) layout = applyTemplate(diagram, layout, template);
      const started = performance.now();
      const scene = buildScene(diagram, layout, avoid);
      const ms = performance.now() - started;
      const q = measureQuality(scene, diagram);
      const name = `${file.replace(/[/.]/g, '_')}${pages > 1 ? `-p${page + 1}` : ''}-${variant}`;
      const svg = join(outDir, `${name}.svg`);
      writeFileSync(svg, renderToStaticMarkup(createElement(DiagramSvg, { scene })));
      if (png) execFileSync('sh', ['scripts/png.sh', svg, svg.replace(/\.svg$/, '.png'), '1400']);
      const { details, ...numbers } = q;
      // Crossings between lines, and the longest line as a share of the picture's width.
      const crossings = countCrossings(scene.edges.map((e) => e.points));
      const longest = Math.max(0, ...scene.edges.map((e) => pathLength(e.points))) / Math.max(1, scene.bounds.w);
      rows.push({ name, ...numbers, crossings, longest: Math.round(longest * 100) / 100, aspect: Math.round(q.aspect * 100) / 100, ms: Math.round(ms), details });
    }
  }
}

const cols = ['containerCrossings', 'titleCrossings', 'nodeCrossings', 'labelOverlaps', 'labelLineOverlaps', 'bends', 'jogs', 'skewEnds', 'crossings', 'longest', 'aspect', 'ms'];
const short = ['cont', 'title', 'node', 'lab', 'labLn', 'bends', 'jogs', 'skew', 'cross', 'long', 'aspect', 'ms'];
console.log(['name'.padEnd(48), ...short.map((s) => s.padStart(6))].join(''));
for (const r of rows) console.log([String(r.name).padEnd(48), ...cols.map((c) => String(r[c]).padStart(6))].join(''));
const total = (c: string) => rows.reduce((s, r) => s + (typeof r[c] === 'number' ? (r[c] as number) : 0), 0);
console.log(['TOTAL'.padEnd(48), ...cols.slice(0, 9).map((c) => String(total(c)).padStart(6))].join(''));
writeFileSync(join(outDir, 'metrics.json'), JSON.stringify(rows, null, 1));
