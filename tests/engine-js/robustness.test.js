'use strict';
// Damaged, hostile and merely odd input.
//
// db.js rejects or throws Errors that always carry a `code` and a sentence for
// the user; the engine throws only coded RangeErrors for bad options; and cells
// of the wrong type read the same way as in the Python engine (the conformance
// suite compares the two byte for byte; the individual decisions are pinned
// down here).

const test = require('node:test');
const assert = require('node:assert/strict');
const { Engine, DB, APPLE_EPOCH, fixture, read, utc, msg, tap, textLeaks, leaks } = require('./support.js');

const NOW = utc(2026, 11, 11, 20);
const ELLIPSIS = '\u2026';

function run(rows, options) {
  return Engine.computeStats(rows, Object.assign({ tz: 'UTC', now: NOW, all_time: true }, options || {}));
}

/** The error a piece of work ends in, or null. */
async function failure(work) {
  try { await work(); } catch (error) { return error; }
  return null;
}

function assertCoded(error, code, pattern) {
  assert.ok(error instanceof Error, 'expected an error with code ' + code);
  assert.equal(error.code, code, error.message);
  assert.ok(error.message.length >= 15 && /[.)]$/.test(error.message), error.message);
  assert.ok(!/[\r\n]/.test(error.message), error.message);
  if (pattern) assert.match(error.message, pattern);
}

/** Open, list the chats and compute every recap: what the page does with a file. */
async function everything(source) {
  const handle = await DB.openDatabase(source);
  try {
    DB.kind(handle);
    DB.diagnostics(handle);
    const listing = DB.listGroupChats(handle, {});
    for (const chat of listing.chats) {
      const stats = DB.statsForChat(handle, chat, { all_time: true, tz: 'UTC', now: NOW });
      assert.deepEqual(textLeaks(JSON.stringify(stats.senders.map((s) => s.name))).filter((f) => f.includes('control')), []);
      try { Engine.fitLink(Engine.shortNames(stats)); } catch (error) {
        if (error.code !== 'link_too_long') throw error;       // garbage can make an enormous name
      }
    }
    return { chats: listing.chats, warnings: handle.warnings.map((w) => w.code), info: handle.info };
  } finally {
    handle.close();
  }
}

class Rng {                                   // the fixture's generator, for repeatable damage
  constructor(seed) { this.state = BigInt(seed); }
  below(n) {
    this.state = (this.state * 6364136223846793005n + 1442695040888963407n) & 0xFFFFFFFFFFFFFFFFn;
    return Number(this.state >> 33n) % n;
  }
}

// ---- damaged databases ----------------------------------------------------------

test('pages overwritten with noise: "corrupt", with a sentence', async () => {
  const bytes = read('backup_sms');
  bytes.fill(0xA5, 4096);                     // everything after the first page
  assertCoded(await failure(() => everything({ db: bytes.slice() })), 'corrupt', /could not read this database/);
  // whichever call meets the damage first says so the same way
  const error = await failure(async () => {
    const handle = await DB.openDatabase({ db: bytes.slice() });
    try { handle.query('SELECT count(*) AS n, max(date) AS last FROM message'); } finally { handle.close(); }
  });
  assertCoded(error, 'corrupt');
});

test('files cut short: "corrupt"', async () => {
  const whole = read('backup_sms');
  for (const keep of [20, 100, 1000, 4096, 4096 * 3 + 17, whole.length >> 2, (whole.length >> 1) + 100]) {
    assertCoded(await failure(() => everything({ db: whole.slice(0, keep) })), 'corrupt');
  }
  assertCoded(await failure(() => DB.openDatabase({ db: whole.slice(0, 0) })), 'empty');
  assertCoded(await failure(() => DB.openDatabase({})), 'empty');
  assertCoded(await failure(() => DB.openDatabase(null)), 'empty');
  const noise = whole.slice(0, 8192).fill(0x5A);
  assertCoded(await failure(() => DB.openDatabase({ db: noise })), 'not_sqlite');
});

test('a -wal from another copy is left out, and the page is told', async () => {
  const original = read('foreign_wal_db');
  const db = original.slice();
  const handle = await DB.openDatabase({ db, wal: read('foreign_wal') });
  assert.deepEqual(handle.warnings.map((w) => w.code), ['wal_invalid']);
  assert.match(handle.warnings[0].message, /does not belong to this copy/);
  assert.equal(handle.info.walMerged, false);          // never "merged" for an image that failed its check
  assert.equal(handle.info.walSupplied, true);
  assert.equal(typeof handle.info.walProblem, 'string');
  const listing = DB.listGroupChats(handle, {});
  assert.equal(listing.diagnostics.wal_merged, false);
  assert.deepEqual(listing.warnings.map((w) => w.code), ['wal_invalid']);
  handle.close();
  assert.deepEqual(Buffer.from(db), Buffer.from(original));       // the file's bytes were put back
  // exactly what the file gives on its own
  const alone = await DB.openDatabase({ db: original.slice() });
  assert.deepEqual(alone.warnings.map((w) => w.code), ['wal_missing']);
  assert.deepEqual(listing.chats, DB.listGroupChats(alone, {}).chats);
  assert.ok(listing.chats.some((chat) => chat.messages > 20));
  alone.close();
  // the right log for the right file is still merged
  const mac = await DB.openDatabase({ db: read('chat_db'), wal: read('chat_db_wal') });
  assert.equal(mac.info.walMerged, true);
  assert.equal(mac.info.walProblem, undefined);
  assert.deepEqual(mac.warnings, []);
  mac.close();
});

test('no chat_handle_join table: members are unknown, the recap is the same', async () => {
  const handle = await DB.openDatabase({ db: read('nojoin_db') });
  const chats = DB.listGroupChats(handle, {}).chats;
  assert.deepEqual(chats.map((c) => [c.name, c.participants, c.members, c.messages]), [['Old Friends', [], 1, 5]]);
  const options = { year: 2016, tz: 'UTC', now: NOW };
  const legacy = await DB.openDatabase({ db: read('legacy_db') });
  assert.deepEqual(DB.statsForChat(handle, chats[0], options), DB.statsForChat(legacy, 1, options));
  handle.close();
  legacy.close();
});

test('a missing column: "schema", and what is missing', async () => {
  const handle = await DB.openDatabase({ db: read('nocolumn_db') });
  assert.equal(DB.listGroupChats(handle, {}).chats.length, 1);
  const error = await failure(() => DB.statsForChat(handle, 1, { year: 2016, tz: 'UTC', now: NOW }));
  assertCoded(error, 'schema', /part of the usual layout is missing.*is_from_me/);
  assertCoded(await failure(() => DB.loadRows(handle, [1])), 'schema');
  handle.close();
});

test('layouts that are not a Messages database: "schema"', async () => {
  const SQL = await DB.init();
  const layouts = [
    'CREATE TABLE message (ROWID INTEGER PRIMARY KEY, text)',
    'CREATE TABLE chat (x); CREATE TABLE message (x); CREATE TABLE handle (x); CREATE TABLE chat_message_join (x)',
    'CREATE TABLE chat (style, guid, chat_identifier, display_name, service_name); CREATE TABLE message (date); ' +
      'CREATE TABLE handle (id); CREATE TABLE chat_message_join (chat_id); INSERT INTO chat (style) VALUES (43)'
  ];
  for (const layout of layouts) {
    const made = new SQL.Database();
    made.run(layout);
    const bytes = made.export();
    made.close();
    const handle = await DB.openDatabase({ db: bytes });
    assertCoded(await failure(() => DB.statsForChat(handle, 1, { all_time: true })), 'schema');
    assertCoded(await failure(() => DB.listGroupChats(handle, {})), 'schema');
    assertCoded(await failure(() => DB.loadContacts(handle)), 'contacts_schema');
    handle.close();
  }
  const book = await DB.openDatabase({ db: read('evil_address_book') });
  assertCoded(await failure(() => DB.listGroupChats(book, {})), 'schema', /not a Messages database/);
  book.close();
});

test('a damaged address book: "corrupt"', async () => {
  const bytes = read('evil_address_book');
  bytes.fill(0x5A, 4096);
  const error = await failure(async () => {
    const handle = await DB.openDatabase({ db: bytes });
    try { DB.loadContacts(handle); } finally { handle.close(); }
  });
  assertCoded(error, 'corrupt');
});

test('random damage: an error always has a code', async () => {
  const outcomes = { read: 0, refused: 0 };
  const original = read('noemoji_db');
  const rng = new Rng(99);
  for (let attempt = 0; attempt < 60; attempt++) {
    let data = original.slice();
    for (let hits = 1 + rng.below(6); hits > 0; hits--) {
      const at = rng.below(data.length);
      const end = Math.min(data.length, at + 1 + rng.below(900));
      for (let i = at; i < end; i++) data[i] = rng.below(256);
    }
    if (attempt % 6 === 5) data = data.slice(0, 100 + rng.below(data.length - 100));    // and sometimes cut short
    const error = await failure(() => everything({ db: data }));
    if (error === null) { outcomes.read += 1; continue; }
    assert.equal(typeof error.code, 'string', error.stack);
    assert.ok(['corrupt', 'schema', 'not_sqlite'].includes(error.code), error.code);
    outcomes.refused += 1;
  }
  assert.ok(outcomes.read > 5 && outcomes.refused > 5, JSON.stringify(outcomes));
  // a damaged log next to a sound file: merged, or left out with a warning; never "merged" and then broken
  const log = read('chat_db_wal');
  for (let attempt = 0; attempt < 12; attempt++) {
    const wal = log.slice();
    for (let flips = 1 + rng.below(4); flips > 0; flips--) wal[rng.below(wal.length)] ^= 1 << rng.below(8);
    const result = await everything({ db: read('chat_db'), wal });
    assert.equal(result.chats.length, 4);
    if (!result.info.walMerged) assert.ok(result.warnings.includes('wal_invalid') || result.info.walFrames === 0);
  }
});

// ---- cells of the wrong type --------------------------------------------------------

test('cells of the wrong type are read the way the Python engine reads them', async () => {
  const chats = fixture().info.evil.chats;
  const handle = await DB.openDatabase({ db: read('evil_db') });
  const rows = DB.loadRows(handle, [chats.control_name.rowid]);
  assert.ok(rows.length > 40);
  const isOneOf = (value, kinds) => kinds.includes(value === null ? 'null' : typeof value);
  for (const chat of Object.values(chats)) {
    for (const row of DB.loadRows(handle, [chat.rowid])) {
      assert.ok(isOneOf(row.rowid, ['number']));
      for (const key of ['guid', 'date', 'handle', 'text', 'associated_message_guid']) assert.ok(isOneOf(row[key], ['string', 'null']), key);
      for (const key of ['is_from_me', 'cache_has_attachments', 'item_type', 'associated_message_type']) {
        assert.ok(isOneOf(row[key], ['number', 'null']), key);
      }
      assert.equal(row.attributedBody, null);
    }
  }
  const byText = new Map(rows.filter((row) => row.text).map((row) => [row.text, row]));
  // a number or a blob where text belongs is read as text
  for (const text of ['1099511627776', '2.5', 'hello from a blob', 'caf\uFFFD \uFFFD ok', '0', 'only in the attributed body']) {
    assert.ok(byText.has(text), text);
  }
  assert.ok(!byText.has('hidden behind a zero'));                     // the zero is text: no fallback
  assert.equal(byText.get('my guid is a number').guid, '12345');
  const handles = new Set(DB.loadRows(handle, [chats.integer_name.rowid]).map((row) => row.handle));
  for (const id of ['+15550100134', '15550100135', '555.5']) assert.ok(handles.has(id), id);      // BLOB, INTEGER, REAL
  // a date that is not an integer: a REAL is truncated, text is read as a number, anything else is no date
  const t = utc(2026, 5, 20, 16, 0) - APPLE_EPOCH;
  const date = (text) => byText.get(text).date;
  assert.equal(date('a date with a fraction'), String(t + 240));
  assert.equal(date('a date in floating point'), String(t + 300) + '000000000');
  assert.equal(date('a date that is text'), String(t + 360));
  assert.equal(date('a date that is a word'), '0');
  assert.equal(date('no date at all'), null);
  assert.equal(date('a negative date'), '-5');
  assert.equal(date('a date beyond the end of time'), '9223372036854775807');
  const dated = run(rows.filter((row) => row.text && row.text.includes('date')));
  assert.equal(dated.totals.messages, 3);
  assert.deepEqual(dated.busiest_day, { date: '2026-05-20', messages: 3 });
  assert.equal(dated.by_hour[16], 3);
  // flags and kinds
  assert.equal(byText.get('mine, says a text cell').is_from_me, 1);
  assert.equal(byText.get('a flag that is a word').is_from_me, 0);
  assert.equal(byText.get('a flag that is a fraction').is_from_me, 0);
  assert.equal(byText.get('a flag that is missing').is_from_me, null);
  assert.equal(byText.get('an event, typed as text').item_type, 1);
  assert.equal(byText.get('\uFFFC').cache_has_attachments, 2);
  const taps = rows.filter((row) => row.associated_message_guid === 'p:0/12345');
  assert.deepEqual(taps.map((row) => row.associated_message_type).sort(), [2000, 2001]);
  // and in the listing and the recap
  const listing = DB.listGroupChats(handle, {});
  const names = listing.chats.map((chat) => chat.display_name);
  for (const name of [ELLIPSIS + '0177', 'Group 7', 'Style As Text']) assert.ok(names.includes(name), name);
  const odd = listing.chats.find((chat) => chat.id === chats.control_name.rowid);
  assert.equal(odd.last_unix, utc(2026, 5, 20, 16, 21));
  const stats = DB.statsForChat(handle, odd, { all_time: true, tz: 'UTC', now: NOW });
  const quote = stats.most_reacted.filter((q) => q.text === 'my guid is a number');
  assert.equal(quote.length, 1);
  assert.deepEqual([quote[0].reactions, quote[0].kinds], [2, { love: 1, like: 1 }]);
  assert.ok(stats.senders.some((s) => s.name === 'Unknown'));
  assert.deepEqual(leaks(stats), []);
  handle.close();
});

test('computeStats: values of the wrong type never throw', () => {
  const t = utc(2026, 5, 5, 10);
  const base = msg(t, '+15550100001', 'hello', { guid: 'G1' });
  const values = [null, undefined, true, false, 0, 1, -1, 2 ** 40, 2 ** 70, -(2 ** 70), 1.5, Infinity, -Infinity,
    NaN, 1e300, '', 'x', '1', new Uint8Array([98, 121]), new ArrayBuffer(2), new Float64Array(2), [], [1], {},
    { a: 1 }, 10n, Symbol('s'), () => 1, new Date(0), /x/];
  const keys = ['date', 'is_from_me', 'handle', 'text', 'attributedBody', 'cache_has_attachments', 'item_type',
    'associated_message_type', 'associated_message_guid', 'guid', 'rowid', 'keep_empty'];
  for (const key of keys) {
    for (const value of values) {
      const odd = Object.assign({}, base, { guid: 'G2' });
      odd[key] = value;
      const st = run([Object.assign({}, base), odd, tap(t + 5, '+15550100002', 2000, base)]);
      assert.ok(st.totals.messages === 1 || st.totals.messages === 2, key);
      Engine.canonicalJson(st);
    }
  }
  // rows that are not rows, and no rows at all
  assert.equal(run([null, 5, 'row', [], base, undefined, true, Symbol('s'), () => 1]).totals.messages, 1);
  for (const nothing of [[], null, undefined, 5, 'rows', {}, new Set()]) assert.equal(run(nothing).totals.messages, 0);
  assert.equal(run(new Set([base])).totals.messages, 1);
  // a huge number as text is "no text", not a buffer size
  let st = run([msg(t, '+15550100001', 2 ** 40), msg(t + 1, '+15550100001', 'real text')]);
  assert.deepEqual([st.totals.messages, st.totals.words], [1, 2]);
  const sample = fixture().info.typedstream_samples.find((s) => /^[a-z]+( [a-z]+)+$/i.test(s.text));
  st = run([msg(t, '+15550100001', 2 ** 40, { attributedBody: new Uint8Array(Buffer.from(sample.hex, 'hex')) })]);
  assert.deepEqual([st.totals.messages, st.totals.words], [1, sample.text.split(' ').length]);
  assert.equal(Engine.decodeAttributedBody(5), null);
  assert.equal(Engine.decodeAttributedBody('a string'), null);
  assert.equal(Engine.decodeAttributedBody({}), null);
});

test('computeStats: options of the wrong type', () => {
  const rows = [msg(utc(2026, 5, 5, 10))];
  const ranged = (options, pattern) => assert.throws(() => run(rows, Object.assign({ all_time: false }, options)),
    (error) => error instanceof RangeError && error.code === 'range' && (!pattern || pattern.test(error.message)),
    JSON.stringify(options));
  for (const year of [0, -1, 10000, 2026.5, '2026', true, [], NaN, Infinity, 1e30]) ranged({ year }, /between 1 and 9999/);
  assert.equal(run(rows, { all_time: false, year: 2026 }).period.label, '2026');
  assert.equal(run(rows, { all_time: false, year: 1 }).period.start, '0001-01-01');
  assert.equal(run(rows, { all_time: false, year: 9999 }).period.end, '9999-12-31');
  for (const bad of [{ now: 'soon' }, { now: -1 }, { now: NaN }, { now: 1e30 }, { now: [] }, { tz: 'Mars/Olympus' },
    { tz: 5 }, { tz: [] }, { start: 5 }, { start: '2026-13-01' }, { end: 'soon' },
    { start: '2026-06-01', end: '2026-05-01' }]) ranged(bad);
  // values that JSON cannot show do not turn the explanation into a second error
  const loop = {};
  loop.self = loop;
  for (const awkward of [10n, loop, Symbol('s'), () => 1]) {
    for (const key of ['year', 'now', 'tz', 'start', 'end']) {
      assert.throws(() => run(rows, { all_time: false, [key]: awkward }), (error) => error.code === 'range', key);
    }
  }
  // ... and what is echoed back is cleaned and short
  assert.throws(() => run(rows, { tz: 'Mars\x1b[31m/\u202EOlympus\r\n' + 'x'.repeat(500) }),
    (error) => error.code === 'range' && error.message.length < 120 && textLeaks(error.message).length === 0);
  // stats that are not plain data are refused with a code, not a TypeError
  for (const bad of [{ v: 1n }, loop, { nested: [loop] }]) {
    for (const call of [() => Engine.fitLink(bad), () => Engine.buildLink(bad, { quotes: true }),
      () => Engine.shortNames(bad), () => Engine.encodePayload(bad)]) {
      assert.throws(call, (error) => error.code === 'bad_stats');
    }
  }
  assert.throws(() => Engine.encodePayload(undefined), (error) => error.code === 'bad_stats');
  for (const harmless of [{ me: 5 }, { me: [] }, { chat_name: 7 }, { chat_name: ['x'] }, { participants: 5 },
    { participants: '+15550100002' }, { participants: [null, 5, '', '+15550100002'] }, { contacts: 5 },
    { contacts: 'text' }, { contacts: [null, 5, 'ab', ['solo'], [5, 'Name']] }, { label: 5 }, { source: [] }]) {
    assert.equal(run(rows, harmless).totals.messages, 1, JSON.stringify(harmless));
  }
  assert.equal(Engine.computeStats(rows, null).v, 1);
});
