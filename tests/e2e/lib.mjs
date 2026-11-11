// Shared helpers for the end-to-end scripts: a tiny static server for web/, Chromium
// launch, and page-side utilities for driving the story.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

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

/** Serve web/ on 127.0.0.1 at a free port. Returns { url, close, hits }. */
export async function startServer(dir = WEB) {
  const hits = [];
  const server = http.createServer((req, res) => {
    let pathname;
    try { pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch { pathname = '/'; }
    hits.push(pathname);
    let file = path.normalize(path.join(dir, pathname));
    if (!file.startsWith(dir)) { res.writeHead(403).end('Forbidden'); return; }
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
    if (!fs.existsSync(file)) { res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found'); return; }
    const body = fs.readFileSync(file);
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

export async function launch() {
  return chromium.launch({ args: ['--font-render-hinting=none', '--disable-lcd-text'] });
}

/** Wait until the story is running and the display font is in. */
export async function waitForStory(page) {
  await page.waitForFunction(() => window.WrappedStory && window.WrappedStory.isActive(), null, { timeout: 15000 });
  await page.evaluate(() => Promise.all([document.fonts.ready, window.WrappedCard.ready()]));
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
}

/** Freeze the story on slide `i` with every entrance finished. */
export async function showSettled(page, i) {
  await page.evaluate((index) => {
    const S = window.WrappedStory;
    S.pause();
    S.goTo(index);
    S.layout();
    S.settle();
    return new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
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
      return cs.position !== 'absolute' && cs.display !== 'none' && !el.classList.contains('gap');
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
