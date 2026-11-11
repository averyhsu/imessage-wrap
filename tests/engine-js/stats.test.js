'use strict';
// The counting rules of docs/SCHEMA.md section 2, one at a time, on hand-made rows.

const test = require('node:test');
const assert = require('node:assert/strict');
const { Engine, LA, APPLE_EPOCH, utc, ns, msg, tap, fixture, hexToBytes } = require('./support.js');

const I = Engine._internals;
const A = '+15550100001', B = '+15550100002', C = '+15550100003';
const NOW = utc(2026, 11, 11, 20);        // 12:00 PST

function run(rows, options) {
  return Engine.computeStats(rows, Object.assign({ tz: 'UTC', now: NOW }, options || {}));
}

// ---- timestamps -------------------------------------------------------------

test('nanoseconds, seconds, strings and BigInt', () => {
  const t = utc(2026, 3, 1, 15, 30);
  const rows = [msg(t, A), { date: t - APPLE_EPOCH, handle: B, text: 'seconds' },
    { date: String(t - APPLE_EPOCH), handle: B, text: 'seconds as text' },
    { date: BigInt(ns(t, 999999999)), handle: C, text: 'bigint' }];
  const st = run(rows);
  assert.equal(st.totals.messages, 4);
  assert.equal(st.by_hour[15], 4);
  assert.deepEqual(st.busiest_day, { date: '2026-03-01', messages: 4 });
});

test('threshold between units and unusable dates', () => {
  assert.deepEqual(I.splitDate(99999), [99999 + APPLE_EPOCH, 0]);
  assert.deepEqual(I.splitDate(100000000001), [100 + APPLE_EPOCH, 1]);
  assert.deepEqual(I.splitDate('100000000001'), [100 + APPLE_EPOCH, 1]);
  assert.equal(I.splitDate(100000000000), null);       // as seconds: the year 5138
  assert.deepEqual(I.splitDate('804914400100000001'), [804914400 + APPLE_EPOCH, 100000001]);
  assert.equal(Engine.dateToUnix('804914400999999999'), 804914400 + APPLE_EPOCH);
  const rows = [msg(utc(2026, 3, 1), A)];
  for (const bad of [null, undefined, 0, -5, '', 'soon', '9000000000000000000', NaN, {}]) {
    rows.push({ date: bad, handle: B, text: 'no date' });
  }
  assert.equal(run(rows, { all_time: true }).totals.messages, 1);
});

test('the last nanosecond of a day stays on that day', () => {
  const t = utc(2026, 2, 15, 7, 59, 59);              // 23:59:59 PST on Feb 14
  const rows = [{ date: ns(t, 999999999), handle: A, text: 'late' },
    { date: ns(t + 1), handle: A, text: 'midnight' }];
  const st = run(rows, { tz: LA });
  assert.equal(st.by_hour[23], 1);
  assert.equal(st.by_hour[0], 1);
  assert.equal(st.totals.days_active, 2);
  assert.equal(st.totals.longest_streak, 2);
  // the same value as a JavaScript number has already lost the nanoseconds:
  assert.notEqual(Number(ns(t, 999999999)), 792748799999999999n);
});

test('local time-zone buckets', () => {
  const t = utc(2026, 7, 5, 4, 30);                    // Jul 4 21:30 PDT, Jul 5 10:00 IST
  const cases = {
    [LA]: ['2026-07-04', 21, 5], UTC: ['2026-07-05', 4, 6], 'Asia/Kolkata': ['2026-07-05', 10, 6],
    'Asia/Kathmandu': ['2026-07-05', 10, 6], 'Pacific/Chatham': ['2026-07-05', 17, 6]
  };
  for (const zone of Object.keys(cases)) {
    const st = run([msg(t, A)], { tz: zone });
    assert.equal(st.busiest_day.date, cases[zone][0], zone);
    assert.equal(st.by_hour[cases[zone][1]], 1, zone);
    assert.equal(st.by_weekday[cases[zone][2]], 1, zone);
    assert.equal(st.by_month[6], 1, zone);
  }
});

test('daylight-saving transitions', () => {
  const rows = [msg(utc(2026, 3, 8, 9, 59), A), msg(utc(2026, 3, 8, 10, 0, 30), A),
    msg(utc(2026, 11, 1, 8, 30), A), msg(utc(2026, 11, 1, 9, 30), A)];
  const st = run(rows, { tz: LA });
  assert.equal(st.by_hour[1], 3);
  assert.equal(st.by_hour[3], 1);
  assert.equal(st.by_hour[2], 0);
});

test('the offset table matches Intl at every sampled instant', () => {
  for (const zone of [LA, 'Asia/Kolkata', 'Australia/Lord_Howe', 'Europe/London', 'Pacific/Apia', 'UTC']) {
    const offsetAt = I.offsetFunction(zone);
    const lo = utc(2009, 1, 1), hi = utc(2027, 1, 1);
    const table = new I.Offsets(offsetAt, lo, hi);
    for (let t = lo; t < hi; t += 5 * 3600 + 1234) assert.equal(table.at(t), offsetAt(t), zone + ' ' + t);
    for (const start of table.starts.slice(1)) assert.notEqual(table.at(start - 1), table.at(start), zone);
  }
  const la = new I.Offsets(I.offsetFunction(LA), utc(2026, 1, 1), utc(2026, 12, 31));
  assert.deepEqual(la.starts.slice(1), [utc(2026, 3, 8, 10), utc(2026, 11, 1, 9)]);
  assert.deepEqual(la.offsets, [-28800, -25200, -28800]);
});

test('time-zone lookups are few, however many messages there are', () => {
  let calls = 0;
  const RealFormat = Intl.DateTimeFormat;
  const counting = function (...args) {
    const real = new RealFormat(...args);
    return { formatToParts: (d) => { calls += 1; return real.formatToParts(d); } };
  };
  Intl.DateTimeFormat = counting;
  try {
    const rows = [];
    for (let i = 0; i < 20000; i++) rows.push(msg(utc(2026, 1, 1) + i * 1300, A, 'x'));
    const st = run(rows, { tz: LA, all_time: true });
    assert.equal(st.totals.messages, 20000);
    assert.ok(calls < 1000, 'Intl was called ' + calls + ' times');
  } finally {
    Intl.DateTimeFormat = RealFormat;
  }
});

test('default zone is the device zone; unknown zones are errors', () => {
  const t = utc(2026, 6, 1, 12);
  const st = Engine.computeStats([msg(t, A)], { now: NOW });
  assert.equal(st.by_hour[new Date(t * 1000).getHours()], 1);
  assert.throws(() => run([msg(t, A)], { tz: 'Mars/Olympus_Mons' }), /unknown time zone/);
});

test('civil date helpers round-trip', () => {
  for (let day = -800; day < 40000; day += 37) {
    const date = new Date(day * 86400000);
    assert.deepEqual(I.civilFromDays(day), [date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate()]);
    assert.equal(I.daysFromCivil(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate()), day);
  }
  assert.equal(I.iso(0), '1970-01-01');
});

// ---- period ---------------------------------------------------------------

const PERIOD_ROWS = [msg(utc(2024, 6, 1, 12), A, 'old'), msg(utc(2025, 12, 31, 23), A, 'last year'),
  msg(utc(2026, 1, 1, 0), B, 'new year'), msg(utc(2026, 11, 11, 23), B, 'today'),
  msg(utc(2026, 11, 12, 0), B, 'tomorrow')];

test('default period, January, explicit year', () => {
  let st = run(PERIOD_ROWS);
  assert.deepEqual(st.period, { label: '2026', start: '2026-01-01', end: '2026-11-11' });
  assert.equal(st.totals.messages, 2);
  assert.equal(st.meta.generated, '2026-11-11');
  st = run(PERIOD_ROWS, { now: utc(2026, 1, 20, 12) });
  assert.deepEqual(st.period, { label: '2025', start: '2025-01-01', end: '2025-12-31' });
  assert.equal(st.totals.messages, 1);
  assert.equal(run(PERIOD_ROWS, { now: utc(2026, 2, 1, 3), tz: 'UTC' }).period.label, '2026');
  assert.equal(run(PERIOD_ROWS, { now: utc(2026, 2, 1, 3), tz: LA }).period.label, '2025');
  assert.deepEqual(run(PERIOD_ROWS, { year: 2025 }).period, { label: '2025', start: '2025-01-01', end: '2025-12-31' });
  assert.equal(run(PERIOD_ROWS, { year: 2023 }).totals.messages, 0);
});

test('all time and explicit bounds', () => {
  let st = run(PERIOD_ROWS, { all_time: true });
  assert.deepEqual(st.period, { label: 'All time', start: '2024-06-01', end: '2026-11-11' });
  assert.equal(st.totals.messages, 4);
  assert.deepEqual(run([], { all_time: true }).period, { label: 'All time', start: '2026-11-11', end: '2026-11-11' });
  st = run(PERIOD_ROWS, { start: '2025-12-31', end: '2026-01-01' });
  assert.deepEqual(st.period, { label: '2025-12-31 \u2013 2026-01-01', start: '2025-12-31', end: '2026-01-01' });
  assert.equal(st.totals.messages, 2);
  assert.equal(run(PERIOD_ROWS, { start: '2026-11-12', end: '2026-12-31' }).totals.messages, 1);
  assert.deepEqual(run(PERIOD_ROWS, { end: '2025-01-01', label: 'Early' }).period,
    { label: 'Early', start: '2024-06-01', end: '2025-01-01' });
  for (const bad of [{ start: '2026-02-30' }, { start: 'yesterday' }, { start: '2026-05-01', end: '2026-04-01' }]) {
    assert.throws(() => run(PERIOD_ROWS, bad), RangeError);
  }
});

// ---- countable ------------------------------------------------------------

const T = utc(2026, 5, 5, 10);
const count = (row) => run([row]).totals.messages;

test('text or an attachment is required', () => {
  assert.equal(count(msg(T, A, 'hi')), 1);
  assert.equal(count(msg(T, A, null)), 0);
  assert.equal(count(msg(T, A, '')), 0);
  assert.equal(count(msg(T, A, ' \n\t\u00a0')), 0);
  assert.equal(count(msg(T, A, '\ufffc')), 0);
  assert.equal(count(msg(T, A, '\ufffc', { cache_has_attachments: 1 })), 1);
  assert.equal(count(msg(T, A, null, { cache_has_attachments: 1 })), 1);
  assert.equal(count(msg(T, A, null, { keep_empty: 1 })), 1);
  assert.equal(count(msg(T, A, new Uint8Array(0))), 0);
  assert.equal(count(msg(T, A, new TextEncoder().encode('bytes are fine'))), 1);
});

test('group events and associated message types', () => {
  for (const itemType of [1, 2, 3, 4, 6]) assert.equal(count(msg(T, A, 'event', { item_type: itemType })), 0);
  assert.equal(count(msg(T, A, 'ok', { item_type: 0 })), 1);
  assert.equal(count(msg(T, A, 'ok', { item_type: null })), 1);
  for (const kind of [null, 0, 2, 3, 999]) {
    assert.equal(count(msg(T, A, 'x', { associated_message_type: kind })), 1, String(kind));
  }
  for (const kind of [1000, 2000, 2007, 3000, 3007, 4000]) {
    assert.equal(count(msg(T, A, 'x', { associated_message_type: kind, associated_message_guid: 'p:0/G' })), 0);
  }
});

test('attributedBody is used when text is empty', () => {
  const sample = fixture().info.typedstream_samples.find((s) => s.name === 'attachment_text');
  const body = hexToBytes(sample.hex);                 // U+FFFC + "Look at this cover"
  for (const text of [null, '']) {
    const st = run([msg(T, A, text, { attributedBody: body })]);
    assert.equal(st.totals.messages, 1);
    assert.equal(st.totals.words, 4);
  }
  assert.equal(run([msg(T, A, 'text wins', { attributedBody: body })]).totals.words, 2);
  assert.equal(run([msg(T, A, null, { attributedBody: new Uint8Array([1, 2, 3]) })]).totals.messages, 0);
});

test('attachments are counted per message', () => {
  const st = run([msg(T, A, '\ufffc\ufffc\ufffc', { cache_has_attachments: 1 }),
    msg(T, A, '\ufffclook', { cache_has_attachments: 1 }), msg(T, B, 'plain')]);
  assert.equal(st.totals.attachments, 2);
  assert.equal(st.totals.words, 2);
  assert.equal(st.senders[0].attachments, 2);
});

// ---- words ------------------------------------------------------------------

test('cleaning and word counting', () => {
  assert.equal(Engine.cleanText('  \ufffc hi \ufffd there \ufffc\n'), 'hi  there');
  assert.equal(Engine.cleanText(null), '');
  assert.equal(Engine.cleanText('\ufeff\u3000x\u2028'), 'x');
  const cases = [
    ['', 0], ['one', 1], ['two words', 2], ['tabs\tand\nnewlines\r\nmixed   spaces', 5],
    ['nbsp\u00a0separated\u00a0words', 3], ['ideographic\u3000space', 2],
    ['zero\u200bwidth\u200bspace is not a separator', 5], ['bom\ufeffinside', 2],
    ['unit\x1fseparator and\x1cfile separator', 3], ['next\x85line', 1],
    ['line\u2028separator\u2029paragraph', 3], ['narrow\u202fnbsp and\u205fmath space and\u1680ogham', 7],
    ['\u180emongolian vowel separator', 3], ['nul\x00inside the text', 3]
  ];
  for (const [text, expected] of cases) {
    assert.equal(Engine.countWords(Engine.cleanText(text)), expected, JSON.stringify(text));
  }
  const spaces = '\t\n\x0b\x0c\r \xa0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a' +
    '\u2028\u2029\u202f\u205f\u3000\ufeff';
  for (const ch of spaces) {
    assert.equal(Engine.countWords('a' + ch + 'b'), 2, JSON.stringify(ch));
    assert.equal(Engine.cleanText(ch + 'a' + ch), 'a', JSON.stringify(ch));
  }
  for (const ch of '\x1c\x1d\x1e\x1f\x85\u200b\u180e\u2060') {
    assert.equal(Engine.countWords('a' + ch + 'b'), 1, JSON.stringify(ch));
  }
});

// ---- senders ----------------------------------------------------------------

test('owner name, contacts and merging', () => {
  assert.equal(run([msg(T)]).senders[0].name, 'Me');
  assert.equal(run([msg(T)], { me: 'Avery' }).senders[0].name, 'Avery');
  const contacts = {
    '(555) 010-0001': 'Ines Calloway', 'Ines.Calloway@Example.com': 'Ines Calloway',
    '+44 20 5550 100002': 'Bram Okoye'
  };
  const rows = [msg(T, '+15550100001'), msg(T, 'ines.calloway@example.com'), msg(T, '5550100001'),
    msg(T, '+15550100002'), msg(T, '+15550100003'), msg(T, 'INES.CALLOWAY@EXAMPLE.COM')];
  for (const form of [contacts, Object.entries(contacts), new Map(Object.entries(contacts))]) {
    const st = run(rows, { contacts: form });
    const got = {};
    st.senders.forEach((s) => { got[s.name] = s.messages; });
    assert.deepEqual(got, { 'Ines Calloway': 4, 'Bram Okoye': 1, '+15550100003': 1 });
    assert.equal(st.chat.members, 4);
  }
  const pairs = [['+1 555 010 0001', 'Zed'], ['5550100001', 'Alba'], ['', 'Nobody'], ['+15550100002', '  '],
    [null, 'x'], ['555-010-0002', 'Bram']];
  const st = run([msg(T, A), msg(T, B)], { contacts: pairs });
  assert.deepEqual(st.senders.map((s) => s.name).sort(), ['Alba', 'Bram']);
  assert.deepEqual(run([msg(T, A), msg(T, B)], { contacts: pairs.slice().reverse() }).senders, st.senders);
  assert.equal(run([{ date: ns(T), is_from_me: 0, handle: null, text: 'who' }]).senders[0].name, 'Unknown');
  const merged = run([msg(T), msg(T, A)], { me: 'Sam', contacts: { [A]: 'Sam' } });
  assert.equal(merged.senders.length, 1);
  assert.equal(merged.chat.members, 1);
});

test('contact keys', () => {
  assert.equal(Engine.contactKey('+1 (555) 010-0001'), 'p:5550100001');
  assert.equal(Engine.contactKey('\u202a+1\u00a0555\u2011010\u20110001\u202c'), 'p:5550100001');
  assert.equal(Engine.contactKey('22000'), 'p:22000');
  assert.equal(Engine.contactKey(' Ines@Example.COM '), 'e:ines@example.com');
  assert.equal(Engine.contactKey('\u0130nes@example.com'), 'e:\u0130nes@example.com');
  assert.equal(Engine.contactKey('Pizza Planet'), null);
  assert.equal(Engine.contactKey(''), null);
  assert.equal(Engine.contactKey(null), null);
});

test('members, ordering, the cap of twelve and shares', () => {
  let st = run([msg(T, A)], { participants: [A, B, C, 'bram@example.com'], contacts: { [B]: 'Bram', 'bram@example.com': 'Bram' } });
  assert.equal(st.chat.members, 4);
  assert.equal(run([msg(T, '+15550109999')], { participants: [A] }).chat.members, 3);
  const rows = [];
  for (let i = 0; i < 15; i++) {
    const handle = '+155501001' + String(i).padStart(2, '0');
    for (let j = 0; j < 1 + (i % 3); j++) rows.push(msg(T + j, handle));
  }
  st = run(rows);
  assert.equal(st.senders.length, 12);
  for (let i = 1; i < st.senders.length; i++) {
    const a = st.senders[i - 1], b = st.senders[i];
    assert.ok(a.messages > b.messages || (a.messages === b.messages && a.name < b.name));
  }
  assert.equal(st.totals.messages, rows.length);
  assert.equal(st.chat.members, 16);
  const names = ['\u{1F525} Jake', '\uff21lice', 'Zed', 'amy', '\u00c9mile'];
  const contacts = {};
  names.forEach((n, i) => { contacts['+155501002' + String(i).padStart(2, '0')] = n; });
  st = run(Object.keys(contacts).map((h) => msg(T, h)), { contacts });
  assert.deepEqual(st.senders.map((s) => s.name), ['Zed', 'amy', '\u00c9mile', '\u{1F525} Jake', '\uff21lice']);
  st = run([msg(T, A), msg(T + 1, B), msg(T + 2, B)]);
  assert.deepEqual(st.senders.map((s) => s.share), [0.6667, 0.3333]);
  for (const [n, total, want] of [[1, 3, 0.3333], [2, 3, 0.6667], [1, 8, 0.125], [1, 16, 0.0625],
    [1, 32, 0.0313], [3, 32, 0.0938], [1, 20000, 0.0001], [1, 20001, 0], [5, 5, 1], [0, 5, 0], [0, 0, 0]]) {
    assert.equal(I.round4(n, total), want, n + '/' + total);
  }
});

test('chat names', () => {
  const contacts = { [A]: 'Ines Calloway', [B]: 'Bram Okoye', [C]: 'Sam Rivera', '+15550100004': 'Sam Chen' };
  const name = Engine.chatDisplayName;
  assert.equal(name('  Dinner Club ', [A, B]), 'Dinner Club');
  assert.equal(name('', [A], contacts), 'Ines');
  assert.equal(name(null, [A, B], contacts), 'Ines, Bram');
  assert.equal(name('', [A, B, C, '+15550100004'], contacts), 'Ines, Bram, Sam & 1 more');
  assert.equal(name(' ', [A, B, C, '+15550100004', 'x@example.com', '+15550100009'], contacts), 'Ines, Bram, Sam & 3 more');
  assert.equal(name('', [B, '+15550100007', A]), '+15550100002, +15550100007, +15550100001');
  assert.equal(name('', []), 'Unnamed group');
  assert.equal(name('', [A, B], { [A]: 'Avery' }, 'Avery'), '+15550100002');
  let st = run([msg(T, A)], { participants: [A, B, C, '+15550100004'], contacts, chat_name: '' });
  assert.deepEqual(st.chat, { name: 'Ines, Bram, Sam & 1 more', members: 5 });
  st = run([msg(T, A)], { chat_name: 'Named', participants: [A] });
  assert.deepEqual(st.chat, { name: 'Named', members: 2 });
});

// ---- tapbacks -----------------------------------------------------------------

function target() { return msg(T, A, 'funny thing', { guid: 'G-1', rowid: 1 }); }

test('each tapback kind; tapbacks are never messages', () => {
  const names = ['love', 'like', 'dislike', 'laugh', 'emphasize', 'question', 'emoji', 'emoji'];
  names.forEach((name, offset) => {
    const m = target();
    const st = run([m, tap(T + 5, B, 2000 + offset, m)]);
    assert.equal(st.reactions.by_kind[name], 1, name);
    assert.equal(st.totals.reactions, 1);
    assert.equal(st.totals.messages, 1);
  });
});

test('remove, change, chronological order and ROWID ties', () => {
  const m = target();
  let st = run([m, tap(T + 5, B, 2001, m), tap(T + 9, B, 3001, m)]);
  assert.equal(st.totals.reactions, 0);
  assert.deepEqual(st.most_reacted, []);
  assert.equal(st.reactions.top_giver, null);
  st = run([m, tap(T + 5, B, 2003, m), tap(T + 9, B, 2000, m)]);
  assert.deepEqual([st.reactions.by_kind.laugh, st.reactions.by_kind.love, st.totals.reactions], [0, 1, 1]);
  assert.equal(run([m, tap(T + 5, B, 2003, m), tap(T + 9, B, 3000, m)]).totals.reactions, 0);
  const add = tap(T + 5, B, 2001, m, { rowid: 9 });
  const remove = tap(T + 5, B, 3001, m, { rowid: 3 });
  remove.date = ns(T + 5, 1);                           // one nanosecond later, lower ROWID
  assert.equal(run([m, remove, add]).totals.reactions, 0);
  assert.equal(run([m, add, remove]).totals.reactions, 0);
  const first = tap(T + 5, B, 2000, m, { rowid: 3 });
  const second = tap(T + 5, B, 2003, m, { rowid: 4 });
  assert.equal(run([m, first, second]).reactions.by_kind.laugh, 1);
  assert.equal(run([m, second, first]).reactions.by_kind.laugh, 1);
});

test('target formats and message parts', () => {
  for (const prefix of ['p:0/', 'p:1/', 'bp:', '']) {
    const m = target();
    assert.equal(run([m, tap(T + 5, B, 2000, m, { prefix })]).totals.reactions, 1, prefix);
  }
  const m = target();
  const rows = [tap(T + 5, B, 2000, m, { prefix: 'p:0/' }), tap(T + 6, B, 2003, m, { prefix: 'p:1/' }),
    tap(T + 7, B, 3003, m, { prefix: 'p:1/' })];
  let st = run([m].concat(rows.slice(0, 2)));
  assert.deepEqual([st.reactions.by_kind.love, st.reactions.by_kind.laugh], [1, 1]);
  st = run([m].concat(rows));
  assert.deepEqual([st.reactions.by_kind.love, st.reactions.by_kind.laugh], [1, 0]);
});

test('targets that do not count, and the edges of the period', () => {
  const m = target();
  const event = msg(T, A, null, { guid: 'EV', item_type: 2 });
  let st = run([m, event, tap(T + 5, B, 2000, { guid: 'NOT-IN-CHAT' }), tap(T + 5, B, 2000, event),
    msg(T + 6, B, 'x', { associated_message_type: 2000 })]);
  assert.equal(st.totals.reactions, 0);
  const old = msg(utc(2025, 12, 31, 12), A, 'last year', { guid: 'OLD' });
  const rows = [m, old, tap(utc(2026, 1, 2), B, 2000, old), tap(utc(2026, 1, 3), C, 2003, m)];
  assert.equal(run(rows).totals.reactions, 1);
  assert.equal(run(rows, { year: 2025 }).totals.reactions, 0);      // added after 2025 ended
  assert.equal(run(rows, { all_time: true }).totals.reactions, 2);
  const late = [m, tap(T + 5, B, 2000, m), tap(utc(2026, 11, 12, 5), B, 3000, m)];
  assert.equal(run(late).totals.reactions, 1);                      // removed "tomorrow"
  assert.equal(run(late, { now: utc(2026, 11, 13) }).totals.reactions, 0);
});

test('reactors merge by display name; given and received', () => {
  const m = target();
  const contacts = { [B]: 'Bram', 'bram@example.com': 'Bram' };
  const rows = [m, tap(T + 5, B, 2001, m), tap(T + 9, 'bram@example.com', 3001, m)];
  assert.equal(run(rows, { contacts }).totals.reactions, 0);
  assert.equal(run(rows).totals.reactions, 1);
  const other = msg(T + 1, B, 'second', { guid: 'G-2' });
  const st = run([m, other, tap(T + 5, B, 2003, m), tap(T + 6, C, 2003, m), tap(T + 7, 'me', 2000, m),
    tap(T + 8, 'me', 2000, other), tap(T + 9, A, 2001, m)]);
  const people = {};
  st.senders.forEach((s) => { people[s.name] = s; });
  assert.equal(people[A].reactions_received, 4);
  assert.equal(people[A].reactions_given, 1);
  assert.equal(people[B].reactions_received, 1);
  assert.equal(people[B].reactions_given, 1);
  assert.equal(st.totals.reactions, 5);
  assert.deepEqual(st.reactions.top_giver, { name: 'Me', count: 2 });
  assert.deepEqual(st.reactions.top_receiver, { name: A, count: 4 });
});

test('most reacted: order, truncation, kinds, attachment flag', () => {
  const m1 = msg(utc(2026, 3, 1, 10), A, 'three', { guid: 'M1' });
  const m2 = msg(utc(2026, 2, 1, 10), B, '\u{1F602}'.repeat(200), { guid: 'M2' });
  const m3 = msg(utc(2026, 2, 1, 9), C, '\ufffc', { guid: 'M3', cache_has_attachments: 1, rowid: 30 });
  const m4 = msg(utc(2026, 1, 1, 9), C, 'one', { guid: 'M4' });
  const m5 = msg(utc(2026, 2, 1, 9), A, 'same instant, higher rowid', { guid: 'M5', rowid: 50 });
  let rows = [m1, m2, m3, m4, m5];
  const t = utc(2026, 4, 1);
  [A, B, C].forEach((who, i) => rows.push(tap(t + i, who, i ? 2003 : 2000, m1)));
  for (const m of [m2, m3, m5]) rows.push(tap(t + 10, A, 2004, m), tap(t + 11, B, 2001, m));
  rows.push(tap(t + 20, A, 2000, m4));
  let top = run(rows).most_reacted;
  assert.deepEqual(top.map((q) => q.sender), [A, C, A]);
  assert.deepEqual(top[0], { sender: A, reactions: 3, date: '2026-03-01', text: 'three', kinds: { laugh: 2, love: 1 } });
  assert.deepEqual(Object.keys(top[0].kinds), ['laugh', 'love']);
  assert.deepEqual(top[1], {
    sender: C, reactions: 2, date: '2026-02-01', text: '', kinds: { like: 1, emphasize: 1 }, attachment: true
  });
  assert.deepEqual(Object.keys(top[1].kinds), ['like', 'emphasize']);
  assert.equal(top[2].text, 'same instant, higher rowid');
  rows = rows.filter((r) => r !== m3 && r !== m5);
  top = run(rows).most_reacted;
  assert.equal(top[1].text, '\u{1F602}'.repeat(180) + '\u2026');      // characters, not UTF-16 units
  assert.equal(top.length, 3);
});

// ---- calendar and shape -------------------------------------------------------

test('days, streaks, busiest day, late night', () => {
  const days = [[1, 1], [1, 2], [1, 3], [1, 5], [2, 27], [2, 28], [3, 1], [3, 2], [3, 3], [6, 9]];
  let rows = [];
  for (const [month, day] of days) {
    rows.push(msg(utc(2026, month, day, 12), A));
    if ((month === 1 && day === 2) || (month === 3 && day === 3)) rows.push(msg(utc(2026, month, day, 12), A));
  }
  let st = run(rows);
  assert.equal(st.totals.days_active, 10);
  assert.equal(st.totals.longest_streak, 5);
  assert.deepEqual(st.busiest_day, { date: '2026-01-02', messages: 2 });
  assert.deepEqual(st.by_month, [5, 2, 4, 0, 0, 1, 0, 0, 0, 0, 0, 0]);
  rows = [msg(utc(2024, 2, 28, 12), A), msg(utc(2024, 2, 29, 12), A), msg(utc(2024, 3, 1, 12), A),
    msg(utc(2024, 12, 31, 12), A), msg(utc(2025, 1, 1, 12), A)];
  assert.equal(run(rows, { year: 2024 }).totals.longest_streak, 3);
  assert.deepEqual(run(rows, { year: 2024 }).by_weekday, [0, 1, 1, 1, 1, 0, 0]);
  rows = [[0, A], [4, A], [4, B], [5, B], [23, B], [3, 'me']].map(([h, who]) => msg(utc(2026, 5, 5, h), who));
  rows.push(msg(utc(2026, 5, 5, 4, 59, 59), B));
  st = run(rows);
  assert.deepEqual(st.late_night, { messages: 5, share: 0.7143, top: { name: B, messages: 2 } });
});

test('empty chat, output shape and key order', () => {
  let st = run([]);
  assert.deepEqual(st.totals, { messages: 0, words: 0, attachments: 0, reactions: 0, days_active: 0, longest_streak: 0 });
  assert.equal(st.busiest_day, null);
  assert.deepEqual(st.late_night, { messages: 0, share: 0, top: null });
  assert.deepEqual([st.senders, st.most_reacted, st.awards], [[], [], []]);
  assert.equal(st.personality.id, 'quiet_ones');
  assert.deepEqual(st.chat, { name: 'Unnamed group', members: 1 });
  st = run([msg(utc(2026, 5, 5, 10), A)], { source: 'sms.db' });
  assert.deepEqual(Object.keys(st), ['v', 'chat', 'period', 'totals', 'by_hour', 'by_weekday', 'by_month',
    'busiest_day', 'personality', 'late_night', 'senders', 'most_reacted', 'reactions', 'awards', 'meta']);
  assert.deepEqual(st.meta, { generator: 'wrapped/1', source: 'sms.db', generated: '2026-11-11' });
  assert.deepEqual(Object.keys(st.reactions.by_kind), ['love', 'like', 'dislike', 'laugh', 'emphasize', 'question', 'emoji']);
  assert.deepEqual(Object.keys(st.senders[0]), ['name', 'messages', 'share', 'words', 'attachments',
    'late_night', 'reactions_given', 'reactions_received']);
  const rows = [msg(utc(2026, 5, 5, 10), A, 'x', { guid: 'G' })];
  const frozen = JSON.stringify(rows);
  assert.deepEqual(run(new Set(rows)), run(rows));
  assert.equal(JSON.stringify(rows), frozen);
});

test('half a million messages in a few seconds', () => {
  const rows = [];
  const base = utc(2025, 1, 1);
  const handles = [A, B, C, '+15550100004', '+15550100005', null];
  const body = hexToBytes(fixture().info.typedstream_samples.find((s) => s.name === 'emoji').hex);
  for (let i = 0; i < 500000; i++) {
    const t = base + Math.floor(i * 115.3);
    const who = handles[i % 6];
    const row = { rowid: i + 1, guid: 'G' + i, date: ns(t, i % 1000), is_from_me: who ? 0 : 1, handle: who };
    if (i % 9 === 0 && i > 10) {
      row.associated_message_type = 2000 + (i % 6);
      row.associated_message_guid = 'p:0/G' + (i - 7);
      row.text = 'Loved a thing';
    } else if (i % 3 === 0) {
      row.text = null;
      row.attributedBody = body;
    } else {
      row.text = 'this is message number ' + i + ' of the benchmark';
    }
    rows.push(row);
  }
  const started = Date.now();
  const st = Engine.computeStats(rows, { tz: LA, all_time: true, now: NOW });
  const elapsed = Date.now() - started;
  assert.equal(st.totals.messages, 500000 - 55554);     // every 9th row is a tapback
  assert.ok(st.totals.reactions > 50000);
  assert.ok(elapsed < 6000, 'computeStats took ' + elapsed + ' ms');
  console.log('    500,000 rows -> stats in ' + elapsed + ' ms');
});
