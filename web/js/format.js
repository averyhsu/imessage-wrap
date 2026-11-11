/*
 * Formatting helpers for the story and the share card. Pure functions, no DOM, no Intl
 * (so output is identical in every browser, in Node and in screenshots).
 */
(function (root) {
  'use strict';

  var MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  var MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var MONTH_LETTERS = ['J', 'F', 'M', 'A', 'M', 'J', 'J', 'A', 'S', 'O', 'N', 'D'];
  // Index 0 = Monday, matching by_weekday in the stats schema.
  var WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
  var WEEKDAYS_SHORT = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  var WEEKDAY_LETTERS = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];

  function num(n) {
    n = Number(n);
    return isFinite(n) ? n : 0;
  }

  /** 48213 → "48,213" */
  function int(n) {
    n = Math.round(num(n));
    var sign = n < 0 ? '-' : '';
    var digits = String(Math.abs(n));
    var out = '';
    while (digits.length > 3) {
      out = ',' + digits.slice(-3) + out;
      digits = digits.slice(0, -3);
    }
    return sign + digits + out;
  }

  /** 950 → "950", 1234 → "1.2K", 48213 → "48K", 1200000 → "1.2M" */
  function compact(n) {
    n = num(n);
    var abs = Math.abs(n);
    function scaled(div, suffix) {
      var v = abs / div;
      var text = v >= 100 ? String(Math.round(v)) : v >= 10 ? String(Math.round(v)) : (Math.round(v * 10) / 10).toFixed(1).replace(/\.0$/, '');
      if (text === '1000' && suffix === 'K') return '1M';
      return (n < 0 ? '-' : '') + text + suffix;
    }
    if (abs < 1000) return String(Math.round(n));
    if (abs < 999500) return scaled(1000, 'K');
    if (abs < 999500000) return scaled(1000000, 'M');
    return scaled(1000000000, 'B');
  }

  /** 0.2456 → "25%"; with digits 1 → "24.6%". Tiny non-zero shares read "<1%". */
  function pct(share, digits) {
    var v = num(share) * 100;
    digits = digits || 0;
    if (v > 0 && v < (digits ? 0.1 : 1)) return digits ? '<0.1%' : '<1%';
    var f = Math.pow(10, digits);
    var r = Math.round(v * f) / f;
    return (digits ? r.toFixed(digits) : String(r)) + '%';
  }

  function clampHour(h) {
    h = Math.round(num(h)) % 24;
    return h < 0 ? h + 24 : h;
  }

  /** 0 → "12 AM", 12 → "12 PM", 23 → "11 PM" */
  function hour(h) {
    h = clampHour(h);
    var h12 = h % 12 === 0 ? 12 : h % 12;
    return h12 + (h < 12 ? ' AM' : ' PM');
  }

  /** 0 → "12a", 18 → "6p" (chart ticks) */
  function hourTick(h) {
    h = clampHour(h);
    var h12 = h % 12 === 0 ? 12 : h % 12;
    return h12 + (h < 12 ? 'a' : 'p');
  }

  /** 23 → "11 PM and midnight", 11 → "11 AM and noon", 14 → "2 and 3 PM" */
  function hourSpan(h) {
    h = clampHour(h);
    var next = (h + 1) % 24;
    if (next === 0) return hour(h) + ' and midnight';
    if (next === 12) return hour(h) + ' and noon';
    if (h === 0) return 'midnight and 1 AM';
    if (h === 12) return 'noon and 1 PM';
    var h12 = h % 12 === 0 ? 12 : h % 12;
    return h12 + ' and ' + hour(next);
  }

  /** "2026-07-04" → {y: 2026, m: 7, d: 4} or null. Never touches time zones. */
  function parseDate(iso) {
    var m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(String(iso == null ? '' : iso));
    if (!m) return null;
    var y = +m[1], mo = +m[2], d = +m[3];
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
    return { y: y, m: mo, d: d };
  }

  function dayNumber(p) { return Math.round(Date.UTC(p.y, p.m - 1, p.d) / 86400000); }

  /** "2026-07-04" → "July 4"; {short: true} → "Jul 4"; {year: true} → "July 4, 2026" */
  function date(iso, opts) {
    var p = parseDate(iso);
    if (!p) return '';
    opts = opts || {};
    var text = (opts.short ? MONTHS_SHORT : MONTHS)[p.m - 1] + ' ' + p.d;
    return opts.year ? text + ', ' + p.y : text;
  }

  /** Weekday index (0 = Monday) of an ISO date, or -1. */
  function weekdayOf(iso) {
    var p = parseDate(iso);
    if (!p) return -1;
    // 1970-01-01 was a Thursday (index 3 with Monday = 0).
    return (((dayNumber(p) + 3) % 7) + 7) % 7;
  }

  /** Inclusive day count between two ISO dates, or 0 when unknown. */
  function daysInclusive(start, end) {
    var a = parseDate(start), b = parseDate(end);
    if (!a || !b) return 0;
    var n = dayNumber(b) - dayNumber(a) + 1;
    return n > 0 ? n : 0;
  }

  /** "Jan 1 – Nov 10", or with years when the period spans more than one. */
  function dateRange(start, end) {
    var a = parseDate(start), b = parseDate(end);
    if (!a && !b) return '';
    if (!a || !b) return date(start || end, { short: true });
    if (a.y === b.y) return date(start, { short: true }) + ' – ' + date(end, { short: true });
    return date(start, { short: true, year: true }) + ' – ' + date(end, { short: true, year: true });
  }

  function plural(n, one, many) { return Math.round(num(n)) === 1 ? one : (many || one + 's'); }

  /** Average per day as a short sentence, or '' when it cannot be computed. */
  function perDay(messages, days) {
    messages = num(messages); days = num(days);
    if (messages <= 0 || days <= 0) return '';
    var avg = messages / days;
    if (avg >= 10) return "That's " + int(avg) + ' a day.';
    if (avg >= 1) return "That's " + (Math.round(avg * 10) / 10).toFixed(1).replace(/\.0$/, '') + ' a day.';
    var every = Math.max(2, Math.round(1 / avg));
    return 'About one every ' + every + ' days.';
  }

  /** A fun, roughly true comparison for a word count. '' when there are no words. */
  function wordFact(words) {
    words = num(words);
    if (words <= 0) return '';
    if (words < 500) return 'About one long text from an aunt.';
    if (words < 2000) return 'A short essay, give or take.';
    if (words < 10000) return "That's a short story.";
    if (words < 40000) return "That's a novella.";
    if (words < 560000) {
      var gatsby = Math.max(1, Math.round(words / 47000)); // The Great Gatsby is about 47,000 words
      return gatsby === 1 ? "That's a whole Great Gatsby." : "That's The Great Gatsby, " + int(gatsby) + ' times over.';
    }
    var wp = words / 587000; // War and Peace is about 587,000 words
    if (wp < 1.5) return 'Longer than War and Peace. Truly.';
    return "That's War and Peace, " + int(wp) + ' times over.';
  }

  /** First visible character of a name, upper-cased, for avatars. */
  function initial(name) {
    var chars = Array.from(String(name == null ? '' : name).trim());
    return chars.length ? chars[0].toUpperCase() : '?';
  }

  /** Truncate by code points and add an ellipsis. */
  function truncate(text, max) {
    var chars = Array.from(String(text == null ? '' : text));
    return chars.length > max ? chars.slice(0, max).join('').replace(/\s+$/, '') + '…' : chars.join('');
  }

  /** "2026" → "2026 in review" (docs/SCHEMA.md §7). */
  function inReview(label) {
    label = String(label == null ? '' : label).trim();
    return label ? label + ' in review' : 'In review';
  }

  /** Index of the largest value (lowest index wins ties), or -1 for an empty/zero list. */
  function argmax(list) {
    var best = -1, bestV = 0;
    for (var i = 0; i < (list ? list.length : 0); i++) {
      if (num(list[i]) > bestV) { bestV = num(list[i]); best = i; }
    }
    return best;
  }

  function sum(list) {
    var t = 0;
    for (var i = 0; i < (list ? list.length : 0); i++) t += num(list[i]);
    return t;
  }

  var Format = {
    MONTHS: MONTHS, MONTHS_SHORT: MONTHS_SHORT, MONTH_LETTERS: MONTH_LETTERS,
    WEEKDAYS: WEEKDAYS, WEEKDAYS_SHORT: WEEKDAYS_SHORT, WEEKDAY_LETTERS: WEEKDAY_LETTERS,
    int: int, compact: compact, pct: pct,
    hour: hour, hourTick: hourTick, hourSpan: hourSpan,
    parseDate: parseDate, date: date, weekdayOf: weekdayOf, daysInclusive: daysInclusive, dateRange: dateRange,
    plural: plural, perDay: perDay, wordFact: wordFact,
    initial: initial, truncate: truncate, inReview: inReview,
    argmax: argmax, sum: sum
  };

  root.WrappedFormat = Format;
  if (typeof module === 'object' && module.exports) module.exports = Format;
})(typeof window !== 'undefined' ? window : globalThis);
