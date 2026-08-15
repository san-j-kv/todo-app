package com.sanjkv.todo;

import com.getcapacitor.BridgeActivity;

/**
 * Voice flavour: wires up the microphone plugin.
 *
 * <p>The seam between the two build flavours. {@code src/plain} carries a stub
 * with the same signature that does nothing, which is what lets MainActivity
 * stay identical across both while the plain build contains no reference to
 * {@link VoicePlugin}, no Vosk dependency and no model — the classes are not in
 * its source set at all, so there is nothing for a reader or the linker to
 * follow.
 */
final class VoiceSupport {

    private VoiceSupport() {}

    /** Must be called before {@code super.onCreate()} — see MainActivity. */
    static void register(BridgeActivity activity) {
        activity.registerPlugin(VoicePlugin.class);
    }
}
