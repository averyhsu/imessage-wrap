// Design-iteration helper: screenshot every slide of a recap, settled.
//
//   node tests/e2e/shots.mjs                      demo at 390×844 @2x → test-results/shots/
//   node tests/e2e/shots.mjs --out=/tmp/x --w=320 --h=568 --fixture=huge --only=3,4
//
// The committed screenshots come from `npm run shots` (tests/e2e/run.mjs with
// --update-screenshots); this script is for looking at one thing quickly and writes to a
// git-ignored folder unless --out says otherwise.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, startServer, launch, waitForStory, showSettled, findOverflow, encodePayload } from './lib.mjs';
import { fixtures } from './fixtures.mjs';

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
  return m ? [m[1], m[2] ?? true] : [a, true];
}));

const out = path.resolve(args.out || path.join(ROOT, 'test-results/shots'));
const width = Number(args.w || 390);
const height = Number(args.h || 844);
const scale = Number(args.scale || 2);
const only = args.only ? String(args.only).split(',').map(Number) : null;
fs.mkdirSync(out, { recursive: true });

const server = await startServer();
const browser = await launch();
const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: scale, hasTouch: width < 600, isMobile: width < 600 });
// Embed mode only switches on when the native bridge exists, so --embed stubs one.
if (args.embed) await context.addInitScript(() => { window.webkit = { messageHandlers: { wrapped: { postMessage() {} } } }; });
const page = await context.newPage();
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') console.log(`[${m.type()}]`, m.text()); });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));

let url = server.url + '?demo=1';
if (args.fixture) {
  const stats = fixtures[args.fixture];
  if (!stats) throw new Error('unknown fixture ' + args.fixture + '; have ' + Object.keys(fixtures).join(', '));
  url = server.url + (args.embed ? '?embed=ios' : '') + '#w1=' + await encodePayload(stats);
} else if (args.embed) {
  url = server.url + '?embed=ios&demo=1';
}
await page.goto(url);
await waitForStory(page);
const ids = await page.evaluate(() => window.WrappedStory.slideIds);
for (let i = 0; i < ids.length; i++) {
  if (only && !only.includes(i + 1)) continue;
  await showSettled(page, i);
  const issues = await findOverflow(page);
  const name = `${String(i + 1).padStart(2, '0')}-${ids[i]}${args.suffix ? '-' + args.suffix : ''}.png`;
  await page.screenshot({ path: path.join(out, name) });
  console.log(name, issues.length ? '\n   ' + issues.join('\n   ') : 'ok');
}
await browser.close();
await server.close();
