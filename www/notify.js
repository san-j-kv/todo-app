/* To Do — local notifications via Capacitor. No build step, no bundler.

   Loaded before app.js, which calls into window.TodoNotify. On a native
   platform the Capacitor bridge publishes every installed plugin on
   window.Capacitor.Plugins, so there is nothing to import. In a plain
   browser the bridge is absent and every entry point here no-ops, which
   keeps index.html working on the desktop exactly as it did before. */
(function () {
  'use strict';

  var INTRO_KEY = 'todo.notifyIntro.v1';
  var CHANNEL_ID = 'todo-reminders';
  var ACTION_TYPE = 'TODO_REMINDER';
  var DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  var TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

  // A task with no time reminds at 08:00 local — not the 23:59:59.999 that
  // msFor() in app.js uses for sorting. The two must not be conflated.
  var DEFAULT_HOUR = 8;

  // iOS silently drops pending local notifications past 64 per app. Staying
  // under it deliberately keeps the *soonest* reminders rather than an
  // arbitrary subset.
  var MAX_PENDING = 60;

  // Walking a recurrence forward is bounded, same as MAX_ROLL in app.js.
  var MAX_ROLL = 500;

  var plugin = null;
  var ready = false;      // init() finished and permission is granted
  var permission = null;  // 'granted' | 'denied' | 'prompt' | null
  var asking = false;     // an intro/permission round-trip is in flight
  var pendingSync = false;

  /* ─────────────────────────────────────────────────────────────
     Environment
     ───────────────────────────────────────────────────────────── */

  function native() {
    return !!(window.Capacitor &&
              typeof Capacitor.isNativePlatform === 'function' &&
              Capacitor.isNativePlatform());
  }

  function getPlugin() {
    if (plugin) return plugin;
    if (!native()) return null;
    plugin = (Capacitor.Plugins && Capacitor.Plugins.LocalNotifications) || null;
    return plugin;
  }

  function platform() {
    return (window.Capacitor && Capacitor.getPlatform) ? Capacitor.getPlatform() : 'web';
  }

  // app.js keeps toast/confirmDialog inside its IIFE and exposes them on
  // window.__todo, which only exists after app.js has run.
  function api() { return window.__todo || null; }

  function toast(message, opts) {
    var a = api();
    if (a && a.toast) a.toast(message, opts);
  }

  /* ─────────────────────────────────────────────────────────────
     When a reminder should fire
     ───────────────────────────────────────────────────────────── */

  // Same parts-based construction as parseLocal() in app.js — never
  // `new Date("2026-08-13")`, which parses as UTC and can land a day early.
  function parseLocal(iso) {
    if (!DATE_RE.test(iso || '')) return null;
    var p = iso.split('-').map(Number);
    var dt = new Date(p[0], p[1] - 1, p[2]);
    if (dt.getFullYear() !== p[0] || dt.getMonth() !== p[1] - 1 || dt.getDate() !== p[2]) return null;
    return dt;
  }

  // Sibling of msFor() in app.js, differing only in the no-time fallback.
  function notifyMsFor(iso, time) {
    var dt = parseLocal(iso);
    if (!dt) return null;
    if (TIME_RE.test(time || '')) {
      var p = time.split(':').map(Number);
      dt.setHours(p[0], p[1], 0, 0);
    } else {
      dt.setHours(DEFAULT_HOUR, 0, 0, 0);
    }
    return dt.getTime();
  }

  /* Read-only sibling of rollForward() in app.js: finds the first occurrence
     still in the future without mutating the task. This is what lets a
     recurring series recover after the app has been shut for weeks — the
     stored date is stale, but the reminder we arm is not. */
  function nextFutureMs(task) {
    var ms = notifyMsFor(task.date, task.time);
    if (ms === null) return null;

    var now = Date.now();
    if (ms > now) return ms;
    if (!task.recurrence) return null;

    var a = api();
    if (!a || !a.nextOccurrence) return null;

    var iso = task.date;
    for (var i = 0; i < MAX_ROLL; i++) {
      var next = a.nextOccurrence(iso, task.recurrence);
      if (!next) return null;
      iso = next;
      ms = notifyMsFor(iso, task.time);
      if (ms === null) return null;
      if (ms > now) return ms;
    }
    return null;
  }

  function eligible(task) {
    if (!task || task.completed) return false;
    if (!task.date) return false;
    return typeof task.notifId === 'number' && isFinite(task.notifId);
  }

  // The set of reminders that *should* be armed right now.
  function desiredFor(tasks) {
    var out = [];
    (tasks || []).forEach(function (task) {
      if (!eligible(task)) return;
      var ms = nextFutureMs(task);
      if (ms === null) return;
      out.push({ id: task.notifId, at: ms, taskId: task.id, name: task.name });
    });

    out.sort(function (a, b) { return a.at - b.at; });
    return out.slice(0, MAX_PENDING);
  }

  function body(item) {
    var a = api();
    var dt = new Date(item.at);
    if (a && a.formatTime) {
      var hh = String(dt.getHours()).padStart(2, '0');
      var mm = String(dt.getMinutes()).padStart(2, '0');
      return 'Due at ' + a.formatTime(hh + ':' + mm);
    }
    return 'This task is due now.';
  }

  /* ─────────────────────────────────────────────────────────────
     Permission

     Asked on the first attempt to arm a reminder, never at boot — a cold
     prompt with no context is what gets permanently denied.
     ───────────────────────────────────────────────────────────── */

  function introShown() {
    try { return localStorage.getItem(INTRO_KEY) === '1'; } catch (err) { return false; }
  }

  function markIntroShown() {
    try { localStorage.setItem(INTRO_KEY, '1'); } catch (err) { /* private mode — ask again next launch */ }
  }

  function explain() {
    var a = api();
    if (!a || !a.confirmDialog) return Promise.resolve(true); // no UI yet — just ask the OS
    return a.confirmDialog({
      title: 'Remind you about tasks?',
      text: 'To Do can send a reminder at the exact time a task is due, even when the app is closed. ' +
            'Reminders are scheduled on this device — nothing is ever sent to a server.',
      buttons: [
        { label: 'Not now', value: false },
        { label: 'Turn on reminders', value: true, variant: 'btn-primary' }
      ]
    }).then(function (choice) { return choice === true; });
  }

  /* Resolves to true when we may schedule. Only ever prompts once per
     launch; a denial is remembered so we stop pestering. */
  function ensurePermission() {
    var p = getPlugin();
    if (!p) return Promise.resolve(false);
    if (permission === 'granted') return Promise.resolve(true);
    if (permission === 'denied') return Promise.resolve(false);
    if (asking) return Promise.resolve(false);

    asking = true;
    return p.checkPermissions().then(function (res) {
      permission = res && res.display;
      if (permission === 'granted') return true;
      if (permission === 'denied') return false;

      var intro = introShown() ? Promise.resolve(true) : explain();
      return intro.then(function (ok) {
        markIntroShown();
        if (!ok) return false;
        return p.requestPermissions().then(function (r) {
          permission = r && r.display;
          if (permission !== 'granted') {
            toast('Reminders are off. You can turn them on in system settings.', { type: 'error' });
            return false;
          }
          return true;
        });
      });
    }).catch(function () {
      return false;
    }).then(function (ok) {
      asking = false;
      // A grant mid-flight means the sync that triggered this never armed
      // anything; run it again now that we are allowed to. Forced, because
      // this only happens on a cold start or a first-ever grant.
      if (ok && pendingSync) { pendingSync = false; resync(true); }
      return ok;
    });
  }

  /* ─────────────────────────────────────────────────────────────
     Scheduling
     ───────────────────────────────────────────────────────────── */

  function scheduleItems(p, items) {
    if (!items.length) return Promise.resolve();
    return p.schedule({
      notifications: items.map(function (item) {
        return {
          id: item.id,
          title: item.name,
          body: body(item),
          channelId: CHANNEL_ID,
          actionTypeId: ACTION_TYPE,
          extra: { taskId: item.taskId },
          smallIcon: 'ic_stat_notify',
          schedule: {
            at: new Date(item.at),
            allowWhileIdle: true // Doze must not batch an exact reminder
          }
        };
      })
    });
  }

  /* Diffs desired against pending so an unrelated save doesn't cancel and
     re-arm every reminder in the app.

     `force` skips that diff and re-arms everything from scratch. It must be
     used on cold start, because getPending() is NOT evidence that the OS alarm
     still exists: the plugin answers from its own SharedPreferences record,
     which outlives the AlarmManager entry. A force-stop — and on OEM builds
     like Motorola or Xiaomi, an ordinary background kill — cancels the alarms
     while leaving that record intact. Trusting the diff there means the
     reminder is reported pending forever and never fires again. */
  function sync(tasks, force) {
    var p = getPlugin();
    if (!p) return Promise.resolve();
    // save() can fire before init() finishes (it does on boot, when
    // normalizeTask hands out fresh notifIds). Scheduling before the Android
    // channel exists would drop the notification, so wait it out — init()
    // runs its own sync when it lands.
    if (!ready) return Promise.resolve();

    if (permission !== 'granted') {
      pendingSync = true;
      return ensurePermission().then(function (ok) {
        if (!ok) return;
        pendingSync = false;
        // `force` has to survive this hop — permission is always unresolved on
        // a cold start, so dropping it here would defeat the re-arm entirely.
        return sync(tasks, force);
      });
    }

    var desired = desiredFor(tasks);

    return p.getPending().then(function (res) {
      var pending = (res && res.notifications) || [];

      var want = {};
      desired.forEach(function (item) { want[item.id] = item; });

      var have = {};
      if (!force) {
        pending.forEach(function (n) {
          var id = Number(n.id);
          // getPending() reports schedule.at as an ISO string on some platforms.
          var at = n.schedule && n.schedule.at ? new Date(n.schedule.at).getTime() : NaN;
          have[id] = at;
        });
      }

      var stale = [];
      pending.forEach(function (n) {
        var id = Number(n.id);
        var item = want[id];
        // Cancel what is no longer wanted, or wanted at a different time.
        // Under `force` every entry is cancelled, so the reschedule below
        // rebuilds the OS alarms rather than trusting the plugin's record.
        if (!item || have[id] !== item.at) stale.push({ id: id });
      });

      var fresh = desired.filter(function (item) {
        return have[item.id] !== item.at;
      });

      var step = stale.length ? p.cancel({ notifications: stale }) : Promise.resolve();
      return step.then(function () { return scheduleItems(p, fresh); });
    }).catch(function (err) {
      if (window.console && console.warn) console.warn('[notify] sync failed', err);
    });
  }

  /* ─────────────────────────────────────────────────────────────
     Init
     ───────────────────────────────────────────────────────────── */

  function createChannel(p) {
    if (platform() !== 'android' || !p.createChannel) return Promise.resolve();
    return p.createChannel({
      id: CHANNEL_ID,
      name: 'Task reminders',
      description: 'Reminders for tasks with a due date',
      importance: 5,   // HIGH — heads-up banner
      visibility: 1,   // public on the lock screen
      vibration: true
    }).catch(function () { /* channel already exists */ });
  }

  function registerActions(p) {
    if (!p.registerActionTypes) return Promise.resolve();
    return p.registerActionTypes({
      types: [{
        id: ACTION_TYPE,
        actions: [
          // foreground:false lets iOS handle this without opening the app.
          // Android launches the activity regardless — Capacitor has no
          // headless JS, so expect the app to surface briefly there.
          { id: 'done', title: 'Mark done', foreground: false }
        ]
      }]
    }).catch(function () { /* older plugin build */ });
  }

  function handleAction(event) {
    var a = api();
    var extra = event && event.notification && event.notification.extra;
    var taskId = extra && extra.taskId;
    if (!a || !taskId) return;

    if (event.actionId === 'done') {
      // Delegates to app.js's toggleComplete(), which already archives the
      // occurrence, rolls a recurring task forward and re-saves — and the
      // save triggers the sync that arms the next reminder.
      if (a.completeById) a.completeById(taskId);
      return;
    }

    // Body tap: open the task so it can be edited.
    if (a.openTaskModal && a.getTasks) {
      var list = a.getTasks();
      for (var i = 0; i < list.length; i++) {
        if (list[i].id === taskId) { a.openTaskModal(list[i]); return; }
      }
    }
  }

  function init() {
    var p = getPlugin();
    if (!p) return Promise.resolve(false);

    return createChannel(p)
      .then(function () { return registerActions(p); })
      .then(function () {
        p.addListener('localNotificationActionPerformed', handleAction);

        // A reminder that fired while the app was closed leaves the series
        // un-armed until something re-syncs. Resume is that something.
        if (window.Capacitor.Plugins.App && window.Capacitor.Plugins.App.addListener) {
          window.Capacitor.Plugins.App.addListener('appStateChange', function (state) {
            if (state && state.isActive) resync();
          });
        }
        document.addEventListener('resume', resync, false);

        ready = true;
        return true;
      })
      .catch(function (err) {
        if (window.console && console.warn) console.warn('[notify] init failed', err);
        return false;
      });
  }

  function resync(force) {
    var a = api();
    if (a && a.getTasks) sync(a.getTasks(), force === true);
  }

  window.TodoNotify = {
    init: init,
    sync: sync,
    resync: resync,
    // Exposed for console poking and the checks in the plan.
    notifyMsFor: notifyMsFor,
    nextFutureMs: nextFutureMs,
    desiredFor: desiredFor,
    isNative: native,
    getPending: function () {
      var p = getPlugin();
      return p ? p.getPending() : Promise.resolve({ notifications: [] });
    },
    state: function () {
      return { native: native(), ready: ready, permission: permission, platform: platform() };
    }
  };
})();
