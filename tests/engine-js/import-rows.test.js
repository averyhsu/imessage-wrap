'use strict';
// web/make/import-rows.js: pasted or uploaded exports -> engine rows. Invented data.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { ROOT, Engine, LA, APPLE_EPOCH, utc } = require('./support.js');

const Import = require(path.join(ROOT, 'web', 'make', 'import-rows.js'));
const { parseDate, parseDelimited, pickColumns } = Import._internals;
const NOW = utc(2026, 11, 11, 20);

function unixOf(row) {
  const date = String(row.date);
  return date.length > 11 ? Number(date.slice(0, -9)) + APPLE_EPOCH : Number(date) + APPLE_EPOCH;
}
const stats = (rows, options) => Engine.computeStats(rows, Object.assign({ tz: 'UTC', now: NOW, all_time: true }, options || {}));
const date = (value, options) => {
  const result = parseDate(value, Object.assign({ zone: null, dayFirst: false, me: ['me'], appleEpoch: false }, options || {}));
  return result ? result.sec : null;
};

// ---- columnar -------------------------------------------------------------------

test('columnar: dates and senders, empty sender is me', () => {
  const text = '#dates\n2026-03-14T21:41:07-07:00\n2026-03-14T21:41:30-07:00\n2026-03-15T08:00:00Z\n' +
    '2026-03-15T09:30:00+05:30\n#senders\nMaya\n\nDev\nMaya\n';
  const result = Import.parseExport(text);
  assert.equal(result.format, 'columnar');
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(result.rows.map(unixOf), [utc(2026, 3, 15, 4, 41, 7), utc(2026, 3, 15, 4, 41, 30),
    utc(2026, 3, 15, 8), utc(2026, 3, 15, 4)]);
  assert.deepEqual(result.rows.map((r) => [r.is_from_me, r.handle]), [[0, 'Maya'], [1, null], [0, 'Dev'], [0, 'Maya']]);
  assert.ok(result.rows.every((r) => r.text === '' && r.keep_empty === 1));
  assert.deepEqual(result.summary, {
    messages: 4, senders: 3, from_me: 1, first_unix: utc(2026, 3, 15, 4), last_unix: utc(2026, 3, 15, 8),
    first_date: '2026-03-15', last_date: '2026-03-15'
  });
  const st = stats(result.rows, { tz: LA, me: 'Amara' });
  assert.equal(st.totals.messages, 4);                 // rows without text still count
  assert.equal(st.totals.words, 0);
  assert.equal(st.totals.reactions, 0);
  assert.deepEqual(st.most_reacted, []);
  assert.deepEqual(st.senders.map((s) => [s.name, s.messages]), [['Maya', 2], ['Amara', 1], ['Dev', 1]]);
  assert.equal(st.by_hour[21], 3);                     // 21:41 and 21:00 on Mar 14, Pacific time
  assert.equal(st.busiest_day.date, '2026-03-14');
});

test('columnar: line endings, blank lines, trailing empty senders, case', () => {
  const crlf = '\uFEFF  #DATES\r\n2026-01-01T10:00:00Z\r\n\r\n2026-01-02T10:00:00Z\r\n#Senders\r\nAna\r\n';
  let result = Import.parseExport(crlf);               // second sender line is empty: me
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(result.rows.map((r) => r.handle), ['Ana', null]);
  // without the final line break the last (empty) sender line still counts
  result = Import.parseExport('#dates\n2026-01-01T10:00:00Z\n2026-01-02T10:00:00Z\n#senders\nAna\n');
  assert.deepEqual(result.rows.map((r) => r.is_from_me), [0, 1]);
  result = Import.parseExport('#dates\n2026-01-01T10:00:00Z\n2026-01-02T10:00:00Z\n#senders\n\n\n');
  assert.deepEqual(result.rows.map((r) => r.is_from_me), [1, 1]);
  assert.deepEqual(result.warnings, []);
  result = Import.parseExport('#dates\n2026-01-01T10:00:00Z\n#senders\n  Me \n');
  assert.deepEqual(result.rows.map((r) => r.is_from_me), [1]);
});

test('columnar: mismatched counts are reported and truncated', () => {
  let result = Import.parseExport('#dates\n2026-01-01T10:00:00Z\n2026-01-02T10:00:00Z\n2026-01-03T10:00:00Z\n#senders\nAna\nBo');
  assert.equal(result.rows.length, 2);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /#dates has 3 lines but #senders has 2; only the first 2 of each were used/);
  result = Import.parseExport('#dates\n2026-01-01T10:00:00Z\n#senders\nAna\nBo\nCy\n\n');
  assert.deepEqual(result.rows.map((r) => r.handle), ['Ana']);
  assert.match(result.warnings[0], /#dates has 1 lines but #senders has 4/);
});

test('columnar: bad dates keep the two lists aligned; #texts is refused; no #senders', () => {
  let result = Import.parseExport('#dates\n2026-01-01T10:00:00Z\nnot a date\n2026-01-03T10:00:00Z\n#senders\nAna\nBo\nCy\n');
  assert.deepEqual(result.rows.map((r) => r.handle), ['Ana', 'Cy']);
  assert.deepEqual(result.warnings, ['line 3: could not read the date "not a date"; skipped.']);
  result = Import.parseExport('#dates\n2026-01-01T10:00:00Z\n#senders\nAna\n#texts\nhello\nworld\n');
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].text, '');
  assert.match(result.warnings[0], /#texts section is not supported/);
  result = Import.parseExport('#dates\n2026-01-01T10:00:00Z\n2026-01-02T10:00:00Z\n#extra\nx\n');
  assert.deepEqual(result.rows.map((r) => [r.is_from_me, r.handle]), [[0, 'Unknown'], [0, 'Unknown']]);
  assert.equal(result.warnings.length, 2);
  assert.match(result.warnings.join('\n'), /Unknown section #extra/);
  assert.match(result.warnings.join('\n'), /no #senders section/);
});

// ---- JSON -----------------------------------------------------------------------

test('JSON array and JSON Lines', () => {
  const items = [
    { date: '2026-03-14T21:41:07-07:00', sender: 'Maya', text: 'first message here' },
    { Date: 1773549690, From: '', Message: 'mine, by empty sender' },
    { timestamp: 1773549700123, author: 'Dev', body: 'milliseconds', is_from_me: false },
    { time: '2026-03-15 08:00:00', name: 'ignored', content: 'outgoing wins', direction: 'outgoing' },
    { date: '2026-03-16T00:00:00Z', sender: 'Maya' }
  ];
  for (const [format, text] of [['json', JSON.stringify(items, null, 2)],
    ['jsonl', items.map((i) => JSON.stringify(i)).join('\n') + '\n'],
    ['jsonl', '\n' + items.map((i) => JSON.stringify(i)).join('\r\n\r\n')]]) {
    const result = Import.parseExport(text, { tz: 'UTC' });
    assert.equal(result.format, format);
    assert.deepEqual(result.rows.map((r) => [r.is_from_me, r.handle, r.text]), [
      [0, 'Maya', 'first message here'], [1, null, 'mine, by empty sender'], [0, 'Dev', 'milliseconds'],
      [1, null, 'outgoing wins'], [0, 'Maya', '']], format);
    assert.deepEqual(result.rows.map(unixOf), [utc(2026, 3, 15, 4, 41, 7), 1773549690, 1773549700,
      utc(2026, 3, 15, 8), utc(2026, 3, 16)], format);
    assert.equal(result.rows[2].date, String(1773549700 - APPLE_EPOCH) + '123000000');   // fraction kept
    assert.deepEqual(result.warnings, [], format);
    const st = stats(result.rows);
    assert.equal(st.totals.messages, 5);
    assert.equal(st.totals.words, 3 + 4 + 1 + 2);
  }
});

test('JSON: wrapper objects, bad lines, bad items, missing keys', () => {
  let result = Import.parseExport(JSON.stringify({ exported: '2026', messages: [{ date: '2026-01-01T00:00:00Z', sender: 'A', text: 'x' }] }));
  assert.equal(result.rows.length, 1);
  result = Import.parseExport('{"date": "2026-01-01T00:00:00Z", "sender": "A", "text": "one object"}');
  assert.equal(result.rows.length, 1);
  result = Import.parseExport('{"date":"2026-01-01T00:00:00Z","sender":"A","text":"ok"}\n{"date": oops}\n' +
    '{"date":"2026-01-02T00:00:00Z","sender":"B","text":"ok"}\n{"date":"never","sender":"C"}\n');
  assert.deepEqual(result.rows.map((r) => r.handle), ['A', 'B']);
  assert.deepEqual(result.warnings, ['line 2: not valid JSON ("{\\"date\\": oops}"); skipped.',
    'line 4: could not read the date "never"; skipped.']);
  result = Import.parseExport('[{"date":"2026-01-01T00:00:00Z","sender":"A"}, 5, null, ["x"]]');
  assert.equal(result.rows.length, 1);
  assert.equal(result.warnings.filter((w) => /not an object/.test(w)).length, 3);
  result = Import.parseExport('[{"sender":"A","text":"no date"}]');
  assert.equal(result.rows.length, 0);
  assert.match(result.warnings[0], /No date found/);
  result = Import.parseExport('[{"date":"2026-01-01T00:00:00Z","text":"who"}]');
  assert.deepEqual(result.rows.map((r) => [r.is_from_me, r.handle]), [[0, 'Unknown']]);
  assert.match(result.warnings[0], /No sender found: every message is attributed to "Unknown"/);
  result = Import.parseExport('[{"date": "2026-01-01T00:00:00Z", "sender": "A"');
  assert.equal(result.rows.length, 0);
  assert.match(result.warnings[0], /not valid JSON/);
});

// ---- CSV / TSV --------------------------------------------------------------------

test('CSV with quoted commas, line breaks and doubled quotes', () => {
  const text = 'Date,Sender,Text\r\n' +
    '"11/10/2026, 9:41 PM",Maya,"hello, ""world""\nsecond line, still the same field"\r\n' +
    '11/13/2026 21:41,,plain\r\n' +
    '"11/14/2026, 12:05 AM","O\'Brien, Pat","a ""quoted"" word"\r\n' +
    '11/15/2026 08:00,Dev,\r\n';
  const result = Import.parseExport(text, { tz: LA });
  assert.equal(result.format, 'csv');
  assert.deepEqual(result.columns, { date: 'Date', time: null, sender: 'Sender', text: 'Text', direction: null });
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(result.rows.map((r) => [r.is_from_me, r.handle, r.text]), [
    [0, 'Maya', 'hello, "world"\nsecond line, still the same field'], [1, null, 'plain'],
    [0, 'O\'Brien, Pat', 'a "quoted" word'], [0, 'Dev', '']]);
  assert.deepEqual(result.rows.map(unixOf), [utc(2026, 11, 11, 5, 41), utc(2026, 11, 14, 5, 41),
    utc(2026, 11, 14, 8, 5), utc(2026, 11, 15, 16)]);
  const st = stats(result.rows, { tz: LA, now: utc(2026, 11, 20) });
  assert.equal(st.totals.messages, 4);
  assert.equal(st.totals.words, 8 + 1 + 3 + 0);
  assert.equal(st.by_hour[21], 2);
  assert.equal(st.by_hour[0], 1);
});

test('TSV, semicolons, and header detection by name', () => {
  let result = Import.parseExport('timestamp\tfrom\tbody\n2026-11-10 21:41:07\tMaya\ttabs, with a comma\n', { tz: 'UTC' });
  assert.equal(result.format, 'tsv');
  assert.deepEqual(result.rows.map((r) => [r.handle, r.text]), [['Maya', 'tabs, with a comma']]);
  assert.equal(unixOf(result.rows[0]), utc(2026, 11, 10, 21, 41, 7));
  result = Import.parseExport('Sent;Author;Content\n10.11.2026 21:41;Maya;"semi;colon"\n', { tz: 'UTC' });
  assert.equal(result.format, 'csv');
  assert.deepEqual(result.rows.map((r) => [r.handle, r.text]), [['Maya', 'semi;colon']]);
  assert.equal(unixOf(result.rows[0]), utc(2026, 11, 10, 21, 41));
  // an export-app layout: several date columns, a type column, sender id and name
  const app = 'Chat Session,Message Date,Delivered Date,Read Date,Service,Type,Sender ID,Sender Name,Status,Text\n' +
    'Dinner,2026-11-10 21:41:07,2026-11-10 21:41:09,,iMessage,Incoming,+15550100001,Maya,Read,"see you, soon"\n' +
    'Dinner,2026-11-10 21:42:00,,,iMessage,Outgoing,,,Sent,on my way\n';
  result = Import.parseExport(app, { tz: 'UTC' });
  assert.deepEqual(result.columns, { date: 'Message Date', time: null, sender: 'Sender Name', text: 'Text', direction: 'Type' });
  assert.deepEqual(result.rows.map((r) => [r.is_from_me, r.handle, r.text]), [[0, 'Maya', 'see you, soon'], [1, null, 'on my way']]);
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(pickColumns(['When', 'WHO', 'Msg', 'Is From Me']), { date: 'When', time: null, sender: 'WHO', text: 'Msg', direction: 'Is From Me' });
  assert.deepEqual(pickColumns(['time', 'name']), { date: 'time', time: null, sender: 'name', text: null, direction: null });
});

test('CSV: direction values, separate date and time columns, a type column that is not a direction', () => {
  let result = Import.parseExport('date,time,sender,is_from_me,message\n' +
    '2026-11-10,21:41:07,Maya,0,a\n2026-11-10,9:42 PM,Amara,1,b\n11/11/2026,00:05,Dev,false,c\n2026-11-12,,Kai,TRUE,d\n' +
    '2026-11-13,08:00,Zed,sent,e\n2026-11-13,08:01,Zed,received,f\n', { tz: 'UTC' });
  assert.deepEqual(result.columns, { date: 'date', time: 'time', sender: 'sender', text: 'message', direction: 'is_from_me' });
  assert.deepEqual(result.rows.map((r) => [r.is_from_me, r.handle]), [[0, 'Maya'], [1, null], [0, 'Dev'], [1, null], [1, null], [0, 'Zed']]);
  assert.deepEqual(result.rows.map(unixOf), [utc(2026, 11, 10, 21, 41, 7), utc(2026, 11, 10, 21, 42),
    utc(2026, 11, 11, 0, 5), utc(2026, 11, 12), utc(2026, 11, 13, 8), utc(2026, 11, 13, 8, 1)]);
  result = Import.parseExport('date,type,sender,text\n2026-11-10T10:00:00Z,iMessage,Maya,a\n2026-11-10T10:01:00Z,SMS,,b\n');
  assert.equal(result.columns.direction, null);
  assert.deepEqual(result.rows.map((r) => [r.is_from_me, r.handle]), [[0, 'Maya'], [1, null]]);
  result = Import.parseExport('date,direction,text\n2026-11-10T10:00:00Z,incoming,a\n2026-11-10T10:01:00Z,outgoing,b\n');
  assert.deepEqual(result.rows.map((r) => [r.is_from_me, r.handle]), [[0, null], [1, null]]);
  assert.match(result.warnings[0], /not yours are attributed to "Unknown"/);
  assert.equal(stats(result.rows).senders.map((s) => s.name).sort().join(), 'Me,Unknown');
});

test('CSV: problems are reported, never thrown', () => {
  let result = Import.parseExport('when it happened,who,what\n2026-11-10,Maya,hi\n');
  assert.equal(result.rows.length, 0);
  assert.equal(result.format, 'unknown');
  assert.match(result.warnings[0], /No date column found.*"when it happened"/);
  result = Import.parseExport('date,sender\n2026-11-10T10:00:00Z,Maya\n');
  assert.equal(result.rows.length, 1);
  assert.deepEqual(result.warnings, ['No message text found: word counts will be zero.']);
  result = Import.parseExport('date,sender,text\n2026-11-10T10:00:00Z,Maya,one, two, three\n\n,,\nlater,Bo,x\n2026-11-10T10:02:00Z,Bo\n');
  assert.deepEqual(result.rows.map((r) => [r.handle, r.text]), [['Maya', 'one'], ['Bo', '']]);
  assert.match(result.warnings.join('\n'), /line 2: 5 fields but the header has 3/);
  assert.match(result.warnings.join('\n'), /line 4: could not read the date ""; skipped/);
  assert.match(result.warnings.join('\n'), /line 5: could not read the date "later"; skipped/);
  result = Import.parseExport('date,sender,text\n2026-11-10T10:00:00Z,Maya,"never closed\nmore\n');
  assert.match(result.warnings.join('\n'), /quoted field is never closed/);
  const many = ['date,sender,text'];
  for (let i = 0; i < 30; i++) many.push('bad' + i + ',A,x');
  result = Import.parseExport(many.join('\n'));
  assert.equal(result.warnings.length, 8 + 2);          // eight spelled out, "nothing read", "and N more"
  assert.match(result.warnings.join('\n'), /\.\.\. and 22 more lines with unreadable dates\./);
  assert.match(result.warnings.join('\n'), /No messages could be read/);
  for (const nothing of ['', '   \n ', null, undefined, 42]) {
    result = Import.parseExport(nothing);
    assert.deepEqual(result.rows, []);
    assert.deepEqual(result.warnings, ['There is nothing to read.']);
    assert.equal(result.summary.messages, 0);
  }
  result = Import.parseExport('just some words pasted by mistake');
  assert.equal(result.rows.length, 0);
  assert.equal(result.warnings.length, 1);
});

test('parseDelimited: the CSV grammar', () => {
  const records = (text, delimiter) => parseDelimited(text, delimiter || ',').records;
  assert.deepEqual(records('a,b,c\n1,2,3'), [['a', 'b', 'c'], ['1', '2', '3']]);
  assert.deepEqual(records('a,b\r\n1,2\r\n'), [['a', 'b'], ['1', '2']]);
  assert.deepEqual(records('a,b\r1,2\r'), [['a', 'b'], ['1', '2']]);
  assert.deepEqual(records('"a,1","b""2""","c\nd",\n'), [['a,1', 'b"2"', 'c\nd', '']]);
  assert.deepEqual(records('a,,c\n,,\n\nx'), [['a', '', 'c'], ['', '', ''], ['x']]);
  assert.deepEqual(records('say "hi",5'), [['say "hi"', '5']]);             // quotes inside an unquoted field
  assert.deepEqual(records('"multi\r\nline",z'), [['multi\r\nline', 'z']]);
  assert.deepEqual(records('a\tb,c\td', '\t'), [['a', 'b,c', 'd']]);
  assert.deepEqual(parseDelimited('h\n"a\nb"\nc\n', ',').lines, [1, 2, 4]);
  assert.equal(parseDelimited('"open', ',').unterminated, true);
});

// ---- dates ------------------------------------------------------------------------

test('dates: ISO 8601', () => {
  const t = utc(2026, 11, 10, 21, 41, 7);
  for (const text of ['2026-11-10T21:41:07Z', '2026-11-10T21:41:07+00:00', '2026-11-10T22:41:07+01:00',
    '2026-11-10T13:41:07-08:00', '2026-11-10T13:41:07-0800', '2026-11-10T13:41:07-08', '2026-11-10 21:41:07Z',
    '2026-11-10t21:41:07z', '2026-11-11T03:11:07+05:30', '2026-11-10T21:41:07.123Z', '2026-11-10T21:41:07,5Z',
    '  2026-11-10T21:41:07Z  ', '2026-11-10 21:41:07 UTC', '2026-11-10 21:41:07 GMT+0', '2026/11/10 21:41:07Z']) {
    assert.equal(date(text), t, text);
  }
  assert.equal(date('2026-11-10T21:41Z'), utc(2026, 11, 10, 21, 41));
  assert.equal(date('2026-11-10', { zone: null }), new Date(2026, 10, 10).getTime() / 1000);
  assert.deepEqual(parseDate('2026-11-10T21:41:07.123456789Z', { zone: null, me: [] }), { sec: t, ns: 123456789 });
  assert.deepEqual(parseDate('2026-11-10T21:41:07.5Z', { zone: null, me: [] }), { sec: t, ns: 500000000 });
});

test('dates: zoneless times are local to options.tz, including across DST', () => {
  const parse = (text, tz) => Import.parseExport('date,sender\n' + text + ',A\n', { tz }).rows.map(unixOf)[0];
  assert.equal(parse('2026-11-10 21:41:07', LA), utc(2026, 11, 11, 5, 41, 7));         // PST
  assert.equal(parse('2026-07-04 21:41:07', LA), utc(2026, 7, 5, 4, 41, 7));           // PDT
  assert.equal(parse('2026-03-08 01:59:00', LA), utc(2026, 3, 8, 9, 59));              // before the jump
  assert.equal(parse('2026-03-08 03:00:00', LA), utc(2026, 3, 8, 10, 0));              // after it
  assert.equal(parse('2026-11-10 21:41:07', 'Asia/Kolkata'), utc(2026, 11, 10, 16, 11, 7));
  assert.equal(parse('2026-11-10 21:41:07', 'UTC'), utc(2026, 11, 10, 21, 41, 7));
  assert.equal(parse('2026-11-10T21:41:07+02:00', LA), utc(2026, 11, 10, 19, 41, 7));  // an explicit zone wins
  assert.equal(parse('2026-11-10 21:41:07', undefined), new Date(2026, 10, 10, 21, 41, 7).getTime() / 1000);
  assert.throws(() => Import.parseExport('date\n2026-01-01\n', { tz: 'Mars/Olympus_Mons' }), /unknown time zone/);
});

test('dates: Unix seconds, milliseconds and friends', () => {
  const t = 1794346867;                                   // 2026-11-10T21:41:07Z
  assert.equal(date(t), t);
  assert.equal(date(String(t)), t);
  assert.equal(date(t * 1000), t);
  assert.equal(date(String(t) + '123'), t);
  assert.equal(date(String(t) + '123456'), t);            // microseconds
  assert.equal(date(String(t) + '123456789'), t);         // nanoseconds
  assert.equal(date(t + 0.75), t);
  assert.deepEqual(parseDate(String(t) + '.250', { me: [] }), { sec: t, ns: 250000000 });
  assert.deepEqual(parseDate(String(t) + '123', { me: [] }), { sec: t, ns: 123000000 });
  const ctx = { zone: null, me: [], appleEpoch: false };
  assert.deepEqual(parseDate(t - APPLE_EPOCH, ctx), { sec: t, ns: 0 });       // seconds since 2001
  assert.equal(ctx.appleEpoch, true);
  assert.deepEqual(parseDate(String(t - APPLE_EPOCH) + '000000042', { me: [] }), { sec: t, ns: 42 });
  const result = Import.parseExport('date,sender\n' + (t - APPLE_EPOCH) + ',A\n');
  assert.equal(unixOf(result.rows[0]), t);
  assert.match(result.warnings.join('\n'), /read as seconds since 2001-01-01/);
  for (const bad of [-5, '-1794346867', NaN, Infinity, '99999999999999999999999']) assert.equal(date(bad), null, String(bad));
});

test('dates: written forms', () => {
  const t = utc(2026, 11, 10, 21, 41);
  const zone = { zone: { name: 'UTC', format: new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' }) } };
  const forms = ['11/10/2026, 9:41 PM', '11/10/2026 9:41 PM', '11/10/2026, 21:41', '11/10/26, 9:41 PM', '11/10/2026 at 9:41 pm',
    '11/10/2026, 9:41\u202FPM', '11/10/2026,\u00A09:41 p.m.', '\u200E11/\u200E10/\u200E2026 \u200E9:41 PM',
    'Nov 10, 2026 at 9:41 PM', 'Nov 10, 2026, 9:41 PM', 'November 10, 2026 at 9:41:00 PM', 'Tue, Nov 10, 2026 at 9:41 PM',
    'Tuesday, November 10, 2026 at 21:41', '10 Nov 2026 at 21:41', '10 November 2026 21:41', 'Tue 10 Nov 2026, 21:41',
    '10th November 2026 at 9:41pm', 'Nov. 10, 2026 9:41 PM', 'Sept 10, 2026 at 9:41 PM'.replace('Sept', 'Nov'),
    '10.11.2026 21:41', '10.11.2026, 21:41:00', '10-11-2026 21:41', '2026-11-10 21:41', '2026.11.10 21:41', '2026/11/10, 9:41 PM'];
  for (const text of forms) assert.equal(date(text, zone), t, text);
  assert.equal(date('11/10/2026, 12:05 AM', zone), utc(2026, 11, 10, 0, 5));
  assert.equal(date('11/10/2026, 12:05 PM', zone), utc(2026, 11, 10, 12, 5));
  assert.equal(date('Nov 10, 2026', zone), utc(2026, 11, 10));
  assert.equal(date('1/2/2026 3:04:05 AM', zone), utc(2026, 1, 2, 3, 4, 5));
  assert.equal(date('1/2/2026 3:04:05 AM', Object.assign({ dayFirst: true }, zone)), utc(2026, 2, 1, 3, 4, 5));
  assert.equal(date('25/12/2026 10:00', zone), utc(2026, 12, 25, 10));          // can only be day-first
  assert.equal(date('12/25/2026 10:00', Object.assign({ dayFirst: true }, zone)), utc(2026, 12, 25, 10));
  assert.equal(date('Sep 5, 2026 at 7:00 AM', zone), utc(2026, 9, 5, 7));
  assert.equal(date('Sept 5, 2026 at 7:00 AM', zone), utc(2026, 9, 5, 7));
  assert.equal(date('5 May 2026 07:00', zone), utc(2026, 5, 5, 7));
  for (const bad of ['soon', '', '   ', null, undefined, '2026-13-01', '2026-02-30', '31/31/2026', '11/10/2026 25:00',
    '11/10/2026 13:00 PM', '11/10/2026 0:30 AM', '11/10/2026 9:61 PM', 'Movember 10, 2026', '10 2026', '1999-12-31T23:59:59Z',
    '2150-01-01', 'yesterday at 5', '12:30', {}, []]) {
    assert.equal(date(bad, zone), null, JSON.stringify(bad));
  }
});

test('dates: month-first or day-first is settled from the whole file', () => {
  const rows = (text, options) => Import.parseExport(text, Object.assign({ tz: 'UTC' }, options || {}));
  let result = rows('date,sender\n3/4/2026 10:00,A\n5/6/2026 10:00,A\n');
  assert.deepEqual(result.rows.map(unixOf), [utc(2026, 3, 4, 10), utc(2026, 5, 6, 10)]);
  assert.match(result.warnings.join('\n'), /read as month\/day\/year/);
  result = rows('date,sender,text\n3/4/2026 10:00,A,x\n25/6/2026 10:00,A,x\n');   // one line proves day-first
  assert.deepEqual(result.rows.map(unixOf), [utc(2026, 4, 3, 10), utc(2026, 6, 25, 10)]);
  assert.deepEqual(result.warnings, []);
  result = rows('date,sender,text\n3/4/2026 10:00,A,x\n6/25/2026 10:00,A,x\n');
  assert.deepEqual(result.rows.map(unixOf), [utc(2026, 3, 4, 10), utc(2026, 6, 25, 10)]);
  assert.deepEqual(result.warnings, []);
  result = rows('date,sender,text\n3/4/2026 10:00,A,x\n', { dayFirst: true });
  assert.deepEqual(result.rows.map(unixOf), [utc(2026, 4, 3, 10)]);
  assert.deepEqual(result.warnings, []);
  result = rows('#dates\n3/4/2026 10:00\n13/4/2026 10:00\n#senders\nA\nB\n');
  assert.deepEqual(result.rows.map(unixOf), [utc(2026, 4, 3, 10), utc(2026, 4, 13, 10)]);
});

// ---- end to end ---------------------------------------------------------------------

test('own names, engine options and a full recap from an import', () => {
  const lines = ['date,sender,text'];
  const people = ['Maya', 'Dev', '', 'Amara H.', 'Priya'];
  for (let i = 0; i < 400; i++) {
    const day = String(1 + (i % 28)).padStart(2, '0');
    const hour = String(18 + (i % 6)).padStart(2, '0');
    lines.push('2026-0' + (1 + (i % 9)) + '-' + day + ' ' + hour + ':' + String(i % 60).padStart(2, '0') + ':00,' +
      people[i % 5] + ',"message number ' + i + ', with a comma"');
  }
  const result = Import.parseExport(lines.join('\n'), { tz: LA, me: ['Amara H.'] });
  assert.deepEqual(result.warnings, []);
  assert.equal(result.summary.messages, 400);
  assert.equal(result.summary.from_me, 160);
  assert.equal(result.summary.senders, 4);
  const st = Engine.computeStats(result.rows, { tz: LA, year: 2026, now: NOW, me: 'Amara', chat_name: 'Imported chat' });
  assert.equal(st.totals.messages, 400);
  assert.equal(st.totals.words, 400 * 6);
  assert.deepEqual(st.senders.map((s) => [s.name, s.messages]), [['Amara', 160], ['Dev', 80], ['Maya', 80], ['Priya', 80]]);
  assert.equal(sumOf(st.by_hour.slice(18, 24)), 400);
  assert.equal(st.totals.reactions, 0);
  assert.deepEqual(st.most_reacted, []);
  assert.equal(st.reactions.top_giver, null);
  assert.ok(st.awards.length >= 2);
  const link = Engine.fitLink(st);
  assert.deepEqual(Engine.statsFromUrl(link.url), st);
});

function sumOf(list) { return list.reduce((a, b) => a + b, 0); }

test('a large paste is parsed quickly', () => {
  const lines = ['date,sender,text'];
  for (let i = 0; i < 200000; i++) {
    lines.push('2026-03-14T' + String(i % 24).padStart(2, '0') + ':41:07-07:00,Person ' + (i % 9) + ',"row ' + i + ', quoted"');
  }
  const started = Date.now();
  const result = Import.parseExport(lines.join('\n'));
  const elapsed = Date.now() - started;
  assert.equal(result.rows.length, 200000);
  assert.ok(elapsed < 5000, 'parsing took ' + elapsed + ' ms');
  console.log('    200,000 CSV rows parsed in ' + elapsed + ' ms');
});

test('import-rows.js is a classic script with no network access', () => {
  const source = fs.readFileSync(path.join(ROOT, 'web', 'make', 'import-rows.js'), 'utf8');
  assert.ok(!/^\s*(import|export)\s/m.test(source));
  assert.ok(!/\bfetch\s*\(|XMLHttpRequest|WebSocket|sendBeacon|https?:\/\//.test(source));
  assert.ok(/^[\x00-\x7e]*$/.test(source));
  const vm = require('vm');
  const sandbox = { Intl };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  assert.equal(sandbox.WrappedImport.parseExport('#dates\n2026-01-01T00:00:00Z\n#senders\nA\n').rows.length, 1);
});
