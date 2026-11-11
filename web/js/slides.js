/*
 * The slides. WrappedSlides.build(stats, env) turns a normalised stats object into a list
 * of slide descriptors for the player:
 *
 *   { id, el, ink, world, duration, label, fits[], counts[], cues[] }
 *
 * - el        the <section>, built with createElement/textContent only. Recap strings are
 *             untrusted (they arrive in a link), so nothing from `stats` ever goes through
 *             innerHTML, and styles are set through the CSSOM (the page CSP forbids inline
 *             style attributes).
 * - ink       'light' | 'dark': colour of the player chrome on top of this slide.
 * - world     the slide's signature colour (theme-color, header badge).
 * - backdrop  the colour behind a framed desktop stage; defaults to `world`.
 * - fits      functions the player calls with the size of one design pixel whenever the
 *             stage is laid out; they shrink type until it fits.
 * - counts    numbers that count up: { el, to, at, dur, format }.
 * - cues      timed callbacks: { at, run(env) } (haptics).
 *
 * A slide whose data is missing is simply not built.
 */
(function (root) {
  'use strict';

  var F = root.WrappedFormat;
  var G = root.WrappedGlyphs;
  var Config = root.WrappedConfig;

  // ── tiny DOM kit ───────────────────────────────────────────────────────────

  function add(node, kids) {
    if (kids == null || kids === false) return node;
    if (Array.isArray(kids)) { for (var i = 0; i < kids.length; i++) add(node, kids[i]); }
    else if (kids.nodeType) node.appendChild(kids);
    else node.appendChild(document.createTextNode(String(kids)));
    return node;
  }

  function h(tag, cls, kids) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    return add(node, kids);
  }

  function b(text) { return h('b', '', text); }

  /** Design pixels → CSS length. */
  function u(n) { return 'calc(var(--u) * ' + (Math.round(n * 100) / 100) + ')'; }

  function css(node, props) {
    for (var k in props) if (Object.prototype.hasOwnProperty.call(props, k)) node.style.setProperty(k, String(props[k]));
    return node;
  }

  /** Mark a node as an entrance: kind = up|fade|pop|pop-l|pop-r|slam|drop|grow-x|grow-y|typing… */
  function A(node, kind, delay, dur) {
    node.classList.add('a');
    if (kind && kind !== 'up') node.classList.add('a-' + kind);
    node.style.setProperty('--d', String(Math.round(delay || 0)));
    if (dur) node.style.setProperty('--dur', dur + 's');
    return node;
  }

  function gap(size) { return h('div', 'gap gap--' + (size || 'm')); }

  /** Bold every number in a sentence: "That's 154 a day." */
  function rich(text) {
    var parts = String(text).split(/(\d[\d,.]*\d%?|\d%?)/);
    return parts.map(function (p, i) { return i % 2 ? b(p) : p; });
  }

  function bubble(tone, side, kids, extra) {
    return h('div', 'bubble bubble--' + tone + ' bubble--' + side + (extra ? ' ' + extra : ''), kids);
  }

  function typing() {
    return h('span', 'bubble bubble--white bubble--left typing', [h('i'), h('i'), h('i')]);
  }

  function kicker(text, glyph) {
    return h('p', 'kicker', [glyph ? G.icon(glyph) : null, h('span', '', text)]);
  }

  var AVATAR_COLORS = ['#ff2d55', '#ff9f0a', '#30d158', '#00c7be', '#5e5ce6', '#bf5af2'];

  /** A contact-style circle with the initial; `tint` picks a stable colour from the name. */
  function avatar(name, tint) {
    var node = h('span', 'avatar', F.initial(name));
    if (tint) {
      var sum = 0;
      Array.from(String(name)).forEach(function (ch) { sum += ch.codePointAt(0); });
      css(node, { '--av': AVATAR_COLORS[sum % AVATAR_COLORS.length] });
    }
    return node;
  }

  function decos(slide, classes) {
    var bg = slide.el.querySelector('.slide__bg');
    classes.forEach(function (c) { bg.appendChild(h('i', 'deco ' + c)); });
  }

  function make(id, opts) {
    var el = h('section', 'slide slide--' + id, [h('div', 'slide__bg'), h('div', 'slide__body ' + id)]);
    el.setAttribute('data-slide', id);
    el.setAttribute('aria-hidden', 'true');
    return {
      id: id,
      el: el,
      body: el.lastChild,
      ink: opts.ink || 'light',
      world: opts.world,
      backdrop: opts.backdrop || opts.world,
      duration: opts.duration || 6000,
      label: opts.label || '',
      fits: [],
      counts: [],
      cues: []
    };
  }

  // ── fitting type ───────────────────────────────────────────────────────────

  /**
   * Single line. `node` holds one inline-block child with the text. Tries each width of
   * the variable font at the maximum size, then scales the narrowest one down.
   */
  function fitLine(slide, node, opts) {
    var inner = opts.inner || node.firstElementChild;
    var stretches = opts.stretches || [100];
    slide.fits.push(function (unit) {
      var avail = opts.avail ? opts.avail(unit) : node.clientWidth;
      if (!(avail > 0) || !inner) return;
      avail *= 0.985;
      // Numbers that count up are measured at their final value, not at "0".
      var shown = inner.textContent;
      if (opts.text != null) inner.textContent = opts.text;
      var size = opts.max;
      for (var i = 0; i < stretches.length; i++) {
        node.style.fontStretch = stretches[i] + '%';
        node.style.fontSize = (opts.max * unit) + 'px';
        var w = inner.offsetWidth;
        if (!w) break;
        if (w <= avail) { size = opts.max; break; }
        size = opts.max * avail / w; // kept only if this was the narrowest cut
      }
      if (opts.text != null) inner.textContent = shown;
      // Still too long at the smallest size (an absurdly long name): end with an ellipsis.
      var min = opts.min || 10;
      node.classList.toggle('fit--clip', size < min);
      node.style.fontSize = u(Math.max(min, Math.min(opts.max, size)));
    });
  }

  /**
   * Several lines (the chat name). Largest size first; at each size the wider cuts of the
   * font are tried before the condensed ones. A size fits when no word had to be broken
   * and the text takes at most opts.lines lines. At the minimum size anything goes.
   */
  function fitBlock(slide, node, opts) {
    var stretches = opts.stretches || [100];
    slide.fits.push(function (unit) {
      if (!node.clientWidth) return;
      var lineHeight = opts.lineHeight || 0.9;
      var words = node.querySelectorAll('.w');
      function fitsAt(size, stretch) {
        node.style.fontStretch = stretch + '%';
        node.style.fontSize = (size * unit) + 'px';
        var lh = size * unit * lineHeight;
        for (var k = 0; k < words.length; k++) if (words[k].offsetHeight > lh * 1.6) return false;
        if (node.scrollWidth > node.clientWidth + 1) return false;
        var cs = getComputedStyle(node);
        var height = node.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
        return Math.round(height / lh) <= opts.lines;
      }
      var size = opts.max;
      var done = false;
      while (!done) {
        for (var i = 0; i < stretches.length && !done; i++) done = fitsAt(size, stretches[i]);
        if (done) break;
        if (size <= opts.min) { fitsAt(opts.min, stretches[stretches.length - 1]); size = opts.min; break; }
        size = Math.max(opts.min, size * 0.93);
      }
      node.style.fontSize = u(size);
    });
  }

  /** Split text into word spans (so each can animate) inside `node`. */
  function words(node, text, delay, step) {
    var list = String(text).split(/\s+/).filter(Boolean);
    list.forEach(function (word, i) {
      if (i) node.appendChild(document.createTextNode(' '));
      node.appendChild(A(h('span', 'w', word), 'up', delay + i * step, 0.8));
    });
    return node;
  }

  // ── copy ───────────────────────────────────────────────────────────────────

  var PERSONA_EMOJI = {
    quiet_ones: '🤫', night_owls: '🦉', weekend_warriors: '🎉', always_on: '🔋', early_birds: '🐦',
    morning_meeting: '☕', lunch_break: '🥪', afternoon_slackers: '😎', dinner_table: '🍽️', after_hours: '🌙'
  };

  function clockHeadline(hour) {
    if (hour <= 4) return 'Up way past bedtime.';
    if (hour <= 8) return 'Up before the alarm.';
    if (hour <= 11) return 'A morning kind of chat.';
    if (hour <= 13) return 'Out to lunch, in the chat.';
    if (hour <= 17) return 'The afternoon scroll.';
    if (hour <= 20) return 'Loudest around dinner.';
    return 'Loudest after dark.';
  }

  var WEEK_HEADLINES = [
    'Mondays, of all days.', 'Tuesday. Really, Tuesday.', 'Peak midweek energy.', 'Thursday is the new Friday.',
    'Friday feeling, confirmed.', 'Saturdays are for the chat.', 'Sunday is group chat day.'
  ];

  var TAP_HEADLINES = {
    love: 'Mostly love.', like: 'A thumbs-up kind of chat.', dislike: 'Tough crowd.', laugh: 'Mostly laughing.',
    emphasize: 'Big !! energy.', question: 'So many questions.', emoji: 'Fluent in emoji.'
  };

  function isYear(label) { return /^\d{4}$/.test(label); }

  // ── 1. cover ───────────────────────────────────────────────────────────────

  function cover(s) {
    var slide = make('cover', { ink: 'light', world: '#0a7aff', duration: 5200, label: s.chat.name + ', ' + F.inReview(s.period.label) });
    decos(slide, ['cover__d1', 'cover__d2 deco--l', 'cover__d3 deco--l', 'cover__d4']);

    var meta = [];
    if (s.chat.members > 0) meta.push(F.int(s.chat.members) + ' ' + F.plural(s.chat.members, 'person', 'people'));
    var range = F.dateRange(s.period.start, s.period.end);
    if (range) meta.push(range);

    var T0 = 1650; // the typing bubble resolves into the title here
    var name = words(h('h1', 'cover__name'), s.chat.name, T0 + 60, 80);
    fitBlock(slide, name, { max: 70, min: 24, lines: 3, lineHeight: 0.9, stretches: [116, 100, 82, 66] });

    var labelText = h('span', '', F.inReview(s.period.label));
    var label = A(bubble('white', 'left', labelText, 'cover__label'), 'pop-l', T0 + 520);
    // Somebody loved it: a heart tapback lands on the title bubble.
    label.appendChild(A(G.tapback('love', 'cover__tb'), 'drop', T0 + 1150, 0.5));
    var stack = h('div', 'cover__stack', [
      A(h('div', 'cover__typing', typing()), 'typing', 200, 1.5),
      meta.length ? A(h('p', 'cover__meta', meta.join('  ·  ')), 'up', T0) : null,
      name,
      label
    ]);
    fitLine(slide, label, { inner: labelText, max: 27, min: 13, avail: function (unit) { return stack.clientWidth - 62 * unit; } });

    add(slide.body, [stack, A(h('p', 'cover__hint', 'Tap to skip ahead  ·  hold to pause'), 'fade', T0 + 1500)]);
    slide.cues.push({ at: T0, haptic: 'medium' });
    slide.cues.push({ at: T0 + 1150, haptic: 'light' });
    return slide;
  }

  // ── 2. total messages ──────────────────────────────────────────────────────

  function total(s) {
    var n = s.totals.messages;
    if (!(n > 0)) return null;
    var slide = make('total', { ink: 'dark', world: '#30d158', duration: 6500, label: F.int(n) + ' messages' });
    decos(slide, ['total__d1', 'total__d2 deco--l']);

    var label = s.period.label;
    var lead = isYear(label) ? 'In ' + label + ' this chat sent' : (label ? label + ' · this chat sent' : 'This chat sent');
    var value = h('span', '', F.int(n));
    var num = A(h('div', 'total__num num fit', value), 'up', 250, 0.9);
    fitLine(slide, num, { max: 150, min: 44, stretches: [100, 86, 74, 62], text: F.int(n) });
    slide.counts.push({ el: value, to: n, at: 300, dur: 1500 });

    var days = F.daysInclusive(s.period.start, s.period.end) || s.totals.days_active;
    var perDay = F.perDay(n, days);
    var facts = [];
    if (perDay) facts.push(A(bubble('white', 'left', rich(perDay)), 'pop-l', 2000));
    if (s.totals.words > 0) {
      facts.push(A(bubble('ink', 'right', [b(F.int(s.totals.words) + ' ' + F.plural(s.totals.words, 'word') + '.'), ' ', F.wordFact(s.totals.words)]), 'pop-r', 2550));
    }

    var chips = [];
    if (s.totals.days_active > 0) chips.push(F.int(s.totals.days_active) + ' ' + F.plural(s.totals.days_active, 'day') + ' active');
    if (s.totals.longest_streak > 1) chips.push(F.int(s.totals.longest_streak) + '-day streak');
    if (s.totals.attachments > 0) chips.push(F.int(s.totals.attachments) + ' ' + F.plural(s.totals.attachments, 'photo & file', 'photos & files'));

    add(slide.body, [
      A(kicker(lead), 'up', 100),
      num,
      A(h('p', 'total__unit', F.plural(n, 'message')), 'up', 450),
      facts.length ? h('div', 'total__facts', facts) : null,
      chips.length ? A(h('ul', 'chips', chips.map(function (c) { return h('li', '', c); })), 'up', 3150) : null
    ]);
    return slide;
  }

  // ── 3. the 24-hour clock ───────────────────────────────────────────────────

  var HOUR_STOPS = [
    [0, [94, 92, 230]], [5, [191, 90, 242]], [8, [255, 159, 10]], [12, [255, 214, 10]],
    [16, [255, 159, 10]], [19, [255, 55, 95]], [22, [120, 100, 240]], [24, [94, 92, 230]]
  ];

  function hourColor(hour) {
    for (var i = 1; i < HOUR_STOPS.length; i++) {
      var a = HOUR_STOPS[i - 1], z = HOUR_STOPS[i];
      if (hour <= z[0]) {
        var t = (hour - a[0]) / (z[0] - a[0]);
        var c = [0, 1, 2].map(function (k) { return Math.round(a[1][k] + (z[1][k] - a[1][k]) * t); });
        return 'rgb(' + c.join(',') + ')';
      }
    }
    return 'rgb(94,92,230)';
  }

  function clock(s) {
    var H = s.by_hour;
    var sum = F.sum(H);
    if (!(sum > 0)) return null;
    var peak = F.argmax(H);
    var max = H[peak];
    var slide = make('clock', { ink: 'light', world: '#2a1f7a', duration: 7000, label: 'Peak hour: ' + F.hour(peak) });

    var dial = h('div', 'dial', h('div', 'dial__face'));
    for (var i = 0; i < 24; i++) {
      var len = 7 + 77 * (H[i] / max);
      var bar = A(h('b', 'dial__bar'), 'grow-y', 500 + i * 42, 0.8);
      css(bar, { height: u(len), '--c': hourColor(i) });
      var spoke = h('i', 'dial__spoke' + (i === peak ? ' is-peak' : ''), bar);
      spoke.style.transform = 'rotate(' + (i * 15) + 'deg)';
      dial.appendChild(spoke);
    }
    [0, 6, 12, 18].forEach(function (t) {
      dial.appendChild(A(h('span', 'dial__tick dial__tick--' + t, F.hourTick(t)), 'fade', 400));
    });
    dial.appendChild(h('div', 'dial__center', A(h('div', '', [
      h('span', 'dial__peak', F.hour(peak)),
      h('span', 'dial__cap', 'peak hour')
    ]), 'pop', 1750)));

    var parts = [['Morning', 5, 11], ['Afternoon', 12, 16], ['Evening', 17, 21], ['Night', 22, 28]].map(function (p) {
      var t = 0;
      for (var k = p[1]; k <= p[2]; k++) t += H[k % 24];
      return h('li', '', p[0] + ' ' + F.pct(t / sum));
    });

    add(slide.body, [
      A(kicker('The 24-hour clock'), 'up', 100),
      A(h('h2', 'headline', clockHeadline(peak)), 'up', 220),
      gap('s'),
      dial,
      gap('s'),
      A(bubble('white', 'left', [b(F.int(max) + ' ' + F.plural(max, 'message')), ' landed between ' + F.hourSpan(peak) + '.']), 'pop-l', 2350),
      gap('s'),
      A(h('ul', 'chips', parts), 'up', 2900)
    ]);
    slide.cues.push({ at: 1750, haptic: 'light' });
    return slide;
  }

  // ── 4. personality ─────────────────────────────────────────────────────────

  function titleLines(title) {
    var rest = title.replace(/^the\s+/i, '');
    var the = rest !== title;
    var list = rest.split(/\s+/).filter(Boolean);
    if (list.length <= 3) return { the: the, lines: list };
    // Pack into three lines of roughly equal length.
    var totalChars = list.join(' ').length;
    var lines = [];
    var current = '';
    list.forEach(function (word, i) {
      var candidate = current ? current + ' ' + word : word;
      var remainingLines = 3 - lines.length;
      var remainingWords = list.length - i;
      if (current && remainingLines > 1 && (candidate.length > totalChars / 3 + 2 || remainingWords < remainingLines)) {
        lines.push(current);
        current = word;
      } else {
        current = candidate;
      }
    });
    if (current) lines.push(current);
    return { the: the, lines: lines };
  }

  function stretchFor(text) {
    var n = Array.from(text).length;
    return n <= 3 ? 125 : n <= 5 ? 116 : n <= 7 ? 98 : n <= 9 ? 80 : 64;
  }

  function persona(s) {
    var p = s.personality;
    if (!p || !p.title) return null;
    var slide = make('persona', { ink: 'light', world: '#7a2cf0', duration: 7600, label: 'Personality: ' + p.title + '. ' + p.blurb });
    decos(slide, ['persona__d1 deco--l', 'persona__d2']);

    var T0 = 2300;
    var t = titleLines(p.title);
    var title = h('h2', 'persona__title');
    t.lines.forEach(function (line, i) {
      var node = A(h('span', 'fit persona__line', h('span', '', line)), 'slam', T0 + 180 + i * 150);
      fitLine(slide, node, { max: 104, min: 26, stretches: [stretchFor(line)] });
      title.appendChild(node);
    });
    var after = T0 + 180 + t.lines.length * 150;

    add(slide.body, [
      A(kicker("This chat's personality"), 'up', 100),
      h('div', 'persona__wrap', [
        A(h('div', 'persona__typing', typing()), 'typing', 350, 1.9),
        A(h('span', 'persona__emoji', PERSONA_EMOJI[p.id] || '💬'), 'pop', T0),
        t.the ? A(h('p', 'persona__the', 'The'), 'up', T0 + 100) : null,
        title,
        p.blurb ? A(bubble('white', 'left', p.blurb, 'persona__blurb'), 'pop-l', after + 350) : null
      ])
    ]);
    slide.cues.push({ at: T0 + 180, haptic: 'medium' });
    return slide;
  }

  // ── 5. late night ──────────────────────────────────────────────────────────

  var STARS = [
    [8, 9, 9, 2.6], [22, 20, 6, 3.4], [38, 7, 7, 2.2], [52, 16, 5, 4], [6, 34, 6, 3.1], [90, 33, 8, 2.4],
    [72, 41, 5, 3.6], [14, 55, 7, 2.9], [94, 58, 6, 3.3], [84, 74, 9, 2.5], [10, 82, 6, 3.8], [46, 90, 7, 2.7],
    [70, 94, 5, 3.2], [30, 70, 5, 4.2], [60, 62, 4, 3]
  ];

  function late(s) {
    var l = s.late_night;
    if (!l) return null;
    var n = l.messages;
    var slide = make('late', { ink: 'light', world: '#141a4d', duration: 6500, label: F.int(n) + ' messages between midnight and 5 AM' });
    var bg = slide.el.firstChild;
    STARS.forEach(function (st) {
      bg.appendChild(css(G.icon('star', 'late__star'), { '--x': st[0], '--y': st[1], '--sz': st[2], '--tw': st[3] }));
    });
    bg.appendChild(G.icon('moon', 'late__moon'));

    var value = h('span', '', F.int(n));
    var num = A(h('div', 'late__num num fit', value), 'up', 250, 0.9);
    fitLine(slide, num, { max: 150, min: 44, stretches: [100, 86, 74, 62], text: F.int(n) });
    if (n > 0) slide.counts.push({ el: value, to: n, at: 300, dur: 1400 });

    var kids = [A(kicker('After midnight', 'moon'), 'up', 100), num];
    if (n > 0) {
      kids.push(A(h('p', 'late__cap', F.plural(n, 'message') + ' sent between midnight and 5 AM'), 'up', 500));
      var fill = A(h('b', 'meter__fill'), 'grow-x', 1900);
      fill.style.width = Math.max(1, Math.min(100, l.share * 100)).toFixed(2) + '%';
      kids.push(A(h('div', 'meter', [
        h('div', 'meter__track', fill),
        h('p', 'meter__label', [b(F.pct(l.share)), ' of everything this chat said'])
      ]), 'up', 1750));
      if (l.top && l.top.name) {
        kids.push(A(bubble('yellow', 'right', [
          avatar(l.top.name),
          h('span', '', [b(l.top.name), ' kept the lights on', l.top.messages > 0 ? h('em', '', F.int(l.top.messages) + ' late-night ' + F.plural(l.top.messages, 'message')) : null])
        ], 'late__top'), 'pop-r', 2700));
      }
      // The rest of the night shift, from the per-sender counts.
      var topName = l.top ? l.top.name : '';
      var also = s.senders.filter(function (p) { return p.late_night > 0 && p.name !== topName; })
        .sort(function (a, z) { return z.late_night - a.late_night; }).slice(0, 2);
      if (also.length) {
        kids.push(A(h('div', 'late__also', [h('span', '', 'Also up')].concat(also.map(function (p) {
          return h('b', '', [p.name, h('i', '', F.int(p.late_night))]);
        }))), 'up', 3200));
      }
    } else {
      kids.push(A(h('p', 'late__cap', 'messages after midnight. A suspiciously well-rested chat.'), 'up', 500));
    }
    add(slide.body, kids);
    return slide;
  }

  // ── 6 + 7. column charts ───────────────────────────────────────────────────

  function columns(values, labels, peak, startDelay, step, format) {
    var max = values[peak] || 1;
    var cols = h('div', 'cols');
    values.forEach(function (v, i) {
      var pct = v > 0 ? Math.max(5, (v / max) * 84) : 2.5;
      var bar = A(h('b', 'col__bar'), 'grow-y', startDelay + i * step, 0.9);
      bar.style.height = pct.toFixed(2) + '%';
      var track = h('div', 'col__track', bar);
      if (i === peak) {
        // The whole pill pops in (its position uses `translate`, so `transform` is free).
        var val = A(h('span', 'col__val', h('span', '', format(v))), 'pop', startDelay + values.length * step + 250);
        css(val, { bottom: 'calc(' + pct.toFixed(2) + '% + ' + u(7) + ')' });
        if (i === 0) css(val, { left: '0', translate: '0 0' });
        else if (i === values.length - 1) css(val, { left: 'auto', right: '0', translate: '0 0' });
        else css(val, { translate: '-50% 0' });
        track.appendChild(val);
      }
      cols.appendChild(h('div', 'col' + (i === peak ? ' is-peak' : ''), [track, h('span', 'col__lab', labels[i])]));
    });
    return cols;
  }

  function week(s) {
    var W = s.by_weekday;
    var sum = F.sum(W);
    if (!(sum > 0)) return null;
    var peak = F.argmax(W);
    var slide = make('week', { ink: 'dark', world: '#ff9f0a', duration: 6500, label: 'Busiest weekday: ' + F.WEEKDAYS[peak] });
    decos(slide, ['week__d1']);

    var weekend = (W[5] + W[6]) / sum;
    var fact = [b(F.int(W[peak]) + ' ' + F.plural(W[peak], 'message')), ' landed on a ' + F.WEEKDAYS[peak] + '. '];
    fact = fact.concat(weekend >= 0.4 ? ['Weekends are ', b(F.pct(weekend)), ' of the chat.'] : ['Weekdays carry ', b(F.pct(1 - weekend)), ' of the chat.']);

    add(slide.body, [
      A(kicker('The week'), 'up', 100),
      A(h('h2', 'headline', WEEK_HEADLINES[peak]), 'up', 220),
      gap('m'),
      columns(W, F.WEEKDAY_LETTERS, peak, 550, 85, function (v) { return v >= 100000 ? F.compact(v) : F.int(v); }),
      gap('m'),
      A(bubble('white', 'left', fact), 'pop-l', 2100)
    ]);
    return slide;
  }

  function year(s) {
    var M = s.by_month;
    var sum = F.sum(M);
    if (!(sum > 0)) return null;
    var peak = F.argmax(M);
    var slide = make('year', { ink: 'dark', world: '#00c7be', duration: 6500, label: 'Busiest month: ' + F.MONTHS[peak] });
    decos(slide, ['year__d1 deco--l']);

    var day = s.busiest_day;
    var callout;
    if (day && day.messages > 0) {
      var wd = F.weekdayOf(day.date);
      callout = bubble('white', 'left', [
        h('span', 'year__date', F.date(day.date, { short: true })),
        h('span', '', [h('small', '', 'Busiest day'), b(F.int(day.messages) + ' ' + F.plural(day.messages, 'message')), wd >= 0 ? ' on a ' + F.WEEKDAYS[wd] : ''])
      ], 'year__day');
    } else {
      callout = bubble('white', 'left', [b(F.int(M[peak]) + ' ' + F.plural(M[peak], 'message')), ' in ' + F.MONTHS[peak] + ' alone. That is ', b(F.pct(M[peak] / sum)), ' of the year.']);
    }

    add(slide.body, [
      A(kicker('The year'), 'up', 100),
      A(h('h2', 'headline', F.MONTHS[peak] + ' went off.'), 'up', 220),
      gap('m'),
      columns(M, F.MONTH_LETTERS, peak, 550, 55, function (v) { return v >= 10000 ? F.compact(v) : F.int(v); }),
      gap('m'),
      A(callout, 'pop-l', 2150)
    ]);
    return slide;
  }

  // ── 8. top senders ─────────────────────────────────────────────────────────

  function senders(s) {
    var list = s.senders.filter(function (p) { return p.messages > 0; });
    if (list.length < 2) return null;
    var top = list[0];
    var rows = list.slice(1, 5);
    var more = list.slice(5);
    var slide = make('senders', { ink: 'light', world: '#ff2d55', duration: 7500, label: 'Top sender: ' + top.name + ' with ' + F.int(top.messages) + ' messages' });
    decos(slide, ['senders__d1', 'senders__d2 deco--l']);

    var rowsStart = 500;
    var firstAt = rowsStart + rows.length * 140 + 300;

    var name = h('span', 'fit rank__name', h('span', '', top.name));
    fitLine(slide, name, { max: 58, min: 22, stretches: [112, 96, 80, 64] });
    var first = A(h('li', 'rank__first bubble bubble--white bubble--left', [
      A(G.icon('crown', 'rank__crown'), 'drop', firstAt + 380, 0.55),
      name,
      h('span', 'rank__stat', [b(F.int(top.messages)), ' ' + F.plural(top.messages, 'message') + '  ·  ', b(F.pct(top.share, 1))])
    ]), 'pop-l', firstAt);

    var ol = h('ol', 'rank', first);
    rows.forEach(function (p, i) {
      var at = rowsStart + (rows.length - 1 - i) * 140;
      var fill = A(h('b', 'rank__fill'), 'grow-x', at + 200, 0.9);
      fill.style.width = Math.max(3, Math.min(100, (p.messages / top.messages) * 100)).toFixed(2) + '%';
      ol.appendChild(A(h('li', 'rank__row', [
        h('span', 'rank__pos', String(i + 2)),
        h('span', 'rank__who', p.name),
        h('span', 'rank__pct', F.pct(p.share, 1)),
        h('div', 'rank__track', fill)
      ]), 'up', at));
    });

    add(slide.body, [
      A(kicker('Top senders'), 'up', 100),
      A(h('h2', 'headline', list.length === 2 ? 'It takes two.' : 'Who carried the chat'), 'up', 220),
      gap('s'),
      ol,
      more.length ? A(h('p', 'senders__more', '+' + more.length + ' more: ' + more.map(function (p) { return p.name; }).join(', ')), 'fade', firstAt + 700) : null
    ]);
    slide.cues.push({ at: firstAt + 380, haptic: 'medium' });
    return slide;
  }

  // ── 9. message of the year ─────────────────────────────────────────────────

  /** Expand {laugh: 4, love: 1} into up to `cap` individual badges, biggest kind first. */
  function badgeList(kinds, cap) {
    var entries = Object.keys(kinds).map(function (k) { return [k, kinds[k]]; }).sort(function (a, z) { return z[1] - a[1]; });
    var totalCount = F.sum(entries.map(function (e) { return e[1]; }));
    if (!totalCount) return [];
    var out = [];
    if (totalCount <= cap) {
      entries.forEach(function (e) { for (var i = 0; i < e[1]; i++) out.push(e[0]); });
      return out;
    }
    // Too many to show one by one: keep proportions, at least one of each kind that fits.
    var shown = entries.slice(0, cap);
    var left = cap - shown.length;
    var counts = shown.map(function () { return 1; });
    for (var n = 0; n < left; n++) {
      var best = 0, bestGap = -1;
      for (var k = 0; k < shown.length; k++) {
        var g = shown[k][1] / totalCount - counts[k] / cap;
        if (g > bestGap) { bestGap = g; best = k; }
      }
      counts[best]++;
    }
    shown.forEach(function (e, k) { for (var i = 0; i < counts[k]; i++) out.push(e[0]); });
    return out;
  }

  function kindEntries(kinds) {
    return Object.keys(kinds).map(function (k) { return [k, kinds[k]]; }).sort(function (a, z) { return z[1] - a[1]; });
  }

  /** Compact tapback counts for a runner-up: glyph ×n, glyph ×n. */
  function tally(kinds) {
    return h('span', 'moty__tally', kindEntries(kinds).map(function (e) {
      return h('span', '', [G.icon(e[0]), '×' + F.int(e[1])]);
    }));
  }

  /**
   * The hero when the recap carries no message text (the default: quotes are opt-in).
   * The tapbacks are the content: one badge per kind with its count, landing one by one.
   */
  function tallyBadges(kinds, at, step) {
    var entries = kindEntries(kinds);
    var node = h('span', 'moty__tally moty__tally--badges', entries.map(function (e, i) {
      return A(h('span', '', [G.tapback(e[0]), h('b', '', '×' + (e[1] >= 10000 ? F.compact(e[1]) : F.int(e[1])))]), 'drop', at + i * step, 0.5);
    }));
    // Up to three per row; four reads better as two and two.
    return css(node, { '--cols': entries.length === 4 ? 2 : Math.min(3, entries.length) });
  }

  function moty(s) {
    var m = s.most_reacted[0];
    if (!m || !(m.reactions > 0 || m.text)) return null;
    var slide = make('moty', { ink: 'dark', world: '#e9e9eb', backdrop: '#0a84ff', duration: 8000, label: 'Message of the year, from ' + m.sender + (m.text ? ': ' + m.text : ', ' + F.int(m.reactions) + ' ' + F.plural(m.reactions, 'tapback')) });
    decos(slide, ['moty__d1', 'moty__d2']);

    var len = Array.from(m.text).length;
    var fs = len <= 22 ? 35 : len <= 56 ? 27 : len <= 105 ? 23 : len <= 150 ? 20 : 18;
    var clamp = len <= 22 ? 3 : len <= 56 ? 4 : len <= 105 ? 5 : 6;
    var kindCount = Object.keys(m.kinds).length;
    var landAt = 1650;
    var landStep = 290;
    var landed = 0;
    var hero;

    if (m.text) {
      // The quote, with its tapbacks landing on the corner of the bubble one by one.
      hero = A(bubble('blue', 'left', h('span', 'moty__text', m.text), 'moty__bubble'), 'pop-l', 800);
      css(hero, { '--fs': fs, '--clamp': clamp });
      var badges = badgeList(m.kinds, 6);
      if (badges.length) {
        var tbs = h('span', 'moty__tbs');
        // row-reverse: the first badge in the DOM sits rightmost and lands first.
        badges.forEach(function (kind, i) { tbs.appendChild(A(G.tapback(kind), 'drop', landAt + i * landStep, 0.5)); });
        hero.appendChild(tbs);
        landed = badges.length;
      }
    } else if (kindCount) {
      // No message text in this recap: the bubble holds what the chat did with it.
      hero = A(bubble('blue', 'left', tallyBadges(m.kinds, landAt, landStep), 'moty__bubble moty__bubble--quiet'), 'pop-l', 800);
      landed = kindCount;
    } else {
      hero = A(bubble('blue', 'left', h('span', 'moty__text', F.int(m.reactions) + ' ' + F.plural(m.reactions, 'tapback')), 'moty__bubble'), 'pop-l', 800);
      css(hero, { '--fs': 30, '--clamp': 2 });
    }
    if (landed) slide.cues.push({ at: landAt, haptic: 'light' });
    var doneAt = landAt + landed * landStep;

    var from = h('p', 'moty__from', [avatar(m.sender, true), b(m.sender), m.date ? h('span', '', '·  ' + F.date(m.date)) : null]);
    var receipt = m.reactions > 0
      ? h('p', 'moty__receipt', [b(F.int(m.reactions) + ' ' + F.plural(m.reactions, 'tapback')), m.text ? '  ·  the most all year' : '  ·  the words stayed in the chat'])
      : null;

    var runners = s.most_reacted.slice(1, 3).filter(function (r) { return r.reactions > 0 || r.text; });
    var runnerNodes = runners.map(function (r, i) {
      var inner = r.text ? h('span', '', r.text) : (Object.keys(r.kinds).length ? tally(r.kinds) : h('span', '', F.int(r.reactions) + ' ' + F.plural(r.reactions, 'tapback')));
      var meta = [b(r.sender)];
      if (r.date) meta.push('  ·  ' + F.date(r.date, { short: true }));
      if (r.reactions > 0) meta.push('  ·  ' + F.int(r.reactions) + ' ' + F.plural(r.reactions, 'tapback'));
      return A(h('div', 'moty__runner', [bubble('grey', 'left', inner), h('p', '', meta)]), 'up', doneAt + 700 + i * 180);
    });

    add(slide.body, [
      A(kicker(isYear(s.period.label) ? 'Most tapbacks of ' + s.period.label : 'Most tapbacks'), 'up', 100),
      A(h('h2', 'headline', 'Message of the year'), 'up', 220),
      gap('m'),
      A(from, 'up', 600),
      hero,
      receipt ? A(receipt, 'fade', doneAt + 250) : null,
      runnerNodes.length ? gap('m') : null,
      runnerNodes.length ? h('div', 'moty__runners', [A(kicker(F.plural(runnerNodes.length, 'Runner-up', 'Runners-up')), 'fade', doneAt + 600)].concat(runnerNodes)) : null
    ]);
    return slide;
  }

  // ── 10. tapbacks ───────────────────────────────────────────────────────────

  // Slots for up to seven circles, biggest first: [centre x, centre y, largest radius].
  var CLOUD = [[88, 106, 84], [238, 72, 62], [262, 180, 46], [176, 196, 34], [310, 120, 22], [26, 204, 22], [112, 214, 20]];

  function taps(s) {
    var r = s.reactions;
    var totalTaps = s.totals.reactions;
    if (!r || !(totalTaps > 0)) return null;
    var kinds = G.TAPBACKS.map(function (t) { return { kind: t.kind, count: r.by_kind[t.kind] || 0 }; })
      .filter(function (k) { return k.count > 0; })
      .sort(function (a, z) { return z.count - a.count; });
    var slide = make('taps', { ink: 'light', world: '#5e5ce6', duration: 7000, label: F.int(totalTaps) + ' tapbacks' });
    decos(slide, ['taps__d1']);

    var value = h('span', '', F.int(totalTaps));
    var num = A(h('div', 'taps__num num fit', value), 'up', 250, 0.9);
    var top = h('div', 'taps__top', [num, A(h('p', 'taps__cap', [F.plural(totalTaps, 'tapback') + '.', h('br'), kinds.length ? TAP_HEADLINES[kinds[0].kind] : '']), 'up', 500)]);
    fitLine(slide, num, { max: 96, min: 36, stretches: [100, 84, 70, 62], text: F.int(totalTaps), avail: function () { return top.clientWidth * 0.6; } });
    slide.counts.push({ el: value, to: totalTaps, at: 300, dur: 1300 });

    var cloud = null;
    if (kinds.length) {
      cloud = h('div', 'taps__cloud');
      kinds.forEach(function (k, i) {
        var slot = CLOUD[i];
        var radius = Math.max(Math.min(18, slot[2]), Math.min(slot[2], CLOUD[0][2] * Math.sqrt(k.count / kinds[0].count)));
        var dot = A(h('div', 'taps__dot tb--' + k.kind + (i === 0 ? ' is-top' : ''), [G.icon(k.kind), b(radius < 30 ? F.compact(k.count) : F.int(k.count))]), 'pop', 950 + i * 130);
        css(dot, {
          left: u(slot[0] - radius), top: u(slot[1] - radius), width: u(radius * 2), height: u(radius * 2),
          'font-size': u(radius * (radius < 30 ? 0.62 : 0.72))
        });
        css(dot.lastChild, { 'font-size': u(Math.max(8, radius * 0.3)), 'margin-top': u(radius * 0.06) });
        cloud.appendChild(dot);
      });
    }

    var people = [];
    if (r.top_giver) people.push(A(bubble('white', 'left', [h('small', '', 'Most generous'), b(r.top_giver.name), r.top_giver.count > 0 ? ' gave ' + F.int(r.top_giver.count) : '']), 'pop-l', 2300));
    if (r.top_receiver) people.push(A(bubble('ink', 'right', [h('small', '', 'Most adored'), b(r.top_receiver.name), r.top_receiver.count > 0 ? ' got ' + F.int(r.top_receiver.count) : '']), 'pop-r', 2750));

    add(slide.body, [
      A(kicker('Tapbacks'), 'up', 100),
      top,
      cloud ? gap('s') : null,
      cloud,
      people.length ? gap('s') : null,
      people.length ? h('div', 'taps__people', people) : null
    ]);
    return slide;
  }

  // ── 11. chat awards ────────────────────────────────────────────────────────

  function awards(s) {
    var list = s.awards;
    if (!list.length) return null;
    var slide = make('awards', { ink: 'dark', world: '#ffd60a', duration: 6000 + list.length * 450, label: 'Chat awards: ' + list.map(function (a) { return a.title + ', ' + a.winner; }).join('; ') });
    decos(slide, ['awards__d1']);

    var big = list.length <= 3;
    var grid = h('ul', 'awards__grid awards__grid--' + list.length);
    list.forEach(function (a, i) {
      var winner = h('p', 'award__winner fit', h('span', '', a.winner));
      fitLine(slide, winner, { max: big ? 34 : 27, min: 12, stretches: [104, 88, 74, 62] });
      var title = h('p', 'award__title fit', h('span', '', a.title));
      fitLine(slide, title, { max: big ? 12 : 10.5, min: 7, stretches: [112, 100, 86, 72, 62] });
      grid.appendChild(A(h('li', 'award', [
        h('span', 'award__emoji', a.emoji || '🏆'),
        title,
        winner,
        a.detail ? h('p', 'award__detail', a.detail) : null
      ]), 'pop', 550 + i * 230));
    });

    add(slide.body, [
      A(kicker('Chat awards'), 'up', 100),
      A(h('h2', 'headline', list.length === 1 ? 'And the award goes to…' : 'And the winners are…'), 'up', 220),
      gap('m'),
      grid,
      // Opt-in AI-written awards are labelled as such (docs/SCHEMA.md §4).
      list.some(function (a) { return a.ai; }) ? A(h('p', 'awards__ai', 'These awards were written by AI.'), 'fade', 550 + list.length * 230 + 300) : null
    ]);
    slide.cues.push({ at: 550, haptic: 'light' });
    return slide;
  }

  // ── 12. summary + share ────────────────────────────────────────────────────

  function button(action, text, glyph, extra) {
    var node = h('button', 'btn' + (extra ? ' ' + extra : ''), [glyph ? G.icon(glyph) : null, h('span', '', text)]);
    node.type = 'button';
    node.setAttribute('data-action', action);
    return node;
  }

  function summary(s, env) {
    var slide = make('sum', { ink: 'light', world: '#1d1b3a', duration: 6000, label: 'Summary card. Share it, copy the link, or replay.' });
    slide.last = true;

    var canvas = env.card ? env.card(s) : document.createElement('canvas');
    canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-label', 'Summary card for ' + s.chat.name);
    slide.canvas = canvas;

    var actions;
    if (env.embed) {
      actions = [
        button('send', 'Send to this chat', 'send', 'btn--send'),
        h('div', 'btn-row', [button('share', 'Share card', 'share'), button('replay', 'Replay', 'replay')])
      ];
    } else {
      var makeLink = h('a', 'sum__make', 'Make one for your chat  →');
      makeLink.href = Config.MAKE_PATH;
      makeLink.setAttribute('data-web-only', '');
      actions = [
        button('share', 'Share card', 'share', 'btn--primary'),
        h('div', 'btn-row', [button('copy', 'Copy link', 'link'), button('replay', 'Replay', 'replay')]),
        makeLink
      ];
    }

    add(slide.body, [
      A(kicker("That's " + (isYear(s.period.label) ? s.period.label : 'the recap')), 'up', 100),
      A(h('h2', 'headline', env.embed ? 'Now send it to the chat.' : 'One for the group chat.'), 'up', 220),
      gap('m'),
      A(h('div', 'sum__card', canvas), 'rise', 450),
      gap('m'),
      A(h('div', 'sum__actions', actions), 'up', 1000)
    ]);
    slide.cues.push({ at: 450, haptic: 'success' });
    return slide;
  }

  // ── build ──────────────────────────────────────────────────────────────────

  var ORDER = [cover, total, clock, persona, late, week, year, senders, moty, taps, awards, summary];

  function build(stats, env) {
    env = env || {};
    var slides = [];
    ORDER.forEach(function (builder) {
      var slide = builder(stats, env);
      if (slide) slides.push(slide);
    });
    return slides;
  }

  root.WrappedSlides = { build: build, badgeList: badgeList, titleLines: titleLines };
})(typeof window !== 'undefined' ? window : globalThis);
