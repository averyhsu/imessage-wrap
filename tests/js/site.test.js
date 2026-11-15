'use strict';
// Static checks on the deployed files: naming and address live in one place, the page is
// self-contained and locked down, and the link-preview assets meet Messages' requirements
// (docs/research/06-distribution-and-links.md, Apple TN3156).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const WEB = path.join(__dirname, '../../web');
const Config = require('../../web/js/config.js');
const html = fs.readFileSync(path.join(WEB, 'index.html'), 'utf8');

const read = (rel) => fs.readFileSync(path.join(WEB, rel));
const meta = (attr, name) => {
  const m = new RegExp(`<meta\\s+${attr}="${name}"\\s+content="([^"]*)"`, 'i').exec(html);
  return m ? m[1] : null;
};
const ownFiles = (dir, ext) => fs.readdirSync(path.join(WEB, dir)).filter((f) => f.endsWith(ext)).map((f) => path.join(dir, f));

test('config: one product name, one base URL', () => {
  assert.equal(Config.PRODUCT_NAME, 'Threadback');
  assert.match(Config.DESCRIPTOR, /year in review/);
  assert.match(Config.BASE_URL, /^https:\/\/[^/]+\/.*\/$/, 'absolute https URL ending in a slash');
  assert.equal(Config.MAX_URL_LENGTH, 4800);
  assert.equal(Config.PAYLOAD_KEY, 'w1');
});

test('index.html names the product and the address in exactly one block, in sync with config.js', () => {
  const start = html.indexOf('<!-- brand:start -->');
  const end = html.indexOf('<!-- brand:end -->');
  assert.ok(start > 0 && end > start, 'brand block markers exist');
  const block = html.slice(start, end);
  const outside = (html.slice(0, start) + html.slice(end)).replace(/<!--[\s\S]*?-->/g, '');

  assert.ok(!outside.includes(Config.PRODUCT_NAME), 'the product name appears nowhere outside the brand block');
  assert.ok(!outside.includes(Config.BASE_URL), 'the base URL appears nowhere outside the brand block');
  assert.ok(/<title>Threadback: /.test(block) || new RegExp(`<title>${Config.PRODUCT_NAME}\\b`).test(block), 'title starts with the product name');
  assert.ok(block.includes(Config.DESCRIPTOR), 'title carries the descriptor');

  assert.equal(meta('property', 'og:site_name'), Config.PRODUCT_NAME);
  assert.equal(meta('name', 'application-name'), Config.PRODUCT_NAME);
  assert.equal(meta('name', 'apple-mobile-web-app-title'), Config.PRODUCT_NAME);
  assert.equal(meta('property', 'og:url'), Config.BASE_URL);
  assert.equal(meta('property', 'og:image'), Config.BASE_URL + 'assets/og.png');
  assert.equal(meta('property', 'og:video'), Config.BASE_URL + 'assets/og-video.mp4');
  assert.equal(meta('property', 'og:video:secure_url'), Config.BASE_URL + 'assets/og-video.mp4');
  assert.equal(meta('name', 'twitter:image'), Config.BASE_URL + 'assets/og.png');
  assert.equal(/<link rel="canonical" href="([^"]+)"/.exec(html)[1], Config.BASE_URL);
  // Every mention inside the block is one of the two constants.
  const urls = block.match(/https?:\/\/[^"\s<]+/g) || [];
  assert.ok(urls.length >= 5 && urls.every((u) => u.startsWith(Config.BASE_URL)), 'every URL in the block uses the base URL');
});

test('link-preview tags are static and complete (Messages runs no JavaScript)', () => {
  const title = meta('property', 'og:title');
  assert.ok(title && title.length <= 40, 'og:title is short');
  assert.ok(!title.includes(Config.PRODUCT_NAME), 'og:title does not repeat the site name');
  assert.doesNotMatch(title, /wrapped|imessage/i);
  assert.equal(meta('property', 'og:type'), 'website');
  assert.equal(meta('property', 'og:video:type'), 'video/mp4');
  assert.equal(meta('property', 'og:video:width'), '1200');
  assert.equal(meta('property', 'og:video:height'), '630');
  assert.equal(meta('property', 'og:image:width'), '1200');
  assert.equal(meta('property', 'og:image:height'), '630');
  assert.equal(meta('name', 'twitter:card'), 'summary_large_image');
  assert.ok(meta('name', 'description').length > 50);
  assert.match(html, /<link rel="apple-touch-icon" href="assets\/apple-touch-icon\.png"/);
  assert.match(meta('name', 'viewport'), /viewport-fit=cover/);
  assert.ok(meta('name', 'theme-color'));
  assert.ok(Buffer.byteLength(html) < 1024 * 1024, 'page HTML is under 1 MB');
  assert.ok(Buffer.byteLength(html) < 20 * 1024, `page HTML stays small (${Buffer.byteLength(html)} bytes)`);
});

test('no borrowed trademarks in the static copy', () => {
  const text = html.replace(/<!--[\s\S]*?-->/g, '').replace(/<script[\s\S]*?<\/script>/g, '').replace(/<[^>]+>/g, ' ');
  // "Wrapped" is not a name here; /wrapped is the command people type in the chat.
  const wrapped = text.match(/\S*wrapped\S*/gi) || [];
  assert.ok(wrapped.length >= 2 && wrapped.every((w) => /^\/wrapped[.,]?$/.test(w)), `"wrapped" only as the command /wrapped: ${JSON.stringify(wrapped)}`);
  const mentions = text.match(/[^.]*imessage[^.]*\./gi) || [];
  assert.ok(mentions.length >= 1 && mentions.every((m) => /works with imessage|trademark of apple/i.test(m)), `"iMessage" only as a compatibility note: ${JSON.stringify(mentions)}`);
  assert.doesNotMatch(meta('name', 'description') + meta('property', 'og:description'), /wrapped|imessage/i);
});

test('the page does not claim a licence that has not been chosen', () => {
  // "Open source" is a statement about licensing. Until the owner picks a licence the
  // page says only what is true: the source is public.
  const text = html.replace(/<!--[\s\S]*?-->/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  assert.doesNotMatch(text, /open[- ]source/i);
  assert.match(text, /independent project; the source is public on GitHub/);
  for (const file of ownFiles('js', '.js')) {
    assert.doesNotMatch(fs.readFileSync(path.join(WEB, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, ''), /open[- ]source/i, `${file}: no licence claim in copy`);
  }
});

test('nothing the page links to carries a recap in the query string', () => {
  // ?w1= is readable (some transports drop fragments) but must never be produced: it would
  // put the recap in a request line. Static links first; generated ones are covered by the
  // codec tests (buildLink) and the end-to-end run (Copy link, WrappedStory.link()).
  const hrefs = [...html.replace(/<!--[\s\S]*?-->/g, '').matchAll(/\s(?:href|src|content)="([^"]*)"/g)].map((m) => m[1]);
  for (const h of hrefs) assert.doesNotMatch(h, /[?&]w1=/, `no query-form recap link in index.html (${h})`);
  assert.equal(/<link rel="canonical" href="([^"]+)"/.exec(html)[1].includes('?'), false, 'the canonical URL has no query string');
  for (const file of ownFiles('js', '.js')) {
    const code = fs.readFileSync(path.join(WEB, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.doesNotMatch(code, /['"`]\?w1=|['"`]&w1=|\?['"`]\s*\+\s*Config\.PAYLOAD_KEY/, `${file}: never builds a ?w1= URL`);
  }
});

test('hardening: strict CSP, no referrer, nothing inline', () => {
  const csp = /<meta http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(html)[1];
  const directives = Object.fromEntries(csp.split(';').map((d) => d.trim().split(/\s+/)).map(([k, ...v]) => [k, v.join(' ')]));
  assert.equal(directives['default-src'], "'none'");
  assert.equal(directives['script-src'], "'self'");
  assert.equal(directives['style-src'], "'self'");
  assert.equal(directives['font-src'], "'self'");
  assert.equal(directives['connect-src'], "'none'");
  assert.equal(directives['object-src'], "'none'");
  assert.equal(directives['base-uri'], "'none'");
  assert.equal(directives['form-action'], "'none'");
  assert.equal(directives['img-src'], "'self' data: blob:");
  assert.equal(directives['media-src'], "'self' blob:");
  assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval|\*|https?:/, 'no wildcards, hosts or unsafe keywords');
  assert.equal(meta('name', 'referrer'), 'no-referrer');

  const body = html.replace(/<!--[\s\S]*?-->/g, '');
  assert.doesNotMatch(body, /<script(?![^>]*\ssrc=)[^>]*>/i, 'no inline <script>');
  assert.doesNotMatch(body, /<style[\s>]/i, 'no inline <style>');
  assert.doesNotMatch(body, /\sstyle\s*=/i, 'no style attributes');
  assert.doesNotMatch(body, /\son[a-z]+\s*=/i, 'no inline event handlers');
  assert.doesNotMatch(body, /type="module"/i, 'classic scripts only');
  assert.doesNotMatch(body, /javascript:/i);
});

test('every asset the page references is a relative, existing, same-origin file', () => {
  const refs = [...html.replace(/<!--[\s\S]*?-->/g, '').matchAll(/\s(?:src|href)="([^"]+)"/g)].map((m) => m[1]);
  const local = refs.filter((r) => !/^(https?:|#|\?)/.test(r) && r !== './' && r !== 'make/');
  assert.ok(local.length >= 15, `found the local references (${local.length})`);
  for (const r of local) {
    assert.ok(!r.startsWith('/'), `${r} is relative (the site is served from a sub-path)`);
    assert.ok(fs.existsSync(path.join(WEB, r)), `${r} exists`);
  }
  const external = refs.filter((r) => /^https?:/.test(r));
  // Outbound links (never loaded as resources): the canonical URL and the source link.
  for (const r of external) assert.ok(r.startsWith(Config.BASE_URL) || r === 'https://github.com/averyhsu/imessage-wrap', `unexpected external reference ${r}`);
  const scripts = [...html.matchAll(/<script src="([^"]+)"/g)].map((m) => m[1]);
  assert.deepStrictEqual(scripts.filter((s) => /^(https?:)?\/\//.test(s)), [], 'no remote scripts');
  assert.ok(scripts.indexOf('js/config.js') < scripts.indexOf('js/codec.js'), 'config loads before the codec');
  assert.ok(scripts.indexOf('js/vendor/fflate.min.js') < scripts.indexOf('js/codec.js'), 'fflate loads before the codec');
  assert.equal(scripts[scripts.length - 1], 'js/app.js', 'app.js runs last');
});

test('scripts are classic, namespaced and make no network calls', () => {
  for (const file of ownFiles('js', '.js')) {
    const src = fs.readFileSync(path.join(WEB, file), 'utf8');
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.doesNotMatch(code, /^\s*(import|export)\s/m, `${file}: no ES module syntax`);
    assert.doesNotMatch(code, /\bfetch\s*\(|XMLHttpRequest|sendBeacon|WebSocket|EventSource|importScripts/, `${file}: no network APIs`);
    assert.doesNotMatch(code, /\beval\s*\(|new Function\s*\(|document\.write/, `${file}: no eval`);
    assert.doesNotMatch(code, /https?:\/\/(?!averyhsu\.github\.io\/imessage-wrap\/|www\.w3\.org\/)/, `${file}: no third-party URLs`);
    if (file !== path.join('js', 'boot.js') && file !== path.join('js', 'demo-data.js')) {
      assert.match(code, /root\.Wrapped[A-Z]\w+\s*=/, `${file}: exports one window.Wrapped… global`);
    }
  }
  // Recap strings never reach innerHTML: only the constant glyph markup does.
  for (const file of ['js/insights.js', 'js/slides.js', 'js/player.js', 'js/app.js', 'js/card.js']) {
    const code = fs.readFileSync(path.join(WEB, file), 'utf8');
    assert.doesNotMatch(code.replace(/\/\*[\s\S]*?\*\//g, ''), /innerHTML|insertAdjacentHTML|outerHTML/, `${file}: builds DOM without innerHTML`);
  }
});

test('stylesheets load nothing remote', () => {
  for (const file of ownFiles('css', '.css')) {
    const css = fs.readFileSync(path.join(WEB, file), 'utf8');
    assert.doesNotMatch(css, /@import/, `${file}: no @import`);
    const urls = [...css.matchAll(/url\(\s*["']?([^"')]+)/g)].map((m) => m[1]);
    for (const u of urls) assert.ok(u.startsWith('data:image/svg+xml,') || u.startsWith('../assets/'), `${file}: url(${u.slice(0, 40)}) is local`);
  }
  assert.ok(fs.existsSync(path.join(WEB, 'assets/fonts/OFL.txt')), 'the font licence ships with the font');
  assert.ok(fs.existsSync(path.join(WEB, 'js/vendor/fflate.LICENSE.txt')), 'the fflate licence ships with the library');
});

test('the landing page leads with the demo, then the Mac app, then the browser', () => {
  const body = html.replace(/<!--[\s\S]*?-->/g, '');
  const at = (needle) => { const i = body.indexOf(needle); assert.ok(i > 0, `found ${needle}`); return i; };
  // (1) what it is, the demo first; (2) the main way; (3) the alternative; (4) privacy.
  assert.match(body, /<div class="l-cta">\s*<a class="l-btn l-btn--primary" id="play-demo" href="\?demo=1">/, '"Play the demo" is the first button');
  assert.match(body, /<a class="l-btn" id="get-it" href="#get">Get it for your chat<\/a>/);
  const order = [at('id="play-demo"'), at('<section class="l-section l-get" id="get"'), at('id="get-mac" href="mac/"'), at('id="get-make" href="make/"'), at('id="privacy"')];
  assert.deepStrictEqual([...order].sort((a, b) => a - b), order, 'demo, Mac app, browser, privacy: in that order');
  const get = body.slice(at('id="get"'), at('id="privacy"'));
  const words = get.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  assert.match(words, /one person with a Mac \(macOS 14 or later\)/i, 'says it needs one person with a Mac');
  assert.match(words, /free and not signed through Apple’s paid developer program/, 'and that the app is not signed through Apple’s program');
  assert.match(words, /The Mac page walks you through that/, 'and that the Mac page covers the extra step');
  assert.match(words, /Nothing is installed or uploaded/, 'the browser way installs nothing');
  assert.equal((get.match(/<li>/g) || []).length, 3, 'how it works, in three steps');
  // The reply as it arrives: the Mac app's own card, from this site, light.
  const card = /<img class="l-thread__card" src="(assets\/reply-card\.webp)" alt="([^"]+)" width="(\d+)" height="(\d+)"/.exec(get);
  assert.ok(card, 'the reply card is on the page');
  assert.ok(card[2].length > 40, 'with a description');
  const file = read(card[1]);
  assert.ok(file.length < 60 * 1024, `the card is light (${Math.round(file.length / 1024)} KB)`);
  assert.equal(file.toString('latin1', 8, 12), 'WEBP');
  assert.ok(read('assets/og-thumb.webp').length < 20 * 1024, 'the link preview thumbnail is light');
  // The top bar: on a phone one link, to the section.
  assert.match(body, /<a class="l-top__link l-top__link--narrow" href="#get">/);
  // Privacy: one line about the Mac app.
  const privacy = body.slice(at('id="privacy"')).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  assert.match(privacy, /The Mac app It reads and counts on your Mac and uploads nothing\. Replies come from your own Apple ID, only in the chat you turned on, and the app itself never contacts a server\./);
});

test('the story\'s last slide points at the landing page\'s "get it" section', () => {
  assert.equal(Config.GET_PATH, './#get');
  const slides = fs.readFileSync(path.join(WEB, 'js/slides.js'), 'utf8');
  assert.match(slides, /makeLink\.href = Config\.GET_PATH;/);
  assert.match(slides, /'Get one for your chat {2}→'/);
  assert.match(html, /<section class="l-section l-get" id="get"/, 'and the landing page has that section');
  const app = fs.readFileSync(path.join(WEB, 'js/app.js'), 'utf8');
  assert.match(app, /showLanding\(\);\s*showAnchor\(\);/, 'arriving from a story, the landing page scrolls to it');
});

test('page weight stays small', () => {
  const scripts = [...html.matchAll(/<script src="([^"]+)"/g)].map((m) => m[1]);
  const styles = [...html.matchAll(/<link rel="stylesheet" href="([^"]+)"/g)].map((m) => m[1]).filter((s) => !s.includes('noscript'));
  const files = ['index.html', 'assets/fonts/archivo-latin.woff2', ...scripts, ...styles];
  const total = files.reduce((sum, f) => sum + fs.statSync(path.join(WEB, f)).size, 0);
  assert.ok(total < 600 * 1024, `first load is ${Math.round(total / 1024)} KB (budget 600 KB)`);
});

// ── binary assets ──────────────────────────────────────────────────────────────────────

function pngSize(buf) {
  assert.equal(buf.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', 'PNG signature');
  return [buf.readUInt32BE(16), buf.readUInt32BE(20)];
}

/** Top-level MP4 boxes as [type, offset, size]. */
function boxes(buf, start = 0, end = buf.length) {
  const out = [];
  for (let o = start; o + 8 <= end;) {
    let size = buf.readUInt32BE(o);
    const type = buf.toString('latin1', o + 4, o + 8);
    if (size === 1) size = Number(buf.readBigUInt64BE(o + 8));
    if (size < 8) break;
    out.push([type, o, size]);
    o += size;
  }
  return out;
}

test('og.png and the icons have the sizes link previews want', () => {
  assert.deepStrictEqual(pngSize(read('assets/og.png')), [1200, 630]);
  assert.ok(read('assets/og.png').length < 600 * 1024, 'og.png is light');
  assert.deepStrictEqual(pngSize(read('assets/apple-touch-icon.png')), [180, 180]);
  assert.deepStrictEqual(pngSize(read('assets/favicon-32.png')), [32, 32]);
  const svg = read('assets/favicon.svg').toString('utf8');
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  assert.doesNotMatch(svg, /<script|style=|href=/i, 'the SVG icon is inert');
});

test('og-video.mp4: H.264, yuv420p, faststart, no audio, 4-6 s, under 3 MB', () => {
  const mp4 = read('assets/og-video.mp4');
  assert.ok(mp4.length < 3 * 1024 * 1024, `video is ${Math.round(mp4.length / 1024)} KB (limit 3 MB)`);
  const top = boxes(mp4);
  const order = top.map((b) => b[0]);
  assert.equal(order[0], 'ftyp');
  assert.ok(order.includes('moov') && order.includes('mdat'), 'has moov and mdat');
  assert.ok(order.indexOf('moov') < order.indexOf('mdat'), 'moov comes before mdat (faststart): ' + order.join(' '));

  const [, moovAt, moovSize] = top.find((b) => b[0] === 'moov');
  const moov = boxes(mp4, moovAt + 8, moovAt + moovSize);
  const tracks = moov.filter((b) => b[0] === 'trak');
  assert.equal(tracks.length, 1, 'exactly one track (video only, no audio)');
  const text = mp4.toString('latin1', moovAt, moovAt + moovSize);
  assert.ok(text.includes('vide'), 'the track is video');
  assert.ok(!text.includes('soun'), 'there is no sound handler');
  assert.ok(text.includes('avc1'), 'codec is H.264 (avc1)');

  // Duration from mvhd.
  const [, mvhdAt] = moov.find((b) => b[0] === 'mvhd');
  const version = mp4[mvhdAt + 8];
  const timescale = mp4.readUInt32BE(mvhdAt + (version === 1 ? 28 : 20));
  const duration = version === 1 ? Number(mp4.readBigUInt64BE(mvhdAt + 32)) : mp4.readUInt32BE(mvhdAt + 24);
  const seconds = duration / timescale;
  assert.ok(seconds >= 4 && seconds <= 6, `duration is ${seconds.toFixed(2)} s`);

  // Frame size from the avc1 sample entry; chroma format and bit depth from avcC.
  const avc1 = mp4.indexOf(Buffer.from('avc1', 'latin1'), moovAt);
  assert.deepStrictEqual([mp4.readUInt16BE(avc1 + 28), mp4.readUInt16BE(avc1 + 30)], [1200, 630], 'frame is 1200 × 630');
  assert.deepStrictEqual([meta('property', 'og:video:width'), meta('property', 'og:video:height')], ['1200', '630'], 'matches the og:video tags');
  const avcC = mp4.indexOf(Buffer.from('avcC', 'latin1'), avc1);
  assert.ok(avcC > 0, 'has an avcC box');
  const profile = mp4[avcC + 5];
  assert.ok([66, 77, 100].includes(profile), `profile ${profile} is Baseline/Main/High (8-bit 4:2:0 only)`);
  if (profile === 100) {
    // High profile carries chroma_format_idc explicitly after the parameter sets.
    const size = mp4.readUInt32BE(avcC - 4);
    const tail = mp4.subarray(avcC + size - 8, avcC + size - 4);
    assert.equal(tail[0] & 0x03, 1, 'chroma format is 4:2:0');
    assert.equal(tail[1] & 0x07, 0, 'luma is 8-bit');
  }
});
