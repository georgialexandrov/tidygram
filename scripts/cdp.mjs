// Minimal Chrome DevTools Protocol harness for the browser tests.
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function withChrome(port, fn) {
  port = process.env.CDP_PORT ?? port;
  const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${mkdtempSync(join(tmpdir(), 'puml-cdp-'))}`, '--window-size=1600,1000', 'about:blank']);
  try {
    let target;
    for (let i = 0; i < 50 && !target; i++) {
      await sleep(100);
      target = await fetch(`http://127.0.0.1:${port}/json`).then((r) => r.json()).then((l) => l.find((t) => t.type === 'page')).catch(() => undefined);
    }
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((r) => ws.addEventListener('open', r));
    let id = 0;
    const pending = new Map();
    const errors = [];
    ws.addEventListener('message', (m) => {
      const msg = JSON.parse(m.data);
      if (msg.id && pending.has(msg.id)) pending.get(msg.id)(msg);
      globalThis.__cdpOnEvent?.(msg);
      if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') errors.push(msg.params.args.map((a) => a.value ?? a.description).join(' '));
      if (msg.method === 'Runtime.exceptionThrown') errors.push(msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text);
    });
    const send = (method, params = {}) =>
      new Promise((ok, fail) => {
        const n = ++id;
        pending.set(n, (msg) => (msg.error ? fail(new Error(`${method}: ${msg.error.message}`)) : ok(msg.result)));
        ws.send(JSON.stringify({ id: n, method, params }));
      });
    const evaluate = async (expression) => {
      const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
      return r.result.value;
    };
    const mouse = (type, x, y, buttons = 1, modifiers = 0) => send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons, clickCount: 1, modifiers });
    const drag = async (from, to, steps = 10, modifiers = 1) => {
      await mouse('mouseMoved', from[0], from[1], 0, modifiers);
      await mouse('mousePressed', from[0], from[1], 1, modifiers);
      for (let i = 1; i <= steps; i++) await mouse('mouseMoved', from[0] + ((to[0] - from[0]) * i) / steps, from[1] + ((to[1] - from[1]) * i) / steps, 1, modifiers);
      await mouse('mouseReleased', to[0], to[1], 0, modifiers);
    };
    /**
     * Navigates and waits for the editor's ready signal: `.app[data-loaded]` names the file once its
     * scene (or the "not supported" panel) is committed. Compares the decoded `file` param; the
     * editor's URL may encode `/` either way. Returns the ms from navigate to ready.
     */
    const open = async (url) => {
      const t0 = Date.now();
      await send('Page.navigate', { url });
      const file = new URL(url).searchParams.get('file') ?? '';
      let ready = false;
      for (let i = 0; i < 300 && !ready; i++) {
        await sleep(50);
        ready = await evaluate(`new URLSearchParams(location.search).get('file') === ${JSON.stringify(file)} && document.querySelector('.app')?.dataset.loaded === ${JSON.stringify(file)}`).catch(() => false);
      }
      if (!ready) {
        const seen = await evaluate(`JSON.stringify({ href: location.href, loaded: document.querySelector('.app')?.dataset.loaded, error: document.querySelector('.error')?.textContent })`).catch((e) => String(e));
        throw new Error(`open: ${file} did not load within 15 s (${seen}; console: ${errors.join(' | ') || 'none'})`);
      }
      const ms = Date.now() - t0;
      // Two frames: the fit-on-open effect has run and painted.
      await evaluate(`new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))`);
      return ms;
    };
    const centreOf = (selector) => evaluate(`(() => { const r = document.querySelector(${JSON.stringify(selector)})?.getBoundingClientRect(); return r && [r.x + r.width / 2, r.y + r.height / 2]; })()`);
    const screenshot = async () => Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).data, 'base64');
    await send('Runtime.enable');
    await send('Page.enable');
    const result = await fn({ send, evaluate, mouse, drag, open, centreOf, screenshot, errors });
    ws.close();
    return result;
  } finally {
    chrome.kill();
  }
}
