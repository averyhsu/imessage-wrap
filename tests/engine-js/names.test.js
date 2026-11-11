'use strict';
// Names in a recap (docs/SCHEMA.md section 2): clean names, masking, short names.
//
// The hand-written expectations are in tests/conformance/names.json, which the
// Python tests read as well, so both engines answer to the same table. The last
// tests check, end to end, that no phone number, address or control character
// reaches the stats, the share link or the chat list: for the ordinary fixture,
// for the hostile one and for an imported export.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {
  ROOT, Engine, DB, NAMES, fixture, read, utc, msg, tap, countDecimals, textLeaks, namesIn, leaks, tooLong
} = require('./support.js');

const Import = require(path.join(ROOT, 'web', 'make', 'import-rows.js'));
const I = Engine._internals;
const NOW = utc(2026, 11, 11, 20);
const ELLIPSIS = '\u2026';
const ME = '\x07Amara\u202E\r\nQuinn\x7f';            // cleans to "Amara Quinn"

function run(rows, options) {
  return Engine.computeStats(rows, Object.assign({ tz: 'UTC', now: NOW, all_time: true }, options || {}));
}

const controlOnly = (findings) => findings.filter((finding) => finding.includes('control'));

// ---- clean names ----------------------------------------------------------------

test('clean names: the shared table', () => {
  assert.ok(NAMES.clean.length > 20);
  for (const [raw, expected] of NAMES.clean) assert.equal(Engine.cleanName(raw), expected, JSON.stringify(raw));
  for (const notText of [undefined, null, 5, true, {}, [], ['x']]) assert.equal(Engine.cleanName(notText), '');
});

test('clean names: every dangerous character is dropped, and cleaning is stable', () => {
  const removed = [0x200E, 0x200F, 0xFEFF, 0xFFFC, 0xFFFD];
  for (let code = 0x00; code < 0x20; code++) removed.push(code);
  for (let code = 0x7F; code < 0xA0; code++) removed.push(code);
  for (let code = 0x202A; code < 0x202F; code++) removed.push(code);
  for (let code = 0x2066; code < 0x206A; code++) removed.push(code);
  for (const code of removed) {
    const expected = code === 0x09 || code === 0x0A || code === 0x0D ? 'a b' : 'ab';
    assert.equal(Engine.cleanName('a' + String.fromCharCode(code) + 'b'), expected, code.toString(16));
  }
  for (const code of [0x2028, 0x2029]) assert.equal(Engine.cleanName('a' + String.fromCharCode(code) + 'b'), 'a b');
  for (const keep of ['\u200D', '\u200C', '\u200B', '\uFE0F', '\uFE0E', '\xe9', '\u{1F32E}', '\u0301', '\xa0',
    '\u{E0100}']) {
    assert.equal(Engine.cleanName('a' + keep + 'b'), 'a' + keep + 'b');
  }
  for (const [raw] of NAMES.clean.concat(NAMES.mask, NAMES.chat_names)) {
    const once = Engine.cleanName(raw);
    assert.equal(Engine.cleanName(once), once, JSON.stringify(raw));
    assert.deepEqual(controlOnly(textLeaks(once)), [], JSON.stringify(raw));
  }
});

test('clean names: every name that reaches the stats is clean', () => {
  const t = utc(2026, 5, 5, 10);
  const evil = 'Mal\x1b[31m\u202Eory\r\nX\x00';
  const rows = [msg(t, evil, 'hello', { guid: 'G1' }), msg(t + 60, 'me', 'hi', { guid: 'G2' }),
    msg(t + 120, '+15550100020', 'yo'), tap(t + 180, evil, 2000, { guid: 'G2' }),
    tap(t + 200, 'me', 2003, { guid: 'G1' })];
  const contacts = { '+15550100020': 'Tab\tby \x1b[0mCat' };
  let st = run(rows, {
    me: ME, chat_name: 'Chat\x07 \u2066name\u2069\t!', label: 'La\x1bbel\n2', source: 'chat\x00.db',
    contacts, participants: [evil, '+15550100020']
  });
  assert.deepEqual(st.chat, { name: 'Chat name !', members: 3 });
  assert.equal(st.period.label, 'Label 2');
  assert.equal(st.meta.source, 'chat.db');
  assert.deepEqual(st.senders.map((s) => s.name).sort(), ['Amara Quinn', 'Mal[31mory X', 'Tab by [0mCat']);
  assert.deepEqual(leaks(st), []);
  // a chat without a name of its own is called after its (clean) members
  st = run(rows, { me: ME, contacts, participants: [evil, '+15550100020'] });
  assert.equal(st.chat.name, 'Mal[31mory, Tab');
  assert.deepEqual(leaks(st), []);
  // nothing left of a name: the fallbacks
  assert.equal(run([msg(t, '\x1b\x07\u202E')], { me: '\x00', chat_name: '\x1b' }).senders[0].name, 'Unknown');
  assert.equal(run([msg(t)], { me: '\x00\t' }).senders[0].name, 'Me');
  assert.equal(run([msg(t)], { chat_name: '\x1b\x07' }).chat.name, 'Unnamed group');
});

// ---- masking ----------------------------------------------------------------------

test('masking: the shared table; what comes out holds nothing private', () => {
  assert.ok(NAMES.mask.length > 40);
  for (const [raw, expected] of NAMES.mask) {
    const shown = Engine.maskHandle(Engine.cleanName(raw));
    assert.equal(shown, expected, JSON.stringify(raw));
    assert.deepEqual(textLeaks(shown), [], JSON.stringify(raw));
    assert.ok(countDecimals(shown) < 7, JSON.stringify(raw));
    assert.equal(Engine.maskHandle(Engine.cleanName(shown)), shown, JSON.stringify(raw));     // stable
  }
});

test('masking: chat names', () => {
  for (const [display, expected] of NAMES.chat_names) {
    assert.equal(Engine.chatDisplayName(display, [], null, 'Me'), expected, JSON.stringify(display));
  }
  const t = utc(2026, 5, 5, 10);
  assert.equal(run([msg(t)], { chat_name: '+1 (555) 010-0142' }).chat.name, ELLIPSIS + '0142');
  assert.equal(run([msg(t)], { chat_name: 'Party <party.planning@example.com>' }).chat.name, 'party.planning');
});

test('masking: every decimal digit this runtime knows counts as a digit', () => {
  let known = 0;
  const missing = [];
  for (let code = 0; code < 0x110000; code++) {
    if (code >= 0xD800 && code <= 0xDFFF) continue;
    const ch = String.fromCodePoint(code);
    if (!/^\p{Nd}$/u.test(ch)) continue;
    known += 1;
    if (Engine.maskHandle(ch.repeat(7)) !== ELLIPSIS + ch.repeat(4)) missing.push('U+' + code.toString(16));
    assert.equal(Engine.maskHandle(ch.repeat(6)), ch.repeat(6), 'U+' + code.toString(16));
  }
  assert.ok(known >= 600, String(known));
  // the engine's table is Unicode 17; a newer runtime may know digits that it does not
  if (parseFloat(process.versions.unicode) <= 17) assert.deepEqual(missing, []);
  else assert.ok(missing.length <= known - 770, missing.join(' '));
  // letters, superscripts and circled numbers are not decimal digits
  for (const other of ['aaaaaaa', '\xb2\xb3\xb9\xb2\xb3\xb9\xb2', '\u2460\u2461\u2462\u2463\u2464\u2465\u2466']) {
    assert.equal(Engine.maskHandle(other), other);
  }
});

test('masking: every way round the first mask is closed', () => {
  // the handles from the review, as senders, tapback givers and members
  const t = utc(2026, 5, 5, 10);
  const pairs = fixture().info.evil.handles.filter((entry) => entry.id !== null);
  assert.ok(pairs.length >= 20);
  for (let start = 0; start < pairs.length; start += 10) {      // a recap lists at most 12 senders
    const group = pairs.slice(start, start + 10).map((entry) => entry.id);
    const labels = pairs.slice(start, start + 10).map((entry) => entry.label);
    const rows = group.map((h, i) => msg(t + i, h, 'hello there', { guid: 'G' + i }));
    group.forEach((h, i) => rows.push(tap(t + 100 + i, h, 2003, rows[0])));
    const st = run(rows, { participants: group, chat_name: '' });
    assert.deepEqual(st.senders.map((s) => s.name).sort(), labels.slice().sort());
    assert.equal(st.chat.members, group.length + 1);
    assert.deepEqual(leaks(st), []);
    assert.deepEqual(leaks(Engine.statsFromUrl(Engine.buildLink(st))), []);
  }
  // a contact name still wins over the mask
  const named = run([msg(t, 'tel:+15550100123')], { contacts: { '(555) 010-0123': 'Ines Calloway' } });
  assert.equal(named.senders[0].name, 'Ines Calloway');
});

// ---- sender labels ----------------------------------------------------------------
// A handle, an imported sender, a contact name, the owner's name: each is a
// sender label, cleaned, cut to 40 characters and masked.

const length = (text) => Array.from(text).length;

test('sender labels: the shared table', () => {
  assert.ok(NAMES.person.length > 25);
  const t = utc(2026, 5, 5, 10);
  for (const [raw, expected] of NAMES.person) {
    const shown = I.personLabel(raw);
    assert.equal(shown, expected, JSON.stringify(raw).slice(0, 80));
    assert.deepEqual(textLeaks(shown), []);
    assert.ok(length(shown) <= 41);
    assert.equal(I.personLabel(shown), shown);                    // stable
    if (typeof raw === 'string' && expected) {                    // as a contact name, a handle, the owner
      assert.equal(run([msg(t, '+15550100777', 'hi')], { contacts: { '(555) 010-0777': raw } }).senders[0].name, expected);
      assert.equal(run([msg(t, raw, 'hi')]).senders[0].name, expected);
      assert.equal(run([msg(t)], { me: raw }).senders[0].name, expected);
    }
  }
});

test('sender labels: cards saved under a number or an address never reach a link', () => {
  const t = utc(2026, 5, 5, 10);
  const contacts = [['+15550100401', 'jane.doe@example.com'], ['+15550100402', '+1 (555) 010-0402'],
    ['+15550100403', 'Dr. Okafor 555-010-0403'], ['+15550100001', 'Ines Calloway']];
  const handles = contacts.map((pair) => pair[0]);
  const rows = [];
  for (let i = 0; i < 24; i++) rows.push(msg(t + i, handles[i % 4], 'hello there', { guid: 'G' + i }));
  for (let i = 0; i < 12; i++) rows.push(tap(t + 100 + i, handles[i % 4], 2003, rows[(i + 1) % 8]));
  rows.push(msg(t + 200, 'me', 'mine'));
  const labels = ['jane.doe', '\u20260402', '\u20260403', 'Ines Calloway', 'Me'];
  let st = run(rows, { contacts, participants: handles });
  assert.deepEqual(st.senders.map((s) => s.name).sort(), labels.slice().sort());
  assert.equal(st.chat.name, 'jane.doe, \u20260402, \u20260403 & 1 more');
  const short = Engine.shortNames(st);
  assert.deepEqual(short.senders.map((s) => s.name).sort(), ['jane.doe', '\u20260402', '\u20260403', 'Ines', 'Me'].sort());
  for (const stats of [st, short]) {
    assert.deepEqual(leaks(stats), []);
    const text = JSON.stringify(stats);
    for (const secret of ['example.com', 'Okafor', '010-0402', '5550100']) assert.ok(!text.includes(secret), secret);
    for (const quotes of [false, true]) {
      assert.deepEqual(leaks(Engine.statsFromUrl(Engine.buildLink(stats, { quotes }))), []);
    }
  }
  // the same cards as an object and as a Map; two cards for one number: the label that sorts first
  st = run(rows, { contacts: Object.fromEntries(contacts) });
  assert.deepEqual(st.senders.map((s) => s.name).sort(), labels.slice().sort());
  st = run(rows, { contacts: new Map(contacts) });
  assert.deepEqual(st.senders.map((s) => s.name).sort(), labels.slice().sort());
  st = run(rows.slice(0, 1), { contacts: [['+15550100401', 'Zed'], ['+15550100401', '+1 555 010 0401']] });
  assert.equal(st.senders[0].name, 'Zed');
  // the owner is a sender label too
  assert.equal(run([msg(t)], { me: '+1 555 010 0123' }).senders[0].name, '\u20260123');
  assert.equal(run([msg(t)], { me: 'jane.doe@example.com' }).senders[0].name, 'jane.doe');
});

test('sender labels: names are capped however long they are', () => {
  const t = utc(2026, 5, 5, 10);
  const million = 1000000;
  const rows = [msg(t, 'H'.repeat(million), 'hi'), msg(t + 1, '+15550100002', 'yo'), msg(t + 2)];
  let st = run(rows, {
    me: 'M'.repeat(million), chat_name: 'C'.repeat(million), label: 'L'.repeat(million), source: 'S'.repeat(million),
    contacts: { '+15550100002': 'N'.repeat(million) }, participants: ['H'.repeat(million), 'P'.repeat(million)]
  });
  assert.deepEqual(st.chat, { name: 'C'.repeat(80) + '\u2026', members: 4 });
  assert.equal(st.period.label, 'L'.repeat(80) + '\u2026');
  assert.equal(st.meta.source, 'S'.repeat(40) + '\u2026');
  assert.deepEqual(st.senders.map((s) => s.name).sort(), ['H', 'M', 'N'].map((letter) => letter.repeat(40) + '\u2026'));
  assert.deepEqual(tooLong(st), []);
  assert.ok(JSON.stringify(st).length < 3000);
  // counted in characters, not in UTF-16 units; a pair is never split
  const party = run([msg(t)], { chat_name: '\u{1F389}'.repeat(1000), me: '\u{1F600}'.repeat(1000) });
  assert.equal(party.chat.name, '\u{1F389}'.repeat(80) + '\u2026');
  assert.equal(party.senders[0].name, '\u{1F600}'.repeat(40) + '\u2026');
  // a chat named after its members is held to 80 as well
  const handles = [0, 1, 2, 3, 4].map((i) => String.fromCharCode(0x4E00 + i).repeat(39) + 'x');
  st = run(handles.map((h) => msg(t, h, 'hi')), { participants: handles });
  assert.equal(length(st.chat.name), 81);
  assert.ok(st.chat.name.endsWith('\u2026'));
  // only the first 1,024 characters are looked at (characters, not UTF-16 units)
  assert.equal(Engine.cleanName('\x00'.repeat(1023) + 'tail', 40), 't');
  assert.equal(Engine.cleanName('\x00'.repeat(1024) + 'tail', 40), '');
  assert.equal(Engine.cleanName('\x00'.repeat(1024) + 'tail'), 'tail');
  assert.equal(Engine.cleanName('\u{1F600}'.repeat(1023) + 'tail', 2000), '\u{1F600}'.repeat(1023) + 't');
  assert.equal(I.nameWindow('\u{1F600}'.repeat(2000)).length, 2048);
  assert.deepEqual([Engine.NAME_LIMIT, Engine.CHAT_NAME_LIMIT], [40, 80]);
});

test('sender labels: a million characters cost no more than a short name', () => {
  const t = utc(2026, 5, 5, 10);
  const million = 1000000;
  const best = (rows, options) => {
    let fastest = Infinity;
    for (let i = 0; i < 5; i++) {
      const started = performance.now();
      run(rows, options);
      fastest = Math.min(fastest, performance.now() - started);
    }
    return fastest;
  };
  const shortHandles = Array.from({ length: 20 }, (_x, i) => 'person ' + i);
  // built in pieces so that every handle is its own flat string, as a parser would hand it over
  const longHandles = shortHandles.map((h) => Buffer.from((h + ' ').repeat(Math.ceil(million / 9))).toString());
  assert.ok(Math.min(...longHandles.map((h) => h.length)) >= million);
  const shortRows = Array.from({ length: 400 }, (_x, i) => msg(t + i, shortHandles[i % 20], 'hello there'));
  const longRows = Array.from({ length: 400 }, (_x, i) => msg(t + i, longHandles[i % 20], 'hello there'));
  const short = best(shortRows, { chat_name: 'Chat', me: 'Me', contacts: { '+15550100001': 'Ines' }, participants: shortHandles });
  const contacts = { '+15550100001': 'N'.repeat(million) };
  contacts['9'.repeat(million)] = 'x';
  const long = best(longRows, {
    chat_name: 'C'.repeat(million), me: 'M'.repeat(million), label: 'L'.repeat(million), contacts, participants: longHandles
  });
  assert.ok(long < short * 3 + 50, 'short ' + short.toFixed(2) + ' ms, long ' + long.toFixed(2) + ' ms');
  const started = performance.now();
  for (let i = 0; i < 200; i++) {
    I.personLabel(longHandles[0]);
    Engine.cleanName(longHandles[1], Engine.CHAT_NAME_LIMIT);
    Engine.contactKey(longHandles[2]);
  }
  assert.ok(performance.now() - started < 500);
});

test('sender labels: short names never bring anything back', () => {
  // a stats object from somewhere else, with raw labels still in it
  const foreign = {
    senders: [{ name: 'Dr. Okafor 555-010-0403' }, { name: 'jane.doe@example.com' }, { name: 'Sam Rivera' },
      { name: 'Sam +15550100123' }, { name: 'N'.repeat(500) }, { name: 'Evil\x1b[31m\u202e Name' },
      { name: '+1 555 010 0177' }],
    awards: [{ winner: 'Dr. Okafor 555-010-0403' }, { winner: 'Sam Rivera' }],
    reactions: { top_giver: { name: 'jane.doe@example.com' }, top_receiver: null }
  };
  const short = Engine.shortNames(foreign, '+1 555 010 0177');
  assert.deepEqual(short.senders.map((s) => s.name),
    ['\u20260403', 'jane.doe', 'Sam', '\u20260123', 'N'.repeat(40) + '\u2026', 'Evil[31m', '\u20260177']);
  assert.deepEqual(short.awards.map((a) => a.winner), ['\u20260403', 'Sam']);
  assert.equal(short.reactions.top_giver.name, 'jane.doe');
  assert.deepEqual(leaks(short), []);
  assert.deepEqual(tooLong(short), []);
  // names computeStats produced are not touched by the extra pass
  for (const item of NAMES.short) for (const name of item.names) assert.equal(I.personLabel(name), name);
});

// ---- short names ----------------------------------------------------------------

test('short names: the shared table', () => {
  assert.ok(NAMES.short.length > 10);
  for (const item of NAMES.short) {
    assert.deepEqual(Object.fromEntries(I.shortForms(item.names, item.me)), item.expected, JSON.stringify(item.names));
  }
});

function recap() {
  const t = utc(2026, 5, 5, 3);
  const contacts = {
    '+15550100003': 'Sam Rivera', '+15550100004': 'Sam Chen', '+15550100001': 'Ines Calloway',
    '+15550100021': 'Dave plumber'
  };
  const people = ['+15550100003', '+15550100004', '+15550100001', '+15550100021', '+15550100022', 'me'];
  const rows = [];
  for (let i = 0; i < 48; i++) {
    rows.push(msg(t + i * 600, people[(i * i + Math.floor(i / 5)) % 6], 'word '.repeat(1 + i % 5), { guid: 'G' + i }));
  }
  for (let i = 0; i < 30; i++) rows.push(tap(t + 40000 + i, people[i % 6], i % 2 ? 2003 : 2000, rows[(i * 7) % 12]));
  return run(rows, { contacts, me: 'Amara Quinn', chat_name: 'Dinner' });
}

test('short names: a whole recap is renamed consistently and nothing else changes', () => {
  const full = recap();
  const frozen = JSON.stringify(full);
  const short = Engine.shortNames(full, 'Amara Quinn');
  assert.equal(JSON.stringify(full), frozen);                     // the input is not modified
  const expected = {
    'Sam Rivera': 'Sam R.', 'Sam Chen': 'Sam C.', 'Ines Calloway': 'Ines', 'Dave plumber': 'Dave',
    'Amara Quinn': 'Amara Quinn'
  };
  expected[ELLIPSIS + '0022'] = ELLIPSIS + '0022';
  assert.deepEqual(full.senders.map((s) => s.name).sort(), Object.keys(expected).sort());
  assert.deepEqual(short.senders.map((s) => s.name), full.senders.map((s) => expected[s.name]));
  const before = namesIn(full);
  const after = namesIn(short);
  assert.deepEqual(after.map((slot) => slot[0]), before.map((slot) => slot[0]));
  assert.deepEqual(Array.from(new Set(before.map((slot) => slot[0].split('[')[0]))).sort(),
    ['awards', 'chat.name', 'late_night.top.name', 'most_reacted', 'reactions.top_giver.name',
      'reactions.top_receiver.name', 'senders']);
  before.forEach(([where, old], i) => {
    assert.equal(after[i][1], where === 'chat.name' ? old : expected[old], where);
  });
  for (const key of Object.keys(full)) {
    if (!['senders', 'late_night', 'most_reacted', 'reactions', 'awards'].includes(key)) {
      assert.deepEqual(short[key], full[key], key);
    }
  }
  assert.deepEqual(short.senders.map((s) => s.messages), full.senders.map((s) => s.messages));
  assert.deepEqual(Engine.shortNames(short, 'Amara Quinn'), short);
  // the owner is whoever the caller says; the default is "Me"
  assert.ok(Engine.shortNames(full).senders.some((s) => s.name === 'Amara'));
  // computeStats itself keeps full names
  assert.ok(recap().senders.some((s) => s.name === 'Sam Rivera'));
});

test('short names: odd input', () => {
  assert.deepEqual(Engine.shortNames({}), {});
  const odd = {
    senders: null, awards: [null, 5, { winner: 7 }, { winner: 'Sam Rivera' }], reactions: [],
    late_night: { top: null }, most_reacted: 'none'
  };
  const expected = JSON.parse(JSON.stringify(odd));
  expected.awards[3].winner = 'Sam';
  assert.deepEqual(Engine.shortNames(odd), expected);
  assert.deepEqual(Engine.shortNames([1, 2]), [1, 2]);
  assert.equal(Engine.shortNames(undefined), undefined);
  assert.equal(Engine.shortNames(null), null);
});

// ---- end to end -------------------------------------------------------------------

async function check(dbKey, walKey, books, me, expectedNames) {
  const handle = await DB.openDatabase({ db: read(dbKey), wal: walKey ? read(walKey) : undefined });
  let contacts = null;
  if (books) {
    contacts = [];
    for (const book of books) {
      const bookHandle = await DB.openDatabase({ db: read(book) });
      contacts = contacts.concat(DB.loadContacts(bookHandle));
      bookHandle.close();
    }
  }
  const listing = DB.listGroupChats(handle, { contacts, me });
  assert.ok(listing.chats.length >= 4);
  const seen = new Set();
  for (const chat of listing.chats) {
    assert.deepEqual(textLeaks(chat.name), [], chat.name);
    assert.deepEqual(textLeaks(chat.display_name), [], chat.name);
    if (expectedNames && expectedNames[chat.id]) assert.equal(chat.name, expectedNames[chat.id]);
    const stats = DB.statsForChat(handle, chat, { all_time: true, tz: 'UTC', now: NOW, me, contacts });
    assert.deepEqual(leaks(stats), [], chat.name);
    assert.deepEqual(tooLong(stats), [], chat.name);
    assert.ok(length(chat.name) <= 81);
    for (const id of chat.participants) assert.ok(id.length <= 4096);
    stats.senders.forEach((sender) => seen.add(sender.name));
    const short = Engine.shortNames(stats, I.ownerName(me));
    assert.deepEqual(leaks(short), [], chat.name);
    for (const options of [undefined, { quotes: true }]) {
      const shared = Engine.statsFromUrl(Engine.fitLink(short, options).url);
      assert.deepEqual(leaks(shared), [], chat.name);
      if (!options) assert.ok(shared.most_reacted.every((quote) => quote.text === ''));
    }
  }
  handle.close();
  return seen;
}

test('nothing private is shown: the ordinary fixture', async () => {
  const books = fixture().info.paths.address_books;
  assert.ok((await check('chat_db', 'chat_db_wal', books, 'Me')).has('Ines Calloway'));
  assert.ok((await check('chat_db', 'chat_db_wal', null, 'Amara')).has(ELLIPSIS + '0001'));
});

test('nothing private is shown: the evil fixture', async () => {
  const info = fixture().info.evil;
  const names = {};
  for (const chat of Object.values(info.chats)) if (chat.name) names[chat.rowid] = chat.name;
  let seen = await check('evil_db', null, ['evil_address_book'], ME, names);
  for (const entry of info.handles) assert.ok(seen.has(entry.label), entry.label);
  for (const entry of info.contacts) assert.ok(seen.has(entry.name), entry.name);
  for (const name of ['Amara Quinn', 'Unknown', info.stranger.label]) assert.ok(seen.has(name), name);
  for (const entry of info.numbered) assert.ok(seen.has(entry.name), entry.name);     // cards saved under a number
  seen = await check('evil_db', null, null, 'Me', names);
  for (const entry of info.handles) assert.ok(seen.has(entry.label), entry.label);
  assert.ok(seen.has('nick'));                // nick@example.com without the address book
  for (const label of ['\u20260401', '\u20260402', '\u20260403', 'okafor']) assert.ok(seen.has(label), label);
  // the address book as the page gets it: the names are labels already
  const book = await DB.openDatabase({ db: read('evil_address_book') });
  const pairs = DB.loadContacts(book);
  book.close();
  for (const entry of info.numbered.concat(info.contacts)) {
    const pair = pairs.find((p) => Engine.contactKey(p[0]) === Engine.contactKey(entry.handle));
    assert.equal(pair[1], entry.name);
  }
  // a chat name of a million characters costs no more than a short one
  const handle = await DB.openDatabase({ db: read('evil_db') });
  const best = (id) => {
    let fastest = Infinity;
    for (let i = 0; i < 5; i++) {
      const started = performance.now();
      DB.statsForChat(handle, id, { all_time: true, tz: 'UTC', now: NOW, contacts: pairs });
      fastest = Math.min(fastest, performance.now() - started);
    }
    return fastest;
  };
  const long = best(info.chats.long_name.rowid);
  const short = best(info.chats.text_style.rowid);
  assert.ok(long < short * 3 + 250, 'short ' + short.toFixed(1) + ' ms, long ' + long.toFixed(1) + ' ms');
  const stats = DB.statsForChat(handle, info.chats.long_name.rowid, { all_time: true, tz: 'UTC', now: NOW, contacts: pairs });
  assert.equal(stats.chat.name, info.chats.long_name.name);
  assert.ok(stats.senders.some((s) => s.name === 'N'.repeat(40) + '\u2026'));
  handle.close();
});

test('nothing private is shown: an imported export', () => {
  const senders = fixture().info.evil.handles.filter((entry) => entry.id !== null);
  const t = utc(2026, 5, 5, 10);
  const when = (i) => new Date((t + i * 90) * 1000).toISOString();
  for (let start = 0; start < senders.length; start += 10) {
    const group = senders.slice(start, start + 10);
    // JSON Lines: a sender can hold any character at all
    const lines = [];
    group.forEach((entry, i) => {
      lines.push(JSON.stringify({ date: when(i), sender: entry.id, text: 'hello there' }));
      lines.push(JSON.stringify({ date: when(i + 40), sender: entry.id, text: 'and again' }));
    });
    lines.push(JSON.stringify({ date: when(99), sender: '', text: 'mine' }));
    const result = Import.parseExport(lines.join('\n'));
    assert.equal(result.format, 'jsonl');
    assert.deepEqual(result.warnings, []);
    assert.equal(result.summary.senders, group.length + 1);
    for (const row of result.rows) {
      if (row.handle !== null) assert.deepEqual(controlOnly(textLeaks(row.handle)), [], JSON.stringify(row.handle));
    }
    const stats = run(result.rows, { chat_name: 'Imported' });
    assert.deepEqual(stats.senders.map((s) => s.name).sort(), group.map((entry) => entry.label).concat(['Me']).sort());
    assert.deepEqual(leaks(stats), []);
    assert.deepEqual(leaks(Engine.statsFromUrl(Engine.buildLink(Engine.shortNames(stats)))), []);
  }
  // CSV: quoted senders with commas and line breaks; columnar: one sender per line
  const csv = 'date,sender,text\n' + when(0) + ',"Jane Doe <jane.doe@example.com>",hi\n' + when(1) +
    ',"Evil\x1b[31m\r\nName\u202E",hi\n' + when(2) + ',"+1 555-010-0124 (mobile)","a, b"\n' + when(3) + ',Maya,ok\n';
  let stats = run(Import.parseExport(csv).rows);
  assert.deepEqual(stats.senders.map((s) => s.name).sort(), ['Evil[31m Name', 'Maya', 'jane.doe', ELLIPSIS + '0124'].sort());
  assert.deepEqual(leaks(stats), []);
  const columnar = '#dates\n' + [0, 1, 2, 3].map(when).join('\n') +
    '\n#senders\ntel:+15550100123\n+1\xa0555\xa0010\xa00128\n\npat.evil@example.com\n';
  stats = run(Import.parseExport(columnar).rows);
  assert.deepEqual(stats.senders.map((s) => s.name).sort(), ['Me', 'pat.evil', ELLIPSIS + '0123', ELLIPSIS + '0128'].sort());
  assert.deepEqual(leaks(stats), []);
  // what a warning quotes back is cleaned as well
  const warned = Import.parseExport(JSON.stringify({ date: 'so\x1b[31mon\u202E\x07', sender: 'Maya', text: 'x' }));
  assert.equal(warned.rows.length, 0);
  assert.ok(warned.warnings.length >= 1);
  for (const warning of warned.warnings) assert.deepEqual(controlOnly(textLeaks(warning)), [], warning);
  assert.equal(Import._internals.cleanName(' \x00Ma\u202Eya\t \r\n x\uFFFD '), 'Maya x');
  // a sender of a million characters: cut like any name, and no slower to read
  const million = 'Wolfeschlegelstein '.repeat(55556);
  const long = [0, 1, 2, 3, 4, 5].map((i) => JSON.stringify({ date: when(i), sender: million + i, text: 'hi' })).join('\n');
  const short = [0, 1, 2, 3, 4, 5].map((i) => JSON.stringify({ date: when(i), sender: 'Maya' + i, text: 'hi' })).join('\n');
  const parsed = Import.parseExport(long);
  assert.deepEqual(parsed.rows.map((row) => row.handle),
    new Array(6).fill('Wolfeschlegelstein Wolfeschlegelstein Wo\u2026'));
  assert.equal(parsed.summary.senders, 1);
  assert.equal(run(parsed.rows).senders[0].name, 'Wolfeschlegelstein Wolfeschlegelstein Wo\u2026');
  assert.equal(Import._internals.cleanName('\u{1F600}'.repeat(3000), 40), '\u{1F600}'.repeat(40) + '\u2026');
  assert.equal(Import._internals.cleanName('a'.repeat(2047) + '\u{1F600}'), 'a'.repeat(2047));    // no half pair
  assert.equal(Import.parseExport(short).summary.senders, 6);
  assert.equal(Import.parseExport(JSON.stringify({ date: '2'.repeat(million.length), sender: 'Maya' })).rows.length, 0);
});

test('the importer documents what it does with lists of unequal length', () => {
  const source = fs.readFileSync(path.join(ROOT, 'web', 'make', 'import-rows.js'), 'utf8');
  const header = source.slice(0, source.indexOf('(function'));
  assert.match(header, /only the first N lines of each list are used/);
  assert.match(header, /a warning gives both\s+\*\s+counts/);
  const dates = ['2026-01-01T10:00:00Z', '2026-01-02T10:00:00Z', '2026-01-03T10:00:00Z', '2026-01-04T10:00:00Z'];
  // more dates than senders, and the other way round: the shorter list decides, and says so
  let result = Import.parseExport('#dates\n' + dates.join('\n') + '\n#senders\nAna\nBo');
  assert.deepEqual(result.rows.map((row) => row.handle), ['Ana', 'Bo']);
  assert.equal(result.summary.messages, 2);
  assert.deepEqual(result.warnings.length, 1);
  assert.match(result.warnings[0], /#dates has 4 lines but #senders has 2; only the first 2 of each were used/);
  result = Import.parseExport('#dates\n' + dates.slice(0, 2).join('\n') + '\n#senders\nAna\nBo\nCy\nDi\nEd');
  assert.deepEqual(result.rows.map((row) => row.handle), ['Ana', 'Bo']);
  assert.match(result.warnings[0], /#dates has 2 lines but #senders has 5; only the first 2 of each were used/);
  // equal lists: no warning
  result = Import.parseExport('#dates\n' + dates.join('\n') + '\n#senders\nAna\nBo\nCy\nDi');
  assert.deepEqual(result.warnings, []);
  assert.equal(result.rows.length, 4);
  // an unknown time zone is the one thing that throws, and it has a code
  assert.throws(() => Import.parseExport('#dates\n' + dates[0] + '\n', { tz: 'Mars/Olympus\x1b[0m' }),
    (error) => error instanceof RangeError && error.code === 'range' && controlOnly(textLeaks(error.message)).length === 0);
});
