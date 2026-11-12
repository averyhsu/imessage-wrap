/*
 * Threadback for Mac: the text recap and the command rule of the Python Mac
 * helper, line for line, so the app replies with exactly what the helper sends.
 *
 *   wrapped/mac/text.py      recapLines, emptyText, assertSafe
 *   wrapped/mac/triggers.py  parseTrigger, startsWithTrigger
 *   wrapped/mac/fmt.py       clean, firstName, maskLabel, safeChatName, displayNames,
 *                            fmtInt, fmtPct, hour12, shortDate, peakHour
 *
 * Loaded after engine.js (it uses WrappedEngine.maskChatName, as fmt.py uses
 * the engine's mask_chat_name). CI compares its output with the Python helper's
 * for the same chat (.github/workflows/mac-app.yml).
 */
(function (root) {
  'use strict';

  var Engine = root.WrappedEngine;
  var PRODUCT_NAME = 'Threadback';
  var MAX_INPUT = 2000;
  var MAX_CHAT_NAME = 60;
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  // ---- fmt.clean ---------------------------------------------------- //

  function range(a, b) { var out = []; for (var i = a; i < b; i++) out.push(i); return out; }

  var REMOVED = [].concat(
    range(0x00, 0x20), range(0x7F, 0xA0),
    [0x00AD, 0x034F, 0x061C, 0x115F, 0x1160, 0x17B4, 0x17B5],
    range(0x180B, 0x1810),
    [0x200B, 0x200E, 0x200F],
    range(0x202A, 0x202F),
    range(0x2060, 0x2070),
    [0x3164, 0xFEFF, 0xFFA0],
    range(0xFFF9, 0xFFFE),
    range(0x1D173, 0x1D17B),
    range(0xE0000, 0xE0080)
  );
  var SPACES = [0x09, 0x0A, 0x0B, 0x0C, 0x0D, 0x85, 0xA0, 0x1680, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000]
    .concat(range(0x2000, 0x200B));
  var UNSAFE = new Map();
  REMOVED.forEach(function (cp) { UNSAFE.set(cp, ''); });
  SPACES.forEach(function (cp) { UNSAFE.set(cp, ' '); });
  // Python's str.isspace() set (what \s and strip() use there).
  var PY_SPACE = new Set([0x09, 0x0A, 0x0B, 0x0C, 0x0D, 0x1C, 0x1D, 0x1E, 0x1F, 0x20, 0x85, 0xA0, 0x1680,
    0x2028, 0x2029, 0x202F, 0x205F, 0x3000].concat(range(0x2000, 0x200B)));

  function codePoints(s) { return Array.from(s); }

  function str(value) {
    if (value === null || value === undefined) return '';
    if (value === true) return 'True';
    if (value === false) return 'False';
    return String(value);
  }

  function isPySpace(ch) { return PY_SPACE.has(ch.codePointAt(0)); }

  function pyStrip(s, extra) {
    var cps = codePoints(s);
    var test = extra ? function (ch) { return extra.indexOf(ch) !== -1; } : isPySpace;
    var a = 0, b = cps.length;
    while (a < b && test(cps[a])) a++;
    while (b > a && test(cps[b - 1])) b--;
    return cps.slice(a, b).join('');
  }

  function translateUnsafe(s) {
    var out = '';
    for (var ch of s) {
      var cp = ch.codePointAt(0);
      out += UNSAFE.has(cp) ? UNSAFE.get(cp) : ch;
    }
    return out;
  }

  function collapse(s) {
    var out = '';
    var space = false;
    for (var ch of s) {
      if (isPySpace(ch)) { space = true; continue; }
      if (space) { out += ' '; space = false; }
      out += ch;
    }
    if (space) out += ' ';
    return out;
  }

  /** fmt.clean: safe to draw, print, log or send. */
  function clean(text, limit) {
    var s = str(text);
    var cps = codePoints(s);
    if (cps.length > MAX_INPUT) s = cps.slice(0, MAX_INPUT).join('');
    s = pyStrip(collapse(translateUnsafe(s)));
    if (limit !== undefined && limit !== null) {
      cps = codePoints(s);
      if (cps.length > limit) {
        var head = cps.slice(0, Math.max(1, limit - 1));
        while (head.length && (head[head.length - 1] === '\u200D' || head[head.length - 1] === '\uFE0F' ||
          head[head.length - 1] === ' ')) head.pop();   // rstrip(_JOINERS)
        s = head.join('') + '\u2026';
      }
    }
    return s;
  }

  // ---- numbers and dates -------------------------------------------- //

  function toInt(value) {
    if (typeof value === 'number') {
      if (!isFinite(value)) throw new Error('not an integer');
      return Math.trunc(value);
    }
    if (value === true) return 1;
    if (value === false) return 0;
    if (typeof value === 'string' && /^\s*[-+]?\d+\s*$/.test(value)) return parseInt(value, 10);
    throw new Error('not an integer');
  }

  function fmtInt(n) {
    var v;
    try { v = toInt(n); } catch (e) { return '0'; }
    var sign = v < 0 ? '-' : '';
    var digits = String(Math.abs(v));
    var out = '';
    while (digits.length > 3) { out = ',' + digits.slice(-3) + out; digits = digits.slice(0, -3); }
    return sign + digits + out;
  }

  function toFloat(value) {
    if (typeof value === 'number') return value;
    if (value === true) return 1;
    if (value === false) return 0;
    if (typeof value === 'string' && value.trim() !== '' && !isNaN(Number(value))) return Number(value);
    throw new Error('not a number');
  }

  function fmtPct(share) {
    var x;
    try { x = toFloat(share) * 100.0; } catch (e) { return '0%'; }
    if (x > 0 && x < 1) return '<1%';
    return Math.trunc(x + 0.5) + '%';
  }

  function hour12(h) {
    var v;
    try { v = toInt(h); } catch (e) { return ''; }
    v = ((v % 24) + 24) % 24;
    return (v % 12 || 12) + ' ' + (v < 12 ? 'AM' : 'PM');
  }

  function shortDate(iso) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(str(iso || ''));
    if (!m) return '';
    var month = Number(m[2]), day = Number(m[3]);
    if (month < 1 || month > 12) return '';
    return MONTHS[month - 1] + ' ' + day;
  }

  function asInt(x) {
    try { return Math.max(0, toInt(x)); } catch (e) { return 0; }
  }

  function byHour(stats) {
    var h = stats.by_hour;
    if (Array.isArray(h) && h.length === 24) return h.map(asInt);
    var legacy = stats.messages_by_hour;
    if (legacy && typeof legacy === 'object' && !Array.isArray(legacy)) {
      return range(0, 24).map(function (i) { var v = legacy[String(i)]; return asInt(v === undefined ? 0 : v); });
    }
    return [];
  }

  function peakHour(stats) {
    var p = (stats.personality || {}).peak_hour;
    if (typeof p === 'number' && Number.isInteger(p) && p >= 0 && p <= 23) return p;
    var hours = byHour(stats);
    if (hours.length) {
      var max = Math.max.apply(null, hours);
      if (max > 0) return hours.indexOf(max);
    }
    return null;
  }

  // ---- names ------------------------------------------------------ //

  var RUN = /[^\s<>()\[\]"',;:\u001c-\u001f\u0085]+/g;

  function maskLabel(label) {
    var s = clean(label);
    var match;
    RUN.lastIndex = 0;
    while ((match = RUN.exec(s)) !== null) {
      var run = codePoints(match[0]);
      var at = run.indexOf('@');
      if (at > 0 && at < run.length - 1) {
        var local = run.slice(0, at);
        return local.length <= 16 ? local.join('') : local.slice(0, 16).join('') + '\u2026';
      }
    }
    var digits = codePoints(s).filter(function (ch) { return /^\p{Nd}$/u.test(ch); });
    if (digits.length >= 7) return '\u2026' + digits.slice(-4).join('');
    return s;
  }

  function firstName(name) {
    var s = clean(name);
    if (!s) return '?';
    if (s.charAt(0) === '\u2026') return codePoints(s).slice(0, 17).join('');
    var masked = maskLabel(s);
    if (masked !== s) return masked;
    var first = codePoints(s.split(' ')[0]);
    return first.length <= 16 ? first.join('') : first.slice(0, 15).join('') + '\u2026';
  }

  function safeChatName(name, limit) {
    var parts = clean(name).split(/(, | & )/);
    for (var i = 0; i < parts.length; i++) {
      var part = parts[i];
      if (part === ', ' || part === ' & ' || part.charAt(0) === '\u2026') continue;
      parts[i] = Engine.maskChatName(part);
    }
    return clean(parts.join(''), limit === undefined ? MAX_CHAT_NAME : limit);
  }

  /** {cleaned name: short display name}, as a Map (keeps insertion order like a dict). */
  function displayNames(names) {
    var full = [];
    var seenFull = new Set();
    names.forEach(function (n) {
      var c = clean(n);
      if (!seenFull.has(c)) { seenFull.add(c); full.push(c); }
    });
    var shown = new Map();
    full.forEach(function (name) { shown.set(name, firstName(name)); });
    function clashes() {
      var values = full.map(function (n) { return shown.get(n); });
      return full.filter(function (n) {
        var v = shown.get(n);
        return values.filter(function (x) { return x === v; }).length > 1;
      });
    }
    clashes().forEach(function (name) {
      var current = shown.get(name);
      if (current.charAt(0) === '\u2026' || current !== name.split(' ')[0]) return;
      var rest = name.split(' ').slice(1);
      var initial = '';
      for (var i = 0; i < rest.length; i++) {
        var head = codePoints(rest[i])[0];
        if (head !== undefined && /^\p{L}$/u.test(head)) { initial = head; break; }
      }
      if (initial) shown.set(name, current + ' ' + initial.toUpperCase() + '.');
    });
    var seen = new Map();
    clashes().forEach(function (name) {
      var v = shown.get(name);
      seen.set(v, (seen.get(v) || 0) + 1);
      if (seen.get(v) > 1) shown.set(name, v + ' ' + seen.get(v));
    });
    return shown;
  }

  // ---- triggers (triggers.py) --------------------------------------- //

  var INVISIBLE = /[\uFFFC\uFFFD\u200B\u200C\u200D\u200E\u200F\u2060\uFEFF]/g;
  var MIN_YEAR = 2007;
  var TRIGGER = /^\/(wrapped|recap)(?:[\s\u001c-\u001f\u0085]+(\d{4}|all))?$/i;
  var STARTS = /^\/[\s\u001c-\u001f\u0085]*(wrapped|recap)/i;

  function normalize(text) {
    if (!text) return '';
    return pyStrip(String(text).normalize('NFKC').replace(INVISIBLE, ''));
  }

  /** {command, period} or null. period: null (default), "all" or "2025". */
  function parseTrigger(text, currentYear) {
    var m = TRIGGER.exec(normalize(text));
    if (!m) return null;
    var command = m[1].toLowerCase();
    var arg = m[2];
    if (arg === undefined) return { command: command, period: null };
    if (arg.toLowerCase() === 'all') return { command: command, period: 'all' };
    var year = parseInt(arg, 10);
    if (year < MIN_YEAR || (currentYear != null && year > currentYear)) return null;
    return { command: command, period: String(year) };
  }

  function startsWithTrigger(line) {
    return STARTS.test(normalize(line));
  }

  // ---- text.py ------------------------------------------------------ //

  var PERSONALITY_EMOJI = {
    quiet_ones: '\uD83E\uDD2B', night_owls: '\uD83E\uDD89', weekend_warriors: '\uD83C\uDF89',
    always_on: '\uD83D\uDD0B', early_birds: '\uD83D\uDC26', morning_meeting: '\u2615',
    lunch_break: '\uD83E\uDD6A', afternoon_slackers: '\uD83D\uDE0E', dinner_table: '\uD83C\uDF7D\uFE0F',
    after_hours: '\uD83C\uDF19'
  };
  var MEDALS = ['\uD83E\uDD47', '\uD83E\uDD48', '\uD83E\uDD49'];

  function isDict(x) { return x !== null && typeof x === 'object' && !Array.isArray(x); }
  function or(x, fallback) { return x ? x : fallback; }
  function plural(n, one, many) { return fmtInt(n) + ' ' + (n === 1 ? one : many); }
  function lookup(map, key) { return map.has(key) ? map.get(key) : undefined; }

  function safeLine(line) {
    line = clean(line);
    while (startsWithTrigger(line)) line = '\u00B7 ' + line;
    return line;
  }

  function recapLines(stats, withLink) {
    if (withLink === undefined) withLink = true;
    var chat = or(stats.chat, {});
    var period = or(stats.period, {});
    var totals = or(stats.totals, {});
    var senders = (or(stats.senders, [])).filter(isDict);
    var names = displayNames(senders.map(function (s) { return s.name; }));

    var chatName = clean(safeChatName(chat.name), 60) || 'This chat';
    var label = clean(period.label, 24);
    var lines = [];
    lines.push(label ? '\uD83E\uDDF5 ' + chatName + ' \u2014 ' + label + ' in review' : '\uD83E\uDDF5 ' + chatName + ' in review');

    var messages = toInt(or(totals.messages, 0));
    var parts = [plural(messages, 'message', 'messages')];
    var days = toInt(or(totals.days_active, 0));
    if (days) parts.push(plural(days, 'active day', 'active days'));
    var streak = toInt(or(totals.longest_streak, 0));
    if (streak >= 3) parts.push(fmtInt(streak) + '-day streak');
    lines.push('\uD83D\uDCAC ' + parts.join(' \u00B7 '));

    var personality = or(stats.personality, {});
    var title = clean(personality.title, 40);
    var peak = peakHour(stats);
    if (title) {
      var key = str(personality.id === undefined ? null : personality.id);
      if (personality.id === null || personality.id === undefined) key = 'None';
      var emoji = Object.prototype.hasOwnProperty.call(PERSONALITY_EMOJI, key) ? PERSONALITY_EMOJI[key] : '\u2728';
      var tail = peak !== null ? ' \u2014 peak hour ' + hour12(peak) : '';
      lines.push(emoji + ' You are ' + title + tail);
    } else if (peak !== null) {
      lines.push('\u23F0 Peak hour: ' + hour12(peak));
    }

    var podium = [];
    senders.slice(0, 3).forEach(function (s, i) {
      var shown = lookup(names, clean(s.name));
      podium.push(MEDALS[i] + ' ' + (shown === undefined ? 'Someone' : shown) + ' ' + fmtPct(s.share));
    });
    if (podium.length) lines.push(podium.join(' \u00B7 '));

    var awards = [];
    (or(stats.awards, [])).slice(0, 3).forEach(function (a) {
      if (!isDict(a)) return;
      var aTitle = clean(a.title, 28);
      var winner = clean(a.winner);
      if (!aTitle || !winner) return;
      if (aTitle.toLowerCase().indexOf('the ') === 0) aTitle = codePoints(aTitle).slice(4).join('');
      awards.push(aTitle + ': ' + (lookup(names, winner) || firstName(winner)));
    });
    if (awards.length) lines.push('\uD83C\uDFC6 ' + awards.join(' \u00B7 '));

    var reactions = toInt(or(totals.reactions, 0));
    if (reactions > 0) {
      var line = '\u2764\uFE0F ' + plural(reactions, 'tapback', 'tapbacks');
      var giver = (or(or(stats.reactions, {}).top_giver, {})).name;
      if (giver) {
        var g = clean(giver);
        line += ' \u00B7 most generous: ' + (lookup(names, g) || firstName(g));
      }
      lines.push(line);
    }

    var busiest = or(stats.busiest_day, {});
    var day = shortDate(busiest.date);
    if (day && toInt(or(busiest.messages, 0)) > 0 && lines.length < 7) {
      lines.push('\uD83D\uDCC5 Busiest day: ' + day + ' (' + plural(toInt(busiest.messages), 'message', 'messages') + ')');
    }

    lines = lines.slice(0, 7);
    if (withLink) lines.push('\uD83D\uDC47 The full story is in the link below (' + PRODUCT_NAME + ')');
    return lines.map(safeLine);
  }

  function emptyText(stats) {
    var label = clean((or(stats.period, {})).label, 24);
    var where = label ? ' in ' + label : '';
    return safeLine('\uD83E\uDDF5 Nothing to recap' + where + ': no messages in this chat for that period.');
  }

  function assertSafe(message) {
    var lines = String(message).split(/\r\n|\r|\n|\u000b|\u000c|\u001c|\u001d|\u001e|\u0085|\u2028|\u2029/);
    for (var i = 0; i < lines.length; i++) {
      if (startsWithTrigger(lines[i])) throw new Error('refusing to send a line that looks like a command');
    }
  }

  root.ThreadbackText = {
    clean: clean,
    firstName: firstName,
    maskLabel: maskLabel,
    safeChatName: safeChatName,
    displayNames: function (names) { var m = displayNames(names); var o = {}; m.forEach(function (v, k) { o[k] = v; }); return o; },
    fmtInt: fmtInt,
    fmtPct: fmtPct,
    hour12: hour12,
    shortDate: shortDate,
    peakHour: peakHour,
    parseTrigger: parseTrigger,
    startsWithTrigger: startsWithTrigger,
    recapLines: recapLines,
    emptyText: emptyText,
    assertSafe: assertSafe,

    /** JSON in, JSON out, for Swift: {lines: [...]} or {empty: "..."} or {error}. */
    recapJSON: function (statsJSON, withLink) {
      try {
        var stats = JSON.parse(statsJSON);
        var messages = toInt(or((or(stats.totals, {})).messages, 0));
        if (messages <= 0) { var e = emptyText(stats); assertSafe(e); return JSON.stringify({ empty: e }); }
        var lines = recapLines(stats, !!withLink);
        assertSafe(lines.join('\n'));
        return JSON.stringify({ lines: lines });
      } catch (error) {
        return JSON.stringify({ error: String(error && error.message || error) });
      }
    },

    triggerJSON: function (text, currentYear) {
      return JSON.stringify(parseTrigger(text, currentYear));
    }
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
