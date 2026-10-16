// Opens every fixture in the running editor (pnpm dev) and checks it renders without errors;
// drags a sequence participant and checks the column is stored. Restores layout files after.
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { withChrome, sleep } from './cdp.mjs';

const dir = new URL('../fixtures/', import.meta.url);
const files = readdirSync(dir).filter((f) => /\.(puml|mmd)$/.test(f)).sort();
const layoutOf = (f) => new URL(f.replace(/\.\w+$/, '.layout.json'), dir);
const saved = new Map(files.map((f) => [f, existsSync(layoutOf(f)) ? readFileSync(layoutOf(f), 'utf8') : null]));

let ok = true;
try {
  await withChrome(9340, async ({ evaluate, open, drag, centreOf, screenshot, errors }) => {
    for (const f of files) {
      await open(`http://localhost:5199/?file=fixtures/${f}`);
      const count = await evaluate(`[document.querySelectorAll('[data-id]').length, document.querySelectorAll('[data-edge]').length, document.querySelector('.warnings, .toolbar .warn')?.textContent ?? '']`);
      const nan = await evaluate(`document.querySelector('.canvas').innerHTML.includes('NaN')`);
      const pass = count[0] + count[1] > 0 && !nan && errors.length === 0;
      ok &&= pass;
      console.log(`${pass ? 'ok  ' : 'FAIL'} ${f.padEnd(22)} ${count[0]} elements, ${count[1]} lines${count[2] ? `, ${count[2]}` : ''}${nan ? ', NaN in SVG' : ''}${errors.length ? `, errors: ${errors.join(' | ')}` : ''}`);
      errors.length = 0;
      if (process.argv[2]) writeFileSync(`${process.argv[2]}/${f}.png`, await screenshot());
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
  });
} finally {
  for (const [f, text] of saved) {
    if (text === null) rmSync(layoutOf(f), { force: true });
    else writeFileSync(layoutOf(f), text);
  }
}
console.log(ok ? 'TYPES OK' : 'TYPES FAILED');
process.exitCode = ok ? 0 : 1;
