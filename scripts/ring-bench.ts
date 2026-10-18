// Clean-template numbers: template bounds area at the default size, and the time of one placement and one fit-to-frame.
// Usage: npx tsx scripts/ring-bench.ts
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fitToFrame } from '../src/layout/fit.ts';
import { emptyLayout } from '../src/layout/layout-file.ts';
import { applyTemplate } from '../src/layout/template/index.ts';
import { parseDiagram } from '../src/model/diagram.ts';
import { loadAvoid } from '../src/scene/avoid.ts';
import { buildScene } from '../src/scene/scene.ts';

const require = createRequire(import.meta.url);
const avoid = await loadAvoid(join(dirname(require.resolve('libavoid-js')), 'libavoid.wasm'));
for (const name of ['clean-flowchart.mmd', 'hexagonal-order-service.puml', 'layered-web-shop.puml']) {
  const { diagram } = parseDiagram(readFileSync(`fixtures/architecture/${name}`, 'utf8'), name);
  let t0 = performance.now();
  const layout = applyTemplate(diagram, emptyLayout(), 'clean');
  const place = performance.now() - t0;
  const b = buildScene(diagram, layout, avoid).template!.bounds;
  t0 = performance.now();
  const fit = await fitToFrame(diagram, layout, [1600, 900]);
  const fitMs = performance.now() - t0;
  console.log(`${name.padEnd(32)} bounds ${Math.round(b.w)}x${Math.round(b.h)} area ${Math.round(b.w * b.h)}  place ${place.toFixed(0)} ms  fit ${fitMs.toFixed(0)} ms (${fit.tried} tried)`);
}
