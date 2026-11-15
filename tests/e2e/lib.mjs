// Shared helpers for the end-to-end scripts: a tiny static server for web/, the browser
// launch (BROWSER=chromium|webkit|firefox, default chromium), and page-side utilities for
// driving the story.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, webkit, firefox } from 'playwright';

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, '../..');
export const WEB = path.join(ROOT, 'web');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.mp4': 'video/mp4',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
  '.ico': 'image/x-icon',
};

/**
 * Serve web/ on 127.0.0.1 at a free port. Returns { url, close, hits }.
 * `rewrite(file, body)` may change a file on its way out (a test's control experiment).
 */
export async function startServer(dir = WEB, { rewrite } = {}) {
  const hits = [];
  const server = http.createServer((req, res) => {
    let pathname;
    try { pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch { pathname = '/'; }
    hits.push(pathname);
    let file = path.normalize(path.join(dir, pathname));
    if (!file.startsWith(dir)) { res.writeHead(403).end('Forbidden'); return; }
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
    if (!fs.existsSync(file)) { res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found'); return; }
    let body = fs.readFileSync(file);
    if (rewrite) body = Buffer.from(rewrite(file, body));
    res.writeHead(200, {
      'content-type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'content-length': body.length,
      'cache-control': 'no-store',
    });
    res.end(body);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}/`,
    hits,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

// ── which browser ──────────────────────────────────────────────────────────────────────
// Every suite runs in Chromium by default. BROWSER=webkit or BROWSER=firefox runs the same
// checks in that engine; where a check leans on something only Chromium's automation offers,
// the suite says so in one line (see note()) and checks the same behaviour another way.
const ENGINES = { chromium, webkit, firefox };
export const BROWSER = (process.env.BROWSER || 'chromium').toLowerCase();
if (!ENGINES[BROWSER]) throw new Error(`BROWSER must be one of ${Object.keys(ENGINES).join(', ')} (got "${process.env.BROWSER}")`);
export const IS_CHROMIUM = BROWSER === 'chromium';

const noted = new Set();
/** Say once per run why a check is different in this engine. */
export function note(reason) {
  if (noted.has(reason)) return;
  noted.add(reason);
  console.log(`  ~ [${BROWSER}] ${reason}`);
}

export async function launch() {
  console.log(`Browser: ${BROWSER}`);
  if (BROWSER === 'firefox') {
    // Firefox's async clipboard asks the user (a "Paste" menu) before readText() resolves;
    // this is the preference Firefox's own tests use to answer it, so the clipboard checks
    // still read what the page really wrote.
    return firefox.launch({ firefoxUserPrefs: { 'dom.events.testing.asyncClipboard': true } });
  }
  if (BROWSER === 'webkit') return webkit.launch();
  // PW_CHANNEL=chrome uses an installed Google Chrome instead of Playwright's Chromium.
  const channel = process.env.PW_CHANNEL || undefined;
  return chromium.launch({ channel, args: ['--font-render-hinting=none', '--disable-lcd-text'] });
}

// Which permission names each engine's automation can grant. Chromium: both clipboard
// permissions. WebKit: clipboard-read only (writing needs no grant there). Firefox: neither
// (see the preference in launch()).
const GRANTABLE = { webkit: ['clipboard-read'], firefox: [] };
function grantable(permissions) {
  if (IS_CHROMIUM || !permissions) return permissions;
  const keep = permissions.filter((p) => !/^clipboard-/.test(p) || GRANTABLE[BROWSER].includes(p));
  const dropped = permissions.filter((p) => !keep.includes(p));
  if (dropped.length) note(`Playwright cannot grant ${dropped.join(', ')} here; the page's clipboard calls run without that grant`);
  return keep;
}

/**
 * newContext() options for this engine. Playwright's Firefox has no isMobile (meta viewport
 * and mobile layout emulation): there a phone is its viewport size plus a touch screen.
 */
export function contextOptions(options) {
  const out = { ...options };
  if (BROWSER === 'firefox' && 'isMobile' in out) {
    if (out.isMobile) note('isMobile is not supported by Playwright in Firefox: phones are the viewport size with touch only');
    delete out.isMobile;
  }
  if (out.permissions) out.permissions = grantable(out.permissions);
  return out;
}

/** context.grantPermissions() limited to what this engine can grant. */
export function grant(context, permissions) {
  return context.grantPermissions(grantable(permissions));
}

/**
 * The key that moves focus to the next control. WebKit on macOS follows the system
 * setting Safari ships with: Tab stops only at text fields and Option+Tab at every control.
 * Option+Tab is what a Safari keyboard user presses, so that is the key pressed there.
 */
export const TAB_ALL = process.platform === 'darwin' && BROWSER === 'webkit';
export function tabKey(shift = false) {
  if (!TAB_ALL) return shift ? 'Shift+Tab' : 'Tab';
  note('macOS WebKit: Tab skips buttons, links and checkboxes (as in Safari by default); pressing Option+Tab');
  return shift ? 'Alt+Shift+Tab' : 'Alt+Tab';
}

/**
 * Take a screenshot. Before every screenshot Playwright's WebKit appends <style>body {}</style>
 * to the page (to bring CSS animations in step). A page with a strict style-src refuses it and
 * says so on the console. shoot() marks the time it takes, and screenshotNoise() recognises
 * exactly that refusal inside that window, so it is not mistaken for the page's own doing.
 */
const shooting = new WeakMap();
export async function shoot(page, take) {
  if (BROWSER !== 'webkit') return take();
  note("Playwright's WebKit adds an inline <style> before each screenshot; the page's CSP refusal of it is not counted against the page");
  shooting.set(page, Infinity);
  try { return await take(); } finally { shooting.set(page, Date.now() + 1000); }
}
export function screenshotNoise(page, text) {
  if (BROWSER !== 'webkit' || !page || !(Date.now() <= (shooting.get(page) || 0))) return false;
  return /^Refused to apply a stylesheet because its hash, its nonce, or 'unsafe-inline' does not appear in the style-src directive of the Content Security Policy\.$/.test(text)
    || text === 'CSP violation: style-src-elem inline';
}

/** A request the browser cut short on purpose (navigation away), in this engine's words. */
export const ABORTED = /^(net::ERR_ABORTED|NS_BINDING_ABORTED|cancelled|Load request cancelled)$/i;

/** Wait until the story is running and the display font is in. */
export async function waitForStory(page) {
  await page.waitForFunction(() => window.WrappedStory && window.WrappedStory.isActive(), null, { timeout: 15000 });
  await page.evaluate(() => Promise.all([document.fonts.ready, window.WrappedCard.ready()]));
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
}

/**
 * Freeze the story on slide `i` with every entrance finished.
 *
 * The chrome and the desktop backdrop change colour with CSS transitions. Chromium runs
 * colour transitions on the compositor, and a frame captured while one is running or
 * winding down differs from a settled frame by a few anti-aliased pixels (the edge of the
 * header badge, the desktop arrows). So: let any transition that is already under way
 * finish, switch transitions off for what follows, and give the compositor a moment after
 * the slide is in place. A settled slide is then the same picture on every run.
 */
export async function showSettled(page, i) {
  await page.evaluate(async (index) => {
    const S = window.WrappedStory;
    const frames = (n) => new Promise((resolve) => { const step = () => (n-- > 0 ? requestAnimationFrame(step) : resolve()); step(); });
    const chrome = document.querySelectorAll('.story__backdrop, .story__arrow, .chrome, .chrome *');
    if (!chrome[0] || chrome[0].style.transition !== 'none') {
      const running = document.getAnimations().filter((a) => a.constructor.name === 'CSSTransition');
      await Promise.all(running.map((a) => a.finished.catch(() => {})));
      chrome.forEach((el) => { el.style.transition = 'none'; });
      await frames(3);
    }
    S.pause();
    S.goTo(index);
    S.layout();
    S.settle();
    await frames(3);
  }, i);
}

/**
 * Check the active slide for layout problems. Returns a list of human-readable issues.
 * Decorative backgrounds (.slide__bg) are exempt: they bleed off the stage on purpose.
 */
export async function findOverflow(page) {
  return page.evaluate(() => {
    const stage = document.querySelector('.stage');
    const slide = document.querySelector('.slide.is-active');
    if (!stage || !slide) return ['no active slide'];
    const s = stage.getBoundingClientRect();
    const issues = [];
    const tol = 1.5;
    const describe = (el) => {
      const cls = typeof el.className === 'string' ? el.className.trim().split(/\s+/).slice(0, 2).join('.') : '';
      return el.tagName.toLowerCase() + (cls ? '.' + cls : '');
    };
    // What is actually painted: the element's box cut down by every clipping ancestor.
    const painted = (el) => {
      let { left, top, right, bottom } = el.getBoundingClientRect();
      for (let p = el.parentElement; p && p !== stage; p = p.parentElement) {
        const pcs = getComputedStyle(p);
        if (pcs.overflowX === 'visible' && pcs.overflowY === 'visible') continue;
        const pr = p.getBoundingClientRect();
        if (pcs.overflowX !== 'visible') { left = Math.max(left, pr.left); right = Math.min(right, pr.right); }
        if (pcs.overflowY !== 'visible') { top = Math.max(top, pr.top); bottom = Math.min(bottom, pr.bottom); }
      }
      return { left, top, right, bottom, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
    };
    const nodes = [...slide.querySelectorAll('.slide__body *'), ...document.querySelectorAll('.chrome *')];
    for (const el of nodes) {
      if (el.closest('svg') && el.tagName.toLowerCase() !== 'svg') continue;
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') continue;
      if (el.classList.contains('sr-only')) continue;
      const r = painted(el);
      if (r.width === 0 && r.height === 0) continue;
      if (r.left < s.left - tol || r.right > s.right + tol || r.top < s.top - tol || r.bottom > s.bottom + tol) {
        issues.push(`${describe(el)} leaves the stage: [${[r.left - s.left, r.top - s.top, r.right - s.left, r.bottom - s.top].map((v) => Math.round(v)).join(', ')}] vs ${Math.round(s.width)}×${Math.round(s.height)}`);
        continue;
      }
      // Text that is cut off without an ellipsis, or pushed out of its own box.
      const clips = cs.overflowX !== 'visible' || cs.overflowY !== 'visible';
      const graceful = cs.textOverflow === 'ellipsis' || cs.webkitLineClamp !== 'none';
      if (clips && !graceful && el.children.length === 0 && el.textContent.trim()) {
        if (el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1) {
          issues.push(`${describe(el)} clips its text "${el.textContent.trim().slice(0, 30)}"`);
        }
      }
      // A count or a date next to a name: the name may be shortened, this may not.
      if (el.hasAttribute('data-keep')) {
        const full = el.getBoundingClientRect();
        // (Inline boxes report a clientWidth of 0, so only blocks get the scroll test.)
        if (r.width < full.width - 1 || r.height < full.height - 1 || (el.clientWidth > 0 && el.scrollWidth > el.clientWidth + 1)) {
          issues.push(`${describe(el)} "${el.textContent.trim().slice(0, 24)}" is cut off (${Math.round(r.width)} of ${Math.round(full.width)} px shown)`);
        }
      }
      if (el.classList.contains('fit') && !el.classList.contains('fit--clip')) {
        const inner = el.firstElementChild;
        if (inner && inner.offsetWidth > el.clientWidth + 1 && !el.closest('.taps__top')) {
          issues.push(`${describe(el)} fit text wider than its line (${inner.offsetWidth} > ${el.clientWidth})`);
        }
      }
    }
    // Siblings in the main column must not run into each other.
    const body = slide.querySelector('.slide__body');
    const flow = [...body.children].filter((el) => {
      const cs = getComputedStyle(el);
      // Spacers are empty, and a rotated glyph's bounding box is bigger than its layout box.
      return cs.position !== 'absolute' && cs.display !== 'none' && !el.classList.contains('gap') && !el.classList.contains('late__space') && !el.classList.contains('late__moon');
    });
    for (let i = 1; i < flow.length; i++) {
      const a = flow[i - 1].getBoundingClientRect();
      const b = flow[i].getBoundingClientRect();
      if (b.top < a.bottom - 6 && a.height > 0 && b.height > 0) {
        issues.push(`${describe(flow[i])} overlaps ${describe(flow[i - 1])} by ${Math.round(a.bottom - b.top)}px`);
      }
    }
    if (body.scrollHeight > body.clientHeight + 2) {
      issues.push(`slide body is taller than the stage allows (${body.scrollHeight} > ${body.clientHeight})`);
    }
    // Display type is set tight. Where it wraps, the distance from one line to the next
    // has to be more than the font's ink (deepest descender + tallest ascender), or a "y"
    // touches the "h" under it. Measured on the laid-out lines, whatever CSS produced them.
    const inks = {};
    const inkOf = (cs) => {
      const key = cs.fontWeight + ' ' + cs.fontFamily;
      if (!(key in inks)) {
        const ctx = document.createElement('canvas').getContext('2d');
        ctx.font = `${cs.fontWeight} 200px ${cs.fontFamily}`;
        inks[key] = (ctx.measureText('gjpqy').actualBoundingBoxDescent + ctx.measureText('bdfhklt').actualBoundingBoxAscent) / 200;
      }
      return inks[key];
    };
    const blocks = new Map();
    const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const parent = node.parentElement;
      if (!node.nodeValue.trim() || parent.closest('svg')) continue;
      const pcs = getComputedStyle(parent);
      if (!/^"?Archivo/.test(pcs.fontFamily) || pcs.display === 'none' || pcs.visibility === 'hidden') continue;
      let block = parent;
      while (block !== body && getComputedStyle(block).display.startsWith('inline')) block = block.parentElement;
      const range = document.createRange();
      range.selectNodeContents(node);
      const entry = blocks.get(block) || { rects: [], ink: inkOf(pcs) };
      for (const r of range.getClientRects()) if (r.width > 0) entry.rects.push({ top: r.top, bottom: r.bottom, size: parseFloat(pcs.fontSize) });
      blocks.set(block, entry);
    }
    for (const [block, entry] of blocks) {
      const lines = [];
      for (const r of entry.rects.sort((a, b) => a.top - b.top)) {
        const line = lines[lines.length - 1];
        if (line && r.top < line.bottom - (r.bottom - r.top) * 0.5) { line.size = Math.max(line.size, r.size); line.bottom = Math.max(line.bottom, r.bottom); }
        else lines.push({ top: r.top, bottom: r.bottom, size: r.size });
      }
      for (let i = 1; i < lines.length; i++) {
        if (Math.abs(lines[i].size - lines[i - 1].size) > 0.5) continue; // different type on each line
        const spare = (lines[i].top - lines[i - 1].top) / lines[i].size - entry.ink;
        if (spare < 0.015) {
          issues.push(`${describe(block)} "${block.textContent.trim().slice(0, 24)}": wrapped display lines are ${spare < 0 ? 'overlapping' : 'touching'} (line pitch ${((lines[i].top - lines[i - 1].top) / lines[i].size).toFixed(3)}em, ink ${entry.ink.toFixed(3)}em)`);
          break;
        }
      }
    }
    return issues;
  });
}

export function encodePayload(stats) {
  // Use the page's own codec implementation from Node so tests and site cannot drift.
  return import('node:module').then(({ createRequire }) => {
    const require = createRequire(import.meta.url);
    return require(path.join(WEB, 'js/codec.js')).encode(stats);
  });
}
