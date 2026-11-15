/*
 * The Mac app's download page (web/mac/): the one place its download address lives.
 *
 * MAC_DOWNLOAD_URL is the public download: the disk image attached to the newest release
 * on GitHub (the Mac app workflow publishes one from every change to the app that reaches
 * main). If it is ever emptied, the page shows "The download is not public yet" and a link
 * to the project instead of the Download button. tests/js/mac-site.test.js checks
 * the shape of the value; tests/e2e/mac-guide.mjs renders both states.
 */
(function (root) {
  'use strict';

  var MacConfig = {
    /** Absolute https:// address, or a path relative to web/mac/. Empty: not public yet. */
    MAC_DOWNLOAD_URL: 'https://github.com/averyhsu/imessage-wrap/releases/latest/download/Threadback-for-Mac.dmg',

    /** Where the project and its source code live. */
    SOURCE_URL: 'https://github.com/averyhsu/imessage-wrap',

    /** The oldest macOS the app runs on (mac/project.yml, deploymentTarget). */
    MIN_MACOS: 14
  };

  root.WrappedMacConfig = MacConfig;
  if (typeof module === 'object' && module.exports) module.exports = MacConfig;
})(typeof window !== 'undefined' ? window : globalThis);
