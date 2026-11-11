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
  assert.equal(Card.cardName('+1 (555) 010-0001'), '…01');
  assert.equal(Card.cardName('+15550100001'), '…01');
  assert.equal(Card.cardName('555 010 0001'), '…01');
  assert.equal(Card.cardName('someone@example.com'), 'S…');
  for (const raw of ['+1 (555) 010-0001', '+15550100001', 'someone@example.com']) {
    const shown = Card.cardName(raw);
    assert.ok(!/\d{5,}/.test(shown) && !shown.includes('@'), `${raw} → ${shown}`);
  }
});
