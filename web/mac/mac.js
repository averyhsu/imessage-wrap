/*
 * The Mac app's download page (web/mac/): a walkthrough, one step in focus at a time.
 *
 * Without JavaScript every step is simply shown in order. With it, the page shows one step,
 * an "I did this" button moves on, and "Show all steps" goes back to the full list. All of
 * that state lives in memory: nothing is stored, nothing is sent anywhere.
 */
(function (root) {
  'use strict';

  /* ═══════════════════════════════════════════════════════════════════════════════════
     WHAT macOS SAYS. The one place the page quotes macOS's own words: the "could not
     verify" message, its buttons, and the Privacy & Security settings that let the app
     open. {app} stands for the product name (../js/config.js).

     APPROXIMATE: written as docs/research/08-mac-one-click-distribution.md gives them,
     not yet checked against a real Mac. Correct a string here once it has been seen on
     macOS (and set `approximate` to false when all of them have been). index.html carries
     the same words as its text for browsers without JavaScript; `npm test`
     (tests/js/mac-site.test.js) names every place there that no longer matches.
     ═══════════════════════════════════════════════════════════════════════════════════ */
  var MACOS_TEXT = {
    approximate: true,
    // The message on first open, and its two buttons.
    notOpenedTitle: '“{app}” Not Opened',
    notOpenedBody: 'Apple could not verify “{app}” is free of malware that may harm your Mac or compromise your privacy.',
    done: 'Done',
    moveToTrash: 'Move to Trash',
    // Where the way through is, and what it says there.
    appleMenu: 'Apple menu',
    systemSettings: 'System Settings',
    privacySecurity: 'Privacy & Security',
    securityHeading: 'Security',
    blockedLine: '“{app}” was blocked to protect your Mac.',
    openAnyway: 'Open Anyway',
    // The question macOS asks after the password, one last time.
    confirmOpen: 'Open Anyway',
    // The message with no way past it (a broken download).
    damaged: '“{app}” is damaged and can’t be opened. You should move it to the Trash.'
  };

  /** What the page calls the device it is on, when that device is not a Mac. */
  var DEVICES = {
    iphone: 'an iPhone',
    ipad: 'an iPad',
    android: 'an Android phone',
    windows: 'a Windows computer',
    chromebook: 'a Chromebook',
    linux: 'a Linux computer'
  };

  /**
   * Which kind of device a browser is on, from its user agent. iPads ask for the desktop
   * site and say "Macintosh"; they are the Macs with a touch screen.
   */
  function platform(userAgent, touchPoints) {
    var ua = String(userAgent || '');
    if (/iPhone|iPod/.test(ua)) return 'iphone';
    if (/iPad/.test(ua)) return 'ipad';
    if (/Android/i.test(ua)) return 'android';
    if (/Windows/i.test(ua)) return 'windows';
    if (/CrOS/.test(ua)) return 'chromebook';
    if (/Macintosh|Mac OS X/.test(ua)) return (touchPoints || 0) > 1 ? 'ipad' : 'mac';
    if (/Linux|X11/.test(ua)) return 'linux';
    return 'unknown';
  }

  /** A macOS string with the product name filled in. */
  function macos(key, name) {
    return String(MACOS_TEXT[key]).split('{app}').join(name);
  }

  /** A download address the page is willing to point at: https:// or a relative path. */
  function usableDownload(url) {
    var u = String(url || '').trim();
    if (!u) return '';
    if (/^https:\/\//i.test(u)) return u;
    if (/^[a-z][a-z0-9+.-]*:/i.test(u) || u.charAt(0) === '/' || u.indexOf('//') === 0) return '';
    return u;
  }

  var Guide = { MACOS_TEXT: MACOS_TEXT, DEVICES: DEVICES, platform: platform, macos: macos, usableDownload: usableDownload };
  root.WrappedMacGuide = Guide;
  if (typeof module === 'object' && module.exports) module.exports = Guide;
  if (!root.document) return;

  // ── the page ─────────────────────────────────────────────────────────────────────────

  var doc = root.document;
  var Config = root.WrappedConfig || {};
  var MacConfig = root.WrappedMacConfig || {};
  var NAME = Config.PRODUCT_NAME || 'the app';
  var $ = function (id) { return doc.getElementById(id); };
  var all = function (selector, scope) { return Array.prototype.slice.call((scope || doc).querySelectorAll(selector)); };

  // Names and macOS's words.
  all('[data-brand]').forEach(function (el) { el.textContent = NAME; });
  all('[data-macos]').forEach(function (el) {
    var key = el.getAttribute('data-macos');
    if (Object.prototype.hasOwnProperty.call(MACOS_TEXT, key) && typeof MACOS_TEXT[key] === 'string') el.textContent = macos(key, NAME);
  });
  all('[data-approx]').forEach(function (el) { el.hidden = !MACOS_TEXT.approximate; });
  all('[data-source]').forEach(function (el) { if (MacConfig.SOURCE_URL) el.setAttribute('href', MacConfig.SOURCE_URL); });

  // Which device, and whether there is a download.
  var device = platform(root.navigator && root.navigator.userAgent, root.navigator && root.navigator.maxTouchPoints);
  var download = usableDownload(MacConfig.MAC_DOWNLOAD_URL);
  doc.documentElement.setAttribute('data-device', device);
  var notMac = Object.prototype.hasOwnProperty.call(DEVICES, device);
  if (notMac) {
    $('not-mac-device').textContent = DEVICES[device];
    $('not-mac').hidden = false;
  }
  if (download) {
    $('download').setAttribute('href', download);
    $('download').hidden = notMac;
    $('download-note').hidden = notMac;
  } else {
    $('download-none').hidden = notMac;
  }

  // ── the walkthrough ──────────────────────────────────────────────────────────────────

  var steps = all('.mg-step');
  var rail = all('#rail > li');
  var status = $('status');
  var toggle = $('show-all');
  var state = { current: 1, all: false };
  var still = root.matchMedia && root.matchMedia('(prefers-reduced-motion: reduce)');

  function titleOf(n) {
    var h = steps[n - 1].querySelector('.mg-step__title');
    return h ? h.textContent.replace(/\s+/g, ' ').trim() : '';
  }

  function render() {
    doc.documentElement.classList.toggle('mg-all', state.all);
    steps.forEach(function (step, i) {
      var n = i + 1;
      var on = state.all || n === state.current;
      step.classList.toggle('is-active', on);
      step.classList.toggle('is-done', !state.all && n < state.current);
      step.classList.toggle('is-locked', !state.all && n > state.current);
      if (n === state.current && !state.all) step.setAttribute('aria-current', 'step');
      else step.removeAttribute('aria-current');
      var body = step.querySelector('.mg-step__body');
      if (body) body.hidden = !on;
      var next = step.querySelector('.mg-next');
      if (next) next.hidden = state.all || n !== state.current;
      var again = step.querySelector('.mg-again');
      if (again) again.hidden = state.all || n >= state.current;
    });
    rail.forEach(function (li, i) {
      var n = i + 1;
      li.classList.toggle('is-done', state.all ? false : n < state.current);
      li.classList.toggle('is-current', !state.all && n === state.current);
      if (!state.all && n === state.current) li.setAttribute('aria-current', 'step');
      else li.removeAttribute('aria-current');
    });
    toggle.setAttribute('aria-pressed', state.all ? 'true' : 'false');
    toggle.textContent = state.all ? 'One step at a time' : 'Show all steps';
    $('progress-label').textContent = state.all ? 'All ' + steps.length + ' steps' : 'Step ' + state.current + ' of ' + steps.length;
  }

  function bring(n) {
    var step = steps[n - 1];
    var heading = step.querySelector('.mg-step__title');
    var smooth = !(still && still.matches);
    if (step.scrollIntoView) step.scrollIntoView({ block: 'start', behavior: smooth ? 'smooth' : 'auto' });
    if (heading) heading.focus({ preventScroll: true });
  }

  function go(n) {
    state.current = Math.max(1, Math.min(steps.length, n));
    state.all = false;
    render();
    status.textContent = 'Step ' + state.current + ' of ' + steps.length + ': ' + titleOf(state.current);
    bring(state.current);
  }

  steps.forEach(function (step, i) {
    var n = i + 1;
    var next = step.querySelector('.mg-next');
    if (next) next.addEventListener('click', function () { go(n + 1); });
    var again = step.querySelector('.mg-again');
    if (again) again.addEventListener('click', function () { go(n); });
  });
  rail.forEach(function (li, i) {
    var button = li.querySelector('button');
    if (button) button.addEventListener('click', function () { go(i + 1); });
  });
  toggle.addEventListener('click', function () {
    state.all = !state.all;
    render();
    status.textContent = state.all ? 'Showing all ' + steps.length + ' steps.' : 'Showing step ' + state.current + ' of ' + steps.length + '.';
  });
  var restart = $('restart');
  if (restart) {
    restart.hidden = false;
    restart.addEventListener('click', function () { go(1); });
  }

  // The progress bar sticks to the top of the window; it gets a backing once it does.
  var progress = $('progress');
  progress.hidden = false;
  function stuck() { progress.classList.toggle('is-stuck', progress.getBoundingClientRect().top <= 0.5 && root.scrollY > 0); }
  root.addEventListener('scroll', stuck, { passive: true });
  root.addEventListener('resize', stuck);
  stuck();
  doc.documentElement.classList.add('mg-js');
  render();

  /** For tests: where the walkthrough is. */
  Guide.state = function () { return { current: state.current, all: state.all, device: device, download: download }; };
})(typeof window !== 'undefined' ? window : globalThis);
