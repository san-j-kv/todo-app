# Third-party notices

To Do itself is MIT licensed — see [LICENSE](LICENSE). It redistributes the
components below, which carry their own terms. This file is the attribution
notice those terms require.

---

## Vosk speech model (bundled in this repository)

**`vosk-model-small-en-in-0.4`** — Indian English acoustic model for mobile
Vosk applications.

- Bundled at `android/app/src/voice/assets/model-en/`
- Copyright © Alpha Cephei Inc.
- Licensed under the Apache License, Version 2.0 — full text in
  [`licenses/vosk-APACHE-2.0.txt`](licenses/vosk-APACHE-2.0.txt)
- Upstream: <https://alphacephei.com/vosk/models>

**Modifications.** The copy in this repository is not byte-identical to the
published archive. A `uuid` file reading `en-in-0.4-todoapp-1` was added at the
root of the model directory: Vosk's `StorageService` requires one in order to
decide whether the unpacked copy on disk is current, the published zips do not
ship it, and its absence fails at runtime with nothing pointing back at the
cause. The value must change whenever the model does. The reasoning is recorded
in full in commit `2f185f5`.

The model files are pinned `binary` in [`.gitattributes`](.gitattributes) so no
end-of-line conversion can corrupt them.

This model is bundled only in the `voice` product flavour. The `plain` flavour
contains no model, no Vosk code and no `RECORD_AUDIO` permission.

---

## Runtime dependencies

| Component | Version | License |
|---|---|---|
| [Vosk for Android](https://github.com/alphacep/vosk-api) (`com.alphacephei:vosk-android`) | 0.3.75 | Apache 2.0 |
| [JNA](https://github.com/java-native-access/jna) (`net.java.dev.jna:jna`) | 5.18.1 | Apache 2.0 / LGPL 2.1 (dual) |
| [Capacitor](https://capacitorjs.com/) (`@capacitor/core`, `/cli`, `/android`, `/ios`, `/app`) | 8.x | MIT |
| [`@capacitor/local-notifications`](https://github.com/ionic-team/capacitor-plugins) | 8.2.1 | MIT — **modified, see below** |
| [AndroidX](https://developer.android.com/jetpack/androidx) (appcompat, coordinatorlayout, core-splashscreen) | see `android/variables.gradle` | Apache 2.0 |

Vosk and JNA are pulled in by the `voice` flavour only (`voiceImplementation`
in `android/app/build.gradle`), so the `plain` build links neither.

### Modification to `@capacitor/local-notifications`

`patches/@capacitor+local-notifications+8.2.1.patch` is applied at install time
by [patch-package](https://github.com/ds300/patch-package) (MIT), via the
`postinstall` script. It changes notification action buttons from launching the
activity to sending a package-scoped broadcast, so "Mark done" can be handled
without the app's UI appearing, and tightens the `PendingIntent` mutability
flags. The patch file carries the full rationale inline and constitutes the
notice of modification required by the MIT license's attribution clause.

---

## Development dependencies

Not redistributed — used only to run the test suite.

| Component | License |
|---|---|
| [jsdom](https://github.com/jsdom/jsdom) | MIT |
| [patch-package](https://github.com/ds300/patch-package) | MIT |
| [JUnit 4](https://junit.org/junit4/) | Eclipse Public License 1.0 |
| [Espresso / AndroidX Test](https://developer.android.com/training/testing) | Apache 2.0 |

The Gradle wrapper (`android/gradlew`, `android/gradle/wrapper/`) is part of
[Gradle](https://gradle.org/), Apache 2.0.
