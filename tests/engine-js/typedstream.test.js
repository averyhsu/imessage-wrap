'use strict';
// attributedBody (typedstream) decoder: every length encoding and fallback.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { Engine, fixture, hexToBytes, bytes } = require('./support.js');

const I = Engine._internals;
const IMMUTABLE = '\x04\x0bstreamtyped\x81\xe8\x03\x84\x01@\x84\x84\x84\x12NSAttributedString\x00' +
  '\x84\x84\x08NSObject\x00\x85\x92\x84\x84\x84\x08NSString\x01\x94\x84\x01+';
const MUTABLE = '\x04\x0bstreamtyped\x81\xe8\x03\x84\x01@\x84\x84\x84\x19NSMutableAttributedString\x00' +
  '\x84\x84\x12NSAttributedString\x00\x84\x84\x08NSObject\x00\x85\x92\x84\x84\x84' +
  '\x0fNSMutableString\x01\x84\x84\x08NSString\x01\x95\x84\x01+';
const TAIL = '\x86\x84\x02iI\x01\x05\x92\x84\x84\x84\x0cNSDictionary\x00\x94\x84\x01i\x00\x86\x86';

function le(n, size) {
  let out = '';
  for (let i = 0; i < size; i++) { out += String.fromCharCode(n % 256); n = Math.floor(n / 256); }
  return out;
}

function check(lengthBytes, n) {
  const payload = 'abcdefghij'.repeat(Math.floor(n / 10) + 1).slice(0, n);
  for (const prefix of [IMMUTABLE, MUTABLE]) {
    const data = bytes(prefix + lengthBytes + payload + TAIL);
    assert.equal(Engine.decodeAttributedBody(data), payload);
    assert.equal(I.decodeFast(data), payload);
    assert.equal(I.decodeStructural(data), payload);
    assert.equal(I.decodeScan(data), payload);
  }
}

test('single-byte lengths', () => {
  for (const n of [0, 1, 2, 126, 127]) check(String.fromCharCode(n), n);
});

test('16-bit lengths, read as unsigned', () => {
  for (const n of [128, 129, 255, 256, 300, 2359, 32767, 32768, 40000, 65535]) check('\x81' + le(n, 2), n);
});

test('32-bit and 64-bit lengths', () => {
  for (const n of [5, 200, 32768, 65536, 70000]) check('\x82' + le(n, 4), n);
  check('\x87' + le(300, 8), 300);
});

test('length counts UTF-8 bytes, not characters', () => {
  const text = '\u{1F602}'.repeat(40);
  const raw = Buffer.from(text, 'utf8');
  assert.equal(raw.length, 160);
  const data = Buffer.concat([Buffer.from(IMMUTABLE + '\x81' + le(160, 2), 'latin1'), raw, Buffer.from(TAIL, 'latin1')]);
  assert.equal(Engine.decodeAttributedBody(new Uint8Array(data)), text);
});

test('fixture samples decode exactly, on the fast path, and all strategies agree', () => {
  const samples = fixture().info.typedstream_samples;
  assert.ok(samples.length >= 30);
  for (const sample of samples) {
    const data = hexToBytes(sample.hex);
    assert.deepEqual(I.decodeWithStrategy(data), [sample.text, 'fast'], sample.name);
    assert.equal(I.decodeStructural(data), sample.text, sample.name);
    assert.equal(I.decodeScan(data), sample.text, sample.name);
  }
});

test('accepts ArrayBuffer, typed-array views, Buffers and plain arrays', () => {
  const sample = fixture().info.typedstream_samples.find((s) => s.name === 'emoji');
  const data = hexToBytes(sample.hex);
  assert.equal(Engine.decodeAttributedBody(data.buffer.slice(data.byteOffset, data.byteOffset + data.length)), sample.text);
  assert.equal(Engine.decodeAttributedBody(Buffer.from(data)), sample.text);
  assert.equal(Engine.decodeAttributedBody(Array.from(data)), sample.text);
  const padded = new Uint8Array(data.length + 7);
  padded.set(data, 3);
  assert.equal(Engine.decodeAttributedBody(padded.subarray(3, 3 + data.length)), sample.text);
  assert.equal(Engine.decodeAttributedBody(new DataView(padded.buffer, 3, data.length)), sample.text);
});

test('an unknown class chain is walked structurally', () => {
  const data = bytes('\x04\x0bstreamtyped\x81\xe8\x03\x84\x01@\x84\x84\x84\x1aNSConcreteAttributedString' +
    '\x05\x84\x84\x12NSAttributedString\x00\x84\x84\x08NSObject\x00\x85\x92\x84\x84\x84' +
    '\x12NSBigMutableString\x02\x84\x84\x0fNSMutableString\x01\x84\x84\x08NSString\x01' +
    '\x95\x84\x01+\x0bhello world\x86');
  assert.deepEqual(I.decodeWithStrategy(data), ['hello world', 'structural']);
});

test('big-endian stream and C-string value', () => {
  const big = bytes('\x04\x0btypedstream\x81\x03\xe8\x84\x01@\x84\x84\x84\x12NSAttributedString\x00' +
    '\x84\x84\x08NSObject\x00\x85\x92\x84\x84\x84\x08NSString\x01\x94\x84\x01+\x81\x01\x2c' +
    'z'.repeat(300) + '\x86');
  assert.deepEqual(I.decodeWithStrategy(big), ['z'.repeat(300), 'structural']);
  const cstring = bytes('\x04\x0bstreamtyped\x81\xe8\x03\x84\x01@\x84\x84\x84\x08NSString\x00\x84\x84' +
    '\x08NSObject\x00\x85\x84\x01*\x84\x84\x05plain\x86');
  assert.deepEqual(I.decodeWithStrategy(cstring), ['plain', 'structural']);
});

test('scan fallback', () => {
  const broken = bytes('\x04\x0bstreamtyped\x81\xe8\x03\x00\x00junkNSString\x01\x94\x84\x01+\x05hello\x86');
  assert.deepEqual(I.decodeWithStrategy(broken), ['hello', 'scan']);
  const twice = bytes('xxNSStringxxxxxxxxxxxxxxxxxxxxxxxxNSString\x01\x95\x84\x01+\x02ok\x86');
  assert.equal(Engine.decodeAttributedBody(twice), 'ok');
});

test('invalid UTF-8 is replaced and a BOM is kept', () => {
  assert.equal(Engine.decodeAttributedBody(bytes(IMMUTABLE + '\x04a\xff\xfeb' + TAIL)), 'a\uFFFD\uFFFDb');
  assert.equal(Engine.decodeAttributedBody(bytes(IMMUTABLE + '\x06\xef\xbb\xbfbom' + TAIL)), '\uFEFFbom');
});

test('things that are not typedstreams', () => {
  for (const junk of [null, undefined, new Uint8Array(0), bytes('\x00'), bytes('bplist00\xd4\x01\x02'),
    bytes('streamtyped'), 'a string', 12345, {}]) {
    assert.deepEqual(I.decodeWithStrategy(junk), [null, 'none']);
  }
});

test('truncated blobs never throw', () => {
  for (const name of ['short', 'len300', 'short_mutable', 'len300_mutable']) {
    const sample = fixture().info.typedstream_samples.find((s) => s.name === name);
    const data = hexToBytes(sample.hex);
    const marker = Buffer.from(data).indexOf(Buffer.from('\x84\x01+', 'latin1')) + 3;
    const need = marker + (sample.text.length < 128 ? 1 : 3) + sample.text.length;
    for (let cut = 0; cut < data.length; cut++) {
      const got = Engine.decodeAttributedBody(data.subarray(0, cut));
      assert.equal(got, cut < need ? null : sample.text, name + ' cut at ' + cut);
    }
  }
});

test('real NSArchiver output (macOS CI job)', { skip: !process.env.WRAPPED_REAL_TYPEDSTREAM }, () => {
  const samples = JSON.parse(fs.readFileSync(process.env.WRAPPED_REAL_TYPEDSTREAM, 'utf8'));
  assert.ok(samples.length >= 20);
  for (const sample of samples) {
    const data = hexToBytes(sample.hex);
    assert.deepEqual(I.decodeWithStrategy(data), [sample.string, 'fast'], sample.name);
    assert.equal(I.decodeStructural(data), sample.string, sample.name);
    assert.equal(I.decodeScan(data), sample.string, sample.name);
  }
});
