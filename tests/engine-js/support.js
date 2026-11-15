/*
 * Shared helpers for the JavaScript engine tests (node --test tests/engine-js/).
 *
 * The invented fixture databases are generated with the Python builder into a
 * temporary folder, or reused from WRAPPED_FIXTURE_DIR when it already holds
 * one. Python 3.9+ must be on PATH (or $PYTHON).
 *
 * Nothing is written into the repository: everything goes to temporary
 * folders, and the Python helpers are told not to leave __pycache__ behind.
 */
'use strict';

process.env.PYTHONDONTWRITEBYTECODE = '1';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const PYTHON = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
const Engine = require(path.join(ROOT, 'web', 'make', 'engine.js'));
const DB = require(path.join(ROOT, 'web', 'make', 'db.js'));

const APPLE_EPOCH = 978307200;
const LA = 'America/Los_Angeles';
let cached = null;

function python(args, options) {
  const result = spawnSync(PYTHON, args, Object.assign({ encoding: 'utf8', maxBuffer: 1 << 28 }, options || {}));
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(PYTHON + ' ' + args.join(' ') + ' failed:\n' + result.stderr);
  return result.stdout;
}

/** {dir, info}: the generated fixture and its fixture.json. */
function fixture() {
  if (cached) return cached;
  const shared = process.env.WRAPPED_FIXTURE_DIR;
  if (shared && fs.existsSync(path.join(shared, 'fixture.json'))) {
    cached = { dir: shared, info: JSON.parse(fs.readFileSync(path.join(shared, 'fixture.json'), 'utf8')) };
    return cached;
  }
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'wrapped-fixture-js-'));
  process.on('exit', () => fs.rmSync(folder, { recursive: true, force: true }));
  const dir = path.join(folder, 'fx');
  python([path.join(ROOT, 'tests', 'fixtures', 'build_fixture.py'), dir]);
  cached = { dir, info: JSON.parse(fs.readFileSync(path.join(dir, 'fixture.json'), 'utf8')) };
  return cached;
}

/** Bytes of a fixture file, by fixture.json path key or relative path. */
function read(key) {
  const { dir, info } = fixture();
  const relative = info.paths[key] || key;
  return new Uint8Array(fs.readFileSync(path.join(dir, ...relative.split('/'))));
}

function tempDir(prefix) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  process.on('exit', () => fs.rmSync(folder, { recursive: true, force: true }));
  return folder;
}

/** Contacts from both of the fixture's Mac address books. */
async function macContacts() {
  const { info } = fixture();
  let contacts = [];
  for (const book of info.paths.address_books) {
    const handle = await DB.openDatabase({ db: read(book) });
    contacts = contacts.concat(DB.loadContacts(handle));
    handle.close();
  }
  return contacts;
}

async function openMac() {
  return DB.openDatabase({ db: read('chat_db'), wal: read('chat_db_wal') });
}

function utc(y, mo, d, h, mi, s) {
  return Date.UTC(y, mo - 1, d, h || 0, mi || 0, s || 0) / 1000;
}

/** Unix seconds (+ nanoseconds) -> raw message.date as an exact decimal string. */
function ns(unix, nanos) {
  return String(unix - APPLE_EPOCH) + String(nanos || 0).padStart(9, '0');
}

/** A minimal message row. sender: 'me' or a handle. */
function msg(unix, sender, text, extra) {
  return Object.assign({
    date: ns(unix), is_from_me: sender === 'me' || sender === undefined ? 1 : 0,
    handle: sender === 'me' || sender === undefined ? null : sender,
    text: text === undefined ? 'hello' : text
  }, extra || {});
}

/** A tapback row aimed at `target` (which needs a guid). */
function tap(unix, sender, kind, target, extra) {
  const e = Object.assign({}, extra || {});
  const prefix = e.prefix === undefined ? 'p:0/' : e.prefix;
  delete e.prefix;
  return msg(unix, sender, 'Reacted', Object.assign({
    associated_message_type: kind, associated_message_guid: prefix + target.guid
  }, e));
}

function hexToBytes(hex) {
  return new Uint8Array(Buffer.from(hex, 'hex'));
}

function bytes(text) {
  return new Uint8Array(Buffer.from(text, 'latin1'));
}

/** Paths at which `expected` (a partial tree) is not matched by `actual`. */
function subsetMismatches(expected, actual, where) {
  where = where || '';
  let problems = [];
  if (expected && typeof expected === 'object' && !Array.isArray(expected) &&
      actual && typeof actual === 'object' && !Array.isArray(actual)) {
    for (const key of Object.keys(expected)) {
      if (!(key in actual)) problems.push(where + '.' + key + ' missing');
      else problems = problems.concat(subsetMismatches(expected[key], actual[key], where + '.' + key));
    }
  } else if (JSON.stringify(expected) !== JSON.stringify(actual)) {
    problems.push(where + ': expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual));
  }
  return problems;
}

// ---- nothing private in what is shown or shared ---------------------------------

const CONTROL_RANGES = [[0x00, 0x09], [0x0B, 0x1F], [0x7F, 0x9F], [0x2028, 0x2029], [0x202A, 0x202E],
  [0x2066, 0x2069]];
const NOT_IN_AN_ADDRESS = /[\s<>()[\]"',;:@]/;

/** How many decimal digits (of any script) a string holds. */
function countDecimals(text) {
  const found = String(text).match(/\p{Nd}/gu);
  return found ? found.length : 0;
}

/**
 * What a piece of output must never contain: a run of seven or more digits
 * (in any script), an e-mail address, a control character or a direction
 * override. Returns a list of findings (empty = clean).
 */
function textLeaks(text, where) {
  where = where || 'text';
  const found = [];
  for (const match of text.matchAll(/\p{Nd}{7,}/gu)) found.push(where + ': a run of ' + Array.from(match[0]).length + ' digits');
  // a character on each side of the sign; in linear time, whatever the length
  for (let at = text.indexOf('@'); at !== -1; at = text.indexOf('@', at + 1)) {
    if (at > 0 && at < text.length - 1 && !NOT_IN_AN_ADDRESS.test(text[at - 1]) && !NOT_IN_AN_ADDRESS.test(text[at + 1])) {
      found.push(where + ': an address (' + JSON.stringify(text.slice(Math.max(0, at - 30), at + 30)) + ')');
    }
  }
  for (const ch of text) {
    const code = ch.codePointAt(0);
    if (CONTROL_RANGES.some(([low, high]) => code >= low && code <= high)) {
      found.push(where + ': control character U+' + code.toString(16).toUpperCase().padStart(4, '0'));
    }
  }
  return found;
}

/** [where, name] for the chat name and every place that names a person. */
function namesIn(stats) {
  const out = [];
  if (stats.chat && typeof stats.chat.name === 'string') out.push(['chat.name', stats.chat.name]);
  (stats.senders || []).forEach((sender, i) => out.push(['senders[' + i + '].name', sender.name]));
  if (stats.late_night && stats.late_night.top) out.push(['late_night.top.name', stats.late_night.top.name]);
  (stats.most_reacted || []).forEach((quote, i) => out.push(['most_reacted[' + i + '].sender', quote.sender]));
  for (const key of ['top_giver', 'top_receiver']) {
    if (stats.reactions && stats.reactions[key]) out.push(['reactions.' + key + '.name', stats.reactions[key].name]);
  }
  (stats.awards || []).forEach((award, i) => out.push(['awards[' + i + '].winner', award.winner]));
  return out;
}

function strings(value, where, out) {
  if (typeof value === 'string') out.push([where, value]);
  else if (Array.isArray(value)) value.forEach((item, i) => strings(item, where + '[' + i + ']', out));
  else if (value && typeof value === 'object') {
    for (const key of Object.keys(value)) {
      out.push([where + ' (key)', key]);
      strings(value[key], where + '.' + key, out);
    }
  }
  return out;
}

/**
 * Findings for a whole stats object: textLeaks() for every string in it (the
 * quoted message text aside: that is the user's own content and only goes
 * into a link when asked for), and no name in it may hold seven digits in
 * total, however they are separated ("+1 555-010-0123" has no long run but
 * is a phone number).
 */
function leaks(stats) {
  let found = [];
  for (const [where, text] of strings(stats, 'stats', [])) {
    if (!(where.startsWith('stats.most_reacted[') && where.endsWith('.text'))) found = found.concat(textLeaks(text, where));
  }
  for (const [where, name] of namesIn(stats)) {
    // a chat without a name of its own is called after its members: "Ines, Bram & 2 more"
    const parts = where === 'chat.name' ? name.split(/, | & /) : [name];
    for (const part of parts) {
      if (countDecimals(part) >= 7) found.push(where + ': ' + countDecimals(part) + ' digits in ' + JSON.stringify(part));
    }
  }
  return found;
}

/**
 * Names in a stats object that are over the caps of docs/SCHEMA.md 2: a person
 * 40 characters plus an ellipsis, a chat 80 plus an ellipsis.
 */
function tooLong(stats) {
  const found = [];
  for (const [where, name] of namesIn(stats)) {
    const length = Array.from(name).length;
    if (length > (where === 'chat.name' ? 81 : 41)) found.push(where + ': ' + length + ' characters');
  }
  if (stats.period && typeof stats.period.label === 'string' && Array.from(stats.period.label).length > 81) {
    found.push('period.label is too long');
  }
  return found;
}

const EXPECTED = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests', 'conformance', 'expected_tiny.json'), 'utf8'));
// hand-written clean / mask / short-name cases, shared with the Python tests
const NAMES = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests', 'conformance', 'names.json'), 'utf8'));
const VECTOR = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests', 'vectors', 'payload-v1.json'), 'utf8'));

module.exports = {
  ROOT, PYTHON, Engine, DB, LA, APPLE_EPOCH, EXPECTED, VECTOR, NAMES, python, fixture, read, tempDir,
  macContacts, openMac, utc, ns, msg, tap, hexToBytes, bytes, subsetMismatches, countDecimals,
  textLeaks, namesIn, leaks, tooLong
};
