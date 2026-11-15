// End-to-end checks for the "Make your own" page (web/make/), in headless Chromium (or
// BROWSER=webkit / BROWSER=firefox).
//
//   npm run test:make                       everything; exits non-zero on any failure
//   node tests/e2e/make/run.mjs --only=mac,paste
//   npm run shots:make                      rewrite docs/screenshots/web/make-*.png
//
// Sections: mac, nowal, progress, search, backup, paste, sample, rename, guards, keyboard,
// matrix, shots.
//
// The invented Messages databases are built into a temporary folder with
// tests/fixtures/build_fixture.py and deleted afterwards; nothing is read from a real device
// and no database is ever written inside the repository. What the page computes is compared
// with the Python command-line tool (`python3 -m wrapped ...`) on the same files.
//
// A plain run leaves the repository as it found it: its screenshots go to
// test-results/make-screenshots/ (ignored by git). Only --update-screenshots rewrites the
// committed pictures in docs/screenshots/web/.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { ROOT, WEB, BROWSER, IS_CHROMIUM, note, ABORTED, startServer, launch, contextOptions, waitForStory, showSettled } from '../lib.mjs';

const require = createRequire(import.meta.url);
const Engine = require(path.join(WEB, 'make/engine.js'));
const Import = require(path.join(WEB, 'make/import-rows.js'));
const Config = require(path.join(WEB, 'js/config.js'));
// Same DEFLATE implementation as the page, so links built here are character-for-character
// the ones the page builds.
Engine.useCodec(require(path.join(WEB, 'js/vendor/fflate.min.js')));

const PYTHON = process.env.PYTHON || 'python3';
const LA = 'America/Los_Angeles';
const UPDATE_SHOTS = process.argv.includes('--update-screenshots');
// The committed pictures are Chromium's; another engine may only write to test-results/.
if (UPDATE_SHOTS && !IS_CHROMIUM) { console.error('--update-screenshots runs in Chromium only (BROWSER=' + BROWSER + ')'); process.exit(2); }
const SHOTS = path.join(ROOT, UPDATE_SHOTS ? 'docs/screenshots/web' : 'test-results/make-screenshots');
const VIEWPORTS = {
  'phone-360': { width: 360, height: 740, mobile: true },
  'phone-390': { width: 390, height: 844, mobile: true },
  'tablet-768': { width: 768, height: 1024, mobile: true },
  'desktop-1440': { width: 1440, height: 900 },
};
const only = (process.argv.find((a) => a.startsWith('--only=')) || '').slice(7).split(',').filter(Boolean);
const wants = (name) => only.length === 0 || only.includes(name);

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

// ── fixtures ───────────────────────────────────────────────────────────────────────────

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'threadback-make-'));
const FX = path.join(TMP, 'fx');
const EXTRA = path.join(TMP, 'extra');
execFileSync(PYTHON, [path.join(ROOT, 'tests/fixtures/build_fixture.py'), FX], { stdio: ['ignore', 'ignore', 'inherit'] });
execFileSync(PYTHON, [path.join(ROOT, 'tests/e2e/make/extra_fixtures.py'), EXTRA], { stdio: ['ignore', 'ignore', 'inherit'] });
const fixture = JSON.parse(fs.readFileSync(path.join(FX, 'fixture.json'), 'utf8'));
const fx = (rel) => path.join(FX, rel);
const P = fixture.paths;
const CHAT_DB = fx(P.chat_db);
const CHAT_WAL = fx(P.chat_db_wal);
const BOOKS = P.address_books.map(fx);
const BOOK_DIR = fx(P.address_book_dir);
const BACKUP = fx(P.backup);
const TACO = fixture.chats.lively.rowid;
const STRESS = fixture.chats.stress.rowid;
const UNNAMED = fixture.chats.unnamed.rowid;

/** Run the command-line tool; returns its standard output. */
function cli(args, tz = LA) {
  return execFileSync(PYTHON, ['-m', 'wrapped', ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    // Without --me the tool would look up the first name of this computer's account (on a
    // Mac); the tests say "Me" where they mean the page's "Leave me as Me".
    env: { ...process.env, PYTHONPATH: ROOT, PYTHONIOENCODING: 'utf-8', TZ: tz, WRAPPED_ME: 'Me' },
  });
}
const cliChats = (args) => JSON.parse(cli(['chats', '--json', ...args]));
// The page is compared with the engine's own output for the names it was given. Once the
// command-line tool shortens names by default (docs/SCHEMA.md section 2, "Short names"),
// that is what its --full-names prints; until then the flag does not exist.
const FULL_NAMES = /--full-names/.test(cli(['stats', '--help'])) ? ['--full-names'] : [];
const cliStats = (args, tz) => cli(['stats', ...args, ...FULL_NAMES, '--compact'], tz).replace(/\n$/, '');
const brief = (chat) => ({ id: chat.id, name: chat.name, members: chat.members, messages: chat.messages, last_unix: chat.last_unix });

// Every raw phone number and e-mail address in the fixture: none may ever reach a link.
const RAW_HANDLES = [...new Set(cliChats(['--db', CHAT_DB, '--no-contacts']).chats.flatMap((c) => c.participants))];
function leaks(text) {
  const found = [];
  for (const handle of RAW_HANDLES) {
    const digits = handle.replace(/[^0-9]/g, '');
    if (text.includes(handle)) found.push(handle);
    else if (!handle.includes('@') && digits.length >= 7 && text.includes(digits.slice(-10))) found.push(digits.slice(-10));
    else if (handle.includes('@') && text.toLowerCase().includes('@' + handle.split('@')[1].toLowerCase())) found.push(handle);
  }
  return found;
}

const server = await startServer();
const browser = await launch();
const origin = new URL(server.url).origin;
const MAKE = server.url + 'make/';

/** A page that records console errors, failed requests, CSP violations and foreign requests. */
async function open(opts = {}) {
  const vp = opts.viewport || VIEWPORTS['desktop-1440'];
  const context = await browser.newContext(contextOptions({
    viewport: { width: vp.width, height: vp.height },
    deviceScaleFactor: opts.scale || 1,
    hasTouch: !!vp.mobile,
    isMobile: !!vp.mobile,
    timezoneId: opts.tz || LA,
    locale: 'en-US',
    reducedMotion: opts.still ? 'reduce' : (opts.reducedMotion || 'no-preference'),
    permissions: opts.permissions || [],
    bypassCSP: !!(opts.still || opts.bypassCSP),
  }));
  const problems = [];
  const foreign = [];
  const requests = [];
  context.on('request', (req) => {
    const url = req.url();
    requests.push(url);
    if (/^(data|blob|about):/.test(url)) return;
    if (!url.startsWith(origin + '/')) foreign.push(url);
  });
  await context.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (e) => {
      console.error('CSP violation: ' + e.violatedDirective + ' ' + e.blockedURI);
    });
  });
  if (opts.init) await context.addInitScript(opts.init);
  if (opts.still) {
    // For screenshots only: no animation, transition or transform at all, so that every
    // run paints the same pixels. (Injecting a style needs bypassCSP; the sections that
    // check the page's own policy do not use this.)
    await context.addInitScript(() => {
      if (!/\/make\//.test(location.pathname)) return;
      const add = () => {
        if (!document.documentElement) return false;
        const style = document.createElement('style');
        style.textContent = '*, *::before, *::after { animation: none !important; transition: none !important; }' +
          ' .mk-btn:active, .mk-tab:active, .mk-chat:active, .mk-copy:active { transform: none !important; }';
        document.documentElement.appendChild(style);
        return true;
      };
      if (!add()) new MutationObserver((_, o) => { if (add()) o.disconnect(); }).observe(document, { childList: true });
    });
  }
  const page = await context.newPage();
  context.on('console', (m) => { if (m.type() === 'error') problems.push('console: ' + m.text()); });
  context.on('weberror', (e) => problems.push('pageerror: ' + e.error().message));
  context.on('requestfailed', (r) => {
    const why = r.failure() ? r.failure().errorText : '';
    // A load inside the preview frame that was cut short because the frame was sent
    // somewhere else (a test does that on purpose) is not a failure of the page.
    let inPreview = false;
    try { inPreview = r.frame() !== page.mainFrame(); } catch { inPreview = false; }
    if (ABORTED.test(why) && inPreview) return;
    problems.push('requestfailed: ' + r.url() + ' ' + why);
  });
  if (opts.goto !== false) {
    await page.goto(MAKE + (opts.hash || ''));
    await page.evaluate(() => document.fonts.ready);
  }
  return {
    context, page, problems, foreign, requests,
    clean(label) {
      eq(problems, [], `${label}: no console errors, failed requests or CSP violations`);
      eq(foreign, [], `${label}: no request left this origin`);
    },
    close: () => context.close(),
  };
}

// ── page helpers ───────────────────────────────────────────────────────────────────────

const snap = (page) => page.evaluate(() => window.WrappedMake.snapshot());
async function settled(page) {
  await page.waitForFunction(() => !window.WrappedMake.snapshot().busy, null, { timeout: 60000 });
  return snap(page);
}
const visible = (page, selector) => page.locator(selector).isVisible();
const text = (page, selector) => page.locator(selector).innerText();
const listed = (page) => page.$$eval('.mk-chat', (els) => els.map((e) => ({
  id: Number(e.dataset.chatId),
  name: e.querySelector('.mk-chat__name').textContent.replace(/⁠/g, ''),     // minus the invisible "keep together" marks
  members: Number(e.dataset.members),
  messages: Number(e.dataset.messages),
  last_unix: e.dataset.lastUnix === '' ? null : Number(e.dataset.lastUnix),
})));

async function addMac(page, files) {
  await page.setInputFiles('#input-mac', files);
  await page.waitForSelector('#step-chat.is-active', { timeout: 60000 });
}
async function pick(page, id) {
  await page.click(`.mk-chat[data-chat-id="${id}"]`);
  await page.waitForSelector('#step-tune.is-active', { timeout: 60000 });
}
/** Choose a period. (A DOM click: the page may still be scrolling to the step it just opened.) */
async function period(page, value) {
  await page.locator(`input[name="period"][value="${value}"]`).evaluate((radio) => radio.click());
}
/**
 * Set the quotes switch by clicking its label, as a person would. (An ordinary click, so
 * Playwright waits until the page has stopped scrolling; a forced click on the invisible
 * checkbox can land somewhere else while the page is still moving.)
 */
async function quotes(page, on) {
  if ((await page.locator('#quotes').isChecked()) !== on) await page.locator('.mk-switch__text').click();
  await page.waitForFunction((want) => document.getElementById('quotes').checked === want, on, { timeout: 10000 });
}
/**
 * Press "Create recap". A recap is not made until the owner has typed their name or has
 * chosen to stay "Me"; a test that is not about that choice takes "Me", which is also what
 * the command-line tool calls the owner unless told otherwise.
 */
async function create(page) {
  await page.evaluate(() => {
    const name = document.getElementById('me-name');
    const stay = document.getElementById('me-as-me');
    if (!name.value.trim() && !stay.checked) stay.click();
  });
  await page.click('#create');
  await page.waitForFunction(() => {
    const s = window.WrappedMake.snapshot();
    return s.created && !s.busy;
  }, null, { timeout: 60000 });
  return snap(page);
}
/** Type a display name for the person whose row carries this key. */
async function rename(page, key, name) {
  if (key !== 'me') return page.locator(`.mk-person[data-person="${key}"] input`).fill(name);
  // The owner has a field of their own, which is switched off while they stay "Me".
  await page.evaluate(() => { const stay = document.getElementById('me-as-me'); if (stay.checked) stay.click(); });
  return page.locator('#me-name').fill(name);
}
const nowYear = (tz = LA) => Number(new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric' }).format(new Date()));

function firstDifference(a, b) {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return `first difference at ${i}: page …${a.slice(Math.max(0, i - 40), i + 60)}… vs CLI …${b.slice(Math.max(0, i - 40), i + 60)}…`;
}

/** The stats on the page are byte-for-byte what the command-line tool prints. */
async function matchesCli(page, args, tz, message) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const expected = cliStats(args, tz);
    const got = (await settled(page)).statsJson;
    if (got === expected) return ok(true, message);
    // The calendar day may have turned over between the two: count again, once.
    const stale = got && JSON.parse(got).meta.generated !== JSON.parse(expected).meta.generated;
    if (attempt === 0 && stale) { await page.locator('#chat-name').dispatchEvent('input'); continue; }
    return ok(false, `${message}: ${got ? firstDifference(got, expected) : 'the page has no stats'}`);
  }
  return false;
}

const decode = (url) => Engine.statsFromUrl(url);
const payloadOf = (url) => url.split('#w1=')[1];
const localStory = (url) => server.url + '#w1=' + payloadOf(url);

/**
 * Inside the preview frame, go to the story's last slide and press ITS "Copy link".
 * Returns what lands on the clipboard. (Needs the clipboard permissions.)
 */
async function copyFromStory(page) {
  await page.evaluate(() => navigator.clipboard.writeText('nothing copied yet'));
  const frame = await previewFrame(page);
  await frame.evaluate(() => Promise.all([document.fonts.ready, window.WrappedCard.ready()]));
  await frame.evaluate(() => {
    const S = window.WrappedStory;
    S.pause();
    S.goTo(S.total - 1);
    S.layout();
    S.settle();
    return new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  });
  await page.evaluate(() => document.getElementById('preview').scrollIntoView({ block: 'center' }));
  await frame.locator('.slide.is-active [data-action="copy"]').click();     // a real click, on the story's own button
  await page.waitForFunction(() => navigator.clipboard.readText().then((value) => value !== 'nothing copied yet'), null, { timeout: 10000 });
  return page.evaluate(() => navigator.clipboard.readText());
}

/** Open a recap link on the story page and read the big total from its second slide. */
async function storyTotal(url) {
  const s = await open({ viewport: VIEWPORTS['phone-390'], goto: false });
  await s.page.goto(localStory(url));
  await waitForStory(s.page);
  await showSettled(s.page, 1);
  const shown = await s.page.locator('.slide.is-active .total__num').innerText();
  const title = await s.page.title();
  s.clean('story page');
  await s.close();
  return { total: Number(shown.replace(/[^0-9]/g, '')), title };
}

async function previewFrame(page) {
  const handle = await page.waitForSelector('#preview');
  const frame = await handle.contentFrame();
  await frame.waitForFunction(() => window.WrappedStory && window.WrappedStory.isActive(), null, { timeout: 20000 });
  return frame;
}

/** Drop real files (by path) on the page, the way a drag from a file manager would. */
async function dropFiles(page, files) {
  const payload = files.map((file) => ({ name: path.basename(file), b64: fs.readFileSync(file).toString('base64') }));
  const transfer = await page.evaluateHandle((items) => {
    const dt = new DataTransfer();
    for (const item of items) {
      const bin = atob(item.b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      dt.items.add(new File([bytes], item.name));
    }
    return dt;
  }, payload);
  await page.dispatchEvent('body', 'dragenter', { dataTransfer: transfer });
  const hot = await page.evaluate(() => document.getElementById('page').classList.contains('is-dragging'));
  await page.dispatchEvent('body', 'drop', { dataTransfer: transfer });
  return hot;
}

/**
 * Drop a FOLDER. Browsers hand a dropped folder over as a FileSystemDirectoryEntry, which
 * cannot be made from a script, so this builds stand-ins with the same methods (getFile,
 * createReader, file) from a tree of {name: path-on-disk | subtree}.
 */
async function dropFolder(page, name, tree) {
  const encode = (node) => Object.fromEntries(Object.entries(node).map(([key, value]) => [key,
    typeof value === 'string' ? { b64: fs.readFileSync(value).toString('base64') } : { dir: encode(value) }]));
  await page.evaluate(({ name, tree }) => {
    const fileOf = (key, node) => {
      const bin = atob(node.b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      // One fixed time stamp for every file: a Mac's address books share a name and often
      // a size, so two of them must not be mistaken for the same file added twice.
      return new File([bytes], key, { lastModified: 1794000000000 });
    };
    const fileEntry = (key, node) => ({ isFile: true, isDirectory: false, name: key, file: (done) => done(fileOf(key, node)) });
    const dirEntry = (key, nodes) => ({
      isFile: false,
      isDirectory: true,
      name: key,
      getFile(where, _options, done, fail) {
        let at = { dir: nodes };
        const parts = where.split('/');
        for (const part of parts) at = at && at.dir ? at.dir[part] : undefined;
        if (at && at.b64) done(fileEntry(parts[parts.length - 1], at));
        else fail(new DOMException('missing', 'NotFoundError'));
      },
      createReader() {
        let read = false;
        return {
          readEntries(done) {
            if (read) { done([]); return; }
            read = true;
            done(Object.entries(nodes).map(([k, v]) => (v.dir ? dirEntry(k, v.dir) : fileEntry(k, v))));
          },
        };
      },
    });
    const event = new Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'dataTransfer', {
      value: { types: ['Files'], files: [], items: [{ kind: 'file', webkitGetAsEntry: () => dirEntry(name, tree), getAsFile: () => null }] },
    });
    document.body.dispatchEvent(event);
  }, { name, tree: encode(tree) });
}

/** Anything sticking out of the viewport sideways? (The page clips, so scrollWidth is not enough.) */
const overflow = (page) => page.evaluate(() => {
  const vw = document.documentElement.clientWidth;
  const issues = [];
  if (document.documentElement.scrollWidth > vw + 1) issues.push(`the page scrolls sideways (${document.documentElement.scrollWidth} > ${vw})`);
  for (const el of document.querySelectorAll('#page *')) {
    if (el.closest('.mk-sky, .sr-only, [hidden], svg')) continue;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    const r = el.getBoundingClientRect();
    if (!r.width && !r.height) continue;
    let inside = false;       // inside something that clips or scrolls: only that box matters
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

/** A screenshot of the whole page, or of one step when `selector` is given. */
async function shot(page, name, selector) {
  // Same picture every run: nothing focused or hovered, scrolled to the top.
  await page.evaluate(() => {
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
    window.scrollTo(0, 0);
  });
  if (!page.viewportSize() || page.viewportSize().width > 800) await page.mouse.move(2, 2);
  await page.waitForTimeout(500);
  const file = path.join(SHOTS, `make-${name}.png`);
  if (selector) await page.locator(selector).screenshot({ path: file, animations: 'disabled' });
  else await page.screenshot({ path: file, fullPage: true, animations: 'disabled' });
}
/** Hold the preview on the cover so screenshots do not depend on timing. */
async function freezePreview(page) {
  const frame = await previewFrame(page);
  await frame.evaluate(() => Promise.all([document.fonts.ready, window.WrappedCard.ready()]));
  await frame.evaluate(() => {
    const S = window.WrappedStory;
    S.pause();
    S.goTo(0);
    S.layout();
    S.settle();
    return new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  });
}

// ── 1. a Mac: chat.db + chat.db-wal ────────────────────────────────────────────────────
await section('mac', 'Mac: chat.db + chat.db-wal against the command-line tool', async () => {
  const s = await open();
  const { page } = s;
  ok(await visible(page, '#step-source.is-active') && await visible(page, '#panel-mac'), 'starts on step 1 with the Mac instructions');
  eq(await page.locator('.mk-step.is-locked').count(), 3, 'steps 2 to 4 are locked until there are messages');
  eq(await text(page, '.mk-brand__name'), Config.PRODUCT_NAME, 'the product name comes from config.js');

  // Without contact names. Watch what the page announces and whether its main thread stalls.
  await page.evaluate(() => {
    window.__said = [];
    new MutationObserver(() => {
      const now = document.getElementById('status').textContent;
      if (now && window.__said[window.__said.length - 1] !== now) window.__said.push(now);
    }).observe(document.getElementById('status'), { childList: true, characterData: true, subtree: true });
    window.__stall = 0;
    let last = performance.now();
    setInterval(() => { const now = performance.now(); window.__stall = Math.max(window.__stall, now - last); last = now; }, 10);
  });
  await addMac(page, [CHAT_DB, CHAT_WAL]);
  const plain = cliChats(['--db', CHAT_DB, '--no-contacts']);
  eq(await listed(page), plain.chats.map(brief), 'chat list matches `wrapped chats` (no contacts)');
  const said = await page.evaluate(() => window.__said);
  const stages = ['Loading the database reader', 'Reading chat.db (', 'Reading chat.db-wal (', 'Opening the database', 'Finding your group chats', 'Found 4 group chats'];
  const order = stages.map((stage) => said.findIndex((line) => line.startsWith(stage)));
  ok(order.every((at, i) => at !== -1 && (i === 0 || at > order[i - 1])), `progress is announced stage by stage (${said.join(' | ')})`);
  const stall = await page.evaluate(() => window.__stall);
  ok(stall < 1000, `the page stayed responsive while the database was read (longest pause ${Math.round(stall)} ms)`);
  const diag = await text(page, '#diag');
  ok(diag.includes(plain.diagnostics.messages.toLocaleString('en-US') + ' messages') && diag.includes(`${plain.diagnostics.chats} conversations`),
    `diagnostics line shows the totals (${diag.slice(0, 80)}…)`);
  ok(/Oct \d, 2025/.test(diag) && /2027/.test(diag), 'diagnostics line shows the first and the last date');
  ok(!(await visible(page, '#source-notes [data-note="wal_missing"]')), 'no "recent messages may be missing" warning when the -wal is there');
  ok(s.requests.some((u) => u.endsWith('/make/vendor/sql-wasm.wasm')), 'the worker\'s own request (SQLite) is seen by the test, so a foreign one would be too');
  ok(s.requests.some((u) => u.endsWith('/make/worker.js')), 'the work happens in worker.js');
  eq(page.workers().length, 1, 'one background worker');
  eq(await page.workers()[0].evaluate(() => ['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'importScripts'].map((name) => typeof self[name])),
    ['undefined', 'undefined', 'undefined', 'undefined', 'undefined'], 'which has removed its own network functions before reading the files');
  ok(!(await visible(page, '#chat-search-wrap')), 'no search box for four chats');

  // Add the address books afterwards: the same database is read again, now with names.
  await page.setInputFiles('#input-mac', BOOKS);
  await page.waitForFunction(() => /contact/.test(document.getElementById('source-summary').textContent), null, { timeout: 60000 });
  await page.waitForSelector('#step-chat.is-active');
  const named = cliChats(['--db', CHAT_DB, '--contacts', BOOK_DIR]);
  eq(await listed(page), named.chats.map(brief), 'chat list matches `wrapped chats --contacts`');
  ok((await text(page, `.mk-chat[data-chat-id="${TACO}"]`)).includes('Ines Calloway'), 'the list says who is in each chat');

  await pick(page, TACO);
  ok(await visible(page, '#step-chat.is-done') && (await text(page, '#chat-summary')).includes('Taco Tuesday Crew'), 'the chosen chat folds into a summary');
  const year = nowYear();
  const base = [String(TACO), '--db', CHAT_DB, '--contacts', BOOK_DIR];

  await period(page, 'custom');
  await page.fill('#period-start', '2026-01-01');
  await page.fill('#period-end', '2026-11-10');
  let state = await create(page);
  ok(await visible(page, '#recap'), 'the recap appears');

  // People go by first names to begin with: a full name in an address book is the owner's
  // own label for someone. The full name stays in the list as a hint, on this device only.
  eq(state.stats.senders.map((x) => x.name).sort(), ['Bram', 'Ines', 'Me', 'Sam C.', 'Sam R.', 'Zoë', '…0006'].sort(),
    'by default people go by first names, with an initial where two share one');
  ok(!/Calloway|Okoye|Rivera|Chen|Müller/.test(JSON.stringify(decode(state.link.url))), 'so no surname from the address book is in the link');
  ok((await text(page, '.mk-person[data-person="n:Ines Calloway"]')).includes('Ines Calloway'), 'the full name stays in the list as a hint');
  eq(await page.inputValue('.mk-person[data-person="n:Sam Rivera"] input'), 'Sam R.', 'and the short name is what the field holds, ready to edit');
  eq(await text(page, '#first-names'), 'Use the full names', 'full names are one click away');
  await page.click('#first-names');
  eq(await page.inputValue('.mk-person[data-person="n:Sam Rivera"] input'), 'Sam Rivera', 'the fields then show the full names');

  await matchesCli(page, [...base, '--tz', LA, '--start', '2026-01-01', '--end', '2026-11-10'], LA, 'custom range, full names: stats are byte-identical to `wrapped stats`');
  state = await snap(page);
  eq(state.stats.totals.messages, 2869, 'the fixture\'s known total for 2026 so far');

  // The link.
  const link = state.link.url;
  ok(link.startsWith(Config.BASE_URL + '#w1=') && state.link.length === link.length && link.length <= 4800, `link is under the budget (${link.length} characters)`);
  eq(await page.inputValue('#link'), link, 'the link field holds the link');
  // Served from somewhere other than the public site (here: the test server), "Open story"
  // opens the story next to this page with the very same recap; the copied link stays public.
  eq(await page.getAttribute('#open', 'href'), '../' + link.slice(link.indexOf('#')),
    '"Open story" opens the local story with the same recap');
  const decoded = decode(link);
  eq(decoded, Engine.fitLink(state.stats, { quotes: false }).stats, 'the link decodes to the stats, with no message text');
  ok(decoded.most_reacted.length === 3 && decoded.most_reacted.every((m) => m.text === ''), 'quotes are off by default: every most_reacted text is blank');
  eq(leaks(JSON.stringify(decoded)), [], 'no phone number or e-mail address from the database is in the link');
  eq(leaks(state.statsJson), [], 'nor in the stats');
  const story = await storyTotal(link);
  eq(story.total, state.stats.totals.messages, 'the story opened with the link shows the same total');
  ok(story.title.includes('Taco Tuesday Crew'), 'and the chat\'s name');

  // The preview plays the link itself: what you see is what you send.
  const frame = await previewFrame(page);
  ok(await frame.evaluate(() => window.WrappedStory.isActive()), 'the preview plays the real story');
  eq(payloadOf(state.preview), payloadOf(link), 'the preview frame is given exactly the payload of the link, nothing more');
  ok(new URL(state.preview).origin === origin, 'and is loaded from this site');
  const inFrame = decode(await frame.evaluate(() => location.href));
  ok(inFrame.most_reacted.every((m) => m.text === ''), 'so with the quotes switch off there is no message text inside the frame');
  eq(leaks(JSON.stringify(inFrame)), [], 'and no phone number or e-mail address');

  // Other periods, the owner's name, another time zone.
  await period(page, 'all');
  await matchesCli(page, [...base, '--tz', LA, '--all-time'], LA, 'all time: byte-identical');
  await period(page, 'year');
  await matchesCli(page, [...base, '--tz', LA, '--year', String(year)], LA, `this year (${year}): byte-identical`);
  await period(page, 'last');
  await matchesCli(page, [...base, '--tz', LA, '--year', String(year - 1)], LA, `last year (${year - 1}): byte-identical`);
  await period(page, 'all');
  await rename(page, 'me', 'Amara');
  await matchesCli(page, [...base, '--tz', LA, '--all-time', '--me', 'Amara'], LA, 'your own name: byte-identical to --me');
  await page.locator('#advanced summary').click();
  await page.selectOption('#tz', 'Asia/Tokyo');
  await matchesCli(page, [...base, '--tz', 'Asia/Tokyo', '--all-time', '--me', 'Amara'], LA, 'another time zone: byte-identical to --tz');
  ok((await page.locator('#tz option').count()) > 100, 'the time zone list is filled in');

  // Another chat without reloading the file: the stress chat needs the trim ladder.
  await page.click('#another');
  await page.waitForSelector('#step-chat.is-active');
  eq((await listed(page)).length, named.chats.length, 'choosing another chat brings the list back without reading the file again');
  await pick(page, STRESS);
  await period(page, 'all');
  state = await create(page);
  ok(state.link.steps === 0 && state.link.length < 3000, `largest chat, first names: the link is short (${state.link.length} characters) and nothing is trimmed`);
  await page.click('#first-names');                 // full names: fourteen enormous ones
  await matchesCli(page, [String(STRESS), '--db', CHAT_DB, '--contacts', BOOK_DIR, '--tz', 'Asia/Tokyo', '--all-time', '--me', 'Amara'], LA, 'largest chat, full names (the owner keeps the name typed for the first chat): byte-identical');
  state = await snap(page);
  ok(state.link.length <= 4800, `largest chat: the link fits (${state.link.length} characters, quotes off)`);
  ok(await page.locator('#quotes').isEnabled(), 'largest chat: quotes can still be switched on');
  await quotes(page, true);
  state = await snap(page);
  const withQuotes = Engine.fitLink(state.stats, { quotes: true });
  ok(state.link.length <= 4800 && state.link.url === withQuotes.url, `largest chat with quotes: still fits (${state.link.length} characters)`);
  ok(withQuotes.steps > 0 && state.link.steps === withQuotes.steps, `the trim ladder had to cut (${state.link.steps} steps)`);
  ok(await visible(page, '#trim') && /left out/.test(await text(page, '#trim')), `and the page says what was cut: "${(await text(page, '#trim')).slice(0, 90)}…"`);
  const shownQuotes = await page.$$eval('.mk-quote__text', (els) => els.map((e) => e.textContent));
  eq(shownQuotes, decode(state.link.url).most_reacted.map((m) => m.text), 'the quotes on the page are exactly the (shortened) ones in the link');

  // The unnamed chat: masked names, and a name built from the members.
  await page.click('#another');
  await page.waitForSelector('#step-chat.is-active');
  await pick(page, UNNAMED);
  await period(page, 'all');
  await create(page);
  await page.click('#first-names');
  await matchesCli(page, [String(UNNAMED), '--db', CHAT_DB, '--contacts', BOOK_DIR, '--tz', 'Asia/Tokyo', '--all-time', '--me', 'Amara'], LA, 'unnamed chat, full names: byte-identical');
  state = await snap(page);
  ok(state.stats.chat.name.includes('…') && (await page.getAttribute('#chat-name', 'placeholder')) === state.stats.chat.name, 'unnamed chat: its name is built from the members, masked');
  eq(leaks(JSON.stringify(decode(state.link.url))), [], 'unnamed chat: nothing raw in the link');

  s.clean('mac');
  await s.close();
});

// ── 2. chat.db without its -wal ────────────────────────────────────────────────────────
await section('nowal', 'Mac: chat.db alone warns, adding chat.db-wal fixes it', async () => {
  const s = await open();
  const { page } = s;
  await addMac(page, [CHAT_DB]);
  const note = page.locator('#source-notes [data-note="wal_missing"]');
  ok(await note.isVisible(), 'the warning is visible');
  const words = await note.innerText();
  ok(/recent messages may be missing/i.test(words) && /add chat\.db-wal too/i.test(words), `it says what to do: "${words.slice(0, 100)}…"`);
  const without = await listed(page);
  const full = cliChats(['--db', CHAT_DB, '--no-contacts']).chats.map(brief);
  const sum = (list) => list.reduce((n, c) => n + c.messages, 0);
  ok(sum(without) < sum(full), `without the -wal ${sum(full) - sum(without)} messages are missing from the group chats`);

  // Pick a chat, then add the missing file: the same chat is chosen again, now complete.
  await pick(page, TACO);
  await page.setInputFiles('#input-mac', [CHAT_WAL]);
  await page.waitForFunction(() => /chat\.db-wal/.test(document.getElementById('source-summary').textContent), null, { timeout: 60000 });
  await page.waitForSelector('#step-tune.is-active');
  ok(!(await note.isVisible()), 'the warning is gone once the -wal is added');
  eq((await snap(page)).chat.messages, full.find((c) => c.id === TACO).messages, 'and the chat is read again with every message');
  await period(page, 'all');
  await create(page);
  await matchesCli(page, [String(TACO), '--db', CHAT_DB, '--no-contacts', '--tz', LA, '--all-time'], LA, 'stats after adding the -wal are byte-identical to the CLI');

  // A damaged -wal is left out with a warning instead of being merged.
  const t = await open();
  fs.mkdirSync(path.join(TMP, 'damaged'), { recursive: true });
  fs.copyFileSync(CHAT_DB, path.join(TMP, 'damaged/chat.db'));
  fs.writeFileSync(path.join(TMP, 'damaged/chat.db-wal'), Buffer.alloc(8192, 0x5a));
  await addMac(t.page, [path.join(TMP, 'damaged/chat.db'), path.join(TMP, 'damaged/chat.db-wal')]);
  const damaged = t.page.locator('#source-notes [data-note="wal_invalid"]');
  ok(await damaged.isVisible() && /recent messages may be missing/i.test(await damaged.innerText()), 'a damaged -wal is left out, with a warning');
  eq(await listed(t.page), without, 'and the list is what chat.db alone gives');
  t.clean('damaged -wal');
  await t.close();

  s.clean('nowal');
  await s.close();
});

// ── while the files are read ───────────────────────────────────────────────────────────
await section('progress', 'While files are read: progress sits by the drop zone, the rest steps back', async () => {
  const s = await open({ viewport: VIEWPORTS['phone-390'] });
  const { page } = s;
  ok(await visible(page, '.mk-touch'), 'on a touch device the page says a Messages history needs a computer');
  // Hold SQLite's download back for a moment so the working state can be looked at.
  await s.context.route('**/make/vendor/sql-wasm.wasm', (route) => setTimeout(() => route.continue(), 1500));
  await page.setInputFiles('#input-mac', [CHAT_DB, CHAT_WAL]);
  await page.waitForSelector('#work-source:not([hidden])');
  await page.waitForFunction(() => /database reader/.test(document.getElementById('work-source').textContent));
  ok(await page.locator('#step-source.is-busy').count() === 1, 'step 1 is marked busy');
  eq(await page.evaluate(() => getComputedStyle(document.getElementById('panel-mac')).pointerEvents), 'none', 'the instructions cannot be clicked meanwhile');
  await page.waitForTimeout(600);
  const box = await page.locator('#work-source').boundingBox();
  ok(box && box.y >= 0 && box.y + box.height <= VIEWPORTS['phone-390'].height, 'the progress line is scrolled into view');
  ok(await page.locator('#work-source .mk-typing i').count() === 3, 'with the typing dots');
  await page.waitForSelector('#step-chat.is-active', { timeout: 60000 });
  ok(await page.locator('.mk-step.is-busy').count() === 0 && !(await visible(page, '#work-source')), 'and it goes away when the chats are listed');
  s.clean('progress');
  await s.close();

  const d = await open();
  ok(!(await visible(d.page, '.mk-touch')), 'with a mouse there is no such note');
  await d.close();
});

// ── the reader cannot talk to anyone ───────────────────────────────────────────────────
/**
 * Runs inside the reader's worker (Playwright puts it there through the debugger; the
 * product has no hook for it). Tries every way a worker has of reaching `target`, a second
 * server on this machine, looking for each function on the global object and on its
 * prototypes, and says what it found. What the worker saw is only a hint: the proof is the
 * second server's own log of what arrived.
 */
async function reach({ target, tag, modules }) {
  const chain = [];
  for (let o = self; o && o !== Object.prototype; o = Object.getPrototypeOf(o)) chain.push(o);
  const find = (name) => {
    for (const o of chain) {
      let value;
      try { value = Object.getOwnPropertyDescriptor(o, name) ? Reflect.get(o, name, self) : undefined; } catch { value = undefined; }
      if (typeof value === 'function') return value;
    }
    return null;
  };
  const names = ['fetch', 'XMLHttpRequest', 'importScripts', 'WebSocket', 'EventSource', 'Worker', 'FontFace'];
  const out = { url: self.location.href, found: names.filter((name) => find(name)), saw: {}, refused: [] };
  const note = (event) => out.refused.push(event.effectiveDirective || event.violatedDirective);
  self.addEventListener('securitypolicyviolation', note);
  const attempt = async (name, fn) => {
    try { out.saw[name] = await fn(find(name)); } catch (error) { out.saw[name] = 'failed: ' + ((error && error.name) || 'error'); }
  };
  const gone = () => { throw new ReferenceError('not there'); };
  await attempt('fetch', async (f) => {
    if (!f) gone();
    await f.call(self, target + tag + '-fetch', { mode: 'no-cors', cache: 'no-store' });
    return 'answered';
  });
  await attempt('XMLHttpRequest', (X) => new Promise((resolve, reject) => {
    if (!X) gone();
    const x = new X();
    x.open('GET', target + tag + '-xhr');
    x.onload = () => resolve('answered');
    x.onerror = () => reject(new Error('no answer'));
    x.send();
  }));
  await attempt('importScripts', (load) => {
    if (!load) gone();
    load.call(self, target + tag + '-script.js');
    return 'answered';
  });
  await attempt('WebSocket', (W) => new Promise((resolve, reject) => {
    if (!W) gone();
    const socket = new W(target.replace(/^http/, 'ws') + tag + '-socket');
    socket.onopen = () => resolve('answered');
    socket.onerror = () => reject(new Error('no answer'));
    setTimeout(() => reject(new Error('no answer')), 1500);
  }));
  await attempt('EventSource', (E) => new Promise((resolve, reject) => {
    if (!E) gone();
    const source = new E(target + tag + '-events');
    source.onopen = () => { source.close(); resolve('answered'); };
    source.onerror = () => { source.close(); reject(new Error('no answer')); };
    setTimeout(() => { source.close(); reject(new Error('no answer')); }, 1500);
  }));
  if (modules) {
    // No function to take away here: import() is part of the language, so only the policy stops it.
    await attempt('import()', async () => { await import(target + tag + '-module.js'); return 'answered'; });
  }
  await new Promise((resolve) => setTimeout(resolve, 300));
  self.removeEventListener('securitypolicyviolation', note);
  return out;
}

await section('contain', 'The reader cannot talk to anyone: bound by the page\'s policy, then stripped of the means', async () => {
  // A second origin on this machine. Anything that arrives here left the page's origin.
  const other = await startServer();
  const arrived = (tag) => other.hits.filter((hit) => hit.includes(tag));
  const WAYS = ['fetch', 'XMLHttpRequest', 'importScripts', 'WebSocket', 'EventSource'];

  /** Open the page, add the Mac files, and stop the reader just before it would cut itself off. */
  async function held(opts) {
    const s = await open({ ...opts, goto: false });
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    // SQLite's WebAssembly file is the reader's last legitimate download; it removes its
    // own network functions right after. Holding it back leaves time to look inside first.
    await s.context.route('**/make/vendor/sql-wasm.wasm', async (route) => { await gate; await route.continue(); });
    await s.page.goto(MAKE);
    await s.page.setInputFiles('#input-mac', [CHAT_DB, CHAT_WAL]);
    await s.page.waitForFunction(() => /database reader/.test(document.getElementById('work-source').textContent));
    return { ...s, release, worker: s.page.workers()[0] };
  }

  // 1. The page as it ships.
  const s = await held();
  eq(s.page.workers().length, 1, 'the page runs one worker');
  ok(s.worker.url().startsWith('blob:' + origin + '/'), `started from a blob: address, so the page's policy binds it (${s.worker.url().slice(0, 40)}…)`);
  const before = await s.worker.evaluate(reach, { target: other.url, tag: 'before', modules: true });
  eq(before.found.filter((name) => WAYS.includes(name)), WAYS, 'before it cuts itself off the worker still has its network functions');
  ok(Object.values(before.saw).every((saw) => saw.startsWith('failed')), `yet every attempt to reach another origin fails: ${JSON.stringify(before.saw)}`);
  eq(arrived('before'), [], 'and nothing arrives at the other origin (fetch, XMLHttpRequest, importScripts, WebSocket, EventSource, import())');
  s.release();
  await s.page.waitForSelector('#step-chat.is-active', { timeout: 60000 });
  eq((await listed(s.page)).length, cliChats(['--db', CHAT_DB, '--no-contacts']).chats.length, 'the reader itself still works: the chats are listed');
  const after = await s.worker.evaluate(reach, { target: other.url, tag: 'after', modules: true });
  eq(after.found, [], 'after that the functions are gone, from the global object and from every prototype behind it');
  ok(Object.values(after.saw).every((saw) => saw.startsWith('failed')), `every attempt fails: ${JSON.stringify(after.saw)}`);
  eq(arrived('after'), [], 'and nothing arrives at the other origin');
  const pinned = await s.worker.evaluate(() => {
    const tries = [];
    const real = () => 'put back';
    for (const name of ['fetch', 'XMLHttpRequest', 'importScripts', 'WebSocket']) {
      try { self[name] = real; } catch { /* strict code throws; either way it must not stick */ }
      try { Object.defineProperty(self, name, { value: real, configurable: true }); } catch { /* refused */ }
      if (typeof self[name] === 'function') tries.push(name);
    }
    return { tries, beacon: typeof (self.navigator && self.navigator.sendBeacon) };
  });
  eq(pinned.tries, [], 'they cannot be put back either');
  eq(pinned.beacon, 'undefined', 'and there is no navigator.sendBeacon');
  // (The browser's own request log is no use here: it lists a request the moment one is
  // asked for, including those the policy then refuses. The other origin's log is the proof.)
  const by = [...new Set(before.refused)].sort();
  ok(by.includes('connect-src') && by.some((d) => d.startsWith('script-src')), `the refusals come from the page's policy (${by.join(', ')})`);
  await s.close();

  // 2. Is the probe able to tell? The same worker with the page's policy switched off by
  // the test browser: now the attempts do arrive, until the worker cuts itself off.
  const c = await held({ bypassCSP: true });
  const open1 = await c.worker.evaluate(reach, { target: other.url, tag: 'control', modules: false });
  ok(['fetch', 'xhr', 'script'].every((way) => arrived('control-' + way).length > 0),
    `without the policy the same attempts do arrive, so the check above can tell: ${JSON.stringify(arrived('control'))} ${JSON.stringify(open1.saw)}`);
  c.release();
  await c.page.waitForSelector('#step-chat.is-active', { timeout: 60000 });
  const stripped = await c.worker.evaluate(reach, { target: other.url, tag: 'stripped', modules: false });
  eq(stripped.found, [], 'even without the policy, the worker has removed the functions by the time it holds a file');
  eq(arrived('stripped'), [], 'and nothing arrives');
  await c.close();
  await other.close();

  // 3. A browser that will not start a worker from a blob: the reader runs on the page
  // itself, under the same policy, rather than in a worker the policy does not reach.
  const refusals = {
    'the constructor throws': () => { window.Worker = function () { throw new Error('no workers from blobs here'); }; },
    'the worker dies before it is ready': () => {
      const make = URL.createObjectURL.bind(URL);
      URL.createObjectURL = () => make(new Blob(['throw new Error("refused")'], { type: 'text/javascript' }));
    },
  };
  for (const [label, init] of Object.entries(refusals)) {
    const f = await open({ init });
    await addMac(f.page, [CHAT_DB, CHAT_WAL]);
    eq((await snap(f.page)).runner, 'page', `${label}: the reader runs on the page`);
    eq(f.page.workers().length, 0, `${label}: and no worker is left running`);
    await pick(f.page, TACO);
    await period(f.page, 'all');
    await create(f.page);
    await matchesCli(f.page, ['--db', CHAT_DB, '--no-contacts', String(TACO), '--all-time'], LA, `${label}: the numbers are the command-line tool's, byte for byte`);
    eq(f.foreign, [], `${label}: no request left this origin`);
    if (label === 'the constructor throws') f.clean('main-thread reader');
    await f.close();
  }
});

// ── many chats: search ─────────────────────────────────────────────────────────────────
await section('search', 'Many group chats: the list can be searched', async () => {
  const many = path.join(EXTRA, 'many/chat.db');
  const expected = cliChats(['--db', many, '--no-contacts']).chats.map(brief);
  const s = await open({ viewport: VIEWPORTS['phone-390'] });
  const { page } = s;
  await addMac(page, [many]);
  eq(await listed(page), expected, 'twelve chats, busiest first, as the CLI lists them');
  ok(await visible(page, '#chat-search-wrap'), 'with this many chats there is a search box');
  await page.fill('#chat-search', 'pickle');
  eq((await listed(page)).map((c) => c.name), ['Pickleball Sundays'], 'typing part of a name filters the list');
  await page.fill('#chat-search', '0107003');
  eq((await listed(page)).length, 9, 'part of a member\'s number finds the chats that person is in');
  await page.fill('#chat-search', 'no such chat');
  ok((await listed(page)).length === 0 && await visible(page, '#chats-empty'), 'nothing found: the page says so');
  await page.fill('#chat-search', '');
  eq((await listed(page)).length, 12, 'clearing the search brings every chat back');
  await page.focus('.mk-chat[data-chat-id="1"]');
  await page.keyboard.press('Enter');
  await page.waitForSelector('#step-tune.is-active', { timeout: 30000 });
  ok((await text(page, '#chat-summary')).includes('Pickleball Sundays'), 'a chat can be chosen from the keyboard');
  eq(await overflow(page), [], 'no sideways overflow');
  s.clean('search');
  await s.close();
});

// ── 3. iPhone backups ──────────────────────────────────────────────────────────────────
await section('backup', 'iPhone backup: folder, two files, -wal, several backups, encrypted', async () => {
  const expected = cliChats(['--backup', BACKUP]);
  const hashed = (dir, id) => path.join(dir, id.slice(0, 2), id);
  const SMS = '3d0d7e5fb2ce288813306e4d4636395e047a3d28';
  const BOOK = '31bb7ba8914766d4ba40d6dfb6113c8b614be442';
  const WAL = 'cd47480f213dba9bc38ee792775d17e3f5a73a59';

  // Folder pick.
  let s = await open();
  let page = s.page;
  await page.click('#tab-backup');
  ok(await visible(page, '#panel-backup') && !(await visible(page, '#panel-mac')), 'the backup tab shows its own instructions');
  const how = await text(page, '#panel-backup');
  ok(how.includes('~/Library/Application Support/MobileSync/Backup') && how.includes('%USERPROFILE%\\Apple\\MobileSync\\Backup') && how.includes('%APPDATA%\\Apple Computer\\MobileSync\\Backup'),
    'it gives the folder for macOS and for Windows');
  await page.setInputFiles('#input-backup-folder', BACKUP);
  await page.waitForSelector('#step-chat.is-active', { timeout: 60000 });
  eq(await listed(page), expected.chats.map(brief), 'folder pick: chat list matches `wrapped chats --backup` (names from the backup\'s address book)');
  ok((await text(page, '#source-summary')).includes('iPhone backup'), 'the summary says it is an iPhone backup');
  await pick(page, TACO);
  await period(page, 'all');
  await create(page);
  await page.click('#first-names');                 // the CLI uses the address book's full names
  await matchesCli(page, [String(TACO), '--backup', BACKUP, '--tz', LA, '--all-time'], LA, 'folder pick: stats are byte-identical to `wrapped stats --backup`');
  eq((await snap(page)).stats.meta.source, 'sms.db', 'the source is recorded as sms.db');
  s.clean('backup folder');
  await s.close();

  // Just the two hashed files.
  s = await open();
  page = s.page;
  await page.click('#tab-backup');
  await page.setInputFiles('#input-backup-files', [hashed(BACKUP, SMS), hashed(BACKUP, BOOK)]);
  await page.waitForSelector('#step-chat.is-active', { timeout: 60000 });
  eq(await listed(page), expected.chats.map(brief), 'two-file pick: same chat list');
  s.clean('backup two files');
  await s.close();

  // The messages file alone, no names; and a backup whose sms.db still has a -wal.
  s = await open();
  page = s.page;
  await page.click('#tab-backup');
  const walBackup = fx(P.backup_wal);
  await page.setInputFiles('#input-backup-files', [hashed(walBackup, SMS)]);
  await page.waitForSelector('#step-chat.is-active', { timeout: 60000 });
  ok(await page.locator('#source-notes [data-note="wal_missing"]').isVisible(), 'a backup database with an unmerged -wal warns too');
  await page.setInputFiles('#input-backup-files', [hashed(walBackup, WAL)]);
  await page.waitForFunction(() => !document.querySelector('#source-notes [data-note="wal_missing"]'), null, { timeout: 60000 });
  await page.waitForSelector('#step-chat.is-active');
  eq(await listed(page), cliChats(['--backup', walBackup, '--no-contacts']).chats.map(brief), 'with its -wal added the list matches the CLI');
  s.clean('backup with -wal');
  await s.close();

  // The same database in a backup that has no -wal file at all. Picked as a whole folder,
  // the page can see there is no second file, so it does not ask for one; picked as a
  // single file it cannot know, and says what to look for.
  const bare = path.join(TMP, 'bare-backup', '00008030-000FAKE0FAKE0FAKE');
  fs.cpSync(walBackup, bare, { recursive: true });
  fs.rmSync(hashed(bare, WAL));
  s = await open();
  page = s.page;
  await page.click('#tab-backup');
  await page.setInputFiles('#input-backup-folder', bare);
  await page.waitForSelector('#step-chat.is-active', { timeout: 60000 });
  eq(await page.locator('#source-notes [data-note="wal_missing"]').count(), 0, 'a whole backup folder with no -wal file in it: no warning about a file that does not exist');
  ok(!/cd47480f/.test(await text(page, '#step-source')), 'and nothing asks for it');
  await page.click('#start-over');
  await page.click('#tab-backup');
  await dropFolder(page, '00008030-000FAKE0FAKE0FAKE', { '3d': { [SMS]: hashed(bare, SMS) }, 'Manifest.plist': path.join(bare, 'Manifest.plist') });
  await page.waitForSelector('#step-chat.is-active', { timeout: 60000 });
  eq(await page.locator('#source-notes [data-note="wal_missing"]').count(), 0, 'the same folder dropped on the page: no warning either');
  await page.click('#start-over');
  await page.click('#tab-backup');
  await page.setInputFiles('#input-backup-files', [hashed(bare, SMS)]);
  await page.waitForSelector('#step-chat.is-active', { timeout: 60000 });
  const maybe = await text(page, '#source-notes [data-note="wal_missing"]');
  ok(/cd47480f/.test(maybe) && /If it does not, nothing is missing/.test(maybe), `the messages file picked on its own: the page says what to look for, and that it may not exist ("${maybe.slice(0, 80)}…")`);
  s.clean('backup without a -wal');
  await s.close();

  // A folder that holds two backups: the newer one is used, and the page says so.
  const multi = path.join(TMP, 'multi');
  fs.cpSync(BACKUP, path.join(multi, 'AAAA-OLDER'), { recursive: true });
  fs.cpSync(BACKUP, path.join(multi, 'BBBB-NEWER'), { recursive: true });
  fs.utimesSync(hashed(path.join(multi, 'AAAA-OLDER'), SMS), new Date('2026-05-01T00:00:00Z'), new Date('2026-05-01T00:00:00Z'));
  fs.utimesSync(hashed(path.join(multi, 'BBBB-NEWER'), SMS), new Date('2026-10-01T00:00:00Z'), new Date('2026-10-01T00:00:00Z'));
  s = await open();
  page = s.page;
  await page.click('#tab-backup');
  await page.setInputFiles('#input-backup-folder', multi);
  await page.waitForSelector('#step-chat.is-active', { timeout: 60000 });
  ok(await page.locator('#source-notes [data-note="backups"]').isVisible(), 'several backups in one folder: the newest is used and the page says so');
  eq(await listed(page), expected.chats.map(brief), 'and the chat list is right');
  s.clean('several backups');
  await s.close();

  // Dropped folders (stand-in entries, see dropFolder): one backup, the folder above it, ~/Library/Messages.
  const tree = (dir) => ({ '3d': { [SMS]: hashed(dir, SMS) }, '31': { [BOOK]: hashed(dir, BOOK) }, 'Manifest.plist': path.join(dir, 'Manifest.plist') });
  for (const [label, name, nodes] of [
    ['a backup folder', '00008030-000FAKE0FAKE0FAKE', tree(BACKUP)],
    ['the folder that holds the backups', 'Backup', { '00008030-000FAKE0FAKE0FAKE': tree(BACKUP) }],
  ]) {
    s = await open();
    await s.page.click('#tab-backup');
    await dropFolder(s.page, name, nodes);
    await s.page.waitForSelector('#step-chat.is-active', { timeout: 60000 });
    eq(await listed(s.page), expected.chats.map(brief), `dropping ${label}: chat list matches the CLI`);
    s.clean(`dropped ${label}`);
    await s.close();
  }
  s = await open();
  await dropFolder(s.page, 'Messages', { 'chat.db': CHAT_DB, 'chat.db-wal': CHAT_WAL, 'chat.db-shm': fx('mac/chat.db-shm') });
  await s.page.waitForSelector('#step-chat.is-active', { timeout: 60000 });
  eq(await listed(s.page), cliChats(['--db', CHAT_DB, '--no-contacts']).chats.map(brief), 'dropping the ~/Library/Messages folder itself works too');
  ok(!(await s.page.locator('#source-notes [data-note="wal_missing"]').isVisible()), 'and its -wal is picked up');
  // ... and then the AddressBook folder, whose address books sit in Sources/<id>/.
  await dropFolder(s.page, 'AddressBook', {
    'AddressBook-v22.abcddb': BOOKS[0],
    Metadata: {},
    Sources: { '0A1B2C3D-FAKE-FAKE-FAKE-000000000001': { 'AddressBook-v22.abcddb': BOOKS[1] } },
  });
  await s.page.waitForFunction(() => /contact/.test(document.getElementById('source-summary').textContent), null, { timeout: 60000 });
  await s.page.waitForSelector('#step-chat.is-active');
  eq(await listed(s.page), cliChats(['--db', CHAT_DB, '--contacts', BOOK_DIR]).chats.map(brief), 'dropping the AddressBook folder afterwards adds the names');
  s.clean('dropped Messages folder');
  await s.close();

  // Encrypted.
  s = await open();
  page = s.page;
  await page.click('#tab-backup');
  await page.setInputFiles('#input-backup-folder', fx(P.backup_encrypted));
  await page.waitForSelector('#error-source:not([hidden])', { timeout: 60000 });
  const message = await text(page, '#error-source');
  ok(/this iphone backup is encrypted/i.test(message), 'encrypted backup: the page says so in the title');
  ok(/untick .Encrypt local backup. and back up again/i.test(message) && /use .A Mac. instead/i.test(message), 'and gives the two ways forward');
  ok(!/\bat \S+ \(|Error:|undefined|\[object/.test(message), 'no stack trace or raw error text');
  ok(await visible(page, '#step-source.is-active'), 'the page stays on step 1');
  await page.click('#error-source button');
  ok(await visible(page, '#panel-mac') && !(await visible(page, '#error-source')), '"Use a Mac instead" switches to the Mac instructions');
  s.clean('encrypted backup');
  await s.close();
});

// ── 4. pasted exports ──────────────────────────────────────────────────────────────────
const PEOPLE = ['Maya', 'Dev', 'Priya', 'Jonah', ''];
const MESSAGES = Array.from({ length: 48 }, (_, i) => {
  const day = 1 + ((i * 5) % 27);
  const hour = (7 + i * 7) % 24;
  const stamp = `2026-${String(3 + (i % 4)).padStart(2, '0')}-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:${String((i * 13) % 60).padStart(2, '0')}:07`;
  return { date: stamp + '-07:00', local: stamp.replace('T', ' '), sender: PEOPLE[(i * 3 + (i % 5)) % PEOPLE.length], text: `invented line number ${i}, with a comma${i % 6 === 0 ? ' and a "quote"\nand a second line' : ''}` };
});
const csvCell = (value) => (/[",\n]/.test(value) ? '"' + value.replace(/"/g, '""') + '"' : value);
const EXPORTS = {
  columnar: '#dates\n' + MESSAGES.map((m) => m.date).join('\n') + '\n#senders\n' + MESSAGES.map((m) => m.sender).join('\n') + '\n',
  jsonl: MESSAGES.map((m) => JSON.stringify({ date: m.date, sender: m.sender, text: m.text })).join('\n'),
  json: JSON.stringify(MESSAGES.map((m) => ({ timestamp: m.date, from: m.sender, message: m.text })), null, 1),
  csv: 'Date,Sender,Text\n' + MESSAGES.map((m) => [m.local, m.sender, m.text].map(csvCell).join(',')).join('\n') + '\n',
};

/** What the engine makes of an export, computed here in Node. */
function exportStats(source, tz) {
  const rows = Import.parseExport(source, { tz }).rows;
  const counts = new Map();
  rows.forEach((r) => { if (!r.is_from_me && r.handle) counts.set(r.handle, (counts.get(r.handle) || 0) + 1); });
  const participants = [...counts.keys()].sort((a, b) => (counts.get(b) - counts.get(a)) || (a < b ? -1 : a > b ? 1 : 0));
  return JSON.stringify(Engine.computeStats(rows, { tz, all_time: true, source: 'export', chat_name: '', participants }));
}

await section('paste', 'Paste / export file: every accepted format, #paste, the clipboard', async () => {
  for (const [format, source] of Object.entries(EXPORTS)) {
    const s = await open();
    const { page } = s;
    await page.click('#tab-paste');
    ok(await page.locator('#paste-go').isDisabled(), `${format}: "Read these messages" waits for text`);
    await page.fill('#paste-text', source);
    await page.click('#paste-go');
    await page.waitForSelector('#step-tune.is-active', { timeout: 30000 });
    ok(await visible(page, '#step-chat.is-done') && !(await visible(page, '#chats')), `${format}: the "choose the chat" step is skipped (one chat)`);
    const summary = await text(page, '#source-summary');
    ok(summary.includes('48 messages from 5 people') && /Mar \d+, 2026 to Jun \d+, 2026/.test(summary), `${format}: diagnostics line shows count, people and dates ("${summary.replace(/\n/g, ' / ')}")`);
    ok(!(await visible(page, '#change-chat')), `${format}: no "choose another chat" for an export`);
    eq((await snap(page)).people.map((p) => p.name).sort(), ['Dev', 'Jonah', 'Maya', 'Me', 'Priya'], `${format}: the people are listed for renaming`);
    await period(page, 'all');
    const state = await create(page);
    for (let attempt = 0; attempt < 2; attempt++) {
      const expected = exportStats(source, LA);
      const got = (await settled(page)).statsJson;
      if (got !== expected && attempt === 0) { await page.locator('#chat-name').dispatchEvent('input'); continue; }
      ok(got === expected, `${format}: the page's stats are exactly the engine's for this text` + (got === expected ? '' : ': ' + firstDifference(got, expected)));
      break;
    }
    eq(state.stats.totals.messages, 48, `${format}: all 48 messages counted`);
    eq(state.stats.totals.words > 0, format !== 'columnar', `${format}: ${format === 'columnar' ? 'no text, so no words' : 'words are counted'}`);
    ok(!(await visible(page, '#quotes-box')), `${format}: no quotes switch, an export has no tapbacks`);
    ok(/No message text/.test(await text(page, '#inside-list')), `${format}: the page says the link holds no message text`);
    ok(state.link.length <= 4800 && decode(state.link.url).totals.messages === 48, `${format}: the link decodes`);
    s.clean(`paste ${format}`);
    await s.close();
  }

  // #paste: straight to this mode, focus on Paste, and the button reads the clipboard.
  let s = await open({ hash: '#paste', permissions: ['clipboard-read', 'clipboard-write'] });
  let page = s.page;
  ok(await visible(page, '#panel-paste') && (await page.getAttribute('#tab-paste', 'aria-selected')) === 'true', '#paste opens the paste mode');
  eq(await page.evaluate(() => document.activeElement && document.activeElement.id), 'paste-btn', 'with focus on the Paste button');
  await page.evaluate((value) => navigator.clipboard.writeText(value), EXPORTS.columnar);
  await page.click('#paste-btn');
  await page.waitForSelector('#step-tune.is-active', { timeout: 30000 });
  ok((await text(page, '#source-summary')).includes('48 messages from 5 people'), 'Paste reads the clipboard and goes straight on');
  eq(await page.inputValue('#paste-text'), EXPORTS.columnar, 'what was pasted is left in the box');
  s.clean('#paste');
  await s.close();

  // Clipboard not allowed: a sentence and the focus in the box, not an error.
  s = await open({ hash: '#paste', init: () => { navigator.clipboard.readText = () => Promise.reject(new DOMException('denied', 'NotAllowedError')); } });
  page = s.page;
  await page.click('#paste-btn');
  await page.waitForSelector('#paste-note:not([hidden])');
  ok(/did not let this page read the clipboard/i.test(await text(page, '#paste-note')), 'clipboard blocked: the page explains and points at the box');
  eq(await page.evaluate(() => document.activeElement.id), 'paste-text', 'and puts the cursor in the box');
  await page.keyboard.insertText(EXPORTS.jsonl);
  ok(await page.locator('#paste-go').isEnabled(), 'typing or pasting by hand enables the button');
  s.clean('clipboard blocked');
  await s.close();

  // An export file, picked or dropped; and text that is not an export.
  s = await open();
  page = s.page;
  await page.click('#tab-paste');
  await page.setInputFiles('#input-export', { name: 'my export.csv', mimeType: 'text/csv', buffer: Buffer.from(EXPORTS.csv) });
  await page.waitForSelector('#step-tune.is-active', { timeout: 30000 });
  ok(/my export\.csv \(CSV\)/.test(await text(page, '#source-summary')), 'an export file is read and named in the summary');
  await page.click('#start-over');
  ok(await visible(page, '#step-source.is-active') && await visible(page, '#panel-paste'), 'start over returns to step 1');
  const exportFile = path.join(TMP, 'chat export.jsonl');
  fs.writeFileSync(exportFile, EXPORTS.jsonl);
  await page.click('#tab-mac');
  await dropFiles(page, [exportFile]);
  await page.waitForSelector('#step-tune.is-active', { timeout: 30000 });
  ok(/one message per line/.test(await text(page, '#source-summary')), 'a dropped export file is recognised even on the Mac tab');
  await page.click('#start-over');
  await page.fill('#paste-text', 'hello there\nthis is just a note to myself');
  await page.click('#paste-go');
  await page.waitForSelector('#error-source:not([hidden])');
  const error = await text(page, '#error-source');
  ok(/No messages could be read from that/.test(error) && /needs a date and a sender/.test(error), 'text that is not an export: a plain explanation');
  ok(await page.locator('#panel-paste details').evaluate((d) => d.open), 'and the list of accepted shapes opens');
  s.clean('export file');
  await s.close();

  // Two lists of different lengths: whatever the importer says about it, the page shows
  // it word for word, whether the importer goes on with what it could read or refuses.
  const uneven = '#dates\n2026-03-01T10:00:00-07:00\n2026-03-01T10:05:00-07:00\n2026-03-01T10:09:00-07:00\n2026-03-01T10:12:00-07:00\n#senders\nMaya\nDev\n';
  const verdict = Import.parseExport(uneven, { tz: LA });
  ok(verdict.warnings.length > 0, `the importer objects to uneven lists ("${verdict.warnings[0].slice(0, 70)}…")`);
  s = await open();
  page = s.page;
  await page.click('#tab-paste');
  await page.fill('#paste-text', uneven);
  await page.click('#paste-go');
  await page.waitForFunction(() => !document.getElementById('error-source').hidden || document.getElementById('step-tune').classList.contains('is-active'), null, { timeout: 30000 });
  const where = verdict.rows.length ? '#source-notes' : '#error-source';
  ok(await visible(page, where) && (await text(page, where)).includes(verdict.warnings[0]), `uneven lists: the importer's message is shown as it is (${verdict.rows.length ? 'as a warning' : 'as an error'})`);
  s.clean('uneven lists');
  await s.close();
});

// ── 5. sample data ─────────────────────────────────────────────────────────────────────
await section('sample', 'Sample data end to end: quotes opt-in, copy, share, open, start over', async () => {
  const s = await open({
    permissions: ['clipboard-read', 'clipboard-write'],
    init: () => { navigator.share = (data) => { window.__shared = data; return Promise.resolve(); }; },
  });
  const { page } = s;
  await page.click('#try-sample');
  await page.waitForSelector('#step-tune.is-active', { timeout: 30000 });
  ok(await visible(page, '#step-source.is-done') && await visible(page, '#step-chat.is-done'), 'steps 1 and 2 fold away');
  ok(/invented/i.test(await text(page, '#source-summary')), 'the summary says the data is invented');
  eq((await snap(page)).people.length, 7, 'seven people, the owner included');
  let state = await create(page);
  ok(await visible(page, '#recap'), 'the recap appears');
  ok(state.stats.totals.messages > 500 && state.stats.chat.members === 7 && state.stats.meta.source === 'sample', `a full recap (${state.stats.totals.messages} messages)`);
  eq(await text(page, '#recap-title'), state.stats.chat.name, 'titled with the chat\'s name');
  ok((await text(page, '#recap-facts')).includes(state.stats.totals.messages.toLocaleString('en-US') + ' messages'), 'with the headline numbers');
  const frame = await previewFrame(page);
  ok(await frame.evaluate(() => window.WrappedStory.isActive() && window.WrappedStory.total >= 10), 'the preview plays the story');
  ok(state.stats.most_reacted.length === 3 && state.stats.most_reacted.every((m) => m.text), 'the stats on this device have three quotable messages');

  // Quotes: off by default.
  ok(!(await page.locator('#quotes').isChecked()), 'the quotes switch starts off');
  let decoded = decode(state.link.url);
  ok(decoded.most_reacted.length === 3 && decoded.most_reacted.every((m) => m.text === ''), 'default link: every most_reacted text is blank');
  ok(state.link.length <= 4800 && state.link.steps === 0, `default link: ${state.link.length} characters, nothing trimmed`);
  ok(/No message text/.test(await text(page, '#inside-list')), 'the page says: no message text');
  const offered = await page.$$eval('.mk-quote__text', (els) => els.map((e) => e.textContent));
  eq(offered, state.stats.most_reacted.map((m) => m.text), 'the three messages are shown word for word before anything is switched on');
  ok(!(await visible(page, '#trim')), 'no "left out" note when nothing was trimmed');

  // The preview frame holds the link and nothing else, so the story's OWN "Copy link"
  // (on its last slide) cannot give away message text while the switch is off.
  eq(payloadOf(state.preview), payloadOf(state.link.url), 'switch off: the preview frame is given exactly the link\'s payload');
  eq(payloadOf(await frame.evaluate(() => location.href)), payloadOf(state.link.url), 'and that is what is loaded in it');
  const texts = state.stats.most_reacted.map((m) => m.text);
  const frameText = await frame.evaluate(() => document.body.textContent);
  ok(texts.every((quote) => !frameText.includes(quote)), 'switch off: none of the message text is anywhere in the preview');
  let copied = await copyFromStory(page);
  eq(copied, state.link.url, 'switch off: the story\'s own Copy link gives the very same link');
  ok(decode(copied).most_reacted.length === 3 && decode(copied).most_reacted.every((m) => m.text === ''), 'switch off: the link copied from inside the story has blank most_reacted text');

  // Switch them on.
  await quotes(page, true);
  const on = await snap(page);
  ok(on.quotes && on.link.url !== state.link.url, 'switching on changes the link');
  eq(payloadOf(on.preview), payloadOf(on.link.url), 'switch on: the preview is rebuilt from the new link');
  await page.waitForFunction((payload) => document.getElementById('preview').contentWindow.location.hash === '#w1=' + payload, payloadOf(on.link.url));
  copied = await copyFromStory(page);
  eq(copied, on.link.url, 'switch on: the story\'s own Copy link gives the link with the text');
  eq(decode(copied).most_reacted.map((m) => m.text), texts, 'switch on: and it carries the three messages');
  decoded = decode(on.link.url);
  eq(decoded.most_reacted.map((m) => m.text), state.stats.most_reacted.map((m) => m.text), 'now the link carries the three texts');
  eq(decoded, state.stats, 'and is otherwise the full stats');
  ok(on.link.length <= 4800, `with quotes: ${on.link.length} characters`);
  ok(/The text of 3 messages/.test(await text(page, '#inside-list')), 'the summary now says: the text of 3 messages');
  await page.locator('#raw summary').click();
  eq(JSON.parse(await page.locator('#raw-json').textContent()), decoded, '"See the exact data" shows exactly what the link holds');
  eq(await page.inputValue('#link'), on.link.url, 'the link field follows the switch');

  // Copy, share, open.
  await page.click('#copy');
  await page.waitForFunction(() => /Copied/.test(document.getElementById('copy-label').textContent));
  eq(await page.evaluate(() => navigator.clipboard.readText()), on.link.url, 'Copy link puts the link on the clipboard');
  ok(/Copied\. Paste it into the chat on its own line/.test(await text(page, '#link-meta')) && await page.locator('#copy.is-done').count() === 1, 'and says so');
  ok(await page.locator('#rail li.is-done').count() === 4, 'all four steps are done');
  ok(await visible(page, '#share'), 'Share… is offered when the browser can share');
  await page.click('#share');
  eq(await page.evaluate(() => window.__shared), { url: on.link.url }, 'Share… hands over the link alone');
  eq(await page.getAttribute('#open', 'href'), '../' + on.link.url.slice(on.link.url.indexOf('#')),
    'Open story carries the same recap');
  eq(await page.getAttribute('#open', 'target'), '_blank', 'in a new tab');
  ok(/Paste the link on its own line in the group chat\. Everyone can open it, no app needed\./.test(await text(page, '.mk-guide')), 'the one line of guidance is there');
  const story = await storyTotal(on.link.url);
  eq(story.total, state.stats.totals.messages, 'the story opened with the link shows the right total');

  // Off again; a new chat name updates everything; start over.
  await quotes(page, false);
  eq((await snap(page)).link.url, state.link.url, 'switching off restores the link without text');
  await page.fill('#chat-name', 'Cabin People');
  const renamed = await settled(page);
  eq(renamed.stats.chat.name, 'Cabin People', 'a new chat name is counted in');
  eq(await text(page, '#recap-title'), 'Cabin People', 'and shown');
  eq(decode(renamed.preview).chat.name, 'Cabin People', 'the preview follows');
  await page.waitForFunction(() => document.getElementById('preview').contentWindow.document.title.includes('Cabin People'), null, { timeout: 15000 });
  ok(true, 'the story in the frame restarts with the new name');

  // The story's last slide links to this page. Followed inside the frame, it must not
  // start a second maker in there: the frame goes back to the story.
  const workersBefore = s.requests.filter((u) => u.endsWith('/make/worker.js')).length;
  await page.evaluate(() => {
    const preview = document.getElementById('preview');
    window.__frameLoads = [];
    preview.addEventListener('load', () => window.__frameLoads.push(preview.contentWindow.location.pathname));
    preview.contentWindow.location.href = new URL('./', location.href).href;
  });
  await page.waitForFunction(() => {
    const inner = document.getElementById('preview').contentWindow;
    return window.__frameLoads.length >= 2 && /index\.html$/.test(inner.location.pathname) && inner.WrappedStory && inner.WrappedStory.isActive();
  }, null, { timeout: 20000 });
  ok(/\/make\/$/.test((await page.evaluate(() => window.__frameLoads))[0]), 'the maker did open inside the preview frame');
  ok(true, 'and was replaced by the story again');
  eq(s.requests.filter((u) => u.endsWith('/make/worker.js')).length, workersBefore, 'it never started working in there');
  // Today's last slide links to the landing page's "get it" section (./#get) instead: the
  // frame goes back to the story from there too.
  await page.evaluate(() => {
    window.__frameLoads = [];
    document.getElementById('preview').contentWindow.location.href = new URL('../#get', location.href).href;
  });
  await page.waitForFunction(() => {
    const inner = document.getElementById('preview').contentWindow;
    return window.__frameLoads.length >= 2 && /index\.html$/.test(inner.location.pathname) && inner.WrappedStory && inner.WrappedStory.isActive();
  }, null, { timeout: 20000 });
  ok(/\/$/.test((await page.evaluate(() => window.__frameLoads))[0]), 'the landing page did open inside the preview frame');
  ok(true, 'and was replaced by the story again');
  await (await previewFrame(page)).evaluate(() => window.WrappedStory.goTo(3));
  await page.locator('#replay').click();
  ok(await (await previewFrame(page)).evaluate(() => window.WrappedStory.index === 0), '"Play again" restarts the story from the cover');
  // "Play again" pressed while the frame is on its way somewhere else must not leave it empty.
  await page.evaluate(() => { document.getElementById('preview').contentWindow.location.href = new URL('./', location.href).href; });
  await page.locator('#replay').click();
  await page.waitForFunction(() => {
    const inner = document.getElementById('preview').contentWindow;
    return /index\.html$/.test(inner.location.pathname) && inner.WrappedStory && inner.WrappedStory.isActive();
  }, null, { timeout: 20000 });
  await page.waitForTimeout(1500);
  ok(await page.evaluate(() => { const inner = document.getElementById('preview').contentWindow; return /index\.html$/.test(inner.location.pathname) && inner.WrappedStory.isActive(); }),
    'even when pressed mid-way, the frame ends up playing the story');
  await page.click('#restart');
  ok(await visible(page, '#step-source.is-active') && await page.locator('.mk-step.is-locked').count() === 3, 'start over: back to step 1, later steps locked');
  eq((await snap(page)).stats, null, 'and nothing is kept');
  await page.click('#try-sample');
  await page.waitForSelector('#step-tune.is-active', { timeout: 30000 });
  ok(true, 'the flow can be run again without reloading the page');

  // Without navigator.share the button is not shown; without a clipboard the link is selected.
  const t = await open({ init: () => { delete Navigator.prototype.share; navigator.clipboard.writeText = () => Promise.reject(new Error('no')); document.execCommand = () => false; } });
  await t.page.click('#try-sample');
  await t.page.waitForSelector('#step-tune.is-active', { timeout: 30000 });
  const plain = await create(t.page);
  ok(!(await visible(t.page, '#share')), 'no Share… button when the browser cannot share');
  await t.page.click('#copy');
  await t.page.waitForFunction(() => /did not work/.test(document.getElementById('link-meta').textContent));
  eq(await t.page.evaluate(() => { const f = document.getElementById('link'); return document.activeElement === f && f.selectionEnd - f.selectionStart; }), plain.link.length, 'copy blocked: the link is selected so it can be copied by hand');
  t.clean('copy blocked');
  await t.close();

  s.clean('sample');
  await s.close();
});

// ── 6. renaming and merging people ─────────────────────────────────────────────────────
await section('rename', 'Tune: renaming and merging people keeps the numbers right', async () => {
  const s = await open();
  const { page } = s;
  await addMac(page, [CHAT_DB, CHAT_WAL]);
  await pick(page, TACO);
  let state = await snap(page);
  const unnamed = state.people.filter((p) => !p.named);
  eq(unnamed.length, 7, 'without an address book, seven people have no name');
  ok(unnamed.every((p) => p.handles.length === 1 && (p.name.startsWith('…') || !p.name.includes('@'))), 'they are listed under masked names');
  eq(await text(page, '#unnamed-hint'), '7 people have no name yet. Name them, or add your contacts file to fill them in.', 'a note above the list says so, and what can be done');
  ok(/never go into the recap/.test(await text(page, '#unnamed-privacy')), 'and says the full numbers stay here');
  eq(await page.getAttribute('.mk-person[data-person="h:p:5550100001"] input', 'placeholder'), 'Who is …0001?', 'each row asks who the person is');
  ok((await text(page, '.mk-person[data-person="h:p:5550100001"]')).includes('+15550100001'), 'with the full number as a hint, on this device only');

  await period(page, 'custom');
  await page.fill('#period-start', '2026-01-01');
  await page.fill('#period-end', '2026-11-10');
  const before = (await create(page)).stats;
  const base = [String(TACO), '--db', CHAT_DB, '--tz', LA, '--start', '2026-01-01', '--end', '2026-11-10'];
  await matchesCli(page, [...base, '--no-contacts'], LA, 'no renames: byte-identical to the CLI without contacts');
  eq(leaks(JSON.stringify(before)), [], 'the masked stats hold no raw number or address');

  // Type the names an address book would have given: the result is the CLI's with contacts.
  const names = {
    'h:p:5550100001': 'Ines Calloway', 'h:e:ines.calloway@example.com': 'Ines Calloway', 'h:p:5550100002': 'Bram Okoye',
    'h:p:5550100003': 'Sam Rivera', 'h:p:5550100004': 'Sam Chen', 'h:p:5550100005': 'Zoë Müller',
  };
  for (const [key, name] of Object.entries(names)) await rename(page, key, name);
  await matchesCli(page, [...base, '--contacts', BOOK_DIR], LA, 'typing the names by hand gives exactly the CLI\'s result with an address book');
  const after = (await snap(page)).stats;
  eq(after.totals, before.totals, 'totals do not move when people are renamed or merged');
  eq(after.by_hour, before.by_hour, 'nor does the clock');
  const count = (stats, name) => (stats.senders.find((x) => x.name === name) || { messages: 0 }).messages;
  eq(count(after, 'Ines Calloway'), count(before, '…0001') + count(before, 'ines.calloway'), 'two entries given the same name are one sender with the sum of both');
  eq(after.senders.length, before.senders.length - 1, 'one sender fewer');
  eq(after.chat.members, before.chat.members - 1, 'one member fewer');
  eq(after.senders.reduce((n, x) => n + x.messages, 0), after.totals.messages, 'the senders still add up to the total');
  eq(await page.locator('.mk-tag--merge').count(), 2, 'both rows are marked "Counted together"');
  ok(!(await visible(page, '.mk-person[data-person="h:p:5550100001"] .mk-tag--new')), 'and no longer "No name yet"');
  eq(leaks(JSON.stringify(decode((await snap(page)).link.url))), [], 'nothing raw in the link after renaming');

  // First names only.
  ok(await visible(page, '#first-names'), '"Use first names only" is offered once names have spaces');
  await page.click('#first-names');
  const short = (await settled(page)).stats;
  eq(short.senders.map((x) => x.name).sort(), ['Bram', 'Ines', 'Me', 'Sam C.', 'Sam R.', 'Zoë', '…0006'].sort(), 'first names, with an initial where two people share one');
  eq(short.totals, before.totals, 'totals unchanged');

  // Merge someone into the owner; then undo by clearing the field.
  await rename(page, 'h:p:5550100002', 'Me');
  const mine = (await settled(page)).stats;
  eq(count(mine, 'Me'), count(short, 'Me') + count(short, 'Bram'), 'a person given the owner\'s name is counted with the owner');
  const { reactions: mineReactions, ...mineRest } = mine.totals;
  const { reactions: beforeReactions, ...beforeRest } = before.totals;
  eq(mineRest, beforeRest, 'messages, words, attachments, active days and streak are unchanged');
  // The engine keeps one tapback per person per message, so two people who both reacted to
  // the same message count once after they are merged.
  ok(mineReactions <= beforeReactions && mineReactions > beforeReactions * 0.9, `tapbacks: one per person per message (${beforeReactions} → ${mineReactions})`);
  eq(mine.senders.reduce((n, x) => n + x.messages, 0), mine.totals.messages, 'the senders still add up to the total');
  await rename(page, 'h:p:5550100002', '');
  const undone = (await settled(page)).stats;
  eq(count(undone, '…0002'), count(before, '…0002'), 'clearing a name puts the default back');
  eq(await page.getAttribute('.mk-person[data-person="h:p:5550100002"] input', 'placeholder'), 'Who is …0002?', 'and asks again');

  // A number typed as a name is still masked.
  await rename(page, 'h:p:5550100006', '+1 (555) 010-0006');
  const typed = await settled(page);
  ok(typed.stats.senders.some((x) => x.name === '…0006') && leaks(typed.statsJson).length === 0, 'a phone number typed as a name is masked like any other');

  s.clean('rename');
  await s.close();
});

/** `wrapped stats` as it comes: first names, the way the page starts out. */
const cliShort = (args, tz) => cli(['stats', ...args, '--compact'], tz).replace(/\n$/, '');
async function matchesShort(page, args, message) {
  const expected = cliShort(args, LA);
  const got = (await settled(page)).statsJson;
  return ok(got === expected, got === expected ? message : `${message}: ${got ? firstDifference(got, expected) : 'the page has no stats'}`);
}

// ── your own name ──────────────────────────────────────────────────────────────────────
await section('name', 'Your name: asked first, needed for a recap, "Me" only by choice', async () => {
  const s = await open();
  const { page } = s;
  await addMac(page, [CHAT_DB, CHAT_WAL, ...BOOKS]);
  await pick(page, TACO);
  const base = [String(TACO), '--db', CHAT_DB, '--contacts', BOOK_DIR, '--tz', LA, '--all-time'];
  const first = await page.evaluate(() => {
    const field = [...document.querySelectorAll('#tune-body input, #tune-body select, #tune-body button, #tune-body textarea')]
      .filter((el) => el.offsetParent !== null)[0];
    return { id: field.id, label: document.querySelector('label[for="' + field.id + '"]').textContent, placeholder: field.placeholder, value: field.value };
  });
  eq(first, { id: 'me-name', label: 'Your name in the recap', placeholder: 'First name', value: '' },
    'the first thing step 3 asks for is your name, and it starts empty');
  eq(await page.getAttribute('#me-name', 'autocomplete'), 'given-name', 'the browser may offer the name it knows');
  const mine = (await snap(page)).people.find((p) => p.me).messages;
  ok((await text(page, '#me-hint')).includes(mine.toLocaleString('en-US') + ' messages'), 'it says how many messages will carry that name');
  ok(!(await visible(page, '#me-error')), 'nothing is flagged before anything was tried');
  eq(await page.locator('.mk-person[data-person="me"]').count(), 0, 'the owner is not asked for again in the list of people');

  // Create without a name: nothing is made, the field says why and takes the focus.
  await period(page, 'all');
  await page.click('#create');
  await page.waitForSelector('#me-error:not([hidden])');
  let state = await snap(page);
  ok(!state.created && state.stats === null && !(await visible(page, '#recap')) && await visible(page, '#step-recap.is-locked'), 'Create without a name makes no recap');
  ok(/Type your first name/.test(await text(page, '#me-error')), 'the field says what is missing');
  eq(await page.evaluate(() => document.activeElement.id), 'me-name', 'and it has the focus');
  eq(await page.getAttribute('#me-name', 'aria-invalid'), 'true', 'it is marked as invalid');
  ok((await page.getAttribute('#me-name', 'aria-describedby')).split(' ').includes('me-error'), 'with the message tied to it');
  ok(/first name/i.test(await text(page, '#status')), 'and the live region says so');
  await page.waitForTimeout(500);
  const box = await page.locator('#me-field').boundingBox();
  const tall = page.viewportSize().height;
  ok(box.y >= 0 && box.y + box.height <= tall, 'the field is scrolled into view');

  // Type it: the complaint goes, the recap is made with that name.
  await page.keyboard.type('Amara');
  ok(!(await visible(page, '#me-error')) && (await page.getAttribute('#me-name', 'aria-invalid')) === null, 'typing a name clears the message');
  state = await create(page);
  ok(state.created && state.options.me === 'Amara', 'now Create makes the recap');
  ok(state.stats.senders.some((x) => x.name === 'Amara') && !state.stats.senders.some((x) => x.name === 'Me'), 'with the owner under their own name, not "Me"');
  await matchesShort(page, [...base, '--me', 'Amara'], 'the recap is byte-identical to `wrapped stats --me Amara` (first names, as both start out)');

  // Emptied afterwards: the recap on show is not remade for nobody.
  await page.fill('#me-name', '');
  await page.waitForSelector('#me-error:not([hidden])');
  await page.waitForTimeout(700);
  state = await snap(page);
  ok(!state.busy && state.stats.senders.some((x) => x.name === 'Amara'), 'emptying the field afterwards asks again and leaves the recap as it was');

  // A first name someone else already goes by: they get an initial, nobody is merged.
  await page.fill('#me-name', 'Ines');
  state = await settled(page);
  eq(await page.inputValue('.mk-person[data-person="n:Ines Calloway"] input'), 'Ines C.', 'someone who shares the owner\'s first name gets an initial');
  ok(state.stats.senders.some((x) => x.name === 'Ines') && state.stats.senders.some((x) => x.name === 'Ines C.'), 'so the two are still two people');
  await matchesShort(page, [...base, '--me', 'Ines'], 'exactly as the command-line tool does it with --me Ines');
  await rename(page, 'n:Ines Calloway', 'Ines');
  ok(/counted together/i.test(await text(page, '#me-hint')), 'giving someone the owner\'s exact name is allowed, and the page says what that does');
  await rename(page, 'n:Ines Calloway', '');

  // Staying "Me" is a choice.
  await page.locator('.mk-check').click();
  ok(await page.locator('#me-name').isDisabled() && await page.locator('#me-as-me').isChecked(), '"Leave me as Me" is a box to tick, and it switches the field off');
  state = await settled(page);
  ok(state.options.me === 'Me' && state.stats.senders.some((x) => x.name === 'Me'), 'then, and only then, the owner is "Me"');
  ok(/under .Me./.test(await text(page, '#me-hint')), 'and the page says that everyone will see "Me"');
  eq(await page.inputValue('.mk-person[data-person="n:Ines Calloway"] input'), 'Ines', 'nobody needs an initial because of the owner any more');
  await matchesShort(page, base, 'byte-identical to `wrapped stats` with its default owner');

  // Another chat from the same messages: the same person, so the choice is kept.
  await page.click('#another');
  await page.waitForSelector('#step-chat.is-active');
  await pick(page, UNNAMED);
  ok(await page.locator('#me-as-me').isChecked(), 'choosing another chat keeps the choice');
  await page.locator('.mk-check').click();
  eq(await page.inputValue('#me-name'), 'Ines', 'and the name that was typed');
  ok(await page.locator('#me-name').isEnabled(), 'unticking the box brings the field back');

  // Starting over forgets it; the sample brings an invented owner of its own.
  await page.click('#start-over');
  await page.click('#try-sample');
  await page.waitForSelector('#step-tune.is-active', { timeout: 30000 });
  eq(await page.inputValue('#me-name'), 'Marisol', 'the sample chat comes with an invented name for its owner');
  await page.click('#create');
  await page.waitForFunction(() => { const x = window.WrappedMake.snapshot(); return x.created && !x.busy; }, null, { timeout: 30000 });
  ok((await snap(page)).stats.senders.some((x) => x.name === 'Marisol'), 'so the sample recap can be made with one click');
  await page.click('#restart');
  await addMac(page, [CHAT_DB, CHAT_WAL]);
  await pick(page, TACO);
  eq([await page.inputValue('#me-name'), await page.locator('#me-as-me').isChecked()], ['', false], 'other messages after that start with an empty name again');

  s.clean('name');
  await s.close();
});

// ── people without a name, and contact names added late ────────────────────────────────
await section('contacts', 'People without a name: a note, listed first, the contacts file one click away', async () => {
  const s = await open();
  const { page } = s;
  await addMac(page, [CHAT_DB, CHAT_WAL]);
  await pick(page, TACO);
  const rows = () => page.$$eval('.mk-person', (els) => els.map((e) => ({ key: e.dataset.person, unnamed: e.classList.contains('is-unnamed') })));
  const firstNamed = (list) => { const at = list.findIndex((r) => !r.unnamed); return at < 0 ? list.length : at; };

  ok(await visible(page, '#unnamed-box'), 'a note sits at the top of the list of people');
  eq(await text(page, '#unnamed-hint'), '7 people have no name yet. Name them, or add your contacts file to fill them in.', 'it says how many have no name and what to do');
  eq(await text(page, '#add-contacts'), 'Add your contacts file', 'with a button for the contacts file right there');
  const above = await page.evaluate(() => document.getElementById('unnamed-box').getBoundingClientRect().bottom <= document.getElementById('people').getBoundingClientRect().top);
  ok(above, 'above the first person');
  await page.locator('#contacts-where summary').click();
  ok(await visible(page, '#contacts-where-mac') && !(await visible(page, '#contacts-where-backup')) &&
    (await text(page, '#contacts-where-mac')).includes('~/Library/Application Support/AddressBook'), '"Where is it?" gives the folder on a Mac');
  ok(await page.locator('#create').isEnabled() && !(await visible(page, '#error-tune')), 'none of this stands in the way of creating');

  // Say who you are, pick a period and name one person by hand; then make the recap.
  await rename(page, 'me', 'Amara');
  await period(page, 'all');
  await rename(page, 'h:p:5550100002', 'Bramble');
  eq(await text(page, '#unnamed-hint'), '6 people have no name yet. Name them, or add your contacts file to fill them in.', 'the count follows as names are typed');
  let state = await create(page);
  ok(state.stats.senders.some((x) => x.name === '…0001') && state.stats.senders.some((x) => x.name === 'Bramble'), 'a recap can be made with people still unnamed');
  const workers = s.requests.filter((u) => u.endsWith('/make/worker.js')).length;

  // A contacts file that does not know these people.
  await page.setInputFiles('#input-contacts', [BOOKS[0]]);
  await page.waitForSelector('#contacts-note:not([hidden])', { timeout: 30000 });
  ok(/none of them is one of the people without a name/.test(await text(page, '#contacts-note')) && /Sources/.test(await text(page, '#contacts-note')),
    `a contacts file without these people says so, and where else to look: "${await text(page, '#contacts-note')}"`);
  eq(await text(page, '#add-contacts'), 'Add another contacts file', 'the button now offers another one');
  eq(await text(page, '#unnamed-hint'), '6 people have no name yet: they are not in the contacts you added. Name them, or add another contacts file.', 'and the note says where things stand');

  // The one that does.
  await page.setInputFiles('#input-contacts', [BOOKS[1]]);
  await page.waitForFunction(() => /more people have a name now/.test(document.getElementById('contacts-note').textContent), null, { timeout: 30000 });
  ok(/6 more people have a name now/.test(await text(page, '#contacts-note')), `the page says what the contacts did: "${await text(page, '#contacts-note')}"`);
  state = await settled(page);
  ok(await visible(page, '#step-tune.is-active') && state.chat.id === TACO, 'the chosen chat stays chosen');
  eq([await page.inputValue('#me-name'), await page.locator('input[name="period"]:checked').getAttribute('value')], ['Amara', 'all'], 'your name and the period are as you left them');
  eq(await page.inputValue('.mk-person[data-person="n:Bram Okoye"] input'), 'Bramble', 'a name typed by hand stays with its person');
  ok((await text(page, '.mk-person[data-person="n:Bram Okoye"]')).includes('Bram Okoye'), 'with the name from the contacts beside it as a hint');
  eq(await page.inputValue('.mk-person[data-person="n:Sam Rivera"] input'), 'Sam R.', 'the others get the first names from the contacts');
  let list = await rows();
  eq(list[0], { key: 'h:p:5550100006', unnamed: true }, 'the one person who is still unnamed is listed first');
  ok(list.slice(firstNamed(list)).every((r) => !r.unnamed), 'nobody without a name comes after someone with one');
  eq(await text(page, '#unnamed-hint'), 'One person has no name yet: they are not in the contacts you added. Name them, or add another contacts file.', 'the note counts one');
  ok(/contacts?/.test(await text(page, '#source-summary')) && (await page.locator('#source-notes [data-note="no_contacts"]').count()) === 0, 'step 1\'s summary now shows the contacts');
  eq(state.stats.senders.map((x) => x.name).sort(), ['Amara', 'Bramble', 'Ines', 'Sam C.', 'Sam R.', 'Zoë', '…0006'].sort(), 'the recap that was showing is remade with the names');
  eq(s.requests.filter((u) => u.endsWith('/make/worker.js')).length, workers, 'without starting over: the same reader, the database is not read again');
  await rename(page, 'n:Bram Okoye', '');
  await matchesShort(page, [String(TACO), '--db', CHAT_DB, '--contacts', BOOK_DIR, '--tz', LA, '--all-time', '--me', 'Amara'],
    'and, the hand-typed name aside, it is byte-identical to `wrapped stats --contacts`');
  eq(leaks(JSON.stringify(decode((await snap(page)).link.url))), [], 'nothing raw in the link');

  // The same file again, and a file that is no contacts file.
  await page.setInputFiles('#input-contacts', [BOOKS[1]]);
  await page.waitForFunction(() => /already added/.test(document.getElementById('contacts-note').textContent));
  ok(true, 'the same contacts file twice is read once');
  await page.setInputFiles('#input-contacts', [path.join(EXTRA, 'other/library.db')]);
  await page.waitForSelector('#error-tune:not([hidden])', { timeout: 30000 });
  ok(/not a contacts file/i.test(await text(page, '#error-tune')) && /\.abcddb/.test(await text(page, '#error-tune')), 'another kind of file is refused in words, with what to look for');
  ok(await visible(page, '#step-tune.is-active') && (await page.inputValue('.mk-person[data-person="n:Sam Rivera"] input')) === 'Sam R.' && !(await snap(page)).busy, 'and nothing changed');
  s.clean('contacts');
  await s.close();

  // Dropped on the page while tuning: same thing.
  const d = await open();
  await addMac(d.page, [CHAT_DB, CHAT_WAL]);
  await pick(d.page, TACO);
  await rename(d.page, 'h:p:5550100003', 'Samwise');
  await dropFiles(d.page, [BOOKS[1]]);
  await d.page.waitForFunction(() => /have a name now/.test(document.getElementById('contacts-note').textContent), null, { timeout: 30000 });
  eq(await d.page.inputValue('.mk-person[data-person="n:Sam Rivera"] input'), 'Samwise', 'a contacts file dropped on the page while tuning fills in the names and keeps what was typed');
  d.clean('contacts dropped');
  await d.close();

  // An iPhone backup read from its messages file alone: the note points into the backup.
  const b = await open();
  const inBackup = (id) => path.join(BACKUP, id.slice(0, 2), id);
  await b.page.click('#tab-backup');
  await b.page.setInputFiles('#input-backup-files', [inBackup('3d0d7e5fb2ce288813306e4d4636395e047a3d28')]);
  await b.page.waitForSelector('#step-chat.is-active', { timeout: 60000 });
  await pick(b.page, TACO);
  await b.page.locator('#contacts-where summary').click();
  ok(await visible(b.page, '#contacts-where-backup') && (await text(b.page, '#contacts-where-backup')).includes('31bb7ba8'), 'for an iPhone backup, "Where is it?" names the file inside the backup');
  await b.page.setInputFiles('#input-contacts', [inBackup('31bb7ba8914766d4ba40d6dfb6113c8b614be442')]);
  await b.page.waitForFunction(() => /have a name now/.test(document.getElementById('contacts-note').textContent), null, { timeout: 30000 });
  await period(b.page, 'all');
  await create(b.page);
  await b.page.click('#first-names');
  await matchesCli(b.page, [String(TACO), '--backup', BACKUP, '--tz', LA, '--all-time'], LA, 'with the backup\'s contacts added late, the stats are byte-identical to `wrapped stats --backup`');
  b.clean('contacts for a backup');
  await b.close();

  // An export has no contacts file to add: the note only asks for names.
  const p = await open();
  await p.page.click('#tab-paste');
  await p.page.fill('#paste-text', '#dates\n2026-03-01T10:00:00-08:00\n2026-03-01T10:05:00-08:00\n2026-03-01T10:09:00-08:00\n#senders\n+15550107001\nMaya\n+15550107001\n');
  await p.page.click('#paste-go');
  await p.page.waitForSelector('#step-tune.is-active', { timeout: 30000 });
  ok(/^One person has no name yet\. Name them below/.test(await text(p.page, '#unnamed-hint')) && !(await visible(p.page, '#add-contacts')), 'a pasted export: the note asks for the name, and offers no contacts file');
  list = await p.page.$$eval('.mk-person', (els) => els.map((e) => e.classList.contains('is-unnamed')));
  eq(list, [true, false], 'and the unnamed sender is listed first');
  p.clean('contacts, pasted export');
  await p.close();
});

// ── names every object already has ─────────────────────────────────────────────────────
await section('hostile', 'People called constructor, toString or __proto__ are people like any other', async () => {
  const HOSTILE = path.join(EXTRA, 'hostile/chat.db');
  const HOSTILE_BOOK = path.join(EXTRA, 'hostile/AddressBook-v22.abcddb');
  const names = (state) => state.stats.senders.map((x) => x.name).sort();

  // As the sender itself, in a database.
  let s = await open();
  let page = s.page;
  await addMac(page, [HOSTILE]);
  await pick(page, 1);
  ok(await visible(page, '#step-tune.is-active') && !(await visible(page, '#error-chat')), 'a chat whose senders are called constructor, toString and __proto__ opens');
  eq((await snap(page)).people.filter((p) => !p.me).map((p) => p.name).sort(), ['__proto__', 'constructor', 'hasOwnProperty', 'toString', 'valueOf'], 'they are listed under those names');
  await period(page, 'all');
  let state = await create(page);
  eq(names(state), ['Me', '__proto__', 'constructor', 'hasOwnProperty', 'toString', 'valueOf'], 'and counted under them');
  await matchesCli(page, ['1', '--db', HOSTILE, '--no-contacts', '--tz', LA, '--all-time'], LA, 'sender names: byte-identical to the command-line tool');
  eq(decode(state.link.url).senders.map((x) => x.name).sort(), names(state), 'the link carries the same names');
  await rename(page, 'n:constructor', '__proto__');
  state = await settled(page);
  ok(!names(state).includes('constructor') && (await page.locator('.mk-tag--merge').count()) === 2, 'renaming one of them to another counts the two together, like anyone else');
  await rename(page, 'me', 'toString');
  state = await settled(page);
  ok(state.options.me === 'toString' && /counted together/i.test(await text(page, '#me-hint')), 'the owner can be called that too');
  s.clean('hostile handles');
  await s.close();

  // As names in the address book: first names by default, so the first word is what matters.
  s = await open();
  page = s.page;
  await addMac(page, [HOSTILE, HOSTILE_BOOK]);
  await pick(page, 2);
  ok(await visible(page, '#step-tune.is-active'), 'a chat whose contacts are called constructor Jones and __proto__ Smith opens (it used to stop here, silently)');
  await period(page, 'all');
  state = await create(page);
  eq(names(state), ['Me', '__proto__', 'constructor J.', 'constructor N.', 'hasOwnProperty', 'toString'], 'first names, with an initial for the two who share one');
  await matchesShort(page, ['2', '--db', HOSTILE, '--contacts', HOSTILE_BOOK, '--tz', LA, '--all-time'], 'contact names, first names: byte-identical to the command-line tool');
  await page.click('#first-names');
  await matchesCli(page, ['2', '--db', HOSTILE, '--contacts', HOSTILE_BOOK, '--tz', LA, '--all-time'], LA, 'contact names in full: byte-identical too');
  const story = await storyTotal((await snap(page)).link.url);
  eq(story.total, (await snap(page)).stats.totals.messages, 'and the story plays the link');
  s.clean('hostile contacts');
  await s.close();

  // The same people named late, from the contacts button in step 3.
  s = await open();
  page = s.page;
  await addMac(page, [HOSTILE]);
  await pick(page, 2);
  await page.setInputFiles('#input-contacts', [HOSTILE_BOOK]);
  await page.waitForFunction(() => /have a name now/.test(document.getElementById('contacts-note').textContent), null, { timeout: 30000 });
  await period(page, 'all');
  state = await create(page);
  eq(names(state), ['Me', '__proto__', 'constructor J.', 'constructor N.', 'hasOwnProperty', 'toString'], 'added late, the same names');
  s.clean('hostile contacts, late');
  await s.close();

  // Pasted.
  s = await open();
  page = s.page;
  const senders = ['constructor', 'toString', '__proto__', '', 'constructor', 'valueOf', '__proto__', 'hasOwnProperty', 'toString', 'constructor'];
  const source = '#dates\n' + senders.map((_, i) => `2026-04-0${1 + (i % 9)}T1${i % 10}:15:00-07:00`).join('\n') + '\n#senders\n' + senders.join('\n') + '\n';
  await page.click('#tab-paste');
  await page.fill('#paste-text', source);
  await page.click('#paste-go');
  await page.waitForSelector('#step-tune.is-active', { timeout: 30000 });
  await period(page, 'all');
  state = await create(page);
  eq(names(state), ['Me', '__proto__', 'constructor', 'hasOwnProperty', 'toString', 'valueOf'], 'a pasted export with those senders is read and counted');
  eq(state.statsJson, exportStats(source, LA), 'exactly as the engine counts that text');
  s.clean('hostile paste');
  await s.close();

  // Contacts saved under a number, an address, or a name of a million characters (the
  // shared fixture's "numbered" cards). A card that is only a number is no name: the
  // page still asks who that is, and never shows or sends the number itself.
  s = await open();
  page = s.page;
  const EVIL = fx(P.evil_db);
  const EVIL_BOOK = fx(P.evil_address_book);
  const numbered = fixture.evil.chats.long_name.rowid;
  await addMac(page, [EVIL, EVIL_BOOK]);
  await pick(page, numbered);
  const cards = (await snap(page)).people.filter((p) => !p.me);
  const card = (handle) => cards.find((p) => p.handles.includes(handle)) || {};
  eq([card('+15550100402').name, card('+15550100402').named], ['…0402', false], 'a contact saved under a phone number is not a name');
  eq(await page.getAttribute('.mk-person[data-person="h:p:5550100402"] input', 'placeholder'), 'Who is …0402?', 'so the page asks who that is');
  ok(await visible(page, '.mk-person[data-person="h:p:5550100402"] .mk-tag--new'), 'and marks them "No name yet"');
  eq([card('+15550100403').named, card('okafor@example.com').named], [false, false], 'the same for a name that ends in a number, and for a company saved with one');
  eq([card('+15550100401').name, card('+15550100401').named], ['jane.doe', true], 'a contact saved as an e-mail address goes by the part before the @');
  ok(card('+15550100405').named && Array.from(card('+15550100405').name).length === 41 && card('+15550100405').name.endsWith('…'), 'a name of a million characters is cut to 40 and an ellipsis');
  ok(/^3 people have no name yet/.test(await text(page, '#unnamed-hint')), 'the note counts the three');
  await period(page, 'all');
  state = await create(page);
  await matchesShort(page, [String(numbered), '--db', EVIL, '--contacts', EVIL_BOOK, '--tz', LA, '--all-time'], 'numbered contacts, first names: byte-identical to the command-line tool');
  await page.click('#first-names');
  await matchesCli(page, [String(numbered), '--db', EVIL, '--contacts', EVIL_BOOK, '--tz', LA, '--all-time'], LA, 'numbered contacts, names in full: byte-identical too');
  state = await snap(page);
  ok(!/555\D{0,2}010|example\.com|@/.test(JSON.stringify(decode(state.link.url))) && !/555\D{0,2}010|example\.com|@/.test(state.statsJson), 'no number or address from those cards is in the stats or the link');
  ok(state.link.length <= 4800, `and the link fits (${state.link.length} characters)`);
  s.clean('numbered contacts');
  await s.close();

  // And if something on the page does throw one day, the person is told, on the page.
  s = await open();
  page = s.page;
  await addMac(page, [CHAT_DB, CHAT_WAL]);
  await page.evaluate(() => { window.__real = window.WrappedEngine.shortNames; window.WrappedEngine.shortNames = () => { throw new TypeError('names fell over'); }; });
  await page.click(`.mk-chat[data-chat-id="${TACO}"]`);
  await page.waitForSelector('#error-chat:not([hidden])', { timeout: 30000 });
  const said = await text(page, '#error-chat');
  ok(/Something went wrong on this page/.test(said) && /Nothing was sent anywhere/.test(said) && /names fell over/.test(said), `an exception while a step opens ends in a message on the page: "${said.replace(/\n/g, ' ').slice(0, 120)}…"`);
  state = await snap(page);
  ok(!state.busy && state.chat === null && await visible(page, '#step-chat.is-active') && (await page.locator('.mk-step.is-busy').count()) === 0, 'nothing is left spinning: the page is back on the step before');
  ok(/went wrong/i.test(await text(page, '#status')), 'and it is announced');
  await page.evaluate(() => { window.WrappedEngine.shortNames = window.__real; });
  await pick(page, TACO);
  ok(await visible(page, '#step-tune.is-active') && !(await visible(page, '#error-chat')), 'trying again works once the cause is gone');
  // The same for a throw in a plain click, far from any step change.
  await page.evaluate(() => { window.WrappedEngine.shortNames = () => { throw new RangeError('toggle fell over'); }; });
  await rename(page, 'h:p:5550100001', 'Ines Calloway');
  await page.click('#first-names');
  await page.waitForSelector('#error-tune:not([hidden])', { timeout: 30000 });
  ok(/toggle fell over/.test(await text(page, '#error-tune')), 'an exception in an ordinary click is shown too');
  eq(s.foreign, [], 'none of this left the origin');
  ok(s.problems.length > 0 && s.problems.every((line) => /fell over/.test(line)), 'the only errors in the console are the two that were planted');
  await s.close();
});

// ── 7. wrong files, limits, empty periods ──────────────────────────────────────────────
await section('guards', 'Errors are sentences with a next step', async () => {
  const s = await open();
  const { page } = s;
  const errorFor = async (files, input = '#input-mac') => {
    await page.setInputFiles(input, files);
    await page.waitForSelector('#error-source:not([hidden])', { timeout: 60000 });
    const message = await text(page, '#error-source');
    ok(!/\bat \S+ \(|TypeError|undefined|\[object|NaN/.test(message), `no raw error text in: "${message.split('\n')[0]}"`);
    ok(await visible(page, '#step-source.is-active'), 'the page stays on step 1');
    return message;
  };
  const tmp = (name, bytes) => { const file = path.join(TMP, 'guards', name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes); return file; };

  let message = await errorFor([tmp('holiday.png', Buffer.from('\x89PNG\r\n\x1a\nnot really a picture, and not a database'))]);
  ok(/That is not a Messages database/.test(message) && message.includes('~/Library/Messages') && message.includes('holiday.png'), 'a file that is not a database: named, with where the right one is');

  message = await errorFor([path.join(EXTRA, 'other/library.db')]);
  ok(/That is a database, but not the Messages one/.test(message), 'some other SQLite database');

  message = await errorFor([BOOKS[0]]);
  ok(/That is an address book, not your messages/.test(message) && message.includes('chat.db'), 'an address book on its own');

  message = await errorFor([CHAT_WAL]);
  ok(/That is only half of it/.test(message) && message.includes('chat.db-wal'), 'the -wal on its own');

  message = await errorFor([tmp('chat.db', Buffer.alloc(0))]);
  ok(/That file is empty/.test(message), 'an empty file');

  message = await errorFor([path.join(EXTRA, 'nogroups/chat.db')]);
  ok(/No group chats in there/.test(message) && /3 messages in 1 conversation/.test(message), 'a database without group chats: says what it did find');

  message = await errorFor([path.join(BACKUP, 'Manifest.plist'), path.join(BACKUP, 'Info.plist')], '#input-backup-files');
  ok(/No messages in that folder/.test(message), 'a backup folder without the messages file');

  message = await errorFor([tmp('notes.md', 'x'), tmp('todo.rtf', 'y')]);
  ok(/None of those files look like your messages/.test(message), 'several unrelated files');

  // Over the size guard: a sparse 901 MB file with a SQLite header. Refused before it is read.
  const huge = tmp('huge/chat.db', Buffer.from('SQLite format 3\u0000'));
  fs.truncateSync(huge, 901 * 1024 * 1024);
  const t0 = Date.now();
  message = await errorFor([huge]);
  ok(/too big for a browser tab/.test(message) && /901 MB/.test(message) && /limit here is 900 MB/.test(message), 'a database over the size guard is refused');
  ok(message.includes('wrapped link "Your chat name"'), 'and the message points at the command-line tool');
  ok(Date.now() - t0 < 15000, 'without reading the file first');
  fs.rmSync(huge);

  // An old database (2016): opens, and starts on "All time" instead of an empty recap.
  await page.setInputFiles('#input-mac', [fx(P.legacy_db)]);
  await page.waitForSelector('#step-chat.is-active', { timeout: 60000 });
  ok(!(await visible(page, '#error-source')), 'a good file after a bad one clears the error');
  const legacy = cliChats(['--db', fx(P.legacy_db), '--no-contacts']);
  eq(await listed(page), legacy.chats.map(brief), 'an old-schema database lists its chats like the CLI');
  await pick(page, legacy.chats[0].id);
  ok(await page.locator('input[name="period"][value="all"]').isChecked(), 'a chat that went quiet years ago starts on "All time"');
  await create(page);
  await matchesCli(page, [String(legacy.chats[0].id), '--db', fx(P.legacy_db), '--no-contacts', '--tz', LA, '--all-time'], LA, 'old-schema database: byte-identical');

  // A period with nothing in it.
  await period(page, 'year');
  await page.waitForSelector('#error-recap:not([hidden])');
  message = await text(page, '#error-recap');
  ok(/No messages in this period/.test(message) && !(await visible(page, '#recap')), 'an empty period: says so and shows no link');
  await page.click('#error-recap button');
  await settled(page);
  ok(await visible(page, '#recap') && await page.locator('input[name="period"][value="all"]').isChecked(), '"Use all time instead" brings the recap back');

  // Impossible custom range.
  await period(page, 'custom');
  ok(/Pick a start date/.test(await text(page, '#period-hint')), 'custom with no dates asks for one');
  await page.fill('#period-start', '2016-07-01');
  await page.fill('#period-end', '2016-06-01');
  ok(/start date is after the end date/.test(await text(page, '#period-hint')) && await page.locator('#period-hint.is-error').count() === 1, 'start after end: an inline message, no crash');
  await page.fill('#period-end', '2016-12-31');
  await page.fill('#period-start', '2016-01-01');
  const ranged = await settled(page);
  eq([ranged.stats.period.start, ranged.stats.period.end], ['2016-01-01', '2016-12-31'], 'a valid range is counted');
  await matchesCli(page, [String(legacy.chats[0].id), '--db', fx(P.legacy_db), '--no-contacts', '--tz', LA, '--start', '2016-01-01', '--end', '2016-12-31'], LA, 'and matches the CLI for the same range');

  // Files that add nothing to an open database are ignored, not fatal.
  await page.setInputFiles('#input-mac', [tmp('notes.md', 'x'), tmp('todo.rtf', 'y')]);
  await page.waitForSelector('#source-notes [data-note="ignored"]');
  ok(await visible(page, '#recap'), 'unrelated files added later leave the open recap alone');

  s.clean('guards');
  await s.close();

  // Several files called chat.db: one is read, and the page says which.
  const twinA = path.join(EXTRA, 'twins/a/chat.db');
  const twinB = path.join(EXTRA, 'twins/b/chat.db');
  fs.utimesSync(twinA, new Date('2026-05-02T12:00:00Z'), new Date('2026-05-02T12:00:00Z'));
  fs.utimesSync(twinB, new Date('2026-06-03T12:00:00Z'), new Date('2026-06-03T12:00:00Z'));
  const t = await open();
  await addMac(t.page, [twinA, twinB]);
  let twins = await text(t.page, '#source-notes [data-note="twins"]');
  ok(/You added 2 files called chat\.db/.test(twins) && /this is the one that was used: chat\.db \(\d+ KB, last changed May 2, 2026\)/.test(twins) && /start over and add only that one/.test(twins),
    `two files with the same name: the page says which was read and how to pick the other ("${twins}")`);
  eq((await listed(t.page)).map((c) => c.name), ['Folder A'], 'and that is the one whose chats are listed');
  // The same two inside one folder: the path tells them apart.
  await t.page.click('#start-over');
  await t.page.click('#tab-backup');
  await t.page.setInputFiles('#input-backup-folder', path.join(EXTRA, 'twins'));
  await t.page.waitForSelector('#step-chat.is-active', { timeout: 60000 });
  twins = await text(t.page, '#source-notes [data-note="twins"]');
  const used = (/was used: (twins\/[ab]\/chat\.db) \(/.exec(twins) || [])[1];
  ok(!!used, `picked as a folder, the note gives the path of the one that was read ("${twins}")`);
  eq((await listed(t.page)).map((c) => c.name), [used === 'twins/a/chat.db' ? 'Folder A' : 'Folder B'], 'which is the one whose chats are listed');
  t.clean('same-named files');
  await t.close();
});

// ── 8. keyboard, focus, live status, reduced motion ────────────────────────────────────
await section('keyboard', 'Keyboard only, focus, announcements, reduced motion', async () => {
  const s = await open({ reducedMotion: 'reduce' });
  const { page } = s;
  const active = () => page.evaluate(() => document.activeElement && (document.activeElement.id || document.activeElement.className));
  const seen = [];
  for (let i = 0; i < 6; i++) { await page.keyboard.press('Tab'); seen.push(await active()); }
  ok(seen.includes('tab-mac'), `Tab reaches the source tabs (${seen.join(' → ')})`);
  await page.focus('#tab-mac');
  await page.keyboard.press('ArrowRight');
  eq([await active(), await page.getAttribute('#tab-backup', 'aria-selected')], ['tab-backup', 'true'], 'arrow keys move between the tabs');
  await page.keyboard.press('End');
  eq(await active(), 'tab-paste', 'End jumps to the last tab');
  await page.keyboard.press('ArrowRight');
  eq(await active(), 'tab-mac', 'and the arrows wrap around');
  const ring = await page.evaluate(() => { const cs = getComputedStyle(document.activeElement); return cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) >= 2; });
  ok(ring, 'the focused tab has a visible focus ring');
  eq(await page.getAttribute('#status', 'aria-live'), 'polite', 'there is a polite live region');

  await page.focus('#try-sample');
  await page.keyboard.press('Enter');
  await page.waitForSelector('#step-tune.is-active', { timeout: 30000 });
  eq(await active(), 'h-tune', 'focus moves to the step that opened');
  ok(/sample chat is ready/i.test(await text(page, '#status')), 'and the live region announces it');
  await page.keyboard.press('Tab');
  eq(await active(), 'me-name', 'the next Tab stop is the first field of that step: your name');
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.press('Backspace');
  await page.focus('#create');
  await page.keyboard.press('Enter');
  eq([await active(), (await snap(page)).created], ['me-name', false], 'Create without a name puts the focus back in that field instead');
  ok(/first name/i.test(await text(page, '#status')), 'and says why');
  await page.keyboard.type('Kit');
  await page.keyboard.press('Tab');
  eq(await active(), 'me-as-me', 'next comes the "Leave me as Me" box');
  await page.keyboard.press('Tab');
  ok(await page.evaluate(() => document.activeElement.name === 'period'), 'and then the period');
  const chosen = () => page.locator('input[name="period"]:checked').getAttribute('value');
  const first = await chosen();
  await page.keyboard.press('ArrowRight');
  const second = await chosen();
  await page.keyboard.press('ArrowLeft');
  ok(second !== first && (await chosen()) === first, `the period is a real radio group: the arrow keys change it (${first} → ${second} → ${first})`);
  await page.focus('#create');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => { const x = window.WrappedMake.snapshot(); return x.created && !x.busy && x.link; }, null, { timeout: 30000 });
  eq(await active(), 'h-recap', 'creating the recap moves focus to it');
  await page.focus('#quotes');
  await page.keyboard.press('Space');
  ok((await snap(page)).quotes, 'the quotes switch works from the keyboard');
  eq(await page.getAttribute('#quotes', 'role'), 'switch', 'and is announced as a switch');
  ok(/included in the link/.test(await text(page, '#status')), 'the change is announced');
  const durations = await page.evaluate(() => [...document.querySelectorAll('.mk-typing i, .mk-step__body, .mk-bubble, .mk-art__out')].map((el) => parseFloat(getComputedStyle(el).animationDuration)));
  ok(durations.length > 0 && durations.every((d) => d < 0.01), 'with reduced motion, animations are switched off');
  s.clean('keyboard');
  await s.close();
});

// ── 9. viewports ───────────────────────────────────────────────────────────────────────
await section('matrix', 'No sideways overflow at 360, 390, 768 and 1440 px, at every step', async () => {
  for (const [name, viewport] of Object.entries(VIEWPORTS)) {
    const s = await open({ viewport });
    const { page } = s;
    const check = async (step) => eq(await overflow(page), [], `${name}: ${step}`);
    await check('step 1, Mac');
    await page.click('#tab-backup');
    await check('step 1, iPhone backup');
    await page.click('#tab-paste');
    await page.locator('#panel-paste details summary').click();
    await check('step 1, paste');
    await page.click('#tab-mac');
    await page.locator('#panel-mac details summary').click();
    await page.setInputFiles('#input-mac', [fx(P.backup_sms)]);       // a wrong name is fine: it is still a Messages database
    await page.waitForSelector('#step-chat.is-active', { timeout: 60000 });
    await check('step 2, chat list');
    // A chat is picked by its name, so the name is never cut short (it may take two
    // lines), and the line under it wraps instead of ending in an ellipsis.
    const cut = await page.$$eval('.mk-chat', (els) => els.flatMap((chat) => {
      const name = chat.querySelector('.mk-chat__name');
      const meta = chat.querySelector('.mk-chat__meta');
      const lines = Math.round(name.getBoundingClientRect().height / parseFloat(getComputedStyle(name).lineHeight));
      const out = [];
      if (name.scrollHeight > name.clientHeight + 1 && lines < 2) out.push('name cut on one line: ' + name.textContent);
      if (meta.scrollWidth > meta.clientWidth + 1) out.push('meta cut: ' + meta.textContent);
      if (getComputedStyle(name).whiteSpace === 'nowrap' || getComputedStyle(meta).textOverflow === 'ellipsis') out.push('still set to cut: ' + name.textContent);
      if ([...meta.children].some((part) => part.getClientRects().length !== 1)) out.push('a piece of the meta line is split: ' + meta.textContent);
      return out;
    }));
    eq(cut, [], `${name}: chat names wrap instead of being cut, and the line under them stays whole`);
    if (viewport.width <= 360) {
      const taco = await page.$eval(`.mk-chat[data-chat-id="${TACO}"] .mk-chat__name`, (el) => ({ shown: el.scrollHeight <= el.clientHeight + 1, text: el.textContent }));
      ok(taco.shown && taco.text.includes('Taco Tuesday Crew'), `${name}: "Taco Tuesday Crew" is shown in full`);
    }
    await pick(page, STRESS);                                          // 14 people with enormous names
    await check('step 3, tune (longest names)');
    await period(page, 'custom');
    await check('step 3, custom dates');
    await period(page, 'all');
    await page.locator('#advanced summary').click();
    await create(page);
    await quotes(page, true);
    await page.locator('#raw summary').click();
    await check('step 4, recap with quotes, trimmed, raw data open');
    await page.click('#another');
    await page.waitForSelector('#step-chat.is-active');
    await pick(page, UNNAMED);
    await create(page);
    await check('step 4, unnamed chat');
    await page.click('#restart');
    await page.setInputFiles('#input-mac', [path.join(EXTRA, 'other/library.db')]);
    await page.waitForSelector('#error-source:not([hidden])');
    await check('an error message');
    s.clean(`matrix ${name}`);
    await s.close();
  }
});

// ── 10. screenshots (invented data only) ───────────────────────────────────────────────
await section('shots', 'Screenshots of every step, phone and desktop', async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  for (const [size, viewport] of [['desktop', VIEWPORTS['desktop-1440']], ['phone', VIEWPORTS['phone-390']]]) {
    // Whole-page pictures of the four steps; close-ups of one step for the variations.
    // Steps 1 to 3 with the invented Messages database.
    let s = await open({ viewport, still: true });
    let page = s.page;
    await shot(page, `1-add-${size}`);
    await page.click('#tab-backup');
    await shot(page, `1-add-backup-${size}`, '#step-source');
    await page.click('#tab-paste');
    await page.fill('#paste-text', EXPORTS.columnar.split('\n').slice(0, 5).join('\n') + '\n…');
    await shot(page, `1-add-paste-${size}`, '#step-source');
    await page.click('#tab-mac');
    await addMac(page, [CHAT_DB]);
    await shot(page, `1-add-without-wal-${size}`, '#step-source');
    await page.setInputFiles('#input-mac', [CHAT_WAL, BOOKS[1]]);
    await page.waitForFunction(() => /contact/.test(document.getElementById('source-summary').textContent), null, { timeout: 60000 });
    await page.waitForSelector('#step-chat.is-active');
    await shot(page, `2-choose-${size}`);
    await pick(page, UNNAMED);
    await rename(page, 'me', 'Amara');
    await shot(page, `3-tune-${size}`);
    await s.close();

    s = await open({ viewport, still: true });
    page = s.page;
    await page.click('#tab-backup');
    await page.setInputFiles('#input-backup-folder', fx(P.backup_encrypted));
    await page.waitForSelector('#error-source:not([hidden])');
    await shot(page, `1-add-encrypted-${size}`, '#error-source');
    await s.close();

    // Step 4 with the sample chat.
    s = await open({ viewport, still: true, permissions: ['clipboard-read', 'clipboard-write'] });
    page = s.page;
    await page.click('#try-sample');
    await page.waitForSelector('#step-tune.is-active', { timeout: 30000 });
    await create(page);
    await freezePreview(page);
    await shot(page, `4-recap-${size}`);
    await quotes(page, true);
    await page.click('#copy');
    await page.waitForFunction(() => /Copied/.test(document.getElementById('copy-label').textContent));
    await shot(page, `4-recap-quotes-copied-${size}`, '#step-recap');
    await s.close();
  }
  const written = fs.readdirSync(SHOTS).filter((f) => /^make-.*\.png$/.test(f));
  ok(written.length >= 18, `${written.length} screenshots written to ${path.relative(ROOT, SHOTS)}/`);
  // The committed set is the same list of pictures (their pixels are checked by eye, not here).
  const committed = fs.readdirSync(path.join(ROOT, 'docs/screenshots/web')).filter((f) => /^make-.*\.png$/.test(f)).sort();
  eq(committed, written.sort(), 'docs/screenshots/web/ holds one committed picture for each of them');
});

await browser.close();
await server.close();
fs.rmSync(TMP, { recursive: true, force: true });

console.log('\n' + '─'.repeat(72));
for (const flow of flows) console.log(`${flow.passed ? '✓' : '✗'} ${flow.name.padEnd(9)} ${String(flow.checks).padStart(4)} checks`);
console.log(`${checks} checks, ${failures.length} failed (${BROWSER})`);
if (failures.length) {
  console.log('\nFailures:');
  for (const f of failures) console.log(' - ' + f);
  process.exit(1);
}
