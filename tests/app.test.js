/* Integration tests: the real index.html, notify.js and app.js loaded into
   jsdom against a faked Capacitor bridge.

   The fake records what was scheduled and cancelled, so these assert on the
   plugin calls the app actually makes — create, edit, complete, delete,
   recurrence roll-forward, permission flow — rather than on internals. */

const { JSDOM } = require('jsdom');
const fs = require('fs');
const path = require('path');
const { ROOT, toISO, addDays, fireTime } = require('./harness');

/* Stands in for @capacitor/local-notifications. `scheduled` is the OS alarm
   table; note that getPending() answers from it, which is exactly the
   assumption the cold-start suite below deliberately violates. */
function makeBridge(permission) {
  const scheduled = new Map();
  /* What is actually sitting in the notification shade. Kept separate from
     `scheduled` because the plugin erases its own record of a notification the
     instant it fires (TimedNotificationPublisher) while the banner lives on —
     the exact gap that let a deleted task's banner survive forever. */
  const delivered = new Map();
  const listeners = {};
  const calls = {
    schedule: 0, cancel: 0, requestPermissions: 0, createChannel: 0, write: 0,
    removeDelivered: 0, removeAllDelivered: 0, voiceStart: 0, voiceStop: 0
  };

  const LocalNotifications = {
    checkPermissions: () => Promise.resolve({ display: permission }),
    requestPermissions: () => {
      calls.requestPermissions++;
      permission = 'granted';
      return Promise.resolve({ display: permission });
    },
    createChannel: () => { calls.createChannel++; return Promise.resolve(); },
    registerActionTypes: () => Promise.resolve(),
    addListener: (name, cb) => { listeners[name] = cb; return Promise.resolve({ remove() {} }); },
    getPending: () => Promise.resolve({
      notifications: [...scheduled.values()].map((n) => ({
        id: n.id,
        title: n.title,
        // Mirrors the platforms that hand back an ISO string, not a Date.
        schedule: { at: new Date(n.schedule.at).toISOString() }
      }))
    }),
    schedule: (opts) => {
      calls.schedule++;
      opts.notifications.forEach((n) => {
        /* LocalNotificationManager.schedule() calls dismissVisibleNotification(id)
           before arming — so re-scheduling an id silently clears any banner it
           already has. Modelled because it bounds what the targeted dismissal
           can promise: a reminder that sync re-arms (any recurring task, or one
           moved to a future date) loses its banner on the next sync no matter
           what this app does. Only a banner that is never re-armed — a past
           one-off — survives untouched, which is the case the sections below
           lean on. */
        delivered.delete(Number(n.id));
        scheduled.set(Number(n.id), n);
      });
      return Promise.resolve();
    },
    cancel: (opts) => {
      calls.cancel++;
      opts.notifications.forEach((n) => {
        scheduled.delete(Number(n.id));
        // The real cancel() calls dismissVisibleNotification() as well. Modelled
        // so a test can never mistake a cancel for the targeted dismissal.
        delivered.delete(Number(n.id));
      });
      return Promise.resolve();
    },
    getDeliveredNotifications: () => Promise.resolve({
      notifications: [...delivered.values()].map((n) => ({ id: n.id, title: n.title, tag: null }))
    }),
    removeDeliveredNotifications: (opts) => {
      calls.removeDelivered++;
      ((opts && opts.notifications) || []).forEach((n) => delivered.delete(Number(n.id)));
      return Promise.resolve();
    },
    // The app must never reach for this — a test below pins it at 0, which is
    // the guard against anyone "simplifying" the fix into a global sweep.
    removeAllDeliveredNotifications: () => {
      calls.removeAllDelivered++;
      delivered.clear();
      return Promise.resolve();
    }
  };

  /* Stands in for the app-local TodoStore plugin: the task document as it sits
     in getFilesDir()/tasks.json, plus the two system pickers. */
  const store = { doc: null, failRead: false, failWrite: false };
  const exported = [];
  let inbox = { cancelled: true };
  let exportSaved = true;

  // The receiver-driven paths: TodoStore announces a document written outside
  // the WebView, App announces a return to the foreground. Captured rather than
  // fired, so a suite that never touches them behaves exactly as before.
  const storeListeners = {};
  const appListeners = {};

  const TodoStore = {
    addListener: (name, cb) => { storeListeners[name] = cb; return Promise.resolve({ remove() {} }); },
    read: () => {
      if (store.failRead) return Promise.reject(new Error('read failed'));
      // {} rather than {value: null} when there is no file — JSObject drops a
      // null put, so this is what the web layer actually receives.
      return Promise.resolve(store.doc === null ? {} : { value: store.doc });
    },
    write: (opts) => {
      if (store.failWrite) return Promise.reject(new Error('write failed'));
      calls.write++;
      store.doc = opts.value;
      return Promise.resolve();
    },
    exportDoc: (opts) => {
      exported.push(opts);
      return Promise.resolve({ saved: exportSaved });
    },
    importDoc: () => Promise.resolve(inbox)
  };

  /* Stands in for the app-local TodoVoice plugin — Vosk, in the real thing.
     Nothing here decodes anything; __say() below plays back a dictation the
     way the native side reports one, so the tests exercise the web layer's
     whole path from a transcript to a saved task. */
  const voiceListeners = {};
  const voice = { available: true, granted: true };

  const TodoVoice = {
    addListener: (name, cb) => {
      voiceListeners[name] = cb;
      return Promise.resolve({ remove() { delete voiceListeners[name]; } });
    },
    isAvailable: () => Promise.resolve({
      available: voice.available, ready: true, granted: voice.granted
    }),
    start: () => {
      calls.voiceStart++;
      return voice.granted
        ? Promise.resolve()
        : Promise.reject(new Error('Microphone permission is required for voice input'));
    },
    stop: () => { calls.voiceStop++; return Promise.resolve(); }
  };

  return {
    isNativePlatform: () => true,
    getPlatform: () => 'android',
    Plugins: {
      LocalNotifications,
      TodoStore,
      TodoVoice,
      App: {
        addListener: (name, cb) => { appListeners[name] = cb; return Promise.resolve({ remove() {} }); }
      }
    },

    /* One dictation: a partial guess, then the sentence Vosk settled on. Both
       are emitted because the panel shows the partial, and a test that skipped
       it would not notice the live transcript breaking. */
    __say(text) {
      if (voiceListeners.partial) voiceListeners.partial({ text: String(text).slice(0, 6) });
      if (voiceListeners.result) voiceListeners.result({ text: text });
    },
    __voiceEvent(name, payload) {
      if (voiceListeners[name]) voiceListeners[name](payload);
    },
    set __voiceAvailable(value) { voice.available = value; },
    set __voiceGranted(value) { voice.granted = value; },
    __scheduled: scheduled,
    __delivered: delivered,
    /* Simulates the alarm going off, exactly as TimedNotificationPublisher does
       it: the banner is posted and the plugin's own record is erased in the same
       breath. That is why getPending() stops reporting it, why sync()'s diff can
       never cancel it, and why the banner used to survive forever. */
    __fire(id) {
      const n = scheduled.get(Number(id));
      if (!n) return false;
      scheduled.delete(Number(id));
      delivered.set(Number(id), { id: Number(id), title: n.title });
      return true;
    },
    __listeners: listeners,
    __storeListeners: storeListeners,
    __appListeners: appListeners,
    __calls: calls,
    // `doc` lives in a closure, so these are accessors rather than a plain ref.
    get __doc() { return store.doc; },
    set __doc(value) { store.doc = value; },
    __export: exported,
    set __import(value) { inbox = value; },
    set __exportSaved(value) { exportSaved = value; },
    set __failRead(value) { store.failRead = value; },
    set __failWrite(value) { store.failWrite = value; }
  };
}

const tick = () => new Promise((r) => setTimeout(r, 0));
const settle = async () => { for (let i = 0; i < 40; i++) await tick(); };

/* Boots the real app. `prime` gets the bridge before the scripts run, so a
   suite can seed a pre-existing pending record or a stored document;
   `primeWindow` gets the window, for seeding storage directly. */
async function boot(permission, seedTasks, prime, primeWindow) {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true, url: 'http://localhost/' });
  const w = dom.window;
  const bridge = makeBridge(permission);
  if (prime) prime(bridge);

  w.Capacitor = bridge;
  // Seeded through the legacy key, so every suite below also exercises the
  // one-time migration into the document. The "document already exists" path
  // is covered separately, via prime(bridge) setting __doc.
  if (seedTasks) w.localStorage.setItem('todo.tasks.v1', JSON.stringify(seedTasks));
  if (primeWindow) primeWindow(w);

  // index.html's <script> tags never run under runScripts:'outside-only', so
  // this list is the real load order — store.js first, as in the markup.
  w.eval(fs.readFileSync(path.join(ROOT, 'store.js'), 'utf8'));
  w.eval(fs.readFileSync(path.join(ROOT, 'notify.js'), 'utf8'));
  w.eval(fs.readFileSync(path.join(ROOT, 'nlu.js'), 'utf8'));
  w.eval(fs.readFileSync(path.join(ROOT, 'voice.js'), 'utf8'));
  w.eval(fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8'));
  await settle();
  return { w, bridge };
}

// Reads the stored document back out of the fake.
const docOf = (bridge) => JSON.parse(bridge.__doc);

// Drives the real task sheet rather than poking the model directly.
function addTask(w, name, date, time, category) {
  w.__todo.openTaskModal(null);
  w.document.getElementById('nameInput').value = name;
  w.document.getElementById('dateInput').value = date;
  w.document.getElementById('timeInput').value = time || '';
  if (category) {
    const sel = w.document.getElementById('categoryInput');
    // Pick the existing option when there is one, otherwise go through the
    // "+ New category…" path the same way a user would.
    if ([...sel.options].some((o) => o.value === category)) {
      sel.value = category;
    } else {
      sel.value = '__new';
      w.document.getElementById('newCategoryInput').value = category;
    }
  }
  w.document.getElementById('taskSave').click();
}

// A stored task exactly as it sits in localStorage, before normalizeTask().
const seed = (over) => Object.assign({
  id: 'seed', name: 'Task', date: '', time: '', day: '', category: '',
  completed: false, completedAt: null, recurrence: null, notifId: 1
}, over);

const only = (bridge) => [...bridge.__scheduled.values()][0];

module.exports = async function run(t) {
  const today = new Date();
  const iso = (d) => toISO(d);
  const t2 = iso(addDays(today, 2));
  const t5 = iso(addDays(today, 5));

  t.section('permission granted — create, edit, complete, delete');
  {
    const { w, bridge } = await boot('granted');
    t.check('channel created on android', bridge.__calls.createChannel, 1);

    addTask(w, 'Pay rent', t2, '09:30');
    await settle();
    t.check('creating a dated task arms one reminder', bridge.__scheduled.size, 1);

    const task = w.__todo.getTasks().find((x) => x.name === 'Pay rent');
    t.check('task got a numeric notifId', typeof task.notifId, 'number');
    t.check('notification id matches notifId', only(bridge).id, task.notifId);
    t.check('title is the task name', only(bridge).title, 'Pay rent');
    t.check('fires at the chosen time',
      new Date(only(bridge).schedule.at).toTimeString().slice(0, 5), '09:30');

    const before = bridge.__calls.schedule;
    w.__todo.openTaskModal(task);
    w.document.getElementById('timeInput').value = '18:45';
    w.document.getElementById('taskSave').click();
    await settle();
    t.check('editing keeps exactly one reminder', bridge.__scheduled.size, 1);
    t.check('reminder moved to the new time',
      new Date(only(bridge).schedule.at).toTimeString().slice(0, 5), '18:45');
    t.check('reminder kept its stable id', only(bridge).id, task.notifId);
    t.check('a reschedule actually happened', bridge.__calls.schedule > before, 'true');

    const sched = bridge.__calls.schedule, canc = bridge.__calls.cancel;
    addTask(w, 'No date task', '', '');
    await settle();
    t.check('dateless task arms nothing', bridge.__scheduled.size, 1);
    t.check('unchanged reminder is not rescheduled', bridge.__calls.schedule, sched);
    t.check('unchanged reminder is not cancelled', bridge.__calls.cancel, canc);

    w.__todo.toggleComplete(task.id);
    await settle();
    t.check('completing cancels the reminder', bridge.__scheduled.size, 0);

    w.__todo.toggleComplete(task.id);
    await settle();
    t.check('un-completing re-arms it', bridge.__scheduled.size, 1);

    w.__todo.deleteTask(task.id);
    await settle();
    t.check('deleting cancels the reminder', bridge.__scheduled.size, 0);
  }

  /* ── a reminder that has already fired ──────────────────────────────────
     Once an alarm goes off the plugin erases its own record of it, so the
     notification is no longer pending and sync()'s diff can never reach it.
     Only a delivered-side dismissal can clear the banner, and only the task
     the user actually touched should lose one. */

  // Fired an hour ago: the date is past, so nothing is armed and nothing will
  // be re-armed — leaving __scheduled.size === 0 as a stable invariant while
  // the banner sits in the shade.
  const firedSeed = (over) => seed(Object.assign({
    id: 'a', name: 'Overdue', date: iso(addDays(today, -1)), time: '09:00', notifId: 11
  }, over));
  const withBanner = (id) => (b) => b.__delivered.set(id, { id: id, title: 'Overdue' });

  t.section('a fired banner is dismissed when the task is deleted');
  {
    const { w, bridge } = await boot('granted', [firedSeed()], withBanner(11));
    t.check('a past reminder arms nothing', bridge.__scheduled.size, 0);
    t.check('booting leaves the banner alone', bridge.__delivered.size, 1);
    t.check('and dismisses nothing', bridge.__calls.removeDelivered, 0);

    w.__todo.deleteTask('a');
    await settle();
    t.check('deleting clears the banner', bridge.__delivered.size, 0);
    t.check('via the delivered API', bridge.__calls.removeDelivered, 1);
    t.check('the shade was not swept wholesale', bridge.__calls.removeAllDelivered, 0);

    // Undo restores the task but deliberately not the banner: a banner records
    // a moment that has passed, and re-posting it would announce a reminder for
    // a time now behind us.
    w.document.querySelector('#toastRegion .toast-action').click();
    await settle();
    t.check('undo restores the task', w.__todo.getTasks().length, 1);
    t.check('but not the banner', bridge.__delivered.size, 0);
  }

  t.section('a fired banner is dismissed when the task is completed');
  {
    const { w, bridge } = await boot('granted', [firedSeed()], withBanner(11));

    w.__todo.toggleComplete('a');
    await settle();
    t.check('completing clears the banner', bridge.__delivered.size, 0);
    t.check('through the delivered API', bridge.__calls.removeDelivered, 1);

    w.__todo.toggleComplete('a');
    await settle();
    t.check('un-completing dismisses nothing further', bridge.__calls.removeDelivered, 1);
  }

  t.section('a recurring task loses its banner but keeps its alarm');
  {
    const recurring = [{
      id: 'rec-1', name: 'Standup', date: iso(addDays(today, 1)), time: '09:00',
      completed: false, completedAt: null,
      recurrence: { type: 'custom', interval: 1, unit: 'day' }, notifId: 4242
    }];
    const { w, bridge } = await boot('granted', recurring);
    t.check('armed at boot', bridge.__scheduled.size, 1);

    // The alarm goes off: banner posted, plugin record erased.
    t.check('the reminder fired', String(bridge.__fire(4242)), 'true');
    t.check('and is no longer pending', bridge.__scheduled.size, 0);

    const canc = bridge.__calls.cancel;
    w.__todo.toggleComplete('rec-1');   // the UI path, not the banner action
    await settle();

    t.check('the fired banner is gone', bridge.__delivered.size, 0);
    // Note the banner would have gone here anyway, because sync() re-arms 4242
    // and schedule() dismisses first — so the check above is not on its own
    // evidence this app did it. This one is.
    t.check('and this app asked for it', bridge.__calls.removeDelivered, 1);
    // The assertion that fails if anyone swaps dismiss() back to p.cancel():
    // cancelling would have taken the freshly-armed alarm with it.
    t.check('dismissed, not cancelled', bridge.__calls.cancel, canc);
    t.check('the next occurrence is armed', bridge.__scheduled.size, 1);
    t.check('on the same notification id', only(bridge).id, 4242);
    t.check('for the day after', iso(new Date(only(bridge).schedule.at)), iso(addDays(today, 2)));
  }

  t.section('editing an overdue task clears its banner and re-arms it');
  {
    const { w, bridge } = await boot('granted', [firedSeed()], withBanner(11));

    w.__todo.openTaskModal(w.__todo.getTasks()[0]);
    w.document.getElementById('dateInput').value = t2;
    w.document.getElementById('taskSave').click();
    await settle();

    t.check('the stale banner is gone', bridge.__delivered.size, 0);
    t.check('through the delivered API', bridge.__calls.removeDelivered, 1);
    t.check('and the new time is armed', bridge.__scheduled.size, 1);
    t.check('on the same stable id', only(bridge).id, 11);
    t.check('at the new date', iso(new Date(only(bridge).schedule.at)), t2);
  }

  t.section('an unrelated save leaves every banner up');
  {
    const { w, bridge } = await boot('granted', [
      firedSeed(),
      seed({ id: 'b', name: 'Later', date: t2, time: '09:00', notifId: 12 })
    ], withBanner(11));
    t.check('boot dismissed nothing', bridge.__calls.removeDelivered, 0);
    t.check('the banner survived boot', bridge.__delivered.size, 1);

    addTask(w, 'Unrelated', '', '');
    await settle();
    t.check('creating a task dismisses nothing', bridge.__calls.removeDelivered, 0);
    t.check('the banner is still up', bridge.__delivered.size, 1);

    // Editing a different task takes its own banner, not this one's.
    w.__todo.openTaskModal(w.__todo.getTasks().filter((x) => x.id === 'b')[0]);
    w.document.getElementById('nameInput').value = 'Later, renamed';
    w.document.getElementById('taskSave').click();
    await settle();
    t.check('the other task’s banner is untouched', bridge.__delivered.size, 1);
    t.check('and it is still the right one', [...bridge.__delivered.keys()][0], 11);
    t.check('the shade was never swept', bridge.__calls.removeAllDelivered, 0);
  }

  /* The bound on all of the above, found on a real device: the targeting only
     holds for a banner nothing re-arms. LocalNotificationManager.schedule()
     dismisses a visible notification before arming its id, so any recurring
     task — or any task moved to a future date — loses its banner the next time
     sync() re-schedules it, with the app never asking. Pinned here so the
     guarantee is not read as broader than it is. */
  t.section('a re-armed reminder loses its banner without the app asking');
  {
    const recurring = [{
      id: 'rec-2', name: 'Standup', date: iso(addDays(today, 1)), time: '09:00',
      completed: false, completedAt: null,
      recurrence: { type: 'custom', interval: 1, unit: 'day' }, notifId: 77
    }];
    // The banner is already in the shade as the app starts, and boot force-syncs.
    const { bridge } = await boot('granted', recurring, withBanner(77));

    t.check('the reminder is armed', bridge.__scheduled.size, 1);
    t.check('but the banner is gone', bridge.__delivered.size, 0);
    t.check('and this app never asked', bridge.__calls.removeDelivered, 0);
  }

  t.section('8am default for a task with no time');
  {
    const { w, bridge } = await boot('granted');
    addTask(w, 'Dentist', t2, '');
    await settle();
    t.check('defaults to 08:00, not 23:59',
      new Date(only(bridge).schedule.at).toTimeString().slice(0, 5), '08:00');
    t.check('on the right day', iso(new Date(only(bridge).schedule.at)), t2);
  }

  t.section('recurring task + "Mark done" from the banner');
  {
    // Seeded through storage so the recurrence rule is set without driving
    // the repeat sheet UI.
    const seed = [{
      id: 'rec-1', name: 'Standup', date: iso(addDays(today, 1)), time: '09:00',
      completed: false, completedAt: null,
      recurrence: { type: 'custom', interval: 1, unit: 'day' }, notifId: 4242
    }];
    const { w, bridge } = await boot('granted', seed);
    t.check('recurring task armed at boot', bridge.__scheduled.size, 1);
    t.check('armed for tomorrow',
      iso(new Date(only(bridge).schedule.at)), iso(addDays(today, 1)));

    const handler = bridge.__listeners['localNotificationActionPerformed'];
    t.check('action listener registered', typeof handler, 'function');
    handler({ actionId: 'done', notification: { id: 4242, extra: { taskId: 'rec-1' } } });
    await settle();

    t.check('still exactly one reminder armed', bridge.__scheduled.size, 1);
    t.check('rolled forward to the next occurrence',
      iso(new Date(only(bridge).schedule.at)), iso(addDays(today, 2)));
    t.check('kept the same notification id', only(bridge).id, 4242);
    t.check('the completed occurrence was archived',
      w.__todo.getTasks().filter((x) => x.completed).length, 1);
  }

  /* On Android, "Mark done" is handled by TaskActionReceiver, which rewrites
     tasks.json while the WebView holds a stale list. These cover the web half
     of that: the plugin's storeChanged event and the return to the foreground.
     The receiver itself is Java and out of reach here — RecurrenceTest covers
     the date math it depends on. */
  t.section('a document rewritten outside the WebView is picked up');
  {
    const { w, bridge } = await boot('granted', [
      seed({ id: 'a', name: 'Standup', date: iso(today), time: '09:00', notifId: 1 })
    ]);

    t.check('booted with its one task', w.__todo.getTasks().length, 1);
    t.check('a store listener was registered', typeof bridge.__storeListeners.storeChanged, 'function');

    // What the receiver leaves behind: the task completed, plus one it minted.
    bridge.__doc = JSON.stringify({
      version: 2,
      notifSeq: 7,
      tasks: [
        {
          id: 'a', name: 'Standup', date: iso(today), time: '09:00', day: '', category: '',
          completed: true, completedAt: '2026-08-14T09:00:00.000Z', recurrence: null, notifId: 1
        },
        {
          id: 'b', name: 'Archived occurrence', date: '', time: '', day: '', category: '',
          completed: false, completedAt: null, recurrence: null, notifId: 7
        }
      ],
      updatedAt: '2026-08-14T09:00:00.000Z'
    });

    const writes = bridge.__calls.write;
    bridge.__storeListeners.storeChanged();
    await settle();

    const list = w.__todo.getTasks();
    t.check('the list was replaced, not concatenated', list.length, 2);
    t.check('the background completion came across', String(list.find((x) => x.id === 'a').completed), 'true');
    t.check('and the task that came with it', list.find((x) => x.id === 'b').name, 'Archived occurrence');
    t.check('a reload writes nothing by itself', bridge.__calls.write, writes);
    t.check('the completed card was rendered',
      w.document.querySelectorAll('#completedList [data-card]').length, 1);
  }

  t.section('a failed reload leaves the list alone');
  {
    const { w, bridge } = await boot('granted', [seed({ id: 'a', name: 'Mine', notifId: 1 })]);
    bridge.__failRead = true;
    const writes = bridge.__calls.write;

    bridge.__storeListeners.storeChanged();
    await settle();

    t.check('the task survived', w.__todo.getTasks().length, 1);
    t.check('and is still itself', w.__todo.getTasks()[0].name, 'Mine');
    t.check('nothing was written over it', bridge.__calls.write, writes);
  }

  t.section('returning to the foreground re-reads the document');
  {
    const { w, bridge } = await boot('granted', [seed({ id: 'a', name: 'Mine', notifId: 1 })]);
    t.check('an appStateChange listener was registered',
      typeof bridge.__appListeners.appStateChange, 'function');

    bridge.__doc = JSON.stringify({
      version: 2,
      notifSeq: 3,
      tasks: [{
        id: 'a', name: 'Renamed in the background', date: '', time: '', day: '', category: '',
        completed: false, completedAt: null, recurrence: null, notifId: 1
      }],
      updatedAt: '2026-08-14T09:00:00.000Z'
    });

    // Going away is not coming back — only isActive should re-read.
    bridge.__appListeners.appStateChange({ isActive: false });
    await settle();
    t.check('a background transition does not reload', w.__todo.getTasks()[0].name, 'Mine');

    bridge.__appListeners.appStateChange({ isActive: true });
    await settle();
    t.check('coming back does', w.__todo.getTasks()[0].name, 'Renamed in the background');
    t.check('still exactly one task', w.__todo.getTasks().length, 1);
  }

  /* A recurring series advances when it is completed, and at no other time.
     Booting used to walk a stale one forward and arm the next occurrence, so
     the card said Overdue for a date the alarm had already moved past. Now the
     missed occurrence simply waits. */
  t.section('a missed recurring occurrence waits to be completed');
  {
    const past = iso(addDays(today, -40));
    const seeded = [{
      id: 'old-1', name: 'Weekly review', date: past, time: '09:00',
      completed: false, completedAt: null,
      recurrence: { type: 'custom', interval: 1, unit: 'week' }, notifId: 77
    }];
    const { w, bridge } = await boot('granted', seeded);
    t.check('a missed series arms nothing', bridge.__scheduled.size, 0);
    t.check('and keeps the date it was on', w.__todo.getTasks()[0].date, past);

    // Completing it is the thing that moves the series on — and re-arms it.
    w.__todo.toggleComplete('old-1');
    await settle();
    t.check('completing arms the next occurrence', bridge.__scheduled.size, 1);
    t.check('which is in the future',
      new Date(only(bridge).schedule.at).getTime() > Date.now(), 'true');
    t.check('and the missed one is archived as done',
      w.__todo.getTasks().filter((x) => x.completed).length, 1);
  }

  /* The exception, and the only place the app skips an occurrence: a task
     given a time that was already behind it. No reminder ever existed for that
     slot, so it is not a missed one. */
  t.section('a recurring task written after its time starts at the next occurrence');
  {
    const past = iso(addDays(today, -3));
    const seeded = [{
      id: 'late-1', name: 'Standup', date: past, time: '09:00',
      completed: false, completedAt: null,
      recurrence: { type: 'custom', interval: 1, unit: 'day' }, notifId: 55
    }];
    const { w, bridge } = await boot('granted', seeded);
    t.check('nothing armed while it sits missed', bridge.__scheduled.size, 0);

    // Re-saving through the sheet is a write, so it starts from the next one.
    // openTaskModal carries the existing recurrence into draftRecurrence.
    w.__todo.openTaskModal(w.__todo.getTasks()[0]);
    w.document.getElementById('taskSave').click();
    await settle();

    // Today if 09:00 is still ahead, otherwise tomorrow — computed rather than
    // hard-coded, so the suite does not depend on what time it is run.
    const nineToday = new Date(today); nineToday.setHours(9, 0, 0, 0);
    const expected = nineToday.getTime() > Date.now() ? iso(today) : iso(addDays(today, 1));
    t.check('the date moved to the next occurrence',
      w.__todo.getTasks()[0].date, expected);
    t.check('and a reminder is armed', bridge.__scheduled.size, 1);
    t.check('on the same notification id', only(bridge).id, 55);
    t.check('in the future',
      new Date(only(bridge).schedule.at).getTime() > Date.now(), 'true');
  }

  t.section('legacy tasks with no notifId');
  {
    const seed = [{ id: 'legacy-1', name: 'Old task', date: t5, time: '10:00', completed: false }];
    const { w, bridge } = await boot('granted', seed);
    const task = w.__todo.getTasks()[0];
    t.check('notifId backfilled on load', typeof task.notifId, 'number');
    t.check('and it got armed', bridge.__scheduled.size, 1);
    t.check('backfilled id was persisted', docOf(bridge).tasks[0].notifId, task.notifId);
  }

  t.section('duplicate notifIds from a merged backup');
  {
    const seed = [
      { id: 'a', name: 'A', date: t2, time: '09:00', completed: false, notifId: 5 },
      { id: 'b', name: 'B', date: t5, time: '09:00', completed: false, notifId: 5 }
    ];
    const { w, bridge } = await boot('granted', seed);
    const ids = w.__todo.getTasks().map((x) => x.notifId);
    t.check('collision was resolved', new Set(ids).size, 2);
    t.check('both reminders survive', bridge.__scheduled.size, 2);
  }

  t.section('permission denied');
  {
    const { w, bridge } = await boot('denied');
    addTask(w, 'Ignored', t2, '09:00');
    await settle();
    t.check('nothing is scheduled', bridge.__scheduled.size, 0);
    t.check('the OS was not re-prompted', bridge.__calls.requestPermissions, 0);
    t.check('the task still saved normally', w.__todo.getTasks().length, 1);
  }

  t.section('first-run pre-permission explainer');
  {
    const { w, bridge } = await boot('prompt');
    addTask(w, 'First', t2, '09:00');
    await settle();

    const text = w.document.getElementById('confirmText').textContent;
    t.check('explainer dialog is shown before the OS prompt',
      w.document.getElementById('confirmOverlay').hidden, 'false');
    t.check('OS not yet asked', bridge.__calls.requestPermissions, 0);
    t.check('explainer names the task-reminder purpose', /reminder/i.test(text), 'true');
    t.check('explainer promises no server', /nothing is ever sent to a server/i.test(text), 'true');

    const buttons = [...w.document.getElementById('confirmButtons').querySelectorAll('button')];
    t.check('has a decline and an accept', buttons.length, 2);
    buttons.find((b) => /turn on/i.test(b.textContent)).click();
    await settle();
    t.check('OS prompt followed the explainer', bridge.__calls.requestPermissions, 1);
    t.check('reminder armed after granting', bridge.__scheduled.size, 1);
    t.check('explainer remembered', w.localStorage.getItem('todo.notifyIntro.v1'), '1');
  }

  t.section('cold start re-arms alarms the OS silently dropped');
  {
    /* Regression for the failure seen on a moto g71 running Android 12: after
       a force-stop — or an OEM background kill — the AlarmManager entry is
       gone but the plugin's SharedPreferences record survives, so getPending()
       still reports the notification as pending at the desired time. A
       diffing sync sees desired == pending, schedules nothing, and the
       reminder never fires again. Cold start must therefore re-arm blind. */
    const at = new Date(fireTime(t2, '13:18'));
    const seed = [{
      id: 'x1', name: 'Test1', date: t2, time: '13:18',
      completed: false, completedAt: null, recurrence: null, notifId: 1
    }];

    const { w, bridge } = await boot('granted', seed, (b) => {
      b.__scheduled.set(1, { id: 1, title: 'Test1', schedule: { at } });
    });

    t.check('cold start cancelled the stale entry', bridge.__calls.cancel > 0, 'true');
    t.check('cold start re-scheduled it for real', bridge.__calls.schedule > 0, 'true');
    t.check('still exactly one reminder', bridge.__scheduled.size, 1);
    t.check('at the right time', new Date(only(bridge).schedule.at).getTime(), at.getTime());

    // An in-session save must still take the cheap diffing path.
    const s = bridge.__calls.schedule, c = bridge.__calls.cancel;
    addTask(w, 'Unrelated', '', '');
    await settle();
    t.check('in-session save does not re-arm everything', bridge.__calls.schedule, s);
    t.check('in-session save cancels nothing', bridge.__calls.cancel, c);
  }

  t.section('voice quick-add fills the sheet and saves through the normal path');
  {
    // Intro pre-seeded: the explainer has its own section below.
    const { w, bridge } = await boot(
      'granted',
      [seed({ id: 'a', name: 'Existing', category: 'Work', notifId: 1 })],
      null,
      (win) => win.localStorage.setItem('todo.voiceIntro.v1', '1')
    );

    t.check('mic button appears when the plugin is there',
      w.document.getElementById('micFab').hidden, 'false');

    w.document.getElementById('micFab').click();
    await settle();
    t.check('the listening panel opened', w.document.getElementById('voiceOverlay').hidden, 'false');
    t.check('the mic was opened', bridge.__calls.voiceStart, 1);

    bridge.__say('buy milk tomorrow at 5pm in work');
    await settle();

    /* closeModal marks the overlay 'closing' and hides it 150ms later, and
       settle() can land on either side of that. Both states mean dismissed;
       asserting one of them specifically would be a coin toss. */
    const gone = (el) => el.hidden || el.classList.contains('closing');
    t.check('the listening panel was dismissed',
      gone(w.document.getElementById('voiceOverlay')), 'true');
    t.check('the mic was released', bridge.__calls.voiceStop > 0, 'true');

    t.check('the task sheet opened', w.document.getElementById('taskOverlay').hidden, 'false');
    t.check('name came from the transcript', w.document.getElementById('nameInput').value, 'Buy milk');
    t.check('date came from the transcript',
      w.document.getElementById('dateInput').value, iso(addDays(today, 1)));
    t.check('time came from the transcript', w.document.getElementById('timeInput').value, '17:00');
    t.check('category matched an existing one',
      w.document.getElementById('categoryInput').value, 'Work');

    // The whole design rests on this: hearing something writes nothing.
    t.check('nothing is saved until the user confirms', w.__todo.getTasks().length, 1);

    w.document.getElementById('taskSave').click();
    await settle();

    const added = w.__todo.getTasks().find((x) => x.name === 'Buy milk');
    t.check('saving adds it', w.__todo.getTasks().length, 2);
    t.check('with the parsed time', added.time, '17:00');
    t.check('with the parsed category', added.category, 'Work');
    t.check('and it went through the normal save path, so a reminder was armed',
      bridge.__scheduled.has(added.notifId), 'true');
  }

  /* Backlog item 11. A marked form — "in X", "under X", "category X",
     "X category" — may create a category that does not exist yet, and the
     sheet has to read as creating rather than picking, because that sheet is
     the only thing standing between a mishearing and a permanent namespace. */
  t.section('voice: a marked category that does not exist yet is created');
  {
    const { w, bridge } = await boot(
      'granted',
      [seed({ id: 'a', name: 'Existing', category: 'Work', notifId: 1 })],
      null,
      (win) => win.localStorage.setItem('todo.voiceIntro.v1', '1')
    );
    const d = w.document;

    d.getElementById('micFab').click();
    await settle();
    bridge.__say('buy milk tomorrow in sundries');
    await settle();

    t.check('the category came out of the name',
      d.getElementById('nameInput').value, 'Buy milk');
    t.check('parked behind the new-category sentinel',
      d.getElementById('categoryInput').value, '__new');
    t.check('with the spoken name waiting in it',
      d.getElementById('newCategoryInput').value, 'Sundries');
    t.check('and the sheet says it would be new',
      d.getElementById('categoryButtonText').textContent, 'Sundries (new)');

    // Hearing it creates nothing: the category exists only once a task carries it.
    t.check('the category does not exist yet',
      w.__todo.getCategories().join(','), 'Work');

    d.getElementById('taskSave').click();
    await settle();

    t.check('saving creates it',
      w.__todo.getTasks().find((x) => x.name === 'Buy milk').category, 'Sundries');
    t.check('and it joined the category list',
      w.__todo.getCategories().join(','), 'Sundries,Work');
    t.check('and it reached storage',
      docOf(bridge).tasks.some((x) => x.category === 'Sundries'), 'true');
  }

  t.section('voice: an existing category is matched, not recreated');
  {
    const { w, bridge } = await boot(
      'granted',
      [seed({ id: 'a', name: 'Existing', category: 'Work', notifId: 1 })],
      null,
      (win) => win.localStorage.setItem('todo.voiceIntro.v1', '1')
    );
    const d = w.document;

    d.getElementById('micFab').click();
    await settle();
    bridge.__say('buy milk tomorrow in work');
    await settle();

    t.check('the existing one is selected',
      d.getElementById('categoryInput').value, 'Work');
    t.check('and the button does not call it new',
      d.getElementById('categoryButtonText').textContent, 'Work');
    t.check('nothing is parked behind the sentinel',
      d.getElementById('newCategoryInput').value, '');
  }

  t.section('voice: a spoken repeat becomes a recurrence rule');
  {
    const { w, bridge } = await boot('granted', [], null,
      (win) => win.localStorage.setItem('todo.voiceIntro.v1', '1'));

    w.document.getElementById('micFab').click();
    await settle();
    bridge.__say('water the plants every 3 days');
    await settle();
    w.document.getElementById('taskSave').click();
    await settle();

    const added = w.__todo.getTasks()[0];
    t.check('the task was named', added.name, 'Water the plants');
    t.check('the rule survived into the saved task',
      added.recurrence && added.recurrence.interval + ' ' + added.recurrence.unit, '3 day');
  }

  t.section('voice: nothing heard means nothing happens');
  {
    const { w, bridge } = await boot('granted', [], null,
      (win) => win.localStorage.setItem('todo.voiceIntro.v1', '1'));

    w.document.getElementById('micFab').click();
    await settle();
    bridge.__say('');
    await settle();

    t.check('no task sheet', w.document.getElementById('taskOverlay').hidden, 'true');
    t.check('no task added', w.__todo.getTasks().length, 0);
  }

  t.section('voice: the explainer comes before the microphone prompt');
  {
    const { w, bridge } = await boot('granted', [], null);

    w.document.getElementById('micFab').click();
    await settle();

    const text = w.document.getElementById('confirmText').textContent;
    t.check('explainer shown', w.document.getElementById('confirmOverlay').hidden, 'false');
    t.check('mic not yet opened', bridge.__calls.voiceStart, 0);
    t.check('explainer promises the audio stays put',
      /never leaves your phone/i.test(text), 'true');

    [...w.document.querySelectorAll('#confirmButtons button')]
      .find((b) => /continue/i.test(b.textContent)).click();
    await settle();
    t.check('the mic followed the explainer', bridge.__calls.voiceStart, 1);
  }

  t.section('voice: a refused microphone is reported, not swallowed');
  {
    const { w, bridge } = await boot('granted', [], (b) => { b.__voiceGranted = false; },
      (win) => win.localStorage.setItem('todo.voiceIntro.v1', '1'));

    w.document.getElementById('micFab').click();
    await settle();

    const shut = w.document.getElementById('voiceOverlay');
    t.check('the panel was dismissed', shut.hidden || shut.classList.contains('closing'), 'true');
    t.check('the user was told', /microphone/i.test(w.document.getElementById('toastRegion').textContent), 'true');
    t.check('no task sheet opened', w.document.getElementById('taskOverlay').hidden, 'true');
  }

  t.section('voice: the button is hidden when the model is missing');
  {
    const { w } = await boot('granted', [], (b) => { b.__voiceAvailable = false; });
    t.check('mic button hidden', w.document.getElementById('micFab').hidden, 'true');
  }

  t.section('web build still works with no Capacitor');
  {
    const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'http://localhost/' });
    const w = dom.window;
    w.localStorage.setItem('todo.tasks.v1', JSON.stringify([seed({ id: 'old', name: 'From before' })]));
    w.eval(fs.readFileSync(path.join(ROOT, 'store.js'), 'utf8'));
    w.eval(fs.readFileSync(path.join(ROOT, 'notify.js'), 'utf8'));
    w.eval(fs.readFileSync(path.join(ROOT, 'nlu.js'), 'utf8'));
    w.eval(fs.readFileSync(path.join(ROOT, 'voice.js'), 'utf8'));
    w.eval(fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8'));
    await settle();
    addTask(w, 'Browser task', t2, '09:00');
    await settle();
    t.check('task saved with no bridge present', w.__todo.getTasks().length, 2);
    t.check('notify layer reports non-native', w.TodoNotify.state().native, 'false');
    t.check('no crash in the render path',
      w.document.querySelectorAll('[data-card]').length > 0, 'true');

    const doc = JSON.parse(w.localStorage.getItem('todo.store.v1'));
    t.check('browser fallback writes the document', doc.tasks.length, 2);
    t.check('and migrated the old key away', w.localStorage.getItem('todo.tasks.v1'), 'null');

    // Voice is Android-only. A browser has no plugin, so the button must stay
    // hidden rather than offering something that can only fail.
    t.check('voice layer reports non-native', w.TodoVoice.isNative(), 'false');
    t.check('mic button stays hidden with no plugin', w.document.getElementById('micFab').hidden, 'true');
  }

  t.section('completed section is collapsed by default');
  {
    const { w } = await boot('granted', [
      seed({ id: 'a', name: 'Write notes', notifId: 1 }),
      seed({ id: 'b', name: 'Buy milk', completed: true, completedAt: '2026-08-01T10:00:00.000Z', notifId: 2 })
    ]);
    const d = w.document;
    t.check('completed list starts collapsed', d.getElementById('completedList').hidden, 'true');
    t.check('the section header is still shown', d.getElementById('completedSection').hidden, 'false');
    t.check('toggle reports collapsed', d.getElementById('completedToggle').getAttribute('aria-expanded'), 'false');
    t.check('the completed card is still built', d.querySelectorAll('#completedList [data-card]').length, 1);

    d.getElementById('completedToggle').click();
    t.check('clicking expands it', d.getElementById('completedList').hidden, 'false');
    d.getElementById('completedToggle').click();
    t.check('and collapses it again', d.getElementById('completedList').hidden, 'true');
  }

  t.section('live search');
  {
    const { w } = await boot('granted', [
      seed({ id: 'a', name: 'Write notes', notifId: 1 }),
      seed({ id: 'b', name: 'Buy milk', notifId: 2 }),
      seed({ id: 'c', name: 'Milk the cow', completed: true, completedAt: '2026-08-01T10:00:00.000Z', notifId: 3 })
    ]);
    const d = w.document;
    const pending = () => d.querySelectorAll('#pendingList [data-card]').length;
    const done = () => d.querySelectorAll('#completedList [data-card]').length;

    t.check('everything shown before searching', pending(), 2);
    t.check('search row is offered', d.getElementById('searchRow').hidden, 'false');

    const input = d.getElementById('searchInput');
    input.value = 'milk';
    input.dispatchEvent(new w.Event('input', { bubbles: true }));

    t.check('search narrows pending', pending(), 1);
    t.check('search reaches completed too', done(), 1);
    t.check('search forces completed open', d.getElementById('completedList').hidden, 'false');
    t.check('clear button appears', d.getElementById('searchClear').hidden, 'false');
    t.check('summary switches to a match count', d.getElementById('summary').textContent, 'Showing 2 of 3');

    d.getElementById('searchClear').click();
    t.check('clearing restores every card', pending(), 2);
    t.check('completed collapses back to the default', d.getElementById('completedList').hidden, 'true');
    t.check('clear button hides itself', d.getElementById('searchClear').hidden, 'true');
  }

  t.section('no results reads differently from an empty list');
  {
    const { w } = await boot('granted', [seed({ id: 'a', name: 'Write notes', notifId: 1 })]);
    const d = w.document;

    w.__todo.setSearch('zzzz');
    t.check('no-results shown', d.getElementById('noResults').hidden, 'false');
    t.check('empty state stays hidden', d.getElementById('emptyState').hidden, 'true');
    t.check('message quotes the query',
      d.getElementById('noResultsText').textContent.indexOf('zzzz') > -1, 'true');

    d.getElementById('clearFilters').click();
    t.check('clear filters brings the task back', d.querySelectorAll('#pendingList [data-card]').length, 1);
    t.check('no-results hidden again', d.getElementById('noResults').hidden, 'true');

    const { w: empty } = await boot('granted');
    t.check('a truly empty app shows the empty state',
      empty.document.getElementById('emptyState').hidden, 'false');
    t.check('and hides the search row it has nothing to search',
      empty.document.getElementById('searchRow').hidden, 'true');
  }

  t.section('categories live and die with their tasks');
  {
    const { w, bridge } = await boot('granted');
    addTask(w, 'Standup', t2, '09:00', 'Work');
    await settle();
    t.check('category stored on the task', w.__todo.getTasks()[0].category, 'Work');
    t.check('and offered for future tasks', w.__todo.getCategories().join(','), 'Work');
    t.check('the document stores no category list',
      Object.prototype.hasOwnProperty.call(docOf(bridge), 'categories'), 'false');

    addTask(w, 'Retro', t5, '10:00', 'work');
    await settle();
    t.check('a case variant folds onto the known spelling',
      w.__todo.getCategories().join(','), 'Work');
    t.check('and the task took the canonical spelling', w.__todo.getTasks()[1].category, 'Work');

    // One of the two tasks holding "Work" goes; the category stays because the
    // other still carries it.
    w.__todo.deleteTask(w.__todo.getTasks()[0].id);
    await settle();
    t.check('one task left', w.__todo.getTasks().length, 1);
    t.check('category still offered while a task carries it',
      w.__todo.getCategories().join(','), 'Work');

    // The last one goes, and the category goes with it.
    w.__todo.deleteTask(w.__todo.getTasks()[0].id);
    await settle();
    t.check('no tasks left', w.__todo.getTasks().length, 0);
    t.check('category dropped with its last task', w.__todo.getCategories().join(','), '');
  }

  t.section('a completed task keeps its category alive');
  {
    const { w } = await boot('granted', [
      seed({ id: 'a', name: 'Archived', category: 'Work', completed: true,
             completedAt: '2026-08-01T10:00:00.000Z', notifId: 1 })
    ]);
    t.check('completed-only category is still offered',
      w.__todo.getCategories().join(','), 'Work');

    w.__todo.deleteTask('a');
    await settle();
    t.check('and goes when that task is deleted', w.__todo.getCategories().join(','), '');
  }

  t.section('categories arriving from a backup are folded in');
  {
    const { w } = await boot('granted', [
      seed({ id: 'a', name: 'Ship it', category: 'Errands', notifId: 1 })
    ]);
    t.check('imported category is offered', w.__todo.getCategories().join(','), 'Errands');
    t.check('and shows on the card',
      w.document.querySelector('#pendingList [data-cat]').textContent, 'Errands');
  }

  t.section('assigning a category from a card chip');
  {
    const { w } = await boot('granted', [seed({ id: 'a', name: 'Standup', notifId: 1 })]);
    const d = w.document;

    const chip = d.querySelector('#pendingList [data-cat]');
    t.check('an uncategorised card still offers the chip', chip.textContent, 'Uncategorised');

    chip.click();
    t.check('the picker opened', d.getElementById('categoryOverlay').hidden, 'false');
    t.check('the picker offers Uncategorised',
      d.querySelectorAll('#categoryOptions .option').length, 1);

    d.getElementById('pickerNewCategory').value = 'Errands';
    d.getElementById('pickerAddCategory').click();
    await settle();

    t.check('the task took the new category', w.__todo.getTasks()[0].category, 'Errands');
    t.check('the chip shows it', d.querySelector('#pendingList [data-cat]').textContent, 'Errands');
    t.check('and it joined the category list', w.__todo.getCategories().join(','), 'Errands');
  }

  t.section('picking a category inside the task sheet');
  {
    const { w } = await boot('granted', [
      seed({ id: 'a', name: 'Ship it', category: 'Errands', notifId: 1 })
    ]);
    const d = w.document;

    w.__todo.openTaskModal(null);
    t.check('the sheet has no Day field', String(d.getElementById('dayInput')), 'null');
    t.check('the button starts uncategorised',
      d.getElementById('categoryButtonText').textContent, 'Uncategorised');

    d.getElementById('categoryButton').click();
    t.check('the picker opened', d.getElementById('categoryOverlay').hidden, 'false');
    t.check('it offers Uncategorised and the known category',
      [...d.querySelectorAll('#categoryOptions .option strong')].map((e) => e.textContent).join(','),
      'Uncategorised,Errands');

    [...d.querySelectorAll('#categoryOptions .option')][1].click();
    // closeModal() hides on a 150ms animation tick; the class flips at once.
    t.check('the picker closed',
      d.getElementById('categoryOverlay').classList.contains('closing'), 'true');
    t.check('the button shows the choice',
      d.getElementById('categoryButtonText').textContent, 'Errands');

    // A name invented in the sheet has no task yet, so it rides the __new path.
    d.getElementById('categoryButton').click();
    d.getElementById('pickerNewCategory').value = 'Health';
    d.getElementById('pickerAddCategory').click();
    t.check('the button shows the invented name, marked as new',
      d.getElementById('categoryButtonText').textContent, 'Health (new)');
    t.check('parked behind the new-category sentinel',
      d.getElementById('categoryInput').value, '__new');

    d.getElementById('nameInput').value = 'Walk';
    d.getElementById('taskSave').click();
    await settle();

    t.check('the task saved with it',
      w.__todo.getTasks().find((x) => x.name === 'Walk').category, 'Health');
    t.check('and it joined the category list',
      w.__todo.getCategories().join(','), 'Errands,Health');

    // Reopening an existing task must show its category checked.
    w.__todo.openTaskModal(w.__todo.getTasks().find((x) => x.name === 'Ship it'));
    t.check('editing preselects the stored category',
      d.getElementById('categoryButtonText').textContent, 'Errands');
    d.getElementById('categoryButton').click();
    t.check('and the picker checks that row',
      d.querySelector('#categoryOptions .option[aria-checked="true"] strong').textContent, 'Errands');
  }

  t.section('category filter drawer');
  {
    const { w } = await boot('granted', [
      seed({ id: 'a', name: 'Standup', category: 'Work', notifId: 1 }),
      seed({ id: 'b', name: 'Buy milk', category: 'Home', notifId: 2 }),
      seed({ id: 'c', name: 'Loose end', notifId: 3 })
    ]);
    const d = w.document;
    const pending = () => d.querySelectorAll('#pendingList [data-card]').length;

    t.check('drawer lists All, Uncategorised and both categories',
      d.querySelectorAll('#drawerList .drawer-item').length, 4);
    t.check('rows are sorted after All and Uncategorised',
      d.querySelectorAll('#drawerList .drawer-item-label')[2].textContent, 'Home');

    w.__todo.setCategoryFilter('Work');
    t.check('filter narrows to one task', pending(), 1);
    t.check('filter pill is shown', d.getElementById('filterBar').hidden, 'false');
    t.check('pill names the category', d.getElementById('filterLabel').textContent, 'Work');

    w.__todo.setCategoryFilter('');
    t.check('the uncategorised filter works too', pending(), 1);
    t.check('pill says Uncategorised', d.getElementById('filterLabel').textContent, 'Uncategorised');

    w.__todo.setCategoryFilter('Work');
    w.__todo.setSearch('milk');
    t.check('search and category compose rather than override', pending(), 0);

    w.__todo.setSearch('');
    // The first drawer row is "All tasks".
    d.querySelector('#drawerList .drawer-item').click();
    t.check('All clears the filter', pending(), 3);
    t.check('and hides the pill', d.getElementById('filterBar').hidden, 'true');
    t.check('filter state really is cleared', String(w.__todo.getCategoryFilter()), 'null');
  }

  /* ─────────────────────────────────────────────────────────────
     The document store
     ───────────────────────────────────────────────────────────── */

  t.section('migration off the pre-document keys');
  {
    const { w, bridge } = await boot('granted', undefined, () => {}, (win) => {
      win.localStorage.setItem('todo.tasks.v1', JSON.stringify([
        seed({ id: 'a', name: 'Carried over', category: 'Work', notifId: 7 })
      ]));
      win.localStorage.setItem('todo.categories.v1', JSON.stringify(['Work', 'Home']));
      win.localStorage.setItem('todo.notifSeq.v1', '7');
    });

    t.check('the task came across', w.__todo.getTasks()[0].name, 'Carried over');
    // "Home" was in the old standalone list but on no task, so it does not
    // survive a store that derives categories from the tasks.
    t.check('only the category a task carries came across',
      w.__todo.getCategories().join(','), 'Work');

    const doc = docOf(bridge);
    t.check('a document was written', doc.version, 2);
    t.check('with the task in it', doc.tasks.length, 1);
    t.check('and the counter', doc.notifSeq, 7);

    t.check('old task key cleared', w.localStorage.getItem('todo.tasks.v1'), 'null');
    t.check('old category key cleared', w.localStorage.getItem('todo.categories.v1'), 'null');
    t.check('old counter key cleared', w.localStorage.getItem('todo.notifSeq.v1'), 'null');
  }

  t.section('a lost counter does not recycle notifIds');
  {
    // todo.notifSeq.v1 missing, but the tasks carry ids — the migration has to
    // start above the highest of them or the next task collides with one.
    const { w } = await boot('granted', [seed({ id: 'a', name: 'A', notifId: 42 })]);
    addTask(w, 'B', t2, '09:00');
    await settle();
    const ids = w.__todo.getTasks().map((x) => x.notifId);
    t.check('the new id clears the stored one', ids[1] > 42, 'true');
  }

  t.section('an existing document wins over stale legacy keys');
  {
    // The keys should already have been cleared, but a partial backup restore
    // can bring them back. Re-migrating would revert the user's recent work.
    const { w, bridge } = await boot(
      'granted',
      [seed({ id: 'stale', name: 'Old copy' })],
      (b) => {
        b.__doc = JSON.stringify({
          version: 2, notifSeq: 3,
          tasks: [seed({ id: 'live', name: 'Current copy', notifId: 3 })]
        });
      }
    );

    t.check('only the document was loaded', w.__todo.getTasks().length, 1);
    t.check('and it is the current copy', w.__todo.getTasks()[0].name, 'Current copy');
    t.check('the document was not overwritten', docOf(bridge).tasks[0].name, 'Current copy');
    t.check('nothing was written at all', bridge.__calls.write, 0);
  }

  t.section('a v1 document is rewritten once to drop its category list');
  {
    const { w, bridge } = await boot('granted', undefined, (b) => {
      b.__doc = JSON.stringify({
        version: 1, notifSeq: 3, categories: ['Work', 'Ghost'],
        tasks: [seed({ id: 'a', name: 'Kept', category: 'Work', notifId: 3 })]
      });
    });

    t.check('the task survived the upgrade', w.__todo.getTasks()[0].name, 'Kept');
    t.check('a category with a task is still offered',
      w.__todo.getCategories().join(','), 'Work');

    const doc = docOf(bridge);
    t.check('the document was rewritten', bridge.__calls.write, 1);
    t.check('at the new version', doc.version, 2);
    t.check('with the stored list gone',
      Object.prototype.hasOwnProperty.call(doc, 'categories'), 'false');
  }

  t.section('export through the system picker');
  {
    const { w, bridge } = await boot('granted', [seed({ id: 'a', name: 'Ship it', notifId: 1 })]);
    w.document.getElementById('exportBtn').click();
    await settle();

    t.check('the picker was handed one document', bridge.__export.length, 1);
    t.check('with a dated filename',
      /^todo-backup-\d{4}-\d{2}-\d{2}\.json$/.test(bridge.__export[0].name), 'true');
    const payload = JSON.parse(bridge.__export[0].value);
    t.check('carrying the task', payload.tasks[0].name, 'Ship it');
    t.check('confirmed to the user',
      w.document.querySelector('#toastRegion .toast-msg').textContent, 'Exported 1 task');
  }

  t.section('backing out of the export picker is not an error');
  {
    const { w, bridge } = await boot('granted', [seed({ id: 'a', name: 'Ship it', notifId: 1 })],
      (b) => { b.__exportSaved = false; });
    w.document.getElementById('exportBtn').click();
    await settle();
    t.check('the picker still ran', bridge.__export.length, 1);
    t.check('but nothing was announced',
      w.document.querySelectorAll('#toastRegion .toast').length, 0);
  }

  t.section('import through the system picker');
  {
    const { w, bridge } = await boot('granted', [seed({ id: 'a', name: 'Mine', notifId: 1 })],
      (b) => {
        b.__import = { value: JSON.stringify({
          app: 'todo-list', version: 1,
          tasks: [seed({ id: 'b', name: 'Theirs', notifId: 9 })]
        }) };
      });

    w.document.getElementById('importBtn').click();
    await settle();

    const buttons = [...w.document.querySelectorAll('#confirmButtons button')];
    t.check('the import dialog opened', buttons.length, 2);
    t.check('with no way to replace the list',
      buttons.map((b) => b.textContent).join(','), 'Cancel,Merge');
    buttons.find((b) => b.textContent === 'Merge').click();
    await settle();

    t.check('both tasks are present', w.__todo.getTasks().length, 2);
    t.check('and the document has them', docOf(bridge).tasks.length, 2);
  }

  t.section('backing out of the import picker changes nothing');
  {
    const { w } = await boot('granted', [seed({ id: 'a', name: 'Mine', notifId: 1 })],
      (b) => { b.__import = { cancelled: true }; });
    w.document.getElementById('importBtn').click();
    await settle();
    t.check('no dialog', w.document.getElementById('confirmOverlay').hidden, 'true');
    t.check('task list untouched', w.__todo.getTasks().length, 1);
  }

  t.section('a failing write is survivable');
  {
    const { w, bridge } = await boot('granted', [seed({ id: 'a', name: 'Mine', notifId: 1 })],
      (b) => { b.__failWrite = true; });
    addTask(w, 'Added anyway', t2, '09:00');
    await settle();

    t.check('the task is in the list', w.__todo.getTasks().length, 2);
    t.check('it rendered', w.document.querySelectorAll('#pendingList [data-card]').length > 0, 'true');
    t.check('and the failure was reported',
      /Could not save/.test(w.document.querySelector('#toastRegion .toast-msg').textContent), 'true');
    t.check('reminders were still armed', bridge.__scheduled.size > 0, 'true');
  }

  t.section('a failing read never overwrites what is stored');
  {
    // The one path that could lose everything: read fails, the app looks empty,
    // and the next mutation writes that emptiness over a good document.
    const { w, bridge } = await boot('granted', undefined, (b) => {
      b.__doc = JSON.stringify({
        version: 1, notifSeq: 1, categories: [],
        tasks: [seed({ id: 'precious', name: 'Do not lose me', notifId: 1 })]
      });
      b.__failRead = true;
    });

    t.check('the app reports the problem',
      /Could not read/.test(w.document.querySelector('#toastRegion .toast-msg').textContent), 'true');

    addTask(w, 'Typed into the void', t2, '09:00');
    await settle();

    t.check('nothing was written', bridge.__calls.write, 0);
    t.check('the stored document is intact', docOf(bridge).tasks[0].name, 'Do not lose me');

    // "Start fresh" is the deliberate way out, and it does write.
    w.document.querySelector('#toastRegion .toast-action').click();
    await settle();
    t.check('start fresh writes an empty list', docOf(bridge).tasks.length, 0);
  }
};
