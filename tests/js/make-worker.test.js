'use strict';
// web/make/worker.js driven from Node: the parts that need no SQLite (pasted exports, the
// sample, renaming and merging people, masking). The database path is covered in a real
// browser by tests/e2e/make/.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const MAKE = path.join(__dirname, '../../web/make');
const Engine = require('../../web/make/engine.js');
const Import = require('../../web/make/import-rows.js');

/** Load worker.js the way a browser would, with a stand-in for the worker global. */
function startWorker() {
  const sent = [];
  const waiting = new Map();
  const network = () => { throw new Error('the worker tried to use the network'); };
  const self = Object.assign({}, {
    console, TextEncoder, TextDecoder, Intl, Date, Map, Set, Promise, Uint8Array, Float64Array, Int16Array, ArrayBuffer, setTimeout,
    MAKE_BASE: 'https://example.invalid/make/',
    fetch: network,
    WebSocket: function WebSocket() { network(); },
    postMessage(message) {
      sent.push(message);
      const entry = waiting.get(message.id);
      if (!entry || message.type === 'progress') return;
      waiting.delete(message.id);
      // a round trip through JSON, like the structured clone between a worker and its page
      if (message.type === 'done') entry.resolve(JSON.parse(JSON.stringify(message.result)));
      else entry.reject(Object.assign(new Error(message.message), { code: message.code, detail: message.detail }));
    },
    XMLHttpRequest: function XMLHttpRequest() { network(); },
    EventSource: function EventSource() { network(); },
    navigator: Object.create({ sendBeacon: network }),
  });
  const context = vm.createContext(self);
  self.self = self;
  self.globalThis = self;
  const imported = [];
  self.importScripts = (...files) => {
    for (const file of files) {
      imported.push(file);
      assert.ok(file.startsWith(self.MAKE_BASE), `${file} is loaded by its full address (a blob worker has none of its own)`);
      const name = file.slice(self.MAKE_BASE.length);
      if (name === 'vendor/sql-wasm.js') { self.initSqlJs = () => Promise.reject(new Error('no SQLite in this test')); continue; }
      vm.runInContext(fs.readFileSync(path.join(MAKE, name), 'utf8'), context, { filename: name });
    }
  };
  vm.runInContext(fs.readFileSync(path.join(MAKE, 'worker.js'), 'utf8'), context, { filename: 'worker.js' });
  let next = 1;
  return {
    self,
    sent,
    imported,
    ask(type, fields) {
      return new Promise((resolve, reject) => {
        const id = next++;
        waiting.set(id, { resolve, reject });
        self.onmessage({ data: Object.assign({ id, type }, fields) });
      });
    },
  };
}

const LINES = [
  ['2026-03-01T10:00:00Z', '+1 (555) 010-0001', 'first number, written one way'],
  ['2026-03-01T10:01:00Z', '+15550100001', 'the same number, written another way'],
  ['2026-03-01T10:02:00Z', '+1 555 999 0001', 'another number that ends the same'],
  ['2026-03-01T10:03:00Z', 'Maya', 'hello from Maya'],
  ['2026-03-01T10:04:00Z', 'Dev', 'hello from Dev'],
  ['2026-03-01T10:05:00Z', 'pat.lastname@example.com', 'hello from an address'],
  ['2026-03-01T10:06:00Z', '', 'that one was me'],
  ['2026-03-02T10:06:00Z', 'Maya', 'and Maya again'],
  ['2026-03-02T23:30:00Z', '+1 555 999 0001', 'late one'],
];
const EXPORT = LINES.map(([date, sender, text]) => JSON.stringify({ date, sender, text })).join('\n');
const OPTIONS = { tz: 'UTC', all_time: true, now: Date.UTC(2026, 10, 11, 20) / 1000 };
const RAW = ['5550100001', '5559990001', '555) 010', '555 999', 'example.com', 'pat.lastname@'];

const senders = (stats) => Object.fromEntries(stats.senders.map((s) => [s.name, s.messages]));

test('a pasted export: people are listed once each, unnamed ones by their raw handle', async () => {
  const worker = startWorker();
  const result = await worker.ask('paste', { text: EXPORT, tz: 'UTC' });
  assert.equal(result.format, 'jsonl');
  assert.equal(result.summary.messages, 9);
  assert.equal(result.rows, 9);
  const people = result.people;
  assert.deepStrictEqual(people[0], { key: 'me', name: 'Me', named: true, handles: [], messages: 1, me: true });
  const byKey = Object.fromEntries(people.map((p) => [p.key, p]));
  // the same number written two ways is one person; a different number is another
  assert.deepStrictEqual(byKey['h:p:5550100001'], {
    key: 'h:p:5550100001', name: '…0001', named: false, handles: ['+1 (555) 010-0001', '+15550100001'], messages: 2, me: false,
  });
  assert.deepStrictEqual(byKey['h:p:5559990001'], {
    key: 'h:p:5559990001', name: '…0001', named: false, handles: ['+1 555 999 0001'], messages: 2, me: false,
  });
  assert.equal(byKey['h:e:pat.lastname@example.com'].name, 'pat.lastname');
  assert.equal(byKey['h:e:pat.lastname@example.com'].named, false);
  assert.deepStrictEqual(byKey['n:Maya'], { key: 'n:Maya', name: 'Maya', named: true, handles: [], messages: 2, me: false });
  assert.equal(people.length, 6);
  // an export has no chat name: it is built from the busiest people, masked like everywhere else
  assert.equal(result.chat_name, '…0001, Maya, Dev & 1 more');
  assert.equal(result.named, false);
  assert.ok(worker.sent.some((m) => m.type === 'progress' && m.stage === 'parse'), 'reports progress');
});

test('with no renames the worker gives exactly what the engine gives', async () => {
  const worker = startWorker();
  await worker.ask('paste', { text: EXPORT, tz: 'UTC' });
  const { stats } = await worker.ask('compute', { options: OPTIONS });
  const rows = Import.parseExport(EXPORT, { tz: 'UTC' }).rows;
  const counts = new Map();
  rows.forEach((r) => { if (!r.is_from_me && r.handle) counts.set(r.handle, (counts.get(r.handle) || 0) + 1); });
  const participants = [...counts.keys()].sort((a, b) => (counts.get(b) - counts.get(a)) || (a < b ? -1 : a > b ? 1 : 0));
  const expected = Engine.computeStats(rows, Object.assign({ source: 'export', chat_name: '', participants }, OPTIONS));
  assert.equal(JSON.stringify(stats), JSON.stringify(expected));
  // by default the two numbers ending in 0001 are one sender, as SCHEMA.md §2 says
  assert.deepStrictEqual(senders(stats), { '…0001': 4, Maya: 2, Dev: 1, Me: 1, 'pat.lastname': 1 });
  const json = JSON.stringify(stats);
  for (const raw of RAW) assert.ok(!json.includes(raw), `no raw handle (${raw}) in the stats`);
});

test('renaming tells two people with the same last digits apart, and totals never move', async () => {
  const worker = startWorker();
  await worker.ask('paste', { text: EXPORT, tz: 'UTC' });
  const base = (await worker.ask('compute', { options: OPTIONS })).stats;

  const named = (await worker.ask('compute', {
    options: Object.assign({ names: { 'h:p:5550100001': 'Ines', 'h:p:5559990001': 'Bram' } }, OPTIONS),
  })).stats;
  assert.deepStrictEqual(senders(named), { Ines: 2, Bram: 2, Maya: 2, Dev: 1, Me: 1, 'pat.lastname': 1 });
  assert.deepStrictEqual(named.totals, base.totals);
  assert.equal(named.chat.members, base.chat.members + 1, 'one more distinct person');
  assert.equal(named.late_night.top, null);

  // giving two people the same name merges them; giving someone the owner's name merges with the owner
  const merged = (await worker.ask('compute', {
    options: Object.assign({ me: 'Amara', names: { 'n:Maya': 'Dev', 'h:e:pat.lastname@example.com': ' Amara ' } }, OPTIONS),
  })).stats;
  assert.deepStrictEqual(senders(merged), { '…0001': 4, Dev: 3, Amara: 2 });
  assert.deepStrictEqual(merged.totals, base.totals);
  assert.equal(merged.senders.reduce((sum, s) => sum + s.messages, 0), merged.totals.messages);
  assert.equal(merged.chat.members, 3);
  assert.equal(merged.chat.name, '…0001, Dev');

  // an empty or blank name falls back to the default
  const blank = (await worker.ask('compute', { options: Object.assign({ names: { 'n:Maya': '   ' } }, OPTIONS) })).stats;
  assert.equal(JSON.stringify(blank), JSON.stringify(base));
});

test('a phone number or address typed as a name is masked like any other', async () => {
  const worker = startWorker();
  await worker.ask('paste', { text: EXPORT, tz: 'UTC' });
  const { stats } = await worker.ask('compute', {
    options: Object.assign({ names: { 'n:Maya': '+1 (555) 010-7777', 'n:Dev': 'dev.person@example.org' } }, OPTIONS),
  });
  const names = Object.keys(senders(stats));
  assert.ok(names.includes('…7777') && names.includes('dev.person'), names.join(', '));
  const json = JSON.stringify(stats);
  assert.ok(!json.includes('010-7777') && !json.includes('example.org'));
});

test('the chat name can be set, and an unnamed chat is named after its (renamed) members', async () => {
  const worker = startWorker();
  await worker.ask('paste', { text: EXPORT, tz: 'UTC' });
  const titled = (await worker.ask('compute', { options: Object.assign({ chat_name: 'Sunday Group' }, OPTIONS) })).stats;
  assert.equal(titled.chat.name, 'Sunday Group');
  const renamed = (await worker.ask('compute', { options: Object.assign({ names: { 'h:p:5559990001': 'Zed Example' } }, OPTIONS) })).stats;
  assert.equal(renamed.chat.name, 'Zed, Maya, …0001 & 2 more');
});

test('a new time zone re-reads zone-less dates', async () => {
  const worker = startWorker();
  const text = '#dates\n2026-03-01 23:30\n2026-03-02 00:30\n#senders\nMaya\nDev\n';
  await worker.ask('paste', { text, tz: 'UTC' });
  const utc = (await worker.ask('compute', { options: { tz: 'UTC', all_time: true } })).stats;
  const tokyo = (await worker.ask('compute', { options: { tz: 'Asia/Tokyo', all_time: true } })).stats;
  assert.equal(utc.by_hour[23], 1);
  assert.equal(tokyo.by_hour[23], 1, 'the wall-clock hour stays what the export says');
  assert.equal(tokyo.period.start, '2026-03-01');
});

test('errors are coded, and nothing unreadable is kept', async () => {
  const worker = startWorker();
  await assert.rejects(worker.ask('paste', { text: 'just some words\nwith no dates', tz: 'UTC' }), (error) => {
    assert.equal(error.code, 'paste_empty');
    assert.ok(Array.isArray(error.detail.warnings) && error.detail.warnings.length > 0);
    return true;
  });
  await assert.rejects(worker.ask('compute', { options: OPTIONS }), { code: 'no_rows' });
  await worker.ask('paste', { text: EXPORT, tz: 'UTC' });
  await assert.rejects(worker.ask('compute', { options: { tz: 'Not/AZone', all_time: true } }), { code: 'range' });
  await assert.rejects(worker.ask('compute', { options: { tz: 'UTC', start: '2026-05-01', end: '2026-04-01' } }), { code: 'range' });
  await assert.rejects(worker.ask('nonsense', {}), { code: 'unknown_request' });
  // Contact names can only be added to a database that is open (a pasted export has none).
  await assert.rejects(worker.ask('contacts', { contacts: [] }), { code: 'no_chat' });
});

test('people called constructor, toString or __proto__ are counted like anyone else', async () => {
  const worker = startWorker();
  const names = ['constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf'];
  const lines = names.concat(names, ['constructor', '']).map((sender, i) => JSON.stringify({ date: `2026-03-0${1 + (i % 9)}T12:0${i % 10}:00Z`, sender, text: 'an invented line' }));
  const pasted = await worker.ask('paste', { text: lines.join('\n'), tz: 'UTC' });
  assert.deepStrictEqual(pasted.people.filter((p) => !p.me).map((p) => p.name).sort(), names.slice().sort());
  assert.ok(pasted.people.every((p) => p.me || (p.named && p.key === 'n:' + p.name)), 'each under a key that no object has by itself');
  // (Pairs, not an object: this test must not trip over the very thing it is about.)
  const counted = (stats) => stats.senders.map((s) => s.name + ' ' + s.messages).sort();
  let { stats } = await worker.ask('compute', { options: OPTIONS });
  assert.deepStrictEqual(counted(stats), ['Me 1', '__proto__ 2', 'constructor 3', 'hasOwnProperty 2', 'toString 2', 'valueOf 2']);
  // Renamed to one another, and the owner called one of them too.
  ({ stats } = await worker.ask('compute', { options: { ...OPTIONS, me: 'valueOf', names: { 'n:constructor': '__proto__', 'n:toString': 'constructor' } } }));
  assert.deepStrictEqual(counted(stats), ['__proto__ 5', 'constructor 2', 'hasOwnProperty 2', 'valueOf 3']);
  assert.equal(stats.totals.messages, 12);
});

test('the sample request, and the worker cutting its own network access', async () => {
  const worker = startWorker();
  assert.deepStrictEqual(worker.imported.map((file) => file.replace(worker.self.MAKE_BASE, '')),
    ['engine.js', 'vendor/sql-wasm.js', 'db.js', 'import-rows.js', 'sample.js'], 'the worker loads its parts by full address');
  assert.equal(JSON.stringify(worker.sent[0]), '{"type":"hello"}', 'and says hello once it is ready');
  assert.equal(typeof worker.self.fetch, 'function');
  const result = await worker.ask('sample', {});
  assert.equal(result.named, true);
  assert.match(result.owner, /^[A-Z][a-z]+$/, 'the sample names its owner');
  assert.equal(result.people.length, 7);
  assert.ok(result.people.every((p) => p.named && p.handles.length === 0));
  assert.ok(result.rows > 2500);
  for (const name of ['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'importScripts']) {
    assert.equal(worker.self[name], undefined, `${name} is gone before any data is touched`);
  }
  // ... and for good. (That the prototypes behind a real worker's global are emptied too is
  // checked in a real browser, in tests/e2e/make: a vm context has no such chain to walk.)
  assert.equal(Object.getPrototypeOf(worker.self.navigator).sendBeacon, undefined, 'navigator.sendBeacon is gone');
  assert.throws(() => { worker.self.fetch = () => 'back'; }, TypeError, 'and it cannot be put back');
  assert.throws(() => { delete worker.self.fetch; }, TypeError, 'nor can the pin be removed');
  assert.equal(worker.self.fetch, undefined);
  const { stats } = await worker.ask('compute', { options: { tz: 'UTC', year: result.year } });
  assert.equal(stats.meta.source, 'sample');
  assert.equal(stats.period.label, String(result.year));
  assert.equal(stats.chat.members, 7);
  assert.ok(stats.totals.messages > 500, `messages: ${stats.totals.messages}`);
});
