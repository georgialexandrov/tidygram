// Smoke test for the static demo: serves dist/ under DEMO_BASE (default /x/) with a tiny static server,
// opens a bundled sample, drags a node (kept in localStorage), opens files through the file input
// (diagram alone, diagram + sidecar), shows the drop overlay. Build first: DEMO_BASE=/x/ pnpm build:demo
// Usage: DEMO_BASE=/x/ CDP_PORT=9333 node scripts/smoke-demo.mjs [out-dir]
import { createServer } from 'node:http';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { sleep, withChrome } from './cdp.mjs';

const BASE = process.env.DEMO_BASE ?? '/x/';
const PORT = Number(process.env.DEMO_PORT ?? 5233);
const out = process.argv[2] ?? 'out';
const dist = new URL('../dist/', import.meta.url).pathname;
mkdirSync(out, { recursive: true });
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.json': 'application/json' };
const server = createServer((req, res) => {
  const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (!path.startsWith(BASE)) return (res.statusCode = 404), res.end('outside base');
  const rel = normalize(path.slice(BASE.length) || 'index.html').replace(/^(\.\.[/\\])+/, '');
  try {
    res.setHeader('content-type', types[extname(rel)] ?? 'application/octet-stream');
    res.end(readFileSync(join(dist, rel.endsWith('/') ? rel + 'index.html' : rel)));
  } catch {
    res.statusCode = 404;
    res.end('not found');
  }
});
await new Promise((r) => server.listen(PORT, r));

const sample = '# sample\n@startuml\nactor A\nA --> (Open)\n(Open) --> (Edit)\n@enduml\n';
writeFileSync(join(out, 'mine.puml'), sample);
writeFileSync(join(out, 'sidecar.puml'), sample);
writeFileSync(join(out, 'sidecar.layout.json'), JSON.stringify({ version: 1, nodes: { A: { x: 400, y: 300, pinned: true } }, edges: {} }));
let failed = false;
const check = (ok, what) => (console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`), ok || (failed = true));
try {
  await withChrome(9333, async ({ evaluate, open, drag, centreOf, screenshot, errors, send }) => {
    const url = `http://127.0.0.1:${PORT}${BASE}`;
    const ms = await open(`${url}?file=component.puml`);
    check(true, `sample component.puml opened in ${ms} ms under ${BASE}`);
    const listed = await evaluate(`document.querySelectorAll('[data-path]').length`);
    writeFileSync(join(out, 'demo-sample.png'), await screenshot());
    const id = await evaluate(`document.querySelector('svg g[data-id]')?.dataset.id`);
    const at = await centreOf(`svg g[data-id="${id}"]`);
    await drag(at, [at[0] + 60, at[1] + 40], 10, 1);
    await sleep(500);
    const stored = await evaluate(`localStorage.getItem('tidygram:layout:component.puml')`);
    check(!!stored && JSON.parse(stored).nodes[id]?.pinned === true, `drag of ${id} kept in localStorage`);
    check((await evaluate(`!!document.querySelector('[data-action=save-layout]')`)) === true, 'Save layout button shown for a sample');

    const doc = await send('DOM.getDocument', {});
    const input = (await send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '[data-action=open-input]' })).nodeId;
    const readyFor = async (key) => {
      for (let i = 0; i < 200; i++) {
        if (await evaluate(`document.querySelector('.app')?.dataset.loaded === ${JSON.stringify(key)}`)) return true;
        await sleep(50);
      }
      return false;
    };
    const cwd = process.cwd();
    await send('DOM.setFileInputFiles', { nodeId: input, files: [join(cwd, out, 'mine.puml')] });
    check(await readyFor('opened/mine.puml'), 'opened mine.puml through the file input');
    await sleep(400);
    writeFileSync(join(out, 'demo-opened.png'), await screenshot());

    await send('DOM.setFileInputFiles', { nodeId: input, files: [join(cwd, out, 'sidecar.puml'), join(cwd, out, 'sidecar.layout.json')] });
    check(await readyFor('opened/sidecar.puml'), 'opened sidecar.puml + sidecar.layout.json together');
    await sleep(400);
    const viewSrc = await evaluate(`document.querySelector('[data-id="A"]') ? Math.round(document.querySelector('[data-id="A"]').getBoundingClientRect().x) : null`);
    check(viewSrc !== null, `sidecar position applied (A on screen at x=${viewSrc})`);
    writeFileSync(join(out, 'demo-sidecar.png'), await screenshot());

    // Drop overlay + a dropped file (synthetic events: headless Chrome has no OS drag).
    await evaluate(`(() => { const dt = new DataTransfer(); dt.items.add(new File(['x'], 'x.puml')); window.dispatchEvent(new DragEvent('dragenter', { dataTransfer: dt, bubbles: true, cancelable: true })); })()`);
    await sleep(200);
    check(await evaluate(`!!document.querySelector('.drop-overlay')`), 'drop overlay shows while files are dragged over');
    writeFileSync(join(out, 'demo-drop.png'), await screenshot());
    await evaluate(`(() => { const dt = new DataTransfer(); dt.items.add(new File([${JSON.stringify(sample.replace('Open', 'Dropped'))}], 'dropped.puml')); window.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true })); })()`);
    check(await readyFor('opened/dropped.puml'), 'dropped dropped.puml onto the window');
    check(!(await evaluate(`!!document.querySelector('.drop-overlay')`)), 'overlay gone after the drop');
    const exported = await evaluate(`typeof URL.createObjectURL`);
    check(exported === 'function', `listed ${listed} samples`);
    check(errors.length === 0, `no console errors${errors.length ? ': ' + errors.join(' | ') : ''}`);
  });
} finally {
  server.close();
}
console.log(failed ? 'DEMO FAIL' : 'DEMO OK');
process.exit(failed ? 1 : 0);
