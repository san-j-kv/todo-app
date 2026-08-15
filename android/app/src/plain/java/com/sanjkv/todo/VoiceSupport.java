package com.sanjkv.todo;

import android.content.Context;

import com.getcapacitor.BridgeActivity;

import java.io.File;

/**
 * Plain flavour: no voice, and it clears up after the voice flavour.
 *
 * <p>The counterpart to the version in {@code src/voice}. With this on the
 * source path the build has no Vosk dependency, no VoicePlugin and no bundled
 * model, which is the whole point of the flavour — the plain APK is the app as
 * it was before voice existed, around 4 MB rather than 50.
 *
 * <p>Nothing else needs a conditional. The web layer already asks the bridge
 * whether a TodoVoice plugin exists and hides the microphone button when it
 * does not, which is the same path a desktop browser takes.
 */
final class VoiceSupport {

    /**
     * Where the voice flavour leaves its unpacked model, and the reason this
     * class does anything at all.
     *
     * <p>Installing plain over voice is an in-place update, not an uninstall —
     * that is what preserves the task list, and it is also why Android does not
     * clear {@code Android/data/<pkg>}. So the ~54 MB Vosk extracted on first
     * use would survive the downgrade forever, and someone switching back
     * precisely to reclaim space would get almost none of it back.
     *
     * <p>Must match {@code MODEL_TARGET} in the voice flavour's VoicePlugin.
     * Vosk's StorageService builds {@code new File(getExternalFilesDir(null),
     * targetPath)} and unpacks beneath it, so this directory is entirely
     * Vosk's and can go wholesale.
     */
    private static final String MODEL_DIR = "model";

    private VoiceSupport() {}

    static void register(BridgeActivity activity) {
        // No plugin to register in this flavour; only the tidy-up.
        reclaimModelSpace(activity);
    }

    /**
     * Deletes a model left behind by the voice flavour, if there is one.
     *
     * <p>Runs on a background thread: it is a handful of files rather than
     * thousands, but this is called from onCreate and external storage can be
     * slow, and nothing waits on the result. Cheap when there is nothing to do,
     * which is every launch after the first — an {@code isDirectory()} check
     * and then it is finished.
     */
    private static void reclaimModelSpace(Context context) {
        // Null when external storage is unmounted or unavailable; there is
        // nothing to reclaim in that case and it is not an error.
        File external = context.getExternalFilesDir(null);
        if (external == null) {
            return;
        }

        final File model = new File(external, MODEL_DIR);
        if (!model.isDirectory()) {
            return;
        }

        Thread cleaner = new Thread(new Runnable() {
            @Override
            public void run() {
                deleteTree(model);
            }
        }, "voice-model-cleanup");
        cleaner.setPriority(Thread.MIN_PRIORITY);
        cleaner.start();
    }

    /**
     * Recursive delete, depth first. Package-private so the plain flavour's
     * unit test can drive it against a temporary directory without a Context.
     *
     * <p>Follows symlinks, as {@code File.listFiles()} does. Acceptable here
     * because the tree is one this app's other flavour created inside its own
     * external files directory; it is not a general-purpose utility.
     *
     * @return whether {@code file} itself is gone afterwards
     */
    static boolean deleteTree(File file) {
        // Null for a regular file, and for a directory that cannot be read.
        File[] children = file.listFiles();
        if (children != null) {
            for (File child : children) {
                deleteTree(child);
            }
        }
        return file.delete();
    }
}
