'use strict';
// Personality (section 3) and awards (section 4).
//
// Most cases live in tests/vectors/personality-awards-v1.json, which the Python
// engine's tests run too (tests/python/test_personality_awards.py), so both
// engines are held to the same hand-worked answers.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { Engine, utc, ns, msg, tap } = require('./support.js');

const I = Engine._internals;
const NOW = utc(2026, 11, 11, 20);
const MONDAY = utc(2026, 6, 1);          // 2026-06-01 is a Monday
const VECTORS = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'vectors', 'personality-awards-v1.json'), 'utf8'));

function figures(changes) {
  const f = Object.assign({}, VECTORS.figures.base);
  f.H = f.H.slice();
  for (const key of Object.keys(changes)) {
    if (key === 'peak') {
      f.H = new Array(24).fill(0);
      if (changes.peak !== null) f.H[changes.peak] = 1000;
    } else {
      f[key] = changes[key];
    }
  }
  return f;
}

/** Map of name -> counters, padded with zeros to the engine's thirteen. */
function people(spec) {
  const map = new Map();
  for (const name of Object.keys(spec)) {
    const counters = spec[name].slice();
    while (counters.length < I.COUNTERS) counters.push(0);
    map.set(name, counters);
  }
  return map;
}

function triples(awards) {
  return awards.map((a) => [a.id, a.winner, a.detail]);
}

/** Rows from the vector file's compact form (see its rows.about). */
function expand(entries) {
  const rows = [];
  for (const e of entries) {
    const start = Date.parse(e.at + 'Z') / 1000;
    const every = e.every === undefined ? 60 : e.every;
    let made = 0;
    for (const day of e.days || [0]) {
      const base = start + day * 86400;
      if (e.tap !== undefined) {
        e.on.forEach((target, k) => {
          rows.push(msg(base + k * every, e.from, 'Reacted', {
            associated_message_type: e.tap, associated_message_guid: 'p:0/' + target
          }));
        });
        continue;
      }
      for (let k = 0; k < (e.count || 1); k++) {
        const text = Array.isArray(e.text) ? e.text[k % e.text.length] : e.text;
        const row = msg(base + k * every, e.from, text, { date: ns(base + k * every, e.ns || 0) });
        if (e.rowid !== undefined) row.rowid = e.rowid;
        if (e.att) row.cache_has_attachments = 1;
        if (e.guid !== undefined) row.guid = e.guid + made;
        made++;
        rows.push(row);
      }
    }
  }
  return rows;
}

function runCase(c) {
  const options = Object.assign({ tz: 'UTC', now: NOW, contacts: VECTORS.rows.contacts }, c.options || {});
  return Engine.computeStats(expand(c.rows), options);
}

test('personality: figure vectors', () => {
  const cases = VECTORS.figures.cases;
  assert.ok(cases.length >= 55);
  for (const c of cases) {
    const p = I.personality(figures(c.set));
    assert.equal(p.id, c.id, c.name);
    const def = I.PERSONALITIES[c.id];
    assert.deepEqual([p.emoji, p.title], [def[0], def[1]], c.name);
    if (c.reason !== undefined) assert.equal(p.reason, c.reason, c.name);
    assert.equal(p.blurb, p.reason + '. ' + def[2], c.name);
    const peak = c.peak_hour !== undefined ? c.peak_hour : (c.set.peak !== undefined ? c.set.peak : 19);
    assert.equal(p.peak_hour, peak, c.name);
    assert.deepEqual(Object.keys(p), ['id', 'emoji', 'title', 'reason', 'blurb', 'peak_hour']);
  }
});

test('personality: every trait has a hit and a miss', () => {
  const names = VECTORS.figures.cases.map((c) => c.name);
  I.TRAITS.forEach((t, i) => {
    const hits = names.filter((n) => n.startsWith((i + 1) + ' ' + t.id + ' at the floor'));
    const misses = names.filter((n) => n.startsWith((i + 1) + ' ' + t.id + ' just'));
    assert.deepEqual([hits.length, misses.length], [1, 1], t.id);
  });
});

test('personality: by peak hour when no trait stands out', () => {
  const labels = VECTORS.figures.peak_labels;
  for (const hour of Object.keys(VECTORS.figures.peak_hours)) {
    const p = I.personality(figures({ peak: Number(hour) }));
    assert.deepEqual([p.id, p.peak_hour], [VECTORS.figures.peak_hours[hour], Number(hour)]);
    assert.ok(p.reason.startsWith('Peak hour: '));
    if (labels[hour]) assert.equal(p.reason, 'Peak hour: ' + labels[hour]);
  }
  for (const hour of Object.keys(labels)) assert.equal(I.hour12(Number(hour)), labels[hour]);
});

test('personality: tables', () => {
  assert.deepEqual(I.TRAITS.map((t) => t.id), [
    'one_person_show', 'dynamic_duo', 'round_table', 'night_owls', 'weekend_warriors',
    'weekday_regulars', 'always_on', 'daily_ritual', 'flash_mob', 'seasonal_special',
    'firehose', 'slow_burn', 'photo_dump', 'hype_squad', 'comedy_club', 'love_fest',
    'essayists', 'rapid_fire']);
  assert.equal(Object.keys(I.PERSONALITIES).length, 25);
  for (const id of Object.keys(I.PERSONALITIES)) {
    const [emoji, title, line] = I.PERSONALITIES[id];
    assert.ok(emoji && title.startsWith('The ') && line.endsWith('.'), id);
  }
  assert.deepEqual(I.PERSONALITIES.morning_meeting, ['\u2615', 'The Morning Meeting', 'This could not have been an email.']);
});

test('personality: figures from rows', () => {
  function at(day, hour, n, sender, extra) {
    const rows = [];
    for (let i = 0; i < n; i++) rows.push(msg(MONDAY + day * 86400 + hour * 3600 + i, sender, 'one two', extra));
    return rows;
  }
  let rows = at(0, 23, 5, '+15550100001').concat(at(1, 0, 4, '+15550100002'), at(1, 1, 3, '+15550100003'),
    at(5, 12, 2, '+15550100004', { cache_has_attachments: 1 }));
  for (let i = 0; i < 13; i++) rows.push(msg(MONDAY + 38 * 86400 + 3600 + i, '+15550101' + String(i).padStart(3, '0'), 'x'));
  const st = Engine.computeStats(rows, { tz: 'UTC', now: NOW, start: '2026-06-01', end: '2026-07-31' });
  const counts = [5, 4, 3, 2].concat(new Array(13).fill(1));
  const f = I.personalityFigures(st.totals, st.by_hour, st.by_weekday, st.by_month, 61,
    st.busiest_day.messages, st.reactions.by_kind, counts);
  assert.equal(st.senders.length, 12);
  assert.deepEqual([f.n, f.top1, f.top2, f.low], [17, 5, 4, 1]);
  assert.deepEqual([f.T, f.night, f.weekend, f.best3], [27, 20, 2, 25]);     // 11 PM to 1 AM
  assert.deepEqual([f.month1, f.month1_index, f.day1, f.A, f.Wd], [14, 5, 13, 2, 41]);
});

test("personality: the owner's chat was called the Night Owls before", () => {
  const st = runCase(VECTORS.rows.cases[0]);
  assert.ok(st.late_night.share >= 0.12);       // the old rule's night share
  assert.equal(st.personality.peak_hour, 11);
  assert.notEqual(st.personality.id, 'night_owls');
});

test('awards: counter vectors', () => {
  for (const c of VECTORS.awards.cases) {
    assert.deepEqual(triples(I.awards(people(c.people))), c.expect, c.name);
  }
});

test('awards: need three qualifying senders', () => {
  assert.deepEqual(I.awards(people({ a: [50], b: [5], c: [4] })), []);
  const got = I.awards(people({ a: [50], b: [5], c: [5], d: [1, 0, 0, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9] }));
  assert.deepEqual(got.map((a) => a.id), ['yapper', 'lurker', 'novelist']);
});

test('awards: table', () => {
  assert.deepEqual(I.AWARDS.map((a) => [a[0], a[1], a[2]]), [
    ['yapper', '\u{1F5E3}\uFE0F', 'The Yapper'],
    ['comedian', '\u{1F602}', 'The Comedian'],
    ['night_owl', '\u{1F989}', 'The Night Owl'],
    ['starter', '\u{1F680}', 'The Conversation Starter'],
    ['paparazzi', '\u{1F4F8}', 'The Paparazzi'],
    ['interrogator', '\u2753', 'The Interrogator'],
    ['hype', '\u{1F4E3}', 'The Hype Machine'],
    ['early_bird', '\u{1F426}', 'The Early Bird'],
    ['closer', '\u{1F3AC}', 'The Last Word'],
    ['link_dropper', '\u{1F517}', 'The Link Dropper'],
    ['favorite', '\u2B50', 'The Crowd Favorite'],
    ['double_texter', '\u{1F4F2}', 'The Double Texter'],
    ['novelist', '\u{1F4DA}', 'The Novelist'],
    ['minimalist', '\u2702\uFE0F', 'The Minimalist'],
    ['lurker', '\u{1F47B}', 'The Lurker']]);
});

test('awards: details use thousands', () => {
  const got = {};
  I.awards(people({
    a: [12004, 61200, 3120, 1201, 2100, 1850, 1400, 1500, 1600, 1700, 1800, 1900, 2000],
    b: [2000, 1], c: [1000, 1]
  })).forEach((a) => { got[a.id] = a; });
  assert.equal(got.yapper.detail, '12,004 messages. Nobody asked.');
  assert.equal(got.comedian.detail, 'Made the chat laugh 1,400 times.');
  assert.equal(got.night_owl.detail, '1,201 messages after midnight.');
  assert.equal(got.starter.detail, 'Sent the first message of the day 1,800 times.');
  assert.deepEqual([got.minimalist.winner, got.minimalist.detail], ['b', '0.0 words per message. Straight to the point.']);
  assert.equal(got.paparazzi, undefined);       // the list is full at six
});

test('awards: novelist ratio is exact and rounds half up', () => {
  for (const [words, messages, shown] of [[45, 20, '2.3'], [49, 20, '2.5'], [41, 20, '2.1'], [239, 20, '12.0'], [25001, 20, '1250.1']]) {
    const novelist = I.awards(people({ a: [messages, words], b: [50, 50], c: [10, 10] })).find((a) => a.id === 'novelist');
    assert.equal(novelist.winner, 'a');
    assert.equal(novelist.detail, shown + ' words per message. A paragraph person.');
  }
  const got = new Map(I.awards(people({ a: [3000000, 1000000], b: [1000000, 333333], c: [30, 1] })).map((a) => [a.id, a.winner]));
  assert.equal(got.get('novelist'), 'a');           // 1/3 against 333333/1000000
  assert.equal(got.get('minimalist'), 'c');
});

test('awards: ratios compare exactly past 2^53', () => {
  const n = Number.MAX_SAFE_INTEGER;
  // (n-1)/n against (n-2)/(n-1): cross-multiplying in doubles calls them equal
  assert.equal((n - 1) * (n - 1), n * (n - 2));
  assert.equal(I.compareRatio(n - 1, n, n - 2, n - 1), 1);
  assert.equal(I.compareRatio(n - 2, n - 1, n - 1, n), -1);
  assert.equal(I.compareRatio(n - 1, n, n - 1, n), 0);
  assert.equal(I.compareRatio(6, 4, 3, 2), 0);
  assert.equal(I.compareRatio(0, 5, 0, 9), 0);
  assert.equal(I.compareRatio(1, 3, 333333, 1000000), 1);
  assert.equal(I.compareRatio(7, 2, 10, 3), 1);
});

test('rows: vectors', () => {
  for (const c of VECTORS.rows.cases) {
    const st = runCase(c);
    const expect = c.expect;
    for (const key of Object.keys(expect.personality || {})) {
      assert.deepEqual(st.personality[key], expect.personality[key], c.name + ': ' + key);
    }
    if (expect.late_share !== undefined) assert.equal(st.late_night.share, expect.late_share, c.name);
    if (expect.senders !== undefined) assert.equal(st.senders.length, expect.senders, c.name);
    const got = triples(st.awards);
    if (Array.isArray(expect.awards)) {
      assert.deepEqual(got, expect.awards, c.name);
    } else if (expect.awards) {
      const ids = got.map((a) => a[0]);
      for (const id of expect.awards.has || []) assert.ok(ids.includes(id), c.name + ': ' + id);
      for (const id of expect.awards.lacks || []) assert.ok(!ids.includes(id), c.name + ': ' + id);
    }
    if (expect.double_texter) {
      assert.deepEqual(got.filter((a) => a[0] === 'double_texter').map((a) => a.slice(1)), [expect.double_texter], c.name);
    }
    for (const person of st.senders) {
      for (const word of person.name.split(' ')) assert.ok(!st.personality.reason.includes(word), c.name);
    }
  }
});

test('rows: tapbacks feed the comedian', () => {
  const t = utc(2026, 6, 1, 12);
  const a = '+15550100001', b = '+15550100002', c = '+15550100003';
  const na = '\u20260001', nb = '\u20260002', nc = '\u20260003';   // no contacts: masked
  let rows = [];
  for (let i = 0; i < 30; i++) rows.push(msg(t + i, a, 'word word word', { guid: 'A' + i }));
  for (let i = 0; i < 6; i++) rows.push(msg(t + 100 + i, b, '\uFFFC', { cache_has_attachments: 1 }));
  for (let i = 0; i < 5; i++) rows.push(msg(t - 12 * 3600 + i, c, 'night'));
  for (let i = 0; i < 4; i++) rows.push(tap(t + 500 + i, b, 2003, rows[i]));
  const st = Engine.computeStats(rows, { tz: 'UTC', now: NOW });
  // fresh winners first, then the deferred ones in table order
  assert.deepEqual(triples(st.awards), [
    ['yapper', na, '30 messages. Nobody asked.'],
    ['night_owl', nc, '5 messages after midnight.'],
    ['paparazzi', nb, '6 photos, videos and memes.'],
    ['comedian', na, 'Made the chat laugh 4 times.'],
    ['hype', nb, 'Handed out 4 tapbacks.'],
    ['favorite', na, '4 tapbacks received.']]);
});
