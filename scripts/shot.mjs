// Screenshots the running editor: node scripts/shot.mjs out/ui-x.png [file] [js-to-run-before]
import { writeFileSync } from 'node:fs';
import { sleep, withChrome } from './cdp.mjs';

const [out = 'out/ui.png', file = 'fixtures/food-delivery.puml', script] = process.argv.slice(2);
await withChrome(9335, async ({ open, evaluate, screenshot, errors }) => {
  await open(`http://localhost:${process.env.PUML_PORT ?? 5199}/?file=${file}`);
  if (script) {
    await evaluate(script);
    await sleep(500);
  }
  writeFileSync(out, await screenshot());
  if (errors.length) console.log(errors);
});
