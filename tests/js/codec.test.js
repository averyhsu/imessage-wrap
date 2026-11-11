'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const path = require('node:path');

const Codec = require('../../web/js/codec.js');
const Config = require('../../web/js/config.js');
const vector = require('../vectors/payload-v1.json');

const clone = (o) => JSON.parse(JSON.stringify(o));

test('decodes the cross-language vector exactly', () => {
  assert.deepStrictEqual(Codec.decode(vector.payload), vector.stats);
});

test('reads the payload out of the vector URL (fragment form)', () => {
  const parsed = Codec.parseLocation(vector.url);
  assert.equal(parsed.source, 'fragment');
  assert.equal(parsed.payload, vector.payload);
  assert.deepStrictEqual(Codec.decode(parsed.payload), vector.stats);
});

test('round trip: encode → decode', () => {
  const payload = Codec.encode(vector.stats);
  assert.match(payload, /^[A-Za-z0-9_-]+$/, 'base64url, no padding');
  assert.deepStrictEqual(Codec.decode(payload), vector.stats);
});

test('encode produces raw DEFLATE that zlib can inflate', () => {
  const payload = Codec.encode(vector.stats);
  const json = zlib.inflateRawSync(Buffer.from(payload, 'base64url')).toString('utf8');
  assert.equal(json, JSON.stringify(vector.stats));
});

test('decode accepts raw DEFLATE produced by zlib (any compression level)', () => {
  for (const level of [1, 6, 9]) {
    const payload = zlib.deflateRawSync(Buffer.from(JSON.stringify(vector.stats)), { level }).toString('base64url');
    assert.deepStrictEqual(Codec.decode(payload), vector.stats);
  }
});

test('round trip keeps emoji, astral characters and quotes intact', () => {
  const stats = { v: 1, chat: { name: 'Dinner Club 🍝 “quoted” 👩‍👩‍👧‍👦 中文', members: 3 }, totals: { messages: 1 } };
  assert.deepStrictEqual(Codec.decode(Codec.encode(stats)), stats);
});

test('decode tolerates what messaging apps do to links', () => {
  const p = vector.payload;
  assert.deepStrictEqual(Codec.decode(p + '.'), vector.stats, 'trailing full stop');
  assert.deepStrictEqual(Codec.decode(' ' + p + '\n'), vector.stats, 'whitespace');
  assert.deepStrictEqual(Codec.decode(p.replace(/-/g, '+').replace(/_/g, '/') + '=='), vector.stats, 'classic base64 with padding');
  assert.deepStrictEqual(Codec.decode(encodeURIComponent(p.replace(/-/g, '+'))), vector.stats, 'percent-encoded');
});

test('decode rejects garbage with a WrappedCodecError', () => {
  for (const bad of ['', '!!!', 'AAAA', 'not-a-payload', null, undefined]) {
    assert.throws(() => Codec.decode(bad), { name: 'WrappedCodecError' }, String(bad));
  }
  const notObject = zlib.deflateRawSync(Buffer.from('[1,2,3]')).toString('base64url');
  assert.throws(() => Codec.decode(notObject), { name: 'WrappedCodecError', code: 'shape' });
  assert.throws(() => Codec.decode('A'.repeat(30000)), { name: 'WrappedCodecError', code: 'too_long' });
});

test('parseLocation: fragment, query, demo and embed forms', () => {
  const base = 'https://example.test/app/';
  assert.deepStrictEqual(Codec.parseLocation(base), { payload: null, source: null, demo: false, embed: null });
  assert.deepStrictEqual(Codec.parseLocation(base + '?demo=1'), { payload: null, source: null, demo: true, embed: null });
  assert.equal(Codec.parseLocation(base + '?w1=abc_-DEF').payload, 'abc_-DEF');
  assert.equal(Codec.parseLocation(base + '?w1=abc_-DEF').source, 'query');
  assert.equal(Codec.parseLocation(base + '#w1=abc').source, 'fragment');
  assert.equal(Codec.parseLocation(base + '?w1=QUERY#w1=FRAGMENT').payload, 'FRAGMENT', 'fragment wins');
  const embed = Codec.parseLocation('file:///bundle/web/index.html?embed=ios#w1=abc');
  assert.equal(embed.embed, 'ios');
  assert.equal(embed.payload, 'abc');
  // A Location-like object works too.
  assert.equal(Codec.parseLocation({ hash: '#w1=xyz', search: '?embed=ios' }).payload, 'xyz');
  assert.equal(Codec.parseLocation({ hash: '', search: '?utm=1&w1=xyz&x=2' }).payload, 'xyz');
});

test('buildLink: the demo recap fits without trimming', () => {
  const plan = Codec.planLink(vector.stats);
  assert.deepStrictEqual(plan.steps, []);
  assert.ok(plan.url.startsWith(Config.BASE_URL + '#w1='));
  assert.ok(plan.length <= 4800);
  assert.equal(plan.url, Codec.buildLink(vector.stats));
  assert.deepStrictEqual(Codec.decode(Codec.parseLocation(plan.url).payload), vector.stats);
  assert.ok(Codec.buildLink(vector.stats, { form: 'query' }).startsWith(Config.BASE_URL + '?w1='));
});

test('buildLink: "no quotes" blanks every most_reacted text and nothing else', () => {
  const plan = Codec.planLink(vector.stats, { quotes: false });
  const got = Codec.decode(plan.payload);
  assert.deepStrictEqual(got.most_reacted.map((m) => m.text), ['', '', '']);
  const expected = clone(vector.stats);
  expected.most_reacted.forEach((m) => { m.text = ''; });
  assert.deepStrictEqual(got, expected);
  assert.equal(vector.stats.most_reacted[0].text.length > 0, true, 'input is not mutated');
});

// A recap that compresses badly: 12 senders with long random-looking names, long quotes,
// long award details. `noise` controls how far over budget it goes.
function bulky(noise) {
  let seed = 7;
  const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed; };
  const junk = (len) => { let s = ''; while (s.length < len) s += rand().toString(36); return s.slice(0, len); };
  const s = clone(vector.stats);
  s.senders = [];
  for (let i = 0; i < 12; i++) {
    s.senders.push({ name: junk(noise), messages: 5000 - i * 311, share: 0.08, words: rand() % 90000, attachments: rand() % 900, late_night: rand() % 900, reactions_given: rand() % 900, reactions_received: rand() % 900 });
  }
  s.most_reacted = [0, 1, 2].map((i) => ({ sender: junk(8), reactions: 9 - i, date: '2026-03-1' + i, text: junk(180) + '…', kinds: { laugh: 5, love: 4 - i } }));
  s.awards = [0, 1, 2, 3, 4, 5].map((i) => ({ id: 'a' + i, emoji: '🏆', title: junk(14), winner: junk(noise), detail: junk(70) }));
  return s;
}

test('buildLink: trim ladder is applied in order and stops as soon as the link fits', () => {
  const seen = new Set();
  for (let noise = 20; noise <= 800; noise += 10) {
    const stats = bulky(noise);
    const untrimmedLength = (Config.BASE_URL + '#w1=' + Codec.encode(stats)).length;
    let plan;
    try { plan = Codec.planLink(stats); } catch (e) { assert.equal(e.code, 'too_long'); seen.add('error'); continue; }
    assert.ok(plan.length <= 4800, `fits (${plan.length})`);
    assert.equal(plan.url.length, plan.length);
    // Steps are always a prefix of the ladder.
    assert.deepStrictEqual(plan.steps, Codec.TRIM_STEPS.slice(0, plan.steps.length));
    assert.equal(plan.steps.length === 0, untrimmedLength <= 4800);
    seen.add(plan.steps.length);

    // The link carries exactly the trimmed stats.
    const carried = Codec.decode(plan.payload);
    assert.deepStrictEqual(carried, plan.stats);
    const k = plan.steps.length;
    if (k >= 1 && k < 5) assert.ok(carried.awards.every((a) => !('detail' in a)), 'step 1: no award details');
    if (k >= 2) assert.ok(carried.most_reacted.every((m) => Array.from(m.text).length <= 61 && m.text.endsWith('…')), 'step 2: quotes cut to 60 + …');
    if (k >= 3) assert.ok(carried.senders.length <= 8, 'step 3: 8 senders');
    if (k >= 4) assert.equal(carried.most_reacted.length, 1, 'step 4: one quote');
    if (k >= 5) assert.equal('awards' in carried, false, 'step 5: no awards');
    if (k >= 6) assert.equal(carried.senders.length, 5, 'step 6: 5 senders');
    if (k < 3) assert.equal(carried.senders.length, 12);
    if (k < 4) assert.equal(carried.most_reacted.length, 3);

    // One step fewer would not have fit.
    if (k > 0) {
      const fewer = Codec.planLink(stats, { maxLength: 1e9 }).stats; // untouched copy
      const ladder = [
        (s) => s.awards.forEach((a) => delete a.detail),
        (s) => s.most_reacted.forEach((m) => { const c = Array.from(m.text); if (c.length > 60) m.text = c.slice(0, 60).join('') + '…'; }),
        (s) => { s.senders = s.senders.slice(0, 8); },
        (s) => { s.most_reacted = s.most_reacted.slice(0, 1); },
        (s) => { delete s.awards; },
        (s) => { s.senders = s.senders.slice(0, 5); },
      ];
      for (let j = 0; j < k - 1; j++) ladder[j](fewer);
      assert.ok((Config.BASE_URL + '#w1=' + Codec.encode(fewer)).length > 4800, 'previous step alone was not enough');
    }
  }
  // The sweep must exercise every rung of the ladder, the no-trim case and the failure.
  for (const k of [0, 1, 2, 3, 4, 5, 6, 'error']) assert.ok(seen.has(k), `sweep reached outcome ${k} (saw ${[...seen].join(', ')})`);
});

test('buildLink: short quotes are left alone by the 60-character step', () => {
  const stats = bulky(60);
  stats.most_reacted[0].text = 'short one';
  stats.most_reacted[1].text = '🍝'.repeat(60); // exactly 60 code points
  const afterStepOne = clone(stats);
  afterStepOne.awards.forEach((a) => delete a.detail);
  const budget = (Config.BASE_URL + '#w1=' + Codec.encode(afterStepOne)).length - 1; // step 1 alone is not enough
  const plan = Codec.planLink(stats, { maxLength: budget });
  assert.deepStrictEqual(plan.steps, Codec.TRIM_STEPS.slice(0, 2));
  assert.equal(plan.stats.most_reacted[0].text, 'short one');
  assert.equal(plan.stats.most_reacted[1].text, '🍝'.repeat(60));
  assert.equal(Array.from(plan.stats.most_reacted[2].text).length, 61);
  assert.ok(plan.stats.most_reacted[2].text.endsWith('…'));
});

test('buildLink: fails with a clear error when nothing fits, and never mutates its input', () => {
  const stats = bulky(1000);
  const before = JSON.stringify(stats);
  assert.throws(() => Codec.buildLink(stats), (e) => {
    assert.equal(e.name, 'WrappedCodecError');
    assert.equal(e.code, 'too_long');
    assert.match(e.message, /4800/);
    return true;
  });
  assert.equal(JSON.stringify(stats), before);
});

test('buildLink: honours a custom base and budget', () => {
  const url = Codec.buildLink(vector.stats, { base: 'https://example.test/x/' });
  assert.ok(url.startsWith('https://example.test/x/#w1='));
  assert.throws(() => Codec.buildLink(vector.stats, { maxLength: 200 }), { code: 'too_long' });
});

test('codec file is a classic script (no ES module syntax)', () => {
  const src = require('node:fs').readFileSync(path.join(__dirname, '../../web/js/codec.js'), 'utf8');
  assert.doesNotMatch(src, /^\s*(import|export)\s/m);
});
