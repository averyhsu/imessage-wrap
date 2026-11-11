'use strict';
// The invented sample chat behind "Try it with sample data" (web/make/sample.js).
const test = require('node:test');
const assert = require('node:assert/strict');

const Sample = require('../../web/make/sample.js');
const Engine = require('../../web/make/engine.js');

const NOVEMBER = Date.UTC(2026, 10, 11, 20, 0, 0) / 1000;
const stats = (built, now) => Engine.computeStats(built.rows, {
  now, chat_name: built.chat_name, participants: built.participants, source: 'sample',
});

test('the sample is deterministic and a few thousand rows long', () => {
  const a = Sample.build({ now: NOVEMBER });
  const b = Sample.build({ now: NOVEMBER });
  assert.deepStrictEqual(a, b);
  assert.equal(a.year, 2026);
  assert.ok(a.rows.length > 2500 && a.rows.length < 9000, `rows: ${a.rows.length}`);
  const full = Sample.build({ now: Date.UTC(2026, 11, 31, 23, 0, 0) / 1000 });
  assert.ok(full.rows.length > a.rows.length, 'a later day only adds rows');
  const ids = new Set(a.rows.map((r) => r.guid));
  assert.equal(ids.size, a.rows.length, 'every row has its own guid');
  assert.ok(a.rows.every((r) => r.date + 978307200 <= NOVEMBER), 'nothing from the future');
  assert.ok(a.rows.every((r, i) => r.rowid === i + 1), 'rowids are 1..n in date order');
});

test('early in a year the sample covers the whole year that just ended', () => {
  for (const now of [Date.UTC(2027, 0, 9, 12) / 1000, Date.UTC(2027, 2, 20, 12) / 1000]) {
    const built = Sample.build({ now });
    assert.equal(built.year, 2026);
    const st = Engine.computeStats(built.rows, { now, year: built.year, chat_name: built.chat_name, participants: built.participants });
    assert.equal(st.period.label, '2026');
    assert.ok(st.totals.messages > 3000);
    assert.ok(st.by_month.every((n) => n > 0), 'every month of the year has messages');
  }
  const april = Sample.build({ now: Date.UTC(2027, 3, 2, 12) / 1000 });
  assert.equal(april.year, 2027);
  assert.ok(april.rows.length > 500, 'three months are already enough for a recap');
});

test('the sample makes a complete, lively recap', () => {
  const built = Sample.build({ now: NOVEMBER });
  const st = stats(built, NOVEMBER);
  assert.equal(st.chat.name, Sample.CHAT_NAME);
  assert.equal(st.chat.members, 7);
  assert.equal(st.senders.length, 7);
  assert.ok(st.senders.some((s) => s.name === 'Me'), 'the owner wrote too');
  assert.ok(st.totals.messages > 2000 && st.totals.reactions > 500 && st.totals.attachments > 100);
  assert.ok(st.totals.days_active > 200 && st.totals.longest_streak >= 7);
  assert.equal(st.busiest_day.date, '2026-07-18', 'the trip weekend is the busiest day');
  assert.equal(st.awards.length, 6, 'six awards');
  assert.equal(new Set(st.awards.map((a) => a.winner)).size, 6, 'to six different people');
  assert.equal(st.most_reacted.length, 3);
  assert.ok(st.most_reacted.every((m) => m.text.length > 10 && m.reactions >= 4));
  assert.ok(st.late_night.top && st.late_night.messages > 0);
  for (const quotes of [true, false]) {
    const link = Engine.fitLink(st, { quotes });
    assert.equal(link.steps, 0, 'the sample fits in a link untrimmed');
    assert.ok(link.length <= Engine.MAX_URL_LENGTH);
  }
});

test('everything in the sample is invented: first names only, no numbers or addresses', () => {
  const built = Sample.build({ now: NOVEMBER });
  const handles = new Set(built.rows.map((r) => r.handle).filter(Boolean));
  assert.deepStrictEqual([...handles].sort(), [...built.participants].sort());
  for (const name of handles) assert.match(name, /^[A-Z][a-z]+$/, `${name} is a bare first name`);
  const text = built.rows.map((r) => r.text || '').join('\n');
  assert.doesNotMatch(text, /@|https?:|\d{3}/, 'no addresses, links or numbers in the messages');
});
