/*
 * Embed bridge to the native iOS shell (docs/SCHEMA.md §6).
 *
 * In embed mode (?embed=ios) the story posts plain objects to
 *   window.webkit.messageHandlers.wrapped.postMessage(obj)
 * Outside the shell every call is a harmless no-op, but each message is still dispatched
 * as a `wrapped:bridge` DOM event on window, which is handy for debugging and tests.
 */
(function (root) {
  'use strict';

  var enabled = false;
  var log = [];

  function handler() {
    var wk = root.webkit;
    return wk && wk.messageHandlers && wk.messageHandlers.wrapped ? wk.messageHandlers.wrapped : null;
  }

  var Bridge = {
    /** Turned on by the app when the page is loaded with ?embed=ios inside the native shell. */
    enable: function (on) { enabled = on !== false; },
    isEnabled: function () { return enabled; },
    /** True when a native handler is actually listening. */
    isConnected: function () { return !!handler(); },
    /** The most recent messages (newest last), for debugging. */
    log: log,

    post: function (message) {
      if (!enabled || !message || typeof message.type !== 'string') return false;
      log.push(message);
      if (log.length > 60) log.shift();
      try {
        if (typeof root.dispatchEvent === 'function' && typeof root.CustomEvent === 'function') {
          root.dispatchEvent(new root.CustomEvent('wrapped:bridge', { detail: message }));
        }
      } catch (e) { /* ignore */ }
      var h = handler();
      if (!h) return false;
      try { h.postMessage(message); return true; } catch (e) { return false; }
    },

    haptic: function (style) { return Bridge.post({ type: 'haptic', style: style || 'light' }); }
  };

  root.WrappedBridge = Bridge;
})(typeof window !== 'undefined' ? window : globalThis);
