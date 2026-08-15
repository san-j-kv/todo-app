/* To Do — the web side of voice quick-add.

   A thin pipe to the app-local TodoVoice plugin, in the same shape as store.js:
   keyed on the plugin being present rather than on Capacitor.isNativePlatform(),
   so a desktop browser and the jsdom suite land on a no-op instead of calling a
   method that isn't there. Voice is Android-only — there is no Swift half — and
   this is what keeps that from being a crash anywhere else.

   It knows nothing about tasks or dates. The transcript goes to nlu.js, and what
   comes back goes into the task sheet; both of those live in app.js. */
(function () {
  'use strict';

  var plugin = null;
  var listeners = null;   // non-null only while a dictation is open
  var handles = [];

  function getPlugin() {
    if (plugin) return plugin;
    plugin = (window.Capacitor && Capacitor.Plugins && Capacitor.Plugins.TodoVoice) || null;
    return plugin;
  }

  function isNative() { return !!getPlugin(); }

  /* Availability is asked of the plugin rather than assumed from its presence:
     the model is unpacked from the APK on first use, so "the plugin is here"
     and "voice can run right now" are different questions and the UI needs
     both. Resolves rather than rejects on a missing plugin — a browser has no
     voice and that is not an error worth handling at every call site. */
  function isAvailable() {
    var p = getPlugin();
    if (!p) return Promise.resolve({ available: false, ready: false, granted: false });
    return p.isAvailable().catch(function () {
      return { available: false, ready: false, granted: false };
    });
  }

  /* One dictation. `handlers` takes onPartial, onResult, onError and onState;
     all are optional. The promise settles when the mic is open, not when the
     sentence is finished — the transcript arrives through onResult, because a
     dictation produces a stream of guesses before it produces an answer.

     Rejects if the permission is refused or the model cannot be prepared, so
     the caller has one place to put the failure message. */
  function start(handlers) {
    var p = getPlugin();
    if (!p) return Promise.reject(new Error('Voice input needs the Android app'));

    stop();                       // never two mics open at once
    listeners = handlers || {};

    /* addListener resolves to a handle, and removing them is what stops a
       finished dictation from feeding the next one. Held here rather than in
       the caller so a rejected start() still cleans up after itself. */
    handles = [
      p.addListener('partial', function (e) { emit('onPartial', e && e.text); }),
      p.addListener('result', function (e) { emit('onResult', e && e.text); }),
      p.addListener('final', function (e) { emit('onFinal', e && e.text); }),
      p.addListener('state', function (e) { emit('onState', e && e.state); }),
      p.addListener('error', function (e) { emit('onError', (e && e.message) || 'Speech recognition failed'); })
    ];

    return p.start().catch(function (err) {
      stop();
      throw err;
    });
  }

  function emit(name, value) {
    if (!listeners) return;       // an event arriving after stop() is stale
    var fn = listeners[name];
    if (typeof fn === 'function') fn(value);
  }

  /* Safe to call when nothing is running, and called that way — every exit
     from the listening UI routes through here rather than tracking whether it
     needs to. */
  function stop() {
    var p = getPlugin();
    listeners = null;

    handles.forEach(function (h) {
      // addListener returns a promise on some Capacitor versions and a handle
      // on others; both shapes end up with a remove().
      Promise.resolve(h).then(function (handle) {
        if (handle && typeof handle.remove === 'function') handle.remove();
      }).catch(function () {});
    });
    handles = [];

    if (p) p.stop().catch(function () {});
  }

  window.TodoVoice = {
    isNative: isNative,
    isAvailable: isAvailable,
    start: start,
    stop: stop
  };
})();
