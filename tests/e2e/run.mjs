// End-to-end checks for the web story. Plain Playwright, no test runner.
//
//   npm run test:e2e                 everything; exits non-zero on any failure
//   node tests/e2e/run.mjs --only=embed,matrix
//   npm run shots                    refresh the committed screenshots (see below)
//
// Sections: play, links, share, embed, file, matrix, landing, brand, shots.
//
// A test run never touches tracked files: screenshots go to test-results/web-screenshots/
// (git-ignored; CI uploads that folder). Only --update-screenshots writes them to
// docs/screenshots/web/, which is what `npm run shots` does.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { ROOT, WEB, startServer, launch, waitForStory, showSettled, findOverflow } from './lib.mjs';
import { fixtures, viewports } from './fixtures.mjs';

const require = createRequire(import.meta.url);
const Codec = require(path.join(WEB, 'js/codec.js'));
const Config = require(path.join(WEB, 'js/config.js'));
const Data = require(path.join(WEB, 'js/normalize.js'));
const vector = require(path.join(ROOT, 'tests/vectors/payload-v1.json'));

const UPDATE_SCREENSHOTS = process.argv.includes('--update-screenshots');
const SHOTS = UPDATE_SCREENSHOTS ? path.join(ROOT, 'docs/screenshots/web') : path.join(ROOT, 'test-results/web-screenshots');
const ALL_SLIDES = ['cover', 'total', 'clock', 'persona', 'late', 'week', 'year', 'senders', 'moty', 'taps', 'awards', 'sum'];
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
async function section(name, title, fn) {
  if (!wants(name)) return;
  const t0 = Date.now();
  const before = failures.length;
  console.log(`\n▸ ${title}`);
  try { await fn(); } catch (e) { failures.push(`${title}: threw ${e.stack || e}`); console.log('  ✗ threw: ' + (e.stack || e)); }
  console.log(`  ${failures.length === before ? '✓ passed' : '✗ FAILED'} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
}

function pngSize(buffer) {
  const sig = buffer.subarray(0, 8).toString('hex');
  if (sig !== '89504e470d0a1a0a') return null;
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

const server = await startServer();
const browser = await launch();
const origin = new URL(server.url).origin;

/** A context that records console errors, page errors and every request that leaves the origin. */
async function open(opts = {}) {
  const vp = opts.viewport || viewports['phone-390x844'];
  const context = await browser.newContext({
    viewport: { width: vp.width, height: vp.height },
    deviceScaleFactor: opts.scale || 1,
    hasTouch: !!vp.mobile,
    isMobile: !!vp.mobile,
    reducedMotion: opts.reducedMotion || 'no-preference',
    acceptDownloads: true,
    bypassCSP: !!opts.wideFont,
    ...(opts.context || {}),
  });
  const problems = [];
  const foreign = [];
  const requests = [];
  context.on('request', (req) => {
    const url = req.url();
    requests.push(url);
    if (/^(data|blob|about):/.test(url)) return;
    const allowed = opts.fileOrigin ? url.startsWith('file://') : url.startsWith(origin + '/');
    if (!allowed) foreign.push(url);
  });
  if (opts.init) await context.addInitScript(opts.init);
  if (opts.wideFont) {
    // Stand-in for devices whose system font is wider than SF/Inter (needs bypassCSP).
    await context.addInitScript(() => {
      const add = () => {
        if (!document.documentElement) return false;
        const style = document.createElement('style');
        style.textContent = ':root{--font-text:"DejaVu Sans",Verdana,sans-serif !important}';
        document.documentElement.appendChild(style);
        return true;
      };
      if (!add()) new MutationObserver((_, o) => { if (add()) o.disconnect(); }).observe(document, { childList: true });
    });
  }
  const page = await context.newPage();
  page.on('console', (m) => { if (m.type() === 'error') problems.push('console: ' + m.text()); });
  page.on('pageerror', (e) => problems.push('pageerror: ' + e.message));
  page.on('requestfailed', (r) => problems.push('requestfailed: ' + r.url() + ' ' + (r.failure() ? r.failure().errorText : '')));
  return { context, page, problems, foreign, requests, close: () => context.close() };
}

const link = (stats, prefix = '') => server.url + prefix + '#w1=' + Codec.encode(stats);
const state = (page) => page.evaluate(() => ({ index: WrappedStory.index, total: WrappedStory.total, time: WrappedStory.time, paused: WrappedStory.isPaused(), ids: WrappedStory.slideIds }));
const wait = (page, ms) => page.waitForTimeout(ms);
const visibleText = (page) => page.evaluate(() => document.body.innerText);

// ── 1. the demo plays through ──────────────────────────────────────────────────────────
await section('play', 'Demo plays through every slide at 390×844', async () => {
  const s = await open();
  const { page } = s;
  await page.goto(server.url + '?demo=1');
  await waitForStory(page);
  let st = await state(page);
  eq(st.ids, ALL_SLIDES, 'demo has all twelve slides in order');
  eq(st.index, 0, 'starts on the cover');
  ok(await page.locator('.landing').isHidden(), 'landing page is hidden while the story plays');
  eq(await page.locator('.seg').count(), 12, 'one progress segment per slide');

  // Auto-advance: the cover lasts about five seconds.
  await page.waitForFunction(() => WrappedStory.index === 1, null, { timeout: 9000 });
  ok(true, 'auto-advances from the cover');

  // Hold to pause: time stands still while a finger is down, and lifting does not navigate.
  const box = await page.locator('.stage').boundingBox();
  const cx = box.x + box.width * 0.6, cy = box.y + box.height * 0.5;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await wait(page, 500);
  const held1 = await state(page);
  await wait(page, 500);
  const held2 = await state(page);
  ok(held1.paused && held2.paused, 'holding pauses the story');
  ok(Math.abs(held2.time - held1.time) < 5, `the clock stops while held (${held1.time.toFixed(0)} → ${held2.time.toFixed(0)})`);
  await page.mouse.up();
  await wait(page, 300);
  st = await state(page);
  ok(!st.paused && st.index === 1 && st.time > held2.time, 'releasing resumes on the same slide');

  // Count-up: the big number is mid-flight early on and lands on the exact total.
  // (Read on the player's own clock, so a slow machine cannot blur the two samples.)
  await page.evaluate(() => { WrappedStory.goTo(1); WrappedStory.seek(650); });
  const mid = await page.locator('.slide.is-active .total__num').innerText();
  await page.evaluate(() => WrappedStory.seek(2600));
  const end = await page.locator('.slide.is-active .total__num').innerText();
  ok(mid !== end && Number(mid.replace(/,/g, '')) > 0, `the total counts up (saw "${mid}" on the way to "${end}")`);
  eq(end, '48,213', 'the count-up lands on the exact total');
  await page.evaluate(() => WrappedStory.resume());
  ok(!(await state(page)).paused, 'handing the clock back resumes playback');

  // Tap right through every slide.
  const seen = ['cover', 'total'];
  for (let i = 2; i < 12; i++) {
    await page.touchscreen.tap(box.x + box.width * 0.75, box.y + box.height * 0.55);
    await wait(page, 220);
    st = await state(page);
    eq(st.index, i, `tap right goes to slide ${i + 1}`);
    seen.push(await page.evaluate(() => document.querySelector('.slide.is-active').dataset.slide));
    eq(await page.locator('.slide.is-active').count(), 1, `exactly one active slide (${i + 1})`);
  }
  eq(seen, ALL_SLIDES, 'visited every slide by tapping');
  await page.touchscreen.tap(box.x + box.width * 0.75, box.y + box.height * 0.3);
  await wait(page, 150);
  eq((await state(page)).index, 11, 'tap right on the last slide stays there');
  await page.touchscreen.tap(box.x + box.width * 0.12, box.y + box.height * 0.3);
  await wait(page, 150);
  eq((await state(page)).index, 10, 'tap left goes back');

  // Keyboard.
  await page.keyboard.press('ArrowRight');
  eq((await state(page)).index, 11, 'ArrowRight goes forward');
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowLeft');
  eq((await state(page)).index, 9, 'ArrowLeft goes back');
  eq(await page.locator('.head__pause').getAttribute('aria-label'), 'Pause', 'the pause button says "Pause" while the story plays');
  await page.keyboard.press('Space');
  ok((await state(page)).paused, 'space pauses');
  ok(await page.locator('.stage.is-paused').count() === 1, 'paused state is reflected on the stage');
  eq(await page.locator('.head__pause').getAttribute('aria-label'), 'Play', 'once paused, the same button says "Play"');
  await page.keyboard.press('Space');
  ok(!(await state(page)).paused, 'space resumes');
  eq(await page.locator('.head__pause').getAttribute('aria-label'), 'Pause', 'and "Pause" again after resuming');
  await page.locator('.head__pause').click();
  eq([(await state(page)).paused, await page.locator('.head__pause').getAttribute('aria-label')], [true, 'Play'], 'clicking the button pauses and relabels it');
  await page.locator('.head__pause').click();
  eq([(await state(page)).paused, await page.locator('.head__pause').getAttribute('aria-label')], [false, 'Pause'], 'clicking again resumes');
  // Holding (or a hidden tab) is not the viewer pressing pause: the label does not flip.
  await page.evaluate(() => WrappedStory.pause());
  eq(await page.locator('.head__pause').getAttribute('aria-label'), 'Pause', 'a pause the viewer did not ask for leaves the label alone');
  await page.evaluate(() => WrappedStory.resume());
  await page.keyboard.press('End');
  eq((await state(page)).index, 11, 'End jumps to the last slide');

  // Keyboard focus: every stop is a visible control, and the first one is on screen
  // (there used to be two invisible 1×1 buttons ahead of everything). A fresh page, so
  // the browser's tab starting point is the top of the document.
  const kb = await open();
  await kb.page.goto(server.url + '?demo=1');
  await waitForStory(kb.page);
  await kb.page.evaluate(() => { WrappedStory.goTo(2); WrappedStory.pause(); });
  const stops = [];
  for (let i = 0; i < 6; i++) {
    await kb.page.keyboard.press('Tab');
    const stop = await kb.page.evaluate(() => {
      const el = document.activeElement;
      if (!el || el === document.body || !el.closest('#story')) return null;
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return { label: el.getAttribute('aria-label') || el.textContent.trim(), w: Math.round(r.width), h: Math.round(r.height), shown: cs.visibility === 'visible' && cs.display !== 'none' && Number(cs.opacity) > 0.5 };
    });
    if (!stop) break;
    stops.push(stop);
  }
  eq(stops.map((x) => x.label), ['Pause', 'Close', 'Previous slide', 'Next slide'], 'tab order on a slide: the visible controls first, then Previous / Next');
  ok(stops.every((x) => x.shown && x.w >= 30 && x.h >= 30), `every focus stop is visible and a reasonable size when focused (${JSON.stringify(stops)})`);
  await kb.page.keyboard.press('Shift+Tab');
  eq(await kb.page.evaluate(() => document.activeElement.textContent), 'Next slide', 'Shift+Tab walks back through the same stops');
  await kb.page.keyboard.press('Enter');
  eq((await state(kb.page)).index, 3, 'the focusable "Next slide" button works from the keyboard');
  eq(await kb.page.evaluate(() => { const r = document.activeElement.getBoundingClientRect(); return r.width >= 30 && document.activeElement.textContent; }), 'Next slide', 'and stays visible while it has focus');
  await kb.page.evaluate(() => document.activeElement.blur());
  const hidden = await kb.page.evaluate(() => [...document.querySelectorAll('.story__skip')].map((el) => { const r = el.getBoundingClientRect(); return r.width <= 1 && r.height <= 1; }));
  eq(hidden, [true, true], 'without focus the Previous / Next buttons take no room on the stage');
  eq(await kb.page.locator('#story .sr-only button, #story button.sr-only').count(), 0, 'no screen-reader-only buttons are left in the story');
  eq(kb.problems, [], 'no console errors while tabbing');
  await kb.close();

  // The last slide does not advance or loop on its own.
  await page.evaluate(() => { WrappedStory.seek(WrappedStory.duration + 500); WrappedStory.resume(); });
  await wait(page, 400);
  eq((await state(page)).index, 11, 'the story rests on the last slide');

  // Replay and close.
  await page.locator('.slide.is-active [data-action="replay"]').click();
  eq((await state(page)).index, 0, 'Replay restarts from the cover');
  await page.locator('.head__close').click();
  await page.waitForFunction(() => document.documentElement.classList.contains('is-landing'));
  ok(await page.locator('.landing').isVisible(), 'the close button returns to the landing page');
  ok(await page.locator('#story').isHidden(), 'the story is gone after closing');
  ok(!/demo=1/.test(page.url()), 'closing the demo cleans the URL');

  eq(s.problems, [], 'no console errors or page errors');
  eq(s.foreign, [], 'zero requests to any other origin');
  ok(s.requests.length >= 12, `the page made its own asset requests (${s.requests.length})`);
  await s.close();
});

// ── 2. links ───────────────────────────────────────────────────────────────────────────
await section('links', 'Payload links: fragment, query, vector, broken', async () => {
  const s = await open();
  const { page } = s;

  // The cross-language vector, exactly as another component would send it.
  await page.goto(server.url + '#w1=' + vector.payload);
  await waitForStory(page);
  eq(await page.locator('.slide.is-active .cover__name').innerText(), vector.stats.chat.name, 'vector link renders the chat name on the cover');
  ok((await page.locator('.head__name').innerText()).includes('Dinner Club'), 'chat name in the header');
  ok((await page.locator('.slide.is-active .cover__label').innerText()).includes('2026 in review'), 'cover says "<label> in review"');
  ok((await page.title()).includes('Dinner Club'), 'document title carries the chat name');

  // A different recap through the fragment.
  const custom = JSON.parse(JSON.stringify(fixtures.emojiName));
  await page.goto(link(custom));
  await page.reload();
  await waitForStory(page);
  eq(await page.locator('.slide.is-active .cover__name').innerText(), custom.chat.name, 'fragment link renders its own chat name');

  // The same recap through the query string. That form puts the recap in the request line,
  // so the page reads it once and moves it behind the #; nothing the site produces uses it.
  const duoPayload = Codec.encode(fixtures.duo);
  const sentBefore = s.requests.filter((u) => u.includes('w1=')).length;
  await page.goto(server.url + '?utm=x&w1=' + duoPayload);
  await waitForStory(page);
  eq(await page.locator('.slide.is-active .cover__name').innerText(), 'me & u', 'query-string link renders the chat name');
  ok(!(await state(page)).ids.includes('awards'), 'a slide without data is skipped (no awards for two people)');
  const moved = await page.evaluate(() => ({ search: location.search, hash: location.hash }));
  eq(moved, { search: '?utm=x', hash: '#w1=' + duoPayload }, 'a ?w1= recap is moved into the #fragment (other parameters stay)');
  await page.reload();
  await waitForStory(page);
  eq(await page.locator('.slide.is-active .cover__name').innerText(), 'me & u', 'the story survives a reload from the fragment');
  eq(s.requests.filter((u) => u.includes('w1=')).length - sentBefore, 1, 'only the first request ever carried the recap; the reload did not');
  await s.context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.evaluate(() => WrappedStory.goTo(WrappedStory.total - 1));
  await page.locator('.slide.is-active [data-action="copy"]').click();
  await page.waitForSelector('.toast.is-on');
  const fromQuery = new URL(await page.evaluate(() => navigator.clipboard.readText()));
  eq([fromQuery.search, fromQuery.hash], ['', '#w1=' + duoPayload], 'Copy link from a ?w1= visit gives the fragment form');
  eq(await page.evaluate(() => { const u = new URL(WrappedStory.link()); return [u.search, u.hash.slice(0, 4)]; }), ['', '#w1='], 'WrappedStory.link() never uses the query string');
  eq(await page.evaluate(() => { const c = document.querySelector('link[rel="canonical"]').href; return [new URL(c).search, new URL(c).hash]; }), ['', ''], 'the canonical URL carries no recap');

  // Pasting another link into the same tab swaps the story.
  await page.evaluate((hash) => { location.hash = hash; }, '#w1=' + Codec.encode(fixtures.tiny));
  await page.waitForFunction((name) => { const el = document.querySelector('.slide.is-active .cover__name'); return el && el.innerText === name; }, fixtures.tiny.chat.name);
  ok(true, 'changing the fragment loads the new recap');

  // Copy link gives back a link that decodes to the same stats.
  await s.context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto(server.url + '#w1=' + vector.payload);
  await page.reload();
  await waitForStory(page);
  await page.evaluate(() => WrappedStory.goTo(WrappedStory.total - 1));
  await page.locator('.slide.is-active [data-action="copy"]').click();
  await page.waitForSelector('.toast.is-on');
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  eq(copied, Config.BASE_URL + '#w1=' + vector.payload, 'Copy link copies the canonical link');
  eq(Codec.decode(Codec.parseLocation(copied).payload), vector.stats, 'the copied link decodes to the same stats');
  ok((await page.locator('.toast').innerText()).includes('Link copied'), 'a toast confirms the copy');

  // Message text is opt-in (DECISIONS D12): a recap handed to the page directly may show
  // its quotes on this device, but a link built from it carries none.
  await page.goto(server.url);
  await page.waitForFunction(() => window.WrappedApp);
  await page.evaluate((stats) => window.WrappedApp.load(stats), vector.stats);
  await waitForStory(page);
  const built = await page.evaluate(() => WrappedStory.link());
  ok(built.startsWith(Config.BASE_URL + '#w1=') && built.length <= Config.MAX_URL_LENGTH, `a built link is canonical and within the budget (${built.length})`);
  const carried = Codec.decode(Codec.parseLocation(built).payload);
  eq(carried.most_reacted.map((m) => m.text), ['', '', ''], 'a link built by the page carries no message text');
  eq(carried.most_reacted.map((m) => m.reactions), vector.stats.most_reacted.map((m) => m.reactions), 'but keeps who and how many tapbacks');
  eq(carried.senders, vector.stats.senders, 'and everything else');
  await page.goto(server.url + '#w1=' + vector.payload);
  await page.reload();
  await waitForStory(page);

  // Closing a recap keeps it one tap away.
  await page.locator('.head__close').click();
  await page.waitForFunction(() => document.documentElement.classList.contains('is-landing'));
  ok(await page.locator('#play-recap').isVisible(), 'after closing a recap the landing page offers to play it again');
  await page.locator('#play-recap').click();
  await waitForStory(page);
  eq(await page.locator('.slide.is-active .cover__name').innerText(), vector.stats.chat.name, '"Play your recap again" restarts it');

  eq(s.problems, [], 'no console errors with valid links');
  eq(s.foreign, [], 'zero foreign requests with valid links');

  // Ids that name things on Object.prototype, and numbers no chat can have. Nothing may
  // print a function's source, "[object Object]" or an exponent: not on a slide, not on the
  // card (whose text is captured by wrapping fillText).
  const spy = await open({ init: () => {
    window.__drawn = [];
    const fillText = CanvasRenderingContext2D.prototype.fillText;
    CanvasRenderingContext2D.prototype.fillText = function (text, ...rest) { window.__drawn.push(String(text)); return fillText.call(this, text, ...rest); };
  } });
  for (const id of ['constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf']) {
    const hostile = JSON.parse(JSON.stringify(vector.stats));
    hostile.personality.id = id;
    hostile.awards.forEach((a) => { a.id = id; });
    hostile.most_reacted[0].kinds = JSON.parse(`{"${id}": 3, "laugh": 2}`);
    hostile.reactions.by_kind = JSON.parse(`{"${id}": 40, "love": 10, "laugh": 5}`);
    hostile.totals.messages = 1e21;
    hostile.senders[0].messages = 1e308;
    hostile.late_night.messages = 1e22;
    await spy.page.goto(link(hostile));
    await spy.page.reload();
    await waitForStory(spy.page);
    const total = (await state(spy.page)).total;
    eq(total, 12, `id "${id}": every slide still builds`);
    const texts = [];
    for (let i = 0; i < total; i++) {
      await showSettled(spy.page, i);
      texts.push(await spy.page.evaluate(() => document.querySelector('.slide.is-active').innerText));
    }
    const drawn = (await spy.page.evaluate(() => window.__drawn)).join('\n');
    const seen = texts.join('\n') + '\n' + drawn;
    ok(!/native code|function\s*\w*\s*\(|\[object|undefined|NaN|Infinity|e\+\d/.test(seen), `id "${id}": nothing inherited or malformed is printed on a slide or the card`);
    await showSettled(spy.page, 3);
    eq(await spy.page.locator('.slide.is-active .persona__emoji').innerText(), '💬', `id "${id}": the personality slide shows the neutral emoji`);
    ok(drawn.includes('💬') && drawn.includes('The Night Owls'), `id "${id}": so does the share card, next to the title`);
    ok(drawn.includes('9,999,999,999') && texts[1].includes('9,999,999,999'), `id "${id}": absurd totals are capped on the slide and on the card`);
    await showSettled(spy.page, 8);
    eq(await spy.page.locator('.slide.is-active .moty__tbs .tb').count(), 5, `id "${id}": an unknown tapback kind becomes a generic badge`);
    eq(await spy.page.locator('.slide.is-active .moty__tbs .tb--emoji').count(), 3, `id "${id}": three of them`);
  }
  eq(await spy.page.evaluate(() => [({}).x, Object.prototype.hasOwnProperty.call(Object.prototype, 'personality')]), [null, false], 'nothing was added to Object.prototype');
  eq(spy.problems, [], 'hostile ids and numbers cause no errors');
  await spy.close();

  // Damaged links fail politely, including ones with nothing decodable in them at all:
  // those used to fall through to the landing page as if no link had been opened.
  for (const bad of ['#w1=AAAA', '#w1=not*a*payload', '?w1=' + vector.payload.slice(0, 300), '#w1=' + Codec.encode({ nothing: 'here' }), '#w1=!!!', '#w1=', '?w1=***', '?demo=1#w1=!!!']) {
    const before = s.problems.length;
    await page.goto(server.url + bad);
    await page.reload();
    await page.waitForSelector('.story-error', { timeout: 5000 });
    ok((await page.locator('.story-error h2').innerText()).length > 0, `damaged link shows an error card (${bad.slice(0, 18)}…)`);
    ok(await page.locator('.story-error a[href="?demo=1"]').isVisible(), 'the error card offers the demo');
    ok(await page.locator('.landing').isHidden(), `a damaged link does not show the landing page (${bad.slice(0, 12)})`);
    ok(!(await page.evaluate(() => WrappedStory.isActive())), 'and does not start a story');
    eq(s.problems.slice(before), [], 'a damaged link does not throw');
  }
  // The error card's way out works.
  await page.locator('.story-error a[href="./"]').click();
  await page.waitForFunction(() => document.documentElement.classList.contains('is-landing'));
  ok(await page.locator('.landing').isVisible(), 'the error card leads back to the landing page');
  await s.close();
});

// ── 3. share card ──────────────────────────────────────────────────────────────────────
await section('share', 'Share card: 1080×1350 PNG, download fallback, Web Share', async () => {
  const s = await open();
  const { page } = s;
  await page.goto(server.url + '?demo=1');
  await waitForStory(page);

  const direct = await page.evaluate(async () => {
    const stats = WrappedData.normalize(WRAPPED_DEMO);
    const blob = await WrappedCard.toBlob(stats);
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const canvas = WrappedCard.render(stats);
    return { type: blob.type, bytes: Array.from(bytes), canvas: [canvas.width, canvas.height], dataUrl: WrappedCard.toDataURL(stats).slice(0, 22) };
  });
  const png = Buffer.from(direct.bytes);
  eq(pngSize(png), { width: 1080, height: 1350 }, 'WrappedCard.toBlob() is a 1080×1350 PNG');
  eq(direct.type, 'image/png', 'card blob type');
  eq(direct.canvas, [1080, 1350], 'WrappedCard.render() canvas is 1080×1350');
  eq(direct.dataUrl, 'data:image/png;base64,', 'WrappedCard.toDataURL() is a PNG data URL');
  ok(png.length > 40000, `the card is not blank (${png.length} bytes)`);
  fs.mkdirSync(SHOTS, { recursive: true });
  fs.writeFileSync(path.join(SHOTS, 'share-card.png'), png);

  // The card on the last slide is the same canvas size.
  await showSettled(page, 11);
  eq(await page.evaluate(() => { const c = document.querySelector('.slide.is-active .sum__card canvas'); return [c.width, c.height]; }), [1080, 1350], 'the preview on the last slide is the real card');

  // No message text on the card: the slide may quote, the card may not. (Canvas text
  // cannot be read back, so check the inputs the renderer touches instead.)
  const cardSource = fs.readFileSync(path.join(WEB, 'js/card.js'), 'utf8');
  ok(!/most_reacted|\.text\b/.test(cardSource.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '').replace(/ctx\.(fillText|measureText|textAlign|textBaseline)/g, '')), 'card.js never reads message text');

  // Without Web Share (desktop Chromium) the button downloads the PNG.
  await page.evaluate(() => WrappedStory.resume());
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 8000 }),
    page.locator('.slide.is-active [data-action="share"]').click(),
  ]);
  const file = path.join(ROOT, 'test-results', 'share-download.png');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  await download.saveAs(file);
  eq(pngSize(fs.readFileSync(file)), { width: 1080, height: 1350 }, '"Share card" falls back to downloading a 1080×1350 PNG');
  ok(/^threadback-dinner-club-2026\.png$/.test(download.suggestedFilename()), `download has a sensible name (${download.suggestedFilename()})`);
  eq(s.problems, [], 'no console errors while sharing');
  eq(s.foreign, [], 'sharing makes no foreign requests');
  await s.close();

  // With Web Share available the PNG goes to navigator.share as a file.
  const w = await open({ init: () => {
    window.__shares = [];
    navigator.canShare = (data) => !!(data && data.files && data.files.length);
    navigator.share = (data) => {
      const f = data.files && data.files[0];
      window.__shares.push({ name: f && f.name, type: f && f.type, size: f && f.size, text: data.text, title: data.title, hasUrl: 'url' in data });
      return Promise.resolve();
    };
  } });
  await w.page.goto(server.url + '?demo=1');
  await waitForStory(w.page);
  await w.page.evaluate(() => WrappedStory.goTo(WrappedStory.total - 1));
  await w.page.waitForTimeout(300);
  await w.page.locator('.slide.is-active [data-action="share"]').click();
  await w.page.waitForFunction(() => window.__shares.length === 1);
  const shared = (await w.page.evaluate(() => window.__shares))[0];
  eq([shared.name, shared.type], ['threadback-dinner-club-2026.png', 'image/png'], 'Web Share receives the PNG file');
  ok(shared.size > 40000, 'the shared file has content');
  ok(/Dinner Club/.test(shared.text) && /2026 in review/.test(shared.text), `share text names the chat (${shared.text})`);
  eq(w.problems, [], 'no console errors with Web Share');
  await w.close();
});

// ── 4. embed mode ──────────────────────────────────────────────────────────────────────
const stubBridge = () => {
  window.__bridge = [];
  window.webkit = { messageHandlers: { wrapped: { postMessage: (m) => { window.__bridge.push(JSON.parse(JSON.stringify(m))); } } } };
};

await section('embed', 'Embed mode (?embed=ios) talks to the native bridge', async () => {
  const s = await open({ init: stubBridge });
  const { page } = s;
  const messages = () => page.evaluate(() => window.__bridge);
  await page.goto(link(vector.stats, '?embed=ios'));
  await waitForStory(page);

  let m = await messages();
  eq(m[0], { type: 'ready', slides: 12 }, 'first message is ready with the slide count');
  eq(m[1], { type: 'slide', index: 0, total: 12 }, 'then the first slide');
  ok(await page.locator('.landing').isHidden(), 'no landing chrome in embed mode');
  ok(await page.evaluate(() => document.documentElement.classList.contains('is-embed')), 'the document is marked as embedded');
  eq((await state(page)).index, 0, 'the story starts immediately');

  // Native drives it.
  await page.evaluate(() => WrappedStory.pause());
  ok((await state(page)).paused, 'WrappedStory.pause() pauses');
  const t1 = (await state(page)).time;
  await wait(page, 300);
  ok(Math.abs((await state(page)).time - t1) < 5, 'time does not advance while paused by native');
  await page.evaluate(() => WrappedStory.resume());
  ok(!(await state(page)).paused, 'WrappedStory.resume() resumes');
  await page.evaluate(() => WrappedStory.goTo(3));
  m = await messages();
  eq(m[m.length - 1], { type: 'slide', index: 3, total: 12 }, 'WrappedStory.goTo(3) reports the slide change');

  // A tap reports the new slide and asks for a light haptic.
  const box = await page.locator('.stage').boundingBox();
  const before = (await messages()).length;
  await page.touchscreen.tap(box.x + box.width * 0.8, box.y + box.height * 0.5);
  await wait(page, 150);
  m = (await messages()).slice(before);
  ok(m.some((x) => x.type === 'slide' && x.index === 4 && x.total === 12), 'tapping posts the slide change');
  ok(m.some((x) => x.type === 'haptic' && x.style === 'light'), 'tapping asks for a light haptic');

  // A reveal asks for a stronger one (personality is slide 4).
  await page.evaluate(() => { WrappedStory.goTo(3); });
  await page.waitForFunction(() => window.__bridge.some((x) => x.type === 'haptic' && x.style === 'medium'), null, { timeout: 6000 });
  ok(true, 'the personality reveal asks for a medium haptic');

  // Last slide: native action first, web-only actions gone.
  await page.evaluate(() => WrappedStory.goTo(11));
  await wait(page, 1300);
  ok(await page.locator('.slide.is-active [data-action="send"]').isVisible(), '"Send to this chat" is on the last slide');
  ok((await page.locator('.slide.is-active [data-action="send"]').innerText()).includes('Send to this chat'), 'primary action label');
  eq(await page.locator('.slide.is-active [data-action="copy"]').count(), 0, 'Copy link is not offered inside the app');
  eq(await page.locator('.slide.is-active .sum__make').count(), 0, 'the "make your own" link is not offered inside the app');
  eq(await page.locator('.slide.is-active .sum__actions .btn').first().getAttribute('data-action'), 'send', 'Send is the first (primary) action');
  ok((await messages()).some((x) => x.type === 'haptic' && x.style === 'success'), 'reaching the summary asks for a success haptic');

  await page.locator('.slide.is-active [data-action="send"]').click();
  m = await messages();
  ok(m.some((x) => x.type === 'send'), 'Send to this chat posts {type: "send"}');
  eq(Object.keys(m.find((x) => x.type === 'send')), ['type'], 'the send message carries nothing else');

  await page.locator('.slide.is-active [data-action="share"]').click();
  await page.waitForFunction(() => window.__bridge.some((x) => x.type === 'share'));
  const share = (await messages()).find((x) => x.type === 'share');
  ok(share.png.startsWith('data:image/png;base64,'), 'share posts the card as a PNG data URL');
  eq(pngSize(Buffer.from(share.png.split(',')[1], 'base64')), { width: 1080, height: 1350 }, 'the shared card is 1080×1350');
  ok(typeof share.text === 'string' && share.text.includes('Dinner Club'), 'share carries a text line');

  await page.locator('.head__close').click();
  m = await messages();
  eq(m[m.length - 1], { type: 'close' }, 'the close button posts {type: "close"}');
  ok(await page.locator('.landing').isHidden(), 'closing inside the app does not reveal the landing page');

  const types = new Set((await messages()).map((x) => x.type));
  ok([...types].every((t) => ['ready', 'slide', 'haptic', 'share', 'send', 'close'].includes(t)), `only contract message types were sent (${[...types].join(', ')})`);
  eq(s.problems, [], 'no console errors in embed mode');
  eq(s.foreign, [], 'zero foreign requests in embed mode');

  // Native can also hand the recap over directly, with no payload in the URL.
  await page.goto(server.url + '?embed=ios');
  await page.waitForFunction(() => window.WrappedApp);
  ok(!(await page.evaluate(() => WrappedStory.isActive())), 'embed without a payload waits quietly');
  ok(await page.locator('.landing').isHidden(), 'and still shows no landing page');
  await page.evaluate((stats) => WrappedApp.load(stats), fixtures.duo);
  await waitForStory(page);
  eq(await page.locator('.slide.is-active .cover__name').innerText(), 'me & u', 'WrappedApp.load(stats) plays a recap handed over by native');
  eq((await messages())[0].type, 'ready', 'and announces ready');

  // A damaged payload inside the app reports an error instead of a blank screen.
  await page.goto(server.url + '?embed=ios#w1=AAAA');
  await page.waitForSelector('.story-error');
  ok((await messages()).some((x) => x.type === 'error'), 'a damaged payload posts {type: "error"}');
  eq(await page.locator('.story-error a').count(), 0, 'the in-app error card has no web links');
  await s.close();

  // An ?embed= link opened in an ordinary browser (no native bridge): the plain web story.
  // It used to trap the viewer: Close and Esc froze it, and Send claimed to have sent.
  const lost = await open();
  await lost.page.goto(link(vector.stats, '?embed=ios'));
  await waitForStory(lost.page);
  eq(await lost.page.evaluate(() => [document.documentElement.classList.contains('is-embed'), document.querySelector('.story').classList.contains('is-embed'), WrappedBridge.isEnabled()]), [false, false, false], 'without a native bridge ?embed=ios is not embed mode');
  await lost.page.evaluate(() => WrappedStory.goTo(WrappedStory.total - 1));
  eq(await lost.page.locator('.slide.is-active [data-action="send"]').count(), 0, 'no "Send to this chat" without a native bridge');
  ok(await lost.page.locator('.slide.is-active [data-action="copy"]').isVisible(), 'the web actions are there instead');
  await lost.page.keyboard.press('Escape');
  await lost.page.waitForFunction(() => document.documentElement.classList.contains('is-landing'));
  ok(await lost.page.locator('.landing').isVisible(), 'Esc leaves the story for the landing page');
  await lost.page.locator('#play-recap').click();
  await waitForStory(lost.page);
  ok(!(await state(lost.page)).paused, 'the recap can be played again and is not frozen');
  await lost.page.locator('.head__close').click();
  await lost.page.waitForFunction(() => document.documentElement.classList.contains('is-landing'));
  ok(await lost.page.locator('.landing').isVisible(), 'the close button leaves the story too');
  eq(await lost.page.locator('.toast.is-on').count(), 0, 'nothing claims to have been added to a message');
  await lost.page.goto(server.url + '?embed=ios');
  await lost.page.waitForFunction(() => document.documentElement.classList.contains('is-ready'));
  ok(await lost.page.locator('.landing').isVisible(), '?embed=ios with no recap and no bridge shows the landing page, not a blank screen');
  await lost.page.goto(server.url + '?embed=ios#w1=!!!');
  await lost.page.reload();
  await lost.page.waitForSelector('.story-error');
  ok(await lost.page.locator('.story-error a[href="./"]').isVisible(), 'a damaged ?embed= link in a browser gets the web error card with its way out');
  eq(lost.problems, [], 'no console errors for ?embed= in a plain browser');
  await lost.close();

  // Outside the shell nothing is posted even if a handler happens to exist.
  const plain = await open({ init: stubBridge });
  await plain.page.goto(server.url + '?demo=1');
  await waitForStory(plain.page);
  await plain.page.evaluate(() => WrappedStory.goTo(2));
  eq(await plain.page.evaluate(() => window.__bridge), [], 'without ?embed the bridge stays silent');
  ok(await plain.page.locator('.slide [data-action="send"]').count() === 0, 'no "Send to this chat" on the web');
  await plain.close();
});

// ── 5. file:// with the CSP (how the iOS shell loads it) ───────────────────────────────
await section('file', 'Runs from file:// under the page CSP', async () => {
  const s = await open({ init: stubBridge, fileOrigin: true });
  const { page } = s;
  const base = 'file://' + path.join(WEB, 'index.html');
  await page.goto(base + '?embed=ios#w1=' + vector.payload);
  await waitForStory(page);
  eq((await state(page)).ids, ALL_SLIDES, 'all twelve slides build from file://');
  eq((await page.evaluate(() => window.__bridge))[0], { type: 'ready', slides: 12 }, 'bridge works from file://');
  ok(await page.evaluate(() => document.fonts.check('900 40px Archivo')), 'the bundled font loads from file://');
  const csp = await page.evaluate(() => document.querySelector('meta[http-equiv="Content-Security-Policy"]').content);
  ok(/default-src 'none'/.test(csp) && /script-src 'self'/.test(csp) && /connect-src 'none'/.test(csp), 'the CSP meta tag is present');
  for (let i = 0; i < 12; i++) await showSettled(page, i);
  const tail = await page.evaluate(() => getComputedStyle(document.querySelector('.slide.is-active .btn--send')).backgroundColor);
  eq(tail, 'rgb(10, 132, 255)', 'stylesheets apply under file:// (send button is blue)');
  const share = await page.evaluate(() => { document.querySelector('.slide.is-active [data-action="share"]').click(); return window.__bridge.find((x) => x.type === 'share'); });
  ok(share && share.png.length > 50000, 'the card renders and exports from file://');
  eq(s.problems, [], 'no console errors or CSP violations from file://');
  eq(s.foreign, [], 'every request from file:// stays on file://');
  ok(s.requests.every((u) => !/^https?:/.test(u)), 'no http(s) request at all from file://');

  // The plain (non-embed) page works from file:// too.
  await page.goto(base + '?demo=1');
  await waitForStory(page);
  eq((await state(page)).total, 12, 'the demo plays from file://');
  await page.goto(base);
  await page.waitForFunction(() => document.documentElement.classList.contains('is-ready'));
  ok(await page.locator('.landing').isVisible(), 'the landing page renders from file://');
  eq(s.problems, [], 'still no console errors');
  await s.close();

  // The CSP really bites: an injected inline script and a fetch are both refused.
  const c = await open();
  await c.page.goto(server.url + '?demo=1');
  await waitForStory(c.page);
  const blocked = await c.page.evaluate(async () => {
    const tag = document.createElement('script');
    tag.textContent = 'window.__inline = true';
    document.head.appendChild(tag);
    let fetched = 'blocked';
    try { await fetch('https://example.com/'); fetched = 'allowed'; } catch (e) { fetched = 'blocked'; }
    const img = document.createElement('div');
    img.setAttribute('style', 'color: rgb(1, 2, 3)');
    document.body.appendChild(img);
    return { inline: !!window.__inline, fetched, styleAttr: getComputedStyle(img).color };
  });
  eq(blocked.inline, false, 'CSP blocks inline scripts');
  eq(blocked.fetched, 'blocked', 'CSP blocks fetch()');
  ok(blocked.styleAttr !== 'rgb(1, 2, 3)', 'CSP blocks inline style attributes');
  eq(c.foreign, [], 'the blocked fetch never left the browser');
  await c.close();
});

// ── 6. robustness matrix ───────────────────────────────────────────────────────────────
await section('matrix', `Robustness: ${Object.keys(fixtures).length} recaps × ${Object.keys(viewports).length} viewports (+2 with a wide system font), nothing overflows`, async () => {
  let slides = 0;
  const runs = Object.entries(viewports).map(([name, vp]) => [name, vp, false]);
  // The two tightest phones again with a much wider body font than the one we design with.
  runs.push(['se-320x568 wide-font', viewports['se-320x568'], true], ['phone-390x844 wide-font', viewports['phone-390x844'], true]);
  for (const [vpName, vp, wideFont] of runs) {
    const s = await open({ viewport: vp, wideFont });
    const { page } = s;
    for (const [name, stats] of Object.entries(fixtures)) {
      await page.goto(link(stats));
      await page.reload();
      await waitForStory(page);
      const st = await state(page);
      const normal = Data.normalize(stats);
      eq(await page.locator('.slide.is-active .cover__name').innerText(), normal.chat.name, `[${vpName}] ${name}: cover shows the chat name`);
      if (wideFont && name === 'demo') {
        const family = await page.evaluate(() => getComputedStyle(document.querySelector('.total__facts .bubble')).fontFamily);
        ok(/^"?DejaVu Sans/.test(family), `[${vpName}] the wide font override is in effect (${family})`);
      }
      for (let i = 0; i < st.total; i++) {
        await showSettled(page, i);
        const issues = await findOverflow(page);
        slides++;
        ok(issues.length === 0, `[${vpName}] ${name} / ${st.ids[i]}: ${issues.join(' | ')}`);
      }
      // Design rules from the review, checked wherever the data can break them.
      if (st.ids.includes('late')) {
        await showSettled(page, st.ids.indexOf('late'));
        // Layout boxes, not painted ones: the moon is rotated, and a line of display type
        // is taller than its ink. The rule: the number starts below the moon, and whatever
        // shares the moon's height stays to its left.
        const clash = await page.evaluate(() => {
          const slide = document.querySelector('.slide.is-active');
          const body = slide.querySelector('.slide__body');
          const moon = slide.querySelector('.late__moon');
          const moonBox = { l: moon.offsetLeft, t: moon.offsetTop, r: moon.offsetLeft + moon.offsetWidth, b: moon.offsetTop + moon.offsetHeight };
          const origin = body.getBoundingClientRect();
          const hits = [];
          const num = slide.querySelector('.late__num');
          if (num.offsetTop < moonBox.b - 0.5) hits.push('number starts ' + Math.round(moonBox.b - num.offsetTop) + 'px above the bottom of the moon');
          for (const el of slide.querySelectorAll('.kicker > span, .late__cap, .meter__label, .late__top, .late__also')) {
            const range = document.createRange();
            range.selectNodeContents(el);
            const r = range.getBoundingClientRect();
            const t = { l: r.left - origin.left, t: r.top - origin.top, r: r.right - origin.left, b: r.bottom - origin.top };
            if (t.l < moonBox.r && t.r > moonBox.l && t.t < moonBox.b && t.b > moonBox.t) hits.push('"' + el.textContent.trim().slice(0, 20) + '" overlaps the moon');
          }
          return hits;
        });
        eq(clash, [], `[${vpName}] ${name} / late: nothing runs into the moon`);
      }
      if (name === 'rtl' && st.ids.includes('moty')) {
        const dirs = await page.evaluate(() => ({
          head: getComputedStyle(document.querySelector('.head__name')).direction,
          headOverflow: getComputedStyle(document.querySelector('.head__name')).textOverflow,
          align: getComputedStyle(document.querySelector('.head__name')).textAlign,
        }));
        eq(dirs, { head: 'rtl', headOverflow: 'ellipsis', align: 'left' }, `[${vpName}] rtl: the chat name in the header is truncated at its logical end`);
        await showSettled(page, st.ids.indexOf('senders'));
        const who = await page.evaluate(() => [...document.querySelectorAll('.slide.is-active .rank__who')].map((el) => [getComputedStyle(el).direction, el.getAttribute('dir'), getComputedStyle(el).unicodeBidi, el.scrollWidth > el.clientWidth]));
        ok(who.length === 4 && who.every((w) => w[1] === 'auto' && w[2] === 'isolate'), `[${vpName}] rtl: sender names are direction-isolated`);
        ok(who.filter((w) => w[3]).every((w) => w[0] === 'rtl'), `[${vpName}] rtl: every truncated right-to-left name is cut at its end (${JSON.stringify(who)})`);
        await showSettled(page, st.ids.indexOf('moty'));
        const runners = await page.evaluate(() => [...document.querySelectorAll('.slide.is-active .moty__runner p')].map((p) => {
          const name = p.querySelector('b'); const facts = p.querySelector('span');
          const pr = p.getBoundingClientRect(); const fr = facts.getBoundingClientRect();
          return { facts: facts.textContent, shown: fr.right <= pr.right + 0.5 && fr.left >= pr.left - 0.5 && facts.scrollWidth <= facts.clientWidth + 1, nameCut: name.scrollWidth > name.clientWidth };
        }));
        eq(runners.length, 2, `[${vpName}] rtl: two runners-up`);
        ok(runners.every((r) => r.shown && /tapbacks?$/.test(r.facts)), `[${vpName}] rtl: a long runner-up name never hides the tapback count (${JSON.stringify(runners)})`);
        ok(runners.some((r) => r.nameCut) || vp.width > 600, `[${vpName}] rtl: the long name is the part that gives way`);
        ok(runners[1].facts.includes('1,234 tapbacks'), `[${vpName}] rtl: the count is shown in full`);
      }
      if (name === 'astronomical') {
        const texts = [];
        for (let i = 0; i < st.total; i++) {
          await showSettled(page, i);
          texts.push(await page.evaluate(() => document.querySelector('.slide.is-active').innerText));
        }
        const all = texts.join('\n');
        ok(!/e\+|NaN|Infinity|undefined/.test(all), `[${vpName}] astronomical: no exponent or NaN on any slide`);
        ok(all.includes('9,999,999,999'), `[${vpName}] astronomical: absurd counts are capped at 9,999,999,999`);
      }
      // The card must cope with the same data.
      const size = await page.evaluate(() => { const c = document.querySelector('.sum__card canvas'); return [c.width, c.height]; });
      eq(size, [1080, 1350], `[${vpName}] ${name}: card canvas size`);
    }
    eq(s.problems, [], `[${vpName}] no console errors across every recap`);
    eq(s.foreign, [], `[${vpName}] zero foreign requests`);
    await s.close();
  }
  console.log(`  checked ${slides} slides`);

  // Which slides each sparse recap keeps.
  const s = await open();
  const idsFor = async (stats) => { await s.page.goto(link(stats)); await s.page.reload(); await waitForStory(s.page); return (await state(s.page)).ids; };
  eq(await idsFor(fixtures.bare), ['cover', 'total', 'sum'], 'a bare recap keeps only cover, total and summary');
  eq(await idsFor(fixtures.sparse), ['cover', 'total', 'clock', 'persona', 'late', 'week', 'year', 'senders', 'sum'], 'missing optional sections drop their slides');
  eq(await idsFor(fixtures.legacy), ['cover', 'total', 'clock', 'persona', 'late', 'week', 'year', 'senders', 'moty', 'sum'], 'the legacy shape plays (with a derived personality)');
  eq(await idsFor(fixtures.noQuotes), ALL_SLIDES, 'a "no quotes" recap keeps every slide');

  // No message text (the default now): who wrote it, when, and the tapbacks. No empty bubble.
  await showSettled(s.page, 8);
  eq(await s.page.locator('.slide.is-active .moty__text').count(), 0, 'no quotes: the hero bubble has no message text');
  ok(await s.page.locator('.slide.is-active .moty__bubble .moty__tally').isVisible(), 'no quotes: the hero bubble shows tapback counts instead');
  eq(await s.page.locator('.slide.is-active .moty__bubble .moty__tally--badges .tb').count(), 3, 'no quotes: one badge per tapback kind');
  eq(await s.page.locator('.slide.is-active .moty__bubble .moty__tally--badges b').allInnerTexts(), ['×4', '×1', '×1'], 'no quotes: each badge carries its count');
  const quietFrom = await s.page.locator('.slide.is-active .moty__from').innerText();
  ok(quietFrom.includes(fixtures.noQuotes.most_reacted[0].sender) && quietFrom.includes('March 14'), `no quotes: sender and date are shown (${quietFrom.replace(/\s+/g, ' ')})`);
  const quietReceipt = await s.page.locator('.slide.is-active .moty__receipt').innerText();
  ok(quietReceipt.includes('6 tapbacks') && quietReceipt.includes('the words stayed in the chat'), 'no quotes: the tapback total is shown and the absence is explained');
  const quietBox = await s.page.locator('.slide.is-active .moty__bubble').boundingBox();
  ok(quietBox.height > 50 && quietBox.width > 150, 'no quotes: the bubble is not an empty shell');
  eq(await s.page.locator('.slide.is-active .moty__runner .moty__tally').count(), 2, 'no quotes: runners-up show their tapbacks too');
  // A mid-flight frame: the badges land one by one.
  await s.page.evaluate(() => { WrappedStory.goTo(8); WrappedStory.seek(1900); });
  const landedNow = await s.page.evaluate(() => [...document.querySelectorAll('.slide.is-active .moty__tally--badges > span')].map((el) => Number(getComputedStyle(el).opacity) > 0.5));
  eq(landedNow, [true, false, false], 'no quotes: tapback badges land one at a time');
  await s.page.evaluate(() => WrappedStory.resume());

  // People who are not in the owner's contacts arrive masked; they render like anyone else.
  await idsFor(fixtures.masked);
  eq(await s.page.locator('.head__badge').innerText(), '#', 'masked: a chat named after a masked number gets a neutral badge');
  await showSettled(s.page, 7);
  eq(await s.page.locator('.slide.is-active .rank__name').innerText(), '…0001', 'masked: "…0001" is shown as the top sender');
  ok((await s.page.locator('.slide.is-active .rank').innerText()).includes('jo.smith'), 'masked: an e-mail local part is shown as a name');
  await showSettled(s.page, 4);
  ok((await s.page.locator('.slide.is-active .late__top').innerText()).includes('kept the lights on'), 'masked: the late-night slide renders');
  await idsFor(fixtures.noQuotes);
  await showSettled(s.page, 10);
  eq(await s.page.locator('.slide.is-active .award__detail').count(), 0, 'awards without detail render without the detail line');
  eq(await s.page.locator('.slide.is-active .award').count(), 6, 'all six awards still render');
  eq(await s.page.locator('.slide.is-active .awards__ai').count(), 0, 'rule-based awards carry no AI note');
  await idsFor(fixtures.dozen);
  await showSettled(s.page, 10);
  ok((await s.page.locator('.slide.is-active .awards__ai').innerText()).includes('written by AI'), 'AI-written awards are labelled');

  // Reduced motion: no count-up, entrances fade.
  const calm = await open({ reducedMotion: 'reduce' });
  await calm.page.goto(server.url + '?demo=1');
  await waitForStory(calm.page);
  await calm.page.evaluate(() => WrappedStory.goTo(1));
  await calm.page.waitForTimeout(450);
  eq(await calm.page.locator('.slide.is-active .total__num').innerText(), '48,213', 'reduced motion: numbers do not count up');
  const anim = await calm.page.evaluate(() => getComputedStyle(document.querySelector('.slide.is-active .total__unit')).animationName);
  eq(anim, 'a-fade', 'reduced motion: entrances are plain fades');
  // Nothing advances on its own; the progress bar is a row of static segments.
  await calm.page.evaluate(() => WrappedStory.goTo(0));
  const segsAt = () => calm.page.evaluate(() => [...document.querySelectorAll('.seg > b')].slice(0, 3).map((b) => b.style.transform));
  eq(await segsAt(), ['scaleX(1)', 'scaleX(0)', 'scaleX(0)'], 'reduced motion: the current segment is simply filled');
  eq(await calm.page.locator('.slide.is-active .cover__hint').innerText(), 'Tap to continue', 'reduced motion: the hint says what to do');
  await calm.page.waitForTimeout(6600); // the cover would auto-advance after 5.2 s
  eq((await state(calm.page)).index, 0, 'reduced motion: the story does not auto-advance');
  eq(await segsAt(), ['scaleX(1)', 'scaleX(0)', 'scaleX(0)'], 'reduced motion: the segments did not move while waiting');
  ok(await calm.page.locator('.head__pause').isHidden(), 'reduced motion: there is nothing to pause, so no pause button');
  const calmBox = await calm.page.locator('.stage').boundingBox();
  await calm.page.touchscreen.tap(calmBox.x + calmBox.width * 0.8, calmBox.y + calmBox.height * 0.5);
  eq((await state(calm.page)).index, 1, 'reduced motion: a tap moves on');
  eq(await segsAt(), ['scaleX(1)', 'scaleX(1)', 'scaleX(0)'], 'reduced motion: and fills the next segment');
  await calm.page.keyboard.press('ArrowRight');
  eq((await state(calm.page)).index, 2, 'reduced motion: so does the keyboard');
  // Switching the setting off while the story is open hands the clock back.
  await calm.page.emulateMedia({ reducedMotion: 'no-preference' });
  await calm.page.waitForFunction(() => !document.querySelector('.story').classList.contains('is-calm'));
  ok(await calm.page.locator('.head__pause').isVisible(), 'turning reduce-motion off brings the pause button back');
  await calm.page.waitForFunction(() => WrappedStory.index === 3, null, { timeout: 12000 });
  ok(true, 'and auto-advance resumes');
  eq(calm.problems, [], 'reduced motion: no console errors');
  await calm.close();
  await s.close();
});

// ── 7. landing page ────────────────────────────────────────────────────────────────────
await section('landing', 'Landing page', async () => {
  for (const [vpName, vp] of [['phone-390x844', viewports['phone-390x844']], ['se-320x568', viewports['se-320x568']], ['desktop-1440x900', viewports['desktop-1440x900']]]) {
    const s = await open({ viewport: vp });
    const { page } = s;
    await page.goto(server.url);
    await page.waitForFunction(() => document.documentElement.classList.contains('is-ready'));
    await page.evaluate(() => Promise.all([document.fonts.ready, WrappedCard.ready()]));
    await page.waitForTimeout(500);
    ok(await page.locator('.landing').isVisible(), `[${vpName}] landing page is visible without a payload`);
    ok(await page.locator('#story').isHidden(), `[${vpName}] no story without a payload`);
    eq(await page.locator('.l-brand__name').innerText(), Config.PRODUCT_NAME, `[${vpName}] brand comes from the config constant`);
    eq(await page.locator('#play-demo').getAttribute('href'), '?demo=1', `[${vpName}] "Play the demo" links to ?demo=1`);
    ok(await page.locator('a[href="make/"]').first().isVisible() || vp.width <= 420, `[${vpName}] "Make your own" links to make/`);
    ok((await page.locator('.l-cta a[href="make/"]').innerText()).includes('Make your own'), `[${vpName}] make link label`);
    const text = await visibleText(page);
    ok(/never send that part/i.test(text) && /no server/i.test(text) && /on your own device/i.test(text), `[${vpName}] explains the privacy model`);
    const scrollW = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
    ok(scrollW[0] <= scrollW[1] + 1, `[${vpName}] no horizontal scrolling (${scrollW.join(' vs ')})`);
    const heroPixels = await page.evaluate(() => { const c = document.getElementById('hero-card'); const d = c.getContext('2d').getImageData(540, 700, 1, 1).data; return d[3]; });
    ok(heroPixels === 255, `[${vpName}] the hero card is drawn`);
    if (vpName !== 'se-320x568') {
      fs.mkdirSync(SHOTS, { recursive: true });
      // Freeze the floating hero pieces so the committed screenshot does not change run to run.
      await page.evaluate(() => { document.getAnimations().forEach((a) => { a.pause(); a.currentTime = 0; }); });
      await page.screenshot({ path: path.join(SHOTS, vpName.startsWith('desktop') ? 'landing-desktop.png' : 'landing-mobile.png'), fullPage: true });
    }
    // "Play the demo" starts the story in place, and Back returns.
    await page.locator('#play-demo').click();
    await waitForStory(page);
    ok(/demo=1/.test(page.url()), `[${vpName}] playing the demo updates the URL`);
    eq((await state(page)).total, 12, `[${vpName}] demo starts from the landing page`);
    await page.goBack();
    await page.waitForFunction(() => document.documentElement.classList.contains('is-landing'));
    ok(await page.locator('.landing').isVisible(), `[${vpName}] Back returns to the landing page`);
    eq(s.problems, [], `[${vpName}] no console errors on the landing page`);
    eq(s.foreign, [], `[${vpName}] zero foreign requests on the landing page`);
    await s.close();
  }
});

// ── 8. naming (docs/SCHEMA.md §7) ──────────────────────────────────────────────────────
await section('brand', 'Copy: product name comes from one constant; no borrowed trademarks', async () => {
  const s = await open({ init: stubBridge });
  const { page } = s;
  const texts = [];
  await page.goto(server.url);
  await page.waitForFunction(() => document.documentElement.classList.contains('is-ready'));
  const landingText = await visibleText(page);
  texts.push(landingText);
  for (const url of [server.url + '?demo=1', link(fixtures.legacy), link(fixtures.noQuotes, '?embed=ios'), link(fixtures.zeroNight)]) {
    await page.goto(url);
    await page.reload();
    await waitForStory(page);
    const total = (await state(page)).total;
    for (let i = 0; i < total; i++) {
      await showSettled(page, i);
      texts.push(await page.evaluate(() => document.querySelector('.stage').innerText + ' ' + [...document.querySelectorAll('.stage [aria-label]')].map((e) => e.getAttribute('aria-label')).join(' ') + ' ' + document.title));
    }
  }
  const all = texts.join('\n');
  ok(!/wrapped/i.test(all), 'no user-visible copy says "Wrapped"');
  const imessage = all.match(/[^.\n]*imessage[^.\n]*/gi) || [];
  ok(imessage.every((line) => /works with imessage|trademark of apple/i.test(line)), `"iMessage" appears only as a compatibility note (${JSON.stringify(imessage)})`);
  ok(landingText.includes(Config.PRODUCT_NAME), 'the landing page shows the product name');
  ok(landingText.toLowerCase().includes(Config.DESCRIPTOR), 'the landing page shows the descriptor');
  ok(/2026 in review/.test(all), 'story copy uses "<label> in review"');
  ok(!/spotify/i.test(all), 'no other company names in the copy');
  await s.close();
});

// ── 9. screenshots (committed: invented data) ──────────────────────────────────────────
await section('shots', `Screenshots of every slide → ${path.relative(ROOT, SHOTS)}/`, async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const s = await open({ scale: 2 });
  const { page } = s;
  await page.goto(server.url + '?demo=1');
  await waitForStory(page);
  const ids = (await state(page)).ids;
  const files = [];
  for (let i = 0; i < ids.length; i++) {
    await showSettled(page, i);
    const file = path.join(SHOTS, `${String(i + 1).padStart(2, '0')}-${ids[i]}.png`);
    await page.screenshot({ path: file });
    files.push(file);
    eq(pngSize(fs.readFileSync(file)), { width: 780, height: 1688 }, `${path.basename(file)} is 780×1688 (390×844 @2x)`);
  }
  eq(files.length, 12, 'twelve slide screenshots');

  // Suspense frames: the typing indicator before the cover and the personality reveal.
  for (const [i, ms, name] of [[0, 900, 'typing-cover'], [3, 1500, 'typing-personality']]) {
    await page.evaluate(([index, t]) => { WrappedStory.goTo(index); WrappedStory.seek(t); return new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))); }, [i, ms]);
    await page.screenshot({ path: path.join(SHOTS, `moment-${name}.png`) });
    ok(await page.locator('.slide.is-active .typing').first().isVisible(), `${name}: the typing indicator is on screen at ${ms} ms`);
  }
  await page.evaluate(() => WrappedStory.resume());
  eq(s.problems, [], 'no console errors while taking screenshots');
  await s.close();

  // Embed mode, last slide.
  const e = await open({ scale: 2, init: stubBridge });
  await e.page.goto(link(vector.stats, '?embed=ios'));
  await waitForStory(e.page);
  await showSettled(e.page, 11);
  await e.page.screenshot({ path: path.join(SHOTS, 'embed-12-sum.png') });
  await e.close();

  // Desktop: the phone-sized stage on its backdrop.
  // 1440 × 760 makes the framed stage exactly 392 × 700, one design pixel per CSS pixel.
  // At fractional scales (1.2 on a 900-high window) Chromium anti-aliases a few edge
  // pixels of the header badge differently from run to run, which made this committed
  // screenshot change by a handful of pixels for no reason.
  const d = await open({ viewport: { width: 1440, height: 760 } });
  await d.page.goto(server.url + '?demo=1');
  await waitForStory(d.page);
  await showSettled(d.page, 3); // (showSettled switches the colour transitions off, so the backdrop is already there)
  await d.page.screenshot({ path: path.join(SHOTS, 'desktop-04-persona.png') });
  const stage = await d.page.locator('.stage').boundingBox();
  eq([stage.width, stage.height, stage.x, stage.y], [392, 700, 524, 30], 'desktop shows a centred phone-sized stage on whole pixels');
  ok(await d.page.locator('.story__arrow--next').isVisible(), 'desktop has arrow buttons');
  await d.page.locator('.story__arrow--next').click();
  eq((await state(d.page)).index, 4, 'the desktop arrow advances');
  await d.close();

  // A contact sheet of all twelve, for the README.
  const sheet = await open({ viewport: { width: 1640, height: 1200 } });
  const imgs = files.map((f) => `<img src="data:image/png;base64,${fs.readFileSync(f).toString('base64')}">`).join('');
  await sheet.page.setContent(`<body>${imgs}</body>`);
  await sheet.page.addStyleTag({ content: 'body{margin:0;padding:40px;background:#07070c;display:grid;grid-template-columns:repeat(6,1fr);gap:20px}img{width:100%;border-radius:22px;display:block}' });
  await sheet.page.waitForTimeout(300);
  await sheet.page.screenshot({ path: path.join(SHOTS, 'overview.png'), fullPage: true });
  await sheet.close();
});

await browser.close();
await server.close();

console.log(`\n${checks} checks, ${failures.length} failed`);
if (failures.length) {
  console.log('\nFailures:');
  for (const f of failures) console.log(' - ' + f);
  process.exit(1);
}
