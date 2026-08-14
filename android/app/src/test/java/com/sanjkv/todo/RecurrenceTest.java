package com.sanjkv.todo;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

import java.util.Calendar;

/**
 * Guards the Java transcription of the recurrence rules in www/app.js and
 * www/notify.js.
 *
 * <p>The jsdom suite cannot see TaskActionReceiver or the code under it, so this
 * is the only thing standing between a change in the web layer's rules and a
 * background "Mark done" that rolls a task onto the wrong date. Run with
 * {@code cd android && ./gradlew testDebugUnitTest}.
 */
public class RecurrenceTest {

    private static Recurrence.Rule workweek() {
        return new Recurrence.Rule("workweek", 0, "");
    }

    private static Recurrence.Rule every(int interval, String unit) {
        return new Recurrence.Rule("custom", interval, unit);
    }

    private static long at(String iso, int hour, int minute) {
        Calendar c = Recurrence.parseLocal(iso);
        c.set(Calendar.HOUR_OF_DAY, hour);
        c.set(Calendar.MINUTE, minute);
        return c.getTimeInMillis();
    }

    // ── parsing ──────────────────────────────────────────────────────

    @Test
    public void rejectsDatesThatLookRealButAreNot() {
        assertNull("2026-02-30 is not a date", Recurrence.parseLocal("2026-02-30"));
        assertNull("month 13 is not a date", Recurrence.parseLocal("2026-13-01"));
        assertNull(Recurrence.parseLocal("not-a-date"));
        assertNull(Recurrence.parseLocal(null));
        assertEquals("2026-02-28", Recurrence.toISO(Recurrence.parseLocal("2026-02-28")));
    }

    @Test
    public void leapDayIsARealDate() {
        assertEquals("2028-02-29", Recurrence.toISO(Recurrence.parseLocal("2028-02-29")));
        assertNull("2027 is not a leap year", Recurrence.parseLocal("2027-02-29"));
    }

    // ── nextOccurrence ───────────────────────────────────────────────

    @Test
    public void workweekSkipsTheWeekend() {
        // 2026-08-14 is a Friday.
        assertEquals("Friday rolls to Monday", "2026-08-17", Recurrence.nextOccurrence("2026-08-14", workweek()));
        assertEquals("Monday rolls to Tuesday", "2026-08-18", Recurrence.nextOccurrence("2026-08-17", workweek()));
        // From a weekend date it still lands on the next weekday.
        assertEquals("Saturday rolls to Monday", "2026-08-17", Recurrence.nextOccurrence("2026-08-15", workweek()));
        assertEquals("Sunday rolls to Monday", "2026-08-17", Recurrence.nextOccurrence("2026-08-16", workweek()));
    }

    @Test
    public void customIntervalsAdvanceByUnit() {
        assertEquals("2026-08-15", Recurrence.nextOccurrence("2026-08-14", every(1, "day")));
        assertEquals("2026-08-17", Recurrence.nextOccurrence("2026-08-14", every(3, "day")));
        assertEquals("2026-08-21", Recurrence.nextOccurrence("2026-08-14", every(1, "week")));
        assertEquals("2026-08-28", Recurrence.nextOccurrence("2026-08-14", every(2, "week")));
        assertEquals("2026-09-14", Recurrence.nextOccurrence("2026-08-14", every(1, "month")));
        assertEquals("2027-08-14", Recurrence.nextOccurrence("2026-08-14", every(1, "year")));
    }

    @Test
    public void monthsClampToTheEndOfTheTargetMonth() {
        // The behaviour addMonths() in app.js documents.
        assertEquals("Jan 31 + 1 month is Feb 28", "2026-02-28", Recurrence.nextOccurrence("2026-01-31", every(1, "month")));
        assertEquals("and Feb 29 in a leap year", "2028-02-29", Recurrence.nextOccurrence("2028-01-31", every(1, "month")));
        assertEquals("Mar 31 + 1 month is Apr 30", "2026-04-30", Recurrence.nextOccurrence("2026-03-31", every(1, "month")));
        assertEquals("a leap day + 1 year is Feb 28", "2029-02-28", Recurrence.nextOccurrence("2028-02-29", every(1, "year")));
    }

    @Test
    public void anUnusableRuleYieldsNothing() {
        assertNull(Recurrence.nextOccurrence("2026-08-14", null));
        assertNull("interval 0 would never advance", Recurrence.nextOccurrence("2026-08-14", every(0, "day")));
        assertNull(Recurrence.nextOccurrence("2026-08-14", every(1, "fortnight")));
        assertNull(Recurrence.nextOccurrence("2026-08-14", new Recurrence.Rule("nonsense", 1, "day")));
        assertNull(Recurrence.nextOccurrence("nope", every(1, "day")));
    }

    // ── rollForward ──────────────────────────────────────────────────

    @Test
    public void rollForwardTakesTheNextOccurrenceWhenItIsAlreadyAhead() {
        long now = at("2026-08-14", 9, 0);
        assertEquals("2026-08-15", Recurrence.rollForward("2026-08-14", "09:00", every(1, "day"), now));
    }

    @Test
    public void rollForwardWalksPastAStaleSeries() {
        // Six weeks of unchecked dailies must not land on another past date.
        long now = at("2026-08-14", 9, 0);
        String next = Recurrence.rollForward("2026-07-01", "09:00", every(1, "day"), now);
        assertEquals("2026-08-15", next);

        String weekly = Recurrence.rollForward("2026-07-01", "09:00", every(1, "week"), now);
        assertTrue("a weekly series lands in the future", Recurrence.msFor(weekly, "09:00") > now);
        assertEquals("2026-08-19", weekly);
    }

    @Test
    public void rollForwardUsesEndOfDayWhenThereIsNoTime() {
        // msFor() semantics: today at 23:59 still counts as ahead of 09:00 today.
        long now = at("2026-08-14", 9, 0);
        assertEquals("2026-08-15", Recurrence.rollForward("2026-08-14", "", every(1, "day"), now));
        assertEquals("today is still 'ahead' with no time set", "2026-08-14", Recurrence.rollForward("2026-08-13", "", every(1, "day"), now));
    }

    // ── nextFutureNotifyMs ───────────────────────────────────────────

    @Test
    public void notifyTimeDefaultsToEightNotEndOfDay() {
        long now = at("2026-08-14", 6, 0);
        long armed = Recurrence.nextFutureNotifyMs("2026-08-14", "", every(1, "day"), now);
        assertEquals("08:00 on the day itself", at("2026-08-14", 8, 0), armed);
    }

    @Test
    public void theTwoTimeRulesDisagreeAndBothAreRight() {
        // 10:00 on the 14th: 23:59 today is still ahead, but 08:00 today has gone.
        // rollForward stores today; the alarm has to be tomorrow, and conflating
        // the two would arm an instant in the past, which the plugin drops.
        long now = at("2026-08-14", 10, 0);

        String stored = Recurrence.rollForward("2026-08-13", "", every(1, "day"), now);
        assertEquals("2026-08-14", stored);

        long armed = Recurrence.nextFutureNotifyMs(stored, "", every(1, "day"), now);
        assertEquals("08:00 tomorrow, not today", at("2026-08-15", 8, 0), armed);
        assertTrue("and it is genuinely in the future", armed > now);
    }

    @Test
    public void aPastOneOffArmsNothing() {
        long now = at("2026-08-14", 10, 0);
        assertNull(Recurrence.nextFutureNotifyMs("2026-08-13", "09:00", null, now));
        assertEquals(at("2026-08-15", 9, 0), (long) Recurrence.nextFutureNotifyMs("2026-08-15", "09:00", null, now));
    }

    @Test
    public void aStaleWorkweekSeriesArmsOnAWeekday() {
        long now = at("2026-08-14", 10, 0); // a Friday, after the 09:00 reminder
        long armed = Recurrence.nextFutureNotifyMs("2026-08-14", "09:00", workweek(), now);
        assertEquals("the next one is Monday", at("2026-08-17", 9, 0), armed);
    }

    // ── the JSON hop ─────────────────────────────────────────────────

    @Test
    public void aMissingRuleReadsAsNoRule() {
        assertNull(Recurrence.Rule.from(null));
    }

    @Test
    public void dayNameIsNotEmptyForARealDate() {
        assertTrue(Recurrence.dayName("2026-08-14").length() > 0);
        assertEquals("", Recurrence.dayName("2026-02-30"));
    }
}
