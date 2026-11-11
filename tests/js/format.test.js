'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const F = require('../../web/js/format.js');

test('int: thousands separators', () => {
  assert.equal(F.int(0), '0');
  assert.equal(F.int(7), '7');
  assert.equal(F.int(999), '999');
  assert.equal(F.int(1000), '1,000');
  assert.equal(F.int(48213), '48,213');
  assert.equal(F.int(1200000), '1,200,000');
  assert.equal(F.int(1234567890), '1,234,567,890');
  assert.equal(F.int(152.6), '153');
  assert.equal(F.int(-4321), '-4,321');
  assert.equal(F.int(NaN), '0');
  assert.equal(F.int(undefined), '0');
  assert.equal(F.int('12004'), '12,004');
});

test('compact: short numbers for tight spaces', () => {
  assert.equal(F.compact(0), '0');
  assert.equal(F.compact(60), '60');
  assert.equal(F.compact(999), '999');
  assert.equal(F.compact(1000), '1K');
  assert.equal(F.compact(1234), '1.2K');
  assert.equal(F.compact(9950), '10K');
  assert.equal(F.compact(48213), '48K');
  assert.equal(F.compact(999499), '999K');
  assert.equal(F.compact(999500), '1M');
  assert.equal(F.compact(1200000), '1.2M');
  assert.equal(F.compact(48000000), '48M');
  assert.equal(F.compact(2500000000), '2.5B');
});

test('pct: shares as percentages', () => {
  assert.equal(F.pct(0.2456), '25%');
  assert.equal(F.pct(0.2456, 1), '24.6%');
  assert.equal(F.pct(0.2, 1), '20.0%');
  assert.equal(F.pct(1), '100%');
  assert.equal(F.pct(0), '0%');
  assert.equal(F.pct(0.004), '<1%');
  assert.equal(F.pct(0.0004, 1), '<0.1%');
  assert.equal(F.pct(undefined), '0%');
});

test('hour: 12-hour clock labels', () => {
  assert.equal(F.hour(0), '12 AM');
  assert.equal(F.hour(1), '1 AM');
  assert.equal(F.hour(11), '11 AM');
  assert.equal(F.hour(12), '12 PM');
  assert.equal(F.hour(13), '1 PM');
  assert.equal(F.hour(23), '11 PM');
  assert.equal(F.hour(24), '12 AM');
  assert.equal(F.hourTick(0), '12a');
  assert.equal(F.hourTick(6), '6a');
  assert.equal(F.hourTick(12), '12p');
  assert.equal(F.hourTick(18), '6p');
});

test('hourSpan: the hour after the peak', () => {
  assert.equal(F.hourSpan(23), '11 PM and midnight');
  assert.equal(F.hourSpan(11), '11 AM and noon');
  assert.equal(F.hourSpan(0), 'midnight and 1 AM');
  assert.equal(F.hourSpan(12), 'noon and 1 PM');
  assert.equal(F.hourSpan(14), '2 and 3 PM');
  assert.equal(F.hourSpan(8), '8 and 9 AM');
});

test('dates: parsed without time zones', () => {
  assert.deepStrictEqual(F.parseDate('2026-07-04'), { y: 2026, m: 7, d: 4 });
  assert.deepStrictEqual(F.parseDate('2026-07-04T23:59:59Z'), { y: 2026, m: 7, d: 4 });
  assert.equal(F.parseDate('July 4'), null);
  assert.equal(F.parseDate('2026-13-01'), null);
  assert.equal(F.parseDate(null), null);
  assert.equal(F.date('2026-07-04'), 'July 4');
  assert.equal(F.date('2026-07-04', { short: true }), 'Jul 4');
  assert.equal(F.date('2026-07-04', { year: true }), 'July 4, 2026');
  assert.equal(F.date('nope'), '');
});

test('weekdayOf: Monday is 0', () => {
  assert.equal(F.weekdayOf('2026-07-04'), 5); // a Saturday
  assert.equal(F.weekdayOf('2026-11-11'), 2); // a Wednesday
  assert.equal(F.weekdayOf('2024-02-29'), 3); // a Thursday
  assert.equal(F.weekdayOf('1969-07-20'), 6); // a Sunday
  assert.equal(F.weekdayOf('2026-01-05'), 0); // a Monday
  assert.equal(F.weekdayOf('garbage'), -1);
  assert.equal(F.WEEKDAYS[F.weekdayOf('2026-07-04')], 'Saturday');
});

test('daysInclusive and dateRange', () => {
  assert.equal(F.daysInclusive('2026-01-01', '2026-11-10'), 314);
  assert.equal(F.daysInclusive('2026-01-01', '2026-01-01'), 1);
  assert.equal(F.daysInclusive('2024-01-01', '2024-12-31'), 366);
  assert.equal(F.daysInclusive('2026-02-01', '2026-01-01'), 0);
  assert.equal(F.daysInclusive('', '2026-01-01'), 0);
  assert.equal(F.dateRange('2026-01-01', '2026-11-10'), 'Jan 1 – Nov 10');
  assert.equal(F.dateRange('2025-11-01', '2026-02-28'), 'Nov 1, 2025 – Feb 28, 2026');
  assert.equal(F.dateRange('', ''), '');
});

test('perDay: averages read like a sentence', () => {
  assert.equal(F.perDay(48213, 314), "That's 154 a day.");
  assert.equal(F.perDay(1000, 314), "That's 3.2 a day.");
  assert.equal(F.perDay(314, 314), "That's 1 a day.");
  assert.equal(F.perDay(60, 314), 'About one every 5 days.');
  assert.equal(F.perDay(60, 0), '');
  assert.equal(F.perDay(0, 314), '');
});

test('wordFact: comparisons scale with the word count', () => {
  assert.equal(F.wordFact(0), '');
  assert.match(F.wordFact(300), /long text/);
  assert.match(F.wordFact(1500), /essay/);
  assert.match(F.wordFact(8000), /short story/);
  assert.match(F.wordFact(30000), /novella/);
  assert.equal(F.wordFact(47000), "That's a whole Great Gatsby.");
  assert.equal(F.wordFact(251034), "That's The Great Gatsby, 5 times over.");
  assert.match(F.wordFact(600000), /War and Peace/);
  assert.equal(F.wordFact(6000000), "That's War and Peace, 10 times over.");
});

test('small helpers', () => {
  assert.equal(F.plural(1, 'message'), 'message');
  assert.equal(F.plural(2, 'message'), 'messages');
  assert.equal(F.plural(0, 'person', 'people'), 'people');
  assert.equal(F.initial('maya'), 'M');
  assert.equal(F.initial('  🍝 club'), '🍝');
  assert.equal(F.initial(''), '?');
  assert.equal(F.truncate('hello world', 5), 'hello…');
  assert.equal(F.truncate('hello', 5), 'hello');
  assert.equal(F.truncate('🍝🍝🍝', 2), '🍝🍝…');
  assert.equal(F.inReview('2026'), '2026 in review');
  assert.equal(F.inReview(''), 'In review');
  assert.equal(F.argmax([1, 5, 5, 2]), 1);
  assert.equal(F.argmax([0, 0, 0]), -1);
  assert.equal(F.argmax([]), -1);
  assert.equal(F.sum([1, 2, '3', null]), 6);
});
