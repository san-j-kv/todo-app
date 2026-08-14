/* To Do — where the task document lives. No build step, no bundler.

   One JSON document, one write. On Android the canonical copy is a real file in
   the app's private storage, reached through the app-local TodoStore plugin; in
   a plain browser it falls back to localStorage, which keeps index.html working
   on the desktop exactly as it did before.

   This file is a byte pipe. It moves a string in and out of storage and knows
   nothing about what the string holds — the document schema, and the migration
   off the old todo.tasks.v1 keys, both live in app.js. */
(function () {
  'use strict';

  var FALLBACK_KEY = 'todo.store.v1';
  var plugin = null;

  /* Keyed on the plugin being there, not on Capacitor.isNativePlatform(). The
     ios/ platform in this project has no Swift implementation, so asking "is
     this native?" answers yes on iOS and then calls a method that doesn't
     exist. Asking "is the plugin here?" lands iOS on the localStorage backend
     by itself, and on the Blob export path with it. */
  function getPlugin() {
    if (plugin) return plugin;
    plugin = (window.Capacitor && Capacitor.Plugins && Capacitor.Plugins.TodoStore) || null;
    return plugin;
  }

  function isNative() { return !!getPlugin(); }

  /* Both backends reject when storage throws — private mode, a full disk, a
     revoked file. What they must never do is resolve null on a failure: app.js
     reads null as "nothing stored yet" and would migrate or start empty over
     the top of data that is still sitting there. */

  function read() {
    var p = getPlugin();
    if (p) {
      return p.read().then(function (res) {
        // No file yet arrives as {} rather than {value: null}: JSObject extends
        // org.json.JSONObject, whose put(name, null) removes the key instead of
        // storing a null. Anything that isn't a string means nothing stored.
        return res && typeof res.value === 'string' ? res.value : null;
      });
    }
    return new Promise(function (resolve) {
      var text = localStorage.getItem(FALLBACK_KEY);
      resolve(typeof text === 'string' ? text : null);
    });
  }

  function write(text) {
    var p = getPlugin();
    if (p) return p.write({ value: text });
    return new Promise(function (resolve) {
      localStorage.setItem(FALLBACK_KEY, text);
      resolve();
    });
  }

  /* Export and import are native-only: a browser has the Blob download and the
     file input, which app.js keeps using when isNative() is false. Rejecting
     here rather than returning a no-op keeps a mis-wired branch loud. */

  function exportDoc(name, text) {
    var p = getPlugin();
    if (!p) return Promise.reject(new Error('exportDoc needs the native store'));
    return p.exportDoc({ name: name, value: text });
  }

  function importDoc() {
    var p = getPlugin();
    if (!p) return Promise.reject(new Error('importDoc needs the native store'));
    return p.importDoc();
  }

  /* The document can change without the web layer touching it: "Mark done" on a
     reminder is handled by a broadcast receiver that writes the file directly.
     The plugin announces that; a browser has no such writer, so this no-ops. */
  function onChanged(cb) {
    var p = getPlugin();
    if (!p || !p.addListener) return;
    p.addListener('storeChanged', cb);
  }

  window.TodoStore = {
    isNative: isNative,
    read: read,
    write: write,
    exportDoc: exportDoc,
    importDoc: importDoc,
    onChanged: onChanged,
    FALLBACK_KEY: FALLBACK_KEY
  };
})();
