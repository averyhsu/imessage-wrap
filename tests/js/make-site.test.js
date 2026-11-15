'use strict';
// Static checks on the maker page (web/make/): the product name and address come from one
// place, the page is locked down, and its own code makes no network calls.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const WEB = path.join(__dirname, '../../web');
const MAKE = path.join(WEB, 'make');
const Config = require('../../web/js/config.js');
const html = fs.readFileSync(path.join(MAKE, 'index.html'), 'utf8');
const body = html.replace(/<!--[\s\S]*?-->/g, '');

const meta = (attr, name) => {
  const m = new RegExp(`<meta\\s+${attr}="${name}"\\s+content="([^"]*)"`, 'i').exec(html);
  return m ? m[1] : null;
};
const code = (file) => fs.readFileSync(path.join(MAKE, file), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

test('make/index.html names the product and the address in one block, in sync with config.js', () => {
  const start = html.indexOf('<!-- brand:start -->');
  const end = html.indexOf('<!-- brand:end -->');
  assert.ok(start > 0 && end > start, 'brand block markers exist');
  const block = html.slice(start, end);
  const outside = (html.slice(0, start) + html.slice(end)).replace(/<!--[\s\S]*?-->/g, '');

  assert.ok(!outside.includes(Config.PRODUCT_NAME), 'the product name appears nowhere outside the brand block');
  assert.ok(!outside.includes(Config.BASE_URL), 'the base URL appears nowhere outside the brand block');
  assert.match(block, new RegExp(`<title>${Config.PRODUCT_NAME}: [^<]+</title>`), 'title starts with the product name');
  assert.equal(meta('property', 'og:site_name'), Config.PRODUCT_NAME);
  assert.equal(meta('name', 'application-name'), Config.PRODUCT_NAME);
  assert.equal(meta('name', 'apple-mobile-web-app-title'), Config.PRODUCT_NAME);
  const address = Config.BASE_URL + Config.MAKE_PATH;
  assert.equal(/<link rel="canonical" href="([^"]+)"/.exec(html)[1], address);
  assert.equal(meta('property', 'og:url'), address);
  assert.equal(meta('property', 'og:image'), Config.BASE_URL + 'assets/og.png');
  const urls = block.match(/https?:\/\/[^"\s<]+/g) || [];
  assert.ok(urls.length >= 3 && urls.every((u) => u.startsWith(Config.BASE_URL)), 'every URL in the block uses the base URL');
  // The visible name is filled in from config.js at run time.
  assert.ok((body.match(/data-brand/g) || []).length >= 2, 'the page has data-brand placeholders');
  assert.match(code('make.js'), /Config\.PRODUCT_NAME/);
  for (const file of ['make.js', 'worker.js', 'sample.js', 'make.css']) {
    assert.ok(!code(file).includes(Config.PRODUCT_NAME), `${file} does not hard-code the product name`);
  }
});

test('no borrowed trademarks in the page copy', () => {
  const text = body.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<[^>]+>/g, ' ');
  assert.doesNotMatch(text, /wrapped/i, 'the word "Wrapped" is not in the page copy');
  const mentions = text.match(/[^.]*imessage[^.]*\./gi) || [];
  assert.ok(mentions.every((m) => /trademark of apple|works with imessage/i.test(m)), `"iMessage" only descriptively: ${JSON.stringify(mentions)}`);
  assert.doesNotMatch(meta('name', 'description') + meta('property', 'og:title') + meta('property', 'og:description'), /wrapped|imessage/i);
  // Copy that is built in JavaScript. "wrapped" may appear only as the typed command.
  const strings = code('make.js').match(/'(?:[^'\\\n]|\\.)*'/g) || [];
  for (const s of strings) {
    if (/^'https:\/\/github\.com\//.test(s)) continue;          // the repository's address, not copy
    assert.doesNotMatch(s, /imessage/i, `no "iMessage" in ${s}`);
    if (/wrapped/i.test(s)) assert.match(s, /wrapped link/, `"wrapped" only as the command name: ${s}`);
  }
});

test('hardening: strict CSP, no referrer, nothing inline', () => {
  const csp = /<meta http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(html)[1];
  const directives = Object.fromEntries(csp.split(';').map((d) => d.trim().split(/\s+/)).map(([k, ...v]) => [k, v.join(' ')]));
  assert.deepStrictEqual(directives, {
    'default-src': "'none'",
    'script-src': "'self' 'wasm-unsafe-eval'",
    'style-src': "'self'",
    'img-src': "'self' data: blob:",
    'font-src': "'self'",
    'connect-src': "'self'",
    // Workers only from blob: addresses: such a worker inherits this policy, one started
    // from a file's address would not be bound by it at all.
    'worker-src': 'blob:',
    'frame-src': "'self'",
    'object-src': "'none'",
    'base-uri': "'none'",
    'form-action': "'none'",
  });
  assert.doesNotMatch(csp, /unsafe-inline|'unsafe-eval'|\*|https?:/, 'no wildcards, hosts or unsafe-inline / unsafe-eval');
  assert.equal(meta('name', 'referrer'), 'no-referrer');

  assert.doesNotMatch(body, /<script(?![^>]*\ssrc=)[^>]*>/i, 'no inline <script>');
  assert.doesNotMatch(body, /<style[\s>]/i, 'no inline <style>');
  assert.doesNotMatch(body, /\sstyle\s*=/i, 'no style attributes');
  assert.doesNotMatch(body, /\son[a-z]+\s*=/i, 'no inline event handlers');
  assert.doesNotMatch(body, /type="module"/i, 'classic scripts only');
  assert.doesNotMatch(body, /javascript:/i);
  assert.doesNotMatch(body, /<form[\s>]/i, 'no forms: nothing can be submitted anywhere');
});

test('every file the page references is relative, exists and is same-origin', () => {
  const refs = [...body.matchAll(/\s(?:src|href)="([^"]+)"/g)].map((m) => m[1]);
  const local = refs.filter((r) => !/^(https?:|#)/.test(r) && r !== '../' && !r.startsWith('../?'));
  assert.ok(local.length >= 10, `found the local references (${local.length})`);
  for (const r of local) {
    assert.ok(!r.startsWith('/'), `${r} is relative (the site is served from a sub-path)`);
    assert.ok(fs.existsSync(path.join(MAKE, r)), `${r} exists`);
  }
  const external = refs.filter((r) => /^https?:/.test(r));
  for (const r of external) {
    assert.ok(r.startsWith(Config.BASE_URL) || r === 'https://github.com/averyhsu/imessage-wrap', `unexpected external reference ${r}`);
  }
  const scripts = [...body.matchAll(/<script src="([^"]+)"/g)].map((m) => m[1]);
  assert.deepStrictEqual(scripts, ['../js/vendor/fflate.min.js', '../js/config.js', '../js/glyphs.js', 'engine.js', 'db.js', 'make.js']);
  // The worker loads the rest; those files must exist too.
  const imports = /scope\.importScripts\(([^)]+)\)/.exec(code('worker.js'))[1].split(',').map((s) => s.trim());
  assert.ok(imports.every((s) => /^BASE \+ '[^']+'$/.test(s)), `every import is relative to the page's folder: ${imports}`);
  const imported = imports.map((s) => s.replace(/^BASE \+ '|'$/g, ''));
  assert.deepStrictEqual(imported, ['engine.js', 'vendor/sql-wasm.js', 'db.js', 'import-rows.js', 'sample.js']);
  for (const file of imported.concat(['vendor/sql-wasm.wasm', 'vendor/LICENSE-sql.js.txt'])) {
    assert.ok(fs.existsSync(path.join(MAKE, file)), `${file} exists`);
  }
});

test('the page\'s own scripts make no network calls and do not eval', () => {
  // The one place the page names importScripts: the two-line program it starts the worker
  // from, which loads worker.js from the page's own folder and nothing else.
  const bootstrap = `'self.MAKE_BASE = ' + JSON.stringify(folder) + ';\\nimportScripts(self.MAKE_BASE + "worker.js");\\n'`;
  assert.equal(code('make.js').split(bootstrap).length, 2, 'make.js builds the worker\'s bootstrap exactly once');
  assert.match(code('make.js'), /var folder = new URL\('\.', root\.location\.href\)\.href;/, 'and the folder is the page\'s own');
  assert.equal((code('make.js').match(/new Worker\(/g) || []).length, 1, 'one place starts a worker');
  assert.match(code('make.js'), /URL\.createObjectURL\(new Blob\(\[source\]/, 'and it starts it from a blob');
  assert.doesNotMatch(code('make.js'), /new Worker\(\s*['"]/, 'never from a file address, which the page\'s policy would not bind');
  for (const file of ['make.js', 'sample.js']) {
    const src = code(file).replace(bootstrap, '');
    assert.doesNotMatch(src, /^\s*(import|export)\s/m, `${file}: no ES module syntax`);
    assert.doesNotMatch(src, /\bfetch\s*\(|XMLHttpRequest|sendBeacon|WebSocket|EventSource|importScripts/, `${file}: no network APIs`);
    assert.doesNotMatch(src, /\beval\s*\(|new Function\s*\(|document\.write|localStorage|sessionStorage|indexedDB|document\.cookie/, `${file}: no eval, no storage`);
    assert.doesNotMatch(src, /https?:\/\/(?!github\.com\/averyhsu\/imessage-wrap\/|www\.w3\.org\/)/, `${file}: no third-party URLs`);
  }
  // The worker names the network functions only to remove them.
  const worker = code('worker.js');
  assert.match(worker, /\n {2}function lockDown\(\) \{/);
  const gone = /\n {2}var GONE = \[([^\]]+)\];/.exec(worker);
  assert.ok(gone, 'worker.js lists what it removes');
  const removed = gone[1].split(',').map((s) => s.trim().replace(/^'|'$/g, ''));
  for (const name of ['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'importScripts', 'Worker']) {
    assert.ok(removed.includes(name), `lockDown() removes ${name}`);
  }
  const withoutLockDown = worker.replace(gone[0], '').replace(/\n {2}function lockDown\(\) \{[\s\S]*?\n {2}\}/, '');
  assert.doesNotMatch(withoutLockDown, /function lockDown/, 'the whole of lockDown() was set aside');
  assert.doesNotMatch(withoutLockDown, /\bfetch\b|XMLHttpRequest|WebSocket|EventSource|sendBeacon/, 'worker.js: no network APIs outside lockDown()');
  assert.equal((worker.match(/importScripts\(/g) || []).length, 1, 'worker.js: one importScripts call, at the top');
  assert.match(worker, /getPrototypeOf\(target\)/, 'lockDown() walks the prototypes too');
  assert.doesNotMatch(worker, /https?:\/\//, 'worker.js: no URLs');
  // Recap strings never reach innerHTML: only the constant icon markup does.
  const uses = code('make.js').match(/[^\n]*innerHTML[^\n]*/g) || [];
  assert.ok(uses.length >= 1 && uses.every((line) => /innerHTML = ICONS\[name\] \|\| \(Glyphs && Glyphs\.ICONS\[name\]\) \|\| ''/.test(line)),
    `innerHTML is only ever given constant icon markup: ${JSON.stringify(uses)}`);
  assert.doesNotMatch(code('make.js'), /insertAdjacentHTML|outerHTML/);
});

test('no table on the page is a plain object that a name could fall into', () => {
  // A plain {} already has constructor, toString and __proto__; someone in a chat may be
  // called that. Tables keyed by data are Maps, Sets or Object.create(null) (table()).
  for (const file of ['make.js', 'worker.js', 'sample.js']) {
    const empties = code(file).match(/[^\n]*(?:=|:)\s*\{\}\s*[,;)][^\n]*/g) || [];
    assert.deepStrictEqual(empties, [], `${file}: no empty object literal is used as a table`);
  }
  assert.match(code('make.js'), /function table\(\) \{ return Object\.create\(null\); \}/);
  assert.match(code('make.js'), /Engine\.shortNames\(/, 'short names come from the engine, not from a copy of its rule');
});

test('an exception nobody caught ends in a message on the page', () => {
  const src = code('make.js');
  assert.match(src, /root\.addEventListener\('error', function \(event\) \{\s*if \(event && event\.error\) unexpected\(event\.error\);/);
  assert.match(src, /root\.addEventListener\('unhandledrejection', function \(event\) \{\s*unexpected\(event && event\.reason\);/);
  // Every request to the reader is followed, somewhere down its chain, by a catch.
  const asks = src.split(/\bask\('(?:open|paste|sample|chat|contacts|compute)'/).slice(1);
  assert.equal(asks.length, 6, 'the six requests the page makes');
  for (const rest of asks) {
    const chain = rest.slice(0, rest.indexOf('\n  }\n'));
    assert.match(chain, /\.catch\(function \(error\) \{[^}]*unexpected\(error, [123]\)/, 'a step that fails half way falls back and says so');
  }
});

test('the stylesheet loads nothing remote', () => {
  const css = fs.readFileSync(path.join(MAKE, 'make.css'), 'utf8');
  assert.doesNotMatch(css, /@import/);
  const urls = [...css.matchAll(/url\(\s*["']?([^"')]+)/g)].map((m) => m[1]);
  for (const u of urls) assert.ok(u.startsWith('data:image/svg+xml,'), `url(${u.slice(0, 40)}) is inline SVG`);
  assert.match(css, /prefers-reduced-motion: reduce/, 'respects reduced motion');
});

test('quotes are opt-in and the page says what the link holds', () => {
  assert.match(body, /<input type="checkbox" id="quotes" role="switch">/, 'the quotes switch is unchecked in the markup');
  assert.match(code('make.js'), /quotes: false,/, 'and off in the initial state');
  assert.match(body, /What goes in the link/);
  assert.match(body, /Paste the link on its own line in the group chat\. Everyone can open it, no app needed\./);
});
