'use strict';
// Link payload (section 5): codec, the shared vector, the trim ladder.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const zlib = require('zlib');
const { Engine, VECTOR, ROOT } = require('./support.js');

const fflate = require(path.join(ROOT, 'web', 'js', 'vendor', 'fflate.min.js'));
const clone = (value) => JSON.parse(JSON.stringify(value));

function bigStats(options) {
  const o = Object.assign({ senders: 12, quotes: 3, quoteLen: 180, awards: 6, nameLen: 40 }, options || {});
  let seed = 12345;
  const noise = (n) => {
    let out = '';
    for (let i = 0; i < n; i++) {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      out += String.fromCharCode(0x4E00 + (seed % 20000));
    }
    return out;
  };
  const stats = clone(VECTOR.stats);
  stats.senders = [];
  for (let i = 0; i < o.senders; i++) {
    stats.senders.push({
      name: noise(o.nameLen), messages: 1000 - i, share: 0.0833, words: 9000 + i, attachments: i,
      late_night: i * 3, reactions_given: i * 7, reactions_received: i * 5
    });
  }
  stats.most_reacted = [];
  for (let i = 0; i < o.quotes; i++) {
    stats.most_reacted.push({
      sender: stats.senders[i % o.senders].name, reactions: 9 - i, date: '2026-03-14',
      text: noise(o.quoteLen), kinds: { laugh: 9 - i }
    });
  }
  stats.awards = [];
  for (let i = 0; i < o.awards; i++) {
    stats.awards.push({
      id: 'a' + i, emoji: '\u2B50', title: 'Title ' + i, winner: stats.senders[i % o.senders].name, detail: noise(30)
    });
  }
  return stats;
}

function lengthAfter(stats, steps, quotes) {
  const trimmed = clone(stats);
  if (quotes === false) Engine.stripQuotes(trimmed);
  for (let step = 1; step <= steps; step++) Engine.applyTrimStep(trimmed, step);
  return [(Engine.BASE_URL + '#w1=' + Engine.encodePayload(trimmed)).length, trimmed];
}

for (const [name, codec] of [['zlib (Node)', null], ['fflate (browser)', fflate]]) {
  test('codec with ' + name + ': vector, round trip, format', () => {
    Engine.useCodec(codec);
    try {
      assert.deepEqual(Engine.decodePayload(VECTOR.payload), VECTOR.stats);
      assert.deepEqual(Engine.statsFromUrl(VECTOR.url), VECTOR.stats);
      for (const stats of [VECTOR.stats, {}, { chat: { name: '\u{1F32E} "quoted" \\ \u2028' } }, bigStats()]) {
        const encoded = Engine.encodePayload(stats);
        assert.match(encoded, /^[A-Za-z0-9_-]+$/);
        assert.deepEqual(Engine.decodePayload(encoded), stats);
      }
      const encoded = Engine.encodePayload(VECTOR.stats);
      const raw = zlib.inflateRawSync(Buffer.from(encoded, 'base64url')).toString('utf8');
      assert.equal(raw, JSON.stringify(VECTOR.stats));
      assert.ok(raw.includes('"name":"Dinner Club \u{1F35D}"'));
      // and the other implementation reads it too
      const other = codec ? zlib.inflateRawSync(Buffer.from(encoded, 'base64url')) : Buffer.from(fflate.inflateSync(new Uint8Array(Buffer.from(encoded, 'base64url'))));
      assert.equal(other.toString('utf8'), JSON.stringify(VECTOR.stats));
    } finally {
      Engine.useCodec(null);
    }
  });
}

test('decoder accepts padding and rejects rubbish', () => {
  const encoded = Engine.encodePayload({ v: 1 });
  assert.deepEqual(Engine.decodePayload(encoded + '='.repeat((4 - encoded.length % 4) % 4)), { v: 1 });
  assert.deepEqual(Engine.decodePayload('  ' + encoded + '\n'), { v: 1 });
  for (const bad of ['', '!!!', 'AAAA', encoded.slice(0, -3) + '@@@', null, 5, undefined]) {
    assert.throws(() => Engine.decodePayload(bad), Error, String(bad));
  }
  const notJson = zlib.deflateRawSync(Buffer.from('hello')).toString('base64url');
  assert.throws(() => Engine.decodePayload(notJson), /JSON/);
});

test('URL forms and constants', () => {
  const payload = VECTOR.payload;
  assert.equal(Engine.payloadFromUrl(Engine.BASE_URL + '#w1=' + payload), payload);
  assert.equal(Engine.payloadFromUrl(Engine.BASE_URL + '?w1=' + payload), payload);
  assert.equal(Engine.payloadFromUrl(Engine.BASE_URL + '?embed=ios&x=1#a=b&w1=' + payload), payload);
  assert.equal(Engine.payloadFromUrl('file:///index.html?demo=1&w1=' + payload + '#top'), payload);
  assert.equal(Engine.payloadFromUrl(Engine.BASE_URL + '?demo=1'), null);
  assert.equal(Engine.payloadFromUrl(null), null);
  assert.throws(() => Engine.statsFromUrl(Engine.BASE_URL), /no w1=/);
  assert.equal(Engine.BASE_URL, 'https://averyhsu.github.io/imessage-wrap/');
  assert.equal(Engine.MAX_URL_LENGTH, 4800);
  assert.equal(Engine.PRODUCT_NAME, 'Threadback');
  assert.ok(VECTOR.url.startsWith(Engine.BASE_URL + '#w1='));
});

test('step 1 deletes award details', () => {
  const stats = Engine.applyTrimStep(bigStats(), 1);
  assert.equal(stats.awards.length, 6);
  for (const award of stats.awards) assert.deepEqual(Object.keys(award).sort(), ['emoji', 'id', 'title', 'winner']);
});

test('step 2 truncates quotes to 60 characters', () => {
  const stats = bigStats();
  stats.most_reacted[1].text = 'short';
  stats.most_reacted[2].text = '\u{1F602}'.repeat(61);
  const original = stats.most_reacted[0].text;
  Engine.applyTrimStep(stats, 2);
  assert.equal(stats.most_reacted[0].text, original.slice(0, 60) + '\u2026');
  assert.equal(stats.most_reacted[1].text, 'short');
  assert.equal(stats.most_reacted[2].text, '\u{1F602}'.repeat(60) + '\u2026');
  const exactly = bigStats({ quoteLen: 60 });
  assert.deepEqual(Engine.applyTrimStep(clone(exactly), 2), exactly);
});

test('steps 3 and 6 keep the first senders; 4 keeps one quote; 5 deletes awards', () => {
  const stats = bigStats();
  const names = stats.senders.map((s) => s.name);
  Engine.applyTrimStep(stats, 3);
  assert.deepEqual(stats.senders.map((s) => s.name), names.slice(0, 8));
  const first = clone(stats.most_reacted[0]);
  Engine.applyTrimStep(stats, 4);
  assert.deepEqual(stats.most_reacted, [first]);
  Engine.applyTrimStep(stats, 5);
  assert.ok(!('awards' in stats));
  Engine.applyTrimStep(stats, 6);
  assert.deepEqual(stats.senders.map((s) => s.name), names.slice(0, 5));
});

test('steps tolerate missing sections', () => {
  for (let step = 1; step <= 6; step++) {
    assert.deepEqual(Engine.applyTrimStep({ v: 1 }, step), { v: 1 });
    const expected = { awards: null, senders: null, most_reacted: null };
    if (step === 5) delete expected.awards;
    assert.deepEqual(Engine.applyTrimStep({ awards: null, senders: null, most_reacted: null }, step), expected);
  }
  assert.throws(() => Engine.applyTrimStep({}, 7), RangeError);
});

test('nothing is trimmed when the link fits', () => {
  const result = Engine.fitLink(VECTOR.stats, { quotes: true });
  assert.equal(result.steps, 0);
  assert.deepEqual(result.stats, VECTOR.stats);
  assert.deepEqual(Engine.statsFromUrl(result.url), VECTOR.stats);
  assert.equal(result.length, result.url.length);
  assert.ok(result.length <= 4800);
  assert.equal(Engine.buildLink(VECTOR.stats, { quotes: true }), result.url);
});

test('the ladder stops at the first step that fits', () => {
  const stats = bigStats();
  const frozen = JSON.stringify(stats);
  const lengths = [0, 1, 2, 3, 4, 5, 6].map((steps) => lengthAfter(stats, steps)[0]);
  assert.deepEqual(lengths, lengths.slice().sort((a, b) => b - a));
  for (let steps = 0; steps <= 6; steps++) {
    if (steps && lengths[steps] === lengths[steps - 1]) continue;
    const result = Engine.fitLink(stats, { quotes: true, max_length: lengths[steps] });
    assert.equal(result.steps, steps);
    assert.equal(result.length, lengths[steps]);
    assert.deepEqual(result.stats, lengthAfter(stats, steps)[1]);
    assert.deepEqual(Engine.statsFromUrl(result.url), result.stats);
    if (steps) assert.equal(Engine.fitLink(stats, { quotes: true, maxLength: lengths[steps - 1] - 1 }).steps, steps);
  }
  assert.equal(JSON.stringify(stats), frozen);           // the input is never modified
});

test('default budget is 4,800 characters; too long is an error', () => {
  const stats = bigStats({ nameLen: 150 });
  assert.ok(lengthAfter(stats, 0)[0] > 4800);
  const result = Engine.fitLink(stats, { quotes: true });
  assert.ok(result.steps > 0);
  assert.ok(result.url.length <= 4800);
  assert.ok(lengthAfter(stats, result.steps - 1)[0] > 4800);
  const small = bigStats();
  assert.throws(() => Engine.fitLink(small, { quotes: true, max_length: lengthAfter(small, 6)[0] - 1 }),
    (error) => error.code === 'link_too_long' && /does not fit/.test(error.message));
  assert.throws(() => Engine.fitLink(small, { max_length: lengthAfter(small, 6, false)[0] - 1 }),
    (error) => error.code === 'link_too_long');
  const huge = bigStats();
  huge.chat.name = Array.from({ length: 4000 }, (_x, i) => String.fromCharCode(0x4E00 + (i * 7919) % 20000)).join('');
  assert.throws(() => Engine.buildLink(huge), (error) => error.code === 'link_too_long');
});

test('no quotes blanks the text before encoding', () => {
  const stats = bigStats();
  const loud = Engine.fitLink(stats, { quotes: true, max_length: 100000 });
  assert.deepEqual(loud.stats, stats);
  // message text is opt-in (section 5): saying nothing about quotes leaves it out
  for (const options of [{}, { quotes: false }, { no_quotes: true }, { noQuotes: true }, { quotes: 0 },
    { quotes: null }, { quotes: true, no_quotes: true }, { quotes: true, noQuotes: true }]) {
    const result = Engine.fitLink(stats, Object.assign({ max_length: 100000 }, options));
    assert.deepEqual(result.stats.most_reacted.map((q) => q.text), ['', '', ''], JSON.stringify(options));
    assert.deepEqual(result.stats.most_reacted.map((q) => q.reactions), [9, 8, 7]);
    assert.deepEqual(result.stats.most_reacted.map((q) => q.sender), stats.most_reacted.map((q) => q.sender));
    assert.equal(result.steps, 0);
    assert.ok(result.length < loud.length);
    assert.equal(Engine.buildLink(stats, Object.assign({ max_length: 100000 }, options)), result.url);
    for (const quote of stats.most_reacted) {
      assert.ok(!JSON.stringify(Engine.statsFromUrl(result.url)).includes(quote.text.slice(0, 20)));
    }
  }
  assert.deepEqual(Engine.statsFromUrl(Engine.buildLink(VECTOR.stats)).most_reacted.map((q) => q.text),
    VECTOR.stats.most_reacted.map(() => ''));
  assert.deepEqual(Engine.fitLink(VECTOR.stats), Engine.fitLink(VECTOR.stats, { quotes: false }));
  assert.equal(stats.most_reacted[0].text.length, 180);
  const budget = lengthAfter(stats, 3, false)[0];
  const trimmed = Engine.fitLink(stats, { quotes: false, max_length: budget });
  assert.equal(trimmed.steps, 3);
  assert.equal(trimmed.stats.senders.length, 8);
  const url = Engine.buildLink(VECTOR.stats, { quotes: true, base_url: 'http://localhost:4173/' });
  assert.ok(url.startsWith('http://localhost:4173/#w1='));
  assert.deepEqual(Engine.statsFromUrl(url), VECTOR.stats);
});

test('stats that are not a recap are refused with a code; odd shapes never break the ladder', () => {
  for (const bad of [[], [1, 2], 'text', 5, null, undefined, true]) {
    assert.throws(() => Engine.fitLink(bad), (error) => error.code === 'bad_stats', JSON.stringify(bad));
    assert.throws(() => Engine.buildLink(bad, { quotes: true }), (error) => error.code === 'bad_stats');
  }
  const odd = { v: 1, senders: 'nobody', most_reacted: { text: 'x' }, awards: 7 };
  const whole = Engine.fitLink(odd, { max_length: 100000 });
  assert.equal(whole.steps, 0);
  assert.deepEqual(whole.stats, odd);
  const result = Engine.fitLink(odd, { max_length: whole.length - 1 });
  assert.equal(result.steps, 5);                           // only "delete awards" helps
  assert.deepEqual(Engine.statsFromUrl(result.url), result.stats);
  assert.ok(!('awards' in result.stats));
  assert.deepEqual(Engine.stripQuotes({ most_reacted: [null, 5, { text: 'x' }, { sender: 'a' }] }),
    { most_reacted: [null, 5, { text: '' }, { sender: 'a', text: '' }] });
  for (const bad of ['', 'AAAA', '!!!', null, 5]) {
    assert.throws(() => Engine.decodePayload(bad), (error) => error.code === 'bad_payload', JSON.stringify(bad));
  }
  assert.throws(() => Engine.statsFromUrl(Engine.BASE_URL), (error) => error.code === 'bad_payload');
  assert.throws(() => Engine.applyTrimStep({}, 7), (error) => error.code === 'range');
});

test('base64url helpers', () => {
  const I = Engine._internals;
  for (let n = 0; n < 70; n++) {
    const data = Uint8Array.from({ length: n }, (_x, i) => (i * 37 + n) % 256);
    const encoded = I.base64urlEncode(data);
    assert.equal(encoded, Buffer.from(data).toString('base64url'));
    assert.deepEqual(Array.from(I.base64urlDecode(encoded)), Array.from(data));
    assert.deepEqual(Array.from(I.base64urlDecode(Buffer.from(data).toString('base64'))), Array.from(data));
  }
});
