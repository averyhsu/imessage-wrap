// End-to-end checks for the "Make your own" page (web/make/), in headless Chromium.
//
//   npm run test:make                       everything; exits non-zero on any failure
//   node tests/e2e/make/run.mjs --only=mac,paste
//
// Sections: mac, nowal, search, backup, paste, sample, rename, guards, keyboard, matrix, shots.
//
// The invented Messages databases are built into a temporary folder with
// tests/fixtures/build_fixture.py and deleted afterwards; nothing is read from a real device
// and no database is ever written inside the repository. What the page computes is compared
// with the Python command-line tool (`python3 -m wrapped ...`) on the same files.
// Screenshots go to docs/screenshots/web/make-*.png.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { ROOT, WEB, startServer, launch, waitForStory, showSettled } from '../lib.mjs';

const require = createRequire(import.meta.url);
const Engine = require(path.join(WEB, 'make/engine.js'));
const Import = require(path.join(WEB, 'make/import-rows.js'));
const Config = require(path.join(WEB, 'js/config.js'));
// Same DEFLATE implementation as the page, so links built here are character-for-character
// the ones the page builds.
Engine.useCodec(require(path.join(WEB, 'js/vendor/fflate.min.js')));

const PYTHON = process.env.PYTHON || 'python3';
const LA = 'America/Los_Angeles';
const SHOTS = path.join(ROOT, 'docs/screenshots/web');
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
    env: { ...process.env, PYTHONPATH: ROOT, PYTHONIOENCODING: 'utf-8', TZ: tz },
  });
}
const cliChats = (args) => JSON.parse(cli(['chats', '--json', ...args]));
const cliStats = (args, tz) => cli(['stats', ...args, '--compact'], tz).replace(/\n$/, '');
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
  const context = await browser.newContext({
    viewport: { width: vp.width, height: vp.height },
    deviceScaleFactor: opts.scale || 1,
    hasTouch: !!vp.mobile,
    isMobile: !!vp.mobile,
    timezoneId: opts.tz || LA,
    locale: 'en-US',
    reducedMotion: opts.still ? 'reduce' : (opts.reducedMotion || 'no-preference'),
    permissions: opts.permissions || [],
    bypassCSP: !!opts.still,
  });
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
  context.on('requestfailed', (r) => problems.push('requestfailed: ' + r.url() + ' ' + (r.failure() ? r.failure().errorText : '')));
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
  name: e.querySelector('.mk-chat__name').textContent,
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
async function create(page) {
  await page.click('#create');
  await page.waitForFunction(() => {
    const s = window.WrappedMake.snapshot();
    return s.created && !s.busy;
  }, null, { timeout: 60000 });
  return snap(page);
}
/** Type a display name for the person whose row carries this key. */
async function rename(page, key, name) {
  await page.locator(`.mk-person[data-person="${key}"] input`).fill(name);
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
const localStory = (url) => server.url + '#w1=' + url.split('#w1=')[1];

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
      return new File([bytes], key);
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

  // Without contact names.
  await addMac(page, [CHAT_DB, CHAT_WAL]);
  const plain = cliChats(['--db', CHAT_DB, '--no-contacts']);
  eq(await listed(page), plain.chats.map(brief), 'chat list matches `wrapped chats` (no contacts)');
  const diag = await text(page, '#diag');
  ok(diag.includes(plain.diagnostics.messages.toLocaleString('en-US') + ' messages') && diag.includes(`${plain.diagnostics.chats} conversations`),
    `diagnostics line shows the totals (${diag.slice(0, 80)}…)`);
  ok(/Oct \d, 2025/.test(diag) && /2027/.test(diag), 'diagnostics line shows the first and the last date');
  ok(!(await visible(page, '#source-notes [data-note="wal_missing"]')), 'no "recent messages may be missing" warning when the -wal is there');
  ok(s.requests.some((u) => u.endsWith('/make/vendor/sql-wasm.wasm')), 'the worker\'s own request (SQLite) is seen by the test, so a foreign one would be too');
  ok(s.requests.some((u) => u.endsWith('/make/worker.js')), 'the work happens in worker.js');
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
  await matchesCli(page, [...base, '--tz', LA, '--start', '2026-01-01', '--end', '2026-11-10'], LA, 'custom range: stats are byte-identical to `wrapped stats`');
  state = await snap(page);
  eq(state.stats.totals.messages, 2869, 'the fixture\'s known total for 2026 so far');

  // The link.
  const link = state.link.url;
  ok(link.startsWith(Config.BASE_URL + '#w1=') && state.link.length === link.length && link.length <= 4800, `link is under the budget (${link.length} characters)`);
  eq(await page.inputValue('#link'), link, 'the link field holds the link');
  eq(await page.getAttribute('#open', 'href'), link, '"Open story" points at the link');
  const decoded = decode(link);
  eq(decoded, Engine.fitLink(state.stats, { quotes: false }).stats, 'the link decodes to the stats, with no message text');
  ok(decoded.most_reacted.length === 3 && decoded.most_reacted.every((m) => m.text === ''), 'quotes are off by default: every most_reacted text is blank');
  eq(leaks(JSON.stringify(decoded)), [], 'no phone number or e-mail address from the database is in the link');
  eq(leaks(state.statsJson), [], 'nor in the stats');
  const story = await storyTotal(link);
  eq(story.total, state.stats.totals.messages, 'the story opened with the link shows the same total');
  ok(story.title.includes('Taco Tuesday Crew'), 'and the chat\'s name');

  // The preview is the full recap, on this device.
  const frame = await previewFrame(page);
  ok(await frame.evaluate(() => window.WrappedStory.isActive()), 'the preview plays the real story');
  const preview = decode(state.preview);
  eq(preview, state.stats, 'the preview is built from the full stats');
  ok(new URL(state.preview).origin === origin, 'the preview is loaded from this site');
  eq(leaks(JSON.stringify(preview)), [], 'no phone number or e-mail address in the preview either');

  // Other periods, the owner's name, another time zone.
  await period(page, 'all');
  await matchesCli(page, [...base, '--tz', LA, '--all-time'], LA, 'all time: byte-identical');
  await period(page, 'year');
  await matchesCli(page, [...base, '--tz', LA, '--year', String(year)], LA, `this year (${year}): byte-identical`);
  await period(page, 'last');
  await matchesCli(page, [...base, '--tz', LA, '--year', String(year - 1)], LA, `last year (${year - 1}): byte-identical`);
  await period(page, 'all');
  await rename(page, 'me', 'Avery');
  await matchesCli(page, [...base, '--tz', LA, '--all-time', '--me', 'Avery'], LA, 'your own name: byte-identical to --me');
  await page.locator('#advanced summary').click();
  await page.selectOption('#tz', 'Asia/Tokyo');
  await matchesCli(page, [...base, '--tz', 'Asia/Tokyo', '--all-time', '--me', 'Avery'], LA, 'another time zone: byte-identical to --tz');
  ok((await page.locator('#tz option').count()) > 100, 'the time zone list is filled in');

  // Another chat without reloading the file: the stress chat needs the trim ladder.
  await page.click('#another');
  await page.waitForSelector('#step-chat.is-active');
  eq((await listed(page)).length, named.chats.length, 'choosing another chat brings the list back without reading the file again');
  await pick(page, STRESS);
  await period(page, 'all');
  state = await create(page);
  await matchesCli(page, [String(STRESS), '--db', CHAT_DB, '--contacts', BOOK_DIR, '--tz', 'Asia/Tokyo', '--all-time'], LA, 'largest chat: byte-identical');
  state = await snap(page);
  ok(state.link.length <= 4800, `largest chat: the link fits (${state.link.length} characters, quotes off)`);
  ok(await page.locator('#quotes').isEnabled(), 'largest chat: quotes can still be switched on');
  await page.locator('#quotes').check({ force: true });
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
  await matchesCli(page, [String(UNNAMED), '--db', CHAT_DB, '--contacts', BOOK_DIR, '--tz', 'Asia/Tokyo', '--all-time'], LA, 'unnamed chat: byte-identical');
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
  eq(decode(state.preview), state.stats, 'the preview carries the full stats');
  ok(state.stats.most_reacted.length === 3 && state.stats.most_reacted.every((m) => m.text), 'the full stats have three quotable messages');

  // Quotes: off by default.
  ok(!(await page.locator('#quotes').isChecked()), 'the quotes switch starts off');
  let decoded = decode(state.link.url);
  ok(decoded.most_reacted.length === 3 && decoded.most_reacted.every((m) => m.text === ''), 'default link: every most_reacted text is blank');
  ok(state.link.length <= 4800 && state.link.steps === 0, `default link: ${state.link.length} characters, nothing trimmed`);
  ok(/No message text/.test(await text(page, '#inside-list')), 'the page says: no message text');
  const offered = await page.$$eval('.mk-quote__text', (els) => els.map((e) => e.textContent));
  eq(offered, state.stats.most_reacted.map((m) => m.text), 'the three messages are shown word for word before anything is switched on');
  ok(!(await visible(page, '#trim')), 'no "left out" note when nothing was trimmed');

  // Switch them on.
  await page.locator('#quotes').check({ force: true });
  const on = await snap(page);
  ok(on.quotes && on.link.url !== state.link.url, 'switching on changes the link');
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
  eq(await page.getAttribute('#open', 'href'), on.link.url, 'Open story is the same link');
  eq(await page.getAttribute('#open', 'target'), '_blank', 'in a new tab');
  ok(/Paste the link on its own line in the group chat\. Everyone can open it, no app needed\./.test(await text(page, '.mk-guide')), 'the one line of guidance is there');
  const story = await storyTotal(on.link.url);
  eq(story.total, state.stats.totals.messages, 'the story opened with the link shows the right total');

  // Off again; a new chat name updates everything; start over.
  await page.locator('#quotes').uncheck({ force: true });
  eq((await snap(page)).link.url, state.link.url, 'switching off restores the link without text');
  await page.fill('#chat-name', 'Cabin People');
  const renamed = await settled(page);
  eq(renamed.stats.chat.name, 'Cabin People', 'a new chat name is counted in');
  eq(await text(page, '#recap-title'), 'Cabin People', 'and shown');
  eq(decode(renamed.preview).chat.name, 'Cabin People', 'the preview follows');
  await page.waitForFunction(() => document.getElementById('preview').contentWindow.document.title.includes('Cabin People'), null, { timeout: 15000 });
  ok(true, 'the story in the frame restarts with the new name');
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
  ok(/7 people have no name yet/.test(await text(page, '#unnamed-hint')), 'the page explains it');
  ok(/never go into the recap/.test(await text(page, '#unnamed-hint')), 'and says the full numbers stay here');
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
  ok(await page.evaluate(() => document.activeElement.name === 'period'), 'the next Tab stop is the first control of that step');
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
    await pick(page, STRESS);                                          // 14 people with enormous names
    await check('step 3, tune (longest names)');
    await period(page, 'custom');
    await check('step 3, custom dates');
    await period(page, 'all');
    await page.locator('#advanced summary').click();
    await create(page);
    await page.locator('#quotes').check({ force: true });
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
    await rename(page, 'me', 'Avery');
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
    await page.locator('#quotes').check({ force: true });
    await page.click('#copy');
    await page.waitForFunction(() => /Copied/.test(document.getElementById('copy-label').textContent));
    await shot(page, `4-recap-quotes-copied-${size}`, '#step-recap');
    await s.close();
  }
  const written = fs.readdirSync(SHOTS).filter((f) => /^make-.*\.png$/.test(f));
  ok(written.length >= 18, `${written.length} screenshots written to docs/screenshots/web/`);
});

await browser.close();
await server.close();
fs.rmSync(TMP, { recursive: true, force: true });

console.log('\n' + '─'.repeat(72));
for (const flow of flows) console.log(`${flow.passed ? '✓' : '✗'} ${flow.name.padEnd(9)} ${String(flow.checks).padStart(4)} checks`);
console.log(`${checks} checks, ${failures.length} failed`);
if (failures.length) {
  console.log('\nFailures:');
  for (const f of failures) console.log(' - ' + f);
  process.exit(1);
}
