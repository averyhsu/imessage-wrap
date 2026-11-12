'use strict';
// Static checks on the Mac app's download page (web/mac/): the product name and address come
// from one place, macOS's own words live in one block, the page is locked down, and the copy
// keeps the project's rules (no jargon, no borrowed names, no claim that Apple checked it).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const WEB = path.join(__dirname, '../../web');
const MAC = path.join(WEB, 'mac');
const Config = require('../../web/js/config.js');
const MacConfig = require('../../web/mac/mac-config.js');
const Guide = require('../../web/mac/mac.js');
const html = fs.readFileSync(path.join(MAC, 'index.html'), 'utf8');
const body = html.replace(/<!--[\s\S]*?-->/g, '');
const source = (file) => fs.readFileSync(path.join(MAC, file), 'utf8');
const code = (file) => source(file).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const decode = (s) => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&nbsp;/g, ' ');
/** The page's words, as a reader without JavaScript gets them. */
const words = (h) => decode(h.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ');
const meta = (attr, name) => {
  const m = new RegExp(`<meta\\s+${attr}="${name}"\\s+content="([^"]*)"`, 'i').exec(html);
  return m ? m[1] : null;
};
const FALLBACK_NAME = 'the app';

test('mac/index.html names the product and the address in one block, in sync with config.js', () => {
  const start = html.indexOf('<!-- brand:start -->');
  const end = html.indexOf('<!-- brand:end -->');
  assert.ok(start > 0 && end > start, 'brand block markers exist');
  const block = html.slice(start, end);
  const outside = (html.slice(0, start) + html.slice(end)).replace(/<!--[\s\S]*?-->/g, '');

  assert.ok(!outside.includes(Config.PRODUCT_NAME), 'the product name appears nowhere outside the brand block');
  assert.ok(!outside.includes(Config.BASE_URL), 'the base URL appears nowhere outside the brand block');
  assert.match(block, new RegExp(`<title>${Config.PRODUCT_NAME} for Mac: [^<]+</title>`), 'title starts with the product name');
  assert.equal(meta('property', 'og:site_name'), Config.PRODUCT_NAME);
  assert.equal(meta('name', 'application-name'), Config.PRODUCT_NAME);
  assert.equal(meta('name', 'apple-mobile-web-app-title'), Config.PRODUCT_NAME);
  assert.equal(Config.MAC_PATH, 'mac/');
  const address = Config.BASE_URL + Config.MAC_PATH;
  assert.equal(/<link rel="canonical" href="([^"]+)"/.exec(html)[1], address);
  assert.equal(meta('property', 'og:url'), address);
  assert.equal(meta('property', 'og:image'), Config.BASE_URL + 'assets/og.png');
  const urls = block.match(/https?:\/\/[^"\s<]+/g) || [];
  assert.ok(urls.length >= 3 && urls.every((u) => u.startsWith(Config.BASE_URL)), 'every URL in the block uses the base URL');
  // The visible name is filled in from config.js at run time; without it the page says "the app".
  assert.ok((body.match(/data-brand/g) || []).length >= 6, 'the page has data-brand placeholders');
  assert.match(code('mac.js'), /Config\.PRODUCT_NAME/);
  for (const file of ['mac.js', 'mac-config.js', 'mac.css']) {
    assert.ok(!code(file).includes(Config.PRODUCT_NAME), `${file} does not hard-code the product name`);
  }
});

test('macOS\'s own words live in one block in mac.js, and the page matches it', () => {
  const T = Guide.MACOS_TEXT;
  assert.equal(typeof T.approximate, 'boolean', 'the block says whether its words are confirmed');
  const keys = Object.keys(T).filter((k) => typeof T[k] === 'string');
  for (const k of ['notOpenedTitle', 'notOpenedBody', 'done', 'moveToTrash', 'systemSettings', 'privacySecurity', 'blockedLine', 'openAnyway', 'confirmOpen', 'damaged']) {
    assert.ok(keys.includes(k), `the block has ${k}`);
  }
  assert.match(T.notOpenedBody, /could not verify/, 'the message as research note 08 gives it');
  assert.match(T.blockedLine, /\{app\}/, 'the product name is filled in, not written in');

  // The block is the only place in mac.js that writes those words.
  const src = source('mac.js');
  const blockStart = src.indexOf('var MACOS_TEXT = {');
  const blockEnd = src.indexOf('};', blockStart);
  assert.ok(blockStart > 0 && blockEnd > blockStart, 'mac.js has the MACOS_TEXT block');
  assert.ok(blockStart < src.indexOf('\n  function '), 'it is at the top of the script, before any code');
  const rest = (src.slice(0, blockStart) + src.slice(blockEnd)).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  for (const k of keys) {
    const literal = JSON.stringify(T[k]).slice(1, -1).replace(/[‘-”]/g, (c) => '\\u' + c.charCodeAt(0).toString(16));
    if (T[k].length >= 6) assert.ok(!rest.includes(T[k]) && !rest.includes(literal), `"${T[k]}" is written only in the block`);
  }

  // Every element that shows macOS's words names a key; its text for readers without
  // JavaScript is the block's string with "the app" for the name.
  const marked = [...body.matchAll(/<(\w+)\b[^>]*\sdata-macos="(\w+)"[^>]*>([^<]*)<\/\1>/g)];
  assert.ok(marked.length >= 20, `the page marks where it quotes macOS (${marked.length})`);
  assert.equal(marked.length, (body.match(/data-macos=/g) || []).length, 'every data-macos element holds plain text only');
  const stale = [];
  for (const [, , key, text] of marked) {
    assert.ok(keys.includes(key), `data-macos="${key}" is a key of the block`);
    const want = Guide.macos(key, FALLBACK_NAME);
    if (decode(text) !== want) stale.push(`data-macos="${key}": index.html says "${decode(text)}", mac.js says "${want}"`);
  }
  assert.deepStrictEqual(stale, [], 'index.html shows the block\'s current wording (update these after changing mac.js)');
  for (const k of keys) assert.ok(marked.some((m) => m[2] === k), `${k} is used on the page`);

  // Nowhere else on the page are those words written out by hand.
  const unmarked = words(body.replace(/<(\w+)\b[^>]*\sdata-macos="\w+"[^>]*>[^<]*<\/\1>/g, ' '));
  for (const k of keys) {
    for (const name of [FALLBACK_NAME, Config.PRODUCT_NAME]) {
      const s = Guide.macos(k, name);
      if (s.length >= 6) assert.ok(!unmarked.includes(s), `"${s}" appears only inside data-macos elements`);
    }
  }
  // While the words are unconfirmed, the drawings say so.
  if (T.approximate) assert.ok((body.match(/data-approx/g) || []).length >= 2, 'each drawing carries the "may differ a little" note');
});

test('the copy: plain words, no borrowed names, honest about Apple', () => {
  const text = words(body);
  assert.doesNotMatch(text, /gatekeeper|notari[sz]|quarantin|xattr|codesign|developer id/i, 'no jargon on the page');
  assert.doesNotMatch(text, /(?<!not )(verified|approved|checked|vouched for) by apple|apple[- ](verified|approved)/i, 'never claims Apple checked the app');
  assert.match(text, /not signed through Apple’s paid developer program/, 'says why macOS stops it');
  assert.match(text, /does not pay Apple’s yearly fee/, 'says the project does not pay the fee');
  assert.match(text, /anyone can read the code/, 'and that the alternative is to trust the public code');
  assert.match(text, /not reviewed or signed by Apple/, 'the footer says it too');
  // "Wrapped" only as the typed command; "iMessage" only as a compatibility note.
  const wrapped = text.match(/\S*wrapped\S*/gi) || [];
  assert.ok(wrapped.length >= 2 && wrapped.every((w) => /^\/wrapped[,.]?$/.test(w)), `"wrapped" only as /wrapped: ${JSON.stringify(wrapped)}`);
  const imessage = text.match(/[^.]*imessage[^.]*\./gi) || [];
  assert.ok(imessage.every((m) => /works with imessage|trademark of apple/i.test(m)), `"iMessage" only descriptively: ${JSON.stringify(imessage)}`);
  assert.doesNotMatch(meta('name', 'description') + meta('property', 'og:title') + meta('property', 'og:description'), /wrapped|imessage/i);
  assert.doesNotMatch(text, /open[- ]source/i, 'no licence claim');
  assert.match(text, new RegExp(`macOS ${MacConfig.MIN_MACOS} or later`), 'the minimum macOS matches mac-config.js');
  // Script-built copy follows the same rules.
  const strings = code('mac.js').match(/'(?:[^'\\\n]|\\.)*'/g) || [];
  for (const s of strings) {
    assert.doesNotMatch(s, /imessage|gatekeeper|notari/i, `no borrowed names or jargon in ${s}`);
  }
});

test('hardening: strict CSP, no referrer, nothing inline', () => {
  const csp = /<meta http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(html)[1];
  const directives = Object.fromEntries(csp.split(';').map((d) => d.trim().split(/\s+/)).map(([k, ...v]) => [k, v.join(' ')]));
  assert.deepStrictEqual(directives, {
    'default-src': "'none'",
    'script-src': "'self'",
    'style-src': "'self'",
    'img-src': "'self' data:",
    'font-src': "'self'",
    'connect-src': "'none'",
    'object-src': "'none'",
    'base-uri': "'none'",
    'form-action': "'none'",
  });
  assert.equal(meta('name', 'referrer'), 'no-referrer');
  assert.doesNotMatch(body, /<script(?![^>]*\ssrc=)[^>]*>/i, 'no inline <script>');
  assert.doesNotMatch(body, /<style[\s>]/i, 'no inline <style>');
  assert.doesNotMatch(body, /\sstyle\s*=/i, 'no style attributes');
  assert.doesNotMatch(body, /\son[a-z]+\s*=/i, 'no inline event handlers');
  assert.doesNotMatch(body, /type="module"/i, 'classic scripts only');
  assert.doesNotMatch(body, /javascript:/i);
  assert.doesNotMatch(body, /<form[\s>]|<iframe[\s>]/i, 'no forms, no frames');
});

test('every file the page references is relative and exists; links go where they should', () => {
  const refs = [...body.matchAll(/\s(?:src|href)="([^"]+)"/g)].map((m) => m[1]);
  const local = refs.filter((r) => !/^(https?:|#|x-apple\.)/.test(r));
  assert.ok(local.length >= 12, `found the local references (${local.length})`);
  for (const r of local) {
    assert.ok(!r.startsWith('/'), `${r} is relative (the site is served from a sub-path)`);
    assert.ok(fs.existsSync(path.join(MAC, r)), `${r} exists`);
  }
  for (const r of refs.filter((x) => /^https?:/.test(x))) {
    assert.ok(r.startsWith(Config.BASE_URL) || r === MacConfig.SOURCE_URL, `unexpected external reference ${r}`);
  }
  const deep = refs.filter((r) => r.startsWith('x-apple.'));
  assert.deepStrictEqual(deep, ['x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Security'], 'one System Settings link, to Privacy & Security');
  const scripts = [...body.matchAll(/<script src="([^"]+)"/g)].map((m) => m[1]);
  assert.deepStrictEqual(scripts, ['../js/config.js', 'mac-config.js', 'mac.js']);
  assert.match(body, /href="\.\.\/"/, 'links back to the main page');
});

test('the page\'s scripts make no network calls, store nothing and build no HTML', () => {
  for (const file of ['mac.js', 'mac-config.js']) {
    const src = code(file);
    assert.doesNotMatch(src, /^\s*(import|export)\s/m, `${file}: no ES module syntax`);
    assert.doesNotMatch(src, /\bfetch\s*\(|XMLHttpRequest|sendBeacon|WebSocket|EventSource|importScripts|new Worker/, `${file}: no network APIs`);
    assert.doesNotMatch(src, /\beval\s*\(|new Function\s*\(|document\.write/, `${file}: no eval`);
    assert.doesNotMatch(src, /localStorage|sessionStorage|indexedDB|document\.cookie/, `${file}: state lives in memory only`);
    assert.doesNotMatch(src, /innerHTML|outerHTML|insertAdjacentHTML/, `${file}: builds no HTML from strings`);
    assert.doesNotMatch(src, /https?:\/\/(?!github\.com\/averyhsu\/imessage-wrap['/])/, `${file}: no third-party URLs`);
    assert.match(src, /root\.Wrapped[A-Z]\w+\s*=/, `${file}: exports one window.Wrapped… global`);
  }
  const css = source('mac.css');
  assert.doesNotMatch(css, /@import/);
  assert.equal((css.match(/url\(/g) || []).length, 0, 'the stylesheet loads nothing');
  assert.match(css, /prefers-reduced-motion: reduce/, 'respects reduced motion');
});

test('mac-config.js: one download address, empty until it is public', () => {
  assert.equal(typeof MacConfig.MAC_DOWNLOAD_URL, 'string');
  const url = MacConfig.MAC_DOWNLOAD_URL;
  assert.ok(url === '' || Guide.usableDownload(url) === url, `MAC_DOWNLOAD_URL is empty, https:// or relative (${url})`);
  assert.equal(MacConfig.SOURCE_URL, 'https://github.com/averyhsu/imessage-wrap');
  assert.equal(MacConfig.MIN_MACOS, 14);
  assert.equal(Guide.usableDownload(''), '');
  assert.equal(Guide.usableDownload('  '), '');
  assert.equal(Guide.usableDownload('https://example.org/a.zip'), 'https://example.org/a.zip');
  assert.equal(Guide.usableDownload('downloads/a.zip'), 'downloads/a.zip');
  for (const bad of ['javascript:alert(1)', 'http://example.org/a.zip', '//example.org/a.zip', '/a.zip', 'data:text/html,x']) {
    assert.equal(Guide.usableDownload(bad), '', `${bad} is refused`);
  }
});

test('platform(): which devices are told they need a Mac', () => {
  const cases = [
    ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.4 Safari/605.1.15', 0, 'mac'],
    ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36', 0, 'mac'],
    ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.4 Safari/605.1.15', 5, 'ipad'],
    ['Mozilla/5.0 (iPhone; CPU iPhone OS 18_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.4 Mobile/15E148 Safari/604.1', 5, 'iphone'],
    ['Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1', 5, 'ipad'],
    ['Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36', 5, 'android'],
    ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36', 0, 'windows'],
    ['Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36', 0, 'chromebook'],
    ['Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36', 0, 'linux'],
    ['', 0, 'unknown'],
  ];
  for (const [ua, touch, want] of cases) assert.equal(Guide.platform(ua, touch), want, `${want}: ${ua.slice(0, 40)}`);
  for (const device of ['iphone', 'ipad', 'android', 'windows', 'chromebook', 'linux']) assert.ok(Guide.DEVICES[device], `${device} has a name`);
  assert.ok(!('mac' in Guide.DEVICES) && !('unknown' in Guide.DEVICES), 'Macs and unknown devices are not told to go elsewhere');
});

/** Width and height of a WebP file (VP8, VP8L or VP8X). */
function webpSize(buf) {
  assert.equal(buf.toString('latin1', 0, 4), 'RIFF');
  assert.equal(buf.toString('latin1', 8, 12), 'WEBP');
  const kind = buf.toString('latin1', 12, 16);
  if (kind === 'VP8 ') return [buf.readUInt16LE(26) & 0x3fff, buf.readUInt16LE(28) & 0x3fff];
  if (kind === 'VP8L') { const b = buf.readUInt32LE(21); return [(b & 0x3fff) + 1, ((b >> 14) & 0x3fff) + 1]; }
  if (kind === 'VP8X') return [buf.readUIntLE(24, 3) + 1, buf.readUIntLE(27, 3) + 1];
  throw new Error('unknown WebP chunk ' + kind);
}

test('the screenshots on the page are small and declare their real size', () => {
  const imgs = [...body.matchAll(/<img src="(img\/[^"]+)" alt="([^"]*)" width="(\d+)" height="(\d+)"/g)];
  assert.ok(imgs.length >= 7, `found the pictures (${imgs.length})`);
  for (const [, src, alt, w, h] of imgs) {
    const buf = fs.readFileSync(path.join(MAC, src));
    assert.ok(buf.length < 40 * 1024, `${src} is light (${Math.round(buf.length / 1024)} KB)`);
    assert.deepStrictEqual(webpSize(buf), [Number(w), Number(h)], `${src}: width and height attributes match the file`);
    if (src !== 'img/reply-card.webp') assert.ok(alt.length > 20, `${src} says what it shows`);
  }
  const files = fs.readdirSync(path.join(MAC, 'img'));
  assert.deepStrictEqual(files.sort(), [...new Set(imgs.map((m) => m[1].slice(4)))].sort(), 'every file in img/ is used, and only those');
});

test('the landing page and the maker link to the Mac page', () => {
  const landing = fs.readFileSync(path.join(WEB, 'index.html'), 'utf8');
  assert.match(landing, /<a class="l-top__link[^"]*" href="mac\/">Get the Mac app<\/a>/);
  const make = fs.readFileSync(path.join(WEB, 'make/index.html'), 'utf8');
  assert.match(make, /<a href="\.\.\/mac\/">Get the Mac app<\/a>/);
});
