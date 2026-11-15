'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { normalize, computePersonality } = require('../../web/js/normalize.js');
const Engine = require('../../web/make/engine.js');
const vector = require('../vectors/payload-v1.json');

const clone = (o) => JSON.parse(JSON.stringify(o));

function loadDemo() {
  const sandbox = { window: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../web/js/demo-data.js'), 'utf8'), sandbox);
  return JSON.parse(JSON.stringify(sandbox.window.WRAPPED_DEMO));
}

test('v1 input passes through unchanged', () => {
  // The vector is a link made before personalities carried an emoji: normalize adds the one
  // for its id, and nothing else changes.
  const expected = clone(vector.stats);
  expected.personality.emoji = '\u{1F989}';
  assert.deepStrictEqual(normalize(vector.stats), expected);
  const demo = loadDemo();
  assert.deepStrictEqual(normalize(demo), demo);
});

test('normalize is idempotent and does not mutate its input', () => {
  const input = clone(vector.stats);
  const once = normalize(input);
  assert.deepStrictEqual(input, vector.stats);
  assert.deepStrictEqual(normalize(once), once);
});

test('demo data is valid v1 and its sums are consistent', () => {
  const demo = loadDemo();
  assert.deepStrictEqual(normalize(demo), demo, 'demo-data.js is already in normal form');
  const sum = (a) => a.reduce((x, y) => x + y, 0);
  const T = demo.totals.messages;
  assert.equal(demo.by_hour.length, 24);
  assert.equal(demo.by_weekday.length, 7);
  assert.equal(demo.by_month.length, 12);
  assert.equal(sum(demo.by_hour), T, 'by_hour sums to the total');
  assert.equal(sum(demo.by_weekday), T, 'by_weekday sums to the total');
  assert.equal(sum(demo.by_month), T, 'by_month sums to the total');
  assert.equal(sum(demo.senders.map((s) => s.messages)), T, 'senders sum to the total');
  assert.equal(sum(demo.senders.map((s) => s.words)), demo.totals.words, 'words sum to the total');
  assert.equal(sum(demo.senders.map((s) => s.attachments)), demo.totals.attachments, 'attachments sum to the total');
  assert.equal(sum(demo.senders.map((s) => s.reactions_given)), demo.totals.reactions, 'tapbacks given sum to the total');
  assert.equal(sum(demo.senders.map((s) => s.reactions_received)), demo.totals.reactions, 'tapbacks received sum to the total');
  assert.equal(sum(Object.values(demo.reactions.by_kind)), demo.totals.reactions, 'tapback kinds sum to the total');
  assert.equal(sum(demo.senders.map((s) => s.late_night)), demo.late_night.messages, 'late-night senders sum to the late-night total');
  assert.equal(sum(demo.by_hour.slice(0, 5)), demo.late_night.messages, 'late night equals hours 0..4');
  assert.equal(demo.late_night.share, Math.round((demo.late_night.messages / T) * 10000) / 10000);
  for (const s of demo.senders) assert.equal(s.share, Math.round((s.messages / T) * 10000) / 10000, `share of ${s.name}`);
  for (const m of demo.most_reacted) assert.equal(sum(Object.values(m.kinds)), m.reactions, `kinds of "${m.text}"`);
  assert.equal(demo.chat.members, demo.senders.length);
  // The personality is what the engines' rule (SCHEMA §3) gives for the demo's own numbers.
  const I = Engine._internals;
  const days = (Date.parse(demo.period.end) - Date.parse(demo.period.start)) / 86400000 + 1;
  assert.equal(days, 314);
  const figures = I.personalityFigures(demo.totals, demo.by_hour, demo.by_weekday, demo.by_month, days,
    demo.busiest_day.messages, demo.reactions.by_kind, demo.senders.map((s) => s.messages));
  assert.deepStrictEqual(I.personality(figures), demo.personality, 'personality follows SCHEMA §3');
  assert.ok(demo.awards.length <= 6);
  const order = I.AWARDS.map((a) => a[0]);
  for (const a of demo.awards) {
    const row = I.AWARDS.find((x) => x[0] === a.id);
    assert.ok(row, a.id + ' is an award of SCHEMA §4');
    assert.deepStrictEqual([a.emoji, a.title], [row[1], row[2]], a.id);
  }
  assert.deepStrictEqual(demo.awards.map((a) => a.id), demo.awards.map((a) => a.id).sort((x, y) => order.indexOf(x) - order.indexOf(y)),
    'awards in table order (every winner holds one award, so none were deferred)');
  assert.equal(new Set(demo.awards.map((a) => a.winner)).size, demo.awards.length);
  assert.equal(demo.reactions.top_giver.count, Math.max(...demo.senders.map((s) => s.reactions_given)));
  assert.equal(demo.reactions.top_receiver.count, Math.max(...demo.senders.map((s) => s.reactions_received)));
  assert.equal(demo.late_night.top.messages, Math.max(...demo.senders.map((s) => s.late_night)));
  const text = JSON.stringify(demo);
  assert.doesNotMatch(text, /wrapped\b(?!\/1)/i, 'no product-name leftovers in demo copy');
});

test('legacy prototype shape is mapped onto v1', () => {
  const legacy = {
    chat_name: 'The Old Prototype Chat',
    year: 2025,
    total_messages: 600,
    total_words: 2400,
    messages_by_hour: Object.fromEntries(Array.from({ length: 24 }, (_, h) => [String(h), 25])),
    messages_by_weekday: { Monday: 50, Tuesday: 50, Wednesday: 50, Thursday: 50, Friday: 100, Saturday: 200, Sunday: 100 },
    messages_by_month: { '1': 100, '2': 50, '7': 300, '12': 150 },
    top_senders: [{ name: 'Robin', count: 400 }, { name: 'Sky', count: 200 }],
    most_reacted: [{ sender: 'Robin', reactions: 5, date: '2025-07-04', text: 'legacy quote' }],
  };
  const s = normalize(legacy);
  assert.equal(s.v, 1);
  assert.equal(s.chat.name, 'The Old Prototype Chat');
  assert.equal(s.chat.members, 2);
  assert.equal(s.period.label, '2025');
  assert.equal(s.totals.messages, 600);
  assert.equal(s.totals.words, 2400);
  assert.deepStrictEqual(s.by_hour, new Array(24).fill(25));
  assert.deepStrictEqual(s.by_weekday, [50, 50, 50, 50, 100, 200, 100]);
  assert.deepStrictEqual(s.by_month, [100, 50, 0, 0, 0, 0, 300, 0, 0, 0, 0, 150]);
  assert.deepStrictEqual(s.senders.map((x) => [x.name, x.messages, x.share]), [['Robin', 400, 0.6667], ['Sky', 200, 0.3333]]);
  assert.deepStrictEqual(s.most_reacted, [{ sender: 'Robin', reactions: 5, date: '2025-07-04', text: 'legacy quote', kinds: {} }]);
  // Sections the prototype never had are derived or empty, never undefined.
  // every hour ties, so the first (midnight) is the peak hour
  assert.deepStrictEqual(s.personality, {
    id: 'night_owls', emoji: '\u{1F989}', title: 'The Night Owls', reason: 'Peak hour: 12 AM',
    blurb: 'Peak hour: 12 AM. Sleep is a suggestion.', peak_hour: 0
  });
  assert.deepStrictEqual(s.late_night, { messages: 125, share: 0.2083, top: null });
  assert.equal(s.reactions, null);
  assert.deepStrictEqual(s.awards, []);
  assert.equal(s.busiest_day, null);
});

test('legacy bucket key variants', () => {
  const base = { chat_name: 'x', total_messages: 10 };
  assert.deepStrictEqual(normalize({ ...base, messages_by_weekday: { '0': 1, '6': 7 } }).by_weekday, [1, 0, 0, 0, 0, 0, 7]);
  assert.deepStrictEqual(normalize({ ...base, messages_by_weekday: { Mon: 2, sun: 3 } }).by_weekday, [2, 0, 0, 0, 0, 0, 3]);
  assert.deepStrictEqual(normalize({ ...base, messages_by_weekday: [1, 2, 3, 4, 5, 6, 7] }).by_weekday, [1, 2, 3, 4, 5, 6, 7]);
  assert.deepStrictEqual(normalize({ ...base, messages_by_month: { '2025-01': 4, '2025-12': 6 } }).by_month, [4, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 6]);
  assert.deepStrictEqual(normalize({ ...base, messages_by_month: { '2024-03': 4, '2025-03': 6 } }).by_month[2], 10, 'same month over two years is summed');
  assert.deepStrictEqual(normalize({ ...base, messages_by_month: { '01': 4, '12': 6 } }).by_month, [4, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 6]);
  assert.deepStrictEqual(normalize({ ...base, messages_by_month: { '0': 4, '11': 6 } }).by_month, [4, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 6]);
  assert.deepStrictEqual(normalize({ ...base, messages_by_month: { January: 4, Dec: 6 } }).by_month, [4, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 6]);
  assert.deepStrictEqual(normalize({ ...base, messages_by_hour: [1, 2, 3] }).by_hour.slice(0, 4), [1, 2, 3, 0]);
  assert.equal(normalize({ ...base, messages_by_hour: [1, 2, 3] }).by_hour.length, 24);
  assert.deepStrictEqual(normalize({ ...base, messages_by_sender: { Ann: 7, Bo: 3 } }).senders.map((s) => s.name), ['Ann', 'Bo']);
  assert.deepStrictEqual(normalize({ ...base, top_senders: [['Ann', 7], ['Bo', 3]] }).senders.map((s) => s.messages), [7, 3]);
});

test('missing optional sections come back empty, not broken', () => {
  const s = normalize({ v: 1, chat: { name: 'Bare', members: 2 }, period: { label: '2026' }, totals: { messages: 60 } });
  assert.equal(s.totals.messages, 60);
  assert.deepStrictEqual(s.by_hour, new Array(24).fill(0));
  assert.deepStrictEqual(s.by_weekday, new Array(7).fill(0));
  assert.deepStrictEqual(s.by_month, new Array(12).fill(0));
  assert.deepStrictEqual(s.senders, []);
  assert.deepStrictEqual(s.most_reacted, []);
  assert.deepStrictEqual(s.awards, []);
  assert.equal(s.reactions, null);
  assert.equal(s.late_night, null);
  assert.equal(s.busiest_day, null);
  assert.equal(s.personality, null, 'no hours, no personality');
  assert.deepStrictEqual(s.period, { label: '2026', start: '', end: '' });
});

test('"no quotes" recaps and awards without detail survive', () => {
  const input = clone(vector.stats);
  input.most_reacted.forEach((m) => { m.text = ''; });
  input.awards.forEach((a) => { delete a.detail; });
  const s = normalize(input);
  assert.deepStrictEqual(s.most_reacted.map((m) => m.text), ['', '', '']);
  assert.equal(s.most_reacted[0].reactions, 6);
  assert.deepStrictEqual(s.awards.map((a) => a.detail), ['', '', '', '', '', '']);
  assert.equal(s.awards.length, 6);
});

test('untrusted input is sanitised', () => {
  const s = normalize({
    chat: { name: '  <img src=x onerror=alert(1)>\u0000‮ evil\n\nname  ', members: '7' },
    period: { label: { nested: true }, start: '2026-01-01<script>', end: 'yesterday' },
    totals: { messages: '48,213', words: -5, attachments: Infinity, reactions: 'NaN', days_active: 1e400 },
    by_hour: ['1', -2, null, 4.6, {}, 'x'],
    senders: [
      { name: 'A'.repeat(500), messages: 10 },
      { name: '', messages: 99 },
      { messages: 5 },
      'not an object',
      { name: 'Zed', messages: '20', share: 45 },
    ],
    most_reacted: [{ sender: 'Q', reactions: 3, text: 'x'.repeat(2000), date: '2026-99-99', kinds: { laugh: 2, sticker: 1, bogus: -1 } }, null, 5],
    awards: [{ title: 'T', winner: 'W', emoji: '🏆'.repeat(40), detail: 12345 }, { title: '', winner: 'nobody' }, 'x'],
    reactions: { by_kind: { love: '3', like: -1, __proto__: 5 }, top_giver: { name: 'G', count: 'lots' }, top_receiver: 'x' },
    late_night: { messages: 4, share: 'big', top: { name: 'N', messages: 3 } },
    meta: { generator: {}, generated: 'today' },
    unknown_key: { ignored: true },
  });
  assert.equal(s.chat.name, '<img src=x onerror=alert(1)> evil name', 'kept as text (the DOM is built with textContent), control characters gone');
  assert.equal(s.chat.members, 7);
  assert.deepStrictEqual(s.period, { label: '2026', start: '2026-01-01', end: '' });
  assert.deepStrictEqual(s.totals, { messages: 48213, words: 0, attachments: 0, reactions: 3, days_active: 0, longest_streak: 0 });
  assert.deepStrictEqual(s.by_hour.slice(0, 6), [1, 0, 0, 5, 0, 0]);
  assert.deepStrictEqual(s.senders.map((x) => x.name.length), [3, 60]);
  assert.equal(s.senders[0].name, 'Zed');
  assert.equal(s.senders[0].share, 0.45, 'a percentage is read as a share');
  assert.equal(s.most_reacted.length, 1);
  assert.equal(Array.from(s.most_reacted[0].text).length, 400);
  assert.equal(s.most_reacted[0].date, '');
  assert.deepStrictEqual(s.most_reacted[0].kinds, { laugh: 2, emoji: 1 });
  assert.equal(s.awards.length, 1);
  assert.equal(Array.from(s.awards[0].emoji).length, 12);
  assert.equal(s.awards[0].detail, '12345');
  assert.equal(s.reactions.by_kind.love, 3);
  assert.equal(s.reactions.by_kind.like, 0);
  assert.deepStrictEqual(s.reactions.top_giver, { name: 'G', count: 0 });
  assert.equal(s.reactions.top_receiver, null);
  assert.deepStrictEqual(s.late_night, { messages: 4, share: 0.0001, top: { name: 'N', messages: 3 } });
  assert.deepStrictEqual(s.meta, { generator: '', source: '', generated: '' });
  assert.equal('unknown_key' in s, false);
  assert.equal(Object.prototype.hasOwnProperty.call(s.reactions.by_kind, '__proto__'), false);
});

test('text that would not paint counts as no text', () => {
  const input = clone(vector.stats);
  input.most_reacted[0].text = '\u200B\u2800 \u3164\uFE0F';
  input.most_reacted[1].text = '\u200Bhi\u200B';
  input.chat.name = '\u2800\u2800';
  const out = normalize(input);
  assert.equal(out.most_reacted[0].text, '', 'a "blank message" is treated like a recap without quotes');
  assert.ok(out.most_reacted[0].reactions > 0, 'and keeps its tapbacks');
  assert.equal(out.most_reacted[1].text, '\u200Bhi\u200B', 'visible text is left alone');
  assert.ok(out.chat.name.length > 0 && /\S/.test(out.chat.name) && !/\u2800/.test(out.chat.name), 'an invisible chat name falls back to a visible one');
  // Emoji sequences use joiners and variation selectors; they are not "invisible".
  input.most_reacted[0].text = '\u2764\uFE0F';
  assert.equal(normalize(input).most_reacted[0].text, '\u2764\uFE0F');
});

test('absurd numbers are capped, and shares stay within 0..1', () => {
  const { MAX_COUNT } = require('../../web/js/normalize.js');
  assert.equal(MAX_COUNT, 9999999999);
  const F = require('../../web/js/format.js');
  const s = normalize({
    chat: { name: 'Big numbers', members: 1e300 },
    totals: { messages: 1e21, words: 1e308, attachments: '1e25', reactions: 9e99, days_active: 1e400, longest_streak: Number.MAX_VALUE },
    by_hour: new Array(24).fill(1e30),
    by_weekday: new Array(7).fill(1e22),
    by_month: { '2026-01': 1e21, '2027-01': 1e21 },
    busiest_day: { date: '2026-07-04', messages: 1e50 },
    late_night: { messages: 1e40, share: 1e9, top: { name: 'N', messages: 1e21 } },
    senders: [{ name: 'A', messages: 1e21, share: 7e30, words: 1e99, reactions_given: 1e21 }, { name: 'B', messages: 5, share: -3 }],
    most_reacted: [{ sender: 'A', reactions: 1e21, text: 'x', kinds: { laugh: 1e21, sticker: 1e21, other: 1e21 } }],
    reactions: { by_kind: { love: 1e21, like: 1e308 }, top_giver: { name: 'A', count: 1e21 }, top_receiver: { name: 'B', count: 1e99 } },
  });
  const numbers = [];
  (function walk(v) {
    if (typeof v === 'number') numbers.push(v);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  })(s);
  assert.ok(numbers.length > 60);
  for (const v of numbers) {
    assert.ok(Number.isFinite(v) && v >= 0 && v <= MAX_COUNT, `every number is finite and capped (${v})`);
    assert.match(F.int(v), /^\d{1,3}(,\d{3})*$/, `prints as plain digits (${v})`);
  }
  assert.equal(s.totals.messages, MAX_COUNT);
  assert.equal(s.totals.days_active, 0, 'a value that overflows to Infinity is dropped, not shown');
  assert.equal(s.by_month[0], MAX_COUNT, 'summed buckets are capped too');
  assert.deepStrictEqual(s.most_reacted[0].kinds, { laugh: MAX_COUNT, emoji: MAX_COUNT });
  for (const share of [s.late_night.share, ...s.senders.map((x) => x.share)]) assert.ok(share >= 0 && share <= 1, `share within 0..1 (${share})`);
  assert.equal(JSON.stringify(s).includes('e+'), false, 'no exponent anywhere in the normalised recap');
});

test('ids and kinds taken from a link cannot reach Object.prototype', () => {
  for (const id of ['constructor', 'toString', 'valueOf', 'hasOwnProperty', '__proto__']) {
    const input = clone(vector.stats);
    input.personality.id = id;
    input.awards.forEach((a) => { a.id = id; });
    input.most_reacted[0].kinds = JSON.parse(`{"${id}": 2, "laugh": 1}`);
    input.reactions.by_kind = JSON.parse(`{"${id}": 5, "love": 3}`);
    const s = normalize(input);
    assert.equal(s.personality.id, id, 'the id is kept as plain text');
    assert.equal(s.personality.title, 'The Night Owls');
    assert.equal(s.personality.emoji, '\u2728', 'an unknown id gets the fallback emoji');
    assert.deepStrictEqual(s.most_reacted[0].kinds, { laugh: 1, emoji: 2 }, 'an unknown kind is counted as emoji');
    assert.deepStrictEqual(Object.keys(s.reactions.by_kind), ['love', 'like', 'dislike', 'laugh', 'emphasize', 'question', 'emoji']);
    assert.equal(s.reactions.by_kind.love, 3);
    assert.equal(s.reactions.by_kind.emoji, 5);
    assert.doesNotMatch(JSON.stringify(s), /native code|\[object/);
  }
  // A kinds object with no own entries contributes nothing, whatever it inherits.
  const inherit = clone(vector.stats);
  inherit.most_reacted[0].kinds = {};
  assert.deepStrictEqual(normalize(inherit).most_reacted[0].kinds, {});
});

test('senders are sorted, capped at 12 and get shares', () => {
  const senders = Array.from({ length: 15 }, (_, k) => ({ name: 'P' + String(k).padStart(2, '0'), messages: 10 + k }));
  senders.push({ name: 'Tie-B', messages: 24 }, { name: 'Tie-A', messages: 24 });
  const s = normalize({ chat: { name: 'Big' }, totals: { messages: 400 }, senders });
  assert.equal(s.senders.length, 12);
  assert.deepStrictEqual(s.senders.slice(0, 3).map((x) => x.name), ['P14', 'Tie-A', 'Tie-B']);
  assert.equal(s.senders[0].share, 0.06);
  assert.equal(s.chat.members, 12, 'falls back to the number of listed senders');
});

test('totals fall back to whatever can be counted', () => {
  assert.equal(normalize({ chat_name: 'x', messages_by_hour: { '3': 10, '4': 5 } }).totals.messages, 15);
  assert.equal(normalize({ chat_name: 'x', senders: [{ name: 'a', messages: 4 }, { name: 'b', messages: 6 }] }).totals.messages, 10);
  assert.equal(normalize({ chat_name: 'x', senders: [{ name: 'a', messages: 4 }, { name: 'b', messages: 6 }] }).senders[0].share, 0.6);
  assert.equal(normalize({ chat: { name: 'x' }, reactions: { by_kind: { love: 2, laugh: 3 } } }).totals.reactions, 5);
});

test('rejects things that are not recaps', () => {
  for (const bad of [null, undefined, 42, 'hello', [], '[]', '{bad json']) {
    assert.throws(() => normalize(bad), /not a recap/i, JSON.stringify(bad));
  }
  assert.throws(() => normalize({}), /empty/i);
  assert.throws(() => normalize({ foo: 'bar' }), /empty/i);
  assert.doesNotThrow(() => normalize(JSON.stringify(vector.stats)), 'a JSON string is accepted');
});

test('fallback personality for recaps without one: quiet, else by peak hour (SCHEMA §3)', () => {
  const at = (peak, total) => { const h = new Array(24).fill(1); h[peak] = total - 23; return h; };
  assert.deepStrictEqual(computePersonality(new Array(24).fill(1), 24), {
    id: 'quiet_ones', emoji: '\u{1F92B}', title: 'The Quiet Ones', reason: '24 messages in total',
    blurb: '24 messages in total. Few words. All of them count.', peak_hour: 0
  });
  assert.equal(computePersonality(at(5, 30), 1).reason, '1 message in total');
  assert.equal(computePersonality(at(5, 30), 49).id, 'quiet_ones');
  const expected = {
    0: 'night_owls', 4: 'night_owls', 5: 'early_birds', 8: 'early_birds', 9: 'morning_meeting', 11: 'morning_meeting',
    12: 'lunch_break', 13: 'lunch_break', 14: 'afternoon_slackers', 17: 'afternoon_slackers', 18: 'dinner_table',
    20: 'dinner_table', 21: 'after_hours', 23: 'after_hours'
  };
  for (const hour of Object.keys(expected)) {
    const p = computePersonality(at(Number(hour), 1000), 1000);
    assert.deepStrictEqual([p.id, p.peak_hour], [expected[hour], Number(hour)], hour);
    assert.ok(p.reason.startsWith('Peak hour: ') && p.blurb.startsWith(p.reason + '. '), hour);
    assert.ok(p.emoji);
  }
  assert.equal(computePersonality(at(22, 1000), 1000).blurb, 'Peak hour: 10 PM. The day ends. The chat begins.');
  // The old rule called any chat with 12% after midnight the Night Owls: not any more.
  const owner = new Array(24).fill(0);
  owner[1] = 130; owner[11] = 500; owner[15] = 370;
  assert.deepStrictEqual([computePersonality(owner, 1000).id, computePersonality(owner, 1000).reason],
    ['morning_meeting', 'Peak hour: 11 AM']);
  assert.equal(computePersonality(new Array(24).fill(0), 500), null, 'no hours, no personality');
});

test('a personality keeps its emoji and reason, cleaned and capped', () => {
  const input = clone(vector.stats);
  input.personality = {
    id: 'daily_ritual', emoji: '\u202E\u{1F4C6}\n', title: 'The Daily Ritual',
    reason: 'Active on 301\u0000 of 314 days' + ' and more'.repeat(30), blurb: 'b', peak_hour: 23
  };
  const p = normalize(input).personality;
  assert.equal(p.emoji, '\u{1F4C6}');
  assert.equal(p.reason.slice(0, 25), 'Active on 301 of 314 days');
  assert.equal(Array.from(p.reason).length, 120);
  assert.deepStrictEqual(Object.keys(p), ['id', 'emoji', 'title', 'reason', 'blurb', 'peak_hour']);
  input.personality.emoji = '\uFE0F';                 // nothing that paints: the id's own
  assert.equal(normalize(input).personality.emoji, '\u{1F4C6}');
  input.personality.emoji = '\u{1F9EA}'.repeat(20);    // capped like the award emoji
  assert.equal(Array.from(normalize(input).personality.emoji).length, 12);
  delete input.personality.reason;
  assert.equal('reason' in normalize(input).personality, false, 'no reason is made up for a recap that carries none');
  input.personality.id = 'a_brand_new_one';
  delete input.personality.emoji;
  assert.equal(normalize(input).personality.emoji, '\u2728');
});

test('the personality contract: id, emoji, title, blurb, peak_hour, and the reason when there was one', () => {
  const rows = [];
  for (let i = 0; i < 80; i++) rows.push({ date: String((1780000000 + i * 600 - 978307200) * 1e9), is_from_me: i % 3 === 0 ? 1 : 0, handle: '+1555010000' + (i % 4), text: 'a b c' });
  const engine = Engine.computeStats(rows, { tz: 'UTC', now: 1795000000, all_time: true });
  assert.deepStrictEqual(normalize(engine).personality, engine.personality, 'what the engines make passes through');
  const inputs = [vector.stats, loadDemo(), engine, { chat_name: 'x', messages_by_hour: { '3': 70 } },
    { chat_name: 'x', total_messages: 7, messages_by_hour: [7] }, { chat: { name: 'x' }, totals: { messages: 90 }, by_hour: [90], personality: 'The Custom Crew' },
    { chat: { name: 'x' }, totals: { messages: 90 }, by_hour: [90], personality: { id: 'toString', title: 'T', emoji: 7, reason: {} } }];
  for (const input of inputs) {
    const p = normalize(input).personality;
    assert.equal(typeof p.id, 'string');
    assert.ok(typeof p.emoji === 'string' && p.emoji.length > 0, JSON.stringify(p));
    assert.ok(typeof p.title === 'string' && p.title.length > 0);
    assert.equal(typeof p.blurb, 'string');
    assert.ok(Number.isInteger(p.peak_hour) && p.peak_hour >= 0 && p.peak_hour <= 23);
    const had = input.personality && typeof input.personality === 'object' && typeof input.personality.reason === 'string';
    if (had || !input.personality) assert.equal(typeof p.reason, 'string', JSON.stringify(input.personality));
  }
});
