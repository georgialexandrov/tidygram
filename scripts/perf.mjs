// Measures drag responsiveness in the running editor (pnpm dev): 60 pointer moves on one node,
// then prints window.__perf.summary(). Usage: node scripts/perf.mjs [theme] [fit]
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = Number(process.env.CDP_PORT ?? 9334);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${mkdtempSync(join(tmpdir(), 'puml-perf-'))}`, '--window-size=1600,1000', 'about:blank']);
try {
  let target;
  for (let i = 0; i < 50 && !target; i++) {
    await sleep(100);
    target = await fetch(`http://127.0.0.1:${PORT}/json`).then((r) => r.json()).then((l) => l.find((t) => t.type === 'page')).catch(() => undefined);
  }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r));
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && pending.has(msg.id)) pending.get(msg.id)(msg);
  });
  const send = (method, params = {}) => new Promise((ok) => { const n = ++id; pending.set(n, (msg) => ok(msg.result)); ws.send(JSON.stringify({ id: n, method, params })); });
  const evaluate = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result.value;
  const mouse = (type, x, y, buttons = 1) => send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons, clickCount: 1, modifiers: 1 });

  await send('Page.navigate', { url: `http://localhost:${process.env.PUML_PORT ?? 5199}/?file=fixtures/food-delivery.puml` });
  for (let i = 0; i < 50; i++) { await sleep(200); if (await evaluate(`document.querySelectorAll('[data-id]').length`)) break; }
  await sleep(1000);
  await evaluate('window.__perf.reset()');
  const [x, y] = await evaluate(`(() => { const r = document.querySelector('[data-id="UC_Login"]').getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()`);
  await mouse('mouseMoved', x, y, 0);
  await mouse('mousePressed', x, y);
  for (let i = 1; i <= 60; i++) { await mouse('mouseMoved', x + i * 4, y + Math.sin(i / 6) * 40); await sleep(16); }
  await mouse('mouseReleased', x + 240, y, 0);
  await sleep(500);
  console.log(JSON.stringify(await evaluate('window.__perf.summary()'), null, 1));
  // Revert the drag so the fixture's layout is unchanged.
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'z', code: 'KeyZ', modifiers: 4, windowsVirtualKeyCode: 90 });
  await sleep(500);
  ws.close();
} finally {
  chrome.kill();
}
