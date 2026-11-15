/* Placeholder story for the iOS shell. Implements the embed bridge (docs/SCHEMA.md §6).
   Classic script, no modules, no network. All sample content is invented. */
(function () {
  'use strict';

  var SLIDE_MS = 6000;
  var FALLBACK = {
    v: 1,
    chat: { name: 'Demo chat', members: 4 },
    period: { label: '2026' },
    totals: { messages: 1234 },
    senders: [
      { name: 'Ada', messages: 600 },
      { name: 'Bo', messages: 400 },
      { name: 'Cy', messages: 234 }
    ],
    personality: { title: 'The Placeholder Crew', blurb: 'The payload could not be read, so this is filler.' }
  };

  var stage = document.getElementById('stage');
  var progress = document.getElementById('progress');
  var stats = FALLBACK;
  var slides = [];
  var index = -1;
  var timer = null;
  var paused = false;
  var remaining = SLIDE_MS;
  var startedAt = 0;

  // ---- bridge -------------------------------------------------------------------------

  function post(message) {
    try {
      var handlers = window.webkit && window.webkit.messageHandlers;
      if (handlers && handlers.wrapped) {
        handlers.wrapped.postMessage(message);
      }
    } catch (e) { /* not embedded */ }
  }

  // ---- payload ------------------------------------------------------------------------

  function findPayload() {
    var sources = [window.location.hash.replace(/^#/, ''), window.location.search.replace(/^\?/, '')];
    for (var i = 0; i < sources.length; i++) {
      var parts = sources[i].split('&');
      for (var j = 0; j < parts.length; j++) {
        if (parts[j].indexOf('w1=') === 0) {
          return decodeURIComponent(parts[j].slice(3));
        }
      }
    }
    return null;
  }

  function base64UrlToBytes(text) {
    var s = text.replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) { s += '='; }
    var binary = window.atob(s);
    var bytes = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i++) { bytes[i] = binary.charCodeAt(i); }
    return bytes;
  }

  function decodePayload(payload) {
    if (typeof DecompressionStream !== 'function') {
      return Promise.reject(new Error('DecompressionStream is unavailable'));
    }
    var stream = new Blob([base64UrlToBytes(payload)]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Response(stream).text().then(function (json) { return JSON.parse(json); });
  }

  // ---- slides -------------------------------------------------------------------------

  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  function count(n) {
    return Number(n || 0).toLocaleString('en-US');
  }

  function buildSlides() {
    var chat = (stats.chat && stats.chat.name) || 'Your group chat';
    var label = (stats.period && stats.period.label) || '';
    var review = label ? label + ' in review' : 'In review';
    var total = (stats.totals && stats.totals.messages) || 0;
    var senders = (stats.senders || []).slice(0, 3);
    var top = senders.length ? senders[0].messages || 1 : 1;
    var personality = stats.personality || {};

    var bars = senders.map(function (s) {
      var width = Math.max(6, Math.round(((s.messages || 0) / top) * 100));
      return '<div class="bar"><div class="row"><span>' + esc(s.name) + '</span><span>' + count(s.messages) +
        '</span></div><div class="track"><span style="width:' + width + '%"></span></div></div>';
    }).join('');

    slides = [
      '<div class="eyebrow">' + esc(review) + '</div><h1>' + esc(chat) + '</h1>' +
        '<p class="lead">Tap the right side to move on, the left side to go back.</p>',
      '<div class="eyebrow">Together you sent</div><div class="big">' + count(total) + '</div>' +
        '<p class="lead">messages. That is a lot of typing.</p>',
      '<div class="eyebrow">Loudest voices</div><h1>Top of the chat</h1><div class="bars">' + bars + '</div>',
      '<div class="eyebrow">Your group is</div><h1>' + esc(personality.title || 'One of a kind') + '</h1>' +
        '<p class="lead">' + esc(personality.blurb || '') + '</p>',
      '<div class="eyebrow">' + esc(review) + '</div><h1>' + esc(chat) + '</h1>' +
        '<p class="lead">' + count(total) + ' messages. Pass it on.</p>' +
        '<div class="buttons">' +
        '<button class="primary" id="btn-send" type="button">Send to this chat</button>' +
        '<button id="btn-share" type="button">Share</button>' +
        '<button id="btn-close" type="button">Close</button></div>'
    ];

    progress.innerHTML = slides.map(function () { return '<i><b></b></i>'; }).join('');
    document.documentElement.style.setProperty('--slide-ms', SLIDE_MS + 'ms');
  }

  function render() {
    stage.className = 's' + index;
    stage.innerHTML = slides[index];
    var marks = progress.children;
    for (var i = 0; i < marks.length; i++) {
      marks[i].className = i < index ? 'done' : (i === index ? 'now' : '');
    }
    var send = document.getElementById('btn-send');
    var share = document.getElementById('btn-share');
    var close = document.getElementById('btn-close');
    if (send) { send.addEventListener('click', function (e) { e.stopPropagation(); post({ type: 'send' }); }); }
    if (share) { share.addEventListener('click', function (e) { e.stopPropagation(); shareCard(); }); }
    if (close) { close.addEventListener('click', function (e) { e.stopPropagation(); post({ type: 'close' }); }); }
  }

  function schedule(ms) {
    window.clearTimeout(timer);
    remaining = ms;
    startedAt = Date.now();
    if (!paused && index < slides.length - 1) {
      timer = window.setTimeout(function () { goTo(index + 1); }, ms);
    }
  }

  function goTo(next) {
    if (!slides.length) { return; }
    next = Math.max(0, Math.min(slides.length - 1, Number(next) || 0));
    if (next === index) { return; }
    index = next;
    render();
    post({ type: 'slide', index: index, total: slides.length });
    post({ type: 'haptic', style: index === slides.length - 1 ? 'success' : 'light' });
    schedule(SLIDE_MS);
  }

  function pause() {
    if (paused) { return; }
    paused = true;
    document.body.classList.add('paused');
    window.clearTimeout(timer);
    remaining = Math.max(300, remaining - (Date.now() - startedAt));
  }

  function resume() {
    if (!paused) { return; }
    paused = false;
    document.body.classList.remove('paused');
    schedule(remaining);
  }

  // ---- share card ---------------------------------------------------------------------

  function shareCard() {
    var chat = (stats.chat && stats.chat.name) || 'Your group chat';
    var label = (stats.period && stats.period.label) || '';
    var total = (stats.totals && stats.totals.messages) || 0;
    var canvas = document.createElement('canvas');
    canvas.width = 1080;
    canvas.height = 1350;
    var ctx = canvas.getContext('2d');
    var gradient = ctx.createLinearGradient(0, 0, 1080, 1350);
    gradient.addColorStop(0, '#ff3d7f');
    gradient.addColorStop(0.55, '#9b4dff');
    gradient.addColorStop(1, '#3d8bff');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, 1080, 1350);
    ctx.fillStyle = '#fff';
    ctx.font = '800 44px -apple-system, system-ui, sans-serif';
    ctx.fillText((label ? label + ' in review' : 'In review').toUpperCase(), 90, 180);
    ctx.font = '900 96px -apple-system, system-ui, sans-serif';
    ctx.fillText(chat, 90, 320, 900);
    ctx.font = '900 220px -apple-system, system-ui, sans-serif';
    ctx.fillText(count(total), 90, 760, 900);
    ctx.font = '700 60px -apple-system, system-ui, sans-serif';
    ctx.fillText('messages', 90, 860);
    post({
      type: 'share',
      png: canvas.toDataURL('image/png'),
      text: chat + ' · ' + (label ? label + ' in review' : 'in review') + ': ' + count(total) + ' messages'
    });
  }

  // ---- input --------------------------------------------------------------------------

  document.addEventListener('click', function (event) {
    if (event.target && event.target.closest && event.target.closest('button')) { return; }
    var x = event.clientX / Math.max(1, window.innerWidth);
    if (x < 0.3) { goTo(index - 1); } else { goTo(index + 1); }
  });

  window.WrappedStory = { pause: pause, resume: resume, goTo: goTo };

  // ---- start --------------------------------------------------------------------------

  function start() {
    index = -1;
    paused = false;
    document.body.classList.remove('paused');
    buildSlides();
    post({ type: 'ready', slides: slides.length });
    goTo(0);
  }

  /* Like the real story: with no recap in the address, wait quietly (the native shell
     warms the page up early and hands the recap over later by setting the #fragment). */
  function route() {
    var payload = findPayload();
    window.clearTimeout(timer);
    if (!payload) {
      index = -1;
      slides = [];
      stage.className = '';
      stage.innerHTML = '';
      progress.innerHTML = '';
      return;
    }
    decodePayload(payload).then(function (decoded) {
      stats = (decoded && typeof decoded === 'object') ? decoded : FALLBACK;
      start();
    }, function () {
      stats = FALLBACK;
      start();
    });
  }

  window.addEventListener('hashchange', route);
  window.WrappedApp = { route: route };
  route();
})();
