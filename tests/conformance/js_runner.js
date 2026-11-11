/*
 * Runs the JavaScript engine over a job description and prints the results
 * as JSON. tests/conformance/test_conformance.py runs the same job through the
 * Python engine and requires the two outputs to be identical.
 *
 *   node tests/conformance/js_runner.js JOB.json > RESULT.json
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const Engine = require(path.join(ROOT, 'web', 'make', 'engine.js'));
const DB = require(path.join(ROOT, 'web', 'make', 'db.js'));
const I = Engine._internals;

const job = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const fixture = job.fixture;

function read(relative) {
  return new Uint8Array(fs.readFileSync(path.join(fixture, relative)));
}

function hex(text) {
  return new Uint8Array(Buffer.from(text, 'hex'));
}

async function openSource(spec) {
  const handle = await DB.openDatabase({ db: read(spec.db), wal: spec.wal ? read(spec.wal) : undefined });
  let contacts = [];
  for (const book of spec.contacts || []) {
    const bookHandle = await DB.openDatabase({ db: read(book) });
    contacts = contacts.concat(DB.loadContacts(bookHandle));
    bookHandle.close();
  }
  return { handle, contacts, kind: spec.kind };
}

function linkLengths(stats, quotes) {
  const copy = JSON.parse(JSON.stringify(stats));
  if (!quotes) Engine.stripQuotes(copy);
  const lengths = [(Engine.BASE_URL + '#w1=' + Engine.encodePayload(copy)).length];
  for (let step = 1; step <= Engine.TRIM_STEPS; step++) {
    Engine.applyTrimStep(copy, step);
    lengths.push((Engine.BASE_URL + '#w1=' + Engine.encodePayload(copy)).length);
  }
  return lengths;
}

async function main() {
  const out = {};

  // ---- stats ------------------------------------------------------------
  const sources = {};
  for (const spec of job.sources) sources[spec.id] = await openSource(spec);
  out.chats = {};
  out.diagnostics = {};
  for (const id of Object.keys(sources)) {
    const source = sources[id];
    for (const withContacts of [true, false]) {
      const listing = DB.listGroupChats(source.handle, { contacts: withContacts ? source.contacts : null });
      out.chats[id + (withContacts ? '+contacts' : '')] = listing.chats;
      out.diagnostics[id] = listing.diagnostics;
    }
    out.contacts = out.contacts || {};
    out.contacts[id] = source.contacts;
  }
  out.stats = {};
  for (const item of job.stats) {
    const source = sources[item.source];
    const options = Object.assign({}, item.options, {
      contacts: item.contacts ? source.contacts : null, source: source.kind
    });
    out.stats[item.id] = Engine.canonicalJson(DB.statsForChat(source.handle, item.chat, options));
  }

  // ---- small pure functions --------------------------------------------
  out.decode = job.decode.map((h) => I.decodeWithStrategy(hex(h)));
  out.texts = job.texts.map((t) => [Engine.cleanText(t), Engine.countWords(Engine.cleanText(t)),
    I.truncate(t, 10)]);
  out.identifiers = job.identifiers.map((s) => Engine.contactKey(s));
  out.names = job.names.map((n) => Engine.chatDisplayName(n[0], n[1], n[2], n[3]));
  out.round4 = job.round4.map((p) => I.round4(p[0], p[1]));
  out.dates = job.dates.map((d) => I.splitDate(d));
  out.zones = {};
  for (const zone of job.zones.names) {
    const table = new I.Offsets(I.offsetFunction(zone), job.zones.lo, job.zones.hi);
    out.zones[zone] = [table.starts, table.offsets];
  }
  out.rows = job.rows.map((r) => {
    const rows = r.rows.map((row) => Object.assign({}, row,
      row.attributedBody ? { attributedBody: hex(row.attributedBody) } : {}));
    return Engine.canonicalJson(Engine.computeStats(rows, r.options));
  });

  // ---- payload and the link ladder ---------------------------------------
  out.payload = {};
  out.payload.decoded = job.payload.encoded.map((p) => Engine.canonicalJson(Engine.decodePayload(p)));
  out.payload.encoded = job.payload.objects.map((o) => Engine.encodePayload(o));
  out.payload.canonical = job.payload.objects.map((o) => Engine.canonicalJson(o));
  out.links = {};
  for (const item of job.links) {
    const stats = JSON.parse(out.stats[item.stats]);
    const entry = { lengths: linkLengths(stats, true), lengths_no_quotes: linkLengths(stats, false) };
    entry.fits = item.budgets.map((b) => {
      try {
        const r = Engine.fitLink(stats, { quotes: b.quotes, max_length: b.max_length });
        return { steps: r.steps, stats: Engine.canonicalJson(r.stats), url: r.url, length: r.length };
      } catch (error) {
        return { error: error.code || String(error) };
      }
    });
    out.links[item.stats] = entry;
  }
  if (job.vendored_fflate) {
    // the codec the browser uses must interoperate with zlib as well
    Engine.useCodec(require(path.join(ROOT, 'web', 'js', 'vendor', 'fflate.min.js')));
    out.payload.fflate_encoded = job.payload.objects.map((o) => Engine.encodePayload(o));
    out.payload.fflate_decoded = job.payload.encoded.map((p) => Engine.canonicalJson(Engine.decodePayload(p)));
    Engine.useCodec(null);
  }

  for (const id of Object.keys(sources)) sources[id].handle.close();
  process.stdout.write(JSON.stringify(out));
}

main().catch((error) => {
  process.stderr.write(String(error && error.stack || error) + '\n');
  process.exit(1);
});
