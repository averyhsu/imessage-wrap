/*
 * Threadback import: turn a pasted or uploaded export into engine rows.
 *
 * For people who cannot hand over a Messages database (an iPhone without a
 * computer): the iOS Shortcuts "Find Messages" action, or an export app, can
 * produce a list of messages as text. parseExport() reads that text and
 * returns rows in exactly the shape WrappedEngine.computeStats takes. There are
 * no tapbacks or attachments in such exports, so the resulting stats simply
 * have zero reactions and an empty most_reacted list.
 *
 * A classic script with no dependencies: window.WrappedImport in a page,
 * module.exports in Node. Nothing is sent anywhere.
 *
 *   var result = WrappedImport.parseExport(text, options);
 *   result.rows       [{date, is_from_me, handle, text, keep_empty: 1}, ...]
 *   result.warnings   ["line 12: could not read the date \"soon\"", ...]
 *   result.format     "columnar" | "json" | "jsonl" | "csv" | "tsv" | "unknown"
 *   result.columns    which input column was used for date / sender / text / direction
 *   result.summary    {messages, senders, from_me, first_unix, last_unix,
 *                      first_date, last_date}      (dates are UTC, for a diagnostics line)
 *
 * Accepted input:
 *
 *   1. Columnar (what a Shortcut can emit without a loop):
 *          #dates
 *          2026-03-14T21:41:07-07:00
 *          2026-03-14T21:41:30-07:00
 *          #senders
 *          Maya
 *                               <- an empty line means "sent by me"
 *      Both lists should have the same number of lines. When they do not,
 *      nothing is guessed about which line went missing: a warning gives both
 *      counts and only the first N lines of each list are used, N being the
 *      length of the shorter one (the rest is dropped). A #texts section is
 *      not supported (message text can contain line breaks).
 *   2. JSON Lines: one object per line, {"date": ..., "sender": ..., "text": ...}.
 *   3. A JSON array of such objects.
 *   4. CSV or TSV with a header row. Quoted fields may contain commas, line
 *      breaks and doubled quotes.
 *
 * Columns / keys are found by name, ignoring case, spaces and punctuation:
 *   date       date, timestamp, time, sent, datetime, "message date", ...
 *   sender     sender, from, author, name, "sender name", ...
 *   text       text, message, body, content
 *   direction  direction, is_from_me, type   ("outgoing" / "sent" / "me" / 1 = mine)
 * Without a direction column, an empty sender (or one named "Me") is the owner.
 * A row is always a message: rows without text count, with zero words.
 *
 * Sender names are cleaned exactly like every other name (docs/SCHEMA.md 2,
 * "Clean names": no control characters, line breaks or direction overrides;
 * cut to 40 characters plus an ellipsis; no more than the first 2,048
 * characters are ever looked at) before they are counted or returned, and
 * the same goes for anything quoted in a warning. A sender that is a phone number or an e-mail address is
 * returned as written, like a handle from a database: the engine masks it
 * ("...0123", the part before the "@") when it computes the stats, so it never
 * reaches the recap or the link.
 *
 * Dates: ISO 8601 (with or without a zone), Unix seconds or milliseconds, and
 * the usual written forms ("11/10/2026, 9:41 PM", "2026-11-10 21:41:07",
 * "Nov 10, 2026 at 9:41 PM", "10.11.2026 21:41"). Times without a zone are
 * taken as local time in options.tz (an IANA name) or, by default, the
 * device's zone. For 11/10/2026-style dates the whole file is looked at to
 * tell month-first from day-first; options.dayFirst (true/false) forces it.
 *
 * options: {tz, dayFirst, me: ["Me", "My Name"]}
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module && module.exports) {
    module.exports = api;
  } else {
    root.WrappedImport = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : (typeof self !== 'undefined' ? self : this), function () {
  'use strict';

  var APPLE_EPOCH = 978307200;        // 2001-01-01T00:00:00Z in Unix seconds
  var MAX_UNIX = 4102444800;          // 2100-01-01
  var MAX_LISTED = 8;                 // warnings spelled out per kind before "and N more"
  var NAME_LIMIT = 40;                // a sender's name: this many code points, plus an ellipsis
  var NAME_WINDOW = 2048;             // no name is looked at beyond this many UTF-16 units

  var ROLES = {
    date: ['date', 'timestamp', 'time', 'sent', 'datetime', 'messagedate', 'datesent', 'sentat',
      'senttime', 'sentdate', 'created', 'createdat', 'when'],
    sender: ['sender', 'from', 'author', 'name', 'sendername', 'fromname', 'contact', 'who', 'handle',
      'senderid'],
    text: ['text', 'message', 'body', 'content', 'messagetext', 'messagebody', 'msg'],
    direction: ['direction', 'isfromme', 'type', 'fromme', 'messagetype', 'outgoing', 'sentbyme', 'issent']
  };
  var MINE = ['outgoing', 'sent', 'me', '1', 'true', 'yes', 'y', 'out', 'outbound', 'fromme', 'self', 'you'];
  var THEIRS = ['incoming', 'received', '0', 'false', 'no', 'n', 'in', 'inbound', 'them', ''];
  var MONTHS = {
    jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
    january: 1, february: 2, march: 3, april: 4, june: 6, july: 7, august: 8, september: 9, october: 10,
    november: 11, december: 12
  };

  // ------------------------------------------------------------------ //
  // small helpers
  // ------------------------------------------------------------------ //

  function Notes() {
    this.list = [];
    this.kinds = {};
  }
  /** Record a warning; after MAX_LISTED of one kind only a count is kept. */
  Notes.prototype.add = function (kind, message) {
    var seen = this.kinds[kind] || 0;
    this.kinds[kind] = seen + 1;
    if (seen < MAX_LISTED) this.list.push(message);
  };
  Notes.prototype.finish = function (labels) {
    var out = this.list.slice();
    var kinds = this.kinds;
    Object.keys(kinds).forEach(function (kind) {
      if (kinds[kind] > MAX_LISTED) {
        out.push('... and ' + (kinds[kind] - MAX_LISTED) + ' more ' + (labels[kind] || 'similar warnings') + '.');
      }
    });
    return out;
  };

  function normalizeKey(key) {
    return String(key).toLowerCase().replace(/[^a-z0-9]/g, '');
  }

  /** Collapse every kind of space, drop direction marks, trim. */
  function tidy(value) {
    return String(value)
      .replace(/[\u200E\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g, '')
      .replace(/[\s\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]+/g, ' ')
      .replace(/^ | $/g, '');
  }

  /**
   * The engine's "clean names" rule, then the spaces collapsed: nothing that
   * could break a line, ring a bell or reorder the text around it survives.
   */
  function cleanName(value, limit) {
    var text = String(value);
    if (text.length > NAME_WINDOW) {              // bounded work, however long the input
      text = text.slice(0, NAME_WINDOW);
      if ((text.charCodeAt(NAME_WINDOW - 1) & 0xFC00) === 0xD800) text = text.slice(0, NAME_WINDOW - 1);
    }
    text = tidy(text.replace(/[\t\n\r\u2028\u2029]/g, ' ')
      .replace(/[\u0000-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069\uFFFC\uFFFD]/g, ''));
    return limit ? cap(text, limit) : text;
  }

  /** The first `limit` code points plus an ellipsis; the text itself when it is not longer. */
  function cap(text, limit) {
    var count = 0;
    for (var i = 0; i < text.length; count++) {
      if (count === limit) return text.slice(0, i) + '\u2026';
      var c = text.charCodeAt(i);
      i += (c >= 0xD800 && c <= 0xDBFF && i + 1 < text.length &&
        (text.charCodeAt(i + 1) & 0xFC00) === 0xDC00) ? 2 : 1;
    }
    return text;
  }

  function quote(value) {
    var text = cleanName(value);
    return JSON.stringify(text.length > 40 ? text.slice(0, 40) + '...' : text);
  }

  // ------------------------------------------------------------------ //
  // dates
  // ------------------------------------------------------------------ //

  function offsetAt(tz, unix) {
    // UTC offset (seconds) of an IANA zone at an instant, via Intl
    var parts = tz.format.formatToParts(new Date(unix * 1000));
    var f = {};
    for (var i = 0; i < parts.length; i++) f[parts[i].type] = parts[i].value;
    return Date.UTC(Number(f.year), Number(f.month) - 1, Number(f.day), Number(f.hour) % 24,
      Number(f.minute), Number(f.second)) / 1000 - unix;
  }

  function makeZone(name) {
    if (name == null || name === '' || name === 'local') return null;
    try {
      return {
        name: name,
        format: new Intl.DateTimeFormat('en-US', {
          timeZone: name, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric',
          hour: 'numeric', minute: 'numeric', second: 'numeric'
        })
      };
    } catch (error) {
      var problem = new RangeError('unknown time zone ' + JSON.stringify(cleanName(name)));
      problem.code = 'range';
      throw problem;
    }
  }

  /** Wall-clock fields -> Unix seconds. offset: seconds east of UTC, or null for local time. */
  function wallToUnix(ctx, y, mo, d, h, mi, s, offset) {
    var asUtc = Date.UTC(y, mo - 1, d, h, mi, s);
    var check = new Date(asUtc);
    if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d ||
        h > 23 || mi > 59 || s > 59) return null;
    asUtc /= 1000;
    if (offset !== null) return asUtc - offset;
    if (!ctx.zone) return new Date(y, mo - 1, d, h, mi, s).getTime() / 1000;
    var guess = asUtc - offsetAt(ctx.zone, asUtc);
    return asUtc - offsetAt(ctx.zone, guess);
  }

  // "9:41 PM", "21:41:07", "21:41:07.123", optionally followed by Z / UTC / +01:00
  var TIME = '(\\d{1,2})[:.](\\d{2})(?:[:.](\\d{2})(?:[.,](\\d{1,9}))?)?\\s*([ap])?\\.?(?:m\\.?)?' +
    '\\s*(z|utc|gmt)?\\s*([+-]\\d{1,2}(?::?\\d{2})?)?';
  var RE_ISO = new RegExp('^(\\d{4})[-/.](\\d{1,2})[-/.](\\d{1,2})(?:(?:t|,?\\s+(?:at\\s+)?)' + TIME + ')?$', 'i');
  var RE_NUMERIC = new RegExp('^(\\d{1,2})([/.-])(\\d{1,2})\\2(\\d{2}|\\d{4})(?:,?\\s+(?:at\\s+)?' + TIME + ')?$', 'i');
  var RE_MONTH_FIRST = new RegExp('^(?:[a-z]+\\.?,?\\s+)?([a-z]{3,9})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})' +
    '(?:,?\\s+(?:at\\s+)?' + TIME + ')?$', 'i');
  var RE_DAY_FIRST = new RegExp('^(?:[a-z]+\\.?,?\\s+)?(\\d{1,2})(?:st|nd|rd|th)?\\.?\\s+([a-z]{3,9})\\.?,?\\s+(\\d{4})' +
    '(?:,?\\s+(?:at\\s+)?' + TIME + ')?$', 'i');
  var RE_EPOCH = /^[+-]?\d+(?:\.\d+)?$/;

  /** Fields of the TIME pattern starting at match index `at` -> {h, mi, s, ns, offset} or null. */
  function readTime(match, at) {
    var time = { h: 0, mi: 0, s: 0, ns: 0, offset: null };
    if (match[at] === undefined) return time;
    time.h = Number(match[at]);
    time.mi = Number(match[at + 1]);
    time.s = match[at + 2] === undefined ? 0 : Number(match[at + 2]);
    if (match[at + 3] !== undefined) time.ns = Number((match[at + 3] + '000000000').slice(0, 9));
    var half = match[at + 4];
    if (half !== undefined) {
      if (time.h < 1 || time.h > 12) return null;
      if (half.toLowerCase() === 'p') { if (time.h !== 12) time.h += 12; } else if (time.h === 12) time.h = 0;
    }
    var zone = match[at + 6];
    if (zone !== undefined) {
      var sign = zone.charAt(0) === '-' ? -1 : 1;
      var digits = zone.slice(1).replace(':', '');
      var hours = digits.length > 2 ? Number(digits.slice(0, digits.length - 2)) : Number(digits);
      var minutes = digits.length > 2 ? Number(digits.slice(-2)) : 0;
      if (hours > 14 || minutes > 59) return null;
      time.offset = sign * (hours * 3600 + minutes * 60);
    } else if (match[at + 5] !== undefined) {
      time.offset = 0;
    }
    return time;
  }

  /** Is this a 3/4/2026-style date whose order cannot be told on its own? Returns [first, second] or null. */
  function slashParts(text) {
    var match = RE_NUMERIC.exec(text);
    return match && match[2] === '/' ? [Number(match[1]), Number(match[3])] : null;
  }

  /**
   * Parse one date value. Returns {sec, ns} (Unix seconds plus nanoseconds)
   * or null. ctx: {zone, dayFirst, appleEpoch (set when a number was read as
   * seconds since 2001)}.
   */
  function parseDate(value, ctx) {
    if (value === null || value === undefined || value === '') return null;
    if (typeof value === 'number') {
      if (!isFinite(value)) return null;
      value = String(value);
    }
    if (String(value).length > 200) return null;      // no date is this long: do not even look
    var text = tidy(value);
    if (!text) return null;
    var match, time, unix, year;

    if (RE_EPOCH.test(text)) {
      var negative = text.charAt(0) === '-';
      var digits = text.replace(/^[+-]/, '');
      var dot = digits.indexOf('.');
      var whole = dot === -1 ? digits : digits.slice(0, dot);
      var fraction = dot === -1 ? '' : digits.slice(dot + 1);
      whole = whole.replace(/^0+(?=\d)/, '');
      // unit by magnitude: seconds, then milli-, micro-, nanoseconds
      var shift = whole.length <= 11 ? 0 : whole.length <= 14 ? 3 : whole.length <= 17 ? 6 : 9;
      var all = whole + fraction;
      var secDigits = whole.length - shift;
      var sec = Number(all.slice(0, secDigits) || '0');
      var ns = Number((all.slice(secDigits) + '000000000').slice(0, 9));
      if (negative) return null;
      if (sec < APPLE_EPOCH) {            // before 2001: seconds since the Apple epoch instead
        sec += APPLE_EPOCH;
        ctx.appleEpoch = true;
      }
      return sec <= MAX_UNIX ? { sec: sec, ns: ns } : null;
    }

    if ((match = RE_ISO.exec(text))) {
      time = readTime(match, 4);
      if (!time) return null;
      unix = wallToUnix(ctx, Number(match[1]), Number(match[2]), Number(match[3]), time.h, time.mi, time.s, time.offset);
    } else if ((match = RE_NUMERIC.exec(text))) {
      time = readTime(match, 5);
      if (!time) return null;
      var a = Number(match[1]);
      var b = Number(match[3]);
      year = Number(match[4]);
      if (match[4].length === 2) year += year < 70 ? 2000 : 1900;
      var dayFirst = match[2] !== '/' || ctx.dayFirst;
      if (match[2] === '/' && a > 12) dayFirst = true;
      if (match[2] === '/' && b > 12) dayFirst = false;
      unix = wallToUnix(ctx, year, dayFirst ? b : a, dayFirst ? a : b, time.h, time.mi, time.s, time.offset);
    } else if ((match = RE_MONTH_FIRST.exec(text)) && MONTHS[match[1].toLowerCase()]) {
      time = readTime(match, 4);
      if (!time) return null;
      unix = wallToUnix(ctx, Number(match[3]), MONTHS[match[1].toLowerCase()], Number(match[2]), time.h, time.mi, time.s, time.offset);
    } else if ((match = RE_DAY_FIRST.exec(text)) && MONTHS[match[2].toLowerCase()]) {
      time = readTime(match, 4);
      if (!time) return null;
      unix = wallToUnix(ctx, Number(match[3]), MONTHS[match[2].toLowerCase()], Number(match[1]), time.h, time.mi, time.s, time.offset);
    } else {
      return null;
    }
    if (unix === null || !(unix > APPLE_EPOCH) || unix > MAX_UNIX) return null;
    return { sec: Math.floor(unix), ns: time.ns };
  }

  /** {sec, ns} -> the engine's raw `date`: seconds since 2001, or a nanosecond string. */
  function engineDate(stamp) {
    var seconds = stamp.sec - APPLE_EPOCH;
    if (!stamp.ns) return seconds;
    return String(seconds) + ('000000000' + stamp.ns).slice(-9);
  }

  // ------------------------------------------------------------------ //
  // delimited text
  // ------------------------------------------------------------------ //

  /** Split CSV/TSV text into records of fields. Returns {records, lines (1-based start line of each)}. */
  function parseDelimited(text, delimiter) {
    var records = [];
    var lines = [];
    var record = [];
    var field = '';
    var quoted = false;
    var fresh = true;                   // at the start of a field
    var line = 1;
    var startLine = 1;
    var i = 0;
    var n = text.length;
    var c;
    function endRecord() {
      record.push(field);
      if (record.length > 1 || record[0] !== '') { records.push(record); lines.push(startLine); }
      record = [];
      field = '';
      fresh = true;
      startLine = line;
    }
    while (i < n) {
      c = text.charAt(i);
      if (quoted) {
        if (c === '"') {
          if (text.charAt(i + 1) === '"') { field += '"'; i += 2; continue; }
          quoted = false;
          i += 1;
          continue;
        }
        if (c === '\n') line += 1;
        field += c;
        i += 1;
        continue;
      }
      if (c === '"' && fresh) { quoted = true; fresh = false; i += 1; continue; }
      if (c === delimiter) { record.push(field); field = ''; fresh = true; i += 1; continue; }
      if (c === '\r' || c === '\n') {
        if (c === '\r' && text.charAt(i + 1) === '\n') i += 1;
        i += 1;
        line += 1;
        endRecord();
        continue;
      }
      field += c;
      fresh = false;
      i += 1;
    }
    if (field !== '' || record.length) endRecord();
    return { records: records, lines: lines, unterminated: quoted };
  }

  function guessDelimiter(text) {
    var end = text.search(/[\r\n]/);
    var header = end === -1 ? text : text.slice(0, end);
    var best = ',';
    var bestCount = 0;
    ['\t', ',', ';'].forEach(function (candidate) {
      var count = 0;
      var inQuotes = false;
      for (var i = 0; i < header.length; i++) {
        var c = header.charAt(i);
        if (c === '"') inQuotes = !inQuotes;
        else if (c === candidate && !inQuotes) count += 1;
      }
      if (count > bestCount) { best = candidate; bestCount = count; }
    });
    return best;
  }

  // ------------------------------------------------------------------ //
  // columns
  // ------------------------------------------------------------------ //

  /** Choose the input key for each role from a list of key names. */
  function pickColumns(keys) {
    var normalized = keys.map(normalizeKey);
    var chosen = { date: null, time: null, sender: null, text: null, direction: null };
    var used = {};
    ['date', 'text', 'sender', 'direction'].forEach(function (role) {
      var best = -1;
      var rank = Infinity;
      for (var i = 0; i < keys.length; i++) {
        if (used[i]) continue;
        var position = ROLES[role].indexOf(normalized[i]);
        if (position !== -1 && position < rank) { best = i; rank = position; }
      }
      if (best !== -1) { chosen[role] = keys[best]; used[best] = true; }
    });
    // a separate "time" column next to a "date" column completes it
    if (chosen.date !== null && normalizeKey(chosen.date) !== 'time') {
      for (var i = 0; i < keys.length; i++) {
        if (!used[i] && normalized[i] === 'time') { chosen.time = keys[i]; break; }
      }
    }
    return chosen;
  }

  function isMine(value) {
    if (value === true) return true;
    if (value === false || value === null || value === undefined) return false;
    return MINE.indexOf(normalizeKey(value)) !== -1;
  }

  function looksLikeDirection(values) {
    for (var i = 0; i < values.length; i++) {
      var v = values[i];
      if (v === true || v === false) return true;
      if (v === null || v === undefined) continue;
      var key = normalizeKey(v);
      if (key !== '' && (MINE.indexOf(key) !== -1 || THEIRS.indexOf(key) !== -1)) return true;
    }
    return false;
  }

  // ------------------------------------------------------------------ //
  // building rows
  // ------------------------------------------------------------------ //

  function Builder(ctx, notes) {
    this.ctx = ctx;
    this.notes = notes;
    this.rows = [];
    this.senders = {};
    this.fromMe = 0;
    this.first = null;
    this.last = null;
  }

  Builder.prototype.add = function (where, dateValue, sender, text, mine) {
    var stamp = parseDate(dateValue, this.ctx);
    if (!stamp) {
      this.notes.add('date', where + ': could not read the date ' + quote(dateValue === undefined ? '' : dateValue) + '; skipped.');
      return;
    }
    var name = sender === null || sender === undefined ? '' : cleanName(sender, NAME_LIMIT);
    if (mine === null) mine = name === '' || this.ctx.me.indexOf(name.toLowerCase()) !== -1;
    if (mine) this.fromMe += 1;
    else this.senders[name || 'Unknown'] = true;
    this.rows.push({
      date: engineDate(stamp),
      is_from_me: mine ? 1 : 0,
      handle: mine ? null : (name || null),
      text: text === null || text === undefined ? '' : String(text),
      keep_empty: 1
    });
    if (this.first === null || stamp.sec < this.first) this.first = stamp.sec;
    if (this.last === null || stamp.sec > this.last) this.last = stamp.sec;
  };

  Builder.prototype.summary = function () {
    function day(unix) { return unix === null ? null : new Date(unix * 1000).toISOString().slice(0, 10); }
    return {
      messages: this.rows.length,
      senders: Object.keys(this.senders).length + (this.fromMe ? 1 : 0),
      from_me: this.fromMe,
      first_unix: this.first,
      last_unix: this.last,
      first_date: day(this.first),
      last_date: day(this.last)
    };
  };

  /** Decide month-first or day-first for 3/4/2026-style dates from all the values. */
  function settleDayFirst(ctx, values, notes) {
    if (ctx.dayFirst === true || ctx.dayFirst === false) return;
    var dayFirst = 0;
    var monthFirst = 0;
    var ambiguous = 0;
    for (var i = 0; i < values.length; i++) {
      if (typeof values[i] !== 'string') continue;
      var parts = slashParts(tidy(values[i]));
      if (!parts) continue;
      if (parts[0] > 12) dayFirst += 1;
      else if (parts[1] > 12) monthFirst += 1;
      else ambiguous += 1;
    }
    ctx.dayFirst = dayFirst > monthFirst;
    if (ambiguous && !dayFirst && !monthFirst) {
      notes.add('order', 'Dates like 3/4/2026 were read as month/day/year. If they are day/month/year, ' +
        'export again with ISO dates (or set the day-first option).');
    } else if (dayFirst && monthFirst) {
      notes.add('order', 'Some dates look day-first and some month-first; ambiguous ones were read as ' +
        (ctx.dayFirst ? 'day/month/year.' : 'month/day/year.'));
    }
  }

  function fromObjects(objects, where, builder, notes, result) {
    var cache = {};
    function columnsOf(object) {            // objects with the same keys share the answer
      var keys = Object.keys(object);
      var signature = keys.join('\u0001');
      if (!cache[signature]) cache[signature] = pickColumns(keys);
      return cache[signature];
    }
    function isObject(value) { return !!value && typeof value === 'object' && !Array.isArray(value); }
    function dateOf(object, columns) {
      var date = object[columns.date];
      if (columns.time !== null && object[columns.time] !== undefined && object[columns.time] !== '') {
        date = String(date) + ' ' + String(object[columns.time]);
      }
      return date;
    }
    var first = null;
    var anyDate = false;
    var noSender = 0;
    var noText = 0;
    var dates = [];
    objects.forEach(function (object) {
      if (!isObject(object)) return;
      var columns = columnsOf(object);
      if (first === null) first = columns;
      if (columns.date !== null) { anyDate = true; dates.push(dateOf(object, columns)); }
      if (columns.sender === null && columns.direction === null) noSender += 1;
      if (columns.text === null) noText += 1;
    });
    result.columns = first;
    if (!anyDate) {
      notes.add('columns', 'No date found: each message needs a "date" (or "timestamp", "time", "sent") value.');
      return;
    }
    var total = objects.filter(isObject).length;
    if (noSender === total) notes.add('columns', 'No sender found: every message is attributed to "Unknown".');
    if (noText === total) notes.add('columns', 'No message text found: word counts will be zero.');
    settleDayFirst(builder.ctx, dates, notes);
    objects.forEach(function (object, index) {
      if (!isObject(object)) {
        notes.add('shape', where(index) + ': not an object; skipped.');
        return;
      }
      var columns = columnsOf(object);
      var mine = null;
      if (columns.direction !== null && looksLikeDirection([object[columns.direction]])) {
        mine = isMine(object[columns.direction]);
      }
      var sender = columns.sender === null ? (mine === null ? 'Unknown' : '') : object[columns.sender];
      builder.add(where(index), columns.date === null ? undefined : dateOf(object, columns), sender,
        columns.text === null ? '' : object[columns.text], mine);
    });
  }

  function describeColumns(columns, notes) {
    if (columns.sender === null && columns.direction === null) {
      notes.add('columns', 'No sender found: every message is attributed to "Unknown".');
    } else if (columns.sender === null) {
      notes.add('columns', 'No sender found: messages that are not yours are attributed to "Unknown".');
    }
    if (columns.text === null) {
      notes.add('columns', 'No message text found: word counts will be zero.');
    }
  }

  function parseColumnar(text, builder, notes, result) {
    var lines = text.split(/\r\n|\r|\n/);
    var sections = {};
    var order = [];
    var current = null;
    lines.forEach(function (line, index) {
      var header = /^\s*#\s*([A-Za-z_]+)\s*$/.exec(line);
      if (header) {
        current = header[1].toLowerCase();
        if (!sections[current]) { sections[current] = []; order.push(current); }
        return;
      }
      if (current) sections[current].push({ value: line, line: index + 1 });
    });
    result.columns = { date: '#dates', time: null, sender: sections.senders ? '#senders' : null, text: null, direction: null };
    order.forEach(function (name) {
      if (name === 'texts' || name === 'text') {
        notes.add('texts', 'The #texts section is not supported (message text can contain line breaks) and ' +
          'was ignored. Use JSON Lines to include text.');
      } else if (name !== 'dates' && name !== 'senders') {
        notes.add('section', 'Unknown section #' + name + ' was ignored.');
      }
    });
    var dates = (sections.dates || []).filter(function (entry) { return tidy(entry.value) !== ''; });
    var senders = sections.senders || [];
    if (!sections.senders) {
      notes.add('columns', 'There is no #senders section: every message is attributed to "Unknown".');
    } else {
      // "Maya\n" at the very end is either one line with its terminator or two
      // lines, the second one empty ("sent by me"): the number of dates decides
      var terminated = /[\r\n]$/.test(text) && senders.length > 0 &&
        senders[senders.length - 1].line === lines.length && senders[senders.length - 1].value === '';
      if (terminated && senders.length !== dates.length) senders.pop();
      if (senders.length !== dates.length) {
        var used = Math.min(senders.length, dates.length);
        notes.add('count', '#dates has ' + dates.length + ' lines but #senders has ' + senders.length +
          '; only the first ' + used + ' of each were used. (An empty sender line means "sent by me": ' +
          'check that no lines were lost when copying.)');
        dates = dates.slice(0, used);
        senders = senders.slice(0, used);
      }
    }
    settleDayFirst(builder.ctx, dates.map(function (entry) { return entry.value; }), notes);
    dates.forEach(function (entry, index) {
      builder.add('line ' + entry.line, entry.value, sections.senders ? senders[index].value : 'Unknown', '', null);
    });
  }

  function parseTable(text, builder, notes, result) {
    var delimiter = guessDelimiter(text);
    result.format = delimiter === '\t' ? 'tsv' : 'csv';
    var parsed = parseDelimited(text, delimiter);
    if (parsed.unterminated) notes.add('quote', 'A quoted field is never closed; the end of the file may be misread.');
    if (!parsed.records.length) return;
    var header = parsed.records[0].map(function (name) { return tidy(name); });
    var columns = pickColumns(header);
    result.columns = columns;
    if (columns.date === null) {
      result.format = 'unknown';
      notes.add('columns', 'No date column found in the first line. Expected a header row with a column named ' +
        'date, timestamp, time or sent (found: ' + header.slice(0, 8).map(quote).join(', ') + ').');
      return;
    }
    var at = {};
    Object.keys(columns).forEach(function (role) { at[role] = columns[role] === null ? -1 : header.indexOf(columns[role]); });
    var body = parsed.records.slice(1);
    if (at.direction !== -1 && !looksLikeDirection(body.map(function (r) { return r[at.direction]; }))) {
      at.direction = -1;
      columns.direction = null;
    }
    describeColumns(columns, notes);
    settleDayFirst(builder.ctx, body.map(function (r) { return r[at.date]; }), notes);
    body.forEach(function (record, index) {
      var where = 'line ' + parsed.lines[index + 1];
      if (record.length > header.length) {
        notes.add('fields', where + ': ' + record.length + ' fields but the header has ' + header.length +
          ' (an unquoted comma in the text?).');
      }
      var date = record[at.date];
      if (at.time !== -1 && record[at.time]) date = (date || '') + ' ' + record[at.time];
      var mine = at.direction === -1 ? null : isMine(record[at.direction]);
      builder.add(where, date === undefined ? '' : date,
        at.sender === -1 ? (mine === null ? 'Unknown' : '') : record[at.sender],
        at.text === -1 ? '' : record[at.text], mine);
    });
  }

  // ------------------------------------------------------------------ //
  // entry point
  // ------------------------------------------------------------------ //

  /**
   * Parse an export. `text` is the pasted or uploaded content (a string).
   * See the top of this file for the formats, the options and the result.
   * Never throws for bad input (problems come back in `warnings`); throws
   * a RangeError with code "range" only for an unknown options.tz.
   */
  function parseExport(text, options) {
    var o = options || {};
    var notes = new Notes();
    var me = (Array.isArray(o.me) ? o.me : o.me ? [o.me] : []).concat(['me'])
      .map(function (name) { return cleanName(name, NAME_LIMIT).toLowerCase(); });
    var ctx = { zone: makeZone(o.tz), dayFirst: o.dayFirst === undefined ? null : !!o.dayFirst, me: me, appleEpoch: false };
    var builder = new Builder(ctx, notes);
    var result = { rows: builder.rows, warnings: [], format: 'unknown', columns: null, summary: null };
    var source = typeof text === 'string' ? text.replace(/^\uFEFF/, '') : '';
    var trimmed = source.replace(/^\s+/, '');

    if (!trimmed) {
      notes.add('empty', 'There is nothing to read.');
    } else if (/^#\s*dates\s*(\r|\n|$)/i.test(trimmed)) {
      result.format = 'columnar';
      parseColumnar(trimmed, builder, notes, result);
    } else if (trimmed.charAt(0) === '[' || trimmed.charAt(0) === '{') {
      var parsed;
      var whole = false;
      try { parsed = JSON.parse(trimmed); whole = true; } catch (error) { whole = false; }
      if (whole && parsed && !Array.isArray(parsed) && typeof parsed === 'object') {
        // {"messages": [...]} and friends; a lone message object is a one-line JSON Lines file
        var lists = Object.keys(parsed).filter(function (key) { return Array.isArray(parsed[key]); });
        parsed = lists.length === 1 ? parsed[lists[0]] : [parsed];
      }
      if (whole && Array.isArray(parsed)) {
        result.format = trimmed.charAt(0) === '[' ? 'json' : 'jsonl';
        fromObjects(parsed, function (index) { return 'item ' + (index + 1); }, builder, notes, result);
      } else if (trimmed.charAt(0) === '{') {
        result.format = 'jsonl';
        var objects = [];
        var numbers = [];
        trimmed.split(/\r\n|\r|\n/).forEach(function (line, index) {
          if (!line.trim()) return;
          try {
            objects.push(JSON.parse(line));
            numbers.push(index + 1);
          } catch (error) {
            notes.add('json', 'line ' + (index + 1) + ': not valid JSON (' + quote(line) + '); skipped.');
          }
        });
        fromObjects(objects, function (index) { return 'line ' + numbers[index]; }, builder, notes, result);
      } else {
        notes.add('json', 'This starts like a JSON array but is not valid JSON; nothing was read.');
      }
    } else {
      parseTable(source, builder, notes, result);
    }

    if (ctx.appleEpoch) {
      notes.add('epoch', 'Numeric dates before 2001 were read as seconds since 2001-01-01 (the Messages ' +
        'database format).');
    }
    if (!builder.rows.length && trimmed && !notes.kinds.columns && !notes.kinds.json) {
      notes.add('none', 'No messages could be read from this text.');
    }
    result.summary = builder.summary();
    result.warnings = notes.finish({
      date: 'lines with unreadable dates', json: 'lines that are not valid JSON',
      fields: 'lines with too many fields', shape: 'items that are not objects'
    });
    return result;
  }

  return {
    parseExport: parseExport,
    // exposed for the tests
    _internals: {
      parseDate: parseDate, parseDelimited: parseDelimited, pickColumns: pickColumns, tidy: tidy,
      cleanName: cleanName, engineDate: engineDate
    }
  };
});
