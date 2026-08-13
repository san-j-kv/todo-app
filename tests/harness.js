/* Minimal test reporter — no framework, to match a project that has no build
   step. Each suite gets a `t` and calls t.section() / t.check(); the runner
   reads the tallies afterwards. */

const ROOT = require('path').join(__dirname, '..', 'www');

function createReporter() {
  const failures = [];
  let pass = 0;

  return {
    ROOT,
    pass: () => pass,
    failures,

    section(name) {
      console.log('\n  ' + name);
    },

    /* Compared as strings so `true`/'true' and 1/'1' don't trip the caller.
       Every assertion in these suites is a scalar. */
    check(label, actual, expected) {
      if (String(actual) === String(expected)) {
        pass++;
        console.log('    ok   ' + label);
      } else {
        failures.push(label);
        console.log('    FAIL ' + label);
        console.log('           got      ' + actual);
        console.log('           expected ' + expected);
      }
    }
  };
}

/* Date helpers shared by both suites. Built from parts, never from a parsed
   'YYYY-MM-DD' string — that parses as UTC and can land a day early, the same
   trap app.js warns about. */
function pad(n) { return String(n).padStart(2, '0'); }

function toISO(dt) {
  return dt.getFullYear() + '-' + pad(dt.getMonth() + 1) + '-' + pad(dt.getDate());
}

function parseLocal(iso) {
  const p = iso.split('-').map(Number);
  return new Date(p[0], p[1] - 1, p[2]);
}

function addDays(dt, n) {
  const t = new Date(dt.getTime());
  t.setDate(t.getDate() + n);
  return t;
}

function addMonths(dt, n) {
  const day = dt.getDate();
  const t = new Date(dt.getFullYear(), dt.getMonth() + n, 1);
  const last = new Date(t.getFullYear(), t.getMonth() + 1, 0).getDate();
  t.setDate(Math.min(day, last));
  return t;
}

// Mirrors notifyMsFor() in notify.js, for building expected fire times.
function fireTime(iso, time) {
  const dt = parseLocal(iso);
  const t = time.split(':').map(Number);
  dt.setHours(t[0], t[1], 0, 0);
  return dt.getTime();
}

/* Stand-in for the slice of window.__todo that notify.js reads. app.js is not
   loaded in the unit suite, so this supplies nextOccurrence() only. */
function fakeTodoApi() {
  return {
    formatTime: (t) => t,
    nextOccurrence(iso, rule) {
      const dt = parseLocal(iso);
      if (rule.type === 'workweek') {
        let next = addDays(dt, 1);
        while (next.getDay() === 0 || next.getDay() === 6) next = addDays(next, 1);
        return toISO(next);
      }
      if (rule.type === 'custom') {
        const n = rule.interval;
        if (rule.unit === 'day') return toISO(addDays(dt, n));
        if (rule.unit === 'week') return toISO(addDays(dt, n * 7));
        if (rule.unit === 'month') return toISO(addMonths(dt, n));
        if (rule.unit === 'year') return toISO(addMonths(dt, n * 12));
      }
      return null;
    }
  };
}

module.exports = {
  ROOT, createReporter, toISO, parseLocal, addDays, addMonths, fireTime, fakeTodoApi
};
