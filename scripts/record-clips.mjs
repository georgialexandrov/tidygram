// Records the narrated-film clips: one clip per beat, no captions, visible cursor, constant-rate webm.
// Build first: DEMO_BASE=/x/ pnpm build:demo
// Usage: DEMO_FILES=/path/with/v1,v2 CLIPS_OUT=/path/out CDP_PORT=9351 node scripts/record-clips.mjs [clip ...]
// Clips: hook, walk, export, survive, formats (stills). Markers (times in seconds within a clip) go to <name>.json.
// DEMO_FILES holds v1/shop.puml and v2/shop.puml (the same file before and after its author edits it).
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync, copyFileSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { sleep, withChrome } from './cdp.mjs';

process.env.CDP_PORT ??= '9351';
const BASE = '/x/';
const PORT = Number(process.env.DEMO_PORT ?? 5236);
const W = 1280;
const H = 720;
const DSF = 1.2;
const FFMPEG = process.env.FFMPEG ?? 'ffmpeg';
const dist = new URL('../dist/', import.meta.url).pathname;
const fixtures = new URL('../fixtures/', import.meta.url).pathname;
const files = process.env.DEMO_FILES ?? '/tmp/tidy-demo';
const out = process.env.CLIPS_OUT ?? new URL('../out/clips/', import.meta.url).pathname;
mkdirSync(out, { recursive: true });
const want = new Set(process.argv.slice(2));
const on = (n) => want.size === 0 || want.has(n);

const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.json': 'application/json', '.svg': 'image/svg+xml' };
const server = createServer((req, res) => {
  const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (path.startsWith('/exported/')) {
    res.setHeader('content-type', types[extname(path)] ?? 'text/html');
    try { return res.end(readFileSync(join(files, 'exported', path.slice(10)))); } catch { res.statusCode = 404; return res.end(); }
  }
  if (!path.startsWith(BASE)) return (res.statusCode = 404), res.end('outside base');
  const rel = normalize(path.slice(BASE.length) || 'index.html').replace(/^(\.\.[/\\])+/, '');
  try {
    res.setHeader('content-type', types[extname(rel)] ?? 'application/octet-stream');
    res.end(readFileSync(join(dist, rel.endsWith('/') ? rel + 'index.html' : rel)));
  } catch { res.statusCode = 404; res.end('not found'); }
});
await new Promise((r) => server.listen(PORT, r));
const base = `http://127.0.0.1:${PORT}${BASE}`;

const overlay = `(() => {
  if (document.getElementById('demo-cursor')) return;
  const st = document.createElement('style');
  st.textContent = \`
    #demo-cursor{position:fixed;left:0;top:0;width:18px;height:18px;margin:-9px 0 0 -9px;border-radius:50%;background:rgba(20,20,20,.85);border:2px solid #fff;box-shadow:0 1px 6px rgba(0,0,0,.4);pointer-events:none;z-index:99999;transition:width .12s, height .12s, margin .12s}
    #demo-cursor.down{width:12px;height:12px;margin:-6px 0 0 -6px;background:rgba(200,40,40,.9)}
    .glow-new{filter:drop-shadow(0 0 7px #ff8a1f) drop-shadow(0 0 14px #ff8a1f)}\`;
  document.head.append(st);
  const c = document.createElement('div'); c.id = 'demo-cursor'; c.style.transform = 'translate(' + (window.__cx ?? 640) + 'px,' + (window.__cy ?? 360) + 'px)'; document.body.append(c);
})()`;

const ease = (t) => t * t * (3 - 2 * t);

async function session(name, body, { record = true, w: SW, h: SH, dsf: SD } = {}) {
  const W = SW ?? 1280, H = SH ?? 720, DSF = SD ?? 1.2;
  const frames = join(out, `${name}-frames`);
  rmSync(frames, { recursive: true, force: true });
  mkdirSync(frames, { recursive: true });
  const shots = [];
  const marks = {};
  let t0 = null;
  await withChrome(9351, async (cdp) => {
    const { send, evaluate, mouse, open, centreOf } = cdp;
    await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: DSF, mobile: false });
    let cx = 640, cy = 360;
    const place = (x, y) => evaluate(`window.__cx=${x};window.__cy=${y};(c=>c&&(c.style.transform='translate(${x}px,${y}px)'))(document.getElementById('demo-cursor'))`);
    const moveTo = async (x, y, ms = 600, buttons = 0) => {
      const n = Math.max(2, Math.round(ms / 16));
      const [x0, y0] = [cx, cy];
      for (let i = 1; i <= n; i++) {
        const e = ease(i / n);
        const px = x0 + (x - x0) * e, py = y0 + (y - y0) * e;
        await Promise.all([mouse('mouseMoved', px, py, buttons), place(px, py)]);
        await sleep(ms / n);
      }
      [cx, cy] = [x, y];
    };
    const down = (d) => evaluate(`document.getElementById('demo-cursor').classList.${d ? 'add' : 'remove'}('down')`);
    const centre = async (sel) => { const c = await centreOf(sel); if (!c) throw new Error(`no element ${sel}`); return c; };
    const clickAt = async (x, y, ms = 600) => {
      await moveTo(x, y, ms); await down(true);
      await mouse('mousePressed', x, y, 1); await sleep(80); await mouse('mouseReleased', x, y, 0); await down(false); await sleep(120);
    };
    const click = async (sel, ms) => { const [x, y] = await centre(sel); await clickAt(x, y, ms); };
    const tag = (text, sel = 'button') => evaluate(`(() => { const b = [...document.querySelectorAll(${JSON.stringify(sel)})].find((b) => b.textContent.trim().startsWith(${JSON.stringify(text)})); if (!b) return false; b.setAttribute('data-demo', ${JSON.stringify(text)}); return true; })()`).then((ok) => { if (!ok) throw new Error(`no ${sel} ${text}`); return `[data-demo="${text}"]`; });
    const dragNode = async (id, dx, dy, ms = 800) => {
      const [x, y] = await centre(`svg g[data-id="${id}"]`);
      await moveTo(x, y, 450); await down(true); await mouse('mousePressed', x, y, 1); await sleep(80);
      await moveTo(x + dx, y + dy, ms, 1); await mouse('mouseReleased', cx, cy, 0); await down(false); await sleep(150);
    };
    const mark = (n) => { marks[n] = Date.now() / 1000; };
    const loaded = (key) => evaluate(`new Promise((ok, no) => { let n = 0; const t = setInterval(() => { if (document.querySelector('.app')?.dataset.loaded === ${JSON.stringify(key)}) { clearInterval(t); ok(true); } else if (++n > 300) { clearInterval(t); no(new Error('not loaded ${key}')); } }, 30); })`);
    // File chooser interception: a click on Open… hands the given files to the input, like the OS dialog would.
    let chooserFiles = [];
    const chooser = async (msg) => {
      if (msg.method !== 'Page.fileChooserOpened') return;
      await send('DOM.setFileInputFiles', { files: chooserFiles, backendNodeId: msg.params.backendNodeId });
    };
    const chooserPending = [];
    globalThis.__cdpOnEvent = (msg) => {
      if (msg.method === 'Page.screencastFrame' && record) {
        const p = msg.params;
        const file = join(frames, `f${String(shots.length).padStart(5, '0')}.jpg`);
        writeFileSync(file, Buffer.from(p.data, 'base64'));
        const t = p.metadata.timestamp;
        t0 ??= t;
        shots.push({ file, t: t - t0, abs: t });
        void send('Page.screencastFrameAck', { sessionId: p.sessionId }).catch(() => {});
      }
      chooserPending.push(chooser(msg));
    };
    const startCast = async () => { await send('Page.startScreencast', { format: 'jpeg', quality: 90, maxWidth: Math.round(W * DSF), maxHeight: Math.round(H * DSF), everyNthFrame: 1 }); };
    const stopCast = async () => { await send('Page.stopScreencast'); await sleep(250); };
    await send('DOM.enable');
    await send('Page.setInterceptFileChooserDialog', { enabled: true }).catch(() => {});
    const api = { ...cdp, place, moveTo, click, clickAt, centre, tag, dragNode, mark, loaded, down, startCast, stopCast, setFiles: (f) => { chooserFiles = f; }, getXY: () => [cx, cy], sleep, overlay, base };
    await body(api);
  });
  if (!record || !shots.length) return marks;
  const rel = {};
  for (const [k, v] of Object.entries(marks)) rel[k] = +(v - (t0 + 0)).toFixed(3);
  // marks are wall-clock; frames carry the browser clock, which are the same epoch in seconds
  const end = Math.max(shots.at(-1).t, ...Object.values(rel)) + 0.3;
  const list = shots.map((s, i) => `file '${s.file}'\nduration ${((shots[i + 1]?.t ?? end) - s.t).toFixed(4)}`).join('\n') + `\nfile '${shots.at(-1).file}'\n`;
  writeFileSync(join(frames, 'list.txt'), list);
  execFileSync(FFMPEG, ['-y', '-v', 'error', '-f', 'concat', '-safe', '0', '-i', join(frames, 'list.txt'), '-vf', `fps=30,scale=${Math.round(W * DSF)}:${Math.round(H * DSF)}:flags=lanczos:in_range=pc:out_range=tv,format=yuv420p`,
    '-c:v', 'libvpx-vp9', '-crf', '22', '-b:v', '0', '-g', '10', '-row-mt', '1', '-cpu-used', '4', join(out, `${name}.webm`)]);
  writeFileSync(join(out, `${name}.json`), JSON.stringify({ duration: +end.toFixed(3), marks: rel }, null, 1));
  rmSync(frames, { recursive: true, force: true });
  console.log(name, 'duration', end.toFixed(2), JSON.stringify(rel));
  return rel;
}

const drop = (api, paths) => api.evaluate(`(async () => {
  const dt = new DataTransfer();
  for (const [name, text] of ${JSON.stringify(paths)}) dt.items.add(new File([text], name));
  const fire = (type) => window.dispatchEvent(new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true }));
  window.__drop = (type) => fire(type);
})()`);

try {
  // ---- hook: the same fixture with a deliberately scrambled layout --------------------------------
  if (on('hook')) {
    await session('hook', async (api) => {
      await api.open(`${base}?file=food-delivery.puml`);
      await api.evaluate('localStorage.clear()');
      await api.open(`${base}?file=food-delivery.puml`);
      await api.evaluate(`new Promise((ok) => { const t = setInterval(() => { if (localStorage.getItem('tidygram:layout:food-delivery.puml')) { clearInterval(t); ok(1); } }, 50); })`);
      const lay = JSON.parse(await api.evaluate(`localStorage.getItem('tidygram:layout:food-delivery.puml')`));
      let seed = 7;
      const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
      const keys = Object.keys(lay.nodes).filter((k) => k.startsWith('UC_'));
      const pos = keys.map((k) => lay.nodes[k]);
      for (let i = pos.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [pos[i], pos[j]] = [pos[j], pos[i]]; }
      const nodes = { ...lay.nodes };
      keys.forEach((k, i) => { nodes[k] = pos[i]; });
      const scrambled = JSON.stringify({ ...lay, nodes, edges: {} });
      await api.evaluate(`localStorage.setItem('tidygram:layout:food-delivery.puml', ${JSON.stringify(scrambled)})`);
      await api.open(`${base}?file=food-delivery.puml`);
      await api.evaluate(overlay); await api.place(900, 520);
      await sleep(500);
      await api.startCast(); api.mark('start');
      await sleep(600);
      await api.moveTo(780, 430, 1800); await api.moveTo(640, 560, 1800); await api.moveTo(900, 380, 1800);
      await sleep(300); api.mark('end');
      await api.stopCast();
    });
  }

  // ---- walk: open, source panel, drag, layout.json, unchanged source, export --------------------------
  if (on('walk')) {
    mkdirSync(join(files, 'exported'), { recursive: true });
    await session('walk', async (api) => {
      const { evaluate, mouse, sleep } = api;
      const v1 = join(files, 'v1', 'shop.puml');
      await api.open(`${base}?file=component.puml`);
      await evaluate(`localStorage.clear()`);
      await api.open(`${base}?file=component.puml`);
      await evaluate(overlay); await api.place(700, 400);
      await sleep(400);
      await api.startCast(); api.mark('start');
      await sleep(400);
      // Open… (file chooser)
      api.setFiles([v1]);
      await evaluate(`Object.defineProperty(window, 'showOpenFilePicker', { value: undefined, configurable: true }) && 0`);
      await api.click('[data-action="open-file"]', 700); api.mark('openClick');
      await api.loaded('opened/shop.puml'); await sleep(900); api.mark('loaded1');
      // drag and drop over the window, with the "Drop to open" overlay
      await drop(api, [['shop.puml', readFileSync(v1, 'utf8')]]);
      await api.moveTo(640, 300, 500);
      await evaluate(`__drop('dragenter'); __drop('dragover')`); api.mark('dropOver');
      await sleep(850);
      await evaluate(`__drop('drop')`); await sleep(500); await api.loaded('opened/shop.puml'); await sleep(700); api.mark('dropped');
      // Source panel
      await api.click('button.switch', 600); await sleep(500); api.mark('srcShown');
      await sleep(900);
      api.mark('srcHold');
      // move boxes
      const free = async (id, dx, dy) => api.dragNode(id, dx, dy, 700);
      api.mark('drag1'); await free('Web', 300, 10); api.mark('drag1end');
      await free('Payments', 0, -70); api.mark('drag2end');
      await sleep(300);
      // layout.json tab
      await api.click('.source-tabs button:nth-child(2)', 500); api.mark('tabLayout');
      await sleep(700);
      api.mark('drag3'); await free('Gateway', 0, -150); api.mark('drag3end');
      await sleep(1200);
      const layoutJson = await evaluate(`document.querySelector('.layout-json')?.textContent ?? ''`);
      writeFileSync(join(files, 'layout-after.json'), layoutJson);
      await api.click('.source-tabs button:nth-child(1)', 500); api.mark('tabSource');
      await sleep(1600); api.mark('end');
      await api.stopCast();
      // the sidecar for the "author edits" clip, and the exported SVG for the export clip
      writeFileSync(join(files, 'v1', 'shop.layout.json'), layoutJson);
      writeFileSync(join(files, 'v2', 'shop.layout.json'), layoutJson);
      await evaluate(`window.__blobs = []; const o = URL.createObjectURL; URL.createObjectURL = (b) => { window.__blobs.push(b); return o.call(URL, b); }`);
      await evaluate(`localStorage.setItem('walk-state', '1')`);
      const more = await api.tag('More export', 'button').catch(() => null);
      globalThis.__exportReady = true;
    });
  }

  // ---- export: menu, SVG (recorded together with a fresh run so the SVG is the real one) -----------------
  if (on('export')) {
    await session('export', async (api) => {
      const { evaluate, sleep } = api;
      const v1 = join(files, 'v1', 'shop.puml'), side = join(files, 'v1', 'shop.layout.json');
      await api.open(`${base}?file=component.puml`);
      await evaluate(overlay);
      api.setFiles([v1, side]);
      await evaluate(`Object.defineProperty(window, 'showOpenFilePicker', { value: undefined, configurable: true }) && 0`);
      await api.click('[data-action="open-file"]', 300);
      await api.loaded('opened/shop.puml'); await sleep(900);
      await evaluate(`window.__blobs = []; const o = URL.createObjectURL; URL.createObjectURL = (b) => { window.__blobs.push(b); return o.call(URL, b); }`);
      await api.place(900, 300);
      await api.startCast(); api.mark('start');
      await sleep(500);
      await api.click('.export-menu .opener, [aria-label="More export"]', 800).catch(async () => {
        const sel = await api.tag('More export'); await api.click(sel, 800);
      });
      api.mark('menu'); await sleep(700);
      const [mx, my] = await api.centre('[role="menuitem"]');
      await api.moveTo(mx, my, 400); await sleep(350);
      await evaluate(`document.querySelector('[role="menuitem"]').click()`); api.mark('clicked');
      await sleep(900); api.mark('end');
      await api.stopCast();
      const svg = await evaluate(`window.__blobs.length ? window.__blobs.at(-1).text() : ''`);
      if (!svg.includes('<svg')) throw new Error('no exported svg captured');
      writeFileSync(join(files, 'exported', 'shop.svg'), svg);
      writeFileSync(join(files, 'exported', 'view.html'), `<!doctype html><meta charset=utf-8><body style="margin:0;background:#fff;display:grid;place-items:center;height:100vh"><img src="shop.svg" style="height:92vh;width:auto;max-width:94vw">`);
    });
    // The exported file, opened on its own.
    await session('exported-still', async (api) => {
      await api.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/exported/view.html` });
      await sleep(1200);
      writeFileSync(join(out, 'export-view.png'), await api.screenshot());
    }, { record: false }).catch(() => {});
  }

  // ---- survive: the author edits the source; the sidecar stays ---------------------------------------------
  if (on('survive')) {
    await session('survive', async (api) => {
      const { evaluate, sleep } = api;
      const v1 = [join(files, 'v1', 'shop.puml'), join(files, 'v1', 'shop.layout.json')];
      const v2 = [join(files, 'v2', 'shop.puml'), join(files, 'v2', 'shop.layout.json')];
      await api.open(`${base}?file=component.puml`);
      await evaluate(overlay);
      await evaluate(`Object.defineProperty(window, 'showOpenFilePicker', { value: undefined, configurable: true }) && 0`);
      api.setFiles(v1);
      await api.click('[data-action="open-file"]', 300);
      await api.loaded('opened/shop.puml'); await sleep(900);
      await api.place(900, 300);
      await api.startCast(); api.mark('start');
      await sleep(1200);
      api.setFiles(v2);
      await api.click('[data-action="open-file"]', 700); api.mark('reload');
      await sleep(1000);
      await evaluate(`document.querySelector('svg g[data-id="Shipping"]')?.classList.add('glow-new')`); api.mark('glow');
      await sleep(2200); api.mark('end');
      await api.stopCast();
    });
  }

  // ---- drag: a close, large recording of one drag with layout.json open, then back to the unchanged source ----
  if (on('drag')) {
    await session('drag', async (api) => {
      const { evaluate, sleep } = api;
      await api.open(`${base}?file=component.puml`);
      await evaluate(`localStorage.clear()`);
      await api.open(`${base}?file=component.puml`);
      await evaluate(overlay); await api.place(500, 330);
      api.setFiles([join(files, 'v1', 'shop.puml')]);
      await evaluate(`Object.defineProperty(window, 'showOpenFilePicker', { value: undefined, configurable: true }) && 0`);
      await api.click('[data-action="open-file"]', 300);
      await api.loaded('opened/shop.puml'); await sleep(900);
      await api.click('button.switch', 300); await sleep(300);
      await api.click('.source-tabs button:nth-child(2)', 300); await sleep(400);
      await api.place(420, 300);
      await api.startCast(); api.mark('start');
      await sleep(500);
      api.mark('drag1'); await api.dragNode(process.env.DRAG_A ?? 'Orders', Number(process.env.DRAG_AX ?? 90), Number(process.env.DRAG_AY ?? -60), 800); api.mark('drag1end');
      await sleep(500);
      api.mark('drag2'); await api.dragNode(process.env.DRAG_B ?? 'Payments', Number(process.env.DRAG_BX ?? -90), Number(process.env.DRAG_BY ?? 70), 800); api.mark('drag2end');
      await sleep(900);
      await api.click('.source-tabs button:nth-child(1)', 500); api.mark('tabSource');
      await sleep(1500); api.mark('end');
      await api.stopCast();
    }, { w: 1024, h: 576, dsf: 1.875 });
  }

  // ---- formats: the same editor on other diagram types (stills) -------------------------------------------
  if (on('formats')) {
    await session('formats', async (api) => {
      const items = [['sequence.puml', 'sequence'], ['class.puml', 'class'], ['c4.puml', 'c4'], ['mindmap.puml', 'mindmap'], ['mermaid/flowchart.mmd', 'mermaid'], ['drawio/flowchart.drawio', 'drawio'], ['component.puml', 'plantuml']];
      await api.open(`${base}?file=sequence.puml`);
      await api.evaluate('localStorage.clear()');
      for (const [f, n] of items) {
        await api.open(`${base}?file=${encodeURIComponent(f)}`);
        await sleep(700);
        // crop to the diagram itself (16:9), so the tile shows the drawing and not the empty canvas
        const r = await api.evaluate(`(() => { const rs = [...document.querySelectorAll('svg g[data-id]')].map((g) => g.getBoundingClientRect()).filter((b) => b.width > 2 && b.y > 60 && b.x >= 0); if (!rs.length) return null; const x0 = Math.min(...rs.map((b) => b.x)), y0 = Math.min(...rs.map((b) => b.y)), x1 = Math.max(...rs.map((b) => b.right)), y1 = Math.max(...rs.map((b) => b.bottom)); return [x0, y0, x1, y1]; })()`);
        let [x0, y0, x1, y1] = r ?? [0, 60, W, H];
        x0 -= 40; y0 -= 30; x1 += 40; y1 += 30;
        let w = x1 - x0, hh = y1 - y0;
        if (w / hh < 16 / 9) { const nw = hh * 16 / 9; x0 -= (nw - w) / 2; w = nw; } else { const nh = w * 9 / 16; y0 -= (nh - hh) / 2; hh = nh; }
        x0 = Math.max(0, x0); y0 = Math.max(52, y0); w = Math.min(w, W - x0); hh = w * 9 / 16;
        const shot = await api.send('Page.captureScreenshot', { format: 'png', clip: { x: x0, y: y0, width: w, height: hh, scale: 1120 / w } });
        writeFileSync(join(out, `format-${n}.png`), Buffer.from(shot.data, 'base64'));
      }
    }, { record: false });
  }
} finally {
  server.close();
}
