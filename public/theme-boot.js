/**
 * Resolve the theme before first paint.
 *
 * A real same-origin file rather than an inline <script>, because the BFF serves
 * `script-src 'self'` with no nonce and no hashes (server/config.ts). An inline block
 * would be refused outright and every load would flash the wrong theme. This is the
 * same reason /config.js exists as a file.
 *
 * Reads a bare string, not JSON: whatever writes this key has to stay readable from a
 * render-blocking script with no parsing and no dependency on a state library's
 * storage envelope.
 *
 * Keep this small and synchronous. It runs before the stylesheet.
 */
(function () {
  var root = document.documentElement;
  try {
    var stored = localStorage.getItem('chemclaw3.theme');
    var choice = stored === 'light' || stored === 'dark' ? stored : 'system';
    root.dataset.theme =
      choice === 'system'
        ? window.matchMedia('(prefers-color-scheme: dark)').matches
          ? 'dark'
          : 'light'
        : choice;
  } catch {
    // Private mode, disabled storage, a hostile embedder — any of these is survivable.
    // A wrong-but-readable theme beats an unstyled page.
    root.dataset.theme = 'light';
  }
})();
