/*
 * The shareable summary card: a 1080 × 1350 (4:5) poster drawn on a <canvas>.
 *
 *   var canvas = WrappedCard.render(stats);            // → HTMLCanvasElement, 1080 × 1350
 *   WrappedCard.toBlob(stats).then(function (png) {}); // → PNG Blob
 *   WrappedCard.toDataURL(stats);                      // → "data:image/png;base64,…"
 *
 * `stats` should already be normalised (WrappedData.normalize). Call WrappedCard.ready()
 * first (it resolves when the display font has loaded) or the first render uses fallbacks.
 *
 * Privacy: the card shows aggregate numbers and first names only. No message text, ever.
 */
(function (root) {
  'use strict';

  var F = root.WrappedFormat;
  var Config = root.WrappedConfig;

  var W = 1080;
  var H = 1350;
  var PAD = 72;
  var EMOJI = '"Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji"';
  var FAMILY = 'Archivo, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, ' + EMOJI + ', sans-serif';
  // Widths of the variable font that the canvas font shorthand can name.
  var WIDE = 'expanded';        // 125%
  var SEMI_WIDE = 'semi-expanded'; // 112.5%
  var NORMAL = 'normal';
  var NARROW = 'condensed';     // 75%
  var XNARROW = 'extra-condensed'; // 62.5%

  var PERSONA_EMOJI = {
    quiet_ones: '🤫', night_owls: '🦉', weekend_warriors: '🎉', always_on: '🔋', early_birds: '🐦',
    morning_meeting: '☕', lunch_break: '🥪', afternoon_slackers: '😎', dinner_table: '🍽️', after_hours: '🌙'
  };

  function font(weight, stretch, size) { return weight + ' ' + stretch + ' ' + size + 'px ' + FAMILY; }

  /** A name fit for a public card: first name only; raw phone numbers and e-mails are masked. */
  function cardName(name) {
    name = String(name == null ? '' : name).trim();
    if (!name) return '?';
    if (name.indexOf('@') > 0) return Array.from(name)[0].toUpperCase() + '…';
    var digits = name.replace(/\D/g, '');
    if (digits.length >= 7 && digits.length >= name.replace(/\s/g, '').length - 4) return '…' + digits.slice(-2);
    var first = name.split(/\s+/)[0];
    return F.truncate(first, 16);
  }

  // ── drawing helpers ────────────────────────────────────────────────────────

  function roundRect(ctx, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  /** A speech bubble with a tail at the bottom corner on `side` ('left' | 'right'). */
  function bubble(ctx, x, y, w, h, r, side, fill) {
    r = Math.min(r, h / 2, w / 2);
    ctx.fillStyle = fill;
    roundRect(ctx, x, y, w, h, r);
    ctx.fill();
    // Tail: the same outline as the CSS mask (--tail in base.css), in units where r = 18.
    var k = r / 18;
    var dir = side === 'right' ? 1 : -1;
    var bx = side === 'right' ? x + w - 18 * k : x + 18 * k;
    var by = y + h - 18 * k;
    function px(v) { return bx + dir * v * k; }
    function py(v) { return by + v * k; }
    ctx.beginPath();
    ctx.moveTo(px(16.5), py(-4));
    ctx.bezierCurveTo(px(17), py(6), px(19.5), py(14), px(25.5), py(17.6));
    ctx.bezierCurveTo(px(19), py(18.2), px(12), py(17.2), px(6), py(13.5));
    ctx.lineTo(px(6), py(-4));
    ctx.closePath();
    ctx.fill();
  }

  /** Largest size (≤ max) and widest cut at which `text` fits in `width` on one line. */
  function fitOne(ctx, text, width, weight, max, min, stretches) {
    for (var i = 0; i < stretches.length; i++) {
      ctx.font = font(weight, stretches[i], max);
      var w = ctx.measureText(text).width;
      if (w <= width) return { size: max, stretch: stretches[i], width: w };
      if (i === stretches.length - 1) {
        var size = Math.max(min, Math.floor(max * width / w));
        ctx.font = font(weight, stretches[i], size);
        return { size: size, stretch: stretches[i], width: ctx.measureText(text).width };
      }
    }
    return { size: max, stretch: NORMAL, width: 0 };
  }

  function ellipsize(ctx, text, width) {
    if (ctx.measureText(text).width <= width) return text;
    var chars = Array.from(text);
    while (chars.length > 1 && ctx.measureText(chars.join('') + '…').width > width) chars.pop();
    return chars.join('').replace(/\s+$/, '') + '…';
  }

  /** Greedy word wrap; words wider than the line are broken. */
  function wrap(ctx, text, width) {
    var lines = [];
    var line = '';
    String(text).split(/\s+/).filter(Boolean).forEach(function (word) {
      var candidate = line ? line + ' ' + word : word;
      if (ctx.measureText(candidate).width <= width) { line = candidate; return; }
      if (line) lines.push(line);
      line = word;
      while (ctx.measureText(line).width > width) {
        var chars = Array.from(line);
        var cut = chars.length - 1;
        while (cut > 1 && ctx.measureText(chars.slice(0, cut).join('')).width > width) cut--;
        lines.push(chars.slice(0, cut).join(''));
        line = chars.slice(cut).join('');
      }
    });
    if (line) lines.push(line);
    return lines;
  }

  /** The chat name: one line if it can stay big, otherwise the biggest two-line setting. */
  function fitTitle(ctx, text, width) {
    var size, i, lines;
    var one = [WIDE, SEMI_WIDE, NORMAL, NARROW];
    for (size = 116; size >= 88; size -= 4) {
      for (i = 0; i < one.length; i++) {
        ctx.font = font(900, one[i], size);
        if (ctx.measureText(text).width <= width) return { size: size, stretch: one[i], lines: [text] };
      }
    }
    var two = [WIDE, NORMAL, NARROW, XNARROW];
    for (size = 108; size >= 56; size -= 6) {
      for (i = 0; i < two.length; i++) {
        ctx.font = font(900, two[i], size);
        lines = wrap(ctx, text, width);
        if (lines.length <= 2) return { size: size, stretch: two[i], lines: lines };
      }
    }
    ctx.font = font(900, XNARROW, 56);
    lines = wrap(ctx, text, width);
    return { size: 56, stretch: XNARROW, lines: [lines[0], ellipsize(ctx, lines.slice(1).join(' '), width)] };
  }

  function label(ctx, text, x, y, color, align) {
    ctx.font = font(800, SEMI_WIDE, 25);
    ctx.fillStyle = color;
    ctx.textAlign = align || 'left';
    ctx.textBaseline = 'alphabetic';
    if ('letterSpacing' in ctx) ctx.letterSpacing = '3px';
    ctx.fillText(text.toUpperCase(), x, y);
    if ('letterSpacing' in ctx) ctx.letterSpacing = '0px';
  }

  function tilt(ctx, cx, cy, degrees, draw) {
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(degrees * Math.PI / 180);
    ctx.translate(-cx, -cy);
    draw();
    ctx.restore();
  }

  // ── the card ───────────────────────────────────────────────────────────────

  function draw(ctx, s) {
    var inner = W - PAD * 2;

    // Background: the cover's blue world with two oversized bubbles.
    var g = ctx.createLinearGradient(0, 0, W * 0.55, H);
    g.addColorStop(0, '#2a9bff');
    g.addColorStop(0.4, '#0a7aff');
    g.addColorStop(1, '#0042d6');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
    tilt(ctx, 900, 120, 14, function () { bubble(ctx, 560, -210, 760, 520, 170, 'right', '#46a6ff'); });
    tilt(ctx, 160, 1250, -10, function () { bubble(ctx, -330, 1010, 820, 600, 180, 'left', '#0036c2'); });

    // ── header: label pill + chat name ──
    var y = 78;
    var pillText = F.inReview(s.period.label).toUpperCase();
    ctx.font = font(800, SEMI_WIDE, 26);
    if ('letterSpacing' in ctx) ctx.letterSpacing = '3px';
    var pillW = Math.min(inner, ctx.measureText(pillText).width + 56);
    ctx.fillStyle = 'rgba(255,255,255,0.2)';
    roundRect(ctx, PAD, y, pillW, 58, 29);
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(ellipsize(ctx, pillText, pillW - 52), PAD + 28, y + 30);
    if ('letterSpacing' in ctx) ctx.letterSpacing = '0px';
    y += 58 + 34;

    var title = fitTitle(ctx, s.chat.name, inner);
    ctx.font = font(900, title.stretch, title.size);
    ctx.fillStyle = '#fff';
    ctx.textBaseline = 'alphabetic';
    title.lines.forEach(function (line, i) {
      ctx.fillText(line, PAD - 4, y + title.size * 0.8 + i * title.size * 0.94);
    });
    y += title.size * 0.94 * title.lines.length + 10;

    // ── blocks ──
    var blocks = [];

    // Total messages.
    var totalText = F.int(s.totals.messages);
    blocks.push({ h: 306, draw: function (top) {
      var num = fitOne(ctx, totalText, 780, 900, 218, 90, [NORMAL, NARROW, XNARROW]);
      var unit = F.plural(s.totals.messages, 'message');
      ctx.font = font(900, WIDE, 50);
      var unitW = ctx.measureText(unit).width;
      var w = Math.max(num.width, unitW) + 108;
      tilt(ctx, PAD + w / 2, top + 153, -2, function () {
        bubble(ctx, PAD, top, w, 306, 76, 'left', '#fff');
        ctx.textAlign = 'left';
        ctx.textBaseline = 'alphabetic';
        ctx.fillStyle = '#0a6cff';
        ctx.font = font(900, num.stretch, num.size);
        ctx.fillText(totalText, PAD + 50, top + 48 + 158);
        ctx.fillStyle = '#0b0b0f';
        ctx.font = font(900, WIDE, 50);
        ctx.fillText(unit, PAD + 54, top + 48 + 158 + 62);
      });
    } });

    // Personality.
    if (s.personality && s.personality.title) {
      blocks.push({ h: 178, draw: function (top) {
        var emoji = PERSONA_EMOJI[s.personality.id] || '💬';
        var text = s.personality.title;
        var fit = fitOne(ctx, text, 640, 900, 62, 34, [SEMI_WIDE, NORMAL, NARROW, XNARROW]);
        ctx.font = font(900, fit.stretch, fit.size);
        text = ellipsize(ctx, text, 640);
        var textW = ctx.measureText(text).width;
        var w = textW + 96 + 104;
        var x = W - PAD - w;
        tilt(ctx, x + w / 2, top + 89, 2, function () {
          bubble(ctx, x, top, w, 178, 64, 'right', '#0b0b0f');
          ctx.textAlign = 'left';
          ctx.textBaseline = 'middle';
          ctx.font = '84px ' + EMOJI + ', sans-serif';
          ctx.fillStyle = '#fff';
          ctx.fillText(emoji, x + 40, top + 94);
          label(ctx, 'Personality', x + 150, top + 62, '#ffd60a');
          ctx.font = font(900, fit.stretch, fit.size);
          ctx.fillStyle = '#fff';
          ctx.textBaseline = 'alphabetic';
          ctx.fillText(text, x + 148, top + 62 + 20 + fit.size * 0.74);
        });
      } });
    }

    // Top senders + peak hour, side by side.
    var top3 = s.senders.filter(function (p) { return p.messages > 0; }).slice(0, 3);
    var hasHours = F.sum(s.by_hour) > 0;
    var peak = hasHours ? F.argmax(s.by_hour) : -1;
    if (top3.length || hasHours) {
      var rowH = 58;
      var sendersH = top3.length ? 104 + top3.length * rowH + 30 : 0;
      blocks.push({ h: Math.max(sendersH, 214), draw: function (top) {
        var bottom = top + Math.max(sendersH, 214);
        var leftW = hasHours ? 574 : inner;
        if (top3.length) {
          var sy = bottom - sendersH;
          tilt(ctx, PAD + leftW / 2, sy + sendersH / 2, -1.5, function () {
            bubble(ctx, PAD, sy, leftW, sendersH, 64, 'left', '#30d158');
            label(ctx, top3.length > 1 ? 'Top senders' : 'Top sender', PAD + 44, sy + 66, 'rgba(3,32,12,0.62)');
            top3.forEach(function (p, i) {
              var ry = sy + 104 + i * rowH + 36;
              ctx.textBaseline = 'alphabetic';
              ctx.textAlign = 'left';
              ctx.fillStyle = 'rgba(3,32,12,0.5)';
              ctx.font = font(900, NORMAL, 40);
              ctx.fillText(String(i + 1), PAD + 44, ry);
              var pctText = F.pct(p.share, 1);
              ctx.font = font(800, NORMAL, 34);
              var pctW = ctx.measureText(pctText).width;
              ctx.fillStyle = '#03200c';
              ctx.textAlign = 'right';
              ctx.fillText(pctText, PAD + leftW - 44, ry);
              ctx.textAlign = 'left';
              ctx.font = font(900, NORMAL, 44);
              var nameW = leftW - 44 - 52 - 44 - pctW - 24;
              if (ctx.measureText(cardName(p.name)).width > nameW) ctx.font = font(900, NARROW, 44);
              ctx.fillText(ellipsize(ctx, cardName(p.name), nameW), PAD + 96, ry);
            });
          });
        }
        if (hasHours && peak >= 0) {
          var pw = top3.length ? inner - leftW - 30 : 380;
          var px = W - PAD - pw;
          var ph = 214;
          var pyTop = bottom - ph - (top3.length ? 18 : 0);
          tilt(ctx, px + pw / 2, pyTop + ph / 2, 3, function () {
            bubble(ctx, px, pyTop, pw, ph, 64, 'right', '#ffd60a');
            label(ctx, 'Peak hour', px + 40, pyTop + 66, 'rgba(11,11,15,0.6)');
            var hourText = F.hour(peak);
            var fit = fitOne(ctx, hourText, pw - 80, 900, 112, 60, [NORMAL, NARROW, XNARROW]);
            ctx.font = font(900, fit.stretch, fit.size);
            ctx.fillStyle = '#0b0b0f';
            ctx.textAlign = 'left';
            ctx.textBaseline = 'alphabetic';
            ctx.fillText(hourText, px + 38, pyTop + 66 + 24 + fit.size * 0.74);
          });
        }
      } });
    }

    // Distribute the blocks between the title and the footer.
    var footerTop = H - 104;
    var used = blocks.reduce(function (t, bl) { return t + bl.h; }, 0);
    var space = footerTop - y - used;
    var gapSize = Math.max(18, Math.min(64, space / (blocks.length + 0.5)));
    var cursor = y + Math.max(0, (space - gapSize * (blocks.length - 1)) / 2);
    cursor = Math.min(cursor, y + 70);
    if (space - gapSize * (blocks.length - 1) > 140) gapSize = Math.min(84, (footerTop - cursor - used - 20) / Math.max(1, blocks.length - 1));
    blocks.forEach(function (bl) {
      bl.draw(cursor);
      cursor += bl.h + gapSize;
    });

    // ── footer ──
    var site = Config.BASE_URL.replace(/^https?:\/\//, '').replace(/\/$/, '');
    ctx.textBaseline = 'alphabetic';
    ctx.textAlign = 'left';
    ctx.fillStyle = '#fff';
    ctx.font = font(900, SEMI_WIDE, 30);
    ctx.fillText(Config.PRODUCT_NAME, PAD, H - 56);
    var nameW = ctx.measureText(Config.PRODUCT_NAME).width;
    ctx.font = font(600, NORMAL, 26);
    ctx.fillStyle = 'rgba(255,255,255,0.78)';
    ctx.fillText('  ·  made on device', PAD + nameW, H - 56);
    ctx.textAlign = 'right';
    ctx.fillText(site, W - PAD, H - 56);
    ctx.textAlign = 'left';
  }

  // ── public API ─────────────────────────────────────────────────────────────

  function render(stats, opts) {
    opts = opts || {};
    var canvas = opts.canvas || document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    var ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, W, H);
    draw(ctx, stats);
    return canvas;
  }

  function toBlob(stats, opts) {
    var canvas = render(stats, opts);
    return new Promise(function (resolve, reject) {
      if (!canvas.toBlob) {
        try { resolve(dataUrlToBlob(canvas.toDataURL('image/png'))); } catch (e) { reject(e); }
        return;
      }
      canvas.toBlob(function (blob) { blob ? resolve(blob) : reject(new Error('Could not draw the card.')); }, 'image/png');
    });
  }

  function dataUrlToBlob(url) {
    var bin = atob(url.split(',')[1]);
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type: 'image/png' });
  }

  function toDataURL(stats, opts) { return render(stats, opts).toDataURL('image/png'); }

  /** Resolves once the display font is usable on a canvas (or after a short timeout). */
  function ready() {
    if (typeof document === 'undefined' || !document.fonts || !document.fonts.load) return Promise.resolve();
    var loads = Promise.all([
      document.fonts.load('900 100px Archivo', 'A1'),
      document.fonts.load('600 30px Archivo', 'A1')
    ]).catch(function () {});
    var timeout = new Promise(function (resolve) { setTimeout(resolve, 2500); });
    return Promise.race([loads, timeout]);
  }

  var Card = { WIDTH: W, HEIGHT: H, render: render, toBlob: toBlob, toDataURL: toDataURL, ready: ready, cardName: cardName };

  root.WrappedCard = Card;
  if (typeof module === 'object' && module.exports) module.exports = Card;
})(typeof window !== 'undefined' ? window : globalThis);
