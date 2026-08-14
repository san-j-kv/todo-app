package com.sanjkv.todo;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.util.Log;

import androidx.core.app.NotificationManagerCompat;

import com.capacitorjs.plugins.localnotifications.LocalNotification;
import com.capacitorjs.plugins.localnotifications.LocalNotificationManager;
import com.capacitorjs.plugins.localnotifications.NotificationStorage;
import com.getcapacitor.CapConfig;
import com.getcapacitor.JSObject;

import org.json.JSONArray;
import org.json.JSONObject;

import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.List;
import java.util.Locale;
import java.util.TimeZone;
import java.util.UUID;

/**
 * "Mark done", handled without the app appearing.
 *
 * <p>Reached by the broadcast that patches/@capacitor+local-notifications+8.2.1
 * .patch routes notification action buttons to. Upstream builds every action
 * button as a PendingIntent.getActivity into MainActivity, so the only way to
 * act on one is to launch the UI; `foreground:false` is an iOS-only flag and
 * Android's NotificationAction has no equivalent field.
 *
 * <p>What it does is a transcription of toggleComplete() in www/app.js: a
 * one-off is marked complete, and a recurring task has this occurrence archived
 * as a completed copy while the live task rolls to its next date, keeping its
 * notifId so the reminder is rescheduled rather than cancelled and re-armed.
 * The next alarm is then armed here, so a repeating reminder survives even if
 * the app is never opened again.
 *
 * <p>No android:process in the manifest entry, deliberately: TaskStore's lock
 * only orders writers inside one process, and this receiver is the second
 * writer it was designed for.
 */
public class TaskActionReceiver extends BroadcastReceiver {

    private static final String TAG = "TaskActionReceiver";
    private static final String DONE_ACTION = "done";

    /** Mirrors the wrap in nextNotifId(), www/app.js. */
    private static final int NOTIF_SEQ_MAX = 2147483000;

    @Override
    public void onReceive(Context context, Intent intent) {
        String action = intent.getStringExtra(LocalNotificationManager.ACTION_INTENT_KEY);
        if (!DONE_ACTION.equals(action)) {
            // Every other button — and there are none today — is not ours to handle.
            return;
        }

        final int notifId = intent.getIntExtra(LocalNotificationManager.NOTIFICATION_INTENT_KEY, Integer.MIN_VALUE);
        final String source = intent.getStringExtra(LocalNotificationManager.NOTIFICATION_OBJ_INTENT_KEY);
        if (notifId == Integer.MIN_VALUE || source == null) {
            Log.e(TAG, "Mark done arrived with no notification attached");
            return;
        }

        // Reading and rewriting the document is file I/O, which onReceive must
        // not do on the main thread. goAsync() keeps the process alive for it.
        final Context app = context.getApplicationContext();
        final PendingResult pending = goAsync();

        new Thread(
            new Runnable() {
                @Override
                public void run() {
                    try {
                        complete(app, notifId, source);
                    } catch (Exception e) {
                        // A failure here must not take the process down: the app
                        // reconciles from the document the next time it opens.
                        Log.e(TAG, "Could not complete the task in the background", e);
                    } finally {
                        pending.finish();
                    }
                }
            },
            TAG
        )
            .start();
    }

    private static void complete(Context context, int notifId, String source) throws Exception {
        JSObject notification = new JSObject(source);
        JSObject extra = notification.getJSObject("extra");
        String taskId = extra == null ? null : extra.getString("taskId");

        String stored = taskId == null ? null : TaskStore.read(context);
        JSONObject doc = stored == null ? null : new JSONObject(stored);
        JSONArray list = doc == null ? null : doc.optJSONArray("tasks");
        JSONObject task = list == null ? null : findTask(list, taskId);

        // Nothing to do, but the banner still has to go — the user tapped it.
        if (task == null || task.optBoolean("completed", false)) {
            dismiss(context, notifId);
            return;
        }

        long now = System.currentTimeMillis();
        String nowIso = isoInstant(now);
        Recurrence.Rule rule = Recurrence.Rule.from(task.optJSONObject("recurrence"));
        String date = task.optString("date", "");
        String time = task.optString("time", "");

        String next = (rule != null && !date.isEmpty()) ? Recurrence.rollForward(date, time, rule, now) : null;

        if (next != null) {
            int seq = doc.optInt("notifSeq", 0);
            seq = seq >= NOTIF_SEQ_MAX ? 1 : seq + 1;

            JSONObject archived = new JSONObject();
            archived.put("id", UUID.randomUUID().toString());
            archived.put("name", task.optString("name", ""));
            archived.put("date", date);
            archived.put("time", time);
            archived.put("day", task.optString("day", ""));
            archived.put("category", task.optString("category", ""));
            archived.put("completed", true);
            archived.put("completedAt", nowIso);
            archived.put("recurrence", JSONObject.NULL);
            archived.put("notifId", seq);
            list.put(archived);

            task.put("date", next);
            task.put("day", Recurrence.dayName(next));
            doc.put("notifSeq", seq);
        } else {
            task.put("completed", true);
            task.put("completedAt", nowIso);
        }

        doc.put("updatedAt", nowIso);
        TaskStore.write(context, doc.toString());

        // The banner goes either way. rearm() would clear it too, but only once
        // it has got as far as scheduling.
        dismiss(context, notifId);

        // rollForward() picks the date by end-of-day; the alarm needs the date
        // whose *reminder* time is still ahead, which is not always the same one.
        Long at = next == null ? null : Recurrence.nextFutureNotifyMs(next, time, rule, now);
        if (at != null) {
            rearm(context, notification, at);
        }

        TodoStorePlugin.notifyChanged();
    }

    private static JSONObject findTask(JSONArray list, String taskId) {
        for (int i = 0; i < list.length(); i++) {
            JSONObject candidate = list.optJSONObject(i);
            if (candidate != null && taskId.equals(candidate.optString("id", null))) {
                return candidate;
            }
        }
        return null;
    }

    /**
     * Arms the next occurrence off the notification that was just acted on, so
     * the title, body, channel, icon and action type all carry over untouched.
     */
    private static void rearm(Context context, JSObject source, long at) {
        try {
            JSObject copy = new JSObject(source.toString());
            JSObject schedule = copy.getJSObject("schedule");
            if (schedule == null) {
                schedule = new JSObject();
            }
            // The exact shape LocalNotificationSchedule parses, UTC included.
            schedule.put("at", isoInstant(at));
            copy.put("schedule", schedule);

            List<LocalNotification> list = new ArrayList<>(1);
            list.add(LocalNotification.buildNotificationFromJSObject(copy));

            NotificationStorage storage = new NotificationStorage(context);
            LocalNotificationManager manager = new LocalNotificationManager(
                storage,
                null, // no Activity from a receiver; LocalNotificationRestoreReceiver does the same
                context,
                CapConfig.loadDefault(context)
            );
            manager.schedule(null, list);
            // schedule() arms the alarm but records nothing. The plugin's own
            // schedule() appends separately, and getPending() — which the web
            // layer diffs against on the next sync — reads that record.
            storage.appendNotifications(list);
        } catch (Exception e) {
            // The reminder is lost until the app is next opened, which re-arms
            // everything from scratch. Worth a log line, not a crash.
            Log.e(TAG, "Could not arm the next reminder", e);
        }
    }

    private static void dismiss(Context context, int notifId) {
        NotificationManagerCompat.from(context).cancel(notifId);
        new NotificationStorage(context).deleteNotification(String.valueOf(notifId));
    }

    /** What Date.prototype.toISOString() produces, which is what the document holds. */
    private static String isoInstant(long ms) {
        SimpleDateFormat format = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US);
        format.setTimeZone(TimeZone.getTimeZone("UTC"));
        return format.format(new Date(ms));
    }
}
