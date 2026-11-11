/*
 * Threadback sample chat: an invented group chat for "Try it with sample data".
 *
 * Everything here is made up: the people, the chat and every message. It lets
 * someone without a Mac walk the whole maker (pick, tune, preview, link) and
 * it is what the screenshots in docs/ are made from.
 *
 * A classic script with no dependencies: WrappedSample in a page or worker,
 * module.exports in Node.
 *
 *   WrappedSample.build({now}) -> {rows, chat_name, participants, me, year}
 *
 * `rows` are in the shape WrappedEngine.computeStats takes; the sender's
 * `handle` is simply a first name. The chat covers one calendar year: the
 * year of `now` (Unix seconds, default: the clock), or the whole year before
 * while `now` is still in January, February or March, so that there is always
 * enough to look at. The output is deterministic: the same day and time zone
 * always give the same rows, and a later day only adds rows at the end.
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module && module.exports) {
    module.exports = api;
  } else {
    root.WrappedSample = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : (typeof self !== 'undefined' ? self : this), function () {
  'use strict';

  var APPLE_EPOCH = 978307200;
  var CHAT_NAME = 'Lake Cabin Crew 🛶';

  // name, share of the talking, attachment %, favourite hours shifted by
  var PEOPLE = [
    { name: null, weight: 16, photos: 5, shift: 0, long: 0 },          // the owner ("Me")
    { name: 'Odalys', weight: 25, photos: 6, shift: 0, long: 0 },
    { name: 'Kenji', weight: 19, photos: 4, shift: 1, long: 0 },
    { name: 'Wren', weight: 14, photos: 31, shift: -1, long: 0 },
    { name: 'Bastian', weight: 11, photos: 3, shift: 0, long: 1 },
    { name: 'Thandi', weight: 10, photos: 5, shift: 5, long: 0 },
    { name: 'Ziggy', weight: 3, photos: 8, shift: 0, long: 0 }
  ];

  // messages per hour of the day, 0..23: a chat that wakes up after dinner
  var HOURS = [3, 2, 1, 0, 0, 1, 2, 5, 8, 9, 9, 10, 13, 11, 9, 9, 11, 14, 19, 24, 28, 31, 22, 11];
  // how busy each month is, January..December: the cabin trip is in July
  var MONTHS = [6, 6, 7, 8, 10, 13, 19, 12, 9, 8, 8, 9];
  // Monday..Sunday
  var WEEKDAYS = [8, 8, 9, 10, 13, 15, 11];

  var SHORT = ['lol', 'no way', 'ok', 'on my way', 'seconded', 'obviously', 'five minutes', 'same',
    'yes please', 'who did this', 'I am in', 'hard pass', 'say less', 'wait what', 'so true',
    'be right there', 'tacos', 'goodnight', 'noted', 'fine'];
  var LINES = [
    'who is bringing the big cooler this time',
    'I can drive if someone else reads the map',
    'the group playlist needs serious help',
    'ok but what time are we actually leaving',
    'rain on Saturday so the card tournament is on',
    'I found the marshmallows behind the pancake mix',
    'did anyone lock the shed',
    'new record on the dock jump, I have witnesses',
    'pancakes at nine, be there or be hungry',
    'the lake is freezing and I regret nothing',
    'can we book the same weekend next year',
    'sending the photos tonight, I promise',
    'someone left one sandal in my car again',
    'I am bringing the famous chili',
    'nobody lets Ziggy near the grill this time',
    'the canoe is patched, mostly',
    'voting for tacos on the first night',
    'the hammock is taken, I live here now',
    'we need a bigger frying pan',
    'does anyone remember the wifi password',
    'I packed four flashlights and zero socks',
    'the loons were loud last night',
    'who moved the puzzle, we were so close',
    'firewood run at four, need two volunteers',
    'adding bug spray to the list in capital letters',
    'that sunset did not have to go that hard',
    'I will trade dish duty for the top bunk',
    'the map says left but my heart says snacks',
    'checking the forecast for the ninth time',
    'next time we rent the place with two bathrooms'
  ];
  var TAILS = ['', '', '', ' honestly', ' again', ' please', ' this time', ' I mean it', ' for real'];

  // the messages everybody reacts to: [month, day, hour, minute, person index, text]
  var LEGENDS = [
    [7, 17, 21, 14, 2, 'I have located the cabin. I have not located the road to the cabin.'],
    [7, 18, 10, 2, 1, 'Who put a whole watermelon in the canoe'],
    [8, 2, 22, 40, 5, 'Update: the raccoon has accepted our terms.'],
    [3, 14, 19, 5, 4, 'I made a spreadsheet for the snacks and I need everyone to take it seriously']
  ];

  // love, like, dislike, laugh, emphasize, question
  var KIND_WEIGHTS = [24, 20, 2, 36, 13, 5];

  function Rng(seed) {
    var state = seed >>> 0;
    this.next = function () {                 // mulberry32
      state = (state + 0x6D2B79F5) >>> 0;
      var t = state;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  Rng.prototype.below = function (n) { return Math.floor(this.next() * n); };
  Rng.prototype.pick = function (list) { return list[this.below(list.length)]; };
  Rng.prototype.weighted = function (weights, total) {
    var roll = this.next() * total;
    for (var i = 0; i < weights.length; i++) {
      roll -= weights[i];
      if (roll < 0) return i;
    }
    return weights.length - 1;
  };

  function sum(list) {
    var total = 0;
    for (var i = 0; i < list.length; i++) total += list[i];
    return total;
  }

  function capital(text) {
    return text.charAt(0).toUpperCase() + text.slice(1);
  }

  function sentence(rng, person) {
    var roll = rng.below(100);
    if (!person.long && roll < 26) return rng.pick(SHORT);
    var text = capital(rng.pick(LINES)) + rng.pick(TAILS);
    if (person.long || roll > 91) text += '. ' + capital(rng.pick(LINES)) + rng.pick(TAILS);
    if (person.long && roll > 40) text += '. ' + capital(rng.pick(LINES));
    return text;
  }

  /** The calendar year the sample covers when made at `now`. */
  function sampleYear(now) {
    var today = new Date(now * 1000);
    return today.getMonth() < 3 ? today.getFullYear() - 1 : today.getFullYear();
  }

  /**
   * Build the sample chat. options: {now} (Unix seconds). Returns
   * {rows, chat_name, participants, me, year}.
   */
  function build(options) {
    var o = options || {};
    var now = Math.floor(o.now == null ? Date.now() / 1000 : Number(o.now));
    var year = sampleYear(now);
    var rng = new Rng(20260711);
    var weights = PEOPLE.map(function (p) { return p.weight; });
    var weightTotal = sum(weights);
    var hourTotal = sum(HOURS);
    var kindTotal = sum(KIND_WEIGHTS);
    var rows = [];
    var rowid = 0;

    function unix(month, day, hour, minute, second) {
      return Math.floor(new Date(year, month - 1, day, hour, minute, second).getTime() / 1000);
    }

    function message(when, who, text, photo) {
      rowid += 1;
      var row = {
        rowid: rowid,
        guid: 'sample-' + rowid,
        date: when - APPLE_EPOCH,
        is_from_me: PEOPLE[who].name === null ? 1 : 0,
        handle: PEOPLE[who].name,
        text: text,
        cache_has_attachments: photo ? 1 : 0,
        item_type: 0,
        associated_message_type: 0,
        associated_message_guid: null
      };
      rows.push(row);
      return row;
    }

    function tapback(target, when, who, kind) {
      rowid += 1;
      rows.push({
        rowid: rowid,
        guid: 'sample-' + rowid,
        date: when - APPLE_EPOCH,
        is_from_me: PEOPLE[who].name === null ? 1 : 0,
        handle: PEOPLE[who].name,
        text: null,
        cache_has_attachments: 0,
        item_type: 0,
        associated_message_type: 2000 + kind,
        associated_message_guid: 'p:0/' + target.guid
      });
    }

    function react(target, author, count, laughs) {
      var order = [];
      var i;
      for (i = 0; i < PEOPLE.length; i++) if (i !== author) order.push(i);
      for (i = order.length - 1; i > 0; i--) {          // shuffle
        var j = rng.below(i + 1);
        var held = order[i]; order[i] = order[j]; order[j] = held;
      }
      var base = target.date + APPLE_EPOCH;
      for (i = 0; i < count && i < order.length; i++) {
        var kind = laughs && rng.below(100) < 70 ? 3 : rng.weighted(KIND_WEIGHTS, kindTotal);
        tapback(target, base + 25 + rng.below(1500) + i * 40, order[i], kind);
      }
    }

    for (var month = 1; month <= 12; month++) {
      var days = new Date(year, month, 0).getDate();
      for (var day = 1; day <= days; day++) {
        var weekday = (new Date(year, month - 1, day).getDay() + 6) % 7;     // Monday = 0
        var busy = MONTHS[month - 1] * WEEKDAYS[weekday] / 100;
        if (month === 7 && day >= 16 && day <= 20) busy *= 2.6;               // the trip itself
        var count = Math.floor(busy * (4 + rng.next() * 11));
        if (rng.below(100) < 9) count = 0;                                   // a quiet day
        var stamps = [];
        var i;
        for (i = 0; i < count; i++) {
          var who = rng.weighted(weights, weightTotal);
          var hour = (rng.weighted(HOURS, hourTotal) + PEOPLE[who].shift + 24) % 24;
          stamps.push([unix(month, day, hour, rng.below(60), rng.below(60)), who]);
        }
        for (i = 0; i < LEGENDS.length; i++) {
          if (LEGENDS[i][0] === month && LEGENDS[i][1] === day) {
            stamps.push([unix(month, day, LEGENDS[i][2], LEGENDS[i][3], 7), LEGENDS[i][4], LEGENDS[i][5], 6 - i]);
          }
        }
        stamps.sort(function (a, b) { return (a[0] - b[0]) || (a[1] - b[1]); });
        for (i = 0; i < stamps.length; i++) {
          var stamp = stamps[i];
          var person = PEOPLE[stamp[1]];
          if (stamp[2]) {
            react(message(stamp[0], stamp[1], stamp[2], false), stamp[1], stamp[3], true);
            continue;
          }
          var photo = rng.below(100) < person.photos;
          var text = photo && rng.below(100) < 55 ? '￼' : sentence(rng, person);
          var row = message(stamp[0], stamp[1], text, photo);
          var roll = rng.below(100);
          var funny = stamp[1] === 2;                     // Kenji gets the laughs
          if (roll < (funny ? 34 : 19)) react(row, stamp[1], 1 + rng.below(funny ? 3 : 2), funny);
        }
      }
    }

    // nothing from the future, and rows in the order Messages would hold them
    rows = rows.filter(function (row) { return row.date + APPLE_EPOCH <= now; });
    rows.sort(function (a, b) { return (a.date - b.date) || (a.rowid - b.rowid); });
    for (var r = 0; r < rows.length; r++) rows[r].rowid = r + 1;

    return {
      rows: rows,
      chat_name: CHAT_NAME,
      participants: PEOPLE.filter(function (p) { return p.name; }).map(function (p) { return p.name; }),
      me: 'Me',
      year: year
    };
  }

  return { build: build, sampleYear: sampleYear, CHAT_NAME: CHAT_NAME };
});
