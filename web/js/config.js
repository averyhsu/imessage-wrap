/*
 * Site-wide constants. This is the ONE place the product name and the public base
 * URL live in JavaScript. (index.html repeats both in its static <head> block because
 * link-preview crawlers run no JavaScript; tests/js/site.test.js keeps the two in sync.)
 */
(function (root) {
  'use strict';

  var Config = {
    /** Public product name. See docs/SCHEMA.md §7. */
    PRODUCT_NAME: 'Threadback',
    DESCRIPTOR: "your group chat's year in review",

    /** Where web/ is deployed. Always ends with a slash. */
    BASE_URL: 'https://averyhsu.github.io/imessage-wrap/',

    /** Link payload key: #w1=<payload> or ?w1=<payload>. docs/SCHEMA.md §5. */
    PAYLOAD_KEY: 'w1',

    /** Whole-URL budget for recap links (MSMessage.url rejects anything over 5,000). */
    MAX_URL_LENGTH: 4800,

    /** Relative path of the in-browser analyzer. */
    MAKE_PATH: 'make/',

    /** Relative path of the page that walks someone through installing the Mac app. */
    MAC_PATH: 'mac/'
  };

  root.WrappedConfig = Config;
  if (typeof module === 'object' && module.exports) module.exports = Config;
})(typeof window !== 'undefined' ? window : globalThis);
