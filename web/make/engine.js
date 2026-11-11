/*
 * Threadback stats engine (docs/SCHEMA.md sections 1-5) for the browser and Node.
 *
 * A classic script with no dependencies: in a page it defines
 * window.WrappedEngine, in Node it is the module's exports. It is the same
 * program as the Python package `wrapped` (stats.py, typedstream.py,
 * payload.py), function for function, and tests/conformance asserts that the
 * two produce byte-identical JSON.
 *
 *   computeStats(rows, options) -> stats          pure: no I/O, no globals
 *   decodeAttributedBody(bytes) -> string | null  message.attributedBody
 *   chatDisplayName(displayName, participants, contacts, me) -> string
 *   encodePayload(stats) / decodePayload(text)    link payload codec
 *   shortNames(stats, me) -> stats                first names ("Sam", "Sam R.") for sharing
 *   cleanName(text) / maskHandle(label)           what every name goes through
 *   fitLink(stats, options) -> {url, length, steps, stats}
 *   buildLink(stats, options) -> url              4,800-character budget; message text
 *                                                 only with options.quotes === true
 *   statsFromUrl(url) -> stats
 *
 * Row shape for computeStats (every key but `date` is optional; the keys are
 * the Messages column names):
 *
 *   rowid                    message.ROWID (ties between equal dates)
 *   guid                     message.guid (what tapbacks point at)
 *   date                     message.date, raw: ns or s since 2001-01-01 UTC.
 *                            Pass a decimal STRING (or BigInt) for nanosecond
 *                            values: they do not fit a JavaScript number.
 *   is_from_me               1 when the owner of the database sent it
 *   handle                   handle.id of the sender (phone or e-mail)
 *   text                     message.text: a string, or UTF-8 bytes
 *   attributedBody           message.attributedBody (Uint8Array)
 *   cache_has_attachments    1 when the message carries an attachment
 *   item_type                0 for messages, anything else is a group event
 *   associated_message_type  2000-2007 / 3000-3007 for tapbacks
 *   associated_message_guid  "p:0/<guid>", "bp:<guid>" or "<guid>"
 *   keep_empty               1 to count a row with neither text nor attachment
 *
 * Values of the wrong type never throw, and both engines read them the same
 * way: a number is used as an integer (truncated towards zero), and anything
 * that is not a number or `true` counts as 0; `text` is a string or UTF-8
 * bytes and `attributedBody` is bytes, `guid`, `handle` and
 * `associated_message_guid` are strings (anything else is "not there"); a
 * `date` is a number (a fraction is dropped), a decimal string or a BigInt;
 * rows that are not objects are skipped. db.js casts every column in SQL, so
 * cells of an unexpected type already arrive in this shape.
 *
 * Options for computeStats (all optional, same names as the Python engine):
 *
 *   tz            IANA zone for every local date and hour (default: the
 *                 device's own zone)
 *   year          calendar year (default: this year, last year in January)
 *   all_time      true: everything up to today
 *   start, end    inclusive "YYYY-MM-DD" bounds;  label: period.label override
 *   now           Unix seconds treated as the current time (default: clock)
 *   me            the owner's display name (default "Me")
 *   contacts      {identifier: name}, a Map, or [[identifier, name], ...]
 *   chat_name     chat.display_name ("" = build one from the members)
 *   participants  handle ids from chat_handle_join
 *   source        recorded in meta.source (default "chat.db")
 *
 * Every name is cleaned (no control characters or direction marks), capped (a
 * person's name at 40 characters, a chat's at 80; no more than the first 1,024
 * are looked at) and masked: handles, imported senders, names from the contact
 * table and the owner's own name alike. See cleanName, maskHandle, maskChatName.
 *
 * Errors: an impossible year, date, zone or "now" throws a RangeError with
 * code "range"; the link functions throw Errors with code "bad_stats" (not a
 * plain JSON object), "bad_payload", "link_too_long" or "no_codec". Nothing
 * here throws an error without a `code` for input of the wrong shape.
 *
 * Payload functions need a raw-DEFLATE codec: the page loads the site's
 * ../js/vendor/fflate.min.js (global `fflate`) before this file; Node uses zlib.
 */
(function (root, factory) {
  'use strict';
  var api = factory(root);
  if (typeof module === 'object' && module && module.exports) {
    module.exports = api;
  } else {
    root.WrappedEngine = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : (typeof self !== 'undefined' ? self : this), function (root) {
  'use strict';

  var PRODUCT_NAME = 'Threadback';
  var GENERATOR = 'wrapped/1';
  var BASE_URL = 'https://averyhsu.github.io/imessage-wrap/';
  var MAX_URL_LENGTH = 4800;
  var TRIM_STEPS = 6;
  var NAME_LIMIT = 40;                // a person's name: this many code points, plus an ellipsis when cut
  var CHAT_NAME_LIMIT = 80;           // a chat's name
  var NAME_WINDOW = 1024;             // no name is looked at beyond this many code points
  var SHORT_QUOTE = 60;

  var APPLE_EPOCH = 978307200;        // 2001-01-01T00:00:00Z in Unix seconds
  var MAX_UNIX = 4102444800;          // 2100-01-01; anything later is not a date
  var DAY = 86400;
  var KINDS = ['love', 'like', 'dislike', 'laugh', 'emphasize', 'question', 'emoji'];
  var KIND_OF = { 2000: 0, 2001: 1, 2002: 2, 2003: 3, 2004: 4, 2005: 5, 2006: 6, 2007: 6 };
  var LAUGH = 3;
  var MAX_SENDERS = 12;
  var MAX_QUOTE = 180;
  var LATE_NIGHT_HOURS = 5;           // local hours 0..4

  var PERSONALITIES = {
    quiet_ones: ['The Quiet Ones', 'Few words. All of them count.'],
    night_owls: ['The Night Owls', 'Sleep is a suggestion.'],
    weekend_warriors: ['The Weekend Warriors', 'Weekdays are for recovering.'],
    always_on: ['The Always-On Group Chat', 'There is no off switch.'],
    early_birds: ['The Early Birds', 'Texting before coffee is a choice.'],
    morning_meeting: ['The Morning Meeting', 'This could not have been an email.'],
    lunch_break: ['The Lunch Break Legends', 'Eating with one hand, typing with the other.'],
    afternoon_slackers: ['The Afternoon Slackers', 'Peak productivity, just not at work.'],
    dinner_table: ['The Dinner Table', 'Phones out, forks down.'],
    after_hours: ['The After-Hours Crew', 'The day ends. The chat begins.']
  };

  // id, emoji, title, detail template ({n} or {x})
  var AWARDS = [
    ['yapper', '\uD83D\uDDE3\uFE0F', 'The Yapper', '{n} messages. Nobody asked.'],
    ['lurker', '\uD83D\uDC7B', 'The Lurker', '{n} messages. Reads everything, says little.'],
    ['night_owl', '\uD83E\uDD89', 'The Night Owl', '{n} messages after midnight.'],
    ['comedian', '\uD83D\uDE02', 'The Comedian', 'Made the chat laugh {n} times.'],
    ['hype', '\uD83D\uDCE3', 'The Hype Machine', 'Handed out {n} tapbacks.'],
    ['novelist', '\uD83D\uDCDA', 'The Novelist', '{x} words per message. A paragraph person.'],
    ['paparazzi', '\uD83D\uDCF8', 'The Paparazzi', '{n} photos, videos and memes.'],
    ['favorite', '\u2B50', 'The Crowd Favorite', '{n} tapbacks received.']
  ];
  var MAX_AWARDS = 6;
  var AWARD_MIN_MESSAGES = 5;
  var AWARD_MIN_SENDERS = 3;
  var AWARD_MIN_COUNT = 3;
  var NOVELIST_MIN_MESSAGES = 20;

  // per-sender counters, by position
  var MSG = 0, WORDS = 1, ATT = 2, LATE = 3, GIVEN = 4, RECV = 5, LAUGHS = 6;

  // ------------------------------------------------------------------ //
  // text
  // ------------------------------------------------------------------ //

  // Whitespace is the ECMAScript set (WhiteSpace + LineTerminator), spelled
  // out so that no engine quirk can make the two implementations disagree.
  function isSpace(c) {
    if (c <= 32) return c === 32 || (c >= 9 && c <= 13);
    if (c < 160) return false;
    return c === 0xA0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200A) || c === 0x2028 ||
      c === 0x2029 || c === 0x202F || c === 0x205F || c === 0x3000 || c === 0xFEFF;
  }

  function trim(text) {
    var start = 0;
    var end = text.length;
    while (start < end && isSpace(text.charCodeAt(start))) start++;
    while (end > start && isSpace(text.charCodeAt(end - 1))) end--;
    return start === 0 && end === text.length ? text : text.slice(start, end);
  }

  /** Remove U+FFFC and U+FFFD, then trim (section 2, "Text"). */
  function cleanText(text) {
    if (!text) return '';
    if (text.indexOf('\uFFFC') !== -1 || text.indexOf('\uFFFD') !== -1) {
      text = text.replace(/[\uFFFC\uFFFD]/g, '');
    }
    return trim(text);
  }

  /** Number of whitespace-separated tokens. */
  function countWords(text) {
    var count = 0;
    var inWord = false;
    for (var i = 0, n = text.length; i < n; i++) {
      if (isSpace(text.charCodeAt(i))) {
        inWord = false;
      } else if (!inWord) {
        inWord = true;
        count++;
      }
    }
    return count;
  }

  function splitWords(text) {
    var out = [];
    var start = -1;
    for (var i = 0, n = text.length; i <= n; i++) {
      if (i === n || isSpace(text.charCodeAt(i))) {
        if (start !== -1) { out.push(text.slice(start, i)); start = -1; }
      } else if (start === -1) {
        start = i;
      }
    }
    return out;
  }

  /** First `limit` characters (Unicode code points) plus an ellipsis. */
  function truncate(text, limit) {
    var i = 0;
    var n = text.length;
    var count = 0;
    while (i < n) {
      if (count === limit) return text.slice(0, i) + '\u2026';
      var c = text.charCodeAt(i);
      if (c >= 0xD800 && c <= 0xDBFF && i + 1 < n) {
        var d = text.charCodeAt(i + 1);
        i += (d >= 0xDC00 && d <= 0xDFFF) ? 2 : 1;
      } else {
        i += 1;
      }
      count++;
    }
    return text;
  }

  var utf8Decoder = null;

  /** Lenient UTF-8 decoding of bytes[start:end] (invalid input -> U+FFFD). */
  function utf8(bytes, start, end) {
    var ascii = true;
    for (var i = start; i < end; i++) {
      if (bytes[i] > 127) { ascii = false; break; }
    }
    if (ascii && end - start < 4096) {
      return String.fromCharCode.apply(null, bytes.subarray(start, end));
    }
    if (!utf8Decoder) utf8Decoder = new TextDecoder('utf-8', { fatal: false, ignoreBOM: true });
    return utf8Decoder.decode(bytes.subarray(start, end));
  }

  function toBytes(value) {
    if (value == null) return null;
    if (value instanceof Uint8Array) return value;
    if (typeof ArrayBuffer !== 'undefined') {
      if (value instanceof ArrayBuffer) return new Uint8Array(value);
      if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    }
    if (Array.isArray(value)) return Uint8Array.from(value);
    return null;
  }

  // ------------------------------------------------------------------ //
  // attributedBody (typedstream)
  // ------------------------------------------------------------------ //

  var TAG_INT16 = 0x81, TAG_INT32 = 0x82, TAG_INT64 = 0x87;
  var TAG_NEW = 0x84, TAG_NIL = 0x85, FIRST_REF = 0x92;

  function latin1(text) {
    var out = new Uint8Array(text.length);
    for (var i = 0; i < text.length; i++) out[i] = text.charCodeAt(i);
    return out;
  }

  var HEADER_LE = latin1('\x04\x0bstreamtyped');
  var HEADER_BE = latin1('\x04\x0btypedstream');
  // The two prefixes NSArchiver writes for the classes Messages uses, up to
  // and including the "+" type marker; the length of the text follows.
  var FAST_PREFIXES = [
    latin1('\x04\x0bstreamtyped\x81\xe8\x03\x84\x01@\x84\x84\x84\x12NSAttributedString\x00' +
      '\x84\x84\x08NSObject\x00\x85\x92\x84\x84\x84\x08NSString\x01\x94\x84\x01+'),
    latin1('\x04\x0bstreamtyped\x81\xe8\x03\x84\x01@\x84\x84\x84\x19NSMutableAttributedString\x00' +
      '\x84\x84\x12NSAttributedString\x00\x84\x84\x08NSObject\x00\x85\x92\x84\x84\x84' +
      '\x0fNSMutableString\x01\x84\x84\x08NSString\x01\x95\x84\x01+')
  ];
  var NSSTRING = latin1('NSString');

  function startsWith(data, prefix) {
    if (data.length < prefix.length) return false;
    for (var i = prefix.length - 1; i >= 0; i--) {
      if (data[i] !== prefix[i]) return false;
    }
    return true;
  }

  function indexOfBytes(data, needle, from, to) {
    var last = Math.min(to, data.length) - needle.length;
    for (var i = from; i <= last; i++) {
      var j = 0;
      while (j < needle.length && data[i + j] === needle[j]) j++;
      if (j === needle.length) return i;
    }
    return -1;
  }

  // Integer readers return the value and leave the next position in `cursor`.
  var cursor = 0;
  var BAD = -1;       // marks "not decodable" (lengths are never negative)

  function readInt(data, pos, little) {
    if (pos >= data.length) return BAD;
    var tag = data[pos];
    if (tag < 0x80) { cursor = pos + 1; return tag; }
    var size = tag === TAG_INT16 ? 2 : tag === TAG_INT32 ? 4 : tag === TAG_INT64 ? 8 : 0;
    if (!size || pos + 1 + size > data.length) return BAD;
    var value = 0;
    for (var i = 0; i < size; i++) {
      var b = data[pos + 1 + (little ? size - 1 - i : i)];
      value = value * 256 + b;
    }
    cursor = pos + 1 + size;
    return value;
  }

  function takeText(data, pos, little) {
    var length = readInt(data, pos, little);
    if (length === BAD) return null;
    var end = cursor + length;
    if (end > data.length) return null;
    return utf8(data, cursor, end);
  }

  function decodeFast(data) {
    for (var i = 0; i < FAST_PREFIXES.length; i++) {
      if (startsWith(data, FAST_PREFIXES[i])) return takeText(data, FAST_PREFIXES[i].length, true);
    }
    return null;
  }

  // Follows the typedstream grammar just far enough to reach the first "+"
  // (or "*") value, which is the backing string of the root object.
  function decodeStructural(data) {
    var little;
    if (startsWith(data, HEADER_LE)) little = true;
    else if (startsWith(data, HEADER_BE)) little = false;
    else return null;
    var pos = HEADER_LE.length;
    var strings = [];

    function sharedString() {       // returns [start, end] or null
      if (pos >= data.length) return null;
      var tag = data[pos++];
      if (tag === TAG_NEW) {
        var length = readInt(data, pos, little);
        if (length === BAD) return null;
        var start = cursor;
        var end = start + length;
        if (end > data.length) return null;
        pos = end;
        var entry = [start, end];
        strings.push(entry);
        return entry;
      }
      if (tag >= FIRST_REF) {
        var index = tag - FIRST_REF;
        return index < strings.length ? strings[index] : null;
      }
      return null;
    }

    function classChain() {
      for (var depth = 0; depth < 64; depth++) {
        if (pos >= data.length) return false;
        var tag = data[pos++];
        if (tag === TAG_NEW) {
          if (!sharedString()) return false;
          if (readInt(data, pos, little) === BAD) return false;
          pos = cursor;
        } else if (tag === TAG_NIL || tag >= FIRST_REF) {
          return true;
        } else {
          return false;
        }
      }
      return false;
    }

    if (readInt(data, pos, little) === BAD) return null;    // system version
    pos = cursor;
    for (var round = 0; round < 8; round++) {
      var encoding = sharedString();
      if (!encoding || encoding[1] === encoding[0]) return null;
      var kind = data[encoding[0]];
      if (kind === 0x2B) return takeText(data, pos, little);            // "+"
      if (kind === 0x2A) {                                               // "*"
        if (pos >= data.length || data[pos++] !== TAG_NEW) return null;
        var raw = sharedString();
        return raw ? utf8(data, raw[0], raw[1]) : null;
      }
      if (kind !== 0x40) return null;                                    // "@"
      if (pos >= data.length || data[pos++] !== TAG_NEW) return null;
      if (!classChain()) return null;
    }
    return null;
  }

  // Heuristic: the first "+"-typed value after an NSString class name.
  function decodeScan(data) {
    var little = !startsWith(data, HEADER_BE);
    var start = indexOfBytes(data, NSSTRING, 0, data.length);
    while (start !== -1) {
      var from = start + 8;
      var limit = Math.min(from + 16, data.length);
      for (var i = from; i + 1 < limit; i++) {
        if (data[i] === 0x01 && data[i + 1] === 0x2B) {
          var text = takeText(data, i + 2, little);
          if (text !== null) return text;
          break;
        }
      }
      start = indexOfBytes(data, NSSTRING, from, data.length);
    }
    return null;
  }

  /** Decode and say how: [text | null, "fast" | "structural" | "scan" | "none"]. */
  function decodeWithStrategy(blob) {
    var data = toBytes(blob);
    if (!data || !data.length) return [null, 'none'];
    var text = decodeFast(data);
    if (text !== null) return [text, 'fast'];
    text = decodeStructural(data);
    if (text !== null) return [text, 'structural'];
    text = decodeScan(data);
    if (text !== null) return [text, 'scan'];
    return [null, 'none'];
  }

  /**
   * The plain text inside a message.attributedBody blob (Uint8Array,
   * ArrayBuffer or array of bytes). Returns null when the blob is empty or
   * not a decodable typedstream; never throws.
   */
  function decodeAttributedBody(blob) {
    return decodeWithStrategy(blob)[0];
  }

  // ------------------------------------------------------------------ //
  // contacts and names
  // ------------------------------------------------------------------ //

  function asciiLower(text) {
    return text.replace(/[A-Z]/g, function (c) { return String.fromCharCode(c.charCodeAt(0) + 32); });
  }

  /** Normalise a phone number or e-mail address for matching, or null. */
  function contactKey(identifier) {
    var value = cleanName(typeof identifier === 'string' ? nameWindow(identifier) : identifier);
    if (!value) return null;
    if (value.indexOf('@') !== -1) return 'e:' + asciiLower(value);
    var digits = value.replace(/[^0-9]/g, '');
    if (digits) return 'p:' + digits.slice(-10);
    return null;
  }

  // First code point of every block of ten Unicode decimal digits (general
  // category Nd, Unicode 17). Spelled out so that both engines agree whatever
  // Unicode version their runtime ships.
  var DIGIT_BLOCKS = [
    0x30, 0x660, 0x6F0, 0x7C0, 0x966, 0x9E6, 0xA66, 0xAE6, 0xB66, 0xBE6, 0xC66, 0xCE6, 0xD66,
    0xDE6, 0xE50, 0xED0, 0xF20, 0x1040, 0x1090, 0x17E0, 0x1810, 0x1946, 0x19D0, 0x1A80, 0x1A90,
    0x1B50, 0x1BB0, 0x1C40, 0x1C50, 0xA620, 0xA8D0, 0xA900, 0xA9D0, 0xA9F0, 0xAA50, 0xABF0,
    0xFF10, 0x104A0, 0x10D30, 0x10D40, 0x11066, 0x110F0, 0x11136, 0x111D0, 0x112F0, 0x11450,
    0x114D0, 0x11650, 0x116C0, 0x116D0, 0x116DA, 0x11730, 0x118E0, 0x11950, 0x11BF0, 0x11C50,
    0x11D50, 0x11DA0, 0x11DE0, 0x11F50, 0x16130, 0x16A60, 0x16AC0, 0x16B50, 0x16D70, 0x1CCF0,
    0x1D7CE, 0x1D7D8, 0x1D7E2, 0x1D7EC, 0x1D7F6, 0x1E140, 0x1E2F0, 0x1E4F0, 0x1E5F1, 0x1E950,
    0x1FBF0
  ];
  var DIGITS = (function () {
    var set = new Set();
    DIGIT_BLOCKS.forEach(function (start) { for (var i = 0; i < 10; i++) set.add(start + i); });
    return set;
  })();
  var RUN_ENDS = '<>()[]"\',;:';

  /**
   * Make a name safe to print, log and share (docs/SCHEMA.md 2, "Clean
   * names"): line breaks and tabs become a space; control characters,
   * direction marks, overrides and isolates, U+FEFF, U+FFFC and U+FFFD are
   * removed; runs of spaces collapse; the result is trimmed. Anything that is
   * not a string gives "". (Zero-width joiners and variation selectors stay:
   * emoji need them.)
   *
   * With `limit` (NAME_LIMIT for a person, CHAT_NAME_LIMIT for a chat) the
   * name is also capped: only its first 1,024 code points are looked at, and
   * a clean name longer than `limit` code points is cut to `limit` plus an
   * ellipsis. The cost is bounded however long the input is. Cap before
   * masking, so that a masked label is never cut.
   */
  function cleanName(name, limit) {
    if (typeof name !== 'string' || !name) return '';
    if (limit != null) name = nameWindow(name);
    var out = name.replace(/[\t\n\r\u2028\u2029]/g, ' ')
      .replace(/[\u0000-\u001F\u007F-\u009F\u200E\u200F\u202A-\u202E\u2066-\u2069\uFEFF\uFFFC\uFFFD]/g, '');
    if (out.indexOf('  ') !== -1) out = out.replace(/ {2,}/g, ' ');
    out = trim(out);
    return limit != null ? truncate(out, limit) : out;
  }

  /** The first NAME_WINDOW code points of a string (all of it when it is shorter). */
  function nameWindow(text) {
    if (text.length <= NAME_WINDOW) return text;
    var i = 0;
    for (var count = 0; count < NAME_WINDOW && i < text.length; count++) {
      var c = text.charCodeAt(i);
      i += (c >= 0xD800 && c <= 0xDBFF && i + 1 < text.length &&
        (text.charCodeAt(i + 1) & 0xFC00) === 0xDC00) ? 2 : 1;
    }
    return text.slice(0, i);
  }

  /** What may be shown for a person: cleaned, capped at NAME_LIMIT and masked ("" when nothing is left). */
  function personLabel(name) {
    return maskHandle(cleanName(name, NAME_LIMIT));
  }

  function endsRun(text, index) {
    return isSpace(text.charCodeAt(index)) || RUN_ENDS.indexOf(text.charAt(index)) !== -1;
  }

  function maskDigits(label) {
    var digits = [];
    for (var i = 0; i < label.length; i++) {
      var c = label.codePointAt(i);
      if (c > 0xFFFF) i++;
      if (c >= 48 && (c <= 57 || (c > 127 && DIGITS.has(c)))) digits.push(String.fromCodePoint(c));
    }
    return digits.length >= 7 ? '\u2026' + digits.slice(-4).join('') : label;
  }

  /**
   * Hide a phone number or e-mail address inside a label. A recap is made to
   * be shared, so a raw number or address never goes into it (docs/SCHEMA.md
   * 2, "Masking"). Applied to every sender label that did not come from the
   * contact table, and to chat names:
   *  1. if the label contains an e-mail address (characters around an "@",
   *     at least one on each side, up to whitespace or one of
   *     < > ( ) [ ] " ' , ; :) it becomes the part before the "@", cut to 16
   *     characters plus an ellipsis when longer;
   *  2. if the label (or that local part) holds seven or more decimal digits
   *     in total, in any script and whatever separates them, it becomes an
   *     ellipsis plus its last four digits as written;
   *  3. anything else is returned unchanged.
   */
  function maskHandle(label) {
    label = String(label);
    var local = addressLocal(label);
    return maskDigits(local === null ? label : local);
  }

  /**
   * The part before the "@" of the first e-mail address in the label (cut to
   * 16 characters plus an ellipsis), or null when it holds none.
   */
  function addressLocal(label) {
    var at = label.indexOf('@');
    while (at !== -1) {
      var start = at;
      while (start > 0 && !endsRun(label, start - 1)) start--;
      var end = at + 1;
      while (end < label.length && !endsRun(label, end)) end++;
      if (start < at && end > at + 1) return truncate(label.slice(start, at), 16);
      at = label.indexOf('@', at + 1);
    }
    return null;
  }

  /** What may stand between the digits of one phone number: spaces, + - ( ) . and dashes. */
  function joinsPhone(c) {
    return isSpace(c) || c === 43 || c === 45 || c === 40 || c === 41 || c === 46 ||
      (c >= 0x2010 && c <= 0x2015) || c === 0x2212;
  }

  /**
   * The last four digits of the first stretch of the label that is shaped
   * like a phone number, or null. A stretch is digits joined by spaces,
   * + - ( ) . or dashes; it counts when it holds ten or more digits, or seven
   * or more after a "+". Years and counts ("Class of 2026-2027", "Flat 12")
   * are not phone numbers.
   */
  function phoneRun(label) {
    var digits = [];
    var plus = false;
    for (var i = 0; i <= label.length; i++) {
      var c = i < label.length ? label.codePointAt(i) : 0;
      if (c > 0xFFFF) i++;
      if (c >= 48 && (c <= 57 || (c > 127 && DIGITS.has(c)))) {
        digits.push(String.fromCodePoint(c));
      } else if (c === 43 || !joinsPhone(c)) {
        if (digits.length >= 10 || (plus && digits.length >= 7)) return digits.slice(-4).join('');
        digits = [];
        plus = c === 43;
      }
    }
    return null;
  }

  /**
   * Hide a phone number or e-mail address in a chat's own name (docs/SCHEMA.md
   * 2, "Masking"). People name chats on purpose and often with numbers in
   * them, so the test for a phone number is stricter here than for a sender
   * label: see phoneRun.
   */
  function maskChatName(label) {
    label = String(label);
    var local = addressLocal(label);
    if (local !== null) return maskDigits(local);
    var tail = phoneRun(label);
    return tail === null ? label : '\u2026' + tail;
  }

  /** A database integer, whatever type it arrived as (non-numbers count as 0). */
  function toInt(value) {
    if (typeof value === 'number') return value === value ? Math.trunc(value) : 0;
    return value === true ? 1 : 0;
  }

  function flag(value) {
    return toInt(value) !== 0;
  }

  /** Typed arrays and ArrayBuffers only: what a database hands over as a BLOB. */
  function blob(value) {
    if (value instanceof Uint8Array) return value;
    if (typeof ArrayBuffer !== 'undefined') {
      if (value instanceof ArrayBuffer) return new Uint8Array(value);
      if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    }
    return null;
  }

  function rangeError(message) {
    var error = new RangeError(message);
    error.code = 'range';
    return error;
  }

  /** A caller's value for an error message: cleaned, short, and never a second error. */
  function show(value) {
    if (typeof value === 'string') return JSON.stringify(truncate(cleanName(value), 60));
    try {
      var text = JSON.stringify(value);
      return typeof text === 'string' ? truncate(text, 60) : typeof value;
    } catch (error) {
      return typeof value;                // a BigInt, or something that refers to itself
    }
  }

  function ContactLookup() { this.table = new Map(); }

  /**
   * Turn {identifier: name}, a Map, or [[identifier, name], ...] into a
   * normalised lookup. When two cards claim the same number under different
   * names the name that sorts first wins, whatever the input order.
   */
  function buildContactLookup(contacts) {
    if (contacts instanceof ContactLookup) return contacts;
    var lookup = new ContactLookup();
    if (!contacts) return lookup;
    var pairs;
    if (Array.isArray(contacts)) pairs = contacts;
    else if (typeof Map !== 'undefined' && contacts instanceof Map) pairs = Array.from(contacts.entries());
    else if (typeof contacts === 'object') pairs = Object.keys(contacts).map(function (k) { return [k, contacts[k]]; });
    else return lookup;                 // not a table of any kind
    for (var i = 0; i < pairs.length; i++) {
      var pair = pairs[i];
      if (!Array.isArray(pair) || pair.length < 2) continue;
      var identifier = pair[0];
      var name = pair[1];
      if (typeof identifier !== 'string' || typeof name !== 'string') continue;
      // people do save contacts under a number or an address: a contact name
      // is a sender label like any other (cleaned, capped and masked)
      name = personLabel(name);
      var key = contactKey(identifier);
      if (!name || key === null) continue;
      var previous = lookup.table.get(key);
      if (previous === undefined || name < previous) lookup.table.set(key, name);
    }
    return lookup;
  }

  function Names(me, lookup) {
    this.me = me;
    this.table = lookup.table;
    this.cache = new Map();
  }
  Names.prototype.handle = function (handle) {
    if (typeof handle !== 'string') return 'Unknown';
    handle = nameWindow(handle);
    var name = this.cache.get(handle);
    if (name === undefined) {
      var key = contactKey(handle);
      // every label is cleaned, capped and masked (contact names when the table is built)
      name = (key !== null && this.table.get(key)) || personLabel(handle) || 'Unknown';
      this.cache.set(handle, name);
    }
    return name;
  };
  Names.prototype.sender = function (row) {
    return flag(row.is_from_me) ? this.me : this.handle(row.handle);
  };

  /** A chat's own name, cleaned and masked ("" when it has none). */
  function chatLabel(displayName) {
    return maskChatName(cleanName(displayName, CHAT_NAME_LIMIT));
  }

  /** The owner's name as it goes into the stats: a sender label like any other. */
  function ownerName(me) {
    return personLabel(me) || 'Me';
  }

  function distinct(names) {
    var seen = new Set();
    var out = [];
    for (var i = 0; i < names.length; i++) {
      if (!seen.has(names[i])) { seen.add(names[i]); out.push(names[i]); }
    }
    return out;
  }

  function fallbackName(members, me) {
    var others = members.filter(function (m) { return m !== me; });
    if (!others.length) return 'Unnamed group';
    var firsts = others.slice(0, 3).map(function (member) {
      var tokens = splitWords(member);
      return tokens.length ? tokens[0] : member;
    });
    var label = firsts.join(', ');
    if (others.length > 3) label += ' & ' + (others.length - 3) + ' more';
    return truncate(label, CHAT_NAME_LIMIT);
  }

  function resolveAll(names, handles) {
    var out = [];
    if (!Array.isArray(handles)) return out;
    for (var i = 0; i < handles.length; i++) {
      if (typeof handles[i] === 'string' && handles[i]) out.push(names.handle(handles[i]));
    }
    return distinct(out);
  }

  /**
   * The chat's name: displayName (cleaned, and masked if somebody named the
   * chat after a phone number or an address) when it has one, otherwise the
   * first names of up to three members (in the order given, the owner left
   * out) joined with ", " plus " & N more".
   */
  function chatDisplayName(displayName, participants, contacts, me) {
    var name = chatLabel(displayName);
    if (name) return name;
    me = ownerName(me);
    var names = new Names(me, buildContactLookup(contacts));
    return fallbackName(resolveAll(names, participants), me);
  }

  // ------------------------------------------------------------------ //
  // dates and time zones
  // ------------------------------------------------------------------ //

  var dateSec = 0;
  var dateFrac = 0;

  /** message.date -> dateSec (Unix seconds) and dateFrac (ns); false if unusable. */
  function splitDate(value) {
    if (value == null) return false;
    var sec, frac;
    var type = typeof value;
    if (type === 'bigint') { value = value.toString(); type = 'string'; }
    if (type === 'string') {
      var s = trim(value);
      if (!/^\+?[0-9]+$/.test(s)) return false;
      s = s.replace(/^\+?0*/, '');
      if (s === '') return false;
      if (s.length <= 11 || s === '100000000000') {
        sec = Number(s) + APPLE_EPOCH;
        frac = 0;
      } else {
        sec = Number(s.slice(0, s.length - 9)) + APPLE_EPOCH;
        frac = Number(s.slice(s.length - 9));
      }
    } else if (type === 'number') {
      if (!(value >= 1)) return false;
      value = Math.floor(value);
      if (value > 100000000000) {
        var whole = Math.floor(value / 1000000000);
        frac = value - whole * 1000000000;
        if (frac < 0) frac = 0; else if (frac > 999999999) frac = 999999999;
        sec = whole + APPLE_EPOCH;
      } else {
        sec = value + APPLE_EPOCH;
        frac = 0;
      }
    } else {
      return false;
    }
    if (!(sec <= MAX_UNIX)) return false;
    dateSec = sec;
    dateFrac = frac;
    return true;
  }

  /** Raw message.date -> Unix seconds, or null. */
  function dateToUnix(value) {
    return splitDate(value) ? dateSec : null;
  }

  function floorDiv(a, b) { return Math.floor(a / b); }

  /** Days since 1970-01-01 for a proleptic Gregorian date. */
  function daysFromCivil(y, m, d) {
    if (m <= 2) y -= 1;
    var era = floorDiv(y, 400);
    var yoe = y - era * 400;
    var doy = floorDiv(153 * (m + (m > 2 ? -3 : 9)) + 2, 5) + d - 1;
    var doe = yoe * 365 + floorDiv(yoe, 4) - floorDiv(yoe, 100) + doy;
    return era * 146097 + doe - 719468;
  }

  function civilFromDays(z) {
    z += 719468;
    var era = floorDiv(z, 146097);
    var doe = z - era * 146097;
    var yoe = floorDiv(doe - floorDiv(doe, 1460) + floorDiv(doe, 36524) - floorDiv(doe, 146096), 365);
    var y = yoe + era * 400;
    var doy = doe - (365 * yoe + floorDiv(yoe, 4) - floorDiv(yoe, 100));
    var mp = floorDiv(5 * doy + 2, 153);
    var d = doy - floorDiv(153 * mp + 2, 5) + 1;
    var m = mp < 10 ? mp + 3 : mp - 9;
    return [m <= 2 ? y + 1 : y, m, d];
  }

  function pad(n, width) {
    var s = String(n);
    while (s.length < width) s = '0' + s;
    return s;
  }

  function iso(day) {
    var c = civilFromDays(day);
    return pad(c[0], 4) + '-' + pad(c[1], 2) + '-' + pad(c[2], 2);
  }

  function parseIso(value, what) {
    var match = typeof value === 'string' ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(value) : null;
    if (!match) throw rangeError(what + ' must be a YYYY-MM-DD date, got ' + show(value));
    var y = Number(match[1]), m = Number(match[2]), d = Number(match[3]);
    var day = daysFromCivil(y, m, d);
    var back = civilFromDays(day);
    if (back[0] !== y || back[1] !== m || back[2] !== d) {
      throw rangeError(what + ' is not a real calendar date: ' + show(value));
    }
    return day;
  }

  /** Unix seconds -> UTC offset in seconds, for an IANA zone or the local one. */
  function offsetFunction(tz) {
    if (tz == null || tz === '' || tz === 'local') {
      return function (t) { return -Math.round(new Date(t * 1000).getTimezoneOffset() * 60); };
    }
    var format;
    try {
      format = new Intl.DateTimeFormat('en-US', {
        timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric',
        hour: 'numeric', minute: 'numeric', second: 'numeric'
      });
    } catch (error) {
      throw rangeError('unknown time zone ' + show(tz));
    }
    return function (t) {
      var parts = format.formatToParts(new Date(t * 1000));
      var f = {};
      for (var i = 0; i < parts.length; i++) f[parts[i].type] = parts[i].value;
      var hour = Number(f.hour) % 24;
      var wall = Date.UTC(Number(f.year), Number(f.month) - 1, Number(f.day), hour,
        Number(f.minute), Number(f.second)) / 1000;
      return wall - t;
    };
  }

  /**
   * UTC offsets over [lo, hi], found by asking the zone once per day and
   * bisecting to the exact second whenever two samples differ. Looking a
   * timestamp up is then a binary search over a handful of transitions, so
   * half a million messages cost a few hundred Intl calls, not half a million.
   */
  function Offsets(offsetAt, lo, hi) {
    this.starts = [lo];
    this.offsets = [offsetAt(lo)];
    var t = lo;
    var current = this.offsets[0];
    while (t < hi) {
      var next = Math.min(t + DAY, hi);
      if (offsetAt(next) === current) { t = next; continue; }
      var a = t, b = next;
      while (b - a > 1) {
        var mid = Math.floor((a + b) / 2);
        if (offsetAt(mid) === current) a = mid; else b = mid;
      }
      current = offsetAt(b);
      this.starts.push(b);
      this.offsets.push(current);
      t = b;
    }
  }
  Offsets.prototype.index = function (t) {      // bisect_right(starts, t) - 1
    var lo = 0, hi = this.starts.length;
    while (lo < hi) {
      var mid = (lo + hi) >> 1;
      if (t < this.starts[mid]) hi = mid; else lo = mid + 1;
    }
    return lo - 1;
  };
  Offsets.prototype.at = function (t) {
    return this.offsets[this.starts.length === 1 ? 0 : this.index(t)];
  };

  /** [startDay | null, endDay, label | null] as local day numbers. */
  function resolvePeriod(today, year, allTime, start, end, label) {
    if (allTime) return [null, today, label || 'All time'];
    if (start != null || end != null) {
      var startDay = start != null ? parseIso(start, 'start') : null;
      var endDay = end != null ? parseIso(end, 'end') : today;
      if (startDay !== null && startDay > endDay) {
        throw rangeError('the period starts after it ends: ' + show(start) + ' > ' + iso(endDay));
      }
      return [startDay, endDay, label || null];
    }
    var now = civilFromDays(today);
    if (year == null) year = now[1] === 1 ? now[0] - 1 : now[0];
    if (typeof year !== 'number' || year !== Math.trunc(year) || year < 1 || year > 9999) {
      throw rangeError('the year must be a whole number between 1 and 9999, got ' + show(year));
    }
    var last = daysFromCivil(year, 12, 31);
    return [daysFromCivil(year, 1, 1), year === now[0] ? today : last, label || String(year)];
  }

  // ------------------------------------------------------------------ //
  // small helpers for the output
  // ------------------------------------------------------------------ //

  /** Share rounded to 4 decimals, half up (section 2, "Rounding"). */
  function round4(numerator, denominator) {
    if (!denominator) return 0;
    return Math.round(numerator / denominator * 10000) / 10000;
  }

  function hour12(hour) {
    return (hour % 12 || 12) + ' ' + (hour < 12 ? 'AM' : 'PM');
  }

  function sum(list, from, to) {
    var total = 0;
    for (var i = from || 0, n = to == null ? list.length : to; i < n; i++) total += list[i];
    return total;
  }

  function personality(byHour, byWeekday, total) {
    var peak = 0;
    var peakHour = 0;
    for (var h = 0; h < 24; h++) {
      if (byHour[h] > peak) { peak = byHour[h]; peakHour = h; }
    }
    var id;
    if (total < 50) id = 'quiet_ones';
    else if (sum(byHour, 0, LATE_NIGHT_HOURS) / total >= 0.12 || peakHour <= 4) id = 'night_owls';
    else if ((byWeekday[5] + byWeekday[6]) / total >= 0.42) id = 'weekend_warriors';
    else if (peak / total < 0.065) id = 'always_on';
    else if (peakHour <= 8) id = 'early_birds';
    else if (peakHour <= 11) id = 'morning_meeting';
    else if (peakHour <= 13) id = 'lunch_break';
    else if (peakHour <= 17) id = 'afternoon_slackers';
    else if (peakHour <= 20) id = 'dinner_table';
    else id = 'after_hours';
    return {
      id: id,
      title: PERSONALITIES[id][0],
      blurb: 'Peak hour: ' + hour12(peakHour) + '. ' + PERSONALITIES[id][1],
      peak_hour: peakHour
    };
  }

  function thousands(n) {
    return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }

  /** Highest `field`; ties go to more messages, then to the name. */
  function top(people, field, minimum, only) {
    var best = null;
    var bestCounters = null;
    people.forEach(function (c, name) {
      if (c[field] <= 0 || c[field] < minimum) return;
      if (only && !only.has(name)) return;
      if (best === null || c[field] > bestCounters[field] ||
          (c[field] === bestCounters[field] && (c[MSG] > bestCounters[MSG] ||
            (c[MSG] === bestCounters[MSG] && name < best)))) {
        best = name;
        bestCounters = c;
      }
    });
    return best === null ? null : [best, bestCounters[field]];
  }

  function awards(people) {
    var qualifying = new Map();
    people.forEach(function (c, name) {
      if (c[MSG] >= AWARD_MIN_MESSAGES) qualifying.set(name, c);
    });
    if (qualifying.size < AWARD_MIN_SENDERS) return [];

    function most(field, minimum) {
      var winner = top(qualifying, field, minimum, null);
      return winner ? [winner[0], thousands(winner[1])] : null;
    }

    var winners = {};
    winners.yapper = most(MSG, 1);
    var lurker = null;
    qualifying.forEach(function (c, name) {
      if (lurker === null || c[MSG] < qualifying.get(lurker)[MSG] ||
          (c[MSG] === qualifying.get(lurker)[MSG] && name < lurker)) {
        lurker = name;
      }
    });
    winners.lurker = [lurker, thousands(qualifying.get(lurker)[MSG])];
    winners.night_owl = most(LATE, AWARD_MIN_COUNT);
    winners.comedian = most(LAUGHS, AWARD_MIN_COUNT);
    winners.hype = most(GIVEN, AWARD_MIN_COUNT);
    var novelist = null;
    qualifying.forEach(function (c, name) {
      if (c[MSG] < NOVELIST_MIN_MESSAGES) return;
      if (novelist === null) { novelist = name; return; }
      var b = qualifying.get(novelist);
      var left = c[WORDS] * b[MSG];           // exact comparison of words/messages
      var right = b[WORDS] * c[MSG];
      if (left > right || (left === right && (c[MSG] > b[MSG] ||
          (c[MSG] === b[MSG] && name < novelist)))) {
        novelist = name;
      }
    });
    if (novelist !== null) {
      var n = qualifying.get(novelist);
      var tenths = Math.floor((n[WORDS] * 20 + n[MSG]) / (2 * n[MSG]));   // one decimal, half up
      winners.novelist = [novelist, Math.floor(tenths / 10) + '.' + (tenths % 10)];
    } else {
      winners.novelist = null;
    }
    winners.paparazzi = most(ATT, AWARD_MIN_COUNT);
    winners.favorite = most(RECV, AWARD_MIN_COUNT);

    var chosen = [];
    var deferred = [];
    var holders = new Set();
    for (var i = 0; i < AWARDS.length; i++) {
      var award = AWARDS[i];
      var won = winners[award[0]];
      if (!won) continue;
      var entry = {
        id: award[0], emoji: award[1], title: award[2], winner: won[0],
        detail: award[3].replace('{n}', won[1]).replace('{x}', won[1])
      };
      if (holders.has(won[0])) {
        deferred.push(entry);
      } else if (chosen.length < MAX_AWARDS) {
        chosen.push(entry);
        holders.add(won[0]);
      }
    }
    return chosen.concat(deferred).slice(0, MAX_AWARDS);
  }

  // ------------------------------------------------------------------ //
  // the engine
  // ------------------------------------------------------------------ //

  /**
   * Compute the stats JSON (schema v: 1) for one chat. See the top of this
   * file for the row shape and the options. Throws RangeError for an unknown
   * time zone or impossible dates.
   */
  function computeStats(rows, options) {
    var opts = options || {};
    var me = ownerName(opts.me);
    var names = new Names(me, buildContactLookup(opts.contacts));
    var now = opts.now == null ? Date.now() / 1000 : opts.now;
    if (typeof now !== 'number' || !(now >= 0 && now <= MAX_UNIX)) {
      throw rangeError('now must be Unix seconds, got ' + show(now));
    }
    now = Math.floor(now);
    if (!Array.isArray(rows)) rows = Array.from(rows || []);
    var count = rows.length;
    var i, row, sec;

    // ---- pass 0: timestamps, and the range the time-zone table must cover
    var secs = new Float64Array(count);
    var fracs = new Float64Array(count);
    var lo = now, hi = now;
    for (i = 0; i < count; i++) {
      row = rows[i];
      if (row && typeof row === 'object' && splitDate(row.date)) {
        sec = dateSec;
        secs[i] = sec;
        fracs[i] = dateFrac;
        if (sec < lo) lo = sec; else if (sec > hi) hi = sec;
      } else {
        secs[i] = -1;
      }
    }
    var table = new Offsets(offsetFunction(opts.tz), lo, hi);
    var starts = table.starts;
    var offsets = table.offsets;

    var today = Math.floor((now + table.at(now)) / DAY);
    var period = resolvePeriod(today, opts.year, !!opts.all_time, opts.start, opts.end,
      cleanName(opts.label, CHAT_NAME_LIMIT) || null);
    var startDay = period[0];
    var endDay = period[1];
    var label = period[2];

    // ---- pass 1: tapbacks, in chronological order
    var taps = [];
    var kind;
    for (i = 0; i < count; i++) {
      sec = secs[i];
      if (sec < 0) continue;
      kind = toInt(rows[i].associated_message_type);
      if (kind < 2000 || kind > 3007 || (kind > 2007 && kind < 3000)) continue;
      if (Math.floor((sec + table.at(sec)) / DAY) > endDay) continue;   // after the period ended
      taps.push(i);
    }
    taps.sort(function (a, b) {
      return (secs[a] - secs[b]) || (fracs[a] - fracs[b]) ||
        (toInt(rows[a].rowid) - toInt(rows[b].rowid)) || (a - b);
    });
    // one tapback per person per message part: the key keeps the "p:N/" or
    // "bp:" prefix, the message is whatever follows it
    var state = new Map();          // target -> Map(reactor -> kind)
    for (i = 0; i < taps.length; i++) {
      row = rows[taps[i]];
      var target = row.associated_message_guid;
      if (typeof target !== 'string' || !target) continue;
      var reactor = names.sender(row);
      kind = toInt(row.associated_message_type);
      var perTarget = state.get(target);
      if (kind >= 3000) {
        if (perTarget) perTarget.delete(reactor);
      } else {
        if (!perTarget) { perTarget = new Map(); state.set(target, perTarget); }
        perTarget.set(reactor, KIND_OF[kind]);
      }
    }
    var standing = new Map();       // message guid -> [[reactor, kind], ...]
    state.forEach(function (perTarget, target) {
      if (!perTarget.size) return;
      var guid;
      var slash = target.lastIndexOf('/');
      if (slash >= 0) {
        guid = target.slice(slash + 1);
      } else {
        var colon = target.indexOf(':');
        guid = colon >= 0 ? target.slice(colon + 1) : target;
      }
      var marks = standing.get(guid);
      if (!marks) { marks = []; standing.set(guid, marks); }
      perTarget.forEach(function (k, who) { marks.push([who, k]); });
    });
    var haveStanding = standing.size > 0;

    // ---- pass 2: countable messages inside the period
    var people = new Map();         // name -> counters
    var byHour = new Array(24).fill(0);
    var dayCounts = new Map();
    var reacted = [];
    var total = 0, wordsTotal = 0, attachmentsTotal = 0;
    var firstDay = null;
    var segLo = 0, segHi = 0, segOff = 0;       // cached [segLo, segHi) with one offset

    for (i = 0; i < count; i++) {
      sec = secs[i];
      if (sec < 0) continue;
      row = rows[i];
      kind = toInt(row.associated_message_type);
      if (kind >= 1000) continue;                   // tapbacks, stickers, poll votes
      if (flag(row.item_type)) continue;            // group events
      if (!(sec >= segLo && sec < segHi)) {
        var s = table.index(sec);
        segOff = offsets[s];
        segLo = starts[s];
        segHi = s + 1 < starts.length ? starts[s + 1] : MAX_UNIX + DAY;
      }
      var local = sec + segOff;
      var day = Math.floor(local / DAY);
      if (day > endDay || (startDay !== null && day < startDay)) continue;
      var text = row.text;
      if (typeof text !== 'string') {
        // raw UTF-8 bytes are fine; any other type is not text at all
        var raw = blob(text);
        text = raw && raw.length ? utf8(raw, 0, raw.length) : null;
      }
      if (!text) {
        var body = blob(row.attributedBody);
        text = body ? decodeAttributedBody(body) : null;
      }
      text = cleanText(text);
      var hasAttachment = flag(row.cache_has_attachments) ? 1 : 0;
      if (!text && !hasAttachment && !flag(row.keep_empty)) continue;   // unsent or empty

      var sender = flag(row.is_from_me) ? me : names.handle(row.handle);
      var counters = people.get(sender);
      if (!counters) { counters = [0, 0, 0, 0, 0, 0, 0]; people.set(sender, counters); }
      var nWords = countWords(text);
      var hour = Math.floor((local - day * DAY) / 3600);
      total++;
      wordsTotal += nWords;
      counters[MSG]++;
      counters[WORDS] += nWords;
      if (hasAttachment) { attachmentsTotal++; counters[ATT]++; }
      if (hour < LATE_NIGHT_HOURS) counters[LATE]++;
      byHour[hour]++;
      dayCounts.set(day, (dayCounts.get(day) || 0) + 1);
      if (firstDay === null || day < firstDay) firstDay = day;
      if (haveStanding && typeof row.guid === 'string') {
        var marks = standing.get(row.guid);
        if (marks) {
          reacted.push({
            sec: sec, frac: fracs[i], rowid: toInt(row.rowid), index: i, sender: sender, day: day,
            text: text, attachment: hasAttachment, marks: marks, kinds: null
          });
        }
      }
    }

    // ---- standing tapbacks on those messages
    var byKind = [0, 0, 0, 0, 0, 0, 0];
    var givers = new Map();
    reacted.forEach(function (q) {
      var kinds = [0, 0, 0, 0, 0, 0, 0];
      for (var m = 0; m < q.marks.length; m++) {
        var who = q.marks[m][0];
        var k = q.marks[m][1];
        kinds[k]++;
        byKind[k]++;
        givers.set(who, (givers.get(who) || 0) + 1);
      }
      var c = people.get(q.sender);
      c[RECV] += q.marks.length;
      c[LAUGHS] += kinds[LAUGH];
      q.kinds = kinds;
    });
    givers.forEach(function (n, who) {
      var c = people.get(who);
      if (c) c[GIVEN] = n;
    });
    var reactionsTotal = sum(byKind);

    // ---- calendar aggregates
    var byWeekday = [0, 0, 0, 0, 0, 0, 0];
    var byMonth = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    var busiest = null;
    var longest = 0, run = 0, previous = null;
    Array.from(dayCounts.keys()).sort(function (a, b) { return a - b; }).forEach(function (day) {
      var n = dayCounts.get(day);
      byWeekday[(((day + 3) % 7) + 7) % 7] += n;      // 1970-01-01 was a Thursday
      byMonth[civilFromDays(day)[1] - 1] += n;
      if (busiest === null || n > busiest[1]) busiest = [day, n];
      run = previous !== null && day === previous + 1 ? run + 1 : 1;
      if (run > longest) longest = run;
      previous = day;
    });

    if (startDay === null) startDay = firstDay !== null ? firstDay : endDay;
    if (label === null) label = iso(startDay) + ' \u2013 ' + iso(endDay);

    // ---- people
    var ranked = Array.from(people.entries()).sort(function (a, b) {
      return (b[1][MSG] - a[1][MSG]) || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
    });
    var senders = ranked.slice(0, MAX_SENDERS).map(function (entry) {
      var c = entry[1];
      return {
        name: entry[0],
        messages: c[MSG],
        share: round4(c[MSG], total),
        words: c[WORDS],
        attachments: c[ATT],
        late_night: c[LATE],
        reactions_given: c[GIVEN],
        reactions_received: c[RECV]
      };
    });
    var lateTotal = sum(byHour, 0, LATE_NIGHT_HOURS);
    var lateTop = top(people, LATE, 1, null);

    // the top giver may be someone who reacted without ever writing
    var topGiver = null;
    var giverMessages = 0;
    givers.forEach(function (n, who) {
      var messages = people.has(who) ? people.get(who)[MSG] : 0;
      if (topGiver === null || n > topGiver.count ||
          (n === topGiver.count && (messages > giverMessages ||
            (messages === giverMessages && who < topGiver.name)))) {
        topGiver = { name: who, count: n };
        giverMessages = messages;
      }
    });
    var topReceiver = top(people, RECV, 1, null);

    reacted.sort(function (a, b) {
      return (b.marks.length - a.marks.length) || (a.sec - b.sec) || (a.frac - b.frac) ||
        (a.rowid - b.rowid) || (a.index - b.index);
    });
    var mostReacted = reacted.slice(0, 3).map(function (q) {
      var order = [0, 1, 2, 3, 4, 5, 6].sort(function (a, b) {
        return (q.kinds[b] - q.kinds[a]) || (a - b);
      });
      var kinds = {};
      order.forEach(function (k) { if (q.kinds[k]) kinds[KINDS[k]] = q.kinds[k]; });
      var entry = {
        sender: q.sender,
        reactions: q.marks.length,
        date: iso(q.day),
        text: truncate(q.text, MAX_QUOTE),
        kinds: kinds
      };
      if (q.attachment) entry.attachment = true;
      return entry;
    });

    var members = new Set(people.keys());
    members.add(me);
    var resolved = resolveAll(names, opts.participants);
    resolved.forEach(function (name) { members.add(name); });
    var chatName = chatLabel(opts.chat_name);
    if (!chatName) chatName = fallbackName(resolved, me);

    var byKindObject = {};
    KINDS.forEach(function (name, k) { byKindObject[name] = byKind[k]; });

    return {
      v: 1,
      chat: { name: chatName, members: members.size },
      period: { label: label, start: iso(startDay), end: iso(endDay) },
      totals: {
        messages: total,
        words: wordsTotal,
        attachments: attachmentsTotal,
        reactions: reactionsTotal,
        days_active: dayCounts.size,
        longest_streak: longest
      },
      by_hour: byHour,
      by_weekday: byWeekday,
      by_month: byMonth,
      busiest_day: busiest ? { date: iso(busiest[0]), messages: busiest[1] } : null,
      personality: personality(byHour, byWeekday, total),
      late_night: {
        messages: lateTotal,
        share: round4(lateTotal, total),
        top: lateTop ? { name: lateTop[0], messages: lateTop[1] } : null
      },
      senders: senders,
      most_reacted: mostReacted,
      reactions: {
        by_kind: byKindObject,
        top_giver: topGiver,
        top_receiver: topReceiver ? { name: topReceiver[0], count: topReceiver[1] } : null
      },
      awards: awards(people),
      meta: {
        generator: opts.generator || GENERATOR,
        source: cleanName(opts.source, NAME_LIMIT) || 'chat.db',
        generated: iso(today)
      }
    };
  }

  // ------------------------------------------------------------------ //
  // short names
  // ------------------------------------------------------------------ //

  function isRecord(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
  }

  /** Every place a finished stats object names a person: [container, key]. */
  function nameSlots(stats) {
    var slots = [];
    function add(container, key) {
      if (isRecord(container) && typeof container[key] === 'string') slots.push([container, key]);
    }
    function each(items, key) {
      if (Array.isArray(items)) items.forEach(function (item) { add(item, key); });
    }
    if (!isRecord(stats)) return slots;
    each(stats.senders, 'name');
    add(isRecord(stats.late_night) ? stats.late_night.top : null, 'name');
    each(stats.most_reacted, 'sender');
    if (isRecord(stats.reactions)) {
      add(stats.reactions.top_giver, 'name');
      add(stats.reactions.top_receiver, 'name');
    }
    each(stats.awards, 'winner');
    return slots;
  }

  /**
   * Map(full name -> short name) for the people of one recap (see shortNames).
   * The rule is applied to what may be shown at all: every name is first
   * cleaned, capped and masked again (which changes nothing for names that
   * computeStats produced), so a short form can never bring back a number or
   * an address that a stats object from somewhere else still holds.
   */
  function shortForms(names, me) {
    var given = distinct(Array.prototype.filter.call(names, function (name) { return typeof name === 'string'; }));
    var shown = new Map();
    given.forEach(function (name) { shown.set(name, personLabel(name) || 'Unknown'); });
    var short = shortFormsOf(distinct(given.map(function (name) { return shown.get(name); })),
      personLabel(me == null ? 'Me' : me) || 'Me');
    var result = new Map();
    given.forEach(function (name) { result.set(name, short.get(shown.get(name))); });
    return result;
  }

  function shortFormsOf(people, me) {
    var fixed = new Set(people.filter(function (name) { return name === me || name.charAt(0) === '\u2026'; }));
    var result = new Map();
    var groups = new Map();
    people.forEach(function (name) {
      var words = splitWords(name);
      var label = fixed.has(name) || !words.length ? name : words[0];
      result.set(name, label);
      if (!groups.has(label)) groups.set(label, []);
      groups.get(label).push(name);
    });
    groups.forEach(function (members) {
      if (members.length < 2) return;
      members.forEach(function (name) {       // same first word: "Sam R.", "Sam C."
        var words = splitWords(name);
        if (!fixed.has(name) && words.length) {
          result.set(name, words[0] + ' ' + String.fromCodePoint(words[words.length - 1].codePointAt(0)) + '.');
        }
      });
    });
    var taken = new Map();
    result.forEach(function (label) { taken.set(label, (taken.get(label) || 0) + 1); });
    people.forEach(function (name) {          // still not unique: the full name
      if (!fixed.has(name) && taken.get(result.get(name)) > 1) result.set(name, name);
    });
    return result;
  }

  /**
   * A copy of a finished stats object with every person's name shortened
   * (docs/SCHEMA.md 2, "Short names"). Contact names are the owner's private
   * labels ("Dave plumber"), so what people see by default is the first word.
   * `me` is the owner's name as it appears in the stats (default "Me"); it
   * and masked labels (starting with an ellipsis) are left alone. Two
   * different people with the same first word become "Sam R." and "Sam C.";
   * if that still collides they keep their full names. Names are replaced
   * consistently in senders, late_night.top, most_reacted[].sender,
   * reactions.top_giver, reactions.top_receiver and awards[].winner. The
   * input is not modified; computeStats itself always returns full names.
   */
  function shortNames(stats, me) {
    if (stats === undefined) return stats;
    var out = jsonCopy(stats);
    var slots = nameSlots(out);
    var mapping = shortForms(slots.map(function (slot) { return slot[0][slot[1]]; }), me);
    slots.forEach(function (slot) { slot[0][slot[1]] = mapping.get(slot[0][slot[1]]); });
    return out;
  }

  // ------------------------------------------------------------------ //
  // link payload (section 5)
  // ------------------------------------------------------------------ //

  var B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  var B64_VALUE = (function () {
    var table = new Int16Array(128).fill(-1);
    for (var i = 0; i < B64.length; i++) table[B64.charCodeAt(i)] = i;
    table[43] = 62;   // "+" and "/" of ordinary base64 are accepted too
    table[47] = 63;
    return table;
  })();
  var MAX_DECODED_BYTES = 8 * 1024 * 1024;

  function base64urlEncode(bytes) {
    var out = [];
    var chunk = '';
    for (var i = 0; i < bytes.length; i += 3) {
      var a = bytes[i];
      var b = i + 1 < bytes.length ? bytes[i + 1] : 0;
      var c = i + 2 < bytes.length ? bytes[i + 2] : 0;
      chunk += B64[a >> 2] + B64[((a & 3) << 4) | (b >> 4)];
      if (i + 1 < bytes.length) chunk += B64[((b & 15) << 2) | (c >> 6)];
      if (i + 2 < bytes.length) chunk += B64[c & 63];
      if (chunk.length > 8192) { out.push(chunk); chunk = ''; }
    }
    out.push(chunk);
    return out.join('');
  }

  function base64urlDecode(text) {
    var clean = text.replace(/=+$/, '');
    if (clean.length % 4 === 1) throw new Error('payload is not base64url');
    var out = new Uint8Array(Math.floor(clean.length * 3 / 4));
    var bits = 0, held = 0, n = 0;
    for (var i = 0; i < clean.length; i++) {
      var code = clean.charCodeAt(i);
      var value = code < 128 ? B64_VALUE[code] : -1;
      if (value < 0) throw new Error('payload is not base64url');
      held = (held << 6) | value;
      bits += 6;
      if (bits >= 8) {
        bits -= 8;
        out[n++] = (held >> bits) & 255;
      }
    }
    return out;
  }

  var codec = null;

  /**
   * Supply the raw-DEFLATE functions explicitly:
   * {deflateRaw(Uint8Array) -> Uint8Array, inflateRaw(Uint8Array) -> Uint8Array},
   * or an fflate module ({deflateSync, inflateSync}). Pass null to go back to
   * automatic detection (global `fflate`, then Node's zlib).
   */
  function useCodec(next) {
    if (next && next.deflateSync && next.inflateSync) {
      var lib = next;
      next = {
        deflateRaw: function (bytes) { return lib.deflateSync(bytes, { level: 9 }); },
        inflateRaw: function (bytes) { return lib.inflateSync(bytes); }
      };
    }
    codec = next || null;
  }

  function getCodec() {
    if (codec) return codec;
    if (root && root.fflate && root.fflate.deflateSync) {
      useCodec(root.fflate);
      return codec;
    }
    if (typeof require === 'function') {
      try {
        var zlib = require('zlib');
        codec = {
          deflateRaw: function (bytes) { return new Uint8Array(zlib.deflateRawSync(bytes, { level: 9 })); },
          inflateRaw: function (bytes) {
            return new Uint8Array(zlib.inflateRawSync(bytes, { maxOutputLength: MAX_DECODED_BYTES }));
          }
        };
        return codec;
      } catch (error) { /* not Node */ }
    }
    throw coded('no_codec', 'No DEFLATE implementation found: load js/vendor/fflate.min.js before engine.js');
  }

  /** Compact JSON; identical to the Python engine's canonical_json(). */
  function canonicalJson(stats) {
    return JSON.stringify(stats);
  }

  /** JSON text of plain data. Throws an Error with code "bad_stats" for anything else. */
  function jsonText(stats) {
    var text;
    try { text = JSON.stringify(stats); } catch (error) { text = undefined; }   // a BigInt, a cycle
    if (typeof text !== 'string') {
      throw coded('bad_stats', 'a recap must be plain JSON data (objects, lists, text and numbers)');
    }
    return text;
  }

  function jsonCopy(stats) {
    return JSON.parse(jsonText(stats));
  }

  /** Stats object -> base64url(raw DEFLATE(UTF-8 JSON)) without padding. */
  function encodePayload(stats) {
    var raw = new TextEncoder().encode(jsonText(stats));
    return base64urlEncode(getCodec().deflateRaw(raw));
  }

  function coded(code, message) {
    var error = new Error(message);
    error.code = code;
    return error;
  }

  /** Inverse of encodePayload. Throws an Error with code "bad_payload" on anything else. */
  function decodePayload(payload) {
    if (typeof payload !== 'string' || !payload) throw coded('bad_payload', 'empty payload');
    var packed;
    try {
      packed = base64urlDecode(trim(payload));
    } catch (error) {
      throw coded('bad_payload', 'payload is not base64url');
    }
    if (!packed.length) throw coded('bad_payload', 'payload is not base64url');
    var raw;
    try {
      raw = getCodec().inflateRaw(packed);
    } catch (error) {
      if (error && error.code === 'no_codec') throw error;
      throw coded('bad_payload', 'payload is not raw DEFLATE data');
    }
    if (raw.length > MAX_DECODED_BYTES) throw coded('bad_payload', 'payload expands to too much data');
    try {
      return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw));
    } catch (error) {
      throw coded('bad_payload', 'payload does not contain JSON');
    }
  }

  /** Pull the w1 payload out of a share URL ("#w1=" or "?w1="), or null. */
  function payloadFromUrl(url) {
    if (typeof url !== 'string') return null;
    var hash = url.indexOf('#');
    var before = hash === -1 ? url : url.slice(0, hash);
    var fragment = hash === -1 ? '' : url.slice(hash + 1);
    var question = before.indexOf('?');
    var query = question === -1 ? '' : before.slice(question + 1);
    var parts = [fragment, query];
    for (var p = 0; p < parts.length; p++) {
      var pieces = parts[p].split('&');
      for (var i = 0; i < pieces.length; i++) {
        if (pieces[i].slice(0, 3) === 'w1=') return pieces[i].slice(3);
      }
    }
    return null;
  }

  /** Decode the stats carried by a share URL. */
  function statsFromUrl(url) {
    var payload = payloadFromUrl(url);
    if (payload === null) throw coded('bad_payload', 'no w1= payload in this URL');
    return decodePayload(payload);
  }

  /** Blank every most_reacted[].text (in place): no message text. */
  function stripQuotes(stats) {
    var list = isRecord(stats) && Array.isArray(stats.most_reacted) ? stats.most_reacted : [];
    for (var i = 0; i < list.length; i++) {
      if (isRecord(list[i])) list[i].text = '';
    }
    return stats;
  }

  /**
   * Apply ladder step 1..6 to `stats` in place and return it:
   * 1 delete awards[].detail; 2 truncate most_reacted[].text to 60 characters
   * plus an ellipsis; 3 keep the first 8 senders; 4 keep the first
   * most_reacted entry; 5 delete awards; 6 keep the first 5 senders.
   * Sections that are missing or not of the expected type are left alone.
   */
  function applyTrimStep(stats, step) {
    var i, list;
    if (step === 1) {
      list = Array.isArray(stats.awards) ? stats.awards : [];
      for (i = 0; i < list.length; i++) {
        if (isRecord(list[i])) delete list[i].detail;
      }
    } else if (step === 2) {
      list = Array.isArray(stats.most_reacted) ? stats.most_reacted : [];
      for (i = 0; i < list.length; i++) {
        if (isRecord(list[i]) && typeof list[i].text === 'string') {
          list[i].text = truncate(list[i].text, SHORT_QUOTE);
        }
      }
    } else if (step === 3) {
      if (Array.isArray(stats.senders)) stats.senders = stats.senders.slice(0, 8);
    } else if (step === 4) {
      if (Array.isArray(stats.most_reacted)) stats.most_reacted = stats.most_reacted.slice(0, 1);
    } else if (step === 5) {
      delete stats.awards;
    } else if (step === 6) {
      if (Array.isArray(stats.senders)) stats.senders = stats.senders.slice(0, 5);
    } else {
      throw rangeError('there is no trim step ' + step);
    }
    return stats;
  }

  function linkOptions(options) {
    var o = options || {};
    return {
      quotes: !!o.quotes && o.no_quotes !== true && o.noQuotes !== true,
      baseUrl: o.base_url || o.baseUrl || BASE_URL,
      maxLength: o.max_length || o.maxLength || MAX_URL_LENGTH
    };
  }

  /**
   * Build the share link, trimming the stats only as far as needed.
   *
   * Message text is opt-in: unless options.quotes is true every
   * most_reacted[].text is blanked before encoding, so nothing puts message
   * content into a link by default. Other options: base_url, max_length
   * (default 4800). Returns {url, length, steps, stats}: `steps` ladder steps
   * were applied (0 = none) and `stats` is the copy that was encoded; the
   * input is never modified. Throws an Error with code "link_too_long" when
   * even step 6 is not enough, "bad_stats" when `stats` is not an object.
   */
  function fitLink(stats, options) {
    if (!isRecord(stats)) throw coded('bad_stats', 'a recap must be an object');
    var o = linkOptions(options);
    var trimmed = jsonCopy(stats);
    if (!o.quotes) stripQuotes(trimmed);
    var step = 0;
    for (;;) {
      var url = o.baseUrl + '#w1=' + encodePayload(trimmed);
      if (url.length <= o.maxLength) {
        return { url: url, length: url.length, steps: step, stats: trimmed };
      }
      if (step === TRIM_STEPS) {
        throw coded('link_too_long', 'This recap does not fit in a link: ' + url.length +
          ' characters after every trimming step, and the limit is ' + o.maxLength +
          '. Try a shorter chat name.');
      }
      step += 1;
      applyTrimStep(trimmed, step);
    }
  }

  /** The share URL for `stats`; see fitLink for the options (no message text by default). */
  function buildLink(stats, options) {
    return fitLink(stats, options).url;
  }

  return {
    PRODUCT_NAME: PRODUCT_NAME,
    GENERATOR: GENERATOR,
    BASE_URL: BASE_URL,
    MAX_URL_LENGTH: MAX_URL_LENGTH,
    TRIM_STEPS: TRIM_STEPS,
    KINDS: KINDS.slice(),
    computeStats: computeStats,
    decodeAttributedBody: decodeAttributedBody,
    chatDisplayName: chatDisplayName,
    contactKey: contactKey,
    NAME_LIMIT: NAME_LIMIT,
    CHAT_NAME_LIMIT: CHAT_NAME_LIMIT,
    maskHandle: maskHandle,
    maskChatName: maskChatName,
    cleanName: cleanName,
    shortNames: shortNames,
    buildContactLookup: buildContactLookup,
    cleanText: cleanText,
    countWords: countWords,
    dateToUnix: dateToUnix,
    canonicalJson: canonicalJson,
    encodePayload: encodePayload,
    decodePayload: decodePayload,
    payloadFromUrl: payloadFromUrl,
    statsFromUrl: statsFromUrl,
    stripQuotes: stripQuotes,
    applyTrimStep: applyTrimStep,
    fitLink: fitLink,
    buildLink: buildLink,
    useCodec: useCodec,
    // exposed for the tests and for web/make/db.js; not part of the page API
    _internals: {
      decodeWithStrategy: decodeWithStrategy, decodeFast: decodeFast,
      decodeStructural: decodeStructural, decodeScan: decodeScan, utf8: utf8, toBytes: toBytes,
      trim: trim, truncate: truncate, splitDate: function (v) { return splitDate(v) ? [dateSec, dateFrac] : null; },
      daysFromCivil: daysFromCivil, civilFromDays: civilFromDays, iso: iso,
      offsetFunction: offsetFunction, Offsets: Offsets, resolvePeriod: resolvePeriod,
      round4: round4, hour12: hour12, personality: personality, awards: awards,
      fallbackName: fallbackName, Names: Names, distinct: distinct, resolveAll: resolveAll,
      chatLabel: chatLabel, ownerName: ownerName, personLabel: personLabel, nameWindow: nameWindow,
      shortForms: shortForms, toInt: toInt, coded: coded,
      PERSONALITIES: PERSONALITIES, base64urlEncode: base64urlEncode,
      base64urlDecode: base64urlDecode
    }
  };
});
