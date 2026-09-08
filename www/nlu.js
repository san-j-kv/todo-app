/* To Do — turning a spoken sentence into task fields. No build step, no
   dependencies, no model.

   This is the "AI" in voice quick-add, and it is deliberately not a model. The
   target shape is four fields (name, date, time, category) plus a recurrence
   rule, and a rule-based parser hits that shape reliably, runs in under a
   millisecond, ships as zero bytes of download, and can be pinned down by a
   table of unit tests. An LLM could not be any of those things.

   Two rules govern everything below.

   It returns raw strings and nothing else — a 'YYYY-MM-DD', an 'HH:MM', a
   recurrence object in app.js's shape. It does no validating, no clamping and
   no rolling forward, because saveTask() already does all of that and a second
   copy of those rules is a second thing to keep in step.

   And it never drops text. Anything it cannot classify stays in the name. A
   task called "buy milk tomorrow" is a small annoyance the user can edit; a
   task whose date was silently discarded is a missed reminder. Since the parse
   is always shown in the task sheet for confirmation before anything is saved,
   over-keeping is free and over-claiming is not. */
(function () {
  'use strict';

  var MAX_NAME = 120;   // matches normalizeTask() in app.js
  var MAX_CATEGORY = 40;

  var WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  var MONTHS = ['january', 'february', 'march', 'april', 'may', 'june',
    'july', 'august', 'september', 'october', 'november', 'december'];

  var UNIT_WORDS = {
    day: 'day', days: 'day',
    week: 'week', weeks: 'week',
    month: 'month', months: 'month',
    year: 'year', years: 'year'
  };

  var CARDINALS = {
    zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
    eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13,
    fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18,
    nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50,
    // speech engines transcribe "a week" as often as "one week"
    a: 1, an: 1, other: 2
  };

  /* Tens words that are really "<digit> a" fused by the speech engine — see
     parseTime. "two a m" arrives as "twenty m", "nine a m" as "ninety m". */
  var FUSED_HOUR = {
    twenty: 2, thirty: 3, forty: 4, fifty: 5,
    sixty: 6, seventy: 7, eighty: 8, ninety: 9
  };

  var ORDINALS = {
    first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7,
    eighth: 8, ninth: 9, tenth: 10, eleventh: 11, twelfth: 12, thirteenth: 13,
    fourteenth: 14, fifteenth: 15, sixteenth: 16, seventeenth: 17,
    eighteenth: 18, nineteenth: 19, twentieth: 20, thirtieth: 30
  };

  /* Openers people say to a voice assistant that carry no task content. Only
     stripped from the front of the leftover name, never from the middle — "add
     to the shopping list" has a real "add" in it. */
  var OPENERS = [
    'please', 'ok', 'okay', 'hey',
    'remind me to', 'remind me', 'reminder to', 'reminder',
    'add a task to', 'add a task', 'add task to', 'add task', 'add a', 'add',
    'create a task to', 'create a task', 'create task', 'create',
    'new task to', 'new task', 'task',
    'i need to', 'i have to', 'i want to', 'i should', 'need to',
    'make a note to', 'note to', 'set up', 'schedule'
  ];

  /* Words that mark the neighbouring token as a category name, whichever side
     they land on. Plurals included because the engine supplies them unasked. */
  var MARKER = { category: 1, categories: 1, list: 1, lists: 1 };

  // Words left stranded once the phrase around them has been claimed.
  var STRANDED = ['at', 'on', 'in', 'by', 'the', 'a', 'an', 'of', 'to', 'for',
    'and', 'this', 'next', 'every', 'repeat', 'repeating', 'starting', 'from',
    'category', 'categories', 'list'];

  // Politeness, which lands at the end rather than the start.
  var CLOSERS = ['please', 'thanks', 'thank you', 'cheers'];

  function pad(n) { return String(n).padStart(2, '0'); }

  function toISO(dt) {
    return dt.getFullYear() + '-' + pad(dt.getMonth() + 1) + '-' + pad(dt.getDate());
  }

  function addDays(dt, n) {
    var t = new Date(dt.getTime());
    t.setDate(t.getDate() + n);
    return t;
  }

  // Clamps to the last day of the target month, same as app.js addMonths().
  function addMonths(dt, n) {
    var day = dt.getDate();
    var t = new Date(dt.getFullYear(), dt.getMonth() + n, 1);
    var last = new Date(t.getFullYear(), t.getMonth() + 1, 0).getDate();
    t.setDate(Math.min(day, last));
    return t;
  }

  function midnight(d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }

  /* ─────────────────────────────────────────────────────────────
     Tokens

     Each token keeps the text as spoken and a normalised form for matching.
     Claimed tokens are marked rather than removed, so indexes stay stable
     across passes and the name can be rebuilt from whatever is left in the
     original word order.
     ───────────────────────────────────────────────────────────── */

  function tokenize(text) {
    var words = String(text || '').trim().split(/\s+/);
    var out = [];
    for (var i = 0; i < words.length; i++) {
      if (!words[i]) continue;
      out.push({
        raw: words[i],
        // Keep : and / — they carry "17:30" and "14/3". Drop everything else,
        // including the apostrophe in "o'clock" and any trailing comma.
        norm: words[i].toLowerCase().replace(/[^a-z0-9:/]/g, ''),
        used: false
      });
    }
    return out;
  }

  function tok(ts, i) { return (i >= 0 && i < ts.length && !ts[i].used) ? ts[i].norm : null; }

  function claim(ts, from, to) {
    for (var i = from; i < to && i < ts.length; i++) ts[i].used = true;
  }

  /* Reads a number written as digits or words, consuming up to two tokens so
     "twenty three" lands as 23. Returns null when the token isn't a number, so
     callers can use it as a test as well as a read. */
  function readNumber(ts, i, table) {
    var t = tok(ts, i);
    if (t === null) return null;

    if (/^\d{1,4}$/.test(t)) return { value: Number(t), next: i + 1 };
    // "3rd", "21st" — digits with an ordinal suffix
    var suffixed = /^(\d{1,2})(st|nd|rd|th)$/.exec(t);
    if (suffixed) return { value: Number(suffixed[1]), next: i + 1 };

    var tens = CARDINALS[t];
    if (tens >= 20 && tens % 10 === 0) {
      var second = tok(ts, i + 1);
      var unit = table[second];
      // "twenty three", "thirty first" — only single digits combine
      if (unit >= 1 && unit <= 9) return { value: tens + unit, next: i + 2 };
    }

    var direct = table[t];
    if (typeof direct === 'number') return { value: direct, next: i + 1 };
    return null;
  }

  function readCardinal(ts, i) { return readNumber(ts, i, CARDINALS); }
  function readOrdinal(ts, i) { return readNumber(ts, i, ORDINALS); }

  /* ─────────────────────────────────────────────────────────────
     Recurrence — runs first

     Before the date pass, so "every monday" is read as a weekly rule and
     leaves "monday" behind for the date pass to anchor it to. The model has no
     day-of-week rule, so a weekly repeat anchored to the next Monday is
     exactly how that sentence is represented.
     ───────────────────────────────────────────────────────────── */

  function parseRecurrence(ts) {
    for (var i = 0; i < ts.length; i++) {
      var t = tok(ts, i);
      if (t === null) continue;

      if (t === 'daily') { claim(ts, i, i + 1); return { type: 'custom', interval: 1, unit: 'day' }; }
      if (t === 'weekly') { claim(ts, i, i + 1); return { type: 'custom', interval: 1, unit: 'week' }; }
      if (t === 'monthly') { claim(ts, i, i + 1); return { type: 'custom', interval: 1, unit: 'month' }; }
      if (t === 'yearly' || t === 'annually') { claim(ts, i, i + 1); return { type: 'custom', interval: 1, unit: 'year' }; }
      if (t === 'fortnightly') { claim(ts, i, i + 1); return { type: 'custom', interval: 2, unit: 'week' }; }

      if (t === 'weekdays' || t === 'weekday') {
        // "every weekday" / "on weekdays" — swallow a preceding every/on
        var back = tok(ts, i - 1);
        claim(ts, (back === 'every' || back === 'on' || back === 'each') ? i - 1 : i, i + 1);
        return { type: 'workweek' };
      }

      if (t !== 'every' && t !== 'each') continue;

      // "every work day" / "every working day"
      var w1 = tok(ts, i + 1);
      if ((w1 === 'work' || w1 === 'working') && UNIT_WORDS[tok(ts, i + 2)] === 'day') {
        claim(ts, i, i + 3);
        return { type: 'workweek' };
      }

      // "every day", "every 3 weeks", "every other week", "every couple of days"
      var start = i + 1;
      if (tok(ts, start) === 'couple') start = tok(ts, start + 1) === 'of' ? start + 2 : start + 1;
      var n = readCardinal(ts, start);
      var unitAt = n ? n.next : start;
      var unit = UNIT_WORDS[tok(ts, unitAt)];
      if (unit) {
        var interval = n ? n.value : 1;
        if (interval >= 1 && interval <= 99) {
          claim(ts, i, unitAt + 1);
          return { type: 'custom', interval: interval, unit: unit };
        }
      }

      /* "every monday" — claim only the "every" and let the date pass take the
         weekday, which anchors the series to the right day. */
      if (WEEKDAYS.indexOf(tok(ts, i + 1)) !== -1) {
        claim(ts, i, i + 1);
        return { type: 'custom', interval: 1, unit: 'week' };
      }
    }
    return null;
  }

  /* ─────────────────────────────────────────────────────────────
     Time — runs before the date pass

     So that "at 5" is claimed as a time before "in 5 days" style matching can
     reach the digit.
     ───────────────────────────────────────────────────────────── */

  /* A bare hour has no meridiem, and guessing beats leaving it blank because
     the guess is shown in the sheet before it is saved. 1–6 reads as afternoon
     ("dinner at 6"), 7–11 as morning ("standup at 9"). The two-thirds of cases
     this gets right cost one tap to fix when it doesn't. */
  function guessHour(h) {
    if (h >= 1 && h <= 6) return h + 12;
    return h;
  }

  function applyMeridiem(h, mer) {
    if (mer === 'am') return h === 12 ? 0 : h;
    if (mer === 'pm') return h === 12 ? 12 : h + 12;
    return guessHour(h);
  }

  /* Vosk transcribes the spoken letters as "p m" about as often as "pm", so
     both spellings have to be read, and a two-token match must report how much
     it consumed. */
  /* "in the morning" / "at night" does a meridiem's job, and it is the natural
     fallback when "a m" keeps coming back as "eighty m" or "damn" — the words
     are long enough that the engine gets them right. Wired into the hour parse
     so "eight in the morning" is 08:00 rather than an hour with no meridiem
     and the phrase left littering the task name. */
  var DAY_PART_MERIDIEM = { morning: 'am', afternoon: 'pm', evening: 'pm', night: 'pm' };

  function readDayPart(ts, i) {
    var j = i;
    if (tok(ts, j) === 'in' || tok(ts, j) === 'at') j++;
    if (tok(ts, j) === 'the') j++;
    var mer = DAY_PART_MERIDIEM[tok(ts, j)];
    if (!mer) return null;
    return { value: mer, next: j + 1 };
  }

  function readMeridiem(ts, i) {
    var t = tok(ts, i);
    if (t === 'am' || t === 'pm') return { value: t, next: i + 1 };
    if (t === 'a' || t === 'p') {
      if (tok(ts, i + 1) === 'm') return { value: t + 'm', next: i + 2 };
    }
    // "o'clock" loses its apostrophe and often arrives as two tokens, "o" then
    // "clock". Carries no meridiem either way — it only marks the hour as read.
    if (t === 'oclock' || t === 'clock') return { value: null, next: i + 1 };
    if (t === 'o' && tok(ts, i + 1) === 'clock') return { value: null, next: i + 2 };
    return null;
  }

  function parseTime(ts) {
    for (var i = 0; i < ts.length; i++) {
      var t = tok(ts, i);
      if (t === null) continue;

      if (t === 'noon' || t === 'midday') { claim(ts, i, i + 1); return '12:00'; }
      if (t === 'midnight') { claim(ts, i, i + 1); return '00:00'; }

      /* "8 AM" comes back from Vosk as "eighty m" — the hour fuses with the
         "a" into a tens word and orphans the "m". This is not an occasional
         slip: it happened on every single AM dictation on the test device, so
         a parser that only understands "eight a m" finds no time at all, which
         is what it looked like from the outside.

         Safe to reinterpret because a lone "m" after a tens word is not
         something anyone says — "eighty metres" transcribes as "meters", not
         "m". Only the exact two-token shape triggers it. */
      var fused = FUSED_HOUR[t];
      if (fused) {
        var after = tok(ts, i + 1);
        var fusedMer = null;
        var fusedEnd = 0;
        if (after === 'm') { fusedMer = 'am'; fusedEnd = i + 2; }
        else if (after === 'p' && tok(ts, i + 2) === 'm') { fusedMer = 'pm'; fusedEnd = i + 3; }
        if (fusedMer) {
          var fusedLead = tok(ts, i - 1);
          var anchoredFused = fusedLead === 'at' || fusedLead === 'around' || fusedLead === 'by';
          claim(ts, anchoredFused ? i - 1 : i, fusedEnd);
          return pad(applyMeridiem(fused, fusedMer)) + ':00';
        }
      }

      /* "17:30", "5:30 pm", "5:30pm". The meridiem is glued to the digits as
         often as it is spaced, because whether it arrives as one token or two
         is down to the speech engine, not the speaker. */
      var hm = /^(\d{1,2}):(\d{2})(am|pm)?$/.exec(t);
      if (hm) {
        var hh = Number(hm[1]);
        var mm = Number(hm[2]);
        if (hh <= 23 && mm <= 59) {
          var glued = hm[3] || null;
          var mer = glued ? { value: glued, next: i + 1 } : readMeridiem(ts, i + 1);
          claim(ts, i, mer ? mer.next : i + 1);
          return pad(mer && mer.value ? applyMeridiem(hh % 12, mer.value) : hh) + ':' + pad(mm);
        }
      }

      // "5pm", "11am"
      var glue = /^(\d{1,2})(am|pm)$/.exec(t);
      if (glue && Number(glue[1]) <= 12) {
        var back = tok(ts, i - 1);
        claim(ts, (back === 'at' || back === 'around' || back === 'by') ? i - 1 : i, i + 1);
        return pad(applyMeridiem(Number(glue[1]), glue[2])) + ':00';
      }

      // "half past four", "quarter past four", "quarter to five"
      if (t === 'half' || t === 'quarter') {
        var rel = tok(ts, i + 1);
        if (rel === 'past' || rel === 'to') {
          var base = readCardinal(ts, i + 2);
          if (base && base.value >= 1 && base.value <= 12) {
            var mins = t === 'half' ? 30 : 15;
            var hour = base.value;
            if (rel === 'to') { mins = 60 - mins; hour = hour === 1 ? 12 : hour - 1; }
            var after = readMeridiem(ts, base.next);
            claim(ts, i, after ? after.next : base.next);
            return pad(applyMeridiem(hour, after && after.value)) + ':' + pad(mins);
          }
        }
      }

      /* A plain number is only a time when something says so — a preceding
         "at", or a following "pm"/"o'clock". Without that guard "buy 6 eggs"
         becomes a 6pm reminder. */
      var lead = tok(ts, i - 1);
      var num = readCardinal(ts, i);
      if (!num || num.value > 23) continue;

      var trailing = readMeridiem(ts, num.next);
      var anchored = lead === 'at' || lead === 'around' || lead === 'by';
      /* A period of day following the number anchors it just as well as "at"
         does — "haircut eight in the morning" is plainly a time, while "buy 6
         eggs" is plainly not, and the difference is exactly this lookahead. */
      if (!trailing && !anchored && !readDayPart(ts, num.next)) continue;

      // "at 5 30" — a bare two-digit minute right after the hour
      var minute = 0;
      var end = trailing ? trailing.next : num.next;
      if (!trailing) {
        var m2 = tok(ts, num.next);
        if (m2 && /^[0-5]\d$/.test(m2)) { minute = Number(m2); end = num.next + 1; }
        var late = readMeridiem(ts, end);
        if (late) { trailing = late; end = late.next; }
      }

      /* "eight in the morning", "five in the evening". Checked even when an
         o'clock was already read, since "eight o'clock at night" carries its
         meridiem here rather than in the o'clock. */
      if (!trailing || !trailing.value) {
        var period = readDayPart(ts, end);
        if (period) { trailing = period; end = period.next; }
      }

      claim(ts, anchored ? i - 1 : i, end);
      return pad(applyMeridiem(num.value, trailing && trailing.value)) + ':' + pad(minute);
    }
    return '';
  }

  /* Named parts of the day set a time only if nothing more specific did, and
     "tonight" also implies today — returned together so the date pass can use
     it. */
  function parseDayPart(ts) {
    for (var i = 0; i < ts.length; i++) {
      var t = tok(ts, i);
      if (t === null) continue;
      var lead = tok(ts, i - 1);
      var withThis = (lead === 'this' || lead === 'in' || lead === 'the') ? i - 1 : i;

      if (t === 'tonight') { claim(ts, i, i + 1); return { time: '20:00', today: true }; }
      if (t === 'morning') { claim(ts, withThis, i + 1); return { time: '09:00' }; }
      if (t === 'afternoon') { claim(ts, withThis, i + 1); return { time: '14:00' }; }
      if (t === 'evening') { claim(ts, withThis, i + 1); return { time: '18:00' }; }
    }
    return null;
  }

  /* ─────────────────────────────────────────────────────────────
     Date
     ───────────────────────────────────────────────────────────── */

  function nextWeekday(from, target, strictlyNext) {
    var diff = (target - from.getDay() + 7) % 7;
    if (diff === 0 && strictlyNext) diff = 7;
    return addDays(from, diff);
  }

  function parseDate(ts, now) {
    var today = midnight(now);

    for (var i = 0; i < ts.length; i++) {
      var t = tok(ts, i);
      if (t === null) continue;

      if (t === 'today') { claim(ts, i, i + 1); return toISO(today); }
      if (t === 'tomorrow') {
        // "day after tomorrow"
        if (tok(ts, i - 2) === 'day' && tok(ts, i - 1) === 'after') {
          claim(ts, i - 2, i + 1);
          return toISO(addDays(today, 2));
        }
        claim(ts, i, i + 1);
        return toISO(addDays(today, 1));
      }

      // "in 3 days", "in a week", "in two months"
      if (t === 'in' || t === 'after') {
        var n = readCardinal(ts, i + 1);
        if (n) {
          var unit = UNIT_WORDS[tok(ts, n.next)];
          if (unit) {
            claim(ts, i, n.next + 1);
            if (unit === 'day') return toISO(addDays(today, n.value));
            if (unit === 'week') return toISO(addDays(today, n.value * 7));
            if (unit === 'month') return toISO(addMonths(today, n.value));
            return toISO(addMonths(today, n.value * 12));
          }
        }
      }

      // "next week", "next month", "this week"
      if (t === 'next' || t === 'this') {
        var u = UNIT_WORDS[tok(ts, i + 1)];
        if (u === 'week' || u === 'month' || u === 'year') {
          claim(ts, i, i + 2);
          if (t === 'this') return toISO(today);
          if (u === 'week') return toISO(addDays(today, 7));
          if (u === 'month') return toISO(addMonths(today, 1));
          return toISO(addMonths(today, 12));
        }
      }

      // "monday", "next monday", "on friday"
      var wd = WEEKDAYS.indexOf(t);
      if (wd !== -1) {
        var before = tok(ts, i - 1);
        var strict = before === 'next';
        var from = (before === 'next' || before === 'this' || before === 'on' || before === 'coming') ? i - 1 : i;
        claim(ts, from, i + 1);
        return toISO(nextWeekday(today, wd, strict));
      }

      // "march 14", "march 14th"
      var mo = MONTHS.indexOf(t);
      if (mo !== -1) {
        var dayNum = readOrdinal(ts, i + 1) || readCardinal(ts, i + 1);
        if (dayNum && dayNum.value >= 1 && dayNum.value <= 31) {
          claim(ts, tok(ts, i - 1) === 'in' || tok(ts, i - 1) === 'on' ? i - 1 : i, dayNum.next);
          return toISO(resolveMonthDay(today, mo, dayNum.value));
        }
      }

      // "14 march", "the 14th of march"
      var lead = readOrdinal(ts, i) || readCardinal(ts, i);
      if (lead && lead.value >= 1 && lead.value <= 31) {
        var at = lead.next;
        if (tok(ts, at) === 'of') at += 1;
        var mo2 = MONTHS.indexOf(tok(ts, at));
        if (mo2 !== -1) {
          var pre = (tok(ts, i - 1) === 'the' || tok(ts, i - 1) === 'on') ? i - 1 : i;
          if (tok(ts, i - 2) === 'on' && tok(ts, i - 1) === 'the') pre = i - 2;
          claim(ts, pre, at + 1);
          return toISO(resolveMonthDay(today, mo2, lead.value));
        }
      }

      // "on the 3rd" — day of the current or next month
      if ((t === 'on' || t === 'the') && i + 1 < ts.length) {
        var start = t === 'on' && tok(ts, i + 1) === 'the' ? i + 2 : i + 1;
        var dayOnly = readOrdinal(ts, start);
        if (dayOnly && dayOnly.value >= 1 && dayOnly.value <= 31) {
          /* "on the 14th of december" reaches this branch at "on", before the
             day-month branch below ever sees the 14th. Look past the day for a
             month first, or the month is dropped and the date lands in the
             wrong one. */
          var monthAt = dayOnly.next;
          if (tok(ts, monthAt) === 'of') monthAt += 1;
          var named = MONTHS.indexOf(tok(ts, monthAt));
          if (named !== -1) {
            claim(ts, i, monthAt + 1);
            return toISO(resolveMonthDay(today, named, dayOnly.value));
          }
          claim(ts, i, dayOnly.next);
          return toISO(resolveMonthDay(today, today.getMonth(), dayOnly.value, true));
        }
      }
    }
    return '';
  }

  /* A bare month-day with no year means the next one that hasn't happened
     yet — "march 14" said in December is next March, not nine months ago. */
  function resolveMonthDay(today, monthIndex, day, rollMonth) {
    var candidate = new Date(today.getFullYear(), monthIndex, day);
    if (candidate.getMonth() !== monthIndex) {            // e.g. "february 30"
      candidate = new Date(today.getFullYear(), monthIndex + 1, 0);
    }
    if (candidate >= today) return candidate;
    return rollMonth
      ? addMonths(candidate, 1)
      : new Date(today.getFullYear() + 1, candidate.getMonth(), candidate.getDate());
  }

  /* ─────────────────────────────────────────────────────────────
     Category

     Matching an existing category always wins. Only when nothing matches may
     one be invented, and only from an explicitly marked form: "in X", "under
     X", "category X", "X category". Never from a bare trailing word, which is
     exactly where a mishearing lands. Recognition here is lossy enough that
     "under groceries" once came back as "Had it under groceries", and a
     category is a namespace: it shows in the drawer, the picker and every
     later match afterwards. So an invented one is shown in the sheet as
     "X (new)", and like everything else here it saves nothing on its own.
     ───────────────────────────────────────────────────────────── */

  /* Reduces a token to the letters and digits in it, which is the only part a
     speech engine can be expected to produce. Punctuation in a category name
     is invisible to the ear: "Anniversary / Birthday" is said "anniversary
     birthday", and comparing raw tokens made that category — the only one in
     the app it was built for — impossible to reach by voice. */
  function wordKey(text) {
    return String(text == null ? '' : text).toLowerCase().replace(/[^a-z0-9]/g, '');
  }

  /* Matches `want` against the tokens from `start`, skipping anything that
     carries no letters or digits so a stray comma or a literal "/" in the
     transcript cannot break the run. Returns the index just past the match, or
     -1. Stops at a claimed token: a category may not be read out of text the
     date or time pass has already taken. */
  function matchCategoryAt(ts, start, want) {
    var i = start;
    for (var w = 0; w < want.length; w++) {
      while (i < ts.length && tok(ts, i) !== null && !wordKey(tok(ts, i))) i++;
      var here = tok(ts, i);
      if (here === null || wordKey(here) !== want[w]) return -1;
      i++;
    }
    return i;
  }

  var MAX_INVENTED_WORDS = 3;

  /* May this token be part of a category name? STRANDED is already the filler
     list -- "the", "a", "at", "every", and the marker words themselves -- and a
     weekday, a month or a number is a date the earlier passes merely failed to
     claim, never a category anyone is asking for. */
  function isNameWord(ts, i) {
    var t = tok(ts, i);
    if (t === null || !wordKey(t)) return false;
    if (STRANDED.indexOf(t) !== -1) return false;
    if (WEEKDAYS.indexOf(t) !== -1 || MONTHS.indexOf(t) !== -1) return false;
    if (typeof CARDINALS[t] === 'number' || typeof ORDINALS[t] === 'number') return false;
    return !/^\d/.test(t);
  }

  // Would anything survive to name the task if [from, to) became the category?
  function hasNameLeft(ts, from, to) {
    for (var i = 0; i < ts.length; i++) {
      if (i >= from && i < to) continue;
      if (!ts[i].used && wordKey(ts[i].norm)) return true;
    }
    return false;
  }

  /* "in home improvement" — both edges are known, the marker on one side and
     the end of the sentence on the other, so the whole run can be taken. */
  function prefixedName(ts, i) {
    var words = [];
    var j = i + 1;
    while (words.length < MAX_INVENTED_WORDS && isNameWord(ts, j)) {
      words.push(wordKey(tok(ts, j)));
      j++;
    }
    if (!words.length) return null;

    /* Unless that would leave nothing to call the task: "in groceries buy
       milk" is a category and a task, not a three-word category. */
    if (!hasNameLeft(ts, i, j)) {
      words = words.slice(0, 1);
      j = i + 2;
      if (!hasNameLeft(ts, i, j)) return null;   // the category was all that was said
    }
    return { words: words, from: i, to: j };
  }

  /* "hygiene category" — only the near edge is known, so take exactly one
     word. Reaching back greedily through "get a haircut ... hygiene category"
     produces "Haircut Hygiene". */
  function suffixedName(ts, i) {
    if (!isNameWord(ts, i - 1)) return null;
    if (!hasNameLeft(ts, i - 1, i + 1)) return null;
    return { words: [wordKey(tok(ts, i - 1))], from: i - 1, to: i + 1 };
  }

  /* A partial mishearing of a multi-word category is the likeliest way a bad
     one gets created, and it lands right beside the real one — "in anniversary"
     against an existing "Anniversary / Birthday". Refuse rather than plant it;
     the words stay in the name, where the user can see what was heard. */
  function startsAnExisting(words, categories) {
    for (var c = 0; c < categories.length; c++) {
      var want = String(categories[c]).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
      if (want.length <= words.length) continue;
      var same = true;
      for (var w = 0; w < words.length; w++) {
        if (words[w] !== want[w]) { same = false; break; }
      }
      if (same) return true;
    }
    return false;
  }

  /* A transcript is all lowercase, and this name goes in the drawer next to
     ones that were typed by hand. */
  function titleCase(words) {
    return words.map(function (w) { return w.charAt(0).toUpperCase() + w.slice(1); }).join(' ');
  }

  function inventCategory(ts, categories) {
    var known = categories || [];

    for (var i = 0; i < ts.length; i++) {
      var t = tok(ts, i);
      if (t === null) continue;

      /* "in" and "under" only make sense ahead of the name; the MARKER words
         read as deliberate on either side, which is why matching already
         accepts both. */
      if (t !== 'in' && t !== 'under' && !MARKER[t]) continue;

      var found = prefixedName(ts, i);
      if (!found && MARKER[t]) found = suffixedName(ts, i);
      if (!found) continue;
      if (startsAnExisting(found.words, known)) continue;

      claim(ts, found.from, found.to);
      return titleCase(found.words);
    }
    return '';
  }

  function parseCategory(ts, categories) {
    // Longest first, so "work trips" wins over "work".
    var sorted = (categories || []).slice().sort(function (a, b) { return b.length - a.length; });

    for (var c = 0; c < sorted.length; c++) {
      /* Split on any run of non-alphanumerics rather than on whitespace, so
         "Anniversary / Birthday" and "Anniversary/Birthday" both reduce to the
         two words someone would actually say. */
      var want = String(sorted[c]).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
      if (!want.length) continue;   // a category of pure punctuation matches nothing

      for (var i = 0; i < ts.length; i++) {
        if (!wordKey(tok(ts, i))) continue;   // start on a real word

        var end = matchCategoryAt(ts, i, want);
        if (end === -1) continue;

        /* An unprefixed match has to be at the very end. Mid-sentence it is far
           more likely to be part of the task — "call work about the invoice"
           is not the Work category. */
        var lead = tok(ts, i - 1);
        var prefixed = MARKER[lead] || lead === 'in' || lead === 'under';

        /* The marker follows the name as often as it precedes it — people say
           "hygiene category" as readily as "category hygiene", and the engine
           pluralises it to "categories" about half the time. Either way it is
           a deliberate signal, so it counts the same as a prefix. */
        var suffixed = MARKER[tok(ts, end)];
        if (suffixed) end += 1;

        var trailing = end >= ts.length;
        if (!prefixed && !suffixed && !trailing) continue;
        if (!prefixed && !suffixed && i === 0) continue;   // whole utterance is the name

        claim(ts, prefixed ? i - 1 : i, end);
        return sorted[c];
      }
    }

    // Nothing known was said. A marked form may still be asking for a new one.
    return inventCategory(ts, categories);
  }

  /* ─────────────────────────────────────────────────────────────
     Name — whatever survived
     ───────────────────────────────────────────────────────────── */

  function buildName(ts) {
    var words = [];
    for (var i = 0; i < ts.length; i++) if (!ts[i].used) words.push(ts[i].raw);

    var name = words.join(' ')
      .replace(/\s*,\s*/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    // Strip openers repeatedly: "ok remind me to buy milk" has two.
    var changed = true;
    while (changed) {
      changed = false;
      for (var o = 0; o < OPENERS.length; o++) {
        var re = new RegExp('^' + OPENERS[o].replace(/ /g, '\\s+') + '\\b[\\s,]*', 'i');
        if (re.test(name)) { name = name.replace(re, ''); changed = true; }
      }
      for (var c = 0; c < CLOSERS.length; c++) {
        var tail = new RegExp('[\\s,]*\\b' + CLOSERS[c].replace(/ /g, '\\s+') + '[\\s.,!]*$', 'i');
        if (tail.test(name)) { name = name.replace(tail, ''); changed = true; }
      }
    }

    // Drop connectives left hanging where a phrase used to be.
    var parts = name.split(' ').filter(function (p) { return p.length; });
    while (parts.length && STRANDED.indexOf(parts[parts.length - 1].toLowerCase().replace(/[^a-z]/g, '')) !== -1) parts.pop();
    while (parts.length && STRANDED.indexOf(parts[0].toLowerCase().replace(/[^a-z]/g, '')) !== -1) parts.shift();

    name = parts.join(' ').replace(/[\s.,!?]+$/, '').trim();
    if (name) name = name.charAt(0).toUpperCase() + name.slice(1);
    return name.slice(0, MAX_NAME);
  }

  /* ─────────────────────────────────────────────────────────────
     Entry point
     ───────────────────────────────────────────────────────────── */

  /* opts.categories — the live list from allCategories(). A spoken category
                       resolves to one of these wherever it can, and is only
                       invented when nothing matches and the form was marked.
     opts.now        — injectable clock; the tests pin it, callers omit it. */
  function parse(transcript, opts) {
    opts = opts || {};
    var now = opts.now || new Date();
    var ts = tokenize(transcript);

    var recurrence = parseRecurrence(ts);
    var time = parseTime(ts);
    var dayPart = parseDayPart(ts);
    if (!time && dayPart) time = dayPart.time;

    var date = parseDate(ts, now);
    if (!date && dayPart && dayPart.today) date = toISO(midnight(now));

    var category = parseCategory(ts, opts.categories);
    var name = buildName(ts);

    /* A recurrence with no date can't be saved — saveTask() rejects it with
       "Pick a date to repeat from." Anchoring it to today is what the user
       meant by "every week" with no start, and it keeps the sheet in a state
       that can be saved without an error the user has to decode. */
    if (recurrence && !date) date = toISO(midnight(now));

    return {
      name: name,
      date: date,
      time: time,
      category: String(category || '').slice(0, MAX_CATEGORY),
      recurrence: recurrence
    };
  }

  /* Unlike the other files here this one touches no DOM at all, which is the
     point of keeping it separate — the suite can require() it straight into
     Node and test the parse table without standing up jsdom. Hence both doors,
     and a guarded `window` so the CommonJS one works with no browser globals. */
  if (typeof window !== 'undefined') window.TodoNLU = { parse: parse };
  if (typeof module === 'object' && module.exports) module.exports = { parse: parse };
})();
