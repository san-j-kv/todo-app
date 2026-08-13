#!/usr/bin/env node
/* Runs every suite and exits non-zero if anything failed.

   Usage:  npm test              all suites
           npm test -- notify    only suites whose name contains "notify"

   No framework and no config, to match a project with no build step. The only
   dev dependency is jsdom, which the integration suite needs. */

const { createReporter } = require('./harness');

const SUITES = [
  { name: 'notify  (unit)', load: () => require('./notify.test') },
  { name: 'app     (integration, jsdom)', load: () => require('./app.test') }
];

/* The app persists through promises now, and every commit() fires one without
   awaiting it. A rejection escaping that path would otherwise be invisible
   here — the assertions would still pass while the write silently failed. */
const unhandled = [];
process.on('unhandledRejection', (err) => {
  unhandled.push((err && err.message) || String(err));
});

async function main() {
  const filter = process.argv[2];
  const suites = filter
    ? SUITES.filter((s) => s.name.includes(filter))
    : SUITES;

  if (!suites.length) {
    console.error('No suite matches "' + filter + '". Available:');
    SUITES.forEach((s) => console.error('  ' + s.name));
    process.exit(1);
  }

  const t = createReporter();
  const broken = [];

  for (const suite of suites) {
    console.log('\n' + suite.name);
    console.log('─'.repeat(60));
    try {
      await suite.load()(t);
    } catch (err) {
      // A suite that throws is a failure in its own right, not a crash of the
      // runner — keep going so one broken suite doesn't hide the others.
      broken.push(suite.name);
      console.log('    ERROR  suite threw: ' + (err && err.message));
      if (process.env.VERBOSE) console.error(err);
    }
  }

  // A rejection reported on the last turn of the loop hasn't reached the
  // handler yet, and process.exit() below would beat it.
  await new Promise((r) => setImmediate(r));

  const failed = t.failures.length + broken.length + unhandled.length;
  console.log('\n' + '─'.repeat(60));
  console.log(t.pass() + ' passed, ' + failed + ' failed');

  if (t.failures.length) {
    console.log('\nFailed assertions:');
    t.failures.forEach((f) => console.log('  · ' + f));
  }
  if (broken.length) {
    console.log('\nSuites that threw:');
    broken.forEach((b) => console.log('  · ' + b));
    console.log('(re-run with VERBOSE=1 for stack traces)');
  }
  if (unhandled.length) {
    console.log('\nUnhandled promise rejections:');
    unhandled.forEach((u) => console.log('  · ' + u));
  }
  console.log('');

  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
