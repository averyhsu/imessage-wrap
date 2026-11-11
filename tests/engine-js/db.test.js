'use strict';
// web/make/db.js on the generated fixture: WAL merging, chat discovery,
// iPhone backups, contacts, old schemas, and the hand-computed tiny chat.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const {
  ROOT, Engine, DB, LA, EXPECTED, python, fixture, read, tempDir, macContacts, openMac, subsetMismatches
} = require('./support.js');

const NOW = EXPECTED.now;

function walk(dir, base) {
  let out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const relative = base ? base + '/' + entry.name : entry.name;
    if (entry.isDirectory()) out = out.concat(walk(path.join(dir, entry.name), relative));
    else out.push(relative);
  }
  return out;
}

async function rejects(promise, code) {
  let error = null;
  try { await promise; } catch (caught) { error = caught; }
  assert.ok(error, 'expected a rejection with code ' + code);
  assert.equal(error.code, code);
  return error;
}

// ---- write-ahead log ----------------------------------------------------------

test('mergeWal reproduces what SQLite reads, case by case', async () => {
  const dir = tempDir('wrapped-wal-');
  python([path.join(__dirname, 'wal_cases.py'), path.join(dir, 'cases')]);
  const spec = JSON.parse(fs.readFileSync(path.join(dir, 'cases', 'cases.json'), 'utf8'));
  const names = Object.keys(spec.cases);
  assert.ok(names.length >= 18);
  const dump = (handle) => {
    const hash = crypto.createHash('sha256');
    let rows = 0;
    handle.each(spec.query, null, (r) => { hash.update(r[0] + '|' + r[1] + '|' + r[2] + '\n'); rows += 1; });
    return { rows, sha256: hash.digest('hex') };
  };
  let merged = 0;
  for (const name of names) {
    const expected = spec.cases[name];
    const file = (suffix) => new Uint8Array(fs.readFileSync(path.join(dir, 'cases', name, 'db' + suffix)));
    const handle = await DB.openDatabase({ db: file(''), wal: file('-wal') });
    assert.deepEqual(dump(handle), { rows: expected.rows, sha256: expected.sha256 }, name);
    assert.equal(handle.query('PRAGMA integrity_check')[0].integrity_check, 'ok', name);
    if (handle.info.walMerged) merged += 1;
    handle.close();
    if (expected.rows_without_wal !== null) {
      const plain = await DB.openDatabase({ db: file('') });
      assert.equal(dump(plain).rows, expected.rows_without_wal, name + ' without its wal');
      assert.deepEqual(plain.warnings.map((w) => w.code), ['wal_missing'], name);
      plain.close();
    }
  }
  assert.ok(merged >= 14, 'only ' + merged + ' cases had anything to merge');
  // direct use: the result is a rollback-journal image of the right size
  const db = new Uint8Array(fs.readFileSync(path.join(dir, 'cases', 'grow', 'db')));
  const wal = new Uint8Array(fs.readFileSync(path.join(dir, 'cases', 'grow', 'db-wal')));
  const result = DB.mergeWal(db, wal);
  assert.equal(result.merged, true);
  assert.ok(result.bytes.length > db.length);
  assert.deepEqual([result.bytes[18], result.bytes[19]], [1, 1]);
  assert.equal(result.bytes.length % 4096, 0);
  assert.equal(DB.sniff(result.bytes).walMode, false);
  for (const [bad, reason] of [[new Uint8Array(0), 'empty'], [new Uint8Array(64), 'bad-magic'],
    [wal.slice(0, 32).fill(1, 24, 32), 'bad-header']]) {
    assert.equal(DB.mergeWal(db, bad).reason, reason);
    assert.equal(DB.mergeWal(db, bad).merged, false);
  }
});

test('the Mac fixture: rows in the -wal are counted, a missing -wal is reported', async () => {
  const { info } = fixture();
  const withWal = await openMac();
  assert.equal(withWal.info.walMode, true);
  assert.equal(withWal.info.walMerged, true);
  assert.ok(withWal.info.walFrames > 50);
  assert.deepEqual(withWal.warnings, []);
  const without = await DB.openDatabase({ db: read('chat_db') });
  assert.deepEqual(without.warnings.map((w) => w.code), ['wal_missing']);
  assert.match(without.warnings[0].message, /chat\.db-wal/);
  const all = DB.diagnostics(withWal);
  const stale = DB.diagnostics(without);
  assert.ok(all.messages > stale.messages + 100);
  assert.equal(all.wal_merged, true);
  assert.equal(stale.wal_merged, false);
  const cutoff = String(info.wal_cutoff - 978307200) + '000000000';
  const late = withWal.query('SELECT COUNT(*) AS n FROM message WHERE date >= ' + cutoff)[0].n;
  assert.ok(late > 100);
  assert.equal(without.query('SELECT COUNT(*) AS n FROM message WHERE date >= ' + cutoff)[0].n, 0);
  const recent = { start: '2026-10-26', end: '2026-11-11', tz: 'UTC', now: NOW };
  assert.ok(DB.statsForChat(withWal, 'Taco', recent).totals.messages > 50);
  assert.equal(DB.statsForChat(without, 'Taco', recent).totals.messages, 0);
  withWal.close();
  without.close();
  // a -wal that belongs to another database is ignored, loudly
  const wrong = await DB.openDatabase({ db: read('chat_db'), wal: read('backup_address_book') });
  assert.deepEqual(wrong.warnings.map((w) => w.code), ['wal_invalid']);
  assert.equal(DB.diagnostics(wrong).messages, stale.messages);
  wrong.close();
});

test('the caller\'s buffer keeps its WAL flag when nothing was merged', async () => {
  const bytes = read('chat_db');
  const handle = await DB.openDatabase({ db: bytes });
  assert.deepEqual([bytes[18], bytes[19]], [2, 2]);
  handle.close();
});

// ---- what is this file? -------------------------------------------------------

test('sniffing, encrypted backups and the size guard', async () => {
  assert.deepEqual(DB.sniff(read('chat_db').subarray(0, 100)), { sqlite: true, walMode: true, pageSize: 4096 });
  assert.equal(DB.sniff(read('legacy_db')).walMode, false);
  assert.equal(DB.sniff(new Uint8Array(4)).sqlite, false);
  const { info } = fixture();
  const noise = read(info.paths.backup_encrypted + '/' + DB.backupPaths.messages);
  assert.equal(DB.sniff(noise).sqlite, false);
  let error = await rejects(DB.openDatabase({ db: noise }), 'not_sqlite');
  assert.match(error.message, /ENCRYPTED iPhone backup/);
  assert.match(error.message, /Encrypt local backup/);
  assert.match(error.message, /Threadback/);
  await rejects(DB.openDatabase({ db: new Uint8Array(0) }), 'empty');
  await rejects(DB.openDatabase({}), 'empty');
  const broken = read('chat_db').slice(0, 5000);
  broken.fill(7, 100);
  error = await rejects(DB.openDatabase({ db: broken }), 'corrupt');
  assert.match(error.message, /could not read this database/);

  assert.equal(DB.precheck(1000, read('chat_db').subarray(0, 16)), null);
  assert.equal(DB.precheck(1000), null);
  assert.equal(DB.precheck(0).code, 'empty');
  assert.equal(DB.precheck(5000, noise.subarray(0, 16)).code, 'not_sqlite');
  const big = DB.precheck(DB.MAX_DB_BYTES + 1, read('chat_db').subarray(0, 16));
  assert.equal(big.code, 'too_large');
  assert.match(big.message, /900 MB/);
  assert.match(big.message, /command-line tool/);
  assert.equal(DB.precheck(DB.MAX_DB_BYTES, null), null);
  assert.equal(DB.MAX_DB_BYTES, 900 * 1024 * 1024);
});

test('kind of database', async () => {
  const mac = await openMac();
  assert.equal(DB.kind(mac), 'messages');
  mac.close();
  for (const [key, kind] of [['backup_address_book', 'contacts'], ['address_books', null]]) {
    if (kind) {
      const handle = await DB.openDatabase({ db: read(key) });
      assert.equal(DB.kind(handle), kind);
      assert.throws(() => DB.listGroupChats(handle), (e) => e.code === 'schema' && /not a Messages database/.test(e.message));
      handle.close();
    }
  }
  const manifest = await DB.openDatabase({ db: read(fixture().info.paths.backup + '/Manifest.db') });
  assert.equal(DB.kind(manifest), 'manifest');
  assert.throws(() => DB.loadContacts(manifest), (e) => e.code === 'contacts_schema');
  manifest.close();
});

// ---- chats --------------------------------------------------------------------

test('chat list: only groups, merged rows, names, diagnostics', async () => {
  const { info } = fixture();
  const handle = await openMac();
  const contacts = await macContacts();
  const listing = DB.listGroupChats(handle, { contacts });
  const chats = listing.chats;
  assert.equal(chats.length, 4);
  assert.deepEqual(listing.warnings, []);
  assert.equal(listing.diagnostics.chats, 7);
  assert.equal(listing.diagnostics.group_chats, 4);
  assert.ok(listing.diagnostics.messages > 7000);
  assert.match(listing.diagnostics.first_date, /^2025-10-\d\d$/);
  assert.ok(listing.diagnostics.first_unix < listing.diagnostics.last_unix);
  assert.equal(listing.diagnostics.bytes, handle.info.bytes);
  const lively = chats[0];
  assert.equal(lively.name, 'Taco Tuesday Crew \u{1F32E}');
  assert.deepEqual(lively.chat_ids, [info.chats.lively.rowid, info.chats.lively_sms.rowid]);
  assert.equal(lively.chat_identifier, 'chat100000000000000001');
  assert.equal(lively.members, 7);
  // 87 characters: cut at 80
  assert.equal(chats[1].name, Array.from(info.chats.stress.display_name).slice(0, 80).join('') + '\u2026');
  assert.equal(chats[2].name, 'Bram, Sam, \u20260007 & 1 more');
  assert.equal(chats[2].display_name, '');
  assert.equal(chats[3].name, 'Book Club \u{1F4DA}');
  assert.deepEqual(chats[3].participants, ['+15550100011', 'nora.quill@example.com', '+15550100012']);
  assert.equal(chats[3].members, 3);
  const counts = chats.map((c) => c.messages);
  assert.deepEqual(counts, counts.slice().sort((a, b) => b - a));
  for (const chat of chats) {
    assert.ok(![info.chats.dm_ines.rowid, info.chats.dm_bram.rowid].includes(chat.id));
  }
  const raw = DB.listGroupChats(handle, {}).chats;
  assert.equal(raw[2].name, '\u20260002, \u20260003, \u20260007 & 1 more');
  assert.equal(raw[3].members, 4);

  const tiny = chats[3];
  assert.equal(DB.findChat(chats, tiny.id), tiny);
  assert.equal(DB.findChat(chats, String(tiny.id)), tiny);
  assert.equal(DB.findChat(chats, 'book club'), tiny);
  assert.equal(DB.findChat(chats, tiny.chat_identifier), tiny);
  assert.equal(DB.findChat(chats, tiny.guid), tiny);
  assert.equal(DB.findChat(chats, info.chats.lively_sms.rowid), lively);
  assert.equal(DB.findChat(chats, tiny), tiny);
  assert.throws(() => DB.findChat(chats, 'no such chat'), (e) => e.code === 'no_chat');
  assert.throws(() => DB.findChat(chats, 'o'), (e) => e.code === 'ambiguous_chat' && e.matches.length > 1);
  handle.close();
});

test('rows have the documented shape', async () => {
  const handle = await openMac();
  const chats = DB.listGroupChats(handle, {}).chats;
  const loaded = DB.loadChat(handle, DB.findChat(chats, 'Book Club'));
  assert.equal(loaded.chat_name, 'Book Club \u{1F4DA}');
  assert.equal(loaded.participants.length, 3);
  const rows = loaded.rows;
  assert.deepEqual(Object.keys(rows[0]), ['rowid', 'guid', 'date', 'is_from_me', 'handle', 'text',
    'attributedBody', 'cache_has_attachments', 'item_type', 'associated_message_type', 'associated_message_guid']);
  assert.equal(new Set(rows.map((r) => r.rowid)).size, rows.length);
  assert.deepEqual(rows.map((r) => r.rowid), rows.map((r) => r.rowid).slice().sort((a, b) => a - b));
  assert.ok(rows.every((r) => r.date === null || /^[0-9]+$/.test(r.date)));       // exact, as text
  assert.ok(rows.some((r) => r.date.length === 18 && r.date.endsWith('999999999')));
  // text arrives decoded (from message.text or, when that is empty, attributedBody)
  assert.ok(rows.every((r) => r.attributedBody === null));
  assert.ok(rows.every((r) => r.text === null || typeof r.text === 'string'));
  const m11 = rows.find((r) => r.rowid === fixture().info.tiny.M11.rowid);
  assert.ok(m11.text.startsWith('Zo') && m11.text.endsWith('vu or not.') && m11.text.length > 280);
  assert.equal(handle.query('SELECT text FROM message WHERE ROWID = ?', [m11.rowid])[0].text, null);
  // invalid UTF-8 and an embedded NUL are read from the raw bytes
  const unnamed = DB.loadChat(handle, DB.findChat(chats, '\u20260002, \u20260003')).rows;
  const bad = unnamed.filter((r) => r.text && r.text.startsWith('bad '));
  assert.deepEqual(bad.map((r) => r.text), ['bad ' + String.fromCharCode(0xFFFD, 0xFFFD) + ' bytes in a text column']);
  assert.equal(Engine.computeStats(bad, { tz: 'UTC', all_time: true, now: NOW }).totals.words, 6);
  const lively = DB.loadChat(handle, chats[0]).rows;
  const nul = lively.filter((r) => r.text && r.text.indexOf(String.fromCharCode(0)) !== -1);
  assert.deepEqual(nul.map((r) => r.text), ['nul' + String.fromCharCode(0) + 'inside the text']);
  assert.equal(Engine.computeStats(nul, { tz: 'UTC', all_time: true, now: NOW }).totals.words, 3);
  handle.close();
});

// ---- the hand-computed tiny chat -------------------------------------------------

test('hand-computed cases through the database layer', async () => {
  const handle = await openMac();
  const contacts = await macContacts();
  for (const item of EXPECTED.cases) {
    const options = Object.assign({ now: EXPECTED.now, contacts: item.contacts ? contacts : null }, item.options);
    const got = DB.statsForChat(handle, EXPECTED.chat, options);
    if (item.stats) {
      assert.deepEqual(got, item.stats, item.name);
      assert.equal(JSON.stringify(got), JSON.stringify(item.stats), item.name);
    } else {
      assert.deepEqual(subsetMismatches(item.partial, got), [], item.name);
    }
  }
  handle.close();
});

test('database without associated_message_emoji; legacy schema', async () => {
  const contacts = await macContacts();
  const noEmoji = await DB.openDatabase({ db: read('noemoji_db') });
  assert.ok(!noEmoji.columns('message').has('associated_message_emoji'));
  const first = EXPECTED.cases[0];
  assert.deepEqual(DB.statsForChat(noEmoji, 'Book Club', Object.assign({ now: NOW, contacts }, first.options)), first.stats);
  noEmoji.close();
  const legacy = await DB.openDatabase({ db: read('legacy_db') });
  assert.deepEqual(legacy.warnings, []);
  const listing = DB.listGroupChats(legacy, {});
  assert.deepEqual(listing.chats.map((c) => [c.name, c.messages]), [['Old Friends', 5]]);
  assert.equal(listing.diagnostics.first_date, '2016-06-01');
  const st = DB.statsForChat(legacy, 'Old Friends', { year: 2016, tz: 'UTC', now: NOW });
  assert.deepEqual(st.totals, { messages: 4, words: 8, attachments: 1, reactions: 0, days_active: 2, longest_streak: 2 });
  assert.deepEqual(st.senders.map((s) => s.name), ['\u20260001', 'Me', '\u20260002']);
  legacy.close();
});

// ---- iPhone backups and contacts --------------------------------------------------

test('backup paths are the documented SHA-1 names', () => {
  const sha1 = (text) => crypto.createHash('sha1').update(text).digest('hex');
  assert.equal(DB.SMS_DB_ID, sha1('HomeDomain-Library/SMS/sms.db'));
  assert.equal(DB.SMS_WAL_ID, sha1('HomeDomain-Library/SMS/sms.db-wal'));
  assert.equal(DB.ADDRESS_BOOK_ID, sha1('HomeDomain-Library/AddressBook/AddressBook.sqlitedb'));
  assert.deepEqual(DB.backupPaths, {
    messages: '3d/3d0d7e5fb2ce288813306e4d4636395e047a3d28',
    messagesWal: 'cd/cd47480f213dba9bc38ee792775d17e3f5a73a59',
    contacts: '31/31bb7ba8914766d4ba40d6dfb6113c8b614be442',
    manifest: 'Manifest.db', manifestPlist: 'Manifest.plist'
  });
});

test('picking files out of a backup folder, and the same stats from it', async () => {
  const { dir, info } = fixture();
  const first = EXPECTED.cases[0];
  const expected = JSON.parse(JSON.stringify(first.stats));
  expected.meta.source = 'sms.db';
  for (const key of ['backup', 'backup_wal']) {
    const root = path.join(dir, ...info.paths[key].split('/'));
    const files = walk(root, info.paths[key]);          // paths relative to the fixture folder
    const picked = DB.pickBackupFiles(files);
    assert.equal(picked.kind, 'backup');
    assert.ok(picked.messages.endsWith(DB.backupPaths.messages));
    assert.equal(picked.contacts.length, 1);
    assert.ok(picked.contacts[0].endsWith(DB.backupPaths.contacts));
    assert.ok(picked.manifest.endsWith('Manifest.db'));
    assert.ok(picked.manifestPlist.endsWith('Manifest.plist'));
    assert.equal(picked.messagesWal !== null, key === 'backup_wal');
    const bytes = (relative) => new Uint8Array(fs.readFileSync(path.join(dir, ...relative.split('/'))));
    const handle = await DB.openDatabase({
      db: bytes(picked.messages), wal: picked.messagesWal ? bytes(picked.messagesWal) : undefined
    });
    assert.deepEqual(handle.warnings.map((w) => w.code), key === 'backup' ? ['wal_missing'] : []);
    const book = await DB.openDatabase({ db: bytes(picked.contacts[0]) });
    const contacts = DB.loadContacts(book);
    book.close();
    const got = DB.statsForChat(handle, 'Book Club', Object.assign({ now: NOW, contacts, source: 'sms.db' }, first.options));
    assert.deepEqual(got, expected, key);
    assert.equal(DB.listGroupChats(handle, { contacts }).chats.length, 4);
    handle.close();
  }
});

test('pickBackupFiles with File-like objects and other selections', () => {
  const file = (relative) => ({ name: relative.split('/').pop(), webkitRelativePath: relative, size: 1 });
  let picked = DB.pickBackupFiles([file('00008030/Info.plist'), file('00008030/Manifest.plist'),
    file('00008030/Manifest.db'), file('00008030/3d/' + DB.SMS_DB_ID), file('00008030/31/' + DB.ADDRESS_BOOK_ID),
    file('00008030/cd/' + DB.SMS_WAL_ID), file('00008030/aa/aa' + '0'.repeat(38))]);
  assert.equal(picked.kind, 'backup');
  assert.equal(picked.messages.name, DB.SMS_DB_ID);
  assert.equal(picked.messagesWal.name, DB.SMS_WAL_ID);
  assert.equal(picked.contacts[0].name, DB.ADDRESS_BOOK_ID);
  assert.equal(picked.others.length, 2);
  picked = DB.pickBackupFiles([{ name: DB.SMS_DB_ID.toUpperCase() }]);      // a single dragged file
  assert.equal(picked.kind, 'backup');
  picked = DB.pickBackupFiles(['C:\\Users\\me\\Apple\\MobileSync\\Backup\\0000\\3d\\' + DB.SMS_DB_ID]);
  assert.equal(picked.kind, 'backup');
  picked = DB.pickBackupFiles([file('Messages/chat.db-shm'), file('Messages/chat.db-wal'), file('Messages/chat.db'),
    file('AddressBook/AddressBook-v22.abcddb'), file('AddressBook/Sources/X/AddressBook-v22.abcddb'), file('Messages/.DS_Store')]);
  assert.equal(picked.kind, 'mac');
  assert.equal(picked.messages.name, 'chat.db');
  assert.equal(picked.messagesWal.name, 'chat.db-wal');
  assert.equal(picked.contacts.length, 2);
  assert.deepEqual(picked.others, []);
  picked = DB.pickBackupFiles([file('Desktop/copy of messages.sqlite'), file('Desktop/copy of messages.sqlite-wal')]);
  assert.equal(picked.kind, 'file');
  assert.equal(picked.messages.name, 'copy of messages.sqlite');
  assert.equal(picked.messagesWal.name, 'copy of messages.sqlite-wal');
  picked = DB.pickBackupFiles([file('00008030/Manifest.plist'), file('00008030/ab/abcdef')]);
  assert.equal(picked.kind, 'backup');
  assert.equal(picked.messages, null);
  assert.equal(DB.pickBackupFiles([]).kind, 'none');
  assert.equal(DB.pickBackupFiles(null).kind, 'none');
  assert.equal(DB.pickBackupFiles([file('a.txt'), file('b.txt')]).kind, 'none');
});

test('contacts: Mac address books and the iPhone address book agree', async () => {
  const mac = await macContacts();
  const names = new Map(mac);
  assert.equal(names.get('(555) 010-0001'), 'Ines Calloway');
  assert.equal(names.get('Ines.Calloway@Example.com'), 'Ines Calloway');
  assert.equal(names.get('+1 (555) 010-0005'), 'Zo\u00eb M\u00fcller');
  assert.equal(names.get('555-010-0099'), 'Pizza Planet');
  assert.equal(names.get('555-010-0098'), 'Coach');
  assert.equal(names.get('SOLO@EXAMPLE.COM'), 'Solo');
  assert.ok(!names.has('555-010-0097'));
  const book = await DB.openDatabase({ db: read('backup_address_book') });
  const ios = new Map(DB.loadContacts(book));
  book.close();
  assert.deepEqual(Array.from(ios.entries()).sort(), Array.from(names.entries()).sort());
});

// ---- packaging --------------------------------------------------------------------

test('vendored libraries match the npm packages', (t) => {
  let dist;
  try { dist = path.dirname(require.resolve('sql.js/dist/sql-wasm.js')); } catch (error) { dist = null; }
  if (!dist) { t.skip('sql.js is not installed (run npm ci at the repository root)'); return; }
  const version = JSON.parse(fs.readFileSync(path.join(dist, '..', 'package.json'), 'utf8')).version;
  assert.equal(version, '1.13.0');
  for (const name of ['sql-wasm.js', 'sql-wasm.wasm']) {
    assert.ok(fs.readFileSync(path.join(ROOT, 'web', 'make', 'vendor', name))
      .equals(fs.readFileSync(path.join(dist, name))), name + ' differs from node_modules/sql.js/dist');
  }
});

test('the page scripts are classic scripts with no network access', () => {
  for (const name of ['engine.js', 'db.js']) {
    const source = fs.readFileSync(path.join(ROOT, 'web', 'make', name), 'utf8');
    assert.ok(!/^\s*(import|export)\s/m.test(source), name + ' must not be an ES module');
    assert.ok(!/\bfetch\s*\(|XMLHttpRequest|WebSocket|sendBeacon|https?:\/\/(?!averyhsu\.github\.io)/.test(source),
      name + ' must not talk to the network');
    assert.ok(/^[\x00-\x7e]*$/.test(source), name + ' must be plain ASCII (escape everything else)');
  }
  // both attach to a browser-like global when there is no module system
  const vm = require('vm');
  const sandbox = { TextDecoder, TextEncoder, Intl, console };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  for (const name of ['js/vendor/fflate.min.js', 'make/engine.js', 'make/db.js']) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, 'web', name), 'utf8'), sandbox, { filename: name });
  }
  assert.equal(typeof sandbox.WrappedEngine.computeStats, 'function');
  assert.equal(typeof sandbox.WrappedDB.openDatabase, 'function');
  assert.equal(typeof sandbox.fflate.deflateSync, 'function');
  const stats = sandbox.WrappedEngine.computeStats([], { tz: 'UTC', now: NOW });
  assert.deepEqual(sandbox.WrappedEngine.statsFromUrl(sandbox.WrappedEngine.buildLink(stats)).totals, stats.totals);
});
