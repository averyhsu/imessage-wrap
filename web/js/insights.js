/*
 * The words on the slides, matched to the chat. WrappedInsights.pick(stats) takes a
 * normalised stats object (docs/SCHEMA.md §1) and returns, for each slide that has
 * patterns, the pattern that won and its copy:
 *
 *   { clock: { id, headline, line }, late: { id, tagline, top }, week: {…}, year: {…},
 *     senders: {…}, moty: {…}, taps: {…}, total: {…} }
 *
 * Each slide has an ordered list of patterns. The first whose condition holds wins, and
 * the last one always holds: it is the copy the slide had before patterns existed, so no
 * slide is ever left without a headline. A pattern only claims what a number on the same
 * slide backs up; when the slide does not show that number already, the pattern's
 * supporting line does.
 *
 * Copy comes back as plain strings (headlines) or as a list of parts (supporting lines):
 *   'text'          plain text
 *   { b: 'text' }   a number, set in bold
 *   { name: 'Sam' } a person's name from the recap, rendered by the slide as a name
 * Nothing here touches the DOM, so the slides can render the parts safely and the whole
 * file can be unit-tested in Node (tests/js/insights.test.js).
 */
(function (root) {
  'use strict';

  var isNode = typeof module === 'object' && module.exports;
  var F = root.WrappedFormat || (isNode ? require('./format.js') : null);

  // ── helpers ────────────────────────────────────────────────────────────────

  function num(v) { v = Number(v); return isFinite(v) && v > 0 ? v : 0; }
  function b(text) { return { b: String(text) }; }
  function isYear(label) { return /^\d{4}$/.test(label || ''); }
  function messages(n) { return F.int(n) + ' ' + F.plural(n, 'message'); }

  /** The first pattern whose `when` holds; the last one in every list always does. */
  function choose(list, ctx) {
    for (var i = 0; i < list.length; i++) {
      if (i === list.length - 1 || list[i].when(ctx)) {
        var out = list[i].copy(ctx);
        out.id = list[i].id;
        return out;
      }
    }
    return null;
  }

  /** "Midnight" / "Noon" / "11 AM": an hour said on its own. */
  function hourWord(h) {
    h = ((h % 24) + 24) % 24;
    return h === 0 ? 'Midnight' : h === 12 ? 'Noon' : F.hour(h);
  }

  /** The stretch of `n` hours starting at `start`: "7 to 10 PM", "10 AM to 1 PM", "9 PM to midnight". */
  function hourStretch(start, n) {
    var a = ((start % 24) + 24) % 24;
    var z = (a + n) % 24;
    function word(h) { return h === 0 ? 'midnight' : h === 12 ? 'noon' : F.hour(h); }
    var sameHalf = a !== 0 && a !== 12 && z !== 0 && z !== 12 && (a < 12) === (z < 12) && z > a;
    if (sameHalf) return (a % 12) + ' to ' + F.hour(z);
    return word(a) + ' to ' + word(z);
  }

  /** Circular distance between two hours. */
  function hourDistance(a, z) { var d = Math.abs(a - z) % 24; return Math.min(d, 24 - d); }

  // ── 3. the 24-hour clock ───────────────────────────────────────────────────

  function clockDefault(hour) {
    if (hour <= 4) return 'Up way past bedtime.';
    if (hour <= 8) return 'Up before the alarm.';
    if (hour <= 11) return 'A morning kind of chat.';
    if (hour <= 13) return 'Out to lunch, in the chat.';
    if (hour <= 17) return 'The afternoon scroll.';
    if (hour <= 20) return 'Loudest around dinner.';
    return 'Loudest after dark.';
  }

  /** The busiest run of three consecutive hours (wrapping past midnight). */
  function busiestStretch(H) {
    var best = 0, start = 0;
    for (var h = 0; h < 24; h++) {
      var t = H[h] + H[(h + 1) % 24] + H[(h + 2) % 24];
      if (t > best) { best = t; start = h; }
    }
    return { start: start, total: best };
  }

  /**
   * A second rush hour: a local peak at least five hours from the busiest hour, at least
   * 80% as busy, with each of the two holding at least 6% of the chat, and a real dip
   * between them (some hour on the way from one to the other at under 75% of the lower
   * peak), so a long plateau does not count as two peaks.
   */
  function secondPeak(H, peak, T) {
    var best = -1;
    for (var h = 0; h < 24; h++) {
      if (hourDistance(h, peak) < 5) continue;
      var left = H[(h + 23) % 24], right = H[(h + 1) % 24];
      if (H[h] < left || H[h] < right) continue;
      if (best < 0 || H[h] > H[best]) best = h;
    }
    if (best < 0) return -1;
    var low = H[best];
    if (low < 0.8 * H[peak] || low < 0.06 * T || H[peak] < 0.06 * T) return -1;
    // The shorter way round from one peak to the other has to dip.
    var step = ((best - peak + 24) % 24) <= 12 ? 1 : -1;
    var dips = false;
    for (var k = (peak + step + 24) % 24; k !== best; k = (k + step + 24) % 24) {
      if (H[k] < 0.75 * low) { dips = true; break; }
    }
    return dips ? best : -1;
  }

  var CLOCK = [
    {
      id: 'open_all_hours',
      when: function (c) { return c.T >= 200 && c.stretch.total / c.T <= 0.2; },
      copy: function (c) {
        return {
          headline: 'Open all hours.',
          line: ['Even the busiest three hours, ' + hourStretch(c.stretch.start, 3) + ', held just ', b(F.pct(c.stretch.total / c.T)), ' of the chat.']
        };
      }
    },
    {
      id: 'two_rush_hours',
      when: function (c) { return c.T >= 200 && c.second >= 0; },
      copy: function (c) {
        var a = Math.min(c.peak, c.second), z = Math.max(c.peak, c.second);
        return {
          headline: 'Two rush hours.',
          line: ['Rush hours at ', b(F.hour(a)), ' and ', b(F.hour(z)), ': ', b(F.int(c.H[a])), ' and ', b(F.int(c.H[z])), ' messages.']
        };
      }
    },
    {
      id: 'clockwork',
      when: function (c) { return c.T >= 100 && c.max / c.T >= 0.15; },
      copy: function (c) {
        return {
          headline: hourWord(c.peak) + ', like clockwork.',
          line: [b(messages(c.max)), ' landed between ' + F.hourSpan(c.peak) + '. That’s ', b(F.pct(c.max / c.T)), ' of everything.']
        };
      }
    },
    {
      id: 'by_peak_hour',
      copy: function (c) {
        return { headline: clockDefault(c.peak), line: [b(messages(c.max)), ' landed between ' + F.hourSpan(c.peak) + '.'] };
      }
    }
  ];

  function clock(s) {
    var H = s.by_hour.map(num);
    var T = F.sum(H);
    if (!(T > 0)) return null;
    var peak = F.argmax(H);
    return choose(CLOCK, { H: H, T: T, peak: peak, max: H[peak], stretch: busiestStretch(H), second: secondPeak(H, peak, T) });
  }

  // ── 5. late night ──────────────────────────────────────────────────────────

  // Thin data: calling a few messages after midnight a "night shift" says too much.
  var LATE_MIN = 20;

  var LATE = [
    { id: 'none', when: function (c) { return c.n === 0; }, copy: function () { return { tagline: 'A suspiciously well-rested chat.' }; } },
    { id: 'no_sleep', when: function (c) { return c.n >= LATE_MIN && c.share >= 0.15; }, copy: function () { return { tagline: 'Does anyone here sleep?' }; } },
    { id: 'night_shift', when: function (c) { return c.n >= LATE_MIN && c.share >= 0.05; }, copy: function () { return { tagline: 'A proper night shift.' }; } },
    { id: 'occasional', when: function (c) { return c.share >= 0.01; }, copy: function () { return { tagline: 'The occasional late one.' }; } },
    { id: 'asleep', copy: function () { return { tagline: 'Practically asleep by midnight.' }; } }
  ];

  var LATE_TOP = [
    {
      id: 'solo',
      when: function (c) { return c.n >= 10 && c.top.messages >= 0.6 * c.n; },
      copy: function (c) {
        return {
          verb: c.top.messages >= c.n ? ' ran the night shift alone' : ' ran the night shift, mostly solo',
          detail: F.int(c.top.messages) + ' of ' + F.int(c.n) + ' late-night messages'
        };
      }
    },
    {
      id: 'lights_on',
      copy: function (c) {
        return { verb: ' kept the lights on', detail: c.top.messages > 0 ? F.int(c.top.messages) + ' late-night ' + F.plural(c.top.messages, 'message') : '' };
      }
    }
  ];

  function late(s) {
    var l = s.late_night;
    if (!l) return null;
    var ctx = { n: num(l.messages), share: num(l.share), top: l.top && l.top.name ? l.top : null };
    var out = choose(LATE, ctx);
    out.top = ctx.top && ctx.n > 0 ? choose(LATE_TOP, ctx) : null;
    return out;
  }

  // ── 6. the week ────────────────────────────────────────────────────────────

  var WEEK_DEFAULT = [
    'Mondays, of all days.', 'Tuesday. Really, Tuesday.', 'Peak midweek energy.', 'Thursday is the new Friday.',
    'Friday feeling, confirmed.', 'Saturdays are for the chat.', 'Sunday is group chat day.'
  ];

  /** Today's line: the busiest day's count, then whichever of weekend/weekdays leads. */
  function weekLine(c) {
    var line = [b(messages(c.W[c.peak])), ' landed on a ' + F.WEEKDAYS[c.peak] + '. '];
    return line.concat(c.weekend >= 0.4 ? ['Weekends are ', b(F.pct(c.weekend)), ' of the chat.'] : ['Weekdays carry ', b(F.pct(1 - c.weekend)), ' of the chat.']);
  }

  var WEEK = [
    { id: 'weekend_chat', when: function (c) { return c.enough && c.weekend >= 0.45; }, copy: function (c) { return { headline: 'Weekends are for the chat.', line: weekLine(c) }; } },
    { id: 'weekdays_only', when: function (c) { return c.enough && c.weekend <= 0.1; }, copy: function (c) { return { headline: 'Strictly Monday to Friday.', line: weekLine(c) }; } },
    {
      id: 'one_day',
      when: function (c) { return c.enough && c.W[c.peak] / c.T >= 0.25; },
      copy: function (c) {
        return {
          headline: F.WEEKDAYS[c.peak] + 's carry the week.',
          line: [b(messages(c.W[c.peak])), ' landed on a ' + F.WEEKDAYS[c.peak] + '. That’s ', b(F.pct(c.W[c.peak] / c.T)), ' of the week.']
        };
      }
    },
    {
      id: 'every_day',
      when: function (c) { return c.enough && c.W[c.peak] <= 1.2 * c.W[c.low]; },
      copy: function (c) {
        return {
          headline: 'Every day is chat day.',
          line: ['From ', b(F.int(c.W[c.low])), ' on ' + F.WEEKDAYS[c.low] + 's to ', b(F.int(c.W[c.peak])), ' on ' + F.WEEKDAYS[c.peak] + 's. Barely a gap.']
        };
      }
    },
    { id: 'by_peak_day', copy: function (c) { return { headline: WEEK_DEFAULT[c.peak], line: weekLine(c) }; } }
  ];

  function week(s) {
    var W = s.by_weekday.map(num);
    var T = F.sum(W);
    if (!(T > 0)) return null;
    var peak = F.argmax(W);
    var low = 0;
    for (var d = 1; d < 7; d++) if (W[d] < W[low]) low = d;
    var days = F.daysInclusive(s.period.start, s.period.end);
    // A week's worth: enough messages, and (when the period is known) every weekday at
    // least three times, so "Fridays" is never one Friday.
    var enough = T >= 100 && (days === 0 || days >= 21);
    return choose(WEEK, { W: W, T: T, peak: peak, low: low, weekend: (W[5] + W[6]) / T, enough: enough });
  }

  // ── 7. the year ────────────────────────────────────────────────────────────

  function daysInMonth(y, m) { return new Date(Date.UTC(y, m, 0)).getUTCDate(); }

  /**
   * The months inside the period, in the order they happened: { list, full, ordered }.
   * `full` marks the months the period covers from the first to the last day (an edge
   * month cut short by the period is never "quiet" for that reason). `ordered` is false
   * when the period runs longer than a year: then by_month sums several Januaries and
   * "first half" means nothing. A recap for the current year ends today, so the months
   * after its end are not in the list at all.
   */
  function periodMonths(s, M) {
    var a = F.parseDate(s.period.start), z = F.parseDate(s.period.end);
    var list = [], full = {}, k;
    if (a && z) {
      var span = (z.y - a.y) * 12 + (z.m - a.m) + 1;
      if (span > 0) {
        if (span >= 12) {
          for (k = 0; k < 12; k++) { var mm = (a.m - 1 + k) % 12; list.push(mm); full[mm] = true; }
          if (span === 12) {
            if (a.d > 1) full[a.m - 1] = false;
            if (z.d < daysInMonth(z.y, z.m)) full[z.m - 1] = false;
          }
          return { list: list, full: full, ordered: span === 12 };
        }
        for (k = 0; k < span; k++) { var m = (a.m - 1 + k) % 12; list.push(m); full[m] = true; }
        if (a.d > 1) full[a.m - 1] = false;
        if (z.d < daysInMonth(z.y, z.m)) full[z.m - 1] = false;
        return { list: list, full: full, ordered: true };
      }
    }
    // No usable dates: the months from the first to the last with messages, which are
    // the only ones the data can vouch for. Their edges may be partial.
    var first = -1, last = -1;
    for (k = 0; k < 12; k++) if (M[k] > 0) { if (first < 0) first = k; last = k; }
    if (first < 0) return { list: [], full: {}, ordered: true };
    for (k = first; k <= last; k++) { list.push(k); full[k] = k !== first && k !== last; }
    return { list: list, full: full, ordered: true };
  }

  var YEAR = [
    {
      id: 'one_month',
      when: function (c) { return c.enough && c.M[c.peak] / c.T >= 0.35; },
      copy: function (c) {
        return { headline: 'All about ' + F.MONTHS[c.peak] + '.', line: [b(F.pct(c.M[c.peak] / c.T)), ' of everything was sent in ' + F.MONTHS[c.peak] + '.'] };
      }
    },
    {
      id: 'quiet_then',
      when: function (c) { return c.enough && c.ordered && c.quietBefore >= 3; },
      copy: function (c) {
        return {
          headline: 'Quiet, then ' + F.MONTHS[c.peak] + '.',
          line: [b(String(c.quietBefore)), ' months under ', b('1%'), ' each. Then ' + F.MONTHS[c.peak] + ' brought ', b(F.pct(c.M[c.peak] / c.T)), '.']
        };
      }
    },
    {
      id: 'loud_start',
      when: function (c) { return c.enough && c.ordered && c.firstHalf / c.T >= 0.7; },
      copy: function (c) {
        return { headline: 'Loud start. Life happened.', line: [b(F.pct(c.firstHalf / c.T)), ' of it came by the end of ' + F.MONTHS[c.firstEnd] + '.'] };
      }
    },
    {
      id: 'loud_finish',
      when: function (c) { return c.enough && c.ordered && c.secondHalf / c.T >= 0.7; },
      copy: function (c) {
        return { headline: 'A slow start. A loud finish.', line: [b(F.pct(c.secondHalf / c.T)), ' of it came from ' + F.MONTHS[c.secondStart] + ' on.'] };
      }
    },
    {
      id: 'steady',
      when: function (c) { return c.enough && c.M[c.peak] <= 1.25 * c.avg; },
      copy: function (c) {
        var over = Math.max(0, c.M[c.peak] / c.avg - 1);
        return {
          headline: c.yearLong ? 'Steady all year.' : 'Steady the whole way.',
          line: [F.MONTHS[c.peak] + ', the busiest month, was just ', b(F.pct(over)), ' above average.']
        };
      }
    },
    { id: 'peak_month', copy: function (c) { return { headline: F.MONTHS[c.peak] + ' went off.', line: null }; } }
  ];

  function year(s) {
    var M = s.by_month.map(num);
    if (!(F.sum(M) > 0)) return null;
    var p = periodMonths(s, M);
    var inside = p.list;
    var T = 0, peak = -1, k;
    inside.forEach(function (m) { T += M[m]; if (peak < 0 || M[m] > M[peak]) peak = m; });
    if (peak < 0 || !(T > 0)) peak = F.argmax(M);
    var quietBefore = 0;
    var at = inside.indexOf(peak);
    for (k = 0; k < at; k++) if (p.full[inside[k]] && M[inside[k]] < 0.01 * T) quietBefore++;
    // The average month: over the months the period covers in full, when there are enough
    // of them, so a month cut short by the period's end does not drag it down.
    var fullList = inside.filter(function (m) { return p.full[m]; });
    var avgOver = fullList.length >= 3 ? fullList : inside;
    var avg = avgOver.length ? F.sum(avgOver.map(function (m) { return M[m]; })) / avgOver.length : 0;
    var half = Math.floor(inside.length / 2);
    var firstHalf = 0, secondHalf = 0;
    for (k = 0; k < half; k++) firstHalf += M[inside[k]];
    for (k = inside.length - half; k < inside.length; k++) secondHalf += M[inside[k]];
    return choose(YEAR, {
      M: M, T: T, peak: peak, avg: avg,
      // Patterns about the shape of the year need six months of it and some messages.
      enough: inside.length >= 6 && T >= 100,
      ordered: p.ordered,
      quietBefore: quietBefore,
      firstHalf: firstHalf, secondHalf: secondHalf,
      firstEnd: inside[Math.max(0, half - 1)], secondStart: inside[Math.max(0, inside.length - half)],
      yearLong: isYear(s.period.label)
    });
  }

  // ── 8. top senders ─────────────────────────────────────────────────────────

  var SENDERS = [
    { id: 'duo', when: function (c) { return c.list.length === 2; }, copy: function () { return { headline: 'It takes two.' }; } },
    { id: 'one_voice', when: function (c) { return c.enough && c.top >= 0.5; }, copy: function () { return { headline: 'One voice, mostly.' }; } },
    { id: 'photo_finish', when: function (c) { return c.enough && c.list[1].messages >= 0.97 * c.list[0].messages; }, copy: function () { return { headline: 'A photo finish.' }; } },
    { id: 'runaway', when: function (c) { return c.enough && c.list[0].messages >= 2 * c.list[1].messages; }, copy: function () { return { headline: 'Nobody else came close.' }; } },
    // Everyone who is in the chat has to be on the list: a member who never wrote did not chip in.
    { id: 'even', when: function (c) { return c.enough && c.list.length >= 3 && c.members <= c.list.length && c.top * c.list.length <= 1.35; }, copy: function () { return { headline: 'Everyone chipped in.' }; } },
    { id: 'carried', copy: function () { return { headline: 'Who carried the chat' }; } }
  ];

  function senders(s) {
    var list = s.senders.filter(function (p) { return p.messages > 0; });
    if (list.length < 2) return null;
    var T = num(s.totals.messages);
    var top = num(list[0].share) || (T > 0 ? list[0].messages / T : 0);
    return choose(SENDERS, { list: list, top: top, members: num(s.chat.members), enough: T >= 50 && list[0].messages >= 20 });
  }

  // ── 9. message of the year ─────────────────────────────────────────────────

  var MOTY = [
    { id: 'laughs', when: function (c) { return c.mostly === 'laugh'; }, copy: function (c) { return { line: [b(F.int(c.count)), ' of them were laughs. Comedy gold.'] }; } },
    { id: 'hearts', when: function (c) { return c.mostly === 'love'; }, copy: function (c) { return { line: [b(F.int(c.count)), ' of them were hearts. Pure love.'] }; } },
    { id: 'emphasis', when: function (c) { return c.mostly === 'emphasize'; }, copy: function (c) { return { line: [b(F.int(c.count)), ' of them were a big !!'] }; } },
    { id: 'mixed', copy: function () { return { line: null }; } }
  ];

  function moty(s) {
    var m = s.most_reacted[0];
    if (!m || !(m.reactions > 0 || m.text)) return null;
    var total = num(m.reactions);
    var kinds = m.kinds || {};
    var mostly = null, count = 0;
    // "Mostly" means more than half of the tapbacks the slide counts, on a message with a few.
    if (total >= 3) {
      ['laugh', 'love', 'emphasize'].forEach(function (k) {
        var v = Object.prototype.hasOwnProperty.call(kinds, k) ? num(kinds[k]) : 0;
        if (v > total / 2 && v <= total) { mostly = k; count = v; }
      });
    }
    return choose(MOTY, { mostly: mostly, count: count });
  }

  // ── 10. tapbacks ───────────────────────────────────────────────────────────

  var TAP_DEFAULT = {
    love: 'Mostly love.', like: 'A thumbs-up kind of chat.', dislike: 'Tough crowd.', laugh: 'Mostly laughing.',
    emphasize: 'Big !! energy.', question: 'So many questions.', emoji: 'Fluent in emoji.'
  };
  var TAP_NOUN = { love: 'hearts', like: 'likes', dislike: 'dislikes', laugh: 'laughs', emphasize: 'emphasis', question: 'questions', emoji: 'emoji' };

  /** "That's 62 for every 100 messages." */
  function per100(c) {
    var r = (100 * c.R) / c.T;
    if (r < 1) return ['Fewer than ', b('1'), ' for every ', b('100'), ' messages.'];
    return ['That’s ', b(F.int(r)), ' for every ', b('100'), ' messages.'];
  }

  function capital(text) { return text.charAt(0).toUpperCase() + text.slice(1); }

  /** "Hearts and laughs, within 3% of each other." */
  function close(c) {
    var a = c.kinds[0], z = c.kinds[1];
    var gap = 1 - z.count / a.count;
    var lead = capital(TAP_NOUN[a.kind]) + ' and ' + TAP_NOUN[z.kind] + ', ';
    if (gap <= 0) return [lead + 'exactly level.'];
    if (gap < 0.01) return [lead + 'less than ', b('1%'), ' apart.'];
    return [lead + 'within ', b(F.pct(gap)), ' of each other.'];
  }

  var TAPS = [
    { id: 'reacts_to_everything', when: function (c) { return c.T >= 50 && c.R >= 0.5 * c.T; }, copy: function (c) { return { headline: 'Reacts to everything.', line: per100(c) }; } },
    { id: 'rare', when: function (c) { return c.T >= 100 && c.R < 0.03 * c.T; }, copy: function (c) { return { headline: 'Saved for big moments.', line: per100(c) }; } },
    {
      id: 'neck_and_neck',
      when: function (c) { return c.R >= 30 && c.kinds.length >= 2 && c.kinds[1].count >= 0.9 * c.kinds[0].count; },
      copy: function (c) { return { headline: 'Neck and neck.', line: close(c) }; }
    },
    { id: 'by_top_kind', copy: function (c) { return { headline: c.kinds.length ? F.pick(TAP_DEFAULT, c.kinds[0].kind, '') : '', line: null }; } }
  ];

  var KIND_ORDER = ['love', 'like', 'dislike', 'laugh', 'emphasize', 'question', 'emoji'];

  function taps(s) {
    var r = s.reactions;
    var R = num(s.totals.reactions);
    if (!r || !(R > 0)) return null;
    // Same order as the slide's bubbles: biggest first, ties in the tapback menu's order.
    var kinds = KIND_ORDER.map(function (k) { return { kind: k, count: num(r.by_kind && r.by_kind[k]) }; })
      .filter(function (k) { return k.count > 0; })
      .sort(function (a, z) { return z.count - a.count; });
    return choose(TAPS, { R: R, T: num(s.totals.messages), kinds: kinds });
  }

  // ── 2. total ───────────────────────────────────────────────────────────────

  /** "3.1 words a text", "14 words a text", "1 word a text". */
  function perText(x) {
    var text = x >= 10 ? F.int(x) : (Math.round(x * 10) / 10).toFixed(1).replace(/\.0$/, '');
    return text + ' ' + (text === '1' ? 'word' : 'words') + ' a text';
  }

  var TOTAL = [
    { id: 'short_texts', when: function (c) { return c.enough && c.avg < 4; }, copy: function (c) { return { fact: 'Short and sweet: ' + perText(c.avg) }; } },
    { id: 'long_texts', when: function (c) { return c.enough && c.avg >= 12; }, copy: function (c) { return { fact: 'Paragraph people: ' + perText(c.avg) }; } },
    { id: 'plain', copy: function () { return { fact: '' }; } }
  ];

  function total(s) {
    var T = num(s.totals.messages);
    if (!(T > 0)) return null;
    var words = num(s.totals.words);
    return choose(TOTAL, { avg: words / T, enough: T >= 100 && words > 0 });
  }

  // ── all of it ──────────────────────────────────────────────────────────────

  var PATTERNS = { total: TOTAL, clock: CLOCK, late: LATE, lateTop: LATE_TOP, week: WEEK, year: YEAR, senders: SENDERS, moty: MOTY, taps: TAPS };

  function pick(stats) {
    return {
      total: total(stats), clock: clock(stats), late: late(stats), week: week(stats), year: year(stats),
      senders: senders(stats), moty: moty(stats), taps: taps(stats)
    };
  }

  /** The ids of every pattern, per slide, in the order they are tried. */
  function ids() {
    var out = {};
    Object.keys(PATTERNS).forEach(function (k) { out[k] = PATTERNS[k].map(function (p) { return p.id; }); });
    return out;
  }

  var Insights = { pick: pick, ids: ids, periodMonths: periodMonths, hourStretch: hourStretch };

  root.WrappedInsights = Insights;
  if (isNode) module.exports = Insights;
})(typeof window !== 'undefined' ? window : globalThis);
