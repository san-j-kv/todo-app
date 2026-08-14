package com.sanjkv.todo;

import org.json.JSONObject;

import java.text.SimpleDateFormat;
import java.util.Calendar;
import java.util.Locale;
import java.util.regex.Pattern;

/* Deliberately no android.* import below: everything here is plain Java so the
   JVM unit suite can exercise it directly. The one org.json touch is confined
   to Rule.from(). */

/**
 * The recurrence rules, in Java, for the code paths that run with no WebView.
 *
 * <p>A deliberate mirror of the web layer: {@code nextOccurrence()} and
 * {@code rollForward()} in www/app.js, and {@code notifyMsFor()} /
 * {@code nextFutureMs()} in www/notify.js. Anything changed there has to change
 * here, which is what RecurrenceTest is for — the jsdom suite cannot see this
 * file at all.
 *
 * <p>java.util.Calendar, never java.time: minSdk here is 24, java.time arrived
 * in 26 and core library desugaring is not enabled, so LocalDate compiles
 * cleanly and then throws NoClassDefFoundError on a real API 24 device. The same
 * trap TaskStore documents for java.nio.file. Calendar.add(MONTH, n) already
 * clamps Jan 31 + 1 month to Feb 28, which is what addMonths() in app.js does.
 */
final class Recurrence {

    private static final Pattern DATE_RE = Pattern.compile("^\\d{4}-\\d{2}-\\d{2}$");
    private static final Pattern TIME_RE = Pattern.compile("^([01]\\d|2[0-3]):[0-5]\\d$");

    /** Walking a recurrence forward is bounded, same as MAX_ROLL in app.js. */
    private static final int MAX_ROLL = 500;

    private Recurrence() {}

    /**
     * A recurrence rule, lifted out of the stored JSON.
     *
     * <p>The rest of this class takes one of these rather than a JSONObject so
     * the math can be unit-tested on a plain JVM — org.json in a local unit test
     * is the un-mocked android.jar stub, which throws on every call.
     */
    static final class Rule {

        final String type;
        final int interval;
        final String unit;

        Rule(String type, int interval, String unit) {
            this.type = type;
            this.interval = interval;
            this.unit = unit;
        }

        /** Null in, null out — a task with no recurrence is the common case. */
        static Rule from(JSONObject json) {
            if (json == null) {
                return null;
            }
            return new Rule(json.optString("type", ""), json.optInt("interval", 0), json.optString("unit", ""));
        }
    }

    /**
     * Midnight local on that date, or null if the string is not a real date.
     * Built from parts like parseLocal() in app.js, so "2026-02-30" is rejected
     * rather than silently rolling into March.
     */
    static Calendar parseLocal(String iso) {
        if (iso == null || !DATE_RE.matcher(iso).matches()) {
            return null;
        }
        Calendar c = Calendar.getInstance();
        c.clear();
        c.setLenient(false);
        try {
            c.set(
                Integer.parseInt(iso.substring(0, 4)),
                Integer.parseInt(iso.substring(5, 7)) - 1,
                Integer.parseInt(iso.substring(8, 10))
            );
            c.getTimeInMillis(); // setLenient(false) only bites once the fields are read
        } catch (RuntimeException impossibleDate) {
            return null;
        }
        c.setLenient(true); // add() past a month end is arithmetic, not a typo
        return c;
    }

    static String toISO(Calendar c) {
        return String.format(
            Locale.US,
            "%04d-%02d-%02d",
            c.get(Calendar.YEAR),
            c.get(Calendar.MONTH) + 1,
            c.get(Calendar.DAY_OF_MONTH)
        );
    }

    /** The weekday name, as dayName() in app.js renders it. */
    static String dayName(String iso) {
        Calendar c = parseLocal(iso);
        if (c == null) {
            return "";
        }
        return new SimpleDateFormat("EEEE", Locale.getDefault()).format(c.getTime());
    }

    /**
     * Mirrors msFor() in app.js: a missing time means the end of that day. Used
     * to pick which occurrence is "next", never to set an alarm.
     */
    static long msFor(String iso, String time) {
        Calendar c = parseLocal(iso);
        if (c == null) {
            return Long.MAX_VALUE;
        }
        applyTime(c, time, 23, 59, 59, 999);
        return c.getTimeInMillis();
    }

    /**
     * Mirrors notifyMsFor() in notify.js: a missing time means 08:00. Used to
     * set an alarm, never to pick an occurrence.
     *
     * <p>The 08:00-versus-23:59 split is the whole reason these are two methods.
     * A dateless-time task can roll onto a date whose 23:59 is still ahead while
     * its 08:00 has already gone, and arming that instant is a no-op the plugin
     * only reports to logcat.
     */
    static Long notifyMsFor(String iso, String time) {
        Calendar c = parseLocal(iso);
        if (c == null) {
            return null;
        }
        applyTime(c, time, 8, 0, 0, 0);
        return c.getTimeInMillis();
    }

    private static void applyTime(Calendar c, String time, int hour, int minute, int second, int ms) {
        if (time != null && TIME_RE.matcher(time).matches()) {
            c.set(Calendar.HOUR_OF_DAY, Integer.parseInt(time.substring(0, 2)));
            c.set(Calendar.MINUTE, Integer.parseInt(time.substring(3, 5)));
            c.set(Calendar.SECOND, 0);
            c.set(Calendar.MILLISECOND, 0);
        } else {
            c.set(Calendar.HOUR_OF_DAY, hour);
            c.set(Calendar.MINUTE, minute);
            c.set(Calendar.SECOND, second);
            c.set(Calendar.MILLISECOND, ms);
        }
    }

    /** The date after this one under the rule, or null if the rule is unusable. */
    static String nextOccurrence(String iso, Rule rule) {
        Calendar c = parseLocal(iso);
        if (c == null || rule == null) {
            return null;
        }
        String type = rule.type;

        if ("workweek".equals(type)) {
            c.add(Calendar.DAY_OF_MONTH, 1);
            while (c.get(Calendar.DAY_OF_WEEK) == Calendar.SUNDAY || c.get(Calendar.DAY_OF_WEEK) == Calendar.SATURDAY) {
                c.add(Calendar.DAY_OF_MONTH, 1);
            }
            return toISO(c);
        }

        if ("custom".equals(type)) {
            int n = rule.interval;
            // Guarded rather than mirrored: app.js leans on normalizeRecurrence()
            // to bound this, and an interval of 0 would spin rollForward() for
            // MAX_ROLL turns without ever moving the date.
            if (n < 1) {
                return null;
            }
            String unit = rule.unit;
            if ("day".equals(unit)) {
                c.add(Calendar.DAY_OF_MONTH, n);
                return toISO(c);
            }
            if ("week".equals(unit)) {
                c.add(Calendar.DAY_OF_MONTH, n * 7);
                return toISO(c);
            }
            if ("month".equals(unit)) {
                c.add(Calendar.MONTH, n);
                return toISO(c);
            }
            if ("year".equals(unit)) {
                c.add(Calendar.MONTH, n * 12);
                return toISO(c);
            }
        }
        return null;
    }

    /**
     * The occurrence to store next, mirroring rollForward() in app.js: advance
     * past now so a task left unchecked for weeks doesn't land on another past
     * date. Returns null when the rule yields nothing.
     */
    static String rollForward(String iso, String time, Rule rule, long now) {
        String current = iso;
        for (int i = 0; i < MAX_ROLL; i++) {
            String next = nextOccurrence(current, rule);
            if (next == null) {
                return null;
            }
            current = next;
            if (msFor(current, time) > now) {
                break;
            }
        }
        return current;
    }

    /**
     * The instant to arm, mirroring nextFutureMs() in notify.js: the first
     * occurrence from this date whose reminder time is still ahead. Null means
     * there is nothing to arm.
     */
    static Long nextFutureNotifyMs(String iso, String time, Rule rule, long now) {
        Long ms = notifyMsFor(iso, time);
        if (ms == null) {
            return null;
        }
        if (ms > now) {
            return ms;
        }
        if (rule == null) {
            return null;
        }

        String current = iso;
        for (int i = 0; i < MAX_ROLL; i++) {
            String next = nextOccurrence(current, rule);
            if (next == null) {
                return null;
            }
            current = next;
            ms = notifyMsFor(current, time);
            if (ms == null) {
                return null;
            }
            if (ms > now) {
                return ms;
            }
        }
        return null;
    }
}
