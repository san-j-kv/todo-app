# To Do

An offline task list for Android. Tasks are stored in a single JSON file in the
app's private storage and never leave the device — there is no account, no sync,
no telemetry, and **the app holds no `INTERNET` permission at all**.

Voice quick-add is optional and also entirely on-device: speech is decoded by
[Vosk](https://alphacephei.com/vosk/) inside the app's own process against a
model bundled in the APK, so "the recording cannot leave the phone" is enforced
by the OS rather than promised by code.

Built with [Capacitor](https://capacitorjs.com/) over a plain HTML/CSS/JS front
end. No build step, no bundler, no framework.

---

## Features

- Tasks with a name, due date, time and category
- Recurring tasks — daily, weekly, monthly, yearly, workweek, or a custom
  "every N days/weeks/months/years". A recurrence advances only when the task is
  actually completed, not when its date passes.
- Local reminders, including a **Mark done** action handled straight from the
  notification without opening the app
- Categories, a category filter drawer, and search
- Pending / completed views
- Export and import a backup to a file the user picks. An import only ever
  merges — it can never delete a task that isn't in the file.
- **Voice quick-add** (voice flavour only): speak a sentence like
  "buy milk tomorrow at 6 in the evening for groceries" and the fields are
  filled in for confirmation before anything is saved

## Privacy

This is the point of the app, so it is worth being specific:

- The task list lives in `getFilesDir()`, reached through an app-local
  `TodoStore` Capacitor plugin.
- `android:allowBackup="false"` — Auto Backup would otherwise push the task list
  into the user's Google Drive quota as a side effect of storing it privately.
  Device-to-device transfer is deliberately left **on** in
  `res/xml/data_extraction_rules.xml`, so a new phone still inherits the list
  without a copy ever landing on someone else's server.
- No `INTERNET` permission in either flavour. `RECORD_AUDIO` is declared by the
  `voice` flavour only, in `src/voice/AndroidManifest.xml`.
- Nothing logs transcripts, and no audio is ever written to disk.

## Build flavours

Voice roughly doubles the download twice over — once for Vosk's native decoder,
once for the acoustic model — so it is a build flavour rather than a fixture:

| Flavour | Voice | Size | Permissions |
|---|---|---|---|
| `plain` | no | small | notifications, alarms |
| `voice` | yes | ~50 MB | the above plus `RECORD_AUDIO` |

The split is a source-set one. `src/plain` and `src/voice` each hold a
`VoiceSupport` class with the same signature — one registers the plugin, one
does nothing — and nothing in `src/main` knows which it got. Both flavours share
an `applicationId`, `versionCode` and signing key, so either installs straight
over the other.

## Building

**Requirements:** Node.js, the Android SDK with `ANDROID_HOME` set (there is no
`local.properties` in the repo — it is gitignored, and the SDK is located from the
environment), and a **JDK 21** toolchain on `JAVA_HOME`. Gradle
8.14.x cannot read the Java 25 runtime that current Android Studio bundles — that
combination fails with `Unsupported class file major version 69`. See
`android/gradle.properties` for how to pin it per-machine without editing the
file. `minSdk` is 24, `compileSdk`/`targetSdk` 36.

```bash
npm ci                          # postinstall applies patches/ via patch-package

npm run build:android:plain     # assemblePlainDebug
npm run build:android           # assembleVoiceDebug
npm run open:android            # open the project in Android Studio
```

> **The `build:android*` and `test:android` scripts invoke `.\gradlew.bat` and
> therefore only run on Windows.** On macOS and Linux, call the wrapper directly
> — it is pinned to LF in `.gitattributes` precisely so that it runs there:
>
> ```bash
> npx cap sync android
> cd android && ./gradlew assemblePlainDebug     # or assembleVoiceDebug
> cd android && ./gradlew testPlainDebugUnitTest
> ```

> **`www/` is the source of truth.** `android/app/src/main/assets/public` is a
> generated copy — edit `www/`, then run `npm run sync` (`cap sync`). Changes
> made in the android assets directory will be overwritten.

`www/index.html` also opens directly in a desktop browser. The native plugins are
absent there, so storage falls back to `localStorage` and notifications and voice
no-op — which keeps the page usable for development.

## Tests

```bash
npm test                # jsdom suite: nlu, notify, app integration
npm test -- nlu         # one suite
npm run test:android    # Gradle unit tests (testPlainDebugUnitTest)
```

No test framework and no config, matching a project with no build step; the only
dev dependency is jsdom. `tests/run.js` also fails the run on any unhandled
promise rejection, so a silently failed write cannot pass as green.

## Layout

```
www/            the app — index.html, styles.css, and:
  app.js          task document, schema, migrations, all UI
  nlu.js          spoken sentence -> task fields (rule-based, no model)
  store.js        byte pipe to native storage, localStorage fallback
  notify.js       local notifications
  voice.js        thin pipe to the TodoVoice plugin
android/        Capacitor Android project
  app/src/main/java/com/sanjkv/todo/   TodoStore plugin, reminders, recurrence
  app/src/voice/                       Vosk plugin + bundled model
  app/src/plain/                       the no-op VoiceSupport
tests/          node test suites
patches/        patch-package diff against @capacitor/local-notifications
```

The `nlu.js` parser is deliberately rule-based rather than a model: the target is
four fields plus a recurrence rule, and rules hit that reliably, run in under a
millisecond, add zero bytes of download, and can be pinned down by a table of
unit tests.

## iOS

The `ios/` directory is the stock Capacitor scaffold and is **not maintained**.
There is no Swift implementation of either app-local plugin, so on iOS the app
falls back to `localStorage` and has no voice input — `Info.plist` carries no
`NSMicrophoneUsageDescription`. Treat it as unbuilt.

## License

MIT — see [LICENSE](LICENSE).

The bundled Vosk model and several dependencies carry their own terms; see
[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).
