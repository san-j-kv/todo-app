/* Unit tests for www/nlu.js — the spoken-sentence parser.

   No jsdom here on purpose. nlu.js touches no DOM, so it require()s straight
   into Node, which keeps this suite fast and keeps the parser honest about
   having no environment of its own.

   The clock is pinned to a Wednesday so "monday"/"friday" have an unambiguous
   answer in both directions, and every expectation is written as a literal
   date rather than computed — a bug that lands in both the parser and the
   expectation would otherwise cancel out. */

const path = require('path');
const { ROOT } = require('./harness');

const { parse } = require(path.join(ROOT, 'nlu.js'));

// Wednesday 2026-08-19, 10:00 local.
const NOW = new Date(2026, 7, 19, 10, 0, 0);
const CATEGORIES = ['Groceries', 'Work', 'Work trips'];

function run(text, opts) {
  return parse(text, Object.assign({ now: NOW, categories: CATEGORIES }, opts || {}));
}

function rule(r) {
  if (!r) return 'null';
  if (r.type === 'workweek') return 'workweek';
  return r.interval + ' ' + r.unit;
}

module.exports = function (t) {
  t.section('name only');
  [
    ['buy milk', 'Buy milk'],
    ['remind me to buy milk', 'Buy milk'],
    ['ok remind me to call the dentist', 'Call the dentist'],
    ['add a task to water the plants', 'Water the plants'],
    ['i need to renew the passport', 'Renew the passport'],
    ['new task pay the gas bill please', 'Pay the gas bill']
  ].forEach(([said, want]) => {
    t.check('"' + said + '" -> name', run(said).name, want);
  });

  t.section('name is never dropped');
  t.check('unparseable stays whole', run('xyzzy plugh frobnicate').name, 'Xyzzy plugh frobnicate');
  t.check('digits in the name survive', run('buy 6 eggs').name, 'Buy 6 eggs');
  t.check('no phantom time from a bare digit', run('buy 6 eggs').time, '');

  t.section('dates');
  [
    ['call mum today', '2026-08-19'],
    ['call mum tomorrow', '2026-08-20'],
    ['call mum the day after tomorrow', '2026-08-21'],
    ['dentist on friday', '2026-08-21'],
    ['dentist monday', '2026-08-24'],
    ['dentist next monday', '2026-08-24'],
    ['dentist next wednesday', '2026-08-26'],
    ['dentist wednesday', '2026-08-19'],
    ['review in 3 days', '2026-08-22'],
    ['review in a week', '2026-08-26'],
    ['review in two weeks', '2026-09-02'],
    ['review in one month', '2026-09-19'],
    ['review next week', '2026-08-26'],
    ['review next month', '2026-09-19'],
    ['pay rent on the 3rd', '2026-09-03'],
    ['pay rent on the 25th', '2026-08-25'],
    ['book flights march 14', '2027-03-14'],
    ['book flights on september 2nd', '2026-09-02'],
    ['book flights 14 march', '2027-03-14'],
    ['book flights on the 14th of december', '2026-12-14']
  ].forEach(([said, want]) => {
    t.check('"' + said + '" -> date', run(said).date, want);
  });

  t.check('date phrase leaves the name clean', run('book flights on the 14th of december').name, 'Book flights');
  t.check('weekday phrase leaves the name clean', run('dentist on friday').name, 'Dentist');
  t.check('no date when none is said', run('buy milk').date, '');

  t.section('times');
  [
    ['standup at 9', '09:00'],
    ['dinner at 6', '18:00'],
    ['call at 5pm', '17:00'],
    ['call at 5 pm', '17:00'],
    ['call at five p m', '17:00'],
    ['call at 11am', '11:00'],
    ['meeting at 17:30', '17:30'],
    ['meeting at 5:30 pm', '17:30'],
    ['meeting at 9 30', '09:30'],
    ['lunch at noon', '12:00'],
    ['alarm at midnight', '00:00'],
    ['call at half past four', '16:30'],
    ['call at quarter past seven', '07:15'],
    ['call at quarter to five', '16:45'],
    ['gym in the morning', '09:00'],
    ['gym this evening', '18:00'],
    ['call mum tonight', '20:00']
  ].forEach(([said, want]) => {
    t.check('"' + said + '" -> time', run(said).time, want);
  });

  t.check('tonight also means today', run('call mum tonight').date, '2026-08-19');
  t.check('time phrase leaves the name clean', run('call at half past four').name, 'Call');
  t.check('"at work" is not a time', run('drop the keys at work').time, '');

  t.section('recurrence');
  [
    ['water plants every day', '1 day'],
    ['water plants daily', '1 day'],
    ['standup every weekday', 'workweek'],
    ['standup on weekdays', 'workweek'],
    ['standup every work day', 'workweek'],
    ['pay rent monthly', '1 month'],
    ['review every 3 weeks', '3 week'],
    ['review every other week', '2 week'],
    ['bins every two weeks', '2 week'],
    ['renew every year', '1 year'],
    ['team sync every monday', '1 week']
  ].forEach(([said, want]) => {
    t.check('"' + said + '" -> rule', rule(run(said).recurrence), want);
  });

  t.check('"every monday" anchors to next monday', run('team sync every monday').date, '2026-08-24');
  t.check('recurrence with no date anchors to today', run('water plants daily').date, '2026-08-19');
  t.check('recurrence phrase leaves the name clean', run('review every 3 weeks').name, 'Review');
  t.check('no rule when none is said', rule(run('buy milk').recurrence), 'null');

  t.section('categories');
  t.check('prefixed', run('buy milk in groceries').category, 'Groceries');
  t.check('prefixed leaves name clean', run('buy milk in groceries').name, 'Buy milk');
  t.check('trailing bare match', run('email the invoice work').category, 'Work');
  t.check('longest match wins', run('book the hotel in work trips').category, 'Work trips');
  t.check('"category X" form', run('buy milk category groceries').category, 'Groceries');
  t.check('mid-sentence bare match is not a category', run('call work about the invoice').category, '');
  t.check('mid-sentence match stays in the name', run('call work about the invoice').name, 'Call work about the invoice');
  t.check('unknown category is never invented', run('buy milk in sundries').category, '');
  t.check('unknown category stays in the name', run('buy milk in sundries').name, 'Buy milk in sundries');
  t.check('no categories configured', parse('buy milk in groceries', { now: NOW, categories: [] }).category, '');

  /* Punctuation in a category name is inaudible, so it cannot be required.
     "Anniversary / Birthday" is a real category from the app this was built
     for, and comparing raw tokens made it unreachable by voice — the spoken
     form has no "/" in it and never will. */
  t.section('categories with punctuation are still speakable');
  const punct = (said, cats) => parse(said, { now: NOW, categories: cats || ['Anniversary / Birthday'] });

  t.check('spaced slash, said without it',
    punct('call mum in anniversary birthday').category, 'Anniversary / Birthday');
  t.check('and the name is left clean',
    punct('call mum in anniversary birthday').name, 'Call mum');
  t.check('unspaced slash, said without it',
    punct('call mum in anniversary birthday', ['Anniversary/Birthday']).category, 'Anniversary/Birthday');
  t.check('ampersand form',
    punct('email the invoice in health & fitness', ['Health & Fitness']).category, 'Health & Fitness');
  t.check('a literal slash in the transcript is skipped, not fatal',
    punct('call mum in anniversary / birthday').category, 'Anniversary / Birthday');
  t.check('trailing bare match still works with punctuation',
    punct('ring the caterers anniversary birthday').category, 'Anniversary / Birthday');
  t.check('still refuses to invent one',
    punct('buy milk in groceries').category, '');
  t.check('partial match is not a match',
    punct('call mum in anniversary').category, '');
  t.check('and that partial stays in the name',
    punct('call mum in anniversary').name, 'Call mum in anniversary');

  /* Verbatim transcripts captured from Vosk on a moto g71, not invented. The
     speaker said "8 AM" every time; the engine returned "eighty m" every time,
     fusing the hour with the "a" and orphaning the "m". A parser that only
     knows "eight a m" reports no time at all, which is exactly how it looked
     from the outside — "it never captures the time". */
  t.section('real Vosk transcripts');
  const vosk = (said) => parse(said, { now: NOW, categories: ['Hygiene', 'Groceries'] });

  {
    const a = vosk('get a haircut sunday eighty m. repeat every three weeks in hygiene');
    t.check('fused 8am is recovered', a.time, '08:00');
    t.check('name is clean of the fusion', a.name, 'Get a haircut');
    t.check('date', a.date, '2026-08-23');
    t.check('rule', rule(a.recurrence), '3 week');
    t.check('category', a.category, 'Hygiene');
  }
  {
    // Marker after the name, pluralised by the engine.
    const b = vosk('get a haircut tomorrow eighty m. repeat every three weeks hygiene category');
    t.check('suffix marker: time', b.time, '08:00');
    t.check('suffix marker: category', b.category, 'Hygiene');
    t.check('suffix marker: name', b.name, 'Get a haircut');
  }
  {
    const c = vosk('get haircut at eighty m. tomorrow repeat every three weeks in hygiene categories');
    t.check('trailing "categories" is absorbed', c.category, 'Hygiene');
    t.check('and does not litter the name', c.name, 'Get haircut');
    t.check('time', c.time, '08:00');
  }

  /* Saying "AM" is the unreliable part on this device — the engine returned
     "eighty m" for it once and "damn" the next time. These are the phrasings
     that avoid the word entirely, so they are the ones that have to work. */
  t.section('saying the time without saying "AM"');
  [
    ['get a haircut at eight', '08:00'],
    ['get a haircut at eight in the morning', '08:00'],
    ['get a haircut at eight o clock', '08:00'],
    ['get a haircut at eight o clock in the morning', '08:00'],
    ['get a haircut eight in the morning', '08:00'],
    ['call at five in the evening', '17:00'],
    ['call at nine at night', '21:00'],
    ['call at two in the afternoon', '14:00'],
    ['call at eleven in the morning', '11:00'],
    ['call at twelve in the afternoon', '12:00']
  ].forEach(([said, want]) => {
    t.check('"' + said + '" -> ' + want, parse(said, { now: NOW }).time, want);
  });
  t.check('the period phrase does not litter the name',
    parse('get a haircut at eight in the morning', { now: NOW }).name, 'Get a haircut');
  t.check('nor does the bare form',
    parse('get a haircut eight in the morning', { now: NOW }).name, 'Get a haircut');
  // Vosk splits o'clock into two tokens; the single-token form only ever
  // appeared because the fixtures were typed rather than spoken.
  t.check('two-token "o clock" is consumed too',
    parse('get a haircut at eight o clock', { now: NOW }).name, 'Get a haircut');
  t.check('and with a period after it',
    parse('call at eight o clock at night', { now: NOW }).time, '20:00');

  t.section('fused hours, the other digits');
  [
    ['wake me at sixty m', '06:00'],
    ['call at ninety m', '09:00'],
    ['standup at twenty m', '02:00'],
    ['dinner at seventy p m', '19:00']
  ].forEach(([said, want]) => {
    t.check('"' + said + '" -> ' + want, parse(said, { now: NOW }).time, want);
  });
  t.check('a real eighty is still not an hour', parse('buy eighty balloons', { now: NOW }).time, '');
  t.check('and stays in the name', parse('buy eighty balloons', { now: NOW }).name, 'Buy eighty balloons');

  t.section('everything at once');
  const full = run('remind me to buy milk tomorrow at 5pm repeat weekly groceries');
  t.check('name', full.name, 'Buy milk');
  t.check('date', full.date, '2026-08-20');
  t.check('time', full.time, '17:00');
  t.check('rule', rule(full.recurrence), '1 week');
  t.check('category', full.category, 'Groceries');

  const spoken = run('add a task call the dentist on friday at half past two in work');
  t.check('spoken name', spoken.name, 'Call the dentist');
  t.check('spoken date', spoken.date, '2026-08-21');
  t.check('spoken time', spoken.time, '14:30');
  t.check('spoken category', spoken.category, 'Work');
  t.check('spoken rule', rule(spoken.recurrence), 'null');

  t.section('degenerate input');
  ['', '   ', null, undefined].forEach((bad) => {
    const got = parse(bad, { now: NOW, categories: CATEGORIES });
    t.check(JSON.stringify(bad) + ' -> empty name', got.name, '');
    t.check(JSON.stringify(bad) + ' -> no rule', rule(got.recurrence), 'null');
  });
  t.check('openers only -> empty name', run('remind me to').name, '');
  t.check('name is capped at 120 chars', run('buy ' + 'x'.repeat(400)).name.length, 120);
};
