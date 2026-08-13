package com.sanjkv.todo;

import android.content.Context;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;

/**
 * The task document on disk: one JSON file in the app's private storage.
 *
 * <p>Deliberately free of Capacitor imports. The plugin is one caller; a
 * background receiver acting on a notification is meant to be another, and it
 * has a Context but no bridge. Strings in, strings out — the schema lives in
 * the web layer.
 *
 * <p>java.io only, never java.nio.file: minSdk here is 24, Files arrived in 26,
 * and core library desugaring is not enabled, so Files compiles cleanly and
 * then throws NoClassDefFoundError on a real API 24 device.
 */
public final class TaskStore {

    private static final String FILE_NAME = "tasks.json";
    private static final String TMP_NAME = "tasks.json.tmp";
    private static final String BAK_NAME = "tasks.json.bak";

    /** Serialises writers inside this process. See the note on write(). */
    private static final Object LOCK = new Object();

    private TaskStore() {}

    public static File file(Context context) {
        return new File(context.getFilesDir(), FILE_NAME);
    }

    /** The stored document, or null if nothing has been written yet. */
    public static String read(Context context) throws IOException {
        synchronized (LOCK) {
            File target = file(context);
            if (!target.exists()) {
                return null;
            }

            FileInputStream in = new FileInputStream(target);
            try {
                ByteArrayOutputStream out = new ByteArrayOutputStream();
                byte[] buffer = new byte[8192];
                int read;
                while ((read = in.read(buffer)) != -1) {
                    out.write(buffer, 0, read);
                }
                return new String(out.toByteArray(), StandardCharsets.UTF_8);
            } finally {
                closeQuietly(in);
            }
        }
    }

    /**
     * Replaces the document atomically.
     *
     * <p>Writes a temporary file, forces it to disk, moves the current document
     * aside as .bak and only then renames the temporary file into place. A kill
     * at any point leaves either the old document or the new one — never a
     * half-written list. The .bak it leaves behind is the last good copy, which
     * is what makes a corrupt read recoverable.
     *
     * <p>The lock only orders writers within this process. That is enough while
     * the WebView and any future receiver share one process; a receiver running
     * under android:process would need a FileChannel lock instead.
     */
    public static void write(Context context, String text) throws IOException {
        synchronized (LOCK) {
            File dir = context.getFilesDir();
            File target = new File(dir, FILE_NAME);
            File tmp = new File(dir, TMP_NAME);
            File bak = new File(dir, BAK_NAME);

            FileOutputStream out = new FileOutputStream(tmp);
            try {
                out.write(text.getBytes(StandardCharsets.UTF_8));
                out.flush();
                out.getFD().sync();
            } finally {
                closeQuietly(out);
            }

            // renameTo reports failure by returning false rather than throwing,
            // so every hop is checked or the corruption is silent.
            boolean rotated = false;
            if (target.exists()) {
                deleteQuietly(bak);
                rotated = target.renameTo(bak);
                if (!rotated) {
                    deleteQuietly(tmp);
                    throw new IOException("Could not rotate " + FILE_NAME + " aside");
                }
            }

            if (!tmp.renameTo(target)) {
                // Put the previous document back rather than leaving none at all.
                if (rotated) {
                    bak.renameTo(target);
                }
                deleteQuietly(tmp);
                throw new IOException("Could not move the new " + FILE_NAME + " into place");
            }
        }
    }

    private static void deleteQuietly(File file) {
        if (file.exists()) {
            //noinspection ResultOfMethodCallIgnored
            file.delete();
        }
    }

    private static void closeQuietly(java.io.Closeable closeable) {
        try {
            closeable.close();
        } catch (IOException ignored) {
            // Nothing useful to do; the caller already has its result or its throw.
        }
    }
}
