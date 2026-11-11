/*
 * Page controller: reads the URL and shows the landing page, a story, or an error card.
 *
 *   (nothing)            landing page
 *   #w1=<payload>        the recap carried in the fragment      (docs/SCHEMA.md §5)
 *   ?w1=<payload>        the same, for transports that drop fragments
 *   ?demo=1              the built-in invented demo
 *   ?embed=ios           inside the iOS shell: no landing page, bridge on (docs/SCHEMA.md §6).
 *                        Only when window.webkit.messageHandlers.wrapped exists; in a plain
 *                        browser the same URL plays as an ordinary web story.
 *
 * Also exposes window.WrappedApp for hosts:
 *   WrappedApp.load(statsOrJson)   play a recap handed over directly (native → web)
 *   WrappedApp.route()             re-read the URL
 */
(function (root) {
  'use strict';

  var Config = root.WrappedConfig;
  var Codec = root.WrappedCodec;
  var Data = root.WrappedData;
  var Story = root.WrappedStory;
  var Card = root.WrappedCard;
  var Bridge = root.WrappedBridge;
  var G = root.WrappedGlyphs;
  var F = root.WrappedFormat;

  var html = document.documentElement;
  var landing = document.getElementById('landing');
  var mount = document.getElementById('story');
  var baseTitle = document.title;
  var pushed = false;       // did we add a history entry for the demo?
  var current = null;       // { stats, payload, demo } of the recap in the URL, if any

  function setMode(mode) {
    html.classList.remove('is-landing', 'is-story', 'is-embed');
    html.classList.add(mode);
    if (mode === 'is-embed') html.classList.add('is-story');
  }

  // ── landing ────────────────────────────────────────────────────────────────

  function fillBrand() {
    var nodes = document.querySelectorAll('[data-brand]');
    for (var i = 0; i < nodes.length; i++) nodes[i].textContent = Config.PRODUCT_NAME;
    var desc = document.querySelectorAll('[data-descriptor]');
    for (var j = 0; j < desc.length; j++) desc[j].textContent = Config.DESCRIPTOR;
    var taps = document.querySelectorAll('[data-tapback]');
    for (var k = 0; k < taps.length; k++) {
      if (!taps[k].firstChild) taps[k].appendChild(G.tapback(taps[k].getAttribute('data-tapback')));
    }
  }

  var heroDrawn = false;
  function drawHero() {
    var canvas = document.getElementById('hero-card');
    if (!canvas || !root.WRAPPED_DEMO) return;
    var demo;
    try { demo = Data.normalize(root.WRAPPED_DEMO); } catch (e) { return; }
    if (!heroDrawn) Card.render(demo, { canvas: canvas });
    heroDrawn = true;
    Card.ready().then(function () { Card.render(demo, { canvas: canvas }); });
  }

  function showLanding() {
    Story.destroy();
    setMode('is-landing');
    document.title = baseTitle;
    html.style.removeProperty('background-color');
    var theme = document.querySelector('meta[name="theme-color"]');
    if (theme) theme.setAttribute('content', '#07070c');
    var again = document.getElementById('play-recap');
    var demoBtn = document.getElementById('play-demo');
    if (again) again.hidden = !(current && !current.demo);
    if (demoBtn) demoBtn.classList.toggle('l-btn--primary', !(current && !current.demo));
    if (again) again.classList.toggle('l-btn--primary', !!(current && !current.demo));
    drawHero();
  }

  // ── story ──────────────────────────────────────────────────────────────────

  function play(stats, info) {
    info = info || {};
    var embed = Bridge.isEnabled();
    setMode(embed ? 'is-embed' : 'is-story');
    document.title = stats.chat.name + ' — ' + F.inReview(stats.period.label);
    Story.start(stats, {
      mount: mount,
      embed: embed,
      payload: info.payload || null,
      demo: !!info.demo,
      onClose: function () { if (!embed) leave(); }
    });
  }

  /** The close button on the web: back to the landing page without losing the recap URL. */
  function leave() {
    if (pushed) {
      pushed = false;
      try { history.back(); return; } catch (e) { /* fall through */ }
    }
    if (current && current.demo) {
      current = null;
      try { history.replaceState(null, '', location.pathname); } catch (e) { /* file:// */ }
    }
    showLanding();
  }

  function showError(error) {
    Story.destroy();
    var embed = Bridge.isEnabled();
    setMode(embed ? 'is-embed' : 'is-story');
    mount.hidden = false;
    mount.className = 'story is-error' + (embed ? ' is-embed' : '');
    mount.textContent = '';

    var card = document.createElement('div');
    card.className = 'story-error';
    var h2 = document.createElement('h2');
    h2.textContent = "This link didn't survive the trip.";
    var p = document.createElement('p');
    p.textContent = (error && error.message ? error.message + ' ' : '') + 'Ask whoever sent it to share it again, as its own message.';
    card.appendChild(h2);
    card.appendChild(p);
    if (!embed) {
      var demo = document.createElement('a');
      demo.className = 'btn btn--primary';
      demo.href = '?demo=1';
      demo.textContent = 'Play the demo instead';
      var home = document.createElement('a');
      home.className = 'btn';
      home.href = './';
      home.textContent = 'What is this?';
      card.appendChild(demo);
      card.appendChild(home);
    }
    var stage = document.createElement('div');
    stage.className = 'stage';
    stage.appendChild(card);
    mount.appendChild(stage);
    sizeError();
    Bridge.post({ type: 'error', message: error && error.message ? String(error.message) : 'Unreadable recap' });
  }

  function sizeError() {
    if (!mount.classList.contains('is-error')) return;
    var vw = mount.clientWidth, vh = mount.clientHeight;
    var framed = !(vw <= 540 && vh >= vw * 1.15);
    var hgt = framed ? Math.min(vh - 40, 760) : vh;
    var w = framed ? Math.min(vw - 40, hgt * 9 / 16) : vw;
    mount.classList.toggle('is-framed', framed);
    mount.style.setProperty('--u', Math.min(w / 390, hgt / 700).toFixed(4) + 'px');
    mount.style.setProperty('--stage-w', w + 'px');
    mount.style.setProperty('--stage-h', hgt + 'px');
  }

  // ── routing ────────────────────────────────────────────────────────────────

  /**
   * ?w1= puts the recap in the request line, so whoever served this page has seen it once.
   * Keep it out of every later request, bookmark and browser share by moving it behind
   * the # (which is never sent). Nothing this site produces uses the query form; this is
   * for links that arrive that way from elsewhere.
   */
  function moveToFragment(payload) {
    if (!/^https?:$/.test(root.location.protocol)) return;
    try {
      var rest = root.location.search.replace(/^\?/, '').split('&').filter(function (pair) {
        return pair && pair.split('=')[0] !== Config.PAYLOAD_KEY;
      });
      var url = root.location.pathname + (rest.length ? '?' + rest.join('&') : '') + '#' + Config.PAYLOAD_KEY + '=' + payload;
      history.replaceState(history.state, '', url);
    } catch (e) { /* leave the address as it is */ }
  }

  function route() {
    var loc = Codec.parseLocation(root.location);
    // Embed mode needs the native shell on the other end of the bridge. A plain browser
    // that opens an ?embed= link gets the ordinary web story, with its way out.
    Bridge.enable(!!loc.embed && Bridge.isConnected());
    current = null;

    if (loc.payload) {
      if (loc.source === 'query') moveToFragment(loc.payload);
      var stats;
      try { stats = Data.normalize(Codec.decode(loc.payload)); } catch (e) { showError(e); return; }
      current = { stats: stats, payload: loc.payload, demo: false };
      play(stats, current);
      return;
    }
    if (loc.damaged) {
      // There was a w1= but nothing readable in it: say so, rather than act as if no link came.
      showError(new Error('The recap link is damaged (nothing readable in it).'));
      return;
    }
    if (loc.demo && root.WRAPPED_DEMO) {
      current = { stats: Data.normalize(root.WRAPPED_DEMO), payload: null, demo: true };
      play(current.stats, current);
      return;
    }
    if (Bridge.isEnabled()) {
      // The shell may hand the recap over with WrappedApp.load(); until then, stay quiet.
      Story.destroy();
      setMode('is-embed');
      return;
    }
    showLanding();
  }

  /** Native → web: play a recap object (or its JSON) directly. */
  function load(statsOrJson) {
    var stats;
    try { stats = Data.normalize(statsOrJson); } catch (e) { showError(e); return false; }
    current = { stats: stats, payload: null, demo: false };
    play(stats, current);
    return true;
  }

  function onPlayDemo(e) {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button) return; // let people open a new tab
    e.preventDefault();
    try {
      history.pushState({ demo: true }, '', '?demo=1');
      pushed = true;
    } catch (err) {
      root.location.search = '?demo=1'; // file:// cannot pushState: do a real navigation
      return;
    }
    route();
  }

  function onPlayRecap(e) {
    e.preventDefault();
    if (current) play(current.stats, current);
  }

  function init() {
    fillBrand();
    var demoBtn = document.getElementById('play-demo');
    var art = document.getElementById('hero-art');
    var again = document.getElementById('play-recap');
    if (demoBtn) demoBtn.addEventListener('click', onPlayDemo);
    if (art) art.addEventListener('click', onPlayDemo);
    if (again) again.addEventListener('click', onPlayRecap);
    root.addEventListener('popstate', function () { pushed = false; route(); });
    root.addEventListener('hashchange', route);
    root.addEventListener('resize', sizeError);
    route();
    html.classList.add('is-ready');
  }

  root.WrappedApp = { route: route, load: load, showLanding: showLanding };
  init();
})(window);
