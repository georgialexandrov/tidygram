// End-to-end smoke test: drives the running editor (pnpm dev) in headless
// Chrome over the DevTools protocol, drags a node and pulls a line, and checks
// what was written to layout.json. Usage: node scripts/smoke.mjs [screenshot.png]
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const URL_ = 'http://localhost:5199/?file=fixtures/food-delivery.puml';
const LAYOUT = new URL('../fixtures/food-delivery.layout.json', import.meta.url);
const PORT = 9333;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const chrome = spawn(CHROME, [
  '--headless=new',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${mkdtempSync(join(tmpdir(), 'puml-smoke-'))}`,
  '--window-size=1600,1000',
  'about:blank',
]);
try {
  let target;
  for (let i = 0; i < 50 && !target; i++) {
    await sleep(100);
    target = await fetch(`http://127.0.0.1:${PORT}/json`)
      .then((r) => r.json())
      .then((list) => list.find((t) => t.type === 'page'))
      .catch(() => undefined);
  }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r));
  let id = 0;
  const pending = new Map();
  const logs = [];
  ws.addEventListener('message', (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && pending.has(msg.id)) pending.get(msg.id)(msg);
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') logs.push(msg.params.args.map((a) => a.value ?? a.description).join(' '));
    if (msg.method === 'Runtime.exceptionThrown') logs.push(msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text);
  });
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const n = ++id;
      pending.set(n, (msg) => (msg.error ? reject(new Error(`${method}: ${msg.error.message}`)) : resolve(msg.result)));
      ws.send(JSON.stringify({ id: n, method, params }));
    });
  const evaluate = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true })).result.value;
  // Alt held: no alignment snapping, so the drag distance is exact.
  const mouse = (type, x, y, buttons = 1) => send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons, clickCount: 1, modifiers: 1 });
  const drag = async (from, to, steps = 12) => {
    await mouse('mouseMoved', from[0], from[1], 0);
    await mouse('mousePressed', from[0], from[1]);
    for (let i = 1; i <= steps; i++) await mouse('mouseMoved', from[0] + ((to[0] - from[0]) * i) / steps, from[1] + ((to[1] - from[1]) * i) / steps);
    await mouse('mouseReleased', to[0], to[1], 0);
  };
  const centreOf = (selector) =>
    evaluate(`(() => { const r = document.querySelector(${JSON.stringify(selector)})?.getBoundingClientRect(); return r && [r.x + r.width / 2, r.y + r.height / 2]; })()`);

  await send('Runtime.enable');
  await send('Page.enable');
  await send('Page.navigate', { url: URL_ });
  for (let i = 0; i < 50; i++) {
    await sleep(200);
    if (await evaluate(`document.querySelectorAll('[data-id]').length`)) break;
  }
  await sleep(800); // initial layout save
  const nodes = await evaluate(`document.querySelectorAll('[data-id]').length`);
  const edges = await evaluate(`document.querySelectorAll('[data-edge]').length`);
  const before = JSON.parse(readFileSync(LAYOUT, 'utf8'));

  const k = await evaluate(`document.querySelector('.canvas > g').transform.baseVal.consolidate().matrix.a`);

  // 1. Drag a node 120px right, 60px down.
  const admin = await centreOf('[data-id="Admin"] circle');
  await drag(admin, [admin[0] + 120, admin[1] + 60]);
  await sleep(600);
  const afterDrag = JSON.parse(readFileSync(LAYOUT, 'utf8'));

  // 2. Pull a line sideways to add a bend.
  const edgeMid = await evaluate(`(() => {
    const p = document.querySelector('[data-edge="UC_Pay-->PSP"] path');
    const len = p.getTotalLength(); const pt = p.getPointAtLength(len / 2);
    const m = p.getScreenCTM(); return [pt.x * m.a + m.e, pt.y * m.d + m.f];
  })()`);
  await drag(edgeMid, [edgeMid[0] + 40, edgeMid[1] + 80]);
  await sleep(600);
  const afterBend = JSON.parse(readFileSync(LAYOUT, 'utf8'));

  // 3. Undo the bend.
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'z', code: 'KeyZ', modifiers: 4, windowsVirtualKeyCode: 90 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'z', code: 'KeyZ', modifiers: 4, windowsVirtualKeyCode: 90 });
  await sleep(600);
  const afterUndo = JSON.parse(readFileSync(LAYOUT, 'utf8'));

  // 4. Modern theme, 16:9 frame, fit to frame, grid off.
  const choose = (index, value) =>
    evaluate(`(() => {
      const el = document.querySelectorAll('.toolbar select')[${index}];
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(el, ${JSON.stringify(value)});
      el.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
  await choose(1, 'modern');
  await sleep(300);
  await choose(3, '16:9');
  await sleep(300);
  await evaluate(`[...document.querySelectorAll('.toolbar button')].find((b) => b.textContent === 'Fit to frame').click()`);
  let fitted = false;
  for (let i = 0; i < 60 && !fitted; i++) {
    await sleep(250);
    fitted = await evaluate(`document.querySelector('.busy')?.textContent.startsWith('Fitted') ?? false`);
  }
  await evaluate(`document.querySelector('.toggle input').click()`);
  await sleep(800);
  const afterFit = JSON.parse(readFileSync(LAYOUT, 'utf8'));
  const busyText = await evaluate(`document.querySelector('.busy')?.textContent ?? ''`);
  const gridShown = await evaluate(`!!document.querySelector('rect[fill="url(#grid)"]')`);

  // 5. Text +2 steps, icons +1, source panel shows the selected element's line.
  const beforeSteps = JSON.parse(readFileSync(LAYOUT, 'utf8')).view ?? {};
  const clickLabel = (label) => evaluate(`document.querySelector('[aria-label="${label}"]').click()`);
  await clickLabel('Larger text');
  await sleep(150);
  await clickLabel('Larger text');
  await sleep(150);
  await clickLabel('Larger icons');
  await sleep(150);
  await evaluate(`[...document.querySelectorAll('.toolbar button')].find((b) => b.textContent === 'Source').click()`);
  await sleep(300);
  const login = await centreOf('[data-id="UC_Login"]');
  if (process.env.SMOKE_DEBUG) console.log('at login:', login, await evaluate(`(() => { const el = document.elementFromPoint(${login[0]}, ${login[1]}); return el?.outerHTML.slice(0, 160) + ' | parent ' + el?.parentElement?.outerHTML.slice(0, 120); })()`));
  await mouse('mouseMoved', login[0], login[1], 0);
  await mouse('mousePressed', login[0], login[1]);
  await mouse('mouseReleased', login[0], login[1], 0);
  await sleep(800);
  const afterSteps = JSON.parse(readFileSync(LAYOUT, 'utf8'));
  const highlighted = await evaluate(`[...document.querySelectorAll('.src-line.hl')].map((l) => l.textContent)`);

  const shot = process.argv[2];
  if (shot) writeFileSync(shot, Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));

  const results = {
    rendered: `${nodes} nodes, ${edges} edges`,
    zoom: k.toFixed(3),
    adminBefore: before.nodes.Admin,
    adminAfter: afterDrag.nodes.Admin,
    expectedDelta: [Math.round(120 / k), Math.round(60 / k)],
    bend: afterBend.edges['UC_Pay-->PSP'],
    afterUndo: afterUndo.edges['UC_Pay-->PSP'] ?? null,
    view: afterFit.view,
    fit: busyText,
    gridShown,
    textIcons: [afterSteps.view?.text, afterSteps.view?.icons],
    highlighted,
    browserErrors: logs,
  };
  console.log(JSON.stringify(results, null, 2));
  const ok =
    nodes > 30 &&
    afterDrag.nodes.Admin.pinned === true &&
    Math.abs(afterDrag.nodes.Admin.x - before.nodes.Admin.x - 120 / k) < 2 &&
    Math.abs(afterDrag.nodes.Admin.y - before.nodes.Admin.y - 60 / k) < 2 &&
    afterBend.edges['UC_Pay-->PSP']?.via?.length === 1 &&
    !afterUndo.edges['UC_Pay-->PSP'] &&
    afterFit.view?.theme === 'modern' &&
    afterFit.view?.frame?.join(':') === '16:9' &&
    fitted &&
    !gridShown &&
    Math.abs((afterSteps.view?.text ?? 1) - Math.min(3, (beforeSteps.text ?? 1) + 0.2)) < 0.01 &&
    Math.abs((afterSteps.view?.icons ?? 1) - Math.min(3, (beforeSteps.icons ?? 1) + 0.1)) < 0.01 &&
    highlighted.length === 1 &&
    highlighted[0].includes('UC_Login') &&
    logs.length === 0;
  console.log(ok ? 'SMOKE OK' : 'SMOKE FAILED');
  ws.close();
  process.exitCode = ok ? 0 : 1;
} finally {
  chrome.kill();
}
