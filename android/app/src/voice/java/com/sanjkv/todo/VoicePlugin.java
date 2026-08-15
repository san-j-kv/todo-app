package com.sanjkv.todo;

import android.Manifest;
import android.content.pm.PackageManager;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import org.json.JSONException;
import org.json.JSONObject;
import org.vosk.Model;
import org.vosk.Recognizer;
import org.vosk.android.RecognitionListener;
import org.vosk.android.SpeechService;
import org.vosk.android.StorageService;

import java.io.IOException;

/**
 * Speech-to-text that never leaves the device.
 *
 * <p>Vosk runs in this process, decoding against a model bundled in the APK. That
 * is the whole reason it was chosen over {@code android.speech.SpeechRecognizer}:
 * the framework's offline recognizer needs API 33 and this app supports API 24,
 * and the ordinary recognizer streams audio to Google's servers from a process
 * this app has no control over. With Vosk in-process the app holds no INTERNET
 * permission at all, so "the audio stays here" stops being a promise about
 * someone else's code and becomes something the OS enforces.
 *
 * <p>App-local, so it is registered by hand in MainActivity for the reason given
 * there.
 */
@CapacitorPlugin(
    name = "TodoVoice",
    permissions = {
        @Permission(strings = { Manifest.permission.RECORD_AUDIO }, alias = VoicePlugin.MIC)
    }
)
public class VoicePlugin extends Plugin {

    static final String MIC = "microphone";

    /**
     * Assets subdirectory holding the model, and where it is unpacked to.
     *
     * <p>Named for the language, not the accent, so swapping en-in for en-us is
     * a change to the asset directory alone. StorageService decides whether to
     * re-extract by comparing an asset file called {@code uuid} against the copy
     * in the target — which the published model zips do not contain, so one is
     * added by hand and must change whenever the model does, or the old model
     * stays on disk forever.
     */
    private static final String MODEL_ASSET = "model-en";
    private static final String MODEL_TARGET = "model";

    /** Hard ceiling on one dictation, so a forgotten mic can't hold the input. */
    private static final int LISTEN_TIMEOUT_MS = 30_000;

    private static final float SAMPLE_RATE = 16000.0f;

    private Model model;
    private SpeechService speechService;

    /** Set while an unpack is in flight, so two taps don't start two copies. */
    private boolean unpacking;

    /**
     * Whether voice can work at all here. Reports readiness separately from
     * availability: the model is ~40 MB and is copied out of the APK on first
     * use, so there is a window where voice is real but not yet usable and the
     * UI needs to say so rather than appear broken.
     */
    @PluginMethod
    public void isAvailable(PluginCall call) {
        JSObject result = new JSObject();
        result.put("available", true);
        result.put("ready", model != null);
        result.put("granted", hasMic());
        call.resolve(result);
    }

    @PluginMethod
    public void start(PluginCall call) {
        if (!hasMic()) {
            // Capacitor re-delivers the call to the callback below once the user
            // has answered, so the JS side sees one promise either way.
            requestPermissionForAlias(MIC, call, "micResult");
            return;
        }
        beginListening(call);
    }

    @PermissionCallback
    private void micResult(PluginCall call) {
        if (!hasMic()) {
            call.reject("Microphone permission is required for voice input");
            return;
        }
        beginListening(call);
    }

    @PluginMethod
    public void stop(PluginCall call) {
        stopListening();
        call.resolve();
    }

    private boolean hasMic() {
        return getPermissionState(MIC) == com.getcapacitor.PermissionState.GRANTED
            || getContext().checkSelfPermission(Manifest.permission.RECORD_AUDIO)
                == PackageManager.PERMISSION_GRANTED;
    }

    /**
     * Unpacks the model if this is the first run, then opens the mic. Resolves as
     * soon as listening has started — the transcript arrives later as events,
     * because a dictation has no single return value and the UI wants the partial
     * results as they come.
     */
    private void beginListening(final PluginCall call) {
        if (model == null) {
            if (unpacking) {
                call.reject("The speech model is still being prepared");
                return;
            }
            unpacking = true;
            notifyState("preparing");
            StorageService.unpack(
                getContext(),
                MODEL_ASSET,
                MODEL_TARGET,
                (unpacked) -> {
                    model = unpacked;
                    unpacking = false;
                    openMic(call);
                },
                (error) -> {
                    unpacking = false;
                    notifyState("idle");
                    call.reject("Could not prepare the speech model", error);
                }
            );
            return;
        }
        openMic(call);
    }

    private void openMic(PluginCall call) {
        // A second start with one already running would open a second AudioRecord
        // on the same mic; end the first cleanly instead.
        stopListening();
        try {
            Recognizer recognizer = new Recognizer(model, SAMPLE_RATE);
            speechService = new SpeechService(recognizer, SAMPLE_RATE);
            speechService.startListening(new Transcriber(), LISTEN_TIMEOUT_MS);
            notifyState("listening");
            call.resolve();
        } catch (IOException e) {
            speechService = null;
            notifyState("idle");
            call.reject("Could not open the microphone", e);
        }
    }

    /**
     * {@code stop()} finishes the stream and still emits a final result;
     * {@code shutdown()} drops it. Stopping is right here — a user tapping done
     * mid-word should keep what they said.
     */
    private void stopListening() {
        if (speechService == null) {
            return;
        }
        try {
            speechService.stop();
        } catch (Exception ignored) {
            // A service already torn down is not worth failing the call over.
        }
        speechService = null;
        notifyState("idle");
    }

    /** Vosk hands back JSON; the web layer only ever wants the one string. */
    private void emit(String event, String hypothesis, String field) {
        String text = "";
        try {
            JSONObject parsed = new JSONObject(hypothesis == null ? "{}" : hypothesis);
            text = parsed.optString(field, "");
        } catch (JSONException ignored) {
            // Malformed hypothesis means nothing was heard, not a failure.
        }
        JSObject payload = new JSObject();
        payload.put("text", text);
        notifyListeners(event, payload);
    }

    private void notifyState(String state) {
        JSObject payload = new JSObject();
        payload.put("state", state);
        notifyListeners("state", payload);
    }

    private class Transcriber implements RecognitionListener {

        @Override
        public void onPartialResult(String hypothesis) {
            emit("partial", hypothesis, "partial");
        }

        /**
         * Fires when Vosk decides the speaker has finished. For quick-add that is
         * the end of the interaction, so the mic closes here rather than waiting
         * for the timeout — one sentence in, one task out.
         */
        @Override
        public void onResult(String hypothesis) {
            emit("result", hypothesis, "text");
            stopListening();
        }

        @Override
        public void onFinalResult(String hypothesis) {
            // Emitted after an explicit stop(). onResult has usually already
            // delivered the same sentence; the web layer ignores a repeat.
            emit("final", hypothesis, "text");
        }

        @Override
        public void onError(Exception e) {
            JSObject payload = new JSObject();
            payload.put("message", e == null ? "Speech recognition failed" : String.valueOf(e.getMessage()));
            notifyListeners("error", payload);
            stopListening();
        }

        @Override
        public void onTimeout() {
            notifyState("timeout");
            stopListening();
        }
    }

    /**
     * The mic and the model both outlive a single call, so both are released
     * here. Leaving the SpeechService running would hold the microphone open
     * after the app is gone.
     */
    @Override
    protected void handleOnDestroy() {
        stopListening();
        if (model != null) {
            model.close();
            model = null;
        }
        super.handleOnDestroy();
    }
}
