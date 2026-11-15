'use strict';
// The share card is drawn on a canvas (covered end to end in tests/e2e); the one piece of
// pure logic in it is how a name is shown on something people will post publicly.
const test = require('node:test');
const assert = require('node:assert/strict');

require('../../web/js/config.js');
require('../../web/js/format.js');
const Card = require('../../web/js/card.js');

test('card size is 4:5 at 1080 × 1350', () => {
  assert.equal(Card.WIDTH, 1080);
  assert.equal(Card.HEIGHT, 1350);
});

test('cardName: first names only', () => {
  assert.equal(Card.cardName('Maya'), 'Maya');
  assert.equal(Card.cardName('Maya Okafor-Lindqvist'), 'Maya');
  assert.equal(Card.cardName('  Dev   Patel '), 'Dev');
  assert.equal(Card.cardName('🦖 Dev'), '🦖');
  assert.equal(Card.cardName('Bartholomew-Maximilian-Alexander'), 'Bartholomew-Maxi…', 'very long first names are cut');
  assert.equal(Card.cardName(''), '?');
  assert.equal(Card.cardName(null), '?');
});

test('cardName: people who arrive masked stay as they are (SCHEMA §2)', () => {
  assert.equal(Card.cardName('…0001'), '…0001');
  assert.equal(Card.cardName('…4417'), '…4417');
  assert.equal(Card.cardName('jo.smith'), 'jo.smith');
  assert.equal(Card.cardName('averyveryverylon…'), 'averyveryverylon…', 'a masked e-mail already cut to 16 + … is not cut again');
});

test('cardName: a raw handle from older data never reaches the card', () => {
  assert.equal(Card.cardName('+1 (555) 010-0001'), '…0001');
  assert.equal(Card.cardName('+15550100001'), '…0001');
  assert.equal(Card.cardName('555 010 0001'), '…0001');
  assert.equal(Card.cardName('Maya +15550100123'), '…0123', 'a number inside a label is masked too');
  assert.equal(Card.cardName('someone@example.com'), 'S…');
  for (const raw of ['+1 (555) 010-0001', '+15550100001', 'someone@example.com']) {
    const shown = Card.cardName(raw);
    assert.ok(!/\d{5,}/.test(shown) && !shown.includes('@'), `${raw} → ${shown}`);
  }
});

// A canvas stand-in whose glyphs are all `glyph` px wide.
const fakeCtx = (glyph) => ({ measureText: (t) => ({ width: Array.from(t).length * glyph }) });

test('wrap: ordinary text breaks at spaces', () => {
  assert.deepStrictEqual(Card.wrap(fakeCtx(10), 'one two three four', 80), ['one two', 'three', 'four']);
  assert.deepStrictEqual(Card.wrap(fakeCtx(10), '', 80), []);
  assert.deepStrictEqual(Card.wrap(fakeCtx(10), '   spaced   out   ', 200), ['spaced out']);
  assert.deepStrictEqual(Card.wrap(fakeCtx(10), 'abcdefghij', 40), ['abcd', 'efgh', 'ij'], 'a long word is broken');
});

test('wrap: always terminates, even when one glyph is wider than the line', () => {
  // Every glyph is 100 px wide and the line is 50 px: nothing fits, so each glyph gets a line.
  assert.deepStrictEqual(Card.wrap(fakeCtx(100), 'abc', 50), ['a', 'b', 'c']);
  assert.deepStrictEqual(Card.wrap(fakeCtx(100), 'a', 50), ['a']);
  assert.deepStrictEqual(Card.wrap(fakeCtx(100), '🍝', 50), ['🍝']);
  assert.deepStrictEqual(Card.wrap(fakeCtx(100), 'ab 🍝 cd', 50), ['a', 'b', '🍝', 'c', 'd']);
  // A word that ends in one oversized glyph (the case from the review).
  const ctx = { measureText: (t) => ({ width: Array.from(t).reduce((w, ch) => w + (ch === 'W' ? 500 : 10), 0) }) };
  assert.deepStrictEqual(Card.wrap(ctx, 'abcW', 100), ['abc', 'W']);
  assert.deepStrictEqual(Card.wrap(ctx, 'W', 100), ['W']);
  assert.deepStrictEqual(Card.wrap(ctx, 'WW ok', 100), ['W', 'W', 'ok']);
  // Degenerate widths and measurements must not hang either.
  for (const width of [0, -5, NaN]) {
    const lines = Card.wrap(fakeCtx(10), 'hello world', width);
    assert.equal(lines.join(''), 'helloworld', 'no glyph is lost at width ' + width);
  }
  assert.equal(Card.wrap(fakeCtx(Infinity), 'héllo wörld', 300).join(''), 'héllowörld');
  // Every line holds at least one glyph and nothing is dropped, for a long hostile string.
  const hostile = 'W'.repeat(300) + ' ' + '🍝'.repeat(200);
  const out = Card.wrap(ctx, hostile, 100);
  assert.ok(out.every((l) => Array.from(l).length >= 1));
  assert.equal(out.join(''), hostile.replace(' ', ''));
});
