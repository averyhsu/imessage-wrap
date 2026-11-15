/*
 * The story player: window.WrappedStory.
 *
 *   WrappedStory.start(stats, { mount, embed, payload, demo, onClose })
 *   WrappedStory.pause() / .resume() / .toggle()
 *   WrappedStory.next() / .prev() / .goTo(i) / .replay() / .close() / .destroy()
 *   WrappedStory.index / .total / .slideIds
 *   WrappedStory.settle()   finish the current slide's entrances at once (snapshots, tests)
 *   WrappedStory.seek(ms)   take over the clock and show the current slide at `ms`
 *                           (frame-by-frame capture); .resume() hands the clock back
 *
 * Mechanics: segmented progress bar, auto-advance, tap right/left, hold to pause, arrow
 * keys and space, a close button and replay. With "reduce motion" on, nothing moves on
 * its own: the viewer taps to go on and the progress bar is a row of static segments. One requestAnimationFrame loop drives the
 * progress bar, the count-ups and the auto-advance; entrances are CSS animations that are
 * paused through one class on the stage.
 */
(function (root) {
  'use strict';

  var Slides = root.WrappedSlides;
  var Card = root.WrappedCard;
  var Codec = root.WrappedCodec;
  var Config = root.WrappedConfig;
  var Bridge = root.WrappedBridge;
  var G = root.WrappedGlyphs;
  var F = root.WrappedFormat;

  var DESIGN_W = 390;
  var DESIGN_H = 700;
  var HOLD_MS = 220;
  var LEAVE_MS = 420;

  var S = null; // the running story, or null

  function h(tag, cls, kids) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (kids != null) (Array.isArray(kids) ? kids : [kids]).forEach(function (k) {
      if (k == null) return;
      node.appendChild(k.nodeType ? k : document.createTextNode(String(k)));
    });
    return node;
  }

  /** Recap text carries its own direction (a right-to-left name truncates at its end). */
  function dirAuto(node) { node.setAttribute('dir', 'auto'); return node; }

  function textButton(cls, action, labelText) {
    var b = h('button', cls, labelText);
    b.type = 'button';
    b.setAttribute('data-action', action);
    return b;
  }

  function iconButton(cls, action, labelText, glyphs) {
    var b = h('button', cls, glyphs.map(function (g) { return G.icon(g); }));
    b.type = 'button';
    b.setAttribute('data-action', action);
    b.setAttribute('aria-label', labelText);
    return b;
  }

  function reducedMotion() {
    return !!(root.matchMedia && root.matchMedia('(prefers-reduced-motion: reduce)').matches);
  }

  function easeOutExpo(p) { return p >= 1 ? 1 : 1 - Math.pow(2, -10 * p); }

  // ── building ───────────────────────────────────────────────────────────────

  function start(stats, opts) {
    destroy();
    opts = opts || {};
    var mount = opts.mount || document.getElementById('story');
    if (!mount) throw new Error('WrappedStory.start: no mount element');

    var embed = !!opts.embed;
    mount.textContent = '';
    mount.hidden = false;
    mount.className = 'story' + (embed ? ' is-embed' : '');

    var live = h('div', 'sr-only');
    live.setAttribute('aria-live', 'polite');

    var calm = reducedMotion();
    var slides = Slides.build(stats, { embed: embed, calm: calm, card: function (s) { return Card.render(s); } });
    var slidesEl = h('div', 'slides', slides.map(function (s) { return s.el; }));
    var segs = slides.map(function () { return h('i', 'seg', h('b')); });

    // Previous / Next for keyboards and screen readers (touch has the tap zones, a framed
    // desktop stage has its arrows). They come after the visible controls and show
    // themselves when focused, so there is never an invisible stop in the tab order.
    var skipPrev = textButton('story__skip story__skip--prev', 'prev', 'Previous slide');
    var skipNext = textButton('story__skip story__skip--next', 'next', 'Next slide');
    var pauseBtn = iconButton('head__btn head__pause', 'toggle', 'Pause', ['pause', 'play']);
    var chrome = h('div', 'chrome', [
      h('div', 'segs', segs),
      h('div', 'head', [
        h('span', 'head__badge', F.initial(stats.chat.name)),
        dirAuto(h('span', 'head__name', stats.chat.name)),
        stats.period.label ? h('span', 'head__label', stats.period.label) : null,
        h('span', 'head__space'),
        pauseBtn,
        iconButton('head__btn head__close', 'close', 'Close', ['close'])
      ])
    ]);
    chrome.firstChild.setAttribute('aria-hidden', 'true');

    var toast = h('div', 'toast');
    toast.setAttribute('role', 'status');

    var stage = h('div', 'stage', [slidesEl, chrome, skipPrev, skipNext, toast, live]);
    stage.setAttribute('role', 'group');
    stage.setAttribute('aria-roledescription', 'story');
    stage.setAttribute('aria-label', stats.chat.name + ', ' + F.inReview(stats.period.label));

    var probe = h('div', 'story__probe');
    var prevArrow = iconButton('story__arrow story__arrow--prev', 'prev', 'Previous slide', ['prev']);
    var nextArrow = iconButton('story__arrow story__arrow--next', 'next', 'Next slide', ['next']);
    var keys = h('p', 'story__keys', '←  →  to move   ·   space to pause   ·   esc to close');
    keys.setAttribute('aria-hidden', 'true');

    [h('div', 'story__backdrop'), stage, prevArrow, nextArrow, keys, probe].forEach(function (n) { mount.appendChild(n); });

    S = {
      stats: stats, opts: opts, embed: embed, mount: mount, stage: stage, slides: slides, segs: segs,
      live: live, toast: toast, probe: probe, prevArrow: prevArrow, nextArrow: nextArrow, pauseBtn: pauseBtn,
      index: -1, t: 0, last: 0, raf: 0, holds: {}, leaving: [], down: null, holdTimer: 0, toastTimer: 0,
      cardBlob: null, unit: 1, listeners: [], calm: calm, ended: false
    };
    mount.classList.toggle('is-calm', calm);

    // "Reduce motion" can be switched while the story is open.
    var motion = root.matchMedia ? root.matchMedia('(prefers-reduced-motion: reduce)') : null;
    if (motion) {
      var onMotion = function () {
        if (!S) return;
        S.calm = !!motion.matches;
        S.mount.classList.toggle('is-calm', S.calm);
        applyTime();
      };
      if (motion.addEventListener) { motion.addEventListener('change', onMotion); S.listeners.push([motion, 'change', onMotion, false]); }
      else if (motion.addListener) motion.addListener(onMotion);
    }

    listen(root, 'resize', layout);
    listen(root, 'orientationchange', layout);
    if (root.visualViewport) listen(root.visualViewport, 'resize', layout);
    listen(document, 'keydown', onKey);
    listen(document, 'visibilitychange', function () { hold('hidden', document.hidden); });
    listen(mount, 'click', onClick);
    listen(stage, 'pointerdown', onDown);
    listen(stage, 'pointerup', onUp);
    listen(stage, 'pointercancel', onCancel);
    listen(stage, 'pointerleave', onCancel);
    listen(stage, 'contextmenu', function (e) { e.preventDefault(); });
    listen(stage, 'dragstart', function (e) { e.preventDefault(); });

    layout();
    goTo(0, 'start');
    hold('hidden', !!document.hidden); // opened in a background tab: wait until it is looked at
    S.last = now();
    S.raf = root.requestAnimationFrame(tick);

    // Fonts change every measurement: lay out again when they are in, and redraw the card.
    var token = S;
    Card.ready().then(function () {
      if (S !== token) return;
      layout();
      var summary = slides[slides.length - 1];
      if (summary.canvas) Card.render(stats, { canvas: summary.canvas });
      prepareCard();
    });

    Bridge.post({ type: 'ready', slides: slides.length });
    Bridge.post({ type: 'slide', index: 0, total: slides.length });
    return api;
  }

  function listen(target, type, fn, options) {
    target.addEventListener(type, fn, options || false);
    S.listeners.push([target, type, fn, options || false]);
  }

  function destroy() {
    if (!S) return;
    root.cancelAnimationFrame(S.raf);
    clearTimeout(S.holdTimer);
    clearTimeout(S.toastTimer);
    S.listeners.forEach(function (l) { l[0].removeEventListener(l[1], l[2], l[3]); });
    S.mount.textContent = '';
    S.mount.hidden = true;
    S.mount.className = 'story';
    S = null;
  }

  function now() { return root.performance && performance.now ? performance.now() : Date.now(); }

  // ── layout ─────────────────────────────────────────────────────────────────

  function layout() {
    if (!S) return;
    var vw = S.mount.clientWidth;
    var vh = S.mount.clientHeight;
    if (!vw || !vh) return;

    // Phones in portrait get the whole screen; everything else gets a phone-shaped stage.
    var framed = !(vw <= 540 && vh >= vw * 1.15);
    var w = vw;
    var hgt = vh;
    var insetT = 0;
    var insetB = 0;
    if (framed) {
      var margin = vw > 700 && vh > 560 ? 30 : 10;
      hgt = Math.max(120, Math.min(vh - margin * 2, 900));
      w = Math.max(80, Math.min(vw - margin * 2, hgt * 9 / 16));
      hgt = Math.min(hgt, w * 2.17);
      // Whole pixels, centred on whole pixels: a stage that starts at x = 483.75 is
      // rendered a little soft.
      w = Math.floor(w);
      hgt = Math.floor(hgt);
      if ((vw - w) % 2) w -= 1;
      if ((vh - hgt) % 2) hgt -= 1;
    } else {
      var cs = getComputedStyle(S.probe);
      insetT = parseFloat(cs.paddingTop) || 0;
      insetB = parseFloat(cs.paddingBottom) || 0;
    }
    var unit = Math.min(w / DESIGN_W, (hgt - insetT - insetB) / DESIGN_H);
    S.unit = unit;
    S.mount.classList.toggle('is-framed', framed);
    S.mount.classList.toggle('has-arrows', framed && vw - w >= 230 && !!(root.matchMedia && root.matchMedia('(hover: hover)').matches));
    S.mount.style.setProperty('--u', unit.toFixed(4) + 'px');
    S.mount.style.setProperty('--stage-w', w.toFixed(2) + 'px');
    S.mount.style.setProperty('--stage-h', hgt.toFixed(2) + 'px');
    S.slides.forEach(function (slide) {
      slide.fits.forEach(function (fit) { fit(unit); });
    });
  }

  // ── clock ──────────────────────────────────────────────────────────────────

  function paused() {
    for (var k in S.holds) if (S.holds[k]) return true;
    return false;
  }

  function hold(reason, on) {
    if (!S) return;
    S.holds[reason] = !!on;
    var p = paused();
    S.stage.classList.toggle('is-paused', p);
    S.stage.classList.toggle('is-user-paused', !!S.holds.user);
    // The button names its action: "Pause" while playing, "Play" once the viewer paused.
    S.pauseBtn.setAttribute('aria-label', S.holds.user ? 'Play' : 'Pause');
    if (!p) S.last = now();
  }

  function tick(time) {
    if (!S) return;
    S.raf = root.requestAnimationFrame(tick);
    var dt = Math.min(Math.max(0, time - S.last), 100);
    S.last = time;
    if (paused()) return;
    S.t += dt;
    applyTime();
    var slide = S.slides[S.index];
    if (S.t >= slide.duration) {
      // With "reduce motion" the story waits for the viewer on every slide.
      if (S.calm) S.t = slide.duration;
      else if (S.index < S.slides.length - 1) goTo(S.index + 1, 'auto');
      else S.ended = true;
    }
  }

  /** Bring everything that depends on the slide clock in line with S.t. */
  function applyTime() {
    var slide = S.slides[S.index];
    var t = S.t;
    var seg = S.segs[S.index].firstChild;
    // Static segments under "reduce motion": the current one is simply filled.
    seg.style.transform = S.calm ? 'scaleX(1)' : 'scaleX(' + Math.max(0, Math.min(1, t / slide.duration)).toFixed(4) + ')';

    for (var i = 0; i < slide.counts.length; i++) {
      var c = slide.counts[i];
      var p = S.calm ? 1 : Math.max(0, Math.min(1, (t - c.at) / c.dur));
      var text = (c.format || F.int)(Math.round(c.to * easeOutExpo(p)));
      if (c.el.textContent !== text) c.el.textContent = text;
    }

    for (var j = 0; j < slide.cues.length; j++) {
      var cue = slide.cues[j];
      if (!cue.done && t >= cue.at) {
        cue.done = true;
        if (cue.haptic && !S.manual) Bridge.haptic(cue.haptic);
      }
    }

    if (S.leaving.length && t >= LEAVE_MS) {
      S.leaving.forEach(function (el) { el.classList.remove('is-leaving'); });
      S.leaving = [];
    }
  }

  // ── navigation ─────────────────────────────────────────────────────────────

  function goTo(i, cause) {
    if (!S) return;
    i = Math.round(Number(i));
    if (!isFinite(i)) return;
    i = Math.max(0, Math.min(S.slides.length - 1, i));
    var prev = S.slides[S.index];
    var next = S.slides[i];

    S.leaving.forEach(function (el) { el.classList.remove('is-leaving'); });
    S.leaving = [];
    if (prev && prev !== next) {
      prev.el.classList.remove('is-active');
      prev.el.setAttribute('aria-hidden', 'true');
      prev.el.classList.add('is-leaving');
      S.leaving.push(prev.el);
    }

    // Removing and re-adding the class restarts every entrance, including on replay.
    next.el.classList.remove('is-leaving');
    next.el.classList.remove('is-active');
    void next.el.offsetWidth;
    next.el.classList.add('is-active');
    next.el.setAttribute('aria-hidden', 'false');

    var changed = S.index !== i;
    S.index = i;
    S.t = 0;
    S.ended = false;
    next.cues.forEach(function (c) { c.done = false; });

    S.stage.setAttribute('data-ink', next.ink);
    S.stage.setAttribute('data-slide', next.id);
    S.mount.style.setProperty('--world', next.world);
    S.mount.style.setProperty('--backdrop', next.backdrop);
    var theme = document.querySelector('meta[name="theme-color"]');
    if (theme) theme.setAttribute('content', next.world);

    S.segs.forEach(function (seg, k) {
      seg.firstChild.style.transform = 'scaleX(' + (k < i ? 1 : 0) + ')';
    });
    S.prevArrow.disabled = i === 0;
    S.nextArrow.disabled = i === S.slides.length - 1;
    S.live.textContent = 'Slide ' + (i + 1) + ' of ' + S.slides.length + '. ' + next.label;

    applyTime();
    if (S.manual) seek(0);

    if (cause !== 'start') {
      if (changed) Bridge.post({ type: 'slide', index: i, total: S.slides.length });
      if (changed && cause === 'user') Bridge.haptic('light');
    }
    if (typeof S.opts.onSlide === 'function') S.opts.onSlide(i, S.slides.length, next.id);
  }

  function next() {
    if (!S) return;
    if (S.index < S.slides.length - 1) goTo(S.index + 1, 'user');
  }

  function prev() {
    if (!S) return;
    // Like every stories player: a tap on the left restarts the first slide.
    goTo(Math.max(0, S.index - 1), 'user');
  }

  function replay() {
    if (!S) return;
    hold('user', false);
    hold('api', false);
    goTo(0, 'user');
  }

  function close() {
    if (!S) return;
    var onClose = S.opts.onClose;
    Bridge.post({ type: 'close' });
    hold('api', true);
    if (typeof onClose === 'function') onClose();
  }

  // ── input ──────────────────────────────────────────────────────────────────

  function interactive(target) {
    return !!(target && target.closest && target.closest('button, a, input, [data-action]'));
  }

  function onDown(e) {
    if (e.button) return;
    if (interactive(e.target)) return;
    S.down = { x: e.clientX, y: e.clientY, held: false };
    clearTimeout(S.holdTimer);
    S.holdTimer = setTimeout(function () {
      if (!S || !S.down) return;
      S.down.held = true;
      hold('hold', true);
    }, HOLD_MS);
  }

  function onUp(e) {
    if (!S.down) return;
    var d = S.down;
    S.down = null;
    clearTimeout(S.holdTimer);
    if (d.held) { hold('hold', false); return; }
    var dx = e.clientX - d.x;
    var dy = e.clientY - d.y;
    if (Math.abs(dx) > 44 && Math.abs(dx) > Math.abs(dy) * 1.2) { dx < 0 ? next() : prev(); return; }
    if (Math.abs(dx) > 12 || Math.abs(dy) > 12) return; // a drag, not a tap
    var rect = S.stage.getBoundingClientRect();
    (e.clientX - rect.left) < rect.width * 0.3 ? prev() : next();
  }

  function onCancel() {
    if (!S || !S.down) return;
    var held = S.down.held;
    S.down = null;
    clearTimeout(S.holdTimer);
    if (held) hold('hold', false);
  }

  function onKey(e) {
    if (!S || e.metaKey || e.ctrlKey || e.altKey) return;
    var onControl = interactive(e.target);
    switch (e.key) {
      case 'ArrowRight': case 'ArrowDown': case 'PageDown': next(); break;
      case 'ArrowLeft': case 'ArrowUp': case 'PageUp': prev(); break;
      case 'Home': goTo(0, 'user'); break;
      case 'End': goTo(S.slides.length - 1, 'user'); break;
      case 'Escape': close(); break;
      case ' ': case 'Spacebar': if (onControl) return; toggle(); break;
      default: return;
    }
    e.preventDefault();
  }

  function onClick(e) {
    var el = e.target.closest ? e.target.closest('[data-action]') : null;
    if (!el || !S) return;
    var action = el.getAttribute('data-action');
    if (action === 'prev') prev();
    else if (action === 'next') next();
    else if (action === 'toggle') toggle();
    else if (action === 'close') close();
    else if (action === 'replay') replay();
    else if (action === 'share') share();
    else if (action === 'copy') copyLink();
    else if (action === 'send') send();
    else return;
    e.preventDefault();
  }

  function toggle() {
    if (!S) return;
    hold('user', !S.holds.user);
  }

  // ── actions on the last slide ──────────────────────────────────────────────

  function toastMessage(text, glyph) {
    if (!S) return;
    S.toast.textContent = '';
    if (glyph) S.toast.appendChild(G.icon(glyph));
    S.toast.appendChild(document.createTextNode(text));
    S.toast.classList.add('is-on');
    clearTimeout(S.toastTimer);
    var token = S;
    S.toastTimer = setTimeout(function () { if (S === token) S.toast.classList.remove('is-on'); }, 2200);
  }

  function slug(text) {
    return String(text).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  }

  function cardFileName() {
    var parts = [slug(Config.PRODUCT_NAME), slug(S.stats.chat.name), slug(S.stats.period.label)].filter(Boolean);
    return parts.join('-') + '.png';
  }

  function shareText() {
    return S.stats.chat.name + ' — ' + F.inReview(S.stats.period.label);
  }

  /** Render the PNG ahead of time so "Share card" can call navigator.share synchronously. */
  function prepareCard() {
    var token = S;
    return Card.toBlob(S.stats).then(function (blob) {
      if (S === token) S.cardBlob = blob;
      return blob;
    }).catch(function () { return null; });
  }

  function download(blob, name) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
  }

  function share() {
    if (!S) return Promise.resolve('none');
    if (S.embed) {
      // The native shell owns the share sheet.
      var png = Card.toDataURL(S.stats);
      Bridge.post({ type: 'share', png: png, text: shareText() });
      return Promise.resolve('bridge');
    }
    var token = S;
    var name = cardFileName();
    // With the PNG already rendered, navigator.share runs inside the tap (Safari insists).
    if (S.cardBlob) return Promise.resolve(deliver(S.cardBlob));
    return prepareCard().then(deliver);

    function deliver(blob) {
      if (!blob || S !== token) return 'none';
      var file = null;
      try { file = new File([blob], name, { type: 'image/png' }); } catch (e) { file = null; }
      if (file && navigator.share && navigator.canShare && navigator.canShare({ files: [file] })) {
        return navigator.share({ files: [file], title: shareText(), text: shareText() }).then(function () {
          return 'shared';
        }, function (err) {
          if (err && err.name === 'AbortError') return 'cancelled';
          download(blob, name);
          toastMessage('Card saved', 'check');
          return 'downloaded';
        });
      }
      download(blob, name);
      toastMessage('Card saved', 'check');
      return 'downloaded';
    }
  }

  /** The link that reproduces this recap. */
  function link() {
    if (!S) return '';
    if (S.opts.payload) return Config.BASE_URL + '#' + Config.PAYLOAD_KEY + '=' + S.opts.payload;
    if (S.opts.demo) return Config.BASE_URL + '?demo=1';
    // A recap handed over directly (WrappedApp.load) may show quotes on this device, but a
    // link built from it carries no message text: quotes are opt-in at the maker (D12).
    return Codec.buildLink(S.stats);
  }

  function copyLink() {
    if (!S) return Promise.resolve(false);
    var url;
    try { url = link(); } catch (e) { toastMessage('This recap is too big for a link'); return Promise.resolve(false); }
    function done() { toastMessage('Link copied', 'check'); return true; }
    function fallback() {
      var ta = document.createElement('textarea');
      ta.value = url;
      ta.setAttribute('readonly', '');
      ta.className = 'sr-only';
      document.body.appendChild(ta);
      ta.select();
      var ok = false;
      try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
      ta.remove();
      if (ok) return done();
      toastMessage('Copy failed. Long-press the address bar instead');
      return false;
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(url).then(done, fallback);
    }
    return Promise.resolve(fallback());
  }

  function send() {
    if (!S) return;
    Bridge.post({ type: 'send' });
    Bridge.haptic('success');
    toastMessage('Added to your message', 'check');
  }

  // ── snapshots and frame-by-frame capture ───────────────────────────────────

  function animations() {
    return S.stage.getAnimations ? S.stage.getAnimations({ subtree: true }) : [];
  }

  /** Jump to the end of the current slide's entrances. */
  function settle() {
    if (!S) return;
    var slide = S.slides[S.index];
    S.t = Math.max(S.t, slide.duration - 60);
    applyTime();
    animations().forEach(function (a) {
      try {
        var timing = a.effect && a.effect.getComputedTiming ? a.effect.getComputedTiming() : null;
        if (timing && timing.iterations === Infinity) return;
        a.finish();
      } catch (e) { /* infinite or already gone */ }
    });
  }

  /** Manual clock: freeze real time and show the current slide exactly `ms` after it began. */
  function seek(ms) {
    if (!S) return;
    S.manual = true;
    hold('manual', true);
    S.t = Math.max(0, Number(ms) || 0);
    applyTime();
    animations().forEach(function (a) {
      try { a.pause(); a.currentTime = S.t; } catch (e) { /* ignore */ }
    });
  }

  function resume() {
    if (!S) return;
    if (S.manual) {
      S.manual = false;
      animations().forEach(function (a) { try { a.play(); } catch (e) { /* ignore */ } });
    }
    hold('manual', false);
    hold('api', false);
    hold('user', false);
  }

  // ── public API ─────────────────────────────────────────────────────────────

  var api = {
    start: start,
    destroy: destroy,
    pause: function () { hold('api', true); },
    resume: resume,
    toggle: toggle,
    next: next,
    prev: prev,
    goTo: function (i) { goTo(i, 'api'); },
    replay: replay,
    close: close,
    layout: layout,
    settle: settle,
    seek: seek,
    share: share,
    copyLink: copyLink,
    link: link,
    send: send,
    isActive: function () { return !!S; },
    isPaused: function () { return !!S && paused(); }
  };

  Object.defineProperties(api, {
    index: { enumerable: true, get: function () { return S ? S.index : -1; } },
    total: { enumerable: true, get: function () { return S ? S.slides.length : 0; } },
    slideIds: { enumerable: true, get: function () { return S ? S.slides.map(function (s) { return s.id; }) : []; } },
    time: { enumerable: true, get: function () { return S ? S.t : 0; } },
    duration: { enumerable: true, get: function () { return S ? S.slides[S.index].duration : 0; } }
  });

  root.WrappedStory = api;
})(typeof window !== 'undefined' ? window : globalThis);
