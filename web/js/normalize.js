/*
 * normalize(raw) → a complete, sanitised stats object in the v1 shape (docs/SCHEMA.md §1).
 *
 * Everything that reaches the story goes through here first. Link payloads are untrusted
 * input, so every string is coerced, stripped of control characters and length-capped, and
 * every number is forced to a finite, non-negative value. Optional sections that are
 * missing come back as null / [] so slides can skip themselves. The legacy prototype keys
 * (messages_by_hour, messages_by_weekday, messages_by_month, …) are mapped onto v1.
 */
(function (root) {
  'use strict';

  var isNode = typeof module === 'object' && module.exports;
  var F = root.WrappedFormat || (isNode ? require('./format.js') : null);

  var KINDS = ['love', 'like', 'dislike', 'laugh', 'emphasize', 'question', 'emoji'];
  var MAX_SENDERS = 12;
  var MAX_AWARDS = 6;
  var MAX_MOST_REACTED = 3;

  // ── primitives ─────────────────────────────────────────────────────────────

  function isObj(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }

  /** No chat has more than this of anything; larger values in a link are capped to it. */
  var MAX_COUNT = 9999999999;

  function n(v) {
    if (typeof v === 'string') v = v.replace(/,/g, '');
    v = Number(v);
    if (!isFinite(v) || !(v > 0)) return 0; // NaN, ±Infinity (JSON "1e400"), zero, negatives
    return v < MAX_COUNT ? v : MAX_COUNT;
  }

  function i(v) { return Math.round(n(v)); }

  var INVISIBLE = /^[\s\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180B-\u180F\u200B-\u200F\u2060-\u2064\u206A-\u206F\u2800\u3164\uFE00-\uFE0F\uFEFF\uFFA0]*$/;

  function str(v, max) {
    if (v == null) return '';
    if (typeof v === 'object') return '';
    var s = String(v)
      // control characters, zero-width joiners used as padding, bidi overrides, object replacement
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069\uFFFC\uFFFD]/g, '')
      .replace(/[\r\n\t]+/g, ' ')
      .replace(/ {2,}/g, ' ')
      .trim();
    // Nothing in it would paint (zero-width characters, blank fillers): treat it as empty,
    // so a "blank message" never becomes an empty bubble and a blank name gets its fallback.
    if (INVISIBLE.test(s)) return '';
    var chars = Array.from(s);
    return chars.length > max ? chars.slice(0, max).join('') : s;
  }

  function first() {
    for (var k = 0; k < arguments.length; k++) {
      if (arguments[k] !== undefined && arguments[k] !== null && arguments[k] !== '') return arguments[k];
    }
    return undefined;
  }

  function round4(x) { return Math.round(x * 10000) / 10000; }

  function share(v, part, total) {
    var s = Number(v);
    if (isFinite(s) && s >= 0) {
      if (s > 1) s = s / 100; // someone wrote a percentage
      return Math.min(1, round4(s));
    }
    return total > 0 ? Math.min(1, round4(part / total)) : 0;
  }

  // ── buckets ────────────────────────────────────────────────────────────────

  var WEEKDAY_KEYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
  var MONTH_KEYS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

  /** Arrays are padded/trimmed; objects are mapped by key with `indexOf(key, keys)`. */
  function buckets(value, size, indexOf) {
    var out = [];
    var k;
    for (k = 0; k < size; k++) out.push(0);
    if (Array.isArray(value)) {
      for (k = 0; k < size && k < value.length; k++) out[k] = i(value[k]);
    } else if (isObj(value)) {
      var keys = Object.keys(value);
      for (k = 0; k < keys.length; k++) {
        var idx = indexOf(keys[k], keys);
        if (idx >= 0 && idx < size) out[idx] = Math.min(MAX_COUNT, out[idx] + i(value[keys[k]]));
      }
    }
    return out;
  }

  function hourIndex(key) {
    var m = /^\s*(\d{1,2})/.exec(key);
    return m ? +m[1] : -1;
  }

  function weekdayIndex(key) {
    var named = WEEKDAY_KEYS.indexOf(String(key).trim().slice(0, 3).toLowerCase());
    if (named !== -1) return named;
    var m = /^\s*(\d)\s*$/.exec(key);
    return m ? +m[1] : -1; // 0 = Monday, like Python's date.weekday()
  }

  function monthIndex(key, keys) {
    var text = String(key).trim();
    var named = MONTH_KEYS.indexOf(text.slice(0, 3).toLowerCase());
    if (named !== -1) return named;
    var ym = /^\d{4}-(\d{1,2})$/.exec(text);
    if (ym) return +ym[1] - 1;
    var m = /^(\d{1,2})$/.exec(text);
    if (!m) return -1;
    // "0".."11" when a zero key exists, otherwise calendar numbers "1".."12".
    var zeroBased = keys.some(function (k) { return /^0+$/.test(String(k).trim()); });
    return zeroBased ? +m[1] : +m[1] - 1;
  }

  // ── personality (docs/SCHEMA.md §3), used when the input has none ───────────

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

  function personalityId(byHour, byWeekday, total) {
    var peak = F.argmax(byHour);
    if (total < 50) return 'quiet_ones';
    if (peak < 0) return null;
    var night = (byHour[0] + byHour[1] + byHour[2] + byHour[3] + byHour[4]) / total;
    if (night >= 0.12 || peak <= 4) return 'night_owls';
    if ((byWeekday[5] + byWeekday[6]) / total >= 0.42) return 'weekend_warriors';
    if (byHour[peak] / total < 0.065) return 'always_on';
    if (peak <= 8) return 'early_birds';
    if (peak <= 11) return 'morning_meeting';
    if (peak <= 13) return 'lunch_break';
    if (peak <= 17) return 'afternoon_slackers';
    if (peak <= 20) return 'dinner_table';
    return 'after_hours';
  }

  function computePersonality(byHour, byWeekday, total) {
    var id = personalityId(byHour, byWeekday, total);
    if (!id) return null;
    var peak = F.argmax(byHour);
    var def = PERSONALITIES[id];
    return {
      id: id,
      title: def[0],
      blurb: (peak >= 0 ? 'Peak hour: ' + F.hour(peak) + '. ' : '') + def[1],
      peak_hour: peak >= 0 ? peak : 0
    };
  }

  // ── sections ───────────────────────────────────────────────────────────────

  function readSenders(raw, total) {
    var src = first(raw.senders, raw.top_senders, raw.messages_by_sender, raw.by_sender);
    var list = [];
    if (Array.isArray(src)) {
      src.forEach(function (s) {
        if (Array.isArray(s)) list.push({ name: s[0], messages: s[1] });
        else if (isObj(s)) list.push(s);
      });
    } else if (isObj(src)) {
      Object.keys(src).forEach(function (name) {
        var v = src[name];
        list.push(isObj(v) ? Object.assign({ name: name }, v) : { name: name, messages: v });
      });
    }
    var out = [];
    list.forEach(function (s) {
      var name = str(first(s.name, s.sender, s.handle), 60);
      var messages = i(first(s.messages, s.count, s.total, s.message_count));
      if (!name) return;
      out.push({
        name: name,
        messages: messages,
        share: share(s.share, messages, total),
        words: i(s.words),
        attachments: i(s.attachments),
        late_night: i(s.late_night),
        reactions_given: i(s.reactions_given),
        reactions_received: i(s.reactions_received)
      });
    });
    out.sort(function (a, b) { return b.messages - a.messages || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0); });
    return out.slice(0, MAX_SENDERS);
  }

  function readKinds(src) {
    var out = {};
    if (!isObj(src)) return out;
    // Own entries only: a payload cannot reach Object.prototype through a kind name.
    KINDS.forEach(function (k) {
      if (Object.prototype.hasOwnProperty.call(src, k) && i(src[k]) > 0) out[k] = i(src[k]);
    });
    // Unknown kinds (stickers and the like) are reported as "emoji", per the counting rules.
    Object.keys(src).forEach(function (k) {
      if (KINDS.indexOf(k) === -1 && i(src[k]) > 0) out.emoji = Math.min(MAX_COUNT, (out.emoji || 0) + i(src[k]));
    });
    return out;
  }

  function readMostReacted(raw) {
    var src = first(raw.most_reacted, raw.most_reacted_messages);
    if (!Array.isArray(src)) return [];
    var out = [];
    src.forEach(function (m) {
      if (!isObj(m)) return;
      var kinds = readKinds(m.kinds);
      var reactions = i(first(m.reactions, m.count));
      if (!reactions) reactions = Math.min(MAX_COUNT, F.sum(Object.keys(kinds).map(function (k) { return kinds[k]; })));
      var sender = str(first(m.sender, m.name), 60);
      if (!sender && !reactions) return;
      out.push({
        sender: sender || 'Someone',
        reactions: reactions,
        date: F.parseDate(m.date) ? String(m.date).slice(0, 10) : '',
        text: str(m.text, 400),
        kinds: kinds
      });
    });
    return out.slice(0, MAX_MOST_REACTED);
  }

  function readPerson(v, countKey) {
    if (!isObj(v)) return null;
    var name = str(v.name, 60);
    if (!name) return null;
    var out = { name: name };
    out[countKey] = i(first(v[countKey], v.count, v.messages));
    return out;
  }

  function readReactions(raw, totalReactions) {
    var src = isObj(raw.reactions) ? raw.reactions : {};
    var kindsSrc = first(src.by_kind, raw.reactions_by_kind, raw.reactions_by_type);
    var byKind = {};
    KINDS.forEach(function (k) { byKind[k] = 0; });
    var seen = readKinds(kindsSrc);
    Object.keys(seen).forEach(function (k) { byKind[k] = seen[k]; });
    var kindTotal = F.sum(KINDS.map(function (k) { return byKind[k]; }));
    var giver = readPerson(src.top_giver, 'count');
    var receiver = readPerson(src.top_receiver, 'count');
    if (!kindTotal && !totalReactions && !giver && !receiver) return null;
    return { by_kind: byKind, top_giver: giver, top_receiver: receiver };
  }

  function readAwards(raw) {
    if (!Array.isArray(raw.awards)) return [];
    var out = [];
    raw.awards.forEach(function (a) {
      if (!isObj(a)) return;
      var title = str(a.title, 48);
      var winner = str(first(a.winner, a.name), 60);
      if (!title || !winner) return;
      var award = { id: str(a.id, 32), emoji: str(a.emoji, 12), title: title, winner: winner, detail: str(a.detail, 140) };
      if (a.ai === true) award.ai = true;
      out.push(award);
    });
    return out.slice(0, MAX_AWARDS);
  }

  function readBusiestDay(raw) {
    var b = raw.busiest_day;
    var date, messages;
    if (isObj(b)) { date = b.date; messages = first(b.messages, b.count); }
    else if (Array.isArray(b)) { date = b[0]; messages = b[1]; }
    else if (typeof b === 'string') { date = b; messages = first(raw.busiest_day_count, raw.busiest_day_messages); }
    if (!F.parseDate(date)) return null;
    return { date: String(date).slice(0, 10), messages: i(messages) };
  }

  function readPersonality(raw, byHour, byWeekday, total) {
    var p = raw.personality;
    var computed = computePersonality(byHour, byWeekday, total);
    if (typeof p === 'string' && str(p, 60)) p = { title: p };
    if (isObj(p) && str(p.title, 60)) {
      var peak = Number(p.peak_hour);
      return {
        id: str(p.id, 32) || (computed ? computed.id : 'custom'),
        title: str(p.title, 60),
        blurb: str(first(p.blurb, p.description, p.line), 200),
        peak_hour: isFinite(peak) && peak >= 0 && peak <= 23 ? Math.round(peak) : (computed ? computed.peak_hour : 0)
      };
    }
    return computed;
  }

  function readLateNight(raw, byHour, total) {
    var l = raw.late_night;
    var hasHours = F.sum(byHour) > 0;
    var derived = byHour[0] + byHour[1] + byHour[2] + byHour[3] + byHour[4];
    if (isObj(l)) {
      var messages = l.messages === undefined && hasHours ? derived : i(l.messages);
      var top = readPerson(l.top, 'messages');
      return { messages: messages, share: share(l.share, messages, total), top: messages > 0 ? top : null };
    }
    var legacy = first(raw.late_night_messages, typeof l === 'number' ? l : undefined);
    if (legacy !== undefined) return { messages: i(legacy), share: share(undefined, i(legacy), total), top: null };
    if (hasHours) return { messages: derived, share: share(undefined, derived, total), top: null };
    return null;
  }

  // ── normalize ──────────────────────────────────────────────────────────────

  function normalize(raw) {
    if (typeof raw === 'string') {
      try { raw = JSON.parse(raw); } catch (e) { throw new Error('That is not a recap (not valid JSON).'); }
    }
    if (!isObj(raw)) throw new Error('That is not a recap.');

    var chat = isObj(raw.chat) ? raw.chat : {};
    var period = isObj(raw.period) ? raw.period : {};
    var totals = isObj(raw.totals) ? raw.totals : {};

    var byHour = buckets(first(raw.by_hour, raw.messages_by_hour), 24, hourIndex);
    var byWeekday = buckets(first(raw.by_weekday, raw.messages_by_weekday), 7, weekdayIndex);
    var byMonth = buckets(first(raw.by_month, raw.messages_by_month), 12, monthIndex);

    var rawSenders = first(raw.senders, raw.top_senders, raw.messages_by_sender, raw.by_sender);
    var messages = i(first(totals.messages, raw.total_messages, raw.message_count, typeof raw.messages === 'number' ? raw.messages : undefined));
    if (!messages) messages = Math.min(MAX_COUNT, Math.max(F.sum(byHour), F.sum(byWeekday), F.sum(byMonth)));
    var senders = readSenders(raw, messages);
    if (!messages) messages = Math.min(MAX_COUNT, F.sum(senders.map(function (s) { return s.messages; })));
    if (!messages && rawSenders === undefined && !str(first(chat.name, raw.chat_name), 10)) {
      throw new Error('That recap is empty.');
    }
    // Shares computed before the total was known need a second pass.
    senders.forEach(function (s) { if (!s.share && s.messages && messages) s.share = share(undefined, s.messages, messages); });

    var memberSrc = first(chat.members, raw.members, raw.participants, raw.member_count);
    var members = Array.isArray(memberSrc) ? memberSrc.length : i(memberSrc);
    if (!members) members = senders.length;

    var label = str(first(period.label, raw.label, raw.year), 24);
    var start = F.parseDate(first(period.start, raw.start_date, raw.start)) ? String(first(period.start, raw.start_date, raw.start)).slice(0, 10) : '';
    var end = F.parseDate(first(period.end, raw.end_date, raw.end)) ? String(first(period.end, raw.end_date, raw.end)).slice(0, 10) : '';
    if (!label) label = start ? String(F.parseDate(start).y) : (end ? String(F.parseDate(end).y) : '');

    var reactionsTotal = i(first(totals.reactions, raw.total_reactions));
    var reactions = readReactions(raw, reactionsTotal);
    if (reactions && !reactionsTotal) {
      reactionsTotal = Math.min(MAX_COUNT, F.sum(KINDS.map(function (k) { return reactions.by_kind[k]; })));
    }

    var meta = isObj(raw.meta) ? raw.meta : {};

    return {
      v: 1,
      chat: {
        name: str(first(chat.name, raw.chat_name, raw.group_name, typeof raw.name === 'string' ? raw.name : undefined, raw.title), 120) || 'The group chat',
        members: members
      },
      period: { label: label, start: start, end: end },
      totals: {
        messages: messages,
        words: i(first(totals.words, raw.total_words, raw.word_count)),
        attachments: i(first(totals.attachments, raw.total_attachments)),
        reactions: reactionsTotal,
        days_active: i(first(totals.days_active, raw.days_active)),
        longest_streak: i(first(totals.longest_streak, raw.longest_streak))
      },
      by_hour: byHour,
      by_weekday: byWeekday,
      by_month: byMonth,
      busiest_day: readBusiestDay(raw),
      personality: readPersonality(raw, byHour, byWeekday, messages),
      late_night: readLateNight(raw, byHour, messages),
      senders: senders,
      most_reacted: readMostReacted(raw),
      reactions: reactions,
      awards: readAwards(raw),
      meta: {
        generator: str(meta.generator, 40),
        source: str(meta.source, 40),
        generated: F.parseDate(meta.generated) ? String(meta.generated).slice(0, 10) : ''
      }
    };
  }

  var Data = {
    normalize: normalize,
    computePersonality: computePersonality,
    KINDS: KINDS,
    MAX_COUNT: MAX_COUNT,
    PERSONALITIES: PERSONALITIES
  };

  root.WrappedData = Data;
  if (isNode) module.exports = Data;
})(typeof window !== 'undefined' ? window : globalThis);
