'use strict';
// The copy each slide picks from the chat's numbers (web/js/insights.js). For every pattern:
// a recap that triggers it and one just short of it; partial periods; thin data.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const F = require('../../web/js/format.js');
const { normalize } = require('../../web/js/normalize.js');
const I = require('../../web/js/insights.js');
const vector = require('../vectors/payload-v1.json');

const clone = (o) => JSON.parse(JSON.stringify(o));
const text = (parts) => (parts || []).map((p) => (typeof p === 'string' ? p : p.b != null ? p.b : p.name)).join('');
const flat = (n, v) => Array.from({ length: n }, () => v);

/**
 * A recap that gets the default copy on every slide: the demo's numbers over a whole
 * calendar year, with a month profile that has no particular shape.
 */
function base(edit) {
  const raw = clone(vector.stats);
  raw.period = { label: '2026', start: '2026-01-01', end: '2026-12-31' };
  raw.by_month = [8, 8, 8, 8, 8, 8, 34, 6, 3, 3, 3, 3].map((v) => v * 100);
  if (edit) edit(raw);
  return normalize(raw);
}
const pick = (edit) => I.pick(base(edit));

test('the base recap gets every slide\'s default copy', () => {
  const c = pick();
  assert.deepStrictEqual(
    Object.fromEntries(Object.entries(c).map(([k, v]) => [k, v.id])),
    { total: 'plain', clock: 'by_peak_hour', late: 'night_shift', week: 'by_peak_day', year: 'peak_month', senders: 'carried', moty: 'laughs', taps: 'by_top_kind' },
  );
  assert.equal(c.late.top.id, 'lights_on');
});

test('every list ends with the copy the slide had before, and its last pattern always applies', () => {
  const ids = I.ids();
  assert.deepStrictEqual(Object.keys(ids), ['total', 'clock', 'late', 'lateTop', 'week', 'year', 'senders', 'moty', 'taps']);
  assert.equal(ids.clock.at(-1), 'by_peak_hour');
  assert.equal(ids.week.at(-1), 'by_peak_day');
  assert.equal(ids.year.at(-1), 'peak_month');
  assert.equal(ids.senders.at(-1), 'carried');
  assert.equal(ids.moty.at(-1), 'mixed');
  assert.equal(ids.taps.at(-1), 'by_top_kind');
  assert.equal(ids.lateTop.at(-1), 'lights_on');
  // Today's copy, word for word.
  const c = pick();
  assert.equal(c.clock.headline, 'Loudest after dark.');
  assert.equal(text(c.clock.line), '4,265 messages landed between 11 PM and midnight.');
  assert.equal(c.week.headline, 'Saturdays are for the chat.');
  assert.equal(text(c.week.line), '8,293 messages landed on a Saturday. Weekdays carry 68% of the chat.');
  assert.equal(c.year.headline, 'July went off.');
  assert.equal(c.year.line, null);
  assert.equal(c.senders.headline, 'Who carried the chat');
  assert.equal(c.taps.headline, 'Mostly laughing.');
  assert.equal(c.taps.line, null);
  assert.equal(c.late.top.verb, ' kept the lights on');
  assert.equal(c.late.top.detail, '2,134 late-night messages');
  assert.equal(c.total.fact, '');
});

test('a recap with nothing in a section gets no copy for that slide', () => {
  const c = I.pick(normalize({ v: 1, chat: { name: 'Bare', members: 5 }, period: { label: '2026' }, totals: { messages: 812 } }));
  assert.equal(c.clock, null);
  assert.equal(c.week, null);
  assert.equal(c.year, null);
  assert.equal(c.senders, null);
  assert.equal(c.moty, null);
  assert.equal(c.taps, null);
  assert.equal(c.late, null);
  assert.equal(c.total.id, 'plain');
});

// ── clock ────────────────────────────────────────────────────────────────────────────

const hours = (H) => (raw) => { raw.by_hour = H; };

test('clock: open all hours (busiest three hours at most 20%, at least 200 messages)', () => {
  const c = pick(hours(flat(24, 100)));
  assert.equal(c.clock.id, 'open_all_hours');
  assert.equal(c.clock.headline, 'Open all hours.');
  assert.equal(text(c.clock.line), 'Even the busiest three hours, midnight to 3 AM, held just 13% of the chat.');
  // Just short: three busy hours hold 21%.
  const H = flat(24, 100);
  H[19] = H[20] = H[21] = 186;
  assert.ok((3 * 186) / (21 * 100 + 3 * 186) > 0.2);
  assert.equal(pick(hours(H)).clock.id, 'by_peak_hour');
  // Exactly 20% counts: 3 × 70 of 1,050.
  const E = flat(24, 40);
  E[3] = E[4] = E[5] = 70;
  assert.equal(pick(hours(E)).clock.id, 'open_all_hours');
  assert.match(text(pick(hours(E)).clock.line), /3 to 6 AM, held just 20%/);
  // Thin: 192 messages spread evenly are not enough to say it.
  assert.equal(pick(hours(flat(24, 8))).clock.id, 'by_peak_hour');
});

test('clock: two rush hours (5+ hours apart, the lower one at least 80%, both at least 6%, a dip between)', () => {
  const H = flat(24, 10);
  H[8] = 100;
  H[20] = 90;
  const c = pick(hours(H));
  assert.equal(c.clock.id, 'two_rush_hours');
  assert.equal(c.clock.headline, 'Two rush hours.');
  assert.equal(text(c.clock.line), 'Rush hours at 8 AM and 8 PM: 100 and 90 messages.');
  // Just short: the second peak at 79%.
  H[20] = 79;
  assert.equal(pick(hours(H)).clock.id, 'clockwork');
  // Four hours apart is one long peak, not two.
  const near = flat(24, 10);
  near[8] = 100;
  near[12] = 95;
  assert.notEqual(pick(hours(near)).clock.id, 'two_rush_hours');
  // A plateau has no dip: not two peaks.
  const plateau = flat(24, 10);
  for (let h = 8; h <= 20; h++) plateau[h] = 95;
  plateau[8] = 100;
  plateau[20] = 99;
  assert.notEqual(pick(hours(plateau)).clock.id, 'two_rush_hours');
  // Each peak needs 6% of the chat: a second bump at 5.9% is not a rush hour.
  const small = flat(24, 42);
  small[7] = small[9] = 66;
  small[8] = 70;
  small[20] = 58;
  for (let h = 12; h <= 16; h++) small[h] = 20;
  assert.ok(58 / F.sum(small) < 0.06 && 58 / F.sum(small) > 0.058);
  assert.equal(pick(hours(small)).clock.id, 'by_peak_hour');
  small[20] = 60;
  assert.ok(60 / F.sum(small) >= 0.06);
  assert.equal(pick(hours(small)).clock.id, 'two_rush_hours');
});

test('clock: like clockwork (the busiest hour holds at least 15%)', () => {
  const H = flat(24, 50);
  H[11] = 210; // 210 of 1,360: 15.4%
  const c = pick(hours(H));
  assert.equal(c.clock.id, 'clockwork');
  assert.equal(c.clock.headline, '11 AM, like clockwork.');
  assert.equal(text(c.clock.line), '210 messages landed between 11 AM and noon. That’s 15% of everything.');
  // Just short: 200 of 1,350 is 14.8%.
  H[11] = 200;
  const short = pick(hours(H));
  assert.equal(short.clock.id, 'by_peak_hour');
  assert.equal(short.clock.headline, 'A morning kind of chat.');
  // Midnight and noon are said as words.
  const M = flat(24, 50);
  M[0] = 300;
  assert.equal(pick(hours(M)).clock.headline, 'Midnight, like clockwork.');
  const N = flat(24, 50);
  N[12] = 300;
  assert.equal(pick(hours(N)).clock.headline, 'Noon, like clockwork.');
  // Thin: 99 messages.
  const T = flat(24, 0);
  T[11] = 30;
  T[12] = 69;
  assert.equal(pick(hours(T)).clock.id, 'by_peak_hour');
});

test('clock: the default line follows the peak hour as before', () => {
  const want = ['Up way past bedtime.', 'Up before the alarm.', 'A morning kind of chat.', 'Out to lunch, in the chat.', 'The afternoon scroll.', 'Loudest around dinner.', 'Loudest after dark.'];
  for (const [hour, headline] of [[2, 0], [7, 1], [10, 2], [13, 3], [16, 4], [19, 5], [22, 6]]) {
    const H = flat(24, 50);
    H[hour] = 120;
    H[(hour + 1) % 24] = 110;
    assert.equal(pick(hours(H)).clock.headline, want[headline], `peak at ${hour}`);
  }
});

test('hourStretch says a three-hour stretch the way people do', () => {
  assert.equal(I.hourStretch(19, 3), '7 to 10 PM');
  assert.equal(I.hourStretch(1, 3), '1 to 4 AM');
  assert.equal(I.hourStretch(10, 3), '10 AM to 1 PM');
  assert.equal(I.hourStretch(9, 3), '9 AM to noon');
  assert.equal(I.hourStretch(21, 3), '9 PM to midnight');
  assert.equal(I.hourStretch(22, 3), '10 PM to 1 AM');
  assert.equal(I.hourStretch(0, 3), 'midnight to 3 AM');
  assert.equal(I.hourStretch(12, 3), 'noon to 3 PM');
});

// ── late night ───────────────────────────────────────────────────────────────────────

const night = (messages, share, top) => (raw) => { raw.late_night = { messages, share, top: top === undefined ? { name: 'Dev', messages: Math.floor(messages / 3) } : top }; };

test('late night: a tagline by tier, guarded against a handful of messages', () => {
  const tier = (n, share) => { const c = pick(night(n, share)); return [c.late.id, c.late.tagline]; };
  assert.deepStrictEqual(tier(0, 0), ['none', 'A suspiciously well-rested chat.']);
  assert.deepStrictEqual(tier(5, 0.005), ['asleep', 'Practically asleep by midnight.']);
  assert.deepStrictEqual(tier(1, 0), ['asleep', 'Practically asleep by midnight.']);
  assert.deepStrictEqual(tier(50, 0.01), ['occasional', 'The occasional late one.']);
  assert.equal(tier(50, 0.0099)[0], 'asleep');
  assert.deepStrictEqual(tier(20, 0.05), ['night_shift', 'A proper night shift.']);
  assert.equal(tier(20, 0.0499)[0], 'occasional');
  assert.deepStrictEqual(tier(20, 0.15), ['no_sleep', 'Does anyone here sleep?']);
  assert.equal(tier(20, 0.1499)[0], 'night_shift');
  // Thin: 19 messages are not a night shift, whatever share they are.
  assert.equal(tier(19, 0.3)[0], 'occasional');
  assert.equal(tier(19, 0.08)[0], 'occasional');
});

test('late night: one person with 60% of at least 10 late messages ran the night shift', () => {
  const top = (n, mine) => pick(night(n, 0.1, { name: 'Sam', messages: mine })).late.top;
  assert.deepStrictEqual(top(10, 6), { id: 'solo', verb: ' ran the night shift, mostly solo', detail: '6 of 10 late-night messages' });
  assert.deepStrictEqual(top(10, 10), { id: 'solo', verb: ' ran the night shift alone', detail: '10 of 10 late-night messages' });
  assert.deepStrictEqual(top(10, 5), { id: 'lights_on', verb: ' kept the lights on', detail: '5 late-night messages' });
  assert.equal(top(9, 9).id, 'lights_on', 'nine late messages are too few to call it a shift');
  assert.equal(top(1000, 599).id, 'lights_on');
  assert.equal(top(1000, 600).id, 'solo');
  // No top person, no bubble.
  assert.equal(pick(night(100, 0.1, null)).late.top, null);
});

// ── week ─────────────────────────────────────────────────────────────────────────────

const weekdays = (W) => (raw) => { raw.by_weekday = W.map((v) => v * 10); };

test('week: weekends are for the chat (Saturday and Sunday at least 45%)', () => {
  const c = pick(weekdays([11, 11, 11, 11, 11, 23, 22]));
  assert.equal(c.week.id, 'weekend_chat');
  assert.equal(c.week.headline, 'Weekends are for the chat.');
  assert.equal(text(c.week.line), '230 messages landed on a Saturday. Weekends are 45% of the chat.');
  assert.equal(pick(weekdays([11, 11, 11, 11, 12, 22, 22])).week.id, 'by_peak_day');
});

test('week: strictly Monday to Friday (weekends at most 10%)', () => {
  const c = pick(weekdays([19, 19, 19, 19, 14, 5, 5]));
  assert.equal(c.week.id, 'weekdays_only');
  assert.equal(c.week.headline, 'Strictly Monday to Friday.');
  assert.equal(text(c.week.line), '190 messages landed on a Monday. Weekdays carry 90% of the chat.');
  assert.equal(pick(weekdays([19, 19, 19, 19, 13, 6, 5])).week.id, 'by_peak_day');
});

test('week: one day carries the week (at least 25%)', () => {
  const c = pick(weekdays([10, 10, 25, 10, 15, 15, 15]));
  assert.equal(c.week.id, 'one_day');
  assert.equal(c.week.headline, 'Wednesdays carry the week.');
  assert.equal(text(c.week.line), '250 messages landed on a Wednesday. That’s 25% of the week.');
  assert.equal(pick(weekdays([10, 11, 24, 10, 15, 15, 15])).week.id, 'by_peak_day');
});

test('week: every day is chat day (busiest at most 1.2 times the quietest)', () => {
  const c = pick(weekdays([15, 15, 15, 15, 18, 15, 15]));
  assert.equal(c.week.id, 'every_day');
  assert.equal(c.week.headline, 'Every day is chat day.');
  assert.equal(text(c.week.line), 'From 150 on Mondays to 180 on Fridays. Barely a gap.');
  assert.equal(pick(weekdays([14, 14, 14, 14, 17, 13, 14])).week.id, 'by_peak_day');
});

test('week: thin data keeps the default (fewer than 100 messages, or under three weeks)', () => {
  assert.equal(pick((raw) => { raw.by_weekday = [11, 11, 11, 11, 11, 23, 22].map((v) => v * 0.9); }).week.id, 'by_peak_day');
  assert.equal(pick((raw) => { weekdays([11, 11, 11, 11, 11, 23, 22])(raw); raw.period.end = '2026-01-20'; }).week.id, 'by_peak_day');
  assert.equal(pick((raw) => { weekdays([11, 11, 11, 11, 11, 23, 22])(raw); raw.period.end = '2026-01-21'; }).week.id, 'weekend_chat');
  // Without dates the period cannot be checked; the message count still is.
  assert.equal(pick((raw) => { weekdays([11, 11, 11, 11, 11, 23, 22])(raw); raw.period = { label: '2026' }; }).week.id, 'weekend_chat');
});

// ── year ─────────────────────────────────────────────────────────────────────────────

const months = (M, period) => (raw) => { raw.by_month = M.map((v) => v * 10); if (period) raw.period = period; };

test('year: one month was the whole story (at least 35%)', () => {
  const c = pick(months([5, 5, 5, 5, 5, 5, 35, 5, 5, 5, 10, 10]));
  assert.equal(c.year.id, 'one_month');
  assert.equal(c.year.headline, 'All about July.');
  assert.equal(text(c.year.line), '35% of everything was sent in July.');
  assert.equal(pick(months([8, 8, 8, 8, 8, 8, 34, 6, 3, 3, 3, 3])).year.id, 'peak_month');
});

test('year: quiet months, then the big one (three full months under 1% before the peak)', () => {
  const c = pick(months([0, 0, 0, 10, 10, 10, 30, 10, 10, 10, 5, 5]));
  assert.equal(c.year.id, 'quiet_then');
  assert.equal(c.year.headline, 'Quiet, then July.');
  assert.equal(text(c.year.line), '3 months under 1% each. Then July brought 30%.');
  // Just short: two quiet months.
  assert.notEqual(pick(months([2, 0, 0, 10, 10, 10, 30, 10, 10, 10, 4, 4])).year.id, 'quiet_then');
  // Quiet months after the peak are not "quiet, then".
  assert.notEqual(pick(months([10, 10, 10, 30, 10, 10, 10, 10, 10, 0, 0, 0])).year.id, 'quiet_then');
});

test('year: loud start (the first half of the months holds at least 70%)', () => {
  const c = pick(months([20, 20, 15, 10, 5, 5, 5, 5, 5, 4, 3, 3]));
  assert.equal(c.year.id, 'loud_start');
  assert.equal(c.year.headline, 'Loud start. Life happened.');
  assert.equal(text(c.year.line), '75% of it came by the end of June.');
  assert.equal(pick(months([20, 18, 13, 9, 5, 4, 6, 6, 6, 5, 4, 4])).year.id, 'peak_month');
});

test('year: loud finish (the second half holds at least 70%)', () => {
  const c = pick(months([3, 3, 4, 5, 5, 5, 5, 5, 10, 15, 20, 20]));
  assert.equal(c.year.id, 'loud_finish');
  assert.equal(c.year.headline, 'A slow start. A loud finish.');
  assert.equal(text(c.year.line), '75% of it came from July on.');
  assert.equal(pick(months([4, 4, 5, 6, 6, 6, 6, 9, 13, 9, 17, 15])).year.id, 'peak_month');
});

test('year: steady (the busiest month at most 1.25 times the average month)', () => {
  const c = pick(months([8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 10, 10]));
  assert.equal(c.year.id, 'steady');
  assert.equal(c.year.headline, 'Steady all year.');
  assert.equal(text(c.year.line), 'November, the busiest month, was just 20% above average.');
  assert.equal(pick(months([8, 8, 8, 8, 8, 8, 8, 8, 8, 7, 11, 10])).year.id, 'peak_month');
  // A period that is not a calendar year says so.
  assert.equal(pick((raw) => { months([8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 10, 10])(raw); raw.period.label = 'Summer to summer'; }).year.headline, 'Steady the whole way.');
});

test('year: a recap for the current year ends today, and the empty months after it do not count', () => {
  // Jan 1 to Sep 15: October to December are empty because they have not happened.
  const partial = [10, 10, 10, 10, 10, 10, 12, 10, 5, 0, 0, 0];
  const c = pick(months(partial, { label: '2026', start: '2026-01-01', end: '2026-09-15' }));
  assert.equal(c.year.id, 'steady', 'nine level months are steady, whatever comes after the end');
  // Over the whole year the same numbers are a busy July in a year that went quiet.
  assert.equal(pick(months(partial)).year.id, 'peak_month');
  // The months before a period that starts in April are empty for the same reason, and
  // are not three quiet months before the peak.
  const april = [0, 0, 0, 10, 10, 10, 30, 10, 10, 10, 5, 5];
  assert.equal(pick(months(april, { label: '2026', start: '2026-04-01', end: '2026-12-31' })).year.id, 'peak_month');
  // A first month cut short by the period is never a quiet month.
  assert.notEqual(pick(months([0, 0, 0, 10, 10, 10, 30, 10, 10, 10, 5, 5], { label: '2026', start: '2026-01-20', end: '2026-12-31' })).year.id, 'quiet_then');
  // A year that runs June to May is read in that order.
  const june = pick(months([3, 3, 4, 5, 5, 20, 20, 15, 10, 5, 5, 5], { label: 'Our year', start: '2025-06-01', end: '2026-05-31' }));
  assert.equal(june.year.id, 'loud_start');
  assert.equal(text(june.year.line), '75% of it came by the end of November.');
});

test('periodMonths lists the months inside the period, in order, with the partial ones marked', () => {
  const M = flat(12, 1);
  const pm = (start, end) => I.periodMonths({ period: { start, end } }, M);
  const a = pm('2026-01-01', '2026-11-10');
  assert.deepStrictEqual(a.list, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.equal(a.full[10], false, 'November is cut short');
  assert.equal(a.full[0], true);
  assert.equal(a.ordered, true);
  assert.deepStrictEqual(pm('2025-10-15', '2026-03-31').list, [9, 10, 11, 0, 1, 2]);
  assert.equal(pm('2025-10-15', '2026-03-31').full[9], false);
  assert.equal(pm('2025-10-15', '2026-03-31').full[2], true);
  const long = pm('2019-03-02', '2026-11-10');
  assert.equal(long.list.length, 12);
  assert.equal(long.ordered, false, 'over several years the months are sums, not a sequence');
  // No dates: the months from the first to the last with messages.
  const none = I.periodMonths({ period: {} }, [0, 0, 5, 1, 0, 3, 0, 0, 0, 0, 0, 0]);
  assert.deepStrictEqual(none.list, [2, 3, 4, 5]);
});

test('year: thin data keeps the default (fewer than six months in the period, or under 100 messages)', () => {
  assert.equal(pick(months([5, 5, 5, 5, 5, 5, 35, 5, 5, 5, 10, 10], { label: '2026', start: '2026-03-01', end: '2026-07-31' })).year.id, 'peak_month');
  assert.equal(pick(months([5, 5, 5, 5, 5, 5, 35, 5, 5, 5, 10, 10], { label: '2026', start: '2026-02-01', end: '2026-07-31' })).year.id, 'one_month');
  assert.equal(pick((raw) => { raw.by_month = [5, 5, 5, 5, 5, 5, 35, 5, 5, 5, 10, 9]; }).year.id, 'peak_month');
  // Over several years by_month sums the same month of each, so halves mean nothing.
  assert.equal(pick(months([20, 20, 15, 10, 5, 5, 5, 5, 5, 4, 3, 3], { label: '2019–2026', start: '2019-03-02', end: '2026-11-10' })).year.id, 'peak_month');
});

// ── senders ──────────────────────────────────────────────────────────────────────────

const people = (counts, members) => (raw) => {
  const total = counts.reduce((a, b) => a + b, 0);
  raw.totals.messages = total;
  raw.chat.members = members || counts.length;
  raw.senders = counts.map((m, i) => ({ name: 'P' + i, messages: m, share: Math.round((m / total) * 10000) / 10000 }));
};

test('senders: two people, one voice, a photo finish, a runaway, everyone, or who carried it', () => {
  const id = (counts, members) => pick(people(counts, members)).senders;
  assert.deepStrictEqual(id([600, 400]), { id: 'duo', headline: 'It takes two.' });
  assert.deepStrictEqual(id([500, 300, 200]), { id: 'one_voice', headline: 'One voice, mostly.' });
  assert.equal(id([490, 300, 210]).id, 'carried');
  assert.deepStrictEqual(id([340, 330, 330]), { id: 'photo_finish', headline: 'A photo finish.' });
  assert.equal(id([341, 330, 329]).id, 'even');
  assert.deepStrictEqual(id([400, 200, 200, 200]), { id: 'runaway', headline: 'Nobody else came close.' });
  assert.equal(id([400, 201, 200, 199]).id, 'carried');
  assert.deepStrictEqual(id([300, 250, 250, 200]), { id: 'even', headline: 'Everyone chipped in.' });
  assert.equal(id([340, 220, 220, 220]).id, 'carried', 'top share times four is 1.36');
  assert.equal(id([300, 250, 250, 200], 5).id, 'carried', 'a member who never wrote did not chip in');
  // Thin: 40 messages say little about who carried what.
  assert.equal(id([25, 10, 5]).id, 'carried');
});

// ── message of the year ──────────────────────────────────────────────────────────────

const winner = (reactions, kinds) => (raw) => { raw.most_reacted[0].reactions = reactions; raw.most_reacted[0].kinds = kinds; };

test('message of the year: mostly laughs, mostly hearts, mostly emphasis, or mixed', () => {
  const m = (reactions, kinds) => { const c = pick(winner(reactions, kinds)).moty; return [c.id, text(c.line)]; };
  assert.deepStrictEqual(m(6, { laugh: 4, love: 1, emphasize: 1 }), ['laughs', '4 of them were laughs. Comedy gold.']);
  assert.deepStrictEqual(m(6, { laugh: 3, love: 3 }), ['mixed', ''], 'exactly half is not "mostly"');
  assert.deepStrictEqual(m(7, { love: 4, laugh: 3 }), ['hearts', '4 of them were hearts. Pure love.']);
  assert.deepStrictEqual(m(6, { emphasize: 5, like: 1 }), ['emphasis', '5 of them were a big !!']);
  assert.deepStrictEqual(m(6, { like: 5, laugh: 1 }), ['mixed', ''], 'thumbs-up is not one of the three');
  assert.deepStrictEqual(m(2, { laugh: 2 }), ['mixed', ''], 'two tapbacks are too few to say "mostly"');
  assert.deepStrictEqual(m(3, { laugh: 2, love: 1 }), ['laughs', '2 of them were laughs. Comedy gold.']);
  assert.deepStrictEqual(m(6, {}), ['mixed', ''], 'no breakdown');
});

// ── tapbacks ─────────────────────────────────────────────────────────────────────────

const tapbacks = (messages, byKind) => (raw) => {
  raw.totals.messages = messages;
  raw.reactions.by_kind = Object.assign({ love: 0, like: 0, dislike: 0, laugh: 0, emphasize: 0, question: 0, emoji: 0 }, byKind);
  raw.totals.reactions = Object.values(raw.reactions.by_kind).reduce((a, b) => a + b, 0);
};

test('tapbacks: reacts to everything (at least one for every two messages)', () => {
  const c = pick(tapbacks(1000, { laugh: 300, love: 200 }));
  assert.equal(c.taps.id, 'reacts_to_everything');
  assert.equal(c.taps.headline, 'Reacts to everything.');
  assert.equal(text(c.taps.line), 'That’s 50 for every 100 messages.');
  assert.equal(pick(tapbacks(1000, { laugh: 300, love: 199 })).taps.id, 'by_top_kind');
  assert.equal(pick(tapbacks(40, { laugh: 30, love: 10 })).taps.id, 'by_top_kind', 'thin: 40 messages');
});

test('tapbacks: rare (under 3 for every 100 messages)', () => {
  const c = pick(tapbacks(1000, { laugh: 20, love: 9 }));
  assert.equal(c.taps.id, 'rare');
  assert.equal(c.taps.headline, 'Saved for big moments.');
  assert.equal(text(c.taps.line), 'That’s 3 for every 100 messages.');
  assert.equal(pick(tapbacks(1000, { laugh: 20, love: 10 })).taps.id, 'by_top_kind');
  assert.equal(text(pick(tapbacks(10000, { laugh: 50, love: 9 })).taps.line), 'Fewer than 1 for every 100 messages.');
  assert.equal(pick(tapbacks(99, { laugh: 1 })).taps.id, 'by_top_kind', 'thin: 99 messages');
});

test('tapbacks: neck and neck (the top two kinds within 10% of each other)', () => {
  const c = pick(tapbacks(1000, { love: 100, laugh: 90, like: 20 }));
  assert.equal(c.taps.id, 'neck_and_neck');
  assert.equal(c.taps.headline, 'Neck and neck.');
  assert.equal(text(c.taps.line), 'Hearts and laughs, within 10% of each other.');
  assert.equal(text(pick(tapbacks(1000, { laugh: 100, love: 100 })).taps.line), 'Hearts and laughs, exactly level.');
  assert.equal(text(pick(tapbacks(10000, { laugh: 1000, emphasize: 995 })).taps.line), 'Laughs and emphasis, less than 1% apart.');
  const short = pick(tapbacks(1000, { love: 100, laugh: 89, like: 20 }));
  assert.equal(short.taps.id, 'by_top_kind');
  assert.equal(short.taps.headline, 'Mostly love.');
  assert.equal(pick(tapbacks(200, { love: 15, laugh: 14 })).taps.id, 'by_top_kind', 'thin: 29 tapbacks');
  assert.equal(pick(tapbacks(200, { love: 16, laugh: 15 })).taps.id, 'neck_and_neck');
});

// ── total ────────────────────────────────────────────────────────────────────────────

const words = (messages, count) => (raw) => { raw.totals.messages = messages; raw.totals.words = count; };

test('total: one matched fact about message length, only when it stands out', () => {
  assert.deepStrictEqual(pick(words(1000, 3990)).total, { id: 'short_texts', fact: 'Short and sweet: 4 words a text' });
  assert.deepStrictEqual(pick(words(1000, 3100)).total, { id: 'short_texts', fact: 'Short and sweet: 3.1 words a text' });
  assert.equal(pick(words(1000, 4000)).total.id, 'plain');
  assert.deepStrictEqual(pick(words(1000, 14000)).total, { id: 'long_texts', fact: 'Paragraph people: 14 words a text' });
  assert.equal(pick(words(1000, 11990)).total.id, 'plain');
  assert.equal(pick(words(1000, 1000)).total.fact, 'Short and sweet: 1 word a text');
  assert.equal(pick(words(99, 200)).total.id, 'plain', 'thin: 99 messages');
  assert.equal(pick(words(1000, 0)).total.id, 'plain', 'no word count');
});

// ── every headline ───────────────────────────────────────────────────────────────────

test('every headline fits like the old ones, names no product and no person', () => {
  const seen = new Set();
  const taglines = new Set();
  const add = (c) => {
    for (const v of Object.values(c)) {
      if (v && v.headline) seen.add(v.headline);
      if (v && v.tagline) taglines.add(v.tagline);
    }
  };
  // Every hour, weekday and month in every templated headline.
  for (let h = 0; h < 24; h++) {
    const H = flat(24, 50);
    H[h] = 300;
    add(pick(hours(H)));
    const D = flat(24, 50);
    D[h] = 120;
    add(pick(hours(D)));
  }
  for (let d = 0; d < 7; d++) {
    const W = flat(7, 10);
    W[d] = 30;
    add(pick(weekdays(W)));
    const V = flat(7, 14);
    V[d] = 16;
    add(pick(weekdays(V)));
  }
  for (let m = 0; m < 12; m++) {
    const M = flat(12, 5);
    M[m] = 50;
    add(pick(months(M)));
    const Q = [0, 0, 0, 0, 10, 10, 10, 10, 10, 10, 10, 10];
    Q[Math.max(4, m)] = 30;
    add(pick(months(Q)));
    const S = flat(12, 5);
    S[m] = 6;
    add(pick(months(S)));
    const P = flat(12, 5);
    P[m] = 10;
    add(pick(months(P)));
  }
  for (const k of ['love', 'like', 'dislike', 'laugh', 'emphasize', 'question', 'emoji']) add(pick(tapbacks(1000, { [k]: 100 })));
  for (const [n, s] of [[0, 0], [5, 0.005], [50, 0.02], [50, 0.08], [50, 0.2]]) add(pick(night(n, s)));
  for (const counts of [[6, 4], [500, 300, 200], [340, 330, 330], [400, 200, 200, 200], [300, 250, 250, 200], [400, 300, 300]]) add(pick(people(counts)));
  add(pick(tapbacks(1000, { laugh: 600 })));
  add(pick(tapbacks(1000, { laugh: 10 })));
  add(pick(months([20, 20, 15, 10, 5, 5, 5, 5, 5, 4, 3, 3])));
  add(pick(months([3, 3, 4, 5, 5, 5, 5, 5, 10, 15, 20, 20])));
  add(pick(hours(flat(24, 100))));
  const two = flat(24, 10);
  two[8] = 100;
  two[20] = 90;
  add(pick(hours(two)));
  assert.ok(seen.size >= 60, `checked ${seen.size} headlines`);
  assert.equal(taglines.size, 5, 'and the five late-night taglines');
  for (const line of seen) {
    // The longest of the old headlines ("Thursday is the new Friday.") has 27 characters.
    assert.ok(Array.from(line).length <= 28, `"${line}" is short enough (${line.length})`);
  }
  for (const line of [...seen, ...taglines]) {
    assert.doesNotMatch(line, /imessage|wrapped/i, line);
    assert.doesNotMatch(line, /\bP\d\b|Dev|Maya|Sam/, `"${line}" names nobody`);
  }
  // A tagline sits under the late-night number; the old one there has 32 characters.
  for (const line of taglines) assert.ok(Array.from(line).length <= 32, `"${line}" is short enough (${line.length})`);
});

test('insights.js is a pure classic script: no DOM, one global, loads before the slides', () => {
  const src = fs.readFileSync(path.join(__dirname, '../../web/js/insights.js'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(src, /\bdocument\b|\bwindow\.|innerHTML|createElement/);
  assert.match(src, /root\.WrappedInsights = Insights;/);
  const html = fs.readFileSync(path.join(__dirname, '../../web/index.html'), 'utf8');
  const scripts = [...html.matchAll(/<script src="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(scripts.indexOf('js/format.js') < scripts.indexOf('js/insights.js'), 'after format.js');
  assert.ok(scripts.indexOf('js/insights.js') >= 0 && scripts.indexOf('js/insights.js') < scripts.indexOf('js/slides.js'), 'before slides.js');
});
