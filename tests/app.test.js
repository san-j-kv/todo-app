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
  const listeners = {};
  const calls = { schedule: 0, cancel: 0, requestPermissions: 0, createChannel: 0, write: 0 };

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
      opts.notifications.forEach((n) => scheduled.set(Number(n.id), n));
      return Promise.resolve();
    },
    cancel: (opts) => {
      calls.cancel++;
      opts.notifications.forEach((n) => scheduled.delete(Number(n.id)));
      return Promise.resolve();
    }
  };

  /* Stands in for the app-local TodoStore plugin: the task document as it sits
     in getFilesDir()/tasks.json, plus the two system pickers. */
  const store = { doc: null, failRead: false, failWrite: false };
  const exported = [];
  let inbox = { cancelled: true };
  let exportSaved = true;

  const TodoStore = {
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

  return {
    isNativePlatform: () => true,
    getPlatform: () => 'android',
    Plugins: {
      LocalNotifications,
      TodoStore,
      App: { addListener: () => Promise.resolve({ remove() {} }) }
    },
    __scheduled: scheduled,
    __listeners: listeners,
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

  t.section('stale recurring series recovers after the app was closed');
  {
    const seed = [{
      id: 'old-1', name: 'Weekly review', date: iso(addDays(today, -40)), time: '09:00',
      completed: false, completedAt: null,
      recurrence: { type: 'custom', interval: 1, unit: 'week' }, notifId: 77
    }];
    const { bridge } = await boot('granted', seed);
    t.check('stale series still arms a reminder', bridge.__scheduled.size, 1);
    t.check('and it is in the future',
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

  t.section('web build still works with no Capacitor');
  {
    const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'http://localhost/' });
    const w = dom.window;
    w.localStorage.setItem('todo.tasks.v1', JSON.stringify([seed({ id: 'old', name: 'From before' })]));
    w.eval(fs.readFileSync(path.join(ROOT, 'store.js'), 'utf8'));
    w.eval(fs.readFileSync(path.join(ROOT, 'notify.js'), 'utf8'));
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
    t.check('the button shows the invented name',
      d.getElementById('categoryButtonText').textContent, 'Health');
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
