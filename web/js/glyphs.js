/*
 * Original vector glyphs for the story: tapbacks, a crown, a moon and the UI icons.
 * Drawn for this project. Every string here is a constant, so setting it with innerHTML
 * is safe; recap data never passes through this file. No style attributes (CSP).
 */
(function (root) {
  'use strict';

  function svg(viewBox, body) {
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="' + viewBox + '" aria-hidden="true" focusable="false">' + body + '</svg>';
  }

  var THUMB =
    '<path fill="currentColor" d="M2.2 10.6h3.2c.6 0 1.1.5 1.1 1.1v7.6c0 .6-.5 1.1-1.1 1.1H2.2z"/>' +
    '<path fill="currentColor" d="M8.2 19.9v-9l3.3-7.2c.4-.9 1.4-1.3 2.3-.9 1.3.6 2 2 1.6 3.4l-.8 3h4.7c1.7 0 2.9 1.6 2.4 3.2l-1.8 5.9c-.3 1.1-1.3 1.8-2.4 1.8H8.2z"/>';

  var ICONS = {
    // ── tapbacks ──
    love: svg('0 0 24 24', '<path fill="currentColor" d="M12 21.2c-.4 0-.8-.1-1.100-.4C6.300 17.200 2 13.700 2 9.200 2 6.200 4.300 3.800 7.200 3.800c1.900 0 3.600 1 4.800 2.700 1.200-1.700 2.900-2.700 4.800-2.700C19.700 3.800 22 6.200 22 9.200c0 4.500-4.300 8-8.900 11.600-.3.300-.7.400-1.100.400z"/>'),
    like: svg('0 0 24 24', THUMB),
    dislike: svg('0 0 24 24', '<g transform="rotate(180 12 12)">' + THUMB + '</g>'),
    laugh: svg('0 0 24 24',
      '<g fill="currentColor" font-family="Archivo, Arial Black, Helvetica, Arial, sans-serif" font-weight="900" font-size="11.5" font-stretch="75%">' +
      '<text x="1.5" y="11" transform="rotate(-7 8 7)">HA</text><text x="9.5" y="21.6" transform="rotate(-7 16 18)">HA</text></g>'),
    emphasize: svg('0 0 24 24',
      '<g fill="currentColor" transform="rotate(8 12 12)">' +
      '<path d="M6.300 3.200h3.800l-.7 11H7z"/><circle cx="8.200" cy="18.600" r="2.100"/>' +
      '<path d="M13.900 3.200h3.800l-.7 11h-2.400z"/><circle cx="15.800" cy="18.600" r="2.100"/></g>'),
    question: svg('0 0 24 24',
      '<path fill="currentColor" d="M12.200 2.600c3.400 0 5.900 2.100 5.900 5.100 0 2.200-1.200 3.500-2.700 4.500-1.200.8-1.600 1.300-1.600 2.400v.4h-3.700v-.800c0-2 .8-3.100 2.300-4.100 1.100-.7 1.700-1.300 1.700-2.200 0-1-.8-1.700-2-1.700-1.300 0-2.200.8-2.300 2.100H6c.1-3.300 2.600-5.700 6.200-5.700z"/><circle cx="12" cy="19.200" r="2.300" fill="currentColor"/>'),
    emoji: svg('0 0 24 24',
      '<circle cx="12" cy="12" r="10" fill="currentColor"/>' +
      '<circle cx="8.500" cy="9.800" r="1.500" fill="#fff"/><circle cx="15.500" cy="9.800" r="1.500" fill="#fff"/>' +
      '<path d="M7.200 13.800c1 2.300 2.700 3.500 4.800 3.500s3.800-1.200 4.800-3.500" fill="none" stroke="#fff" stroke-width="1.800" stroke-linecap="round"/>'),

    // ── story furniture ──
    crown: svg('0 0 32 24',
      '<path fill="currentColor" d="M3.600 20.500 1.300 6.900c-.1-.8.800-1.300 1.400-.8l6.200 4.900 6.200-9c.4-.6 1.300-.6 1.700 0l6.200 9 6.200-4.900c.6-.5 1.500 0 1.400.8l-2.300 13.600c-.1.600-.6 1-1.200 1H4.800c-.6 0-1.100-.4-1.200-1z"/>'),
    moon: svg('0 0 24 24', '<path fill="currentColor" d="M20.700 14.900c-1.100.4-2.300.6-3.500.6-5.400 0-9.700-4.300-9.700-9.700 0-1.200.2-2.400.6-3.500C4.500 3.700 2 7.200 2 11.300 2 17.200 6.800 22 12.700 22c4.100 0 7.600-2.500 9-6.100.2-.6-.4-1.200-1-1z"/>'),
    star: svg('0 0 24 24', '<path fill="currentColor" d="M12 1.500c.6 5.800 4.700 9.900 10.500 10.500C16.700 12.600 12.600 16.700 12 22.500 11.400 16.700 7.300 12.600 1.500 12 7.300 11.400 11.400 7.300 12 1.500z"/>'),
    bubble: svg('0 0 24 24', '<path fill="currentColor" d="M12 3c5.500 0 10 3.700 10 8.300s-4.500 8.300-10 8.300c-1 0-2-.1-2.900-.4-1.300 1-3 1.700-4.900 1.800-.4 0-.6-.4-.4-.7.700-1 1.200-2.100 1.400-3.200C3.200 15.600 2 13.600 2 11.300 2 6.700 6.500 3 12 3z"/>'),

    // ── UI ──
    close: svg('0 0 24 24', '<path d="M6 6l12 12M18 6 6 18" fill="none" stroke="currentColor" stroke-width="2.600" stroke-linecap="round"/>'),
    pause: svg('0 0 24 24', '<rect x="6" y="5" width="4.200" height="14" rx="1.300" fill="currentColor"/><rect x="13.800" y="5" width="4.200" height="14" rx="1.300" fill="currentColor"/>'),
    play: svg('0 0 24 24', '<path fill="currentColor" d="M8 5.300c0-.9 1-1.500 1.800-1l10.400 6.700c.7.5.7 1.500 0 2L9.800 19.700c-.8.500-1.800-.1-1.800-1z"/>'),
    share: svg('0 0 24 24', '<path d="M12 15.500V3.800M7.500 8 12 3.500 16.500 8M6 11.500H5a1.500 1.500 0 0 0-1.500 1.500v6A1.500 1.500 0 0 0 5 20.500h14a1.500 1.500 0 0 0 1.500-1.500v-6a1.500 1.500 0 0 0-1.500-1.500h-1" fill="none" stroke="currentColor" stroke-width="2.200" stroke-linecap="round" stroke-linejoin="round"/>'),
    link: svg('0 0 24 24', '<path d="M10 14a4.500 4.500 0 0 0 6.400 0l3-3a4.500 4.500 0 0 0-6.400-6.400l-1 1M14 10a4.500 4.500 0 0 0-6.400 0l-3 3a4.500 4.500 0 0 0 6.400 6.400l1-1" fill="none" stroke="currentColor" stroke-width="2.200" stroke-linecap="round"/>'),
    replay: svg('0 0 24 24', '<path d="M4.500 12a7.500 7.500 0 1 0 2.300-5.400M4.500 4v4.500H9" fill="none" stroke="currentColor" stroke-width="2.200" stroke-linecap="round" stroke-linejoin="round"/>'),
    send: svg('0 0 24 24', '<path d="M12 19V5.500M6 11l6-6 6 6" fill="none" stroke="currentColor" stroke-width="2.800" stroke-linecap="round" stroke-linejoin="round"/>'),
    next: svg('0 0 24 24', '<path d="m9 5 7 7-7 7" fill="none" stroke="currentColor" stroke-width="2.600" stroke-linecap="round" stroke-linejoin="round"/>'),
    prev: svg('0 0 24 24', '<path d="m15 5-7 7 7 7" fill="none" stroke="currentColor" stroke-width="2.600" stroke-linecap="round" stroke-linejoin="round"/>'),
    check: svg('0 0 24 24', '<path d="m5 12.500 4.500 4.500L19 7.500" fill="none" stroke="currentColor" stroke-width="2.800" stroke-linecap="round" stroke-linejoin="round"/>')
  };

  /** Tapback kinds in display order, with the names used in copy. */
  var TAPBACKS = [
    { kind: 'love', label: 'Hearts' },
    { kind: 'like', label: 'Thumbs up' },
    { kind: 'dislike', label: 'Thumbs down' },
    { kind: 'laugh', label: 'Ha ha' },
    { kind: 'emphasize', label: '!!' },
    { kind: 'question', label: '?' },
    { kind: 'emoji', label: 'Emoji' }
  ];

  /** A <span class="glyph glyph--name"> holding the SVG. Requires a DOM. */
  function icon(name, extraClass) {
    var span = document.createElement('span');
    span.className = 'glyph glyph--' + name + (extraClass ? ' ' + extraClass : '');
    span.setAttribute('aria-hidden', 'true');
    span.innerHTML = ICONS[name] || '';
    return span;
  }

  /** A round tapback badge: <span class="tb tb--love"><span class="glyph">…</span></span>. */
  function tapback(kind, extraClass) {
    if (!ICONS[kind]) kind = 'emoji';
    var badge = document.createElement('span');
    badge.className = 'tb tb--' + kind + (extraClass ? ' ' + extraClass : '');
    badge.setAttribute('aria-hidden', 'true');
    badge.appendChild(icon(kind));
    return badge;
  }

  var Glyphs = { ICONS: ICONS, TAPBACKS: TAPBACKS, icon: icon, tapback: tapback };

  root.WrappedGlyphs = Glyphs;
  if (typeof module === 'object' && module.exports) module.exports = Glyphs;
})(typeof window !== 'undefined' ? window : globalThis);
