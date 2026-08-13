/* Unit tests for the pure scheduling logic in www/notify.js.

   notify.js is loaded into a bare sandbox with the browser globals it touches
   stubbed out and no Capacitor bridge, so only the date maths and the
   eligibility rules are under test — nothing here talks to a plugin. */

const fs = require('fs');
const path = require('path');
const { ROOT, toISO, addDays, fakeTodoApi } = require('./harness');

module.exports = function run(t) {
  const store = {};
  const localStorage = {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); }
  };
  const win = { console };

  const src = fs.readFileSync(path.join(ROOT, 'notify.js'), 'utf8');
  new Function('window', 'document', 'localStorage', 'Capacitor', src)(
    win, { addEventListener() {} }, localStorage, undefined
  );

  const N = win.TodoNotify;
  win.__todo = fakeTodoApi();

  const today = new Date();
  const iso = (d) => toISO(d);
  const tomorrow = iso(addDays(today, 1));
  const yesterday = iso(addDays(today, -1));

  t.section('notifyMsFor — the 8am default');
  t.check('explicit time is honoured',
    new Date(N.notifyMsFor(tomorrow, '14:30')).toTimeString().slice(0, 5), '14:30');
  t.check('missing time defaults to 08:00, not 23:59',
    new Date(N.notifyMsFor(tomorrow, '')).toTimeString().slice(0, 5), '08:00');
  t.check('invalid date yields null', N.notifyMsFor('2026-02-30', '09:00'), 'null');
  t.check('empty date yields null', N.notifyMsFor('', '09:00'), 'null');
  t.check('no UTC drift — date part survives',
    iso(new Date(N.notifyMsFor('2026-08-13', ''))), '2026-08-13');

  t.section('nextFutureMs — past dates and recurrence recovery');
  t.check('past one-off is not scheduled',
    N.nextFutureMs({ date: yesterday, time: '09:00' }), 'null');
  t.check('future one-off is scheduled',
    N.nextFutureMs({ date: tomorrow, time: '09:00' }) > Date.now(), 'true');

  // A weekly task last touched 60 days ago: the stored date is long past, but
  // the reminder we arm must still land in the future.
  const stale = iso(addDays(today, -60));
  const weekly = { date: stale, time: '09:00', recurrence: { type: 'custom', interval: 1, unit: 'week' } };
  const rolled = N.nextFutureMs(weekly);
  t.check('stale weekly rolls forward past now', rolled > Date.now(), 'true');
  t.check('stale weekly lands within 7 days', rolled - Date.now() < 7 * 86400000 + 1000, 'true');
  t.check('roll-forward does not mutate the task', weekly.date, stale);

  const wkMs = N.nextFutureMs({ date: stale, time: '09:00', recurrence: { type: 'workweek' } });
  const wkDay = new Date(wkMs).getDay();
  t.check('workweek lands Mon-Fri', wkDay >= 1 && wkDay <= 5, 'true');

  t.section('desiredFor — eligibility and the iOS 64 cap');
  const base = { id: 'a', notifId: 1, name: 'x', date: tomorrow, time: '09:00', completed: false };
  t.check('eligible task is included', N.desiredFor([base]).length, 1);
  t.check('completed task is excluded',
    N.desiredFor([Object.assign({}, base, { completed: true })]).length, 0);
  t.check('dateless task is excluded',
    N.desiredFor([Object.assign({}, base, { date: '' })]).length, 0);
  t.check('task without notifId is excluded',
    N.desiredFor([Object.assign({}, base, { notifId: undefined })]).length, 0);

  const many = [];
  for (let i = 0; i < 100; i++) {
    many.push({ id: 'i' + i, notifId: i + 1, name: 't' + i, completed: false,
                date: iso(addDays(today, i + 1)), time: '09:00' });
  }
  const capped = N.desiredFor(many);
  t.check('capped at 60 pending', capped.length, 60);
  t.check('kept the soonest, not an arbitrary slice', capped[0].id, 1);
  t.check('dropped the furthest out', capped.some((i) => i.id === 100), 'false');
  t.check('sorted ascending by fire time',
    capped.every((v, i, a) => i === 0 || a[i - 1].at <= v.at), 'true');

  t.section('web fallback');
  t.check('sync is inert with no Capacitor bridge', typeof N.sync([]).then, 'function');
  t.check('state reports non-native', N.state().native, 'false');
};
