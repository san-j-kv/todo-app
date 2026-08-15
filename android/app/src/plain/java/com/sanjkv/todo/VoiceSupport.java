package com.sanjkv.todo;

import com.getcapacitor.BridgeActivity;

/**
 * Plain flavour: no voice.
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

    private VoiceSupport() {}

    static void register(BridgeActivity activity) {
        // Intentionally empty.
    }
}
