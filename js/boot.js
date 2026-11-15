/*
 * Runs in <head>, before anything is painted: decide whether this visit is the landing
 * page, a story or the embedded story, so the wrong one never flashes on screen.
 * Deliberately tiny and dependency-free. The real routing happens in app.js.
 */
(function () {
  'use strict';
  var q = String(location.search || '');
  var f = String(location.hash || '');
  var wk = window.webkit;
  var shell = !!(wk && wk.messageHandlers && wk.messageHandlers.wrapped);
  var mode = 'is-landing';
  // ?embed= only means "embedded" when the native shell is really there (see app.js).
  if (shell && (/[?&#]embed=/.test(q) || /[?&#]embed=/.test(f))) mode = 'is-embed';
  else if (/[?&#]w1(=|&|$)/.test(q) || /[?&#]w1(=|&|$)/.test(f) || /[?&#]demo=(1|true)\b/.test(q) || /[?&#]demo=(1|true)\b/.test(f)) mode = 'is-story';
  document.documentElement.className = (document.documentElement.className + ' js ' + mode).replace(/^\s+/, '');
})();
