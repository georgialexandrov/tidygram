// Opens every fixture in the running editor (pnpm dev) and checks it renders without errors and
// how long it took; `unsupported/` fixtures must show the "not supported" panel and write no sidecar.
// Drags a sequence participant and checks the column is stored; switches draw.io pages and checks
// each page's layout lands in its own place in the sidecar. Restores layout files after.
// Usage: node scripts/smoke-types.mjs [screenshot-dir]
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { withChrome, sleep } from './cdp.mjs';

const dir = new URL('../fixtures/', import.meta.url);
// Mermaid and draw.io fixtures live in their own folders: `class.mmd` or `er.drawio` next to
// `class.puml`/`er.puml` would share one sidecar.
const files = [
  ...readdirSync(dir).filter((f) => /\.(puml|mmd)$/.test(f)).sort(),
  ...readdirSync(new URL('mermaid/', dir)).filter((f) => /\.mmd$/.test(f)).sort().map((f) => `mermaid/${f}`),
  ...readdirSync(new URL('drawio/', dir)).filter((f) => /\.drawio(\.xml)?$/.test(f)).sort().map((f) => `drawio/${f}`),
  ...readdirSync(new URL('unsupported/', dir)).sort().map((f) => `unsupported/${f}`),
];
const unsupported = (f) => f.startsWith('unsupported/');
const layoutOf = (f) => new URL(f.replace(/(\.drawio)?\.\w+$/, '.layout.json'), dir);
const saved = new Map(files.map((f) => [f, existsSync(layoutOf(f)) ? readFileSync(layoutOf(f), 'utf8') : null]));

let ok = true;
const started = Date.now();
try {
  await withChrome(9340, async ({ evaluate, open, drag, centreOf, screenshot, errors }) => {
    for (const f of files) {
      const ms = await open(`http://localhost:5199/?file=fixtures/${f}`);
      const count = await evaluate(`[document.querySelectorAll('[data-id]').length, document.querySelectorAll('[data-edge]').length, document.querySelector('.toolbar .warn')?.textContent ?? '', document.querySelector('.blank-panel')?.dataset.blank ?? '']`);
      const nan = await evaluate(`document.querySelector('.canvas').innerHTML.includes('NaN')`);
      let pass = !nan && errors.length === 0;
      if (unsupported(f)) {
        await sleep(400); // a sidecar write would be debounced by 250 ms
        pass &&= count[3] === 'unsupported' && count[0] + count[1] === 0 && !existsSync(layoutOf(f));
      } else pass &&= count[0] + count[1] > 0 && !count[3];
      ok &&= pass;
      const what = unsupported(f) ? `"not supported" panel: ${count[3] || 'missing'}, sidecar written: ${existsSync(layoutOf(f))}` : `${count[0]} elements, ${count[1]} lines`;
      console.log(`${pass ? 'ok  ' : 'FAIL'} ${f.padEnd(26)} ${String(ms).padStart(5)} ms  ${what}${count[2] ? `, ${count[2]} warnings` : ''}${nan ? ', NaN in SVG' : ''}${errors.length ? `, errors: ${errors.join(' | ')}` : ''}`);
      errors.length = 0;
      if (process.argv[2]) {
        mkdirSync(dirname(`${process.argv[2]}/${f}`), { recursive: true });
        writeFileSync(`${process.argv[2]}/${f}.png`, await screenshot());
      }
    }

    // Sequence: drag the last participant to the far left; it should become the first column.
    await open('http://localhost:5199/?file=fixtures/sequence.puml');
    const before = await evaluate(`[...document.querySelectorAll('[data-id]')].slice(0, 7).map((g) => g.getAttribute('data-id'))`);
    const stripe = await centreOf('[data-id="Stripe"] path, [data-id="Stripe"] rect');
    const customer = await centreOf('[data-id="C"]');
    await drag(stripe, [customer[0] - 120, stripe[1]], 12);
    await sleep(700);
    const layout = JSON.parse(readFileSync(layoutOf('sequence.puml'), 'utf8'));
    const xs = await evaluate(`Object.fromEntries([...document.querySelectorAll('[data-id]')].map((g) => [g.getAttribute('data-id'), g.getBoundingClientRect().x]))`);
    const pass = layout.nodes.Stripe?.pinned === true && xs.Stripe < xs.C && errors.length === 0;
    ok &&= pass;
    console.log(`${pass ? 'ok  ' : 'FAIL'} sequence column drag: Stripe stored at x=${layout.nodes.Stripe?.x}, now left of Customer: ${xs.Stripe < xs.C} (order before: ${before.join(',')})`);

    // draw.io pages: the selector only on multi-page files; page 2's drag lands under pages.p2, page 1 stays put.
    await open('http://localhost:5199/?file=fixtures/drawio/flowchart.drawio');
    const singleHasPicker = await evaluate(`!!document.querySelector('.page-select')`);
    await open('http://localhost:5199/?file=fixtures/drawio/pages.drawio');
    const options = await evaluate(`[...document.querySelectorAll('.page-select option')].map((o) => o.value)`);
    // draw.io files draw where the file says, so page 1 may have no sidecar entries (or no sidecar) yet.
    const readPages = () => (existsSync(layoutOf('drawio/pages.drawio')) ? JSON.parse(readFileSync(layoutOf('drawio/pages.drawio'), 'utf8')) : { nodes: {} });
    await sleep(500); // the first open writes page 1's filled-in layout, debounced
    const top = readPages().nodes;
    await evaluate(`(() => { const s = document.querySelector('.page-select'); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(s, 'p2'); s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    for (let i = 0; i < 100 && (await evaluate(`document.querySelector('.app').dataset.page`)) !== 'p2'; i++) await sleep(50);
    const pageUrl = await evaluate(`new URLSearchParams(location.search).get('page')`);
    const d1 = await centreOf('[data-id="d1"]');
    await drag(d1, [d1[0] + 80, d1[1] + 40], 10, 0);
    await sleep(700);
    const paged = readPages();
    await open('http://localhost:5199/?file=fixtures/drawio/pages.drawio&page=p3');
    const deep = await evaluate(`[document.querySelector('.app').dataset.page, [...document.querySelectorAll('[data-id]')].map((g) => g.dataset.id).join()]`);
    const pagesPass =
      !singleHasPicker &&
      options.join() === 'p1,p2,p3' &&
      pageUrl === 'p2' &&
      paged.pages?.p2?.nodes?.d1?.pinned === true &&
      JSON.stringify(paged.nodes) === JSON.stringify(top) &&
      deep[0] === 'p3' &&
      deep[1] === 'n1' &&
      errors.length === 0;
    ok &&= pagesPass;
    console.log(
      `${pagesPass ? 'ok  ' : 'FAIL'} draw.io pages: selector on single page ${singleHasPicker}, pages ${options.join(',')}, ?page=${pageUrl}, p2/d1 stored ${JSON.stringify(paged.pages?.p2?.nodes?.d1)}, page 1 untouched ${JSON.stringify(paged.nodes) === JSON.stringify(top)}, deep link ${deep.join(' → ')}`,
    );
  });
} finally {
  for (const [f, text] of saved) {
    if (text === null) rmSync(layoutOf(f), { force: true });
    else writeFileSync(layoutOf(f), text);
  }
}
console.log(`${ok ? 'TYPES OK' : 'TYPES FAILED'} in ${((Date.now() - started) / 1000).toFixed(1)} s`);
process.exitCode = ok ? 0 : 1;
