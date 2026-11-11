/*
 * Shared helpers for the JavaScript engine tests (node --test tests/engine-js/).
 *
 * The invented fixture databases are generated with the Python builder into a
 * temporary folder, or reused from WRAPPED_FIXTURE_DIR when it already holds
 * one. Python 3.9+ must be on PATH (or $PYTHON).
 */
'use strict';

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

const EXPECTED = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests', 'conformance', 'expected_tiny.json'), 'utf8'));
const VECTOR = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests', 'vectors', 'payload-v1.json'), 'utf8'));

module.exports = {
  ROOT, PYTHON, Engine, DB, LA, APPLE_EPOCH, EXPECTED, VECTOR, python, fixture, read, tempDir,
  macContacts, openMac, utc, ns, msg, tap, hexToBytes, bytes, subsetMismatches
};
