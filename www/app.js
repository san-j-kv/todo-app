/* To Do — vanilla JS. No build step, no dependencies.

   Tasks and the notification-id counter live together in one JSON document,
   written through store.js: a real file in private storage on Android,
   localStorage in a browser. Categories are derived from the tasks and are
   not stored. The three keys below are the pre-document layout, read once
   during migration and then cleared. */
(function () {
  'use strict';

  var LEGACY_TASKS_KEY = 'todo.tasks.v1';
  var LEGACY_SEQ_KEY = 'todo.notifSeq.v1';
  var LEGACY_CATEGORIES_KEY = 'todo.categories.v1';
  var DOC_VERSION = 2; // 2 dropped the stored category list — see Categories below
  var DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  var TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
  var UNITS = ['day', 'week', 'month', 'year'];
  var MAX_ROLL = 500;
  var MAX_CATEGORY = 40;
  var NEW_CATEGORY = '__new';

  var $ = function (id) { return document.getElementById(id); };

  /* ─────────────────────────────────────────────────────────────
     Dates

     Never `new Date("2026-08-13")` — that parses as UTC and can land
     on the previous day in local time. Always build from parts.
     ───────────────────────────────────────────────────────────── */

  function parseLocal(iso) {
    if (!DATE_RE.test(iso || '')) return null;
    var p = iso.split('-').map(Number);
    var dt = new Date(p[0], p[1] - 1, p[2]);
    // rejects real-looking but impossible dates, e.g. 2026-02-30
    if (dt.getFullYear() !== p[0] || dt.getMonth() !== p[1] - 1 || dt.getDate() !== p[2]) return null;
    return dt;
  }

  function toISO(dt) {
    var m = String(dt.getMonth() + 1).padStart(2, '0');
    var d = String(dt.getDate()).padStart(2, '0');
    return dt.getFullYear() + '-' + m + '-' + d;
  }

  function dayName(iso) {
    var dt = parseLocal(iso);
    return dt ? dt.toLocaleDateString(undefined, { weekday: 'long' }) : '';
  }

  function addDays(dt, n) {
    var t = new Date(dt.getTime());
    t.setDate(t.getDate() + n);
    return t;
  }

  // Clamps to the last day of the target month: Jan 31 + 1 month → Feb 28.
  function addMonths(dt, n) {
    var day = dt.getDate();
    var t = new Date(dt.getFullYear(), dt.getMonth() + n, 1);
    var lastDay = new Date(t.getFullYear(), t.getMonth() + 1, 0).getDate();
    t.setDate(Math.min(day, lastDay));
    return t;
  }

  // Milliseconds for a date+time pair; a missing time means "end of that day".
  function msFor(iso, time) {
    var dt = parseLocal(iso);
    if (!dt) return Infinity;
    if (TIME_RE.test(time || '')) {
      var p = time.split(':').map(Number);
      dt.setHours(p[0], p[1], 0, 0);
    } else {
      dt.setHours(23, 59, 59, 999);
    }
    return dt.getTime();
  }

  function taskMs(task) { return msFor(task.date, task.time); }

  function startOfToday() {
    var n = new Date();
    return new Date(n.getFullYear(), n.getMonth(), n.getDate());
  }

  function formatDate(iso) {
    var dt = parseLocal(iso);
    if (!dt) return '';
    var opts = { weekday: 'long', day: 'numeric', month: 'short' };
    if (dt.getFullYear() !== new Date().getFullYear()) opts.year = 'numeric';
    return dt.toLocaleDateString(undefined, opts);
  }

  function formatTime(time) {
    if (!TIME_RE.test(time || '')) return '';
    var p = time.split(':').map(Number);
    return new Date(2000, 0, 1, p[0], p[1])
      .toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  }

  function relativeLabel(iso) {
    var dt = parseLocal(iso);
    if (!dt) return '';
    var diff = Math.round((dt - startOfToday()) / 86400000);
    if (diff === 0) return 'Today';
    if (diff === 1) return 'Tomorrow';
    return '';
  }

  /* ─────────────────────────────────────────────────────────────
     Recurrence
     ───────────────────────────────────────────────────────────── */

  function describeRecurrence(rule) {
    if (!rule) return '';
    if (rule.type === 'workweek') return 'Mon–Fri';
    if (rule.type === 'custom') {
      var unit = rule.interval === 1 ? rule.unit : rule.unit + 's';
      return rule.interval === 1 ? 'Every ' + unit : 'Every ' + rule.interval + ' ' + unit;
    }
    return '';
  }

  function nextOccurrence(iso, rule) {
    var dt = parseLocal(iso);
    if (!dt || !rule) return null;

    if (rule.type === 'workweek') {
      var next = addDays(dt, 1);
      while (next.getDay() === 0 || next.getDay() === 6) next = addDays(next, 1); // skip Sun/Sat
      return toISO(next);
    }

    if (rule.type === 'custom') {
      var n = rule.interval;
      if (rule.unit === 'day') return toISO(addDays(dt, n));
      if (rule.unit === 'week') return toISO(addDays(dt, n * 7));
      if (rule.unit === 'month') return toISO(addMonths(dt, n));
      if (rule.unit === 'year') return toISO(addMonths(dt, n * 12));
    }
    return null;
  }

  /* When a reminder for this date+time would fire, in notify.js's terms rather
     than msFor()'s — a missing time means 08:00, not end of day. Asked of
     notify.js itself so the two can't drift: the question being settled is
     "has this occurrence's reminder already gone?", and only notify.js gets to
     define that. */
  function reminderMs(date, time) {
    if (window.TodoNotify && TodoNotify.notifyMsFor) return TodoNotify.notifyMsFor(date, time);
    return msFor(date, time);
  }

  /* Where a recurring series should start when it is given a time already
     behind us. Adding "daily 09:00" at 16:00 means "from the next one", not
     "you have already missed today" — no reminder ever existed for that slot.

     Only saveTask() calls this, and that is the whole design: a genuinely
     missed occurrence is one nothing has touched, so it keeps its date, shows
     as overdue and arms nothing until it is completed. Rolling it forward
     anywhere else would be the app deciding to skip an occurrence on the
     user's behalf, which is what nextFutureMs() used to do. */
  function startOccurrence(date, time, rule) {
    if (!date || !rule) return date;
    for (var i = 0; i < MAX_ROLL; i++) {
      var ms = reminderMs(date, time);
      if (ms === null || ms > Date.now()) return date;
      var next = nextOccurrence(date, rule);
      if (!next) return date;
      date = next;
    }
    return date;
  }

  // Advance past "now" so a task left unchecked for weeks doesn't roll
  // forward into another past date.
  function rollForward(task) {
    var iso = task.date;
    var now = Date.now();
    for (var i = 0; i < MAX_ROLL; i++) {
      var next = nextOccurrence(iso, task.recurrence);
      if (!next) return null;
      iso = next;
      if (msFor(iso, task.time) > now) break;
    }
    return iso;
  }

  /* ─────────────────────────────────────────────────────────────
     Model + storage
     ───────────────────────────────────────────────────────────── */

  var tasks = [];

  function uid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  }

  /* Notification ids must be numbers that fit a Java 32-bit int, so the UUID
     above can't serve. A persisted counter gives every task a stable id we can
     cancel and reschedule by, with no risk of hash collisions. */
  var notifSeq = 0;
  var docDirty = false;

  /* The counter rides in the document rather than in its own key, so handing
     out an id is pure in-memory work. That is what lets this stay synchronous
     with an async store behind it — normalizeTask() calls it, and normalizeTask
     is on the __todo surface and inside the import path. */
  function nextNotifId() {
    notifSeq = notifSeq >= 2147483000 ? 1 : notifSeq + 1;
    return notifSeq;
  }

  function normalizeRecurrence(r) {
    if (!r || typeof r !== 'object') return null;
    if (r.type === 'workweek') return { type: 'workweek' };
    if (r.type === 'custom') {
      var n = Math.floor(Number(r.interval));
      if (!isFinite(n) || n < 1 || n > 99) return null;
      if (UNITS.indexOf(r.unit) === -1) return null;
      return { type: 'custom', interval: n, unit: r.unit };
    }
    return null;
  }

  /* Rebuilds a task from known fields only — never trusts the shape of
     stored or imported data. Returns null if it can't be salvaged. */
  function normalizeTask(raw, seenIds) {
    if (!raw || typeof raw !== 'object') return null;
    var name = typeof raw.name === 'string' ? raw.name.trim().slice(0, 120) : '';
    if (!name) return null;

    var date = parseLocal(raw.date) ? raw.date : '';
    var time = TIME_RE.test(raw.time || '') ? raw.time : '';
    var rule = normalizeRecurrence(raw.recurrence);
    if (rule && !date) rule = null; // a recurrence needs an anchor date

    var id = typeof raw.id === 'string' && raw.id ? raw.id : uid();
    if (seenIds) {
      if (seenIds[id]) id = uid();
      seenIds[id] = true;
    }

    // Assigned here rather than only on create, so tasks stored before
    // reminders existed — and tasks arriving from an import — get one too.
    var notifId = raw.notifId;
    if (typeof notifId !== 'number' || !isFinite(notifId) || notifId <= 0) {
      notifId = nextNotifId();
      docDirty = true;
    }

    return {
      id: id,
      name: name,
      date: date,
      time: time,
      day: date ? dayName(date) : '',
      category: cleanCategory(raw.category),
      completed: raw.completed === true,
      completedAt: typeof raw.completedAt === 'string' ? raw.completedAt : null,
      recurrence: rule,
      notifId: notifId
    };
  }

  /* ─────────────────────────────────────────────────────────────
     The document

     The tasks and the notification counter are written whole, as one object.
     Reading it is asynchronous, and two things follow from that.

     Nothing may assume `tasks` is populated before load() resolves — the boot
     chain at the bottom of this file is the only place that assumption holds.

     And a read that fails must not fall through to "start empty". The next
     save() would write that emptiness straight over a file that is still
     perfectly good, which is the one way this app could lose everything.
     loadFailed latches instead and save() stops writing until the user picks
     a way out.
     ───────────────────────────────────────────────────────────── */

  var loadFailed = false;
  var migrated = false;
  var writeQueue = Promise.resolve(true);
  var pendingText = null;

  function store() {
    if (!window.TodoStore) throw new Error('store.js did not load');
    return window.TodoStore;
  }

  function serialize() {
    return JSON.stringify({
      version: DOC_VERSION,
      notifSeq: notifSeq,
      tasks: tasks,
      updatedAt: new Date().toISOString()
    });
  }

  function applyDoc(data) {
    // Ids handed out before the document landed — __todo.normalizeTask() and
    // parseBackup() are both reachable during the read — must not be reissued.
    notifSeq = Math.max(notifSeq, Number(data.notifSeq) || 0);

    var arrived = tasks; // anything added while the read was still in flight
    var raw = Array.isArray(data.tasks) ? data.tasks : [];
    var seen = {};
    tasks = raw.map(function (t) { return normalizeTask(t, seen); })
               .filter(Boolean)
               .concat(arrived);
    dedupeNotifIds();

    // An imported backup can carry two spellings of the same category on
    // different tasks, since it was written by a device that folded them
    // against its own list. Settle them onto one spelling here — in place, so
    // that later tasks fold onto the first one seen.
    tasks.forEach(function (t) {
      var canon = canonicalCategory(t.category);
      if (canon !== t.category) { t.category = canon; docDirty = true; }
    });

    // A document written before categories became a projection of the tasks
    // still carries its own list. Nothing reads it now, so rewrite once to
    // drop it rather than leaving a field that looks meaningful and isn't.
    if (Number(data.version) !== DOC_VERSION) docDirty = true;
  }

  /* The pre-document layout: three independent keys, which could already
     disagree with each other if a crash landed between two setItem calls.
     Read once; the boot chain clears them after the document is safely down. */
  function readLegacy() {
    var raw = null;
    try { raw = localStorage.getItem(LEGACY_TASKS_KEY); } catch (err) { raw = null; }
    if (raw === null) return null;

    // todo.categories.v1 is deliberately not read: categories are a projection
    // of the tasks now, so one that no surviving task carries is one the user
    // has already stopped using. It still gets cleared with the rest.
    var doc = { notifSeq: 0, tasks: [] };

    try { doc.tasks = JSON.parse(raw); } catch (err) { doc.tasks = []; }
    if (!Array.isArray(doc.tasks)) doc.tasks = [];

    var seq = 0;
    try { seq = parseInt(localStorage.getItem(LEGACY_SEQ_KEY), 10); } catch (err) { seq = 0; }
    if (!isFinite(seq) || seq < 0) seq = 0;

    // A lost counter used to mean silent notifId collisions. Every id in the
    // list is visible right here, so start above the highest of them.
    doc.tasks.forEach(function (t) {
      var n = t ? Number(t.notifId) : 0;
      if (isFinite(n) && n > seq) seq = n;
    });
    doc.notifSeq = seq;

    return doc;
  }

  function clearLegacyKeys() {
    try {
      localStorage.removeItem(LEGACY_TASKS_KEY);
      localStorage.removeItem(LEGACY_SEQ_KEY);
      localStorage.removeItem(LEGACY_CATEGORIES_KEY);
    } catch (err) { /* nothing at stake — the document is already written */ }
  }

  // Resolves once the list is ready to render. Never rejects.
  function load() {
    var reading;
    try {
      reading = store().read();
    } catch (err) {
      reading = Promise.reject(err);
    }

    return reading.then(function (text) {
      if (text === null) {
        var legacy = readLegacy();
        if (!legacy) return; // first run — nothing stored anywhere
        migrated = true;
        applyDoc(legacy);
        return;
      }
      applyDoc(JSON.parse(text));
    }).catch(function () {
      loadFailed = true;
      toast('Could not read your saved tasks.', {
        type: 'error',
        duration: 10000,
        action: { label: 'Start fresh', onClick: startFresh }
      });
    });
  }

  /* Re-reads the document after something outside the WebView wrote it. The
     "Mark done" receiver is the only such writer: it completes the task, rolls
     a recurring one forward and arms the next reminder, all while the app is
     closed or in the background.

     applyDoc() is deliberately not reused. It *concatenates* the in-memory list
     onto what it read, which is right on boot — ids handed out while the read
     was in flight must survive — and wrong here, where the stored document is
     the newer copy and the in-memory one is what's stale.

     Silent by design: it repaints rather than toasting. The user marked the
     task done from the notification and already knows.

     Resolves true when the list was actually replaced. */
  function reloadFromStore() {
    // A remembered read failure must not be walked back into, and a write still
    // in flight is newer than anything on disk.
    if (loadFailed || pendingText !== null) return Promise.resolve(false);

    var reading;
    try {
      reading = store().read();
    } catch (err) {
      return Promise.resolve(false);
    }

    return reading.then(function (text) {
      if (typeof text !== 'string') return false;

      var data = JSON.parse(text);
      var raw = Array.isArray(data.tasks) ? data.tasks : [];
      var seen = {};

      // The receiver mints notifIds from the same counter; take the higher.
      notifSeq = Math.max(notifSeq, Number(data.notifSeq) || 0);
      tasks = raw.map(function (t) { return normalizeTask(t, seen); }).filter(Boolean);

      render();
      if (window.TodoNotify) TodoNotify.resync();
      return true;
    }).catch(function () {
      // Unreadable or unparseable: keep showing the list we already have.
      return false;
    });
  }

  // The only way out of loadFailed, and deliberately a decision the user makes:
  // it writes an empty list over whatever is down there.
  function startFresh() {
    loadFailed = false;
    tasks = [];
    commit();
  }

  /* Writes queue rather than race, so they can't land out of order, and any
     two saves made in the same tick collapse into a single write of the later
     state. The queue is reassigned to the *caught* promise, so a single
     failure neither poisons every later write nor escapes as an unhandled
     rejection from the ten fire-and-forget commit() call sites. */
  function persist() {
    if (loadFailed) return Promise.resolve(false);

    pendingText = serialize();
    writeQueue = writeQueue.then(function () {
      // Null means a job queued after this one already wrote the state this one
      // was going to write. Don't null it in the catch below: a newer persist()
      // may have filled it in while this write was still in flight.
      if (pendingText === null) return true;
      var text = pendingText;
      pendingText = null;
      return store().write(text).then(function () { return true; });
    }).catch(function () {
      toast('Could not save — storage is full or unavailable.', { type: 'error' });
      return false;
    });

    return writeQueue;
  }

  /* Persist, then put reminders back in step. Every task mutation — add, edit,
     complete, delete, recurring roll-forward, import — funnels through here, so
     one call covers both.

     sync() stays in this tick rather than moving behind the write: it reads the
     in-memory list, which is already current, and two sync() calls racing in
     one tick would each diff against the same pending set and schedule the same
     reminder twice. That is also why adding a category calls persist() and not
     this — a category can't change a reminder. */
  function save() {
    var written = persist();
    if (window.TodoNotify) TodoNotify.sync(tasks);
    return written;
  }

  function commit() { save(); render(); }

  // Same as commit(), but lets the checkbox tick animation finish before the
  // card is re-rendered away into the Completed section.
  function commitAfterCheck() { save(); setTimeout(render, 260); }

  /* Clears a banner this task has already posted. Deliberately separate from
     save() → sync(): sync() only ever sees reminders that are still *pending*,
     and a notification stops being pending the moment it fires, so the three
     mutations that call this are the only chance to get a stale banner out of
     the shade. Fire and forget — TodoNotify.dismiss swallows its own errors. */
  function dismissBanner(id) {
    if (window.TodoNotify && TodoNotify.dismiss) TodoNotify.dismiss(id);
  }

  /* A backup carries the notifIds of the device it came from, so a merge can
     land one that a local task is already using — and since the notification
     id is the cancel/reschedule handle, the collision would silently drop one
     of the two reminders. Reassign the duplicates. */
  function dedupeNotifIds() {
    var seen = {};
    tasks.forEach(function (t) {
      if (seen[t.notifId]) { t.notifId = nextNotifId(); docDirty = true; }
      seen[t.notifId] = true;
    });
  }

  function findTask(id) {
    for (var i = 0; i < tasks.length; i++) if (tasks[i].id === id) return tasks[i];
    return null;
  }

  /* ─────────────────────────────────────────────────────────────
     Categories

     A projection of the task list, not a list of its own: a category exists
     for exactly as long as some task still carries it — pending or completed
     — and the last such task leaving takes the category with it. A task
     stores the category name itself rather than an id, so there is nothing
     to keep in step and nothing that can drift.

     The cost is that a category cannot outlive its tasks, so inventing one
     only sticks if the task holding it is saved. Both places that offer to
     create a category attach it to a task in the same breath, so that is
     never a half-finished state the user can see.
     ───────────────────────────────────────────────────────────── */

  function cleanCategory(value) {
    return typeof value === 'string' ? value.trim().slice(0, MAX_CATEGORY) : '';
  }

  /* Folds case variants together, so "work" typed later doesn't end up
     sitting beside an existing "Work". Returns the canonical spelling to
     store on the task, or '' for uncategorised. First spelling in the list
     wins, which is why the load-time pass below rewrites in place. */
  function canonicalCategory(value) {
    var name = cleanCategory(value);
    if (!name) return '';
    var lower = name.toLowerCase();
    for (var i = 0; i < tasks.length; i++) {
      var known = tasks[i].category;
      if (known && known.toLowerCase() === lower) return known;
    }
    return name;
  }

  function allCategories() {
    var seen = {};
    var names = [];
    tasks.forEach(function (t) {
      var name = t.category;
      if (!name) return; // '' is uncategorised, offered separately
      var lower = name.toLowerCase();
      if (seen[lower]) return;
      seen[lower] = true;
      names.push(name);
    });
    return names.sort(function (a, b) {
      return a.toLowerCase().localeCompare(b.toLowerCase());
    });
  }

  /* ─────────────────────────────────────────────────────────────
     Tiny DOM helpers
     ───────────────────────────────────────────────────────────── */

  var SVG_NS = 'http://www.w3.org/2000/svg';

  function h(tag, attrs, children) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        var v = attrs[k];
        if (v === null || v === undefined || v === false) return;
        if (k === 'text') node.textContent = v;
        else if (k === 'class') node.className = v;
        else node.setAttribute(k, v === true ? '' : v);
      });
    }
    (children || []).forEach(function (c) { if (c) node.appendChild(c); });
    return node;
  }

  function icon(id) {
    var svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', 'icon');
    svg.setAttribute('aria-hidden', 'true');
    var use = document.createElementNS(SVG_NS, 'use');
    use.setAttribute('href', '#' + id);
    svg.appendChild(use);
    return svg;
  }

  function checkMark() {
    var svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    var path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', 'm5 12.5 4.5 4.5L19 7.5');
    svg.appendChild(path);
    return svg;
  }

  function metaItem(iconId, label) {
    return h('span', {}, [icon(iconId), h('span', { text: label })]);
  }

  /* ─────────────────────────────────────────────────────────────
     Rendering
     ───────────────────────────────────────────────────────────── */

  var completedOpen = false;
  var searchQuery = '';          // already trimmed + lowercased
  var categoryFilter = null;     // null = all, '' = uncategorised, else a name

  function filtersActive() {
    return searchQuery !== '' || categoryFilter !== null;
  }

  function matchesFilters(task) {
    if (categoryFilter !== null && task.category !== categoryFilter) return false;
    if (!searchQuery) return true;
    return task.name.toLowerCase().indexOf(searchQuery) !== -1 ||
           task.category.toLowerCase().indexOf(searchQuery) !== -1;
  }

  function buildCard(task) {
    var overdue = !task.completed && taskMs(task) < Date.now();

    var cbInput = h('input', { type: 'checkbox', 'data-id': task.id, 'aria-label': 'Mark "' + task.name + '" complete' });
    cbInput.checked = task.completed;
    var checkbox = h('label', { class: 'check', 'data-stop': true }, [
      cbInput,
      h('span', { class: 'box' }, [checkMark()])
    ]);

    var meta = h('div', { class: 'meta' });
    if (task.date) {
      meta.appendChild(metaItem('i-calendar', formatDate(task.date)));
    }
    if (task.time) {
      meta.appendChild(metaItem('i-clock', formatTime(task.time)));
    }
    if (!task.date && !task.time) {
      meta.appendChild(h('span', { text: 'No date set' }));
    }

    if (!task.completed && overdue) {
      meta.appendChild(h('span', { class: 'chip chip-warn' }, [icon('i-alert'), h('span', { text: 'Overdue' })]));
    } else if (!task.completed) {
      var rel = relativeLabel(task.date);
      if (rel) meta.appendChild(h('span', { class: 'chip', text: rel }));
    }

    if (task.recurrence) {
      meta.appendChild(h('span', { class: 'chip' }, [icon('i-repeat'), h('span', { text: describeRecurrence(task.recurrence) })]));
    }

    // data-stop keeps this tap out of handleCardActivate() — it opens the
    // category picker, not the edit sheet.
    meta.appendChild(h('button', {
      class: 'chip chip-cat' + (task.category ? '' : ' chip-cat-empty'),
      type: 'button',
      'data-stop': true,
      'data-cat': task.id,
      'aria-label': 'Category: ' + (task.category || 'Uncategorised') + '. Change category for "' + task.name + '"'
    }, [icon('i-tag'), h('span', { text: task.category || 'Uncategorised' })]));

    var del = h('button', { class: 'del', type: 'button', 'data-stop': true, 'data-del': task.id, 'aria-label': 'Delete "' + task.name + '"' }, [icon('i-trash')]);

    var cls = 'card' + (task.completed ? ' done' : '') + (overdue ? ' overdue' : '');
    return h('div', { class: cls, 'data-card': task.id, tabindex: '0', role: 'listitem' }, [
      checkbox,
      h('div', { class: 'card-body' }, [h('p', { class: 'card-name', text: task.name }), meta]),
      del
    ]);
  }

  function render() {
    var visible = tasks.filter(matchesFilters);

    var pending = visible.filter(function (t) { return !t.completed; })
      .sort(function (a, b) {
        var d = taskMs(a) - taskMs(b);
        if (d) return d;
        return a.name.localeCompare(b.name);
      });

    var done = visible.filter(function (t) { return t.completed; })
      .sort(function (a, b) {
        return String(b.completedAt || '').localeCompare(String(a.completedAt || ''));
      });

    var pendingList = $('pendingList');
    var completedList = $('completedList');
    pendingList.textContent = '';
    completedList.textContent = '';
    pending.forEach(function (t) { pendingList.appendChild(buildCard(t)); });
    done.forEach(function (t) { completedList.appendChild(buildCard(t)); });

    $('pendingSection').hidden = pending.length === 0;
    $('completedSection').hidden = done.length === 0;
    $('pendingCount').textContent = pending.length;
    $('completedCount').textContent = done.length;

    // Two different nothings: an empty app invites you to add a task, an
    // empty filter result must not — that would read as data loss.
    $('emptyState').hidden = tasks.length !== 0;
    $('noResults').hidden = !(tasks.length > 0 && visible.length === 0);
    if (!$('noResults').hidden) {
      $('noResultsText').textContent = searchQuery
        ? 'Nothing matches “' + $('searchInput').value.trim() + '”.'
        : 'Nothing in this category yet.';
    }

    // Nothing to search until there is something to search through.
    $('searchRow').hidden = tasks.length === 0;

    // Completed is collapsed by default, which would hide the only hits for
    // a search. Force it open while searching without touching the toggle's
    // own state, so it springs back to the user's choice afterwards.
    var showCompleted = completedOpen || searchQuery !== '';
    completedList.hidden = !showCompleted;
    $('completedToggle').setAttribute('aria-expanded', String(showCompleted));

    renderFilterBar();
    renderDrawer();

    var summary;
    if (filtersActive()) {
      summary = 'Showing ' + visible.length + ' of ' + tasks.length;
    } else {
      var overdue = pending.filter(function (t) { return taskMs(t) < Date.now(); }).length;
      summary = pending.length === 0
        ? (tasks.length ? 'All caught up' : 'Nothing scheduled')
        : pending.length + (pending.length === 1 ? ' task pending' : ' tasks pending') +
          (overdue ? ' · ' + overdue + ' overdue' : '');
    }
    $('summary').textContent = summary;
  }

  function renderFilterBar() {
    $('filterBar').hidden = categoryFilter === null;
    if (categoryFilter !== null) {
      $('filterLabel').textContent = categoryFilter || 'Uncategorised';
    }
  }

  /* ─────────────────────────────────────────────────────────────
     Category filter drawer

     Deliberately not routed through openModal/closeModal — those toggle the
     .overlay/.stacked/.closing classes that belong to the centred sheets and
     would fight the slide-in.
     ───────────────────────────────────────────────────────────── */

  var drawerReturn = null;

  function drawerRow(value, label, count) {
    var active = categoryFilter === value;
    var row = h('button', {
      class: 'drawer-item' + (active ? ' active' : ''),
      type: 'button',
      'aria-current': active ? 'true' : null
    }, [
      icon(value === null ? 'i-menu' : 'i-tag'),
      h('span', { class: 'drawer-item-label', text: label }),
      h('span', { class: 'count', text: String(count) })
    ]);
    // Rebuilt on every render, so the listener dies with the node — no
    // delegation, and no encoding null-vs-'' into a data attribute.
    row.addEventListener('click', function () {
      categoryFilter = value;
      closeDrawer();
      render();
    });
    return row;
  }

  function renderDrawer() {
    var list = $('drawerList');
    list.textContent = '';

    var loose = tasks.filter(function (t) { return !t.category; }).length;

    list.appendChild(drawerRow(null, 'All tasks', tasks.length));
    if (loose) list.appendChild(drawerRow('', 'Uncategorised', loose));

    allCategories().forEach(function (name) {
      var count = tasks.filter(function (t) { return t.category === name; }).length;
      list.appendChild(drawerRow(name, name, count));
    });
  }

  function drawerIsOpen() {
    return document.body.classList.contains('drawer-open');
  }

  function openDrawer() {
    if (drawerIsOpen()) return;
    setMenu(false);
    renderDrawer();
    $('drawerScrim').hidden = false;
    $('drawer').hidden = false;
    // Force layout so the transform transition starts from the off-screen
    // value rather than being collapsed into the same frame as the unhide.
    void $('drawer').offsetWidth;
    document.body.classList.add('drawer-open');
    $('drawerBtn').setAttribute('aria-expanded', 'true');

    drawerReturn = document.activeElement;
    var first = $('drawer').querySelector(FOCUSABLE);
    if (first) setTimeout(function () { first.focus(); }, 20);
  }

  function closeDrawer() {
    if (!drawerIsOpen()) return;
    document.body.classList.remove('drawer-open');
    $('drawerBtn').setAttribute('aria-expanded', 'false');

    setTimeout(function () {
      if (drawerIsOpen()) return; // reopened mid-animation
      $('drawer').hidden = true;
      $('drawerScrim').hidden = true;
    }, 220);

    if (drawerReturn && drawerReturn.focus) drawerReturn.focus();
    drawerReturn = null;
  }

  /* ─────────────────────────────────────────────────────────────
     Toasts
     ───────────────────────────────────────────────────────────── */

  function toast(message, opts) {
    opts = opts || {};
    var node = h('div', { class: 'toast' + (opts.type === 'error' ? ' error' : '') });
    if (opts.type === 'error') node.appendChild(icon('i-alert'));
    node.appendChild(h('span', { class: 'toast-msg', text: message }));

    var timer;
    function dismiss() {
      clearTimeout(timer);
      if (!node.parentNode) return;
      node.classList.add('leaving');
      setTimeout(function () { if (node.parentNode) node.parentNode.removeChild(node); }, 200);
    }

    if (opts.action) {
      var btn = h('button', { class: 'toast-action', type: 'button', text: opts.action.label });
      btn.addEventListener('click', function () { dismiss(); opts.action.onClick(); });
      node.appendChild(btn);
    }

    $('toastRegion').appendChild(node);
    timer = setTimeout(dismiss, opts.duration || (opts.action ? 6000 : 3200));
    return dismiss;
  }

  /* ─────────────────────────────────────────────────────────────
     Modal plumbing — focus trap, Esc, scroll lock, stacking
     ───────────────────────────────────────────────────────────── */

  var FOCUSABLE = 'button, [href], input:not([type="hidden"]), select, textarea, [tabindex]:not([tabindex="-1"])';
  var stack = [];

  function openModal(overlay, onEscape) {
    stack.push({ overlay: overlay, onEscape: onEscape, returnTo: document.activeElement });
    overlay.classList.toggle('stacked', stack.length > 1);
    overlay.classList.remove('closing');
    overlay.hidden = false;
    document.body.style.overflow = 'hidden';

    var first = overlay.querySelector(FOCUSABLE);
    if (first) setTimeout(function () { first.focus(); }, 20);
  }

  function closeModal(overlay) {
    var idx = -1;
    for (var i = 0; i < stack.length; i++) if (stack[i].overlay === overlay) idx = i;
    if (idx === -1) return;
    var entry = stack.splice(idx, 1)[0];

    overlay.classList.add('closing');
    setTimeout(function () {
      // openModal() clears 'closing' — if it's gone, the dialog was reopened.
      if (!overlay.classList.contains('closing')) return;
      overlay.hidden = true;
      overlay.classList.remove('closing', 'stacked');
    }, 150);

    if (!stack.length) document.body.style.overflow = '';
    if (entry.returnTo && entry.returnTo.focus) entry.returnTo.focus();
  }

  document.addEventListener('keydown', function (e) {
    if (!stack.length) return;
    var top = stack[stack.length - 1];

    if (e.key === 'Escape') {
      e.preventDefault();
      top.onEscape ? top.onEscape() : closeModal(top.overlay);
      return;
    }

    if (e.key === 'Tab') {
      var items = Array.prototype.filter.call(
        top.overlay.querySelectorAll(FOCUSABLE),
        function (el) { return el.offsetParent !== null && !el.disabled; }
      );
      if (!items.length) return;
      var first = items[0];
      var last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  });

  // Backdrop click closes the topmost dialog.
  ['taskOverlay', 'repeatOverlay', 'confirmOverlay', 'categoryOverlay'].forEach(function (id) {
    $(id).addEventListener('mousedown', function (e) {
      if (e.target !== this || !stack.length) return;
      var top = stack[stack.length - 1];
      if (top.overlay !== this) return;
      top.onEscape ? top.onEscape() : closeModal(this);
    });
  });

  /* ─────────────────────────────────────────────────────────────
     Confirm / choice dialog (also used by import)
     ───────────────────────────────────────────────────────────── */

  function confirmDialog(options) {
    return new Promise(function (resolve) {
      var overlay = $('confirmOverlay');
      $('confirmTitle').textContent = options.title;
      $('confirmText').textContent = options.text;

      var foot = $('confirmButtons');
      foot.textContent = '';

      function finish(value) { closeModal(overlay); resolve(value); }

      options.buttons.forEach(function (spec) {
        var btn = h('button', { class: 'btn ' + (spec.variant || 'btn-ghost'), type: 'button', text: spec.label });
        btn.addEventListener('click', function () { finish(spec.value); });
        foot.appendChild(btn);
      });

      openModal(overlay, function () { finish(null); });
    });
  }

  /* ─────────────────────────────────────────────────────────────
     Task modal (add / edit)
     ───────────────────────────────────────────────────────────── */

  var editingId = null;
  var draftRecurrence = null;

  function updateRepeatUI() {
    var summary = $('repeatSummary');
    var text = describeRecurrence(draftRecurrence);
    summary.textContent = text;
    summary.hidden = !text;
    $('repeatToggle').checked = !!draftRecurrence;
  }

  function clearTaskErrors() {
    $('nameError').hidden = true;
    $('dateError').hidden = true;
    $('categoryError').hidden = true;
    $('nameInput').classList.remove('invalid');
    $('dateInput').classList.remove('invalid');
  }

  /* The select is rebuilt each time it opens rather than kept in step, so a
     category invented from a card chip is already there on the next edit. */
  function fillCategorySelect(selected) {
    var sel = $('categoryInput');
    var names = allCategories();
    sel.textContent = '';
    sel.appendChild(h('option', { value: '', text: 'Uncategorised' }));
    names.forEach(function (name) {
      sel.appendChild(h('option', { value: name, text: name }));
    });
    sel.appendChild(h('option', { value: NEW_CATEGORY, text: '+ New category…' }));
    sel.value = names.indexOf(selected) === -1 ? '' : selected;
    $('newCategoryInput').value = '';
    updateCategoryButton();
  }

  /* The select is never seen, so the button is what has to read correctly —
     including the not-yet-created name parked behind the NEW_CATEGORY option. */
  function formCategory() {
    var sel = $('categoryInput');
    return sel.value === NEW_CATEGORY ? $('newCategoryInput').value : sel.value;
  }

  function updateCategoryButton() {
    var name = formCategory();
    $('categoryButtonText').textContent = name || 'Uncategorised';
    $('categoryButton').classList.toggle('muted', !name);
  }

  function setFormCategory(value) {
    var sel = $('categoryInput');
    var known = Array.prototype.some.call(sel.options, function (o) {
      return o.value === value && o.value !== NEW_CATEGORY;
    });

    if (!value || known) {
      sel.value = value;
      $('newCategoryInput').value = '';
    } else {
      sel.value = NEW_CATEGORY;
      $('newCategoryInput').value = value;
    }

    $('categoryError').hidden = true;
    updateCategoryButton();
  }

  function openTaskModal(task) {
    editingId = task ? task.id : null;
    draftRecurrence = task ? task.recurrence : null;

    $('taskTitle').textContent = task ? 'Edit task' : 'New task';
    $('nameInput').value = task ? task.name : '';
    $('dateInput').value = task ? task.date : toISO(new Date());
    $('timeInput').value = task ? task.time : '';
    clearTaskErrors();
    fillCategorySelect(task ? task.category : '');
    updateRepeatUI();

    openModal($('taskOverlay'), closeTaskModal);
  }

  function closeTaskModal() {
    closeModal($('taskOverlay'));
    editingId = null;
    draftRecurrence = null;
  }

  function saveTask() {
    clearTaskErrors();

    var name = $('nameInput').value.trim();
    var date = $('dateInput').value;
    var time = $('timeInput').value;

    if (!name) {
      $('nameError').hidden = false;
      $('nameInput').classList.add('invalid');
      $('nameInput').focus();
      return;
    }
    if (date && !parseLocal(date)) {
      $('dateError').textContent = 'That date isn’t valid.';
      $('dateError').hidden = false;
      $('dateInput').classList.add('invalid');
      $('dateInput').focus();
      return;
    }
    if (draftRecurrence && !date) {
      $('dateError').textContent = 'Pick a date to repeat from.';
      $('dateError').hidden = false;
      $('dateInput').classList.add('invalid');
      $('dateInput').focus();
      return;
    }
    if (!TIME_RE.test(time || '')) time = '';

    // Saying "repeat daily at 09:00" at 16:00 starts the series tomorrow, not
    // on an occurrence that was over before the task existed.
    date = startOccurrence(date, time, draftRecurrence);

    var category = $('categoryInput').value;
    if (category === NEW_CATEGORY) {
      var typed = cleanCategory($('newCategoryInput').value);
      if (!typed) {
        $('categoryError').hidden = false;
        $('categoryButton').focus();
        return;
      }
      category = canonicalCategory(typed);
    }

    var existing = editingId ? findTask(editingId) : null;
    if (existing) {
      existing.name = name;
      existing.date = date;
      existing.time = time;
      existing.day = date ? dayName(date) : '';
      existing.category = category;
      existing.recurrence = draftRecurrence;
      /* Editing a task is an acknowledgement of it, so whatever its old
         reminder left in the shade is stale — whether or not the edit moved
         the time. Unconditional on purpose: the call is a free no-op when
         nothing fired, and diffing the old reminder time against the new one
         would need a pre-mutation snapshot plus a rule for "date cleared
         entirely", for a strictly worse-defined behaviour. Read inside this
         block: closeTaskModal() below nulls editingId. */
      dismissBanner(existing.notifId);
    } else {
      // A brand-new task has never fired anything, so nothing to dismiss —
      // which is also what keeps an unrelated add from touching the shade.
      tasks.push({
        id: uid(),
        name: name,
        date: date,
        time: time,
        day: date ? dayName(date) : '',
        category: category,
        completed: false,
        completedAt: null,
        recurrence: draftRecurrence,
        notifId: nextNotifId()
      });
    }

    closeTaskModal();
    commit();
    toast(existing ? 'Task updated' : 'Task added');
  }

  $('taskSave').addEventListener('click', saveTask);
  $('taskCancel').addEventListener('click', closeTaskModal);
  $('nameInput').addEventListener('input', function () {
    if (this.value.trim()) { $('nameError').hidden = true; this.classList.remove('invalid'); }
  });
  $('taskForm').addEventListener('submit', function (e) { e.preventDefault(); saveTask(); });
  $('nameInput').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { e.preventDefault(); saveTask(); }
  });

  /* ─────────────────────────────────────────────────────────────
     Repeat modal
     ───────────────────────────────────────────────────────────── */

  var repeatChoice = null;

  function paintRepeatOptions() {
    var opts = $('repeatOverlay').querySelectorAll('.option');
    Array.prototype.forEach.call(opts, function (btn) {
      btn.setAttribute('aria-checked', String(btn.dataset.type === repeatChoice));
    });
    $('customFields').hidden = repeatChoice !== 'custom';
  }

  function openRepeatModal() {
    var rule = draftRecurrence;
    repeatChoice = rule ? rule.type : 'workweek';
    $('intervalInput').value = rule && rule.type === 'custom' ? rule.interval : 1;
    $('unitInput').value = rule && rule.type === 'custom' ? rule.unit : 'week';
    $('intervalError').hidden = true;
    $('intervalInput').classList.remove('invalid');
    paintRepeatOptions();
    openModal($('repeatOverlay'), cancelRepeat);
  }

  function cancelRepeat() {
    closeModal($('repeatOverlay'));
    updateRepeatUI(); // snaps the switch back off if no rule was ever set
  }

  function confirmRepeat() {
    if (repeatChoice === 'custom') {
      var raw = $('intervalInput').value;
      var n = Math.floor(Number(raw));
      if (raw === '' || !isFinite(n) || n < 1 || n > 99) {
        $('intervalError').hidden = false;
        $('intervalInput').classList.add('invalid');
        $('intervalInput').focus();
        return;
      }
      draftRecurrence = { type: 'custom', interval: n, unit: $('unitInput').value };
    } else {
      draftRecurrence = { type: 'workweek' };
    }
    closeModal($('repeatOverlay'));
    updateRepeatUI();
  }

  Array.prototype.forEach.call($('repeatOverlay').querySelectorAll('.option'), function (btn) {
    btn.addEventListener('click', function () {
      repeatChoice = btn.dataset.type;
      paintRepeatOptions();
      if (repeatChoice === 'custom') $('intervalInput').focus();
    });
  });

  $('intervalInput').addEventListener('input', function () {
    $('intervalError').hidden = true;
    this.classList.remove('invalid');
  });

  $('repeatToggle').addEventListener('change', function () {
    if (this.checked) {
      openRepeatModal();
    } else {
      draftRecurrence = null;
      updateRepeatUI();
    }
  });

  $('repeatDone').addEventListener('click', confirmRepeat);
  $('repeatCancel').addEventListener('click', cancelRepeat);

  /* ─────────────────────────────────────────────────────────────
     Card interactions
     ───────────────────────────────────────────────────────────── */

  function toggleComplete(id) {
    var task = findTask(id);
    if (!task) return;

    // Un-completing dismisses nothing: no banner belongs to the newly-live
    // state, and whatever one existed went when the task was completed.
    if (task.completed) {
      task.completed = false;
      task.completedAt = null;
      commit();
      return;
    }

    // Recurring: archive this occurrence, roll the live task forward.
    if (task.recurrence && task.date) {
      var next = rollForward(task);
      if (next) {
        tasks.push({
          id: uid(),
          name: task.name,
          date: task.date,
          time: task.time,
          day: task.day,
          category: task.category,
          completed: true,
          completedAt: new Date().toISOString(),
          recurrence: null,
          notifId: nextNotifId()
        });
        // The live task keeps its notifId, so the pending reminder is simply
        // rescheduled onto the new date rather than cancelled and re-armed.
        task.date = next;
        task.day = dayName(next);
        // This occurrence's banner goes, while commitAfterCheck() re-arms the
        // same notifId for `next` in the same tick. Only a delivered-side
        // dismissal can do that — cancelling would take the new alarm with it.
        // The archived copy above needs nothing: its notifId is freshly minted
        // and was never scheduled.
        dismissBanner(task.notifId);
        commitAfterCheck();
        toast('Done — next one on ' + formatDate(next));
        return;
      }
    }

    task.completed = true;
    task.completedAt = new Date().toISOString();
    dismissBanner(task.notifId);
    commitAfterCheck();
  }

  function deleteTask(id) {
    var index = -1;
    for (var i = 0; i < tasks.length; i++) if (tasks[i].id === id) index = i;
    if (index === -1) return;

    var removed = tasks.splice(index, 1)[0];
    /* The task is gone; its banner goes with it. Undo below puts the task back
       and save() re-arms the alarm if the reminder is still ahead, but the
       banner is deliberately not restored: a banner is the record of a moment
       that has already passed, and re-posting it would announce a reminder for
       a time now behind us. If nothing had fired there was no banner to lose. */
    dismissBanner(removed.notifId);
    commit();

    toast('Deleted "' + removed.name + '"', {
      action: {
        label: 'Undo',
        onClick: function () {
          tasks.splice(Math.min(index, tasks.length), 0, removed);
          commit();
        }
      }
    });
  }

  function handleCardActivate(e) {
    var stop = e.target.closest('[data-stop]');
    if (stop) return; // checkbox or delete button — not an edit
    var card = e.target.closest('[data-card]');
    if (!card) return;
    var task = findTask(card.dataset.card);
    if (task) openTaskModal(task);
  }

  ['pendingList', 'completedList'].forEach(function (id) {
    var list = $(id);

    list.addEventListener('click', function (e) {
      var del = e.target.closest('[data-del]');
      if (del) { deleteTask(del.dataset.del); return; }
      var cat = e.target.closest('[data-cat]');
      if (cat) { openCategoryPicker(cat.dataset.cat); return; }
      handleCardActivate(e);
    });

    list.addEventListener('change', function (e) {
      if (e.target.matches('input[type="checkbox"][data-id]')) toggleComplete(e.target.dataset.id);
    });

    list.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      if (!e.target.matches('[data-card]')) return;
      e.preventDefault();
      handleCardActivate(e);
    });
  });

  $('completedToggle').addEventListener('click', function () {
    completedOpen = !completedOpen;
    render();
  });

  $('fab').addEventListener('click', function () { openTaskModal(null); });

  /* ─────────────────────────────────────────────────────────────
     Category picker (opened from a card's category chip)

     A sheet rather than an anchored popover: the cards sit in a scrolling
     list, where absolute positioning is fragile, and the sheet already
     brings a focus trap, Escape, scroll lock and the mobile bottom-sheet
     treatment with it.
     ───────────────────────────────────────────────────────────── */

  var pickingId = null;
  var pickerMode = 'card'; // 'card' assigns to a task, 'form' fills the task sheet

  function renderCategoryOptions() {
    var task = findTask(pickingId);
    var current = pickerMode === 'form' ? formCategory() : (task ? task.category : '');
    var box = $('categoryOptions');
    box.textContent = '';

    function option(value, label) {
      var btn = h('button', {
        class: 'option', type: 'button', role: 'radio',
        'aria-checked': String(value === current)
      }, [
        h('span', { class: 'option-dot', 'aria-hidden': 'true' }),
        h('span', { class: 'option-text' }, [h('strong', { text: label })])
      ]);
      btn.addEventListener('click', function () { assignCategory(value); });
      return btn;
    }

    var names = allCategories();
    box.appendChild(option('', 'Uncategorised'));
    names.forEach(function (name) { box.appendChild(option(name, name)); });

    // A name typed into the sheet has no task yet, so allCategories() misses it.
    if (current && names.indexOf(current) === -1) box.appendChild(option(current, current));
  }

  function openCategoryPicker(taskId) {
    if (!findTask(taskId)) return;
    pickerMode = 'card';
    pickingId = taskId;
    $('pickerNewCategory').value = '';
    renderCategoryOptions();
    openModal($('categoryOverlay'), closeCategoryPicker);
  }

  function openFormCategoryPicker() {
    pickerMode = 'form';
    pickingId = null;
    $('pickerNewCategory').value = '';
    renderCategoryOptions();
    openModal($('categoryOverlay'), closeCategoryPicker);
  }

  function closeCategoryPicker() {
    closeModal($('categoryOverlay'));
    pickingId = null;
    pickerMode = 'card';
  }

  function assignCategory(value) {
    if (pickerMode === 'form') {
      closeCategoryPicker();
      setFormCategory(value);
      return;
    }

    var task = findTask(pickingId);
    closeCategoryPicker();
    if (!task || task.category === value) return;
    task.category = value;
    commit();
    toast(value ? 'Moved to ' + value : 'Category cleared');
  }

  /* The category comes into being by being assigned — assignCategory() writes
     it onto the task and commits, and the task is the only thing that keeps it
     alive. Nothing to persist separately. */
  function addCategoryFromPicker() {
    var name = canonicalCategory($('pickerNewCategory').value);
    if (!name) { $('pickerNewCategory').focus(); return; }
    $('pickerNewCategory').value = '';
    assignCategory(name);
  }

  $('pickerAddCategory').addEventListener('click', addCategoryFromPicker);
  $('pickerNewCategory').addEventListener('keydown', function (e) {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    addCategoryFromPicker();
  });
  $('categoryCancel').addEventListener('click', closeCategoryPicker);

  $('categoryButton').addEventListener('click', openFormCategoryPicker);

  /* ─────────────────────────────────────────────────────────────
     Search and category filter
     ───────────────────────────────────────────────────────────── */

  function clearSearch() {
    $('searchInput').value = '';
    $('searchClear').hidden = true;
    searchQuery = '';
  }

  $('searchInput').addEventListener('input', function () {
    searchQuery = this.value.trim().toLowerCase();
    $('searchClear').hidden = this.value === '';
    render();
  });

  $('searchClear').addEventListener('click', function () {
    clearSearch();
    render();
    $('searchInput').focus();
  });

  $('filterClear').addEventListener('click', function () {
    categoryFilter = null;
    render();
  });

  $('clearFilters').addEventListener('click', function () {
    clearSearch();
    categoryFilter = null;
    render();
  });

  $('drawerBtn').addEventListener('click', function () {
    if (drawerIsOpen()) closeDrawer(); else openDrawer();
  });
  $('drawerClose').addEventListener('click', closeDrawer);
  $('drawerScrim').addEventListener('click', closeDrawer);

  document.addEventListener('keydown', function (e) {
    // The sheets have their own trap and sit above the drawer; leave them be.
    if (!drawerIsOpen() || stack.length) return;

    if (e.key === 'Escape') { e.preventDefault(); closeDrawer(); return; }
    if (e.key !== 'Tab') return;

    var items = Array.prototype.filter.call(
      $('drawer').querySelectorAll(FOCUSABLE),
      function (el) { return el.offsetParent !== null && !el.disabled; }
    );
    if (!items.length) return;
    var first = items[0];
    var last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });

  /* ─────────────────────────────────────────────────────────────
     Header menu
     ───────────────────────────────────────────────────────────── */

  function setMenu(open) {
    $('menu').hidden = !open;
    $('menuBtn').setAttribute('aria-expanded', String(open));
  }

  $('menuBtn').addEventListener('click', function (e) {
    e.stopPropagation();
    setMenu($('menu').hidden);
  });

  document.addEventListener('click', function (e) {
    if (!$('menu').hidden && !e.target.closest('.menu-wrap')) setMenu(false);
  });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !$('menu').hidden && !stack.length) setMenu(false);
  });

  /* ─────────────────────────────────────────────────────────────
     Export / Import
     ───────────────────────────────────────────────────────────── */

  function exportTasks() {
    setMenu(false);
    if (!tasks.length) {
      toast('Nothing to export yet.', { type: 'error' });
      return;
    }

    var payload = {
      app: 'todo-list',
      version: 1,
      exportedAt: new Date().toISOString(),
      tasks: tasks
    };

    var text = JSON.stringify(payload, null, 2);
    var name = 'todo-backup-' + toISO(new Date()) + '.json';
    var done = 'Exported ' + tasks.length + (tasks.length === 1 ? ' task' : ' tasks');

    // A WebView is an unreliable host for the <a download> trick, so on Android
    // the file goes wherever the system picker points instead.
    if (store().isNative()) {
      store().exportDoc(name, text).then(function (res) {
        if (res && res.saved) toast(done); // backing out of the picker is not an error
      }).catch(function () {
        toast('Couldn’t save the backup.', { type: 'error' });
      });
      return;
    }

    var blob = new Blob([text], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = h('a', { href: url, download: name });
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);

    toast(done);
  }

  function parseBackup(text) {
    var data = JSON.parse(text); // caller handles the throw
    var list = Array.isArray(data) ? data : (data && Array.isArray(data.tasks) ? data.tasks : null);
    if (!list) throw new Error('shape');

    var seen = {};
    var valid = [];
    var skipped = 0;
    list.forEach(function (raw) {
      var t = normalizeTask(raw, seen);
      if (t) valid.push(t); else skipped++;
    });
    return { tasks: valid, skipped: skipped, total: list.length };
  }

  function importFile(file) {
    var reader = new FileReader();

    reader.onerror = function () {
      toast('Couldn’t read that file.', { type: 'error' });
    };

    reader.onload = function () { importText(String(reader.result)); };

    reader.readAsText(file);
  }

  /* Shared by both pickers — the browser's file input and Android's SAF — so
     the confirmation lives in exactly one place. An import only ever merges:
     nothing already on the list can be lost by a mistaken tap. */
  function importText(text) {
    var result;
    try {
      result = parseBackup(text);
    } catch (err) {
      toast('That doesn’t look like a valid backup file.', { type: 'error' });
      return;
    }

    if (!result.tasks.length) {
      toast('No usable tasks found in that file.', { type: 'error' });
      return;
    }

    var count = result.tasks.length;
    var noun = count === 1 ? 'task' : 'tasks';

    confirmDialog({
      title: 'Import ' + count + ' ' + noun + '?',
      text: tasks.length
        ? 'Your ' + tasks.length + ' current ' + (tasks.length === 1 ? 'task' : 'tasks') +
          ' will be kept — these are added on top.'
        : 'Your list is empty, so these will simply be added.',
      buttons: [
        { label: 'Cancel', value: null, variant: 'btn-ghost' },
        { label: 'Merge', value: 'merge', variant: 'btn-primary' }
      ]
    }).then(function (choice) {
      if (!choice) return;

      var byId = {};
      tasks.forEach(function (t) { byId[t.id] = t; });
      result.tasks.forEach(function (t) { byId[t.id] = t; }); // imported wins on conflict
      tasks = Object.keys(byId).map(function (k) { return byId[k]; });

      dedupeNotifIds();
      commit();
      toast('Imported ' + count + ' ' + noun +
            (result.skipped ? ' (' + result.skipped + ' skipped as invalid)' : ''));
    });
  }

  $('exportBtn').addEventListener('click', exportTasks);

  $('importBtn').addEventListener('click', function () {
    setMenu(false);

    // The document the picker returns is a backup file, but tasks.json itself
    // parses too — parseBackup() accepts a bare {tasks:[…]}, so a user who
    // picks their own store file gets a working import rather than an error.
    if (store().isNative()) {
      store().importDoc().then(function (res) {
        if (res && typeof res.value === 'string') importText(res.value);
      }).catch(function () {
        toast('Couldn’t read that file.', { type: 'error' });
      });
      return;
    }

    $('fileInput').click();
  });

  $('fileInput').addEventListener('change', function () {
    var file = this.files && this.files[0];
    this.value = ''; // so picking the same file again still fires
    if (file) importFile(file);
  });

  /* ─────────────────────────────────────────────────────────────
     Boot
     ───────────────────────────────────────────────────────────── */

  // Small debug surface: handy from the console, used by the test harness, and
  // the only channel notify.js has back into here.
  window.__todo = {
    parseLocal: parseLocal, toISO: toISO, dayName: dayName, addMonths: addMonths,
    nextOccurrence: nextOccurrence, describeRecurrence: describeRecurrence,
    normalizeTask: normalizeTask, taskMs: taskMs, parseBackup: parseBackup,
    openTaskModal: openTaskModal, toggleComplete: toggleComplete, deleteTask: deleteTask,
    render: render,
    load: load, // returns a Promise now — the document is read asynchronously
    reloadFromStore: reloadFromStore,
    importText: importText,
    LEGACY_TASKS_KEY: LEGACY_TASKS_KEY,
    LEGACY_SEQ_KEY: LEGACY_SEQ_KEY,
    LEGACY_CATEGORIES_KEY: LEGACY_CATEGORIES_KEY,
    toast: toast, confirmDialog: confirmDialog, formatTime: formatTime,
    getCategories: allCategories,
    openCategoryPicker: openCategoryPicker,
    // Drive the real input so the clear button and placeholder stay honest.
    setSearch: function (q) {
      $('searchInput').value = q == null ? '' : String(q);
      searchQuery = $('searchInput').value.trim().toLowerCase();
      $('searchClear').hidden = $('searchInput').value === '';
      render();
    },
    setCategoryFilter: function (value) {
      categoryFilter = value === undefined ? null : value;
      render();
    },
    getCategoryFilter: function () { return categoryFilter; },
    getTasks: function () { return tasks; },
    setTasks: function (list) { tasks = list; commit(); },
    // Called from a notification's "Mark done" action. Deliberately routed
    // through toggleComplete so recurrence roll-forward lives in one place.
    completeById: function (id) {
      var task = findTask(id);
      if (task && !task.completed) toggleComplete(id);
    }
  };

  /* Reading the document is asynchronous, so the whole tail hangs off it. The
     first render waits — which is fine, because #emptyState and #noResults are
     hidden in the markup until render() reveals them, so an unpopulated list
     looks like a list that hasn't drawn yet, not like an empty one. */
  load().then(function () {
    // normalizeTask() hands out notifIds to tasks stored before reminders
    // existed, and a migration produces a document that has never been
    // written. load() itself never writes, so do it here or it churns every
    // boot. One write covers both: the migrated document is the normalised one.
    if (migrated || docDirty) {
      docDirty = false;
      persist().then(function (ok) {
        // Only once the document is safely down. If the write failed the old
        // keys are still the only copy, and the next launch tries again.
        if (ok && migrated) clearLegacyKeys();
      });
    }

    render();

    // The "Mark done" receiver writes the document from outside the WebView. If
    // the app is merely backgrounded it is still running and still holding the
    // old list, so the plugin tells us and we re-read. A killed app has no
    // listener and does not need one — its next launch reads the file anyway.
    if (window.TodoStore && TodoStore.onChanged) {
      TodoStore.onChanged(function () { reloadFromStore(); });
    }

    if (window.TodoNotify) {
      // Forced: a cold start may follow a force-stop or an OEM background kill,
      // either of which drops the OS alarms while the plugin still reports them
      // as pending. Re-arm from scratch rather than trusting that report.
      TodoNotify.init().then(function (ok) {
        if (ok) TodoNotify.sync(tasks, true);
      });
    }

    // Overdue chips and relative labels go stale as the clock moves on.
    setInterval(render, 60000);
  });
})();
