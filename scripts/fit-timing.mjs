// Clicks "Fit to frame" N times in the running editor and prints the phase timings.
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const PORT = 9335;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${mkdtempSync(join(tmpdir(), 'puml-fit-'))}`, '--window-size=1600,1000', 'about:blank']);
try {
  let target;
  for (let i = 0; i < 50 && !target; i++) { await sleep(100); target = await fetch(`http://127.0.0.1:${PORT}/json`).then((r) => r.json()).then((l) => l.find((t) => t.type === 'page')).catch(() => undefined); }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r));
  let id = 0; const pending = new Map();
  ws.addEventListener('message', (m) => { const msg = JSON.parse(m.data); if (msg.id && pending.has(msg.id)) pending.get(msg.id)(msg); });
  const send = (method, params = {}) => new Promise((ok) => { const n = ++id; pending.set(n, (msg) => ok(msg.result)); ws.send(JSON.stringify({ id: n, method, params })); });
  const evaluate = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true })).result.value;
  await send('Page.navigate', { url: 'http://localhost:5199/?file=fixtures/food-delivery.puml' });
  for (let i = 0; i < 50; i++) { await sleep(200); if (await evaluate(`document.querySelectorAll('[data-id]').length`)) break; }
  await sleep(500);
  for (let run = 0; run < 3; run++) {
    await evaluate(`[...document.querySelectorAll('.toolbar button')].find((b) => b.textContent === 'Fit to frame').click()`);
    for (let i = 0; i < 80; i++) { await sleep(100); if (await evaluate(`document.querySelector('.busy')?.textContent.startsWith('Fitted') ?? false`)) break; }
    await sleep(300);
  }
  console.log(JSON.stringify(await evaluate('window.__perf.summary()')));
  for (let i = 0; i < 3; i++) { await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'z', code: 'KeyZ', modifiers: 4, windowsVirtualKeyCode: 90 }); await sleep(200); }
  ws.close();
} finally { chrome.kill(); }
