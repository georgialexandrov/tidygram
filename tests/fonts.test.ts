import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { diskCachedFetcher } from '../src/fonts-node.ts';
import { DiagramSvg } from '../src/render/DiagramSvg.tsx';
import { buildAnyScene } from '../src/scene/any.ts';
import { loadAvoid } from '../src/scene/avoid.ts';
import { embeddedFontCss, googleFontsUrl, PAPER_WEB_FONTS, parseFontFaces, type Fetcher } from '../src/scene/fonts.ts';
import { textWidth } from '../src/scene/measure.ts';
import { THEMES } from '../src/scene/theme.ts';
import { emptyLayout } from '../src/layout/layout-file.ts';
import { ensureLayout } from '../src/layout/auto.ts';
import { parseDiagram } from '../src/model/diagram.ts';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';

/** Real Geist advances at 100 px, measured in Chrome by scripts/measure-font.ts, for CORPUS below. */
const CORPUS = [
  'Customer', 'Order Service', 'Payment Gateway', 'Issue Refund', 'Place an order', 'Restaurant owner', 'Delivery driver',
  'Database', 'API Gateway', 'Web Application', 'Sends notifications using', 'Authentication and authorisation',
  'Track delivery status', 'Manage menu', 'Inventory', 'Reads from and writes to', 'The quick brown fox jumps over the lazy dog',
  'Mobile app', 'Identity provider', 'Message broker', 'Search index', 'Analytics', 'Billing', 'User', 'Checkout flow',
];
const GEIST_400 = [448.2, 625.9, 825.3, 598.1, 660.4, 811, 658.3, 434.5, 578.4, 742.2, 1145.4, 1481.6, 944.2, 648.2, 425.5, 1147.4, 2034.5, 504.8, 743.3, 734.9, 597.2, 418.2, 283.5, 212.3, 665.6];
const GEIST_600 = [469.7, 660.7, 860.1, 624.8, 690.6, 851.4, 699.7, 456.3, 603, 782.5, 1207.9, 1565.5, 1003.3, 671.2, 452.8, 1198.4, 2125.9, 528.4, 789.7, 770.3, 625.4, 445.9, 300.9, 222.6, 696.5];

const GOOGLE_CSS = `/* cyrillic */
@font-face { font-family: 'Geist'; font-style: normal; font-weight: 400; src: url(https://fonts.gstatic.com/geist-cyr.woff2) format('woff2'); }
/* latin */
@font-face { font-family: 'Geist'; font-style: normal; font-weight: 400; src: url(https://fonts.gstatic.com/geist-latin.woff2) format('woff2'); unicode-range: U+0000-00FF; }
/* latin */
@font-face { font-family: 'Geist'; font-style: normal; font-weight: 600; src: url(https://fonts.gstatic.com/geist-latin.woff2) format('woff2'); }
/* latin */
@font-face { font-family: 'Instrument Serif'; font-style: italic; font-weight: 400; src: url(https://fonts.gstatic.com/serif-italic.woff2) format('woff2'); }
`;
const fakeFetcher: Fetcher = async (url, kind) => (kind === 'css' ? new TextEncoder().encode(GOOGLE_CSS) : new Uint8Array([1, 2, 3, 4]));
const offline: Fetcher = async () => undefined;

describe('paper web fonts', () => {
  it('declares the widthFactor Geist actually measures at', () => {
    const factor = THEMES.paper!.widthFactor;
    expect(THEMES['paper-dark']!.widthFactor).toBe(factor);
    const mean = (real: number[], bold: boolean) => real.reduce((s, w, i) => s + w / textWidth(CORPUS[i]!, 100, bold), 0) / real.length;
    // Labels are bold (table x1.08 against Geist 600); regular text is the smaller share.
    expect(Math.abs(mean(GEIST_600, true) - factor)).toBeLessThan(0.05);
    expect(Math.abs(mean(GEIST_400, false) - factor)).toBeLessThan(0.05);
    // And per label: no text overflows its measured box by more than 6%.
    GEIST_600.forEach((w, i) => expect(w / textWidth(CORPUS[i]!, 100, true, factor)).toBeLessThan(1.06));
  });

  it('builds the Google Fonts URL from the font list', () => {
    expect(googleFontsUrl(PAPER_WEB_FONTS)).toBe(
      'https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600&family=Geist+Mono:wght@400;500&family=Instrument+Serif:ital@0;1&display=swap',
    );
  });

  it('keeps Latin faces only and merges the weights of a variable font', () => {
    const faces = parseFontFaces(GOOGLE_CSS);
    expect(faces.map((f) => `${f.family} ${f.style} ${f.weight}`)).toEqual(['Geist normal 400 600', 'Instrument Serif italic 400']);
  });

  it('embeds data-URI @font-face rules, and nothing when offline', async () => {
    const css = await embeddedFontCss(PAPER_WEB_FONTS, fakeFetcher);
    expect(css.match(/@font-face/g)).toHaveLength(2);
    expect(css).toContain('data:font/woff2;base64,AQIDBA==');
    expect(await embeddedFontCss(PAPER_WEB_FONTS, offline)).toBe('');
    expect(await embeddedFontCss(undefined, fakeFetcher)).toBe('');
  });

  it('caches downloads on disk and survives going offline', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'puml-fonts-'));
    let calls = 0;
    const net = (async (url: string) => (calls++, new Response(url.includes('css2') ? GOOGLE_CSS : new Uint8Array([9, 9])))) as unknown as typeof fetch;
    const first = await embeddedFontCss(PAPER_WEB_FONTS, diskCachedFetcher(dir, net));
    const online = calls;
    const down = (async () => { throw new Error('offline'); }) as unknown as typeof fetch;
    expect(await embeddedFontCss(PAPER_WEB_FONTS, diskCachedFetcher(dir, down))).toBe(first);
    expect(calls).toBe(online);
    expect(await embeddedFontCss(PAPER_WEB_FONTS, diskCachedFetcher(join(dir, 'empty'), down))).toBe('');
  });

  it('export carries @font-face for paper themes and none for the others', async () => {
    const require = createRequire(import.meta.url);
    const avoid = await loadAvoid(join(dirname(require.resolve('libavoid-js')), 'libavoid.wasm'));
    const file = 'fixtures/component.puml';
    const { diagram } = parseDiagram(readFileSync(file, 'utf8'), file);
    for (const theme of Object.keys(THEMES)) {
      const layout = await ensureLayout(diagram, { ...emptyLayout(), view: { theme } }, 'fill');
      const scene = buildAnyScene(diagram, layout, avoid);
      const fontCss = await embeddedFontCss(scene.theme.webFonts, fakeFetcher);
      const svg = renderToStaticMarkup(createElement(DiagramSvg, { scene, fontCss }));
      expect(svg.includes('@font-face'), theme).toBe(theme.startsWith('paper'));
    }
  });
});
