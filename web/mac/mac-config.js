/*
 * The Mac app's download page (web/mac/): the one place its download address lives.
 *
 * MAC_DOWNLOAD_URL stays empty until there is a public download. While it is empty the
 * page shows "The download is not public yet" and a link to the project instead of the
 * Download button. To publish, put the address of the zip (or .dmg) here, for example a
 * GitHub release asset, and nothing else needs to change. tests/js/mac-site.test.js checks
 * the shape of the value; tests/e2e/mac-guide.mjs renders both states.
 */
(function (root) {
  'use strict';

  var MacConfig = {
    /** Absolute https:// address, or a path relative to web/mac/. Empty: not public yet. */
    MAC_DOWNLOAD_URL: '',

    /** Where the project and its source code live. */
    SOURCE_URL: 'https://github.com/averyhsu/imessage-wrap',

    /** The oldest macOS the app runs on (mac/project.yml, deploymentTarget). */
    MIN_MACOS: 14
  };

  root.WrappedMacConfig = MacConfig;
  if (typeof module === 'object' && module.exports) module.exports = MacConfig;
})(typeof window !== 'undefined' ? window : globalThis);
