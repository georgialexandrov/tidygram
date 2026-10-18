// Records the README demo: drives the static demo build in headless Chrome, captures frames with
// CDP Page.startScreencast, and assembles docs/media/demo.mp4 and demo.gif with ffmpeg.
// Build first: DEMO_BASE=/x/ pnpm build:demo     Usage: CDP_PORT=9350 node scripts/record-demo.mjs
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { sleep, withChrome } from './cdp.mjs';

process.env.CDP_PORT ??= '9350';
const BASE = '/x/';
const PORT = Number(process.env.DEMO_PORT ?? 5234);
const W = 1600;
const H = 900;
const FFMPEG = process.env.FFMPEG ?? 'ffmpeg';
const dist = new URL('../dist/', import.meta.url).pathname;
const media = new URL('../docs/media/', import.meta.url).pathname;
const frames = new URL('../out/demo-frames/', import.meta.url).pathname;
rmSync(frames, { recursive: true, force: true });
mkdirSync(frames, { recursive: true });
mkdirSync(media, { recursive: true });

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

const shots = []; // { file, t } in seconds
try {
  await withChrome(9350, async ({ send, evaluate, mouse, open, centreOf }) => {
    const base = `http://127.0.0.1:${PORT}${BASE}`;
    await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });
    await open(`${base}?file=food-delivery.puml`); // gives us the origin for localStorage
    await evaluate('localStorage.clear()');

    // Overlay: cursor dot and caption, re-injected after every navigation.
    const overlay = `(() => {
      if (document.getElementById('demo-cursor')) return;
      const st = document.createElement('style');
      st.textContent = \`
        #demo-cursor{position:fixed;left:0;top:0;width:18px;height:18px;margin:-9px 0 0 -9px;border-radius:50%;background:rgba(20,20,20,.85);border:2px solid #fff;box-shadow:0 1px 6px rgba(0,0,0,.4);pointer-events:none;z-index:99999;transition:transform .08s linear, width .12s, height .12s, margin .12s}
        #demo-cursor.down{width:12px;height:12px;margin:-6px 0 0 -6px;background:rgba(200,40,40,.9)}
        #demo-caption{position:fixed;left:50%;bottom:28px;transform:translateX(-50%);background:rgba(17,17,17,.82);color:#fff;font:600 26px/1.2 -apple-system,system-ui,sans-serif;padding:12px 26px;border-radius:12px;pointer-events:none;z-index:99998;opacity:0;transition:opacity .25s;white-space:nowrap}
        #demo-caption.on{opacity:1}\`;
      document.head.append(st);
      const c = document.createElement('div'); c.id = 'demo-cursor'; c.style.transform = 'translate(' + (window.__cx ?? 800) + 'px,' + (window.__cy ?? 450) + 'px)'; document.body.append(c);
      const k = document.createElement('div'); k.id = 'demo-caption'; document.body.append(k);
    })()`;

    let cx = 800;
    let cy = 450;
    const place = (x, y) => evaluate(`window.__cx=${x};window.__cy=${y};document.getElementById('demo-cursor')&&(document.getElementById('demo-cursor').style.transform='translate(${x}px,${y}px)')`);
    const caption = (text) => evaluate(`(() => { const k = document.getElementById('demo-caption'); if (!k) return; if (!${JSON.stringify(text)}) return k.classList.remove('on'); k.textContent = ${JSON.stringify(text)}; k.classList.add('on'); })()`);
    const ease = (t) => t * t * (3 - 2 * t);
    const moveTo = async (x, y, ms = 700, buttons = 0) => {
      const n = Math.max(2, Math.round(ms / 16));
      const [x0, y0] = [cx, cy];
      for (let i = 1; i <= n; i++) {
        const e = ease(i / n);
        const px = x0 + (x - x0) * e;
        const py = y0 + (y - y0) * e;
        await Promise.all([mouse('mouseMoved', px, py, buttons), place(px, py)]);
        await sleep(ms / n);
      }
      [cx, cy] = [x, y];
    };
    const centre = async (sel) => {
      const c = await centreOf(sel);
      if (!c) throw new Error(`no element ${sel}`);
      return c;
    };
    const click = async (sel, ms = 700) => {
      const [x, y] = await centre(sel);
      await moveTo(x, y, ms);
      await evaluate(`document.getElementById('demo-cursor').classList.add('down')`);
      await mouse('mousePressed', x, y, 1);
      await sleep(90);
      await mouse('mouseReleased', x, y, 0);
      await evaluate(`document.getElementById('demo-cursor').classList.remove('down')`);
      await sleep(250);
    };
    // Selects can't be popped open headless: point at it, then set the value like a user pick.
    const pick = async (sel, value) => {
      const [x, y] = await centre(sel);
      await moveTo(x, y, 600);
      await sleep(300);
      await evaluate(`(() => { const s = document.querySelector(${JSON.stringify(sel)}); const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set; set.call(s, ${JSON.stringify(value)}); s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
      await sleep(300);
    };
    const btn = (text) => evaluate(`(() => { const b = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === ${JSON.stringify(text)} || b.textContent.trim().startsWith(${JSON.stringify(text)})); if (!b) return false; b.setAttribute('data-demo', ${JSON.stringify(text)}); return true; })()`).then((ok) => {
      if (!ok) throw new Error(`no button ${text}`);
      return `button[data-demo="${text}"]`;
    });
    const settled = (ms = 1200) => sleep(ms);
    const openSample = async (file, text) => {
      await open(`${base}?file=${encodeURIComponent(file)}`);
      await evaluate(overlay);
      await place(cx, cy);
      if (text) await caption(text);
      await sleep(500);
    };

    // Screencast.
    let t0 = null;
    let n = 0;
    const wsSend = send;
    const onFrame = async (params) => {
      const file = join(frames, `f${String(n++).padStart(5, '0')}.jpg`);
      writeFileSync(file, Buffer.from(params.data, 'base64'));
      const t = params.metadata.timestamp;
      t0 ??= t;
      shots.push({ file, t: t - t0 });
      await wsSend('Page.screencastFrameAck', { sessionId: params.sessionId }).catch(() => {});
    };
    // cdp.mjs forwards every protocol message to globalThis.__cdpOnEvent when set.
    globalThis.__cdpOnEvent = (msg) => {
      if (msg.method === 'Page.screencastFrame') void onFrame(msg.params);
      // Reset asks "Discard all positions…?": accept it, like the viewer would.
      if (msg.method === 'Page.javascriptDialogOpening') void wsSend('Page.handleJavaScriptDialog', { accept: true });
    };

    await openSample('food-delivery.puml');
    await evaluate(`document.querySelector('button.switch').click()`); // Source panel open from the start
    await sleep(600);
    await send('Page.startScreencast', { format: 'jpeg', quality: 92, maxWidth: W, maxHeight: H, everyNthFrame: 1 });
    await sleep(300);

    // 1. Source panel open.
    await caption('Your PlantUML, untouched');
    await settled(2200);

    // 2. Reset then Auto layout.
    await caption('Auto layout, lines routed');
    await click(await btn('Reset'), 800);
    await settled(800);
    await click(await btn('Auto'), 600);
    await settled(1600);

    // 3. Drag a node.
    await caption('Drag: lines follow');
    const ids = await evaluate(`[...document.querySelectorAll('svg g[data-id]')].map((g) => { const r = g.getBoundingClientRect(); return { id: g.dataset.id, x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width }; }).filter((n) => n.w > 40 && n.w < 300 && n.x < 1000 && n.y > 150 && n.y < 700)`);
    ids.sort((a, b) => Math.abs(a.x - 560) + Math.abs(a.y - 420) - (Math.abs(b.x - 560) + Math.abs(b.y - 420)));
    const node = ids[0];
    await moveTo(node.x, node.y, 800);
    await evaluate(`document.getElementById('demo-cursor').classList.add('down')`);
    await mouse('mousePressed', node.x, node.y, 1);
    await sleep(200);
    await moveTo(node.x + 170, node.y - 120, 1000, 1);
    await sleep(300);
    await moveTo(node.x - 60, node.y + 130, 1000, 1);
    await mouse('mouseReleased', cx, cy, 0);
    await evaluate(`document.getElementById('demo-cursor').classList.remove('down')`);
    await settled(1000);

    // 4. Themes.
    await caption('Themes');
    await click('.popover.display .opener', 700);
    const themes = await evaluate(`[...document.querySelectorAll('.theme-select option')].map((o) => o.value)`);
    for (const name of ['modern', 'paper', 'midnight']) {
      if (!themes.includes(name)) throw new Error(`theme ${name} missing from ${themes}`);
      await pick('.theme-select', name);
      await settled(800);
    }
    await click('.popover.display .opener', 500); // close
    await sleep(300);

    // 5. Frame + fit.
    await caption('Fit any slide');
    const frameOpts = await evaluate(`[...document.querySelectorAll('.frame-select option')].map((o) => [o.value, o.textContent])`);
    const f169 = frameOpts.find(([, t]) => t.includes('16:9'));
    if (!f169) throw new Error(`no 16:9 frame in ${JSON.stringify(frameOpts)}`);
    await pick('.frame-select', f169[0]);
    await settled(700);
    await click(await btn('Fit to frame'), 700);
    await settled(2000);

    // 6. C4 zoom levels.
    await openSample('c4/zoom.puml', 'C4 zoom levels');
    await evaluate(`localStorage.removeItem('tidygram:layout:c4/zoom.puml')`);
    await sleep(900);
    const views = await evaluate(`[...document.querySelectorAll('.view-select option')].map((o) => [o.value, o.textContent])`);
    for (const [v] of views.filter(([v]) => ['context', 'container:shop', 'component:api'].includes(v))) {
      await pick('.view-select', v);
      await settled(1200);
    }

    // 7. Mermaid and draw.io.
    await openSample('mermaid/flowchart.mmd', 'Mermaid and draw.io too');
    await settled(1400);
    await openSample('drawio/flowchart.drawio');
    await settled(1400);

    // 8. End card.
    await caption('tidygram — layout lives in a sidecar');
    await settled(2500);
    await send('Page.stopScreencast');
    await sleep(300);
    console.log('views:', JSON.stringify(views), 'frames:', shots.length);
  });
} finally {
  server.close();
}

// Assemble: constant-rate video from timestamped frames via the concat demuxer, held to the last frame.
const end = shots.at(-1).t + 0.5;
const list = shots.map((s, i) => `file '${s.file}'\nduration ${((shots[i + 1]?.t ?? end) - s.t).toFixed(4)}`).join('\n') + `\nfile '${shots.at(-1).file}'\n`;
writeFileSync(join(frames, 'list.txt'), list);
const mp4 = join(media, 'demo.mp4');
const gif = join(media, 'demo.gif');
execFileSync(FFMPEG, ['-y', '-v', 'error', '-f', 'concat', '-safe', '0', '-i', join(frames, 'list.txt'), '-vf', `fps=30,scale=${W}:${H}:flags=lanczos:in_range=pc:out_range=tv,format=yuv420p`, '-c:v', 'libx264', '-preset', 'slow', '-crf', '24', '-movflags', '+faststart', mp4]);
execFileSync(FFMPEG, ['-y', '-v', 'error', '-i', mp4, '-vf', 'fps=13,scale=960:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle', '-loop', '0', gif]);
console.log('wrote', mp4, gif);
