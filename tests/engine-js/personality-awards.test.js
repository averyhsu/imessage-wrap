'use strict';
// Personality table (section 3) and award selection (section 4).

const test = require('node:test');
const assert = require('node:assert/strict');
const { Engine, utc, msg, tap } = require('./support.js');

const I = Engine._internals;
const NOW = utc(2026, 11, 11, 20);
const MONDAY = utc(2026, 6, 1);          // 2026-06-01 is a Monday

function at(day, hour, n, sender) {
  const rows = [];
  for (let i = 0; i < n; i++) rows.push(msg(MONDAY + day * 86400 + hour * 3600 + i, sender || '+15550100001', 'x'));
  return rows;
}

function personality(rows) {
  return Engine.computeStats(rows, { tz: 'UTC', now: NOW }).personality;
}

function spread(perHour, from, to) {
  let rows = [];
  for (let hour = from; hour < to; hour++) rows = rows.concat(at(0, hour, perHour));
  return rows;
}

test('rule 1: quiet', () => {
  assert.deepEqual(personality(at(0, 23, 49)), {
    id: 'quiet_ones', title: 'The Quiet Ones',
    blurb: 'Peak hour: 11 PM. Few words. All of them count.', peak_hour: 23
  });
  assert.notEqual(personality(at(0, 23, 50)).id, 'quiet_ones');
});

test('rule 2: night share or night peak', () => {
  assert.equal(personality(at(0, 3, 12).concat(at(0, 12, 88))).id, 'night_owls');
  assert.notEqual(personality(at(0, 3, 11).concat(at(0, 12, 89))).id, 'night_owls');
  const p = personality(at(0, 4, 6).concat(spread(5, 5, 24)));
  assert.deepEqual([p.id, p.peak_hour], ['night_owls', 4]);
  assert.equal(p.blurb, 'Peak hour: 4 AM. Sleep is a suggestion.');
});

test('rule 3: weekend share', () => {
  const weekday = at(0, 12, 58);
  assert.equal(personality(weekday.concat(at(5, 12, 21), at(6, 12, 21))).id, 'weekend_warriors');
  assert.notEqual(personality(weekday.concat(at(5, 12, 21), at(6, 12, 20), at(1, 12, 1))).id, 'weekend_warriors');
});

test('rule 4: always on', () => {
  assert.equal(personality(spread(10, 5, 24)).id, 'always_on');                  // peak share 5.3%
  assert.equal(personality(at(0, 10, 13).concat(spread(11, 5, 22))).id, 'morning_meeting');
});

test('rules 5 to 10 by peak hour, lowest hour wins a tie', () => {
  const expected = {
    5: 'early_birds', 8: 'early_birds', 9: 'morning_meeting', 11: 'morning_meeting', 12: 'lunch_break',
    13: 'lunch_break', 14: 'afternoon_slackers', 17: 'afternoon_slackers', 18: 'dinner_table',
    20: 'dinner_table', 21: 'after_hours', 23: 'after_hours'
  };
  for (const hour of Object.keys(expected)) {
    const p = personality(at(0, Number(hour), 60));
    assert.deepEqual([p.id, p.peak_hour], [expected[hour], Number(hour)]);
    assert.equal(p.title, I.PERSONALITIES[p.id][0]);
    assert.ok(p.blurb.endsWith('. ' + I.PERSONALITIES[p.id][1]), p.blurb);
  }
  const tie = personality(at(0, 18, 30).concat(at(0, 9, 30)));
  assert.deepEqual([tie.id, tie.peak_hour], ['morning_meeting', 9]);
  assert.deepEqual([0, 1, 11, 12, 13, 23].map(I.hour12), ['12 AM', '1 AM', '11 AM', '12 PM', '1 PM', '11 PM']);
  assert.equal(Object.keys(I.PERSONALITIES).length, 10);
});

// counters: [messages, words, attachments, late, given, received, laughs]
function people(table) {
  return new Map(Object.keys(table).map((name) => [name, table[name].slice()]));
}
const ids = (list) => list.map((a) => [a.id, a.winner]);

test('awards need three qualifying senders', () => {
  assert.deepEqual(I.awards(people({ a: [50, 0, 0, 0, 0, 0, 0], b: [5, 0, 0, 0, 0, 0, 0], c: [4, 0, 0, 0, 0, 0, 0] })), []);
  const got = I.awards(people({
    a: [50, 0, 0, 0, 0, 0, 0], b: [5, 0, 0, 0, 0, 0, 0], c: [5, 0, 0, 0, 0, 0, 0], d: [1, 0, 0, 9, 9, 9, 9]
  }));
  assert.deepEqual(ids(got), [['yapper', 'a'], ['lurker', 'b'], ['novelist', 'a']]);
});

test('all eight candidates and the cap of six', () => {
  const got = I.awards(people({
    yap: [900, 900, 0, 0, 0, 0, 0], lurk: [5, 5, 0, 0, 0, 0, 0], owl: [100, 100, 0, 40, 0, 0, 0],
    funny: [100, 100, 0, 0, 0, 30, 30], hype: [100, 100, 0, 0, 77, 0, 0], novel: [20, 2000, 0, 0, 0, 0, 0],
    pap: [100, 100, 12, 0, 0, 0, 0], fav: [100, 100, 0, 0, 0, 55, 0]
  }));
  assert.deepEqual(ids(got), [['yapper', 'yap'], ['lurker', 'lurk'], ['night_owl', 'owl'],
    ['comedian', 'funny'], ['hype', 'hype'], ['novelist', 'novel']]);
  assert.deepEqual(got[0], {
    id: 'yapper', emoji: '\u{1F5E3}\u{FE0F}', title: 'The Yapper', winner: 'yap',
    detail: '900 messages. Nobody asked.'
  });
});

test('details and emoji', () => {
  const list = I.awards(people({
    a: [12004, 61200, 3120, 1201, 2100, 1850, 1400], b: [2000, 1, 0, 0, 0, 0, 0], c: [1000, 1, 0, 0, 0, 0, 0]
  }));
  const got = {};
  list.forEach((a) => { got[a.id] = a; });
  assert.equal(got.yapper.detail, '12,004 messages. Nobody asked.');
  assert.equal(got.lurker.detail, '1,000 messages. Reads everything, says little.');
  assert.equal(got.night_owl.detail, '1,201 messages after midnight.');
  assert.equal(got.comedian.detail, 'Made the chat laugh 1,400 times.');
  assert.equal(got.hype.detail, 'Handed out 2,100 tapbacks.');
  assert.equal(got.novelist.detail, '5.1 words per message. A paragraph person.');
  assert.equal(got.paparazzi, undefined);
  assert.deepEqual(['lurker', 'night_owl', 'comedian', 'hype', 'novelist'].map((k) => got[k].emoji),
    ['\u{1F47B}', '\u{1F989}', '\u{1F602}', '\u{1F4E3}', '\u{1F4DA}']);
  const rest = I.awards(people({
    a: [30, 30, 5, 0, 0, 9, 0], b: [6, 1, 0, 0, 0, 0, 0], c: [7, 1, 0, 0, 0, 0, 0]
  }));
  assert.deepEqual(rest.map((a) => [a.id, a.emoji, a.detail]).slice(2), [
    ['novelist', '\u{1F4DA}', '1.0 words per message. A paragraph person.'],
    ['paparazzi', '\u{1F4F8}', '5 photos, videos and memes.'],
    ['favorite', '\u2B50', '9 tapbacks received.']]);
});

test('deferred awards fill the remaining slots in table order', () => {
  let got = I.awards(people({ star: [100, 100, 9, 9, 9, 9, 9], b: [50, 50, 0, 0, 0, 0, 0], c: [10, 10, 0, 0, 0, 0, 0] }));
  assert.deepEqual(ids(got), [['yapper', 'star'], ['lurker', 'c'], ['night_owl', 'star'],
    ['comedian', 'star'], ['hype', 'star'], ['novelist', 'star']]);
  got = I.awards(people({ star: [100, 100, 9, 9, 9, 9, 9], b: [50, 400, 0, 0, 0, 0, 0], c: [10, 10, 0, 0, 0, 0, 0] }));
  assert.deepEqual(ids(got), [['yapper', 'star'], ['lurker', 'c'], ['novelist', 'b'],
    ['night_owl', 'star'], ['comedian', 'star'], ['hype', 'star']]);
});

test('thresholds and ties', () => {
  const base = { b: [50, 50, 0, 0, 0, 0, 0], c: [10, 10, 0, 0, 0, 0, 0] };
  let got = new Map(ids(I.awards(people(Object.assign({ a: [19, 500, 2, 2, 2, 2, 2] }, base)))));
  assert.deepEqual(Array.from(got.keys()).sort(), ['lurker', 'novelist', 'yapper']);
  assert.equal(got.get('novelist'), 'b');
  got = new Map(ids(I.awards(people(Object.assign({ a: [20, 500, 3, 3, 3, 3, 3] }, base)))));
  assert.deepEqual(Array.from(got.keys()).sort(), ['comedian', 'hype', 'lurker', 'night_owl', 'novelist', 'yapper']);
  assert.equal(got.get('novelist'), 'a');
  got = new Map(ids(I.awards(people({
    zed: [30, 30, 0, 5, 0, 0, 0], amy: [30, 30, 0, 5, 0, 0, 0], bob: [40, 40, 0, 5, 0, 0, 0],
    cat: [8, 8, 0, 0, 0, 0, 0], dan: [8, 8, 0, 0, 0, 0, 0]
  }))));
  assert.deepEqual([got.get('yapper'), got.get('lurker'), got.get('night_owl')], ['bob', 'cat', 'bob']);
  got = new Map(ids(I.awards(people({ zed: [30, 30, 0, 5, 0, 0, 0], amy: [30, 30, 0, 5, 0, 0, 0], cat: [8, 8, 0, 0, 0, 0, 0] }))));
  assert.deepEqual([got.get('yapper'), got.get('night_owl')], ['amy', 'amy']);
});

test('novelist ratio is exact and rounds half up', () => {
  const base = { b: [50, 50, 0, 0, 0, 0, 0], c: [10, 10, 0, 0, 0, 0, 0] };
  for (const [words, messages, shown] of [[45, 20, '2.3'], [49, 20, '2.5'], [41, 20, '2.1'], [239, 20, '12.0'], [25001, 20, '1250.1']]) {
    const list = I.awards(people(Object.assign({ a: [messages, words, 0, 0, 0, 0, 0] }, base)));
    const novelist = list.find((a) => a.id === 'novelist');
    assert.equal(novelist.winner, 'a');
    assert.equal(novelist.detail, shown + ' words per message. A paragraph person.');
  }
  const got = new Map(ids(I.awards(people({
    a: [3000000, 1000000, 0, 0, 0, 0, 0], b: [1000000, 333333, 0, 0, 0, 0, 0], c: [30, 1, 0, 0, 0, 0, 0]
  }))));
  assert.equal(got.get('novelist'), 'a');
});

test('awards from real rows', () => {
  const t = utc(2026, 6, 1, 12);
  const a = '+15550100001', b = '+15550100002', c = '+15550100003';
  const na = '\u20260001', nb = '\u20260002', nc = '\u20260003';   // no contacts: masked
  let rows = [];
  for (let i = 0; i < 30; i++) rows.push(msg(t + i, a, 'word word word', { guid: 'A' + i }));
  for (let i = 0; i < 6; i++) rows.push(msg(t + 100 + i, b, '\uFFFC', { cache_has_attachments: 1 }));
  for (let i = 0; i < 5; i++) rows.push(msg(t - 12 * 3600 + i, c, 'night'));
  for (let i = 0; i < 4; i++) rows.push(tap(t + 500 + i, b, 2003, rows[i]));
  const st = Engine.computeStats(rows, { tz: 'UTC', now: NOW });
  assert.deepEqual(ids(st.awards), [['yapper', na], ['lurker', nc], ['hype', nb],
    ['night_owl', nc], ['comedian', na], ['novelist', na]]);
  const details = {};
  st.awards.forEach((x) => { details[x.id] = x.detail; });
  assert.equal(details.novelist, '3.0 words per message. A paragraph person.');
  assert.equal(details.hype, 'Handed out 4 tapbacks.');
  assert.equal(details.comedian, 'Made the chat laugh 4 times.');
  assert.equal(details.night_owl, '5 messages after midnight.');
});
