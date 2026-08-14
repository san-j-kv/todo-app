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

  /* When a task's reminder should next fire — or null for "not at all".

     A recurrence gets no special treatment here, deliberately. This used to
     walk a stale series forward so a reminder was armed even for an occurrence
     the user never dealt with, which meant the card said Overdue for today
     while the alarm pointed at tomorrow: two different occurrences described
     at once, and the missed one quietly abandoned.

     A recurring task now advances only when it is completed — in
     toggleComplete(), or in TaskActionReceiver for "Mark done" on the banner.
     Until then it stays on the occurrence it is on, shows as overdue and arms
     nothing, so the series waits for the user rather than rolling on without
     them. A task created or edited with a time already behind it is rolled to
     its next occurrence by saveTask() at that moment, so this never sees one:
     no reminder ever existed for that slot, and it is not a missed one. */
  function nextFutureMs(task) {
    var ms = notifyMsFor(task.date, task.time);
    if (ms === null) return null;
    return ms > Date.now() ? ms : null;
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
     Dismissing a banner that has already fired
     ───────────────────────────────────────────────────────────── */

  /* sync() structurally cannot do this. The plugin erases a notification from
     its own record the instant it fires — TimedNotificationPublisher, and this
     app always schedules by `at` with no cron, so that branch always runs. A
     fired reminder is therefore never reported by getPending(), never lands in
     sync()'s `stale` list, and never reaches p.cancel() — which is the only
     call that takes a visible banner down. The banner then sits in the shade
     forever, even after its task is deleted.

     Deliberately not p.cancel(): that also cancels the AlarmManager entry and
     deletes the stored record. In the recurring case the live task keeps its
     notifId and is re-armed for the next occurrence in the same tick, so
     cancel() would race the reschedule and could kill the alarm just set.
     removeDeliveredNotifications() maps straight onto NotificationManager
     .cancel(id) — shade only, no alarm, no record — which makes the ordering
     against sync() irrelevant. It is what TaskActionReceiver.dismiss() already
     does natively for "Mark done"; this is the same policy for the UI paths.

     Known bound, found on a device: this only decides the fate of a banner that
     nothing re-arms. LocalNotificationManager.schedule() dismisses a visible
     notification before arming its id, so a recurring task — or one moved to a
     future date — loses its banner the next time sync() re-schedules it, with
     or without this call. Only a past one-off, never re-armed, is genuinely
     left alone until its own task is touched. */
  function dismiss(id) {
    var p = getPlugin();
    // No bridge at all in a plain browser, and an older plugin build may not
    // have the method. Either way this is a no-op that still returns a promise,
    // so a caller can chain and the jsdom suite never sees a TypeError.
    if (!p || typeof p.removeDeliveredNotifications !== 'function') return Promise.resolve();

    var n = Number(id);
    if (!isFinite(n)) return Promise.resolve();

    // No tag key: the plugin branches on tag == null to reach cancel(id).
    // No getDeliveredNotifications() pre-check either — cancelling an id with
    // no banner showing is a documented no-op, and enumerating the shade first
    // would cost a round trip and add a race.
    try {
      // Promise.resolve wraps a stub that hands back undefined.
      return Promise.resolve(p.removeDeliveredNotifications({ notifications: [{ id: n }] }))
        .catch(function (err) {
          // Same posture as sync(): a shade that failed to clear is not worth
          // breaking a save over.
          if (window.console && console.warn) console.warn('[notify] dismiss failed', err);
        });
    } catch (err) {
      if (window.console && console.warn) console.warn('[notify] dismiss failed', err);
      return Promise.resolve();
    }
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
          // foreground:false is what iOS reads. Android has no equivalent field
          // and the stock plugin opens the activity for every button, so
          // patches/@capacitor+local-notifications+8.2.1.patch reroutes action
          // buttons to a broadcast and TaskActionReceiver completes the task
          // natively. handleAction() below stays the iOS and browser path.
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
      // Only reached where the action still routes through the activity — iOS,
      // and Android if the plugin patch is ever lost. TaskActionReceiver has
      // already done the work otherwise, and completeById() ignores a task that
      // is already completed, so arriving here twice is harmless.
      //
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
            if (state && state.isActive) refresh();
          });
        }
        document.addEventListener('resume', refresh, false);

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

  /* Coming back to the foreground has two jobs. "Mark done" is handled by a
     background receiver that rewrites the document behind us, so re-read it;
     and anything that fired while we were away needs re-arming.

     The plugin's storeChanged event normally gets there first, but only while
     the process was alive — this is the path for a launch after a kill, and the
     belt to that event's braces. reloadFromStore() resyncs when it reloaded, so
     only the miss needs a sync of its own. */
  function refresh() {
    var a = api();
    if (!a) return;
    if (!a.reloadFromStore) { resync(); return; }
    a.reloadFromStore().then(function (reloaded) {
      if (!reloaded) resync();
    });
  }

  window.TodoNotify = {
    init: init,
    sync: sync,
    resync: resync,
    dismiss: dismiss,
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
