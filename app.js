/* To Do — vanilla JS, localStorage only. No build step, no dependencies. */
(function () {
  'use strict';

  var STORAGE_KEY = 'todo.tasks.v1';
  var DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  var TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
  var UNITS = ['day', 'week', 'month', 'year'];
  var MAX_ROLL = 500;

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

    return {
      id: id,
      name: name,
      date: date,
      time: time,
      day: date ? dayName(date) : '',
      completed: raw.completed === true,
      completedAt: typeof raw.completedAt === 'string' ? raw.completedAt : null,
      recurrence: rule
    };
  }

  function load() {
    var parsed;
    try {
      parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
    } catch (err) {
      parsed = [];
    }
    if (!Array.isArray(parsed)) parsed = [];

    var seen = {};
    tasks = parsed.map(function (t) { return normalizeTask(t, seen); })
                  .filter(Boolean);
  }

  function save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(tasks));
    } catch (err) {
      toast('Could not save — browser storage is full or blocked.', { type: 'error' });
    }
  }

  function commit() { save(); render(); }

  // Same as commit(), but lets the checkbox tick animation finish before the
  // card is re-rendered away into the Completed section.
  function commitAfterCheck() { save(); setTimeout(render, 260); }

  function findTask(id) {
    for (var i = 0; i < tasks.length; i++) if (tasks[i].id === id) return tasks[i];
    return null;
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

  var completedOpen = true;

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

    var del = h('button', { class: 'del', type: 'button', 'data-stop': true, 'data-del': task.id, 'aria-label': 'Delete "' + task.name + '"' }, [icon('i-trash')]);

    var cls = 'card' + (task.completed ? ' done' : '') + (overdue ? ' overdue' : '');
    return h('div', { class: cls, 'data-card': task.id, tabindex: '0', role: 'listitem' }, [
      checkbox,
      h('div', { class: 'card-body' }, [h('p', { class: 'card-name', text: task.name }), meta]),
      del
    ]);
  }

  function render() {
    var pending = tasks.filter(function (t) { return !t.completed; })
      .sort(function (a, b) {
        var d = taskMs(a) - taskMs(b);
        if (d) return d;
        return a.name.localeCompare(b.name);
      });

    var done = tasks.filter(function (t) { return t.completed; })
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
    $('emptyState').hidden = tasks.length !== 0;
    $('pendingCount').textContent = pending.length;
    $('completedCount').textContent = done.length;

    completedList.hidden = !completedOpen;
    $('completedToggle').setAttribute('aria-expanded', String(completedOpen));

    var overdue = pending.filter(function (t) { return taskMs(t) < Date.now(); }).length;
    var summary = pending.length === 0
      ? (tasks.length ? 'All caught up' : 'Nothing scheduled')
      : pending.length + (pending.length === 1 ? ' task pending' : ' tasks pending') +
        (overdue ? ' · ' + overdue + ' overdue' : '');
    $('summary').textContent = summary;
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
  ['taskOverlay', 'repeatOverlay', 'confirmOverlay'].forEach(function (id) {
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

  function updateDayField() {
    var iso = $('dateInput').value;
    $('dayInput').value = parseLocal(iso) ? dayName(iso) : '';
  }

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
    $('nameInput').classList.remove('invalid');
    $('dateInput').classList.remove('invalid');
  }

  function openTaskModal(task) {
    editingId = task ? task.id : null;
    draftRecurrence = task ? task.recurrence : null;

    $('taskTitle').textContent = task ? 'Edit task' : 'New task';
    $('nameInput').value = task ? task.name : '';
    $('dateInput').value = task ? task.date : toISO(new Date());
    $('timeInput').value = task ? task.time : '';
    clearTaskErrors();
    updateDayField();
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

    var existing = editingId ? findTask(editingId) : null;
    if (existing) {
      existing.name = name;
      existing.date = date;
      existing.time = time;
      existing.day = date ? dayName(date) : '';
      existing.recurrence = draftRecurrence;
    } else {
      tasks.push({
        id: uid(),
        name: name,
        date: date,
        time: time,
        day: date ? dayName(date) : '',
        completed: false,
        completedAt: null,
        recurrence: draftRecurrence
      });
    }

    closeTaskModal();
    commit();
    toast(existing ? 'Task updated' : 'Task added');
  }

  $('dateInput').addEventListener('change', updateDayField);
  $('dateInput').addEventListener('input', updateDayField);
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
          completed: true,
          completedAt: new Date().toISOString(),
          recurrence: null
        });
        task.date = next;
        task.day = dayName(next);
        commitAfterCheck();
        toast('Done — next one on ' + formatDate(next));
        return;
      }
    }

    task.completed = true;
    task.completedAt = new Date().toISOString();
    commitAfterCheck();
  }

  function deleteTask(id) {
    var index = -1;
    for (var i = 0; i < tasks.length; i++) if (tasks[i].id === id) index = i;
    if (index === -1) return;

    var removed = tasks.splice(index, 1)[0];
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

    var blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = h('a', { href: url, download: 'todo-backup-' + toISO(new Date()) + '.json' });
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);

    toast('Exported ' + tasks.length + (tasks.length === 1 ? ' task' : ' tasks'));
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

    reader.onload = function () {
      var result;
      try {
        result = parseBackup(String(reader.result));
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
          ? 'Merge keeps your ' + tasks.length + ' current ' + (tasks.length === 1 ? 'task' : 'tasks') +
            ' and adds these. Replace deletes them first.'
          : 'Your list is empty, so these will simply be added.',
        buttons: [
          { label: 'Cancel', value: null, variant: 'btn-ghost' },
          { label: 'Merge', value: 'merge', variant: 'btn-ghost' },
          { label: 'Replace', value: 'replace', variant: tasks.length ? 'btn-danger' : 'btn-primary' }
        ]
      }).then(function (choice) {
        if (!choice) return;

        if (choice === 'replace') {
          tasks = result.tasks;
        } else {
          var byId = {};
          tasks.forEach(function (t) { byId[t.id] = t; });
          result.tasks.forEach(function (t) { byId[t.id] = t; }); // imported wins on conflict
          tasks = Object.keys(byId).map(function (k) { return byId[k]; });
        }

        commit();
        toast('Imported ' + count + ' ' + noun +
              (result.skipped ? ' (' + result.skipped + ' skipped as invalid)' : ''));
      });
    };

    reader.readAsText(file);
  }

  $('exportBtn').addEventListener('click', exportTasks);

  $('importBtn').addEventListener('click', function () {
    setMenu(false);
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

  // Small debug surface: handy from the console, and used by the test harness.
  window.__todo = {
    parseLocal: parseLocal, toISO: toISO, dayName: dayName, addMonths: addMonths,
    nextOccurrence: nextOccurrence, describeRecurrence: describeRecurrence,
    normalizeTask: normalizeTask, taskMs: taskMs, parseBackup: parseBackup,
    openTaskModal: openTaskModal, toggleComplete: toggleComplete, deleteTask: deleteTask,
    render: render, load: load, STORAGE_KEY: STORAGE_KEY,
    getTasks: function () { return tasks; },
    setTasks: function (list) { tasks = list; commit(); }
  };

  load();
  render();

  // Overdue chips and relative labels go stale as the clock moves on.
  setInterval(render, 60000);
})();
