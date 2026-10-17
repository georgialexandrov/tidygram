// End-to-end smoke test: drives the running editor (pnpm dev) in headless
// Chrome over the DevTools protocol, drags a node and pulls a line, and checks
// what was written to layout.json; then multi-select (shift-click, group drag,
// one undo), marquee, and layout export; then an architecture template on
// fixtures/architecture/layered-web-shop.puml (apply from the menu, drag into another band, undo,
// findings panel, turn off and back on with undo). Usage: node scripts/smoke.mjs [screenshot.png]
// Restores fixtures/food-delivery.layout.json and the architecture sidecar afterwards.
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const URL_ = 'http://localhost:5199/?file=fixtures/food-delivery.puml';
const LAYOUT = new URL('../fixtures/food-delivery.layout.json', import.meta.url);
const PORT = 9333;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const original = readFileSync(LAYOUT, 'utf8');
const ARCH = new URL('../fixtures/architecture/layered-web-shop.layout.json', import.meta.url);
const archOriginal = existsSync(ARCH) ? readFileSync(ARCH, 'utf8') : null;

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
  const evaluate = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result.value;
  // Alt held: no alignment snapping, so the drag distance is exact. Shift = 8, Cmd = 4.
  const ALT = 1;
  const SHIFT = 8;
  const mouse = (type, x, y, buttons = 1, modifiers = ALT) => send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons, clickCount: 1, modifiers });
  const drag = async (from, to, steps = 12) => {
    await mouse('mouseMoved', from[0], from[1], 0);
    await mouse('mousePressed', from[0], from[1]);
    for (let i = 1; i <= steps; i++) await mouse('mouseMoved', from[0] + ((to[0] - from[0]) * i) / steps, from[1] + ((to[1] - from[1]) * i) / steps);
    await mouse('mouseReleased', to[0], to[1], 0);
  };
  const click = async (at, modifiers = 0) => {
    await mouse('mouseMoved', at[0], at[1], 0, modifiers);
    await mouse('mousePressed', at[0], at[1], 1, modifiers);
    await mouse('mouseReleased', at[0], at[1], 0, modifiers);
  };
  const undoKey = async () => {
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'z', code: 'KeyZ', modifiers: 4, windowsVirtualKeyCode: 90 });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'z', code: 'KeyZ', modifiers: 4, windowsVirtualKeyCode: 90 });
  };
  const selected = () => evaluate(`[...document.querySelectorAll('[data-selected]')].map((g) => g.getAttribute('data-id')).sort()`);
  const rectOf = (selector) => evaluate(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return [r.x, r.y, r.right, r.bottom]; })()`);
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
  await undoKey();
  await sleep(600);
  const afterUndo = JSON.parse(readFileSync(LAYOUT, 'utf8'));

  // 3b. Multi-select: click Admin, shift-click Courier, drag Admin; both move, one undo restores both.
  const groupBefore = JSON.parse(readFileSync(LAYOUT, 'utf8'));
  await click(await centreOf('[data-id="Admin"] circle'));
  await click(await centreOf('[data-id="Courier"] circle'), SHIFT);
  await sleep(200);
  const groupSel = await selected();
  const adminNow = await centreOf('[data-id="Admin"] circle');
  await drag(adminNow, [adminNow[0] + 80, adminNow[1] + 40]);
  await sleep(600);
  const groupAfter = JSON.parse(readFileSync(LAYOUT, 'utf8'));
  await undoKey();
  await sleep(600);
  const groupUndone = JSON.parse(readFileSync(LAYOUT, 'utf8'));
  const moved = (id, from, to) => [Math.round(to.nodes[id].x - from.nodes[id].x), Math.round(to.nodes[id].y - from.nodes[id].y), !!to.nodes[id].pinned];

  // 3c. Marquee: drag on empty canvas around two actors; exactly those (and what else lies fully inside) get selected.
  await click(await centreOf('.canvas'), 0); // clear (may land on an element; Escape below makes sure)
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  const [ax0, ay0, ax1, ay1] = await rectOf('[data-id="Admin"]');
  const [sx0, sy0, sx1, sy1] = await rectOf('[data-id="Staff"]');
  const from = [Math.min(ax0, sx0) - 6, Math.min(ay0, sy0) - 6];
  const to = [Math.max(ax1, sx1) + 6, Math.max(ay1, sy1) + 6];
  const startsEmpty = await evaluate(`!document.elementFromPoint(${from[0]}, ${from[1]}).closest('[data-id], [data-edge]')`);
  await drag(from, to);
  await sleep(300);
  const marqueeSel = await selected();

  // 3d. Layout export: the downloaded file is layout.json as saved, under the sidecar's name; copy gives the same text.
  await evaluate(`(() => {
    window.__downloads = [];
    const create = URL.createObjectURL.bind(URL);
    URL.createObjectURL = (blob) => { const url = create(blob); window.__lastBlob = blob; return url; };
    HTMLAnchorElement.prototype.click = function () { window.__downloads.push({ name: this.download, blob: window.__lastBlob }); };
    window.__copied = null;
    navigator.clipboard.writeText = async (t) => { window.__copied = t; };
  })()`);
  await sleep(400); // let the last save land
  await evaluate(`document.querySelector('.export-menu .opener').click()`);
  await sleep(100);
  const menuOpen = await evaluate(`!document.querySelector('.export-menu .popover-panel').hidden`);
  await evaluate(`document.querySelector('[data-action="export-layout"]').click()`);
  await sleep(100);
  const exported = await evaluate(`(async () => { const d = window.__downloads.at(-1); return d && { name: d.name, text: await d.blob.text() }; })()`);
  await evaluate(`document.querySelector('.export-menu .opener').click()`);
  await evaluate(`document.querySelector('[data-action="copy-layout"]').click()`);
  await sleep(100);
  const copied = await evaluate(`window.__copied`);
  const onDisk = readFileSync(LAYOUT, 'utf8');

  // 4. Modern theme, 16:9 frame, fit to frame, grid off.
  const choose = (selector, value) =>
    evaluate(`(() => {
      const el = document.querySelector('.toolbar ${selector}');
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(el, ${JSON.stringify(value)});
      el.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
  await choose('.theme-select', 'modern');
  await sleep(300);
  await choose('.frame-select', '16:9');
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
  // Shift-click a second element: the source panel highlights both declarations.
  await click(await centreOf('[data-id="UC_Pay"]'), SHIFT);
  await sleep(300);
  const highlightedTwo = await evaluate(`[...document.querySelectorAll('.src-line.hl')].map((l) => l.textContent)`);

  const shot = process.argv[2];
  if (shot) writeFileSync(shot, Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));

  // 6. Architecture template: Layered from the menu, drag Cart into the Application band, undo,
  //    pick the violation in the findings panel, turn the template off, undo brings it back.
  const readArch = () => JSON.parse(readFileSync(ARCH, 'utf8'));
  const pickTemplate = async (kind) => {
    await evaluate(`document.querySelector('.template-menu .opener').click()`);
    await sleep(100);
    await evaluate(`document.querySelector('[data-template="${kind}"]').click()`);
    await sleep(700);
  };
  await send('Page.navigate', { url: 'http://localhost:5199/?file=fixtures/architecture/layered-web-shop.puml' });
  for (let i = 0; i < 100; i++) {
    await sleep(100);
    if (await evaluate(`document.querySelector('.app')?.dataset.loaded === 'fixtures/architecture/layered-web-shop.puml'`)) break;
  }
  await sleep(600);
  await pickTemplate('none'); // a demo sidecar may have one on already
  const freeNodes = readArch().nodes;
  await pickTemplate('layered');
  const applied = readArch();
  const backdrop = await evaluate(`!!document.querySelector('[data-template="layered"] [data-layer="application"]')`);
  const panelViolations = await evaluate(`document.querySelector('.template-panel')?.dataset.violations`);
  const cart = await centreOf('[data-id="Cart"]');
  const band = await evaluate(`(() => { const r = document.querySelector('[data-layer="application"] rect').getBoundingClientRect(); return [r.y, r.height]; })()`);
  const bandMid = [cart[0], band[0] + band[1] / 2];
  await mouse('mouseMoved', cart[0], cart[1], 0);
  await mouse('mousePressed', cart[0], cart[1]);
  for (let i = 1; i <= 10; i++) await mouse('mouseMoved', cart[0], cart[1] + ((bandMid[1] - cart[1]) * i) / 10);
  await sleep(100);
  const dropShown = await evaluate(`document.querySelector('[data-drop]')?.getAttribute('data-drop') ?? null`);
  await mouse('mouseReleased', bandMid[0], bandMid[1], 0);
  await sleep(700);
  const dropped = readArch();
  const cartInBand = await evaluate(`(() => {
    const c = document.querySelector('[data-id="Cart"]').getBoundingClientRect();
    const b = document.querySelector('[data-layer="application"] rect').getBoundingClientRect();
    return c.top >= b.top && c.bottom <= b.bottom;
  })()`);
  await undoKey();
  await sleep(700);
  const undoneDrop = readArch();
  await evaluate(`document.querySelector('.template-panel-list [data-edge-ref]').click()`);
  await sleep(200);
  const panelSelects = await evaluate(`document.querySelector('.template-panel-list button.selected')?.dataset.edgeRef ?? null`);
  await pickTemplate('none');
  const off = readArch();
  const offBackdrop = await evaluate(`!!document.querySelector('.canvas [data-template]')`);
  await undoKey();
  await sleep(700);
  const backOn = readArch();
  const templateResults = {
    applied: applied.template?.kind,
    backdrop,
    panelViolations,
    dropShown,
    assignAfterDrop: dropped.template?.assign,
    cartInBand,
    assignAfterUndo: undoneDrop.template?.assign,
    panelSelects,
    offRestoresFree: !off.template && Object.entries(freeNodes).every(([id, p]) => off.nodes[id]?.x === p.x && off.nodes[id]?.y === p.y),
    offBackdrop,
    undoBringsBack: backOn.template?.kind,
  };

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
    highlightedTwo,
    group: { selected: groupSel, Admin: moved('Admin', groupBefore, groupAfter), Courier: moved('Courier', groupBefore, groupAfter), expected: [Math.round(80 / k), Math.round(40 / k)] },
    groupUndone: { Admin: groupUndone.nodes.Admin, Courier: groupUndone.nodes.Courier },
    marquee: { startsEmpty, selected: marqueeSel },
    layoutExport: { menuOpen, name: exported?.name, matchesDisk: exported?.text === onDisk, copyMatches: copied === onDisk },
    template: templateResults,
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
    highlightedTwo.length === 2 &&
    highlightedTwo.some((l) => l.includes('UC_Pay')) &&
    groupSel.join() === 'Admin,Courier' &&
    ['Admin', 'Courier'].every((id) => {
      const [dx, dy, pinned] = moved(id, groupBefore, groupAfter);
      return Math.abs(dx - 80 / k) < 2 && Math.abs(dy - 40 / k) < 2 && pinned;
    }) &&
    JSON.stringify(groupUndone.nodes.Admin) === JSON.stringify(groupBefore.nodes.Admin) &&
    JSON.stringify(groupUndone.nodes.Courier) === JSON.stringify(groupBefore.nodes.Courier) &&
    startsEmpty &&
    marqueeSel.includes('Admin') &&
    marqueeSel.includes('Staff') &&
    !marqueeSel.includes('Courier') &&
    menuOpen &&
    exported?.name === 'food-delivery.layout.json' &&
    exported.text === onDisk &&
    copied === onDisk &&
    templateResults.applied === 'layered' &&
    templateResults.backdrop &&
    templateResults.panelViolations === '1' &&
    templateResults.dropShown === 'application' &&
    templateResults.assignAfterDrop?.Cart === 'application' &&
    templateResults.cartInBand &&
    !templateResults.assignAfterUndo?.Cart &&
    templateResults.panelSelects === 'Pricing..>Api' &&
    templateResults.offRestoresFree &&
    !templateResults.offBackdrop &&
    templateResults.undoBringsBack === 'layered' &&
    logs.length === 0;
  console.log(ok ? 'SMOKE OK' : 'SMOKE FAILED');
  ws.close();
  process.exitCode = ok ? 0 : 1;
} finally {
  chrome.kill();
  await sleep(600); // a debounced save may still be in flight
  writeFileSync(LAYOUT, original);
  if (archOriginal === null) rmSync(ARCH, { force: true });
  else writeFileSync(ARCH, archOriginal);
}
