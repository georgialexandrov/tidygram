// Width of a web font relative to the Helvetica table in src/scene/measure.ts.
// Usage: CDP_PORT=9311 npx tsx scripts/measure-font.ts  (needs network for Google Fonts)
// Prints the ratio per face over a corpus of diagram labels; the paper themes' widthFactor comes from this.
import { withChrome } from './cdp.mjs';
import { googleFontsUrl, PAPER_WEB_FONTS } from '../src/scene/fonts.ts';
import { textWidth } from '../src/scene/measure.ts';

const CORPUS = [
  'Customer', 'Order Service', 'Payment Gateway', 'Issue Refund', 'Place an order', 'Restaurant owner', 'Delivery driver',
  'Database', 'API Gateway', 'Web Application', 'Sends notifications using', 'Authentication and authorisation',
  'Track delivery status', 'Manage menu', 'Inventory', 'Reads from and writes to', 'The quick brown fox jumps over the lazy dog',
  'Mobile app', 'Identity provider', 'Message broker', 'Search index', 'Analytics', 'Billing', 'User', 'Checkout flow',
];

const weights: [string, number, boolean][] = [['Geist', 400, false], ['Geist', 500, false], ['Geist', 600, true]];
const measured = await withChrome(9311, async ({ send, evaluate }: any) => {
  await send('Page.navigate', { url: 'about:blank' });
  await evaluate(`new Promise((r) => { const l = document.createElement('link'); l.rel = 'stylesheet'; l.href = ${JSON.stringify(googleFontsUrl(PAPER_WEB_FONTS))}; l.onload = r; document.head.append(l); })`);
  const out: Record<string, number[]> = {};
  for (const [family, weight] of weights) {
    await evaluate(`document.fonts.load('${weight} 100px ${family}', 'abc')`);
    out[`${family} ${weight}`] = await evaluate(`(() => { const c = document.createElement('canvas').getContext('2d'); c.font = '${weight} 100px ${family}'; return ${JSON.stringify(CORPUS)}.map((t) => c.measureText(t).width); })()`);
  }
  const ok = await evaluate(`document.fonts.check('600 12px Geist')`);
  return { out, ok };
});
console.log('Geist loaded:', measured.ok);
for (const [family, weight, bold] of weights) {
  const real = measured.out[`${family} ${weight}`]!;
  const ratios = CORPUS.map((t, i) => real[i]! / textWidth(t, 100, bold));
  const mean = ratios.reduce((a, b) => a + b, 0) / ratios.length;
  console.log(`${family} ${weight}${bold ? ' (table bold)' : ''}: mean ${mean.toFixed(3)}, min ${Math.min(...ratios).toFixed(3)}, max ${Math.max(...ratios).toFixed(3)}`);
}
if (process.argv.includes('--json')) for (const [family, weight] of weights) console.log(`${family} ${weight}:`, JSON.stringify(measured.out[`${family} ${weight}`]!.map((w: number) => Math.round(w * 10) / 10)));
