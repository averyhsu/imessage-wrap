// End-to-end checks for the Mac app's download page (web/mac/), in headless Chromium.
//
//   npm run test:mac-guide                     everything; exits non-zero on any failure
//   node tests/e2e/mac-guide.mjs --only=walk,keyboard
//   npm run shots:mac-guide                    rewrite docs/screenshots/web/mac-guide-*.png
//
// Sections: walk, keyboard, deeplink, download, devices, nojs, layout, motion, shots.
//
// Every page is opened with the page's own content security policy in force and records
// console errors, CSP violations, failed requests and any request to another origin; each
// section ends by checking that there were none.
//
// A plain run leaves the repository as it found it: its screenshots go to
// test-results/mac-guide-screenshots/ (ignored by git). Only --update-screenshots rewrites
// the committed pictures in docs/screenshots/web/.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { ROOT, WEB, startServer, launch } from './lib.mjs';

const require = createRequire(import.meta.url);
const Config = require(path.join(WEB, 'js/config.js'));
const MacConfig = require(path.join(WEB, 'mac/mac-config.js'));
const Guide = require(path.join(WEB, 'mac/mac.js'));

const UPDATE_SHOTS = process.argv.includes('--update-screenshots');
const SHOTS = path.join(ROOT, UPDATE_SHOTS ? 'docs/screenshots/web' : 'test-results/mac-guide-screenshots');
const only = (process.argv.find((a) => a.startsWith('--only=')) || '').slice(7).split(',').filter(Boolean);
const wants = (name) => only.length === 0 || only.includes(name);

const VIEWPORTS = {
  'phone-360': { width: 360, height: 740, mobile: true },
  'phone-390': { width: 390, height: 844, mobile: true },
  'tablet-768': { width: 768, height: 1024, mobile: true },
  'desktop-1440': { width: 1440, height: 900 },
};
const UA = {
  mac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.4 Safari/605.1.15',
  macChrome: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
  iphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.4 Mobile/15E148 Safari/604.1',
  // iPadOS asks for the desktop site: it says "Macintosh" and has a touch screen.
  ipad: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.4 Safari/605.1.15',
  android: 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36',
  windows: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0',
  linux: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
};
const DEEP_LINK = 'x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Security';
const STEPS = 5;

const failures = [];
let checks = 0;
function ok(condition, message) {
  checks++;
  if (!condition) { failures.push(message); console.log('  ✗ ' + message); }
  return !!condition;
}
function eq(actual, expected, message) {
  const same = JSON.stringify(actual) === JSON.stringify(expected);
  return ok(same, same ? message : `${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
const flows = [];
async function section(name, title, fn) {
  if (!wants(name)) return;
  const t0 = Date.now();
  const before = failures.length;
  const checksBefore = checks;
  console.log(`\n▸ ${title}`);
  try { await fn(); } catch (e) { failures.push(`${title}: threw ${e.stack || e}`); console.log('  ✗ threw: ' + (e.stack || e)); }
  const passed = failures.length === before;
  flows.push({ name, passed, checks: checks - checksBefore });
  console.log(`  ${passed ? '✓ passed' : '✗ FAILED'} (${checks - checksBefore} checks, ${((Date.now() - t0) / 1000).toFixed(1)}s)`);
}

const server = await startServer();
const browser = await launch();
const origin = new URL(server.url).origin;
const PAGE = server.url + 'mac/';

/** mac-config.js as served, with the download address replaced. */
function configWith(url) {
  const src = fs.readFileSync(path.join(WEB, 'mac/mac-config.js'), 'utf8');
  const out = src.replace(/MAC_DOWNLOAD_URL: '[^']*'/, `MAC_DOWNLOAD_URL: ${JSON.stringify(url).replace(/"/g, "'")}`);
  if (out === src && url) throw new Error('could not set MAC_DOWNLOAD_URL in mac-config.js');
  return out;
}

/** A page that records console errors, failed requests, CSP violations and foreign requests. */
async function open(opts = {}) {
  const vp = opts.viewport || VIEWPORTS['desktop-1440'];
  const context = await browser.newContext({
    viewport: { width: vp.width, height: vp.height },
    deviceScaleFactor: opts.scale || 1,
    hasTouch: !!(vp.mobile || opts.touch),
    isMobile: !!vp.mobile,
    userAgent: opts.ua || UA.mac,
    locale: 'en-US',
    reducedMotion: opts.reducedMotion || 'reduce',
    javaScriptEnabled: opts.js !== false,
  });
  const problems = [];
  const foreign = [];
  context.on('request', (req) => {
    const url = req.url();
    if (/^(data|blob|about):/.test(url)) return;
    if (!url.startsWith(origin + '/')) foreign.push(url);
  });
  await context.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (e) => {
      console.error('CSP violation: ' + e.violatedDirective + ' ' + e.blockedURI);
    });
  });
  if (opts.touch) await context.addInitScript(() => { Object.defineProperty(Navigator.prototype, 'maxTouchPoints', { get: () => 5 }); });
  if (opts.download !== undefined) {
    const body = configWith(opts.download);
    await context.route('**/mac/mac-config.js', (route) => route.fulfill({ status: 200, contentType: 'text/javascript; charset=utf-8', body }));
  }
  const page = await context.newPage();
  context.on('console', (m) => { if (m.type() === 'error') problems.push('console: ' + m.text()); });
  context.on('weberror', (e) => problems.push('pageerror: ' + e.error().message));
  context.on('requestfailed', (r) => problems.push('requestfailed: ' + r.url() + ' ' + (r.failure() ? r.failure().errorText : '')));
  await page.goto(PAGE);
  await page.evaluate(() => document.fonts.ready);
  return {
    context, page, problems, foreign,
    clean(label) {
      eq(problems, [], `${label}: no console errors, failed requests or CSP violations`);
      eq(foreign, [], `${label}: no request left this origin`);
    },
    close: () => context.close(),
  };
}

// ── page helpers ───────────────────────────────────────────────────────────────────────

const snap = (page) => page.evaluate(() => {
  const steps = [...document.querySelectorAll('.mg-step')];
  const shown = (el) => !!el && !el.hidden && getComputedStyle(el).display !== 'none' && el.getClientRects().length > 0;
  return {
    state: window.WrappedMacGuide && window.WrappedMacGuide.state ? window.WrappedMacGuide.state() : null,
    open: steps.map((s) => shown(s.querySelector('.mg-step__body'))),
    classes: steps.map((s) => ['is-active', 'is-done', 'is-locked'].filter((c) => s.classList.contains(c)).join(' ')),
    current: steps.findIndex((s) => s.getAttribute('aria-current') === 'step') + 1,
    nexts: steps.map((s) => shown(s.querySelector('.mg-next'))),
    label: document.getElementById('progress-label').textContent,
    rail: [...document.querySelectorAll('#rail > li')].map((li) => li.className),
    status: document.getElementById('status').textContent,
    focus: document.activeElement ? document.activeElement.id : '',
  };
});

/** Where step n's heading is, relative to the window. */
const headingTop = (page, n) => page.evaluate((i) => document.getElementById('h-' + i).getBoundingClientRect().top, n);

/** Anything sticking out of the viewport sideways? (The page clips, so scrollWidth is not enough.) */
const overflow = (page) => page.evaluate(() => {
  const vw = document.documentElement.clientWidth;
  const issues = [];
  if (document.documentElement.scrollWidth > vw + 1) issues.push(`the page scrolls sideways (${document.documentElement.scrollWidth} > ${vw})`);
  if (document.body.scrollWidth > vw + 1) issues.push(`the body is wider than the window (${document.body.scrollWidth} > ${vw})`);
  for (const el of document.querySelectorAll('#page *')) {
    if (el.closest('.mg-sky, .sr-only, [hidden], svg')) continue;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    const r = el.getBoundingClientRect();
    if (!r.width && !r.height) continue;
    let inside = false;       // inside something that clips: only that box matters
    for (let p = el.parentElement; p && p.id !== 'page'; p = p.parentElement) {
      if (getComputedStyle(p).overflowX !== 'visible') { inside = true; break; }
    }
    if (inside) continue;
    if (r.right > vw + 1 || r.left < -1) {
      issues.push(`${el.tagName.toLowerCase()}.${String(el.className).split(' ')[0]} spans [${Math.round(r.left)}, ${Math.round(r.right)}] of ${vw}`);
    }
  }
  return issues.slice(0, 6);
});

/** Display type: where a heading wraps, its lines must not touch (Archivo's real ink). */
const tightLines = (page) => page.evaluate(() => {
  const issues = [];
  for (const el of document.querySelectorAll('.mg-h1, .mg-step__title, .mg-big, .mg-facts h3')) {
    if (!el.getClientRects().length) continue;
    const cs = getComputedStyle(el);
    const ctx = document.createElement('canvas').getContext('2d');
    ctx.font = `${cs.fontWeight} 200px ${cs.fontFamily}`;
    const ink = (ctx.measureText('gjpqy').actualBoundingBoxDescent + ctx.measureText('bdfhklt').actualBoundingBoxAscent) / 200;
    const spare = parseFloat(cs.lineHeight) / parseFloat(cs.fontSize) - ink;
    if (spare < 0.015) issues.push(`${el.className || el.tagName}: line pitch leaves ${spare.toFixed(3)}em`);
  }
  return issues;
});

// ── 1. the walkthrough, with the mouse ─────────────────────────────────────────────────
await section('walk', 'One step at a time: "I did this" opens the next step and brings it into view', async () => {
  const s = await open();
  const { page } = s;
  let v = await snap(page);
  eq(v.state, { current: 1, all: false, device: 'mac', download: MacConfig.MAC_DOWNLOAD_URL }, 'starts at step 1 on a Mac, with the committed download');
  eq(v.open, [true, false, false, false, false], 'only step 1 is open');
  eq(v.classes, ['is-active', 'is-locked', 'is-locked', 'is-locked', 'is-locked'], 'the others are locked');
  eq(v.label, 'Step 1 of 5', 'the progress label says where you are');
  eq(v.rail, ['is-current', '', '', '', ''], 'the progress bar marks step 1');
  eq(v.nexts, [true, false, false, false, false], 'one "I did this" button, on the open step');
  eq(await page.locator('#step-1 .mg-next').innerText(), 'I did this', 'the button says "I did this"');
  ok(await page.locator('#progress').isVisible(), 'the progress bar is shown once the script runs');

  for (let n = 1; n < STEPS; n++) {
    await page.locator(`#step-${n} .mg-next`).click();
    await page.waitForFunction((i) => window.WrappedMacGuide.state().current === i, n + 1);
    v = await snap(page);
    eq(v.open, Array.from({ length: STEPS }, (_, i) => i === n), `after step ${n}: only step ${n + 1} is open`);
    eq(v.current, n + 1, `step ${n + 1} is the current step (aria-current)`);
    eq(v.classes.slice(0, n), Array(n).fill('is-done'), `steps 1 to ${n} are marked done`);
    eq(v.label, `Step ${n + 1} of 5`, `the progress label moves to ${n + 1}`);
    eq(v.rail[n], 'is-current', 'the progress bar moves along');
    eq(v.focus, `h-${n + 1}`, `focus moves to step ${n + 1}'s heading`);
    ok(/^Step \d of 5: /.test(v.status) && v.status.startsWith(`Step ${n + 1} of 5`), `the change is announced (${v.status})`);
    const top = await headingTop(page, n + 1);
    ok(top >= 0 && top < 260, `step ${n + 1} is scrolled into view, below the progress bar (heading at ${Math.round(top)} px)`);
    const bar = await page.evaluate(() => document.getElementById('progress').getBoundingClientRect().bottom);
    ok(bar <= top + 1, `the sticky progress bar does not cover the heading (${Math.round(bar)} ≤ ${Math.round(top)})`);
  }
  eq(v.nexts, [false, false, false, false, false], 'the last step has no "I did this"');
  ok(await page.locator('#restart').isVisible(), 'the last step offers to start again');

  // A done step can be opened again; the ones after it close.
  ok(await page.locator('#step-2 .mg-again').isVisible(), 'a finished step offers "Show again"');
  await page.locator('#step-2 .mg-again').click();
  v = await snap(page);
  eq([v.state.current, v.open], [2, [false, true, false, false, false]], '"Show again" goes back to that step');

  // Show all steps, and back.
  await page.click('#show-all');
  v = await snap(page);
  eq(v.open, [true, true, true, true, true], '"Show all steps" opens every step');
  eq(v.nexts, [false, false, false, false, false], 'and hides the "I did this" buttons');
  eq(await page.getAttribute('#show-all', 'aria-pressed'), 'true', 'the toggle is pressed');
  eq(await page.innerText('#show-all'), 'One step at a time', 'and offers the way back');
  eq(v.label, 'All 5 steps', 'the progress label says so');
  await page.click('#show-all');
  v = await snap(page);
  eq([v.state, v.open], [{ current: 2, all: false, device: 'mac', download: MacConfig.MAC_DOWNLOAD_URL }, [false, true, false, false, false]], 'back to one step, where you were');

  // The progress bar jumps to a step too.
  await page.locator('#rail > li:nth-child(4) button').click();
  eq((await snap(page)).state.current, 4, 'a segment of the progress bar opens its step');
  await page.locator('#step-4 .mg-next').click();
  await page.click('#restart');
  eq((await snap(page)).state.current, 1, '"Start again" goes back to step 1');

  // "Something else happened?" in every step.
  await page.click('#show-all');
  const faqs = await page.$$eval('.mg-step', (steps) => steps.map((st) => {
    const d = st.querySelector('details.mg-more');
    return d ? [d.querySelector('summary').textContent.trim(), d.querySelectorAll('dt').length] : null;
  }));
  ok(faqs.every((f) => f && f[0] === 'Something else happened?' && f[1] >= 1), `every step has a "Something else happened?" list (${JSON.stringify(faqs)})`);
  const text = (await page.locator('#guide').textContent()).replace(/\s+/g, ' ');
  ok(/more than an hour|about an hour/.test(text) && /Open the app again|open the app again/i.test(text), 'step 3 explains the missing Open Anyway line (about an hour; open the app again first)');
  ok(/is damaged and can.t be opened/.test(text), 'step 2 covers "damaged"');
  ok(/looks empty/.test(text), 'step 4 covers the empty-looking Messages folder window');
  ok(/Nothing happens after/.test(text), 'step 5 covers nothing happening after the command');
  s.clean('walk');
  await s.close();
});

// ── 2. the same with the keyboard only ─────────────────────────────────────────────────
await section('keyboard', 'Keyboard only: Tab to "I did this", Enter or Space, focus follows', async () => {
  const s = await open();
  const { page } = s;
  const focused = () => page.evaluate(() => {
    const el = document.activeElement;
    if (!el) return '';
    const step = el.closest('.mg-step');
    return (step ? step.id + ' ' : '') + (el.id || el.className || el.tagName);
  });
  for (let n = 1; n < STEPS; n++) {
    let presses = 0;
    while (!(await focused()).startsWith(`step-${n} mg-btn`) && presses < 60) { await page.keyboard.press('Tab'); presses++; }
    ok(presses < 60, `step ${n}: "I did this" is reachable with Tab (${presses} presses)`);
    await page.keyboard.press(n % 2 ? 'Enter' : 'Space');
    await page.waitForFunction((i) => window.WrappedMacGuide.state().current === i, n + 1);
    eq(await focused(), `step-${n + 1} h-${n + 1}`, `step ${n + 1}: focus lands on its heading`);
    const visible = await page.evaluate(() => { const r = document.activeElement.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight; });
    ok(visible, `step ${n + 1}: the focused heading is on screen`);
  }
  // The first Tab from the heading reaches something inside the step, not the next step.
  await page.keyboard.press('Tab');
  ok((await focused()).startsWith('step-5'), `Tab from the heading stays inside the open step (${await focused()})`);
  // "Show all steps" with the keyboard.
  await page.focus('#show-all');
  await page.keyboard.press('Space');
  eq((await snap(page)).open, [true, true, true, true, true], 'Space on "Show all steps" opens every step');
  // A disclosure with the keyboard.
  await page.focus('#step-3 summary');
  await page.keyboard.press('Enter');
  ok(await page.evaluate(() => document.querySelector('#step-3 details').open), 'Enter opens "Something else happened?"');
  const ring = await page.evaluate(() => { document.getElementById('show-all').focus(); return getComputedStyle(document.activeElement).outlineStyle; });
  ok(ring !== 'none', `focused controls show a focus ring (${ring})`);
  s.clean('keyboard');
  await s.close();
});

// ── 3. the System Settings button ─────────────────────────────────────────────────────
await section('deeplink', 'The Privacy & Security button links straight to that pane', async () => {
  const s = await open();
  const { page } = s;
  await page.click('#show-all');
  eq(await page.getAttribute('#open-settings', 'href'), DEEP_LINK, 'href is the Privacy & Security deep link');
  eq(await page.getAttribute('#open-settings', 'target'), null, 'it opens in place (no new tab)');
  eq((await page.innerText('#open-settings')).replace(/\s+/g, ' ').trim(), 'Open Privacy & Security', 'the button says what it opens');
  const note = await page.innerText('.mg-deeplink__note');
  ok(/browser asks/i.test(note) && /System Settings/.test(note), 'the page says the browser will ask first');
  const manual = await page.innerText('.mg-manual');
  ok(/Apple menu/.test(manual) && /System Settings/.test(manual) && /Privacy & Security/.test(manual), 'the way by hand is spelled out');
  s.clean('deeplink');
  await s.close();
});

// ── 4. download: not public yet, and configured ───────────────────────────────────────
await section('download', 'Download: "not public yet" while the address is empty; a button once it is set', async () => {
  eq(MacConfig.MAC_DOWNLOAD_URL, 'https://github.com/averyhsu/imessage-wrap/releases/latest/download/Threadback-for-Mac.dmg',
    'the committed config points at the newest release on GitHub');
  let s = await open();
  ok(await s.page.locator('#download').isVisible(), 'as committed: the Download button is shown');
  eq(await s.page.getAttribute('#download', 'href'), MacConfig.MAC_DOWNLOAD_URL, 'as committed: it points at that release');
  s.clean('download (as committed)');
  await s.close();
  s = await open({ download: '' });
  let page = s.page;
  ok(await page.locator('#download').isHidden(), 'empty address: no Download button');
  ok(await page.locator('#download-none').isVisible(), 'empty address: the honest line is shown');
  ok(/not public yet/.test(await page.innerText('#download-none')), 'it says the download is not public yet');
  eq(await page.getAttribute('#download-none a', 'href'), MacConfig.SOURCE_URL, 'and links to the project on GitHub');
  s.clean('download (empty)');
  await s.close();

  const release = 'https://github.com/averyhsu/imessage-wrap/releases/download/v0.1.0/Threadback-for-Mac.zip';
  for (const [label, url, expected] of [['https address', release, release], ['relative path', 'downloads/Threadback.zip', 'downloads/Threadback.zip']]) {
    s = await open({ download: url });
    page = s.page;
    ok(await page.locator('#download').isVisible(), `${label}: the Download button is shown`);
    eq(await page.getAttribute('#download', 'href'), expected, `${label}: it points at the configured address`);
    ok(await page.locator('#download-none').isHidden(), `${label}: the "not public yet" line is gone`);
    ok(await page.locator('#download-note').isVisible(), `${label}: the note under the button is shown`);
    s.clean(`download (${label})`);
    await s.close();
  }
  for (const bad of ['javascript:alert(1)', 'http://example.com/app.zip', '//example.com/app.zip']) {
    s = await open({ download: bad });
    page = s.page;
    ok(await page.locator('#download').isHidden() && await page.locator('#download-none').isVisible(), `an unusable address (${bad}) is treated as no download`);
    s.clean(`download (${bad})`);
    await s.close();
  }
});

// ── 5. the device it is on ─────────────────────────────────────────────────────────────
await section('devices', 'iPhone, iPad, Android, Windows, Linux: "This part needs a Mac"', async () => {
  const release = 'https://github.com/averyhsu/imessage-wrap/releases/download/v0.1.0/Threadback-for-Mac.zip';
  for (const [device, ua, words, extra] of [
    ['iphone', UA.iphone, 'an iPhone', { viewport: VIEWPORTS['phone-390'] }],
    ['ipad', UA.ipad, 'an iPad', { viewport: VIEWPORTS['tablet-768'], touch: true }],
    ['android', UA.android, 'an Android phone', { viewport: VIEWPORTS['phone-360'] }],
    ['windows', UA.windows, 'a Windows computer', {}],
    ['linux', UA.linux, 'a Linux computer', {}],
  ]) {
    const s = await open({ ua, download: release, ...extra });
    const { page } = s;
    eq((await snap(page)).state.device, device, `${device}: detected`);
    ok(await page.locator('#not-mac').isVisible(), `${device}: "This part needs a Mac" is shown`);
    eq(await page.innerText('#not-mac-device'), words, `${device}: it names the device`);
    eq(await page.getAttribute('#not-mac a', 'href'), '../', `${device}: with a link back to the main page`);
    ok(await page.locator('#download').isHidden() && await page.locator('#download-none').isHidden(), `${device}: no download offered on a device that cannot run it`);
    ok(await page.locator('#step-1 .mg-next').isVisible(), `${device}: the steps can still be read`);
    s.clean(device);
    await s.close();
  }
  for (const [label, ua] of [['Safari on a Mac', UA.mac], ['Chrome on a Mac', UA.macChrome]]) {
    const s = await open({ ua, download: release });
    eq((await snap(s.page)).state.device, 'mac', `${label}: detected as a Mac`);
    ok(await s.page.locator('#not-mac').isHidden(), `${label}: no "needs a Mac" notice`);
    ok(await s.page.locator('#download').isVisible(), `${label}: the Download button is shown`);
    s.clean(label);
    await s.close();
  }
  // The same rule as a function, for the cases a browser cannot fake here.
  eq(Guide.platform(UA.ipad, 5), 'ipad', 'a "Macintosh" with a touch screen is an iPad');
  eq(Guide.platform(UA.ipad, 0), 'mac', 'a "Macintosh" without one is a Mac');
});

// ── 6. without JavaScript ──────────────────────────────────────────────────────────────
await section('nojs', 'Without JavaScript every step is shown, with macOS\'s words and no dead buttons', async () => {
  const s = await open({ js: false });
  const { page } = s;
  const v = await page.evaluate(() => {
    const shown = (el) => !!el && !el.hidden && getComputedStyle(el).display !== 'none' && el.getClientRects().length > 0;
    return {
      open: [...document.querySelectorAll('.mg-step__body')].map(shown),
      nexts: [...document.querySelectorAll('.mg-next, .mg-again, #restart')].filter(shown).length,
      progress: shown(document.getElementById('progress')),
      text: document.getElementById('page').innerText,
    };
  });
  eq(v.open, [true, true, true, true, true], 'all five steps are open');
  eq(v.nexts, 0, 'no buttons that would need the script');
  ok(!v.progress, 'no progress bar (there is nothing to track)');
  ok(/Turn on JavaScript to see the Download button/.test(v.text), 'the noscript line explains where the download is');
  ok(/was blocked to protect your Mac/.test(v.text) && /Not Opened/.test(v.text) && /Open Anyway/.test(v.text), 'macOS\'s words are there');
  ok(/drag the app to Applications/i.test(v.text), 'the app is called "the app" where the name would come from the script');
  eq(await page.getAttribute('#open-settings', 'href'), DEEP_LINK, 'the System Settings button works without the script');
  s.clean('nojs');
  await s.close();
});

// ── 7. layout at four widths ───────────────────────────────────────────────────────────
await section('layout', 'No sideways scrolling at 360, 390, 768 and 1440; headings keep clear; images load', async () => {
  for (const [name, viewport] of Object.entries(VIEWPORTS)) {
    for (const ua of [UA.mac, UA.iphone]) {
      const s = await open({ viewport, ua, download: 'https://github.com/averyhsu/imessage-wrap/releases/download/v0.1.0/Threadback-for-Mac.zip' });
      const { page } = s;
      const who = `${name} ${ua === UA.mac ? 'Mac' : 'iPhone'}`;
      eq(await overflow(page), [], `[${who}] one step: nothing sticks out sideways`);
      await page.click('#show-all');
      await page.$$eval('details', (ds) => ds.forEach((d) => { d.open = true; }));
      eq(await overflow(page), [], `[${who}] all steps, every disclosure open: nothing sticks out sideways`);
      eq(await tightLines(page), [], `[${who}] wrapped headings do not touch`);
      if (ua === UA.mac) {
        // Lazy pictures: scroll each into view, then check it arrived.
        const imgs = await page.$$('#page img');
        for (const img of imgs) await img.scrollIntoViewIfNeeded();
        await page.waitForFunction(() => [...document.querySelectorAll('#page img')].every((i) => i.complete), null, { timeout: 10000 });
        const broken = await page.$$eval('#page img', (list) => list.filter((i) => !i.naturalWidth).map((i) => i.getAttribute('src')));
        eq(broken, [], `[${who}] every picture loads`);
        // Locked steps at this width: nothing sticks out either.
        await page.click('#show-all');
        await page.click('#rail > li:nth-child(3) button');
        eq(await overflow(page), [], `[${who}] step 3 with the progress bar stuck: nothing sticks out sideways`);
        ok(await page.evaluate(() => document.getElementById('progress').classList.contains('is-stuck')), `[${who}] the progress bar sticks to the top once scrolled`);
      }
      s.clean(who);
      await s.close();
    }
  }
});

// ── 8. reduced motion ──────────────────────────────────────────────────────────────────
await section('motion', 'Reduced motion: nothing moves, and the jump to the next step is instant', async () => {
  let s = await open({ reducedMotion: 'reduce' });
  let page = s.page;
  await page.locator('#step-1 .mg-next').click();
  const right = await page.evaluate(() => scrollY);
  await page.waitForTimeout(700);
  eq(await page.evaluate(() => scrollY), right, 'the page is already where it ends up (no smooth scroll)');
  eq(await page.evaluate(() => document.getAnimations().filter((a) => a.playState === 'running').map((a) => a.animationName || a.constructor.name)), [], 'no animation runs');
  s.clean('reduced motion');
  await s.close();

  s = await open({ reducedMotion: 'no-preference' });
  page = s.page;
  await page.locator('#step-1 .mg-next').click();
  const names = await page.evaluate(() => [...new Set(document.getAnimations().map((a) => a.animationName).filter(Boolean))]);
  ok(names.includes('mg-ring'), `with motion allowed the "click here" ring pulses (${names.join(', ')})`);
  s.clean('motion');
  await s.close();
});

// ── 9. screenshots ─────────────────────────────────────────────────────────────────────
await section('shots', 'Screenshots of every step, phone and desktop', async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const shot = async (page, name, selector) => {
    await page.evaluate(() => { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); });
    await page.mouse.move(1, 1);
    await page.waitForTimeout(250);
    const file = path.join(SHOTS, `mac-guide-${name}.png`);
    // One element, cut out of a whole-page picture: an element taller than what is left of
    // the window below it would otherwise come out with its bottom missing.
    const clip = selector
      ? await page.locator(selector).evaluate((el) => { const r = el.getBoundingClientRect(); return { x: r.left, y: r.top + scrollY, width: r.width, height: r.height }; })
      : undefined;
    await page.screenshot({ path: file, fullPage: true, clip, animations: 'disabled' });
  };
  const slugs = ['1-applications', '2-first-open', '3-open-anyway', '4-setup', '5-done'];
  for (const [size, viewport] of [['desktop', VIEWPORTS['desktop-1440']], ['phone', VIEWPORTS['phone-390']]]) {
    const s = await open({ viewport, scale: 1 });
    const { page } = s;
    await shot(page, `0-start-${size}`);
    for (let n = 1; n <= STEPS; n++) {
      if (n > 1) await page.locator(`#step-${n - 1} .mg-next`).click();
      await page.evaluate(() => Promise.all([...document.querySelectorAll('.mg-step.is-active img')].map((i) => { i.loading = 'eager'; return i.decode().catch(() => {}); })));
      await shot(page, `${slugs[n - 1]}-${size}`, `#step-${n}`);
    }
    // The likely failures of the hardest step, opened.
    await page.click('#rail > li:nth-child(3) button');
    await page.evaluate(() => { document.querySelector('#step-3 details').open = true; });
    await shot(page, `3-open-anyway-problems-${size}`, '#step-3');
    s.clean(`shots ${size}`);
    await s.close();
  }
  // The two other states of the top of the page.
  let s = await open({ viewport: VIEWPORTS['phone-390'], ua: UA.iphone });
  await shot(s.page, 'not-a-mac-phone', '.mg-hero');
  await s.close();
  s = await open({ download: 'https://github.com/averyhsu/imessage-wrap/releases/download/v0.1.0/Threadback-for-Mac.zip' });
  await shot(s.page, 'download-ready-desktop', '.mg-hero');
  await s.close();

  const written = fs.readdirSync(SHOTS).filter((f) => /^mac-guide-.*\.png$/.test(f)).sort();
  ok(written.length >= 16, `${written.length} screenshots written to ${path.relative(ROOT, SHOTS)}/`);
  const committed = fs.readdirSync(path.join(ROOT, 'docs/screenshots/web')).filter((f) => /^mac-guide-.*\.png$/.test(f)).sort();
  eq(committed, written, 'docs/screenshots/web/ holds one committed picture for each of them');
});

await browser.close();
await server.close();

console.log('\n' + '─'.repeat(72));
for (const flow of flows) console.log(`${flow.passed ? '✓' : '✗'} ${flow.name.padEnd(9)} ${String(flow.checks).padStart(4)} checks`);
console.log(`${checks} checks, ${failures.length} failed`);
if (failures.length) {
  console.log('\nFailures:');
  for (const f of failures) console.log(' - ' + f);
  process.exit(1);
}
