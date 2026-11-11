/*
 * Link payload codec (docs/SCHEMA.md §5).
 *
 *   payload = base64url( raw-DEFLATE( UTF-8( JSON.stringify(stats) ) ) )   // no padding
 *   link    = BASE_URL + '#w1=' + payload                                  // or ?w1=
 *
 * Synchronous on purpose (works from file:// in a WKWebView, no CompressionStream needed).
 * Depends on the vendored fflate UMD build (web/js/vendor/fflate.min.js).
 */
(function (root) {
  'use strict';

  var isNode = typeof module === 'object' && module.exports;
  var fflate = root.fflate || (isNode ? require('./vendor/fflate.min.js') : null);
  var Config = root.WrappedConfig || (isNode ? require('./config.js') : null);

  /** Longest payload we are willing to inflate (characters). Real links stay under 4,800. */
  var MAX_PAYLOAD_CHARS = 24000;
  /** Largest JSON we are willing to parse after inflating (bytes). */
  var MAX_JSON_BYTES = 2 * 1024 * 1024;

  function CodecError(message, code) {
    var err = new Error(message);
    err.name = 'WrappedCodecError';
    err.code = code || 'invalid';
    return err;
  }

  // ── base64url ──────────────────────────────────────────────────────────────

  function bytesToBase64Url(bytes) {
    var bin = '';
    var CHUNK = 0x8000;
    for (var i = 0; i < bytes.length; i += CHUNK) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    var b64 = typeof btoa === 'function' ? btoa(bin) : Buffer.from(bin, 'binary').toString('base64');
    return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function base64UrlToBytes(text) {
    var b64 = text.replace(/-/g, '+').replace(/_/g, '/');
    while (b64.length % 4) b64 += '=';
    var bin;
    try {
      bin = typeof atob === 'function' ? atob(b64) : Buffer.from(b64, 'base64').toString('binary');
    } catch (e) {
      throw CodecError('The recap link is damaged (not valid base64url).', 'base64');
    }
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  /**
   * Tidy a payload that has been through a messaging app: percent-decoding, stray
   * whitespace, classic base64 characters, padding, and anything trailing the payload
   * (a full stop someone typed after the link, for instance).
   */
  function cleanPayload(payload) {
    var p = String(payload == null ? '' : payload);
    if (/%[0-9a-fA-F]{2}/.test(p)) {
      try { p = decodeURIComponent(p); } catch (e) { /* keep as is */ }
    }
    p = p.replace(/\s+/g, '').replace(/\+/g, '-').replace(/\//g, '_');
    var m = /^[A-Za-z0-9_-]+/.exec(p);
    return m ? m[0] : '';
  }

  // ── encode / decode ────────────────────────────────────────────────────────

  function encode(stats) {
    if (!stats || typeof stats !== 'object') throw CodecError('encode() needs a stats object.', 'input');
    var json = JSON.stringify(stats);
    var deflated = fflate.deflateSync(fflate.strToU8(json), { level: 9, mem: 9 });
    return bytesToBase64Url(deflated);
  }

  function decode(payload) {
    var p = cleanPayload(payload);
    if (!p) throw CodecError('The recap link is empty.', 'empty');
    if (p.length > MAX_PAYLOAD_CHARS) throw CodecError('The recap link is too long to be real.', 'too_long');
    var bytes = base64UrlToBytes(p);
    var inflated;
    try {
      inflated = fflate.inflateSync(bytes);
    } catch (e) {
      throw CodecError('The recap link is damaged (could not decompress).', 'inflate');
    }
    if (inflated.length > MAX_JSON_BYTES) throw CodecError('The recap link is too large.', 'too_large');
    var stats;
    try {
      stats = JSON.parse(fflate.strFromU8(inflated));
    } catch (e) {
      throw CodecError('The recap link is damaged (not valid JSON).', 'json');
    }
    if (!stats || typeof stats !== 'object' || Array.isArray(stats)) {
      throw CodecError('The recap link does not contain a recap.', 'shape');
    }
    return stats;
  }

  // ── link building with the §5 length budget ────────────────────────────────

  function clone(obj) { return JSON.parse(JSON.stringify(obj)); }

  /** Truncate by code points so JS and Python agree on astral characters. */
  function truncate(text, max) {
    var chars = Array.from(String(text));
    return chars.length > max ? chars.slice(0, max).join('') + '…' : String(text);
  }

  /** The deterministic trim ladder from docs/SCHEMA.md §5. Each step mutates `s`. */
  var TRIM_STEPS = [
    { id: 'awards.detail', apply: function (s) {
      if (Array.isArray(s.awards)) s.awards.forEach(function (a) { if (a && typeof a === 'object') delete a.detail; });
    } },
    { id: 'most_reacted.text<=60', apply: function (s) {
      if (Array.isArray(s.most_reacted)) s.most_reacted.forEach(function (m) {
        if (m && typeof m.text === 'string') m.text = truncate(m.text, 60);
      });
    } },
    { id: 'senders<=8', apply: function (s) {
      if (Array.isArray(s.senders)) s.senders = s.senders.slice(0, 8);
    } },
    { id: 'most_reacted<=1', apply: function (s) {
      if (Array.isArray(s.most_reacted)) s.most_reacted = s.most_reacted.slice(0, 1);
    } },
    { id: 'awards', apply: function (s) { delete s.awards; } },
    { id: 'senders<=5', apply: function (s) {
      if (Array.isArray(s.senders)) s.senders = s.senders.slice(0, 5);
    } }
  ];

  function linkFor(base, payload, form) {
    var b = String(base);
    if (form === 'query') return b + (b.indexOf('?') === -1 ? '?' : '&') + Config.PAYLOAD_KEY + '=' + payload;
    return b + '#' + Config.PAYLOAD_KEY + '=' + payload;
  }

  /**
   * Work out the link for a recap.
   *   opts.quotes    true → keep most_reacted[].text. Message text is opt-in (SCHEMA §5,
   *                  DECISIONS D12): by default every quote is replaced with "".
   *   opts.base      base URL. Default WrappedConfig.BASE_URL.
   *   opts.maxLength whole-URL budget. Default 4,800.
   *   opts.form      'fragment' (default) or 'query'.
   * Returns { url, payload, length, steps, stats } where `steps` lists the trim steps that
   * had to be applied and `stats` is exactly what the link carries.
   * Throws a WrappedCodecError with code 'too_long' when nothing fits.
   */
  function planLink(stats, opts) {
    opts = opts || {};
    var base = opts.base || Config.BASE_URL;
    var max = opts.maxLength || Config.MAX_URL_LENGTH;
    var form = opts.form === 'query' ? 'query' : 'fragment';

    var working = clone(stats);
    if (opts.quotes !== true && Array.isArray(working.most_reacted)) {
      working.most_reacted.forEach(function (m) { if (m && typeof m === 'object') m.text = ''; });
    }

    var applied = [];
    var payload = encode(working);
    var url = linkFor(base, payload, form);
    for (var i = 0; url.length > max && i < TRIM_STEPS.length; i++) {
      TRIM_STEPS[i].apply(working);
      applied.push(TRIM_STEPS[i].id);
      payload = encode(working);
      url = linkFor(base, payload, form);
    }
    if (url.length > max) {
      throw CodecError(
        'This recap does not fit in a link: ' + url.length + ' characters after trimming, and the limit is ' + max + '.',
        'too_long'
      );
    }
    return { url: url, payload: payload, length: url.length, steps: applied, stats: working };
  }

  function buildLink(stats, opts) { return planLink(stats, opts).url; }

  // ── reading a location ─────────────────────────────────────────────────────

  function parseParams(text) {
    var out = {};
    String(text || '').replace(/^[#?]/, '').split('&').forEach(function (pair) {
      if (!pair) return;
      var eq = pair.indexOf('=');
      var key = eq === -1 ? pair : pair.slice(0, eq);
      out[key] = eq === -1 ? '' : pair.slice(eq + 1);
    });
    return out;
  }

  /**
   * Read what a URL asks for. Accepts a Location, a URL or a string.
   * Returns { payload, source, demo, embed } where payload is null when absent and
   * source is 'fragment' | 'query' | null. The fragment wins over the query string.
   */
  function parseLocation(loc) {
    var hash = '';
    var search = '';
    if (typeof loc === 'string') {
      var h = loc.indexOf('#');
      if (h !== -1) { hash = loc.slice(h); loc = loc.slice(0, h); }
      var q = loc.indexOf('?');
      if (q !== -1) search = loc.slice(q);
    } else if (loc) {
      hash = loc.hash || '';
      search = loc.search || '';
    }
    var hp = parseParams(hash);
    var qp = parseParams(search);
    var key = Config.PAYLOAD_KEY;
    var payload = null;
    var source = null;
    if (hp[key]) { payload = cleanPayload(hp[key]); source = 'fragment'; }
    else if (qp[key]) { payload = cleanPayload(qp[key]); source = 'query'; }
    var demo = qp.demo || hp.demo;
    return {
      payload: payload || null,
      source: payload ? source : null,
      demo: demo === '1' || demo === 'true',
      embed: qp.embed || hp.embed || null
    };
  }

  var Codec = {
    encode: encode,
    decode: decode,
    buildLink: buildLink,
    planLink: planLink,
    parseLocation: parseLocation,
    cleanPayload: cleanPayload,
    TRIM_STEPS: TRIM_STEPS.map(function (s) { return s.id; }),
    MAX_URL_LENGTH: Config.MAX_URL_LENGTH
  };

  root.WrappedCodec = Codec;
  if (isNode) module.exports = Codec;
})(typeof window !== 'undefined' ? window : globalThis);
