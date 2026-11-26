# Android app, ARCore

The Android app: the Scan web app inside a Capacitor 8 shell (`mobile/`), with the phone's own
ARCore session as the AR runtime. It is the scanner and the editor. The full shell reference is
[mobile/README.md](../../mobile/README.md).

## What it is

- The shell bundles the web app; there is no remote page. It talks to the person's own Scan
  server, whose https address is set in the app
  ([README.md](../../README.md#the-scan-server-in-the-android-ios-and-desktop-apps)).
- `MainActivity` registers one plugin, `ScanAR` (`ScanARPlugin.java`, with the GL frame loop in
  `ScanARRenderer.java`). The web side is `NativeARProvider` (`src/ar/native.ts`), behind the same
  `ARProvider` contract as the web runtimes (ADR 0009).
- **Which runtime starts.** When the page loads, the scanner asks `ScanAR.capabilities()`. When it
  reports `supported`, the page chooses the native runtime and the status line reads "ARCore
  ready", which says only that it was chosen; the session starts when AR starts. When it does not,
  the scanner starts on 8th Wall (`public/xr.js`, bundled unmodified), and on WebXR if that engine
  is missing. A native session that was supported and still fails to start hands the same canvas to
  8th Wall, then WebXR. `?ar=webxr` and `?ar=8thwall` keep their web runtimes
  (`src/ar/runtime-select.ts`).
- ARCore can still be checking when the app starts, so the page asks again: at most five times, a
  second apart (`NATIVE_RECHECKS`, `NATIVE_RECHECK_MS`).
- ARCore is optional (the `com.google.ar.core` meta-data is `optional`), so the app installs on
  phones without it. `supported` is true only when Google Play Services for AR is installed, and
  `reason` says what is missing. Since wave 14, `capabilities()` also reports `installable`, and the
  page's `start()` asks Google Play to install or update ARCore through ARCore's own flow; a person
  who declines gets the reason, and the scanner runs the web runtimes. When ARCore is missing or
  needs an update, the 8th Wall status line says so. Not run on a device.
- `ScanAR` hands the page the camera frame as a JPEG with its pose and projection
  (`captureFrame`), exact hit tests (`hitTest`), pose, feature-point and hit-grid events, and
  optional depth from the ARCore depth API. It has one origin anchor (`setOriginAnchor`,
  `getOriginAnchor`) that the page never calls.
- Pausing the app stops the GL loop and pauses the ARCore session, which releases the camera.
  Resuming lets the next frame resume it.
- The shell is portrait only, HTTPS only (no cleartext, no mixed content), and left out of Android
  backup and device-to-device transfer. Companion Account sign-in runs in the browser sheet and
  comes back on `com.companionintelligence.scan://auth`.
- The app carries the XR Engine unmodified and shows Niantic's notice, and it carries ARCore,
  whose terms and Google's disclosure are in its Legal notices
  ([NOTICE.md](../../NOTICE.md)).

## Status

- **Not run on a device.** AR capture, the pause, resume and destroy hooks, the origin anchor and
  the sign-in return (its intent filter and Custom Tabs) have not run on a phone
  ([mobile/README.md](../../mobile/README.md#native-ar-capture)).
- **Build: the merged tree builds.** At commit `81e437c`, the tree `main` merged as `e897380`
  (#282), a local `./gradlew assembleDebug` made a debug APK of about 41 MB, and the Mobile Build
  workflow's Android job built one too (run 45260987425, 2026-11-23;
  [Builds of the merged tree](README.md#builds-of-the-merged-tree)). Neither ran the Android unit
  tests. Since wave 14 the Mobile Build workflow runs `./gradlew testDebugUnitTest` (11
  `ScanARRules` tests and 8 `OriginAnchorStoreTest` tests, where Capacitor's template stubs were) and
  compiles the instrumented tests, which no job runs; its run 45327838056 passed on `main` at
  `8deb264`. No build has been installed on a phone or an emulator. A debug APK build, an install and launch on an Android
  16 emulator, and the start screen were observed before the merge, on a tree that registered a
  different plugin ([DEVICE_TEST_KIT.md](../testing/DEVICE_TEST_KIT.md#surfaces)).
- **Web side: tested without a device.** `npm run test:native-ar` covers the codec, the provider
  against a fake plugin (with the fallback) and the runtime choice. `tests/mock-native-ar.spec.ts`
  runs the scanner in Chromium on a stand-in plugin and checks the handover to the 8th Wall mock.
- **Releases.** The release APK is published only as a GitHub pre-release, signed with the release
  key or a throwaway key and named for which ([Releases](README.md#releases)). It is not on Google
  Play.

## Entry points and files

| What | Where |
|---|---|
| Shell config | `mobile/capacitor.config.ts` (`appId` `com.companionintelligence.scan`, `androidScheme: 'https'`) |
| Activity and plugin | `mobile/android/app/src/main/java/com/companionintelligence/scan/`: `MainActivity.java`, `ScanARPlugin.java`, `ScanARRenderer.java` |
| ARCore dependency | `mobile/android/app/build.gradle`, version `arcoreVersion` in `mobile/android/variables.gradle` |
| Pinned libraries | `mobile/android/app/gradle.lockfile` |
| Web side | `src/ar/native.ts`, `src/ar/native-bridge.ts`, `src/ar/runtime-select.ts`, the runtime choice in `src/main.ts` |
| Web build for the shell | `scripts/native/build-web.mjs` (`npm run build:web` in `mobile/`) |
| Offline queue | `src/page-upload-queue.ts`: the app has no service worker, so the scanner page queues the scan, summary and finalize uploads it cannot send, in the IndexedDB database `companion-scan-offline-queue`, and retries them at start, when the device is back online and every minute. `src/ui/queue-notice.ts` words its notices. Not run on a device |
| Not used | `ArSessionPlugin.java` compiles into the app and is unregistered: neither shell puts it on the bridge ([DEVICE_TEST_KIT.md](../testing/DEVICE_TEST_KIT.md#ar-in-the-shells)) |

## Build

From `mobile/`, after `npm ci` in the repo root. JDK 21, and the Android SDK with platform 36 and
build-tools 36.0.0 (`ANDROID_HOME` set):

```bash
npm ci
npm run build:web
npx cap sync android
(cd android && ./gradlew assembleDebug)      # or assembleRelease
```

`VITE_API_BASE=https://<host>:5173` before `npm run build:web` names a default Scan server; an
address saved in the app overrides it. Release signing, the dependency lock and the store steps
are in [mobile/README.md](../../mobile/README.md#build) and [Releases](README.md#releases). The
**Mobile Build** workflow, run by hand, builds a debug APK.

## Run

1. Install `mobile/android/app/build/outputs/apk/debug/app-debug.apk` on an ARCore-capable phone
   with Google Play Services for AR installed (`adb install -r ...`).
2. Set the Scan server on the first-run screen's Server row (Add server, then
   `https://<host>:5173` for a dev box), unless the build named one.
3. Tap Walk the room, pick or create a Place, and confirm. The camera, motion and location
   prompts should appear.

The emulator is the quickest way to see the shell boot. It has no ARCore and no camera pose, so it
shows that the shell starts, not that AR works
([DEVICE_TEST_KIT.md](../testing/DEVICE_TEST_KIT.md#android-emulator)).

## Test

- [DEVICE_TEST_KIT.md](../testing/DEVICE_TEST_KIT.md#android-native-shell): the Android native
  shell steps. Read `Capacitor.Plugins.ScanAR.capabilities()` in the WebView console
  (`chrome://inspect` on the debug build) and write down `supported` and `reason`. A native start
  logs `[native-ar] trackingStatus:` lines; the warning `[native-ar] the native session did not
  start; using the web runtime:` means it fell back to 8th Wall.
- [Checklist E](../testing/DEVICE_TESTING.md#checklist-e--native-arcore-scan-android-app) in
  DEVICE_TESTING.md, rows 1 to 13: `capabilities()`, the status line, the native start and its
  console lines, a wall hit test, pause and resume, the origin anchor, depth, a refused camera,
  the sign-in return, the 8th Wall build, and a device without ARCore.
- The room-loop benchmark asks for an ARCore phone or tablet in the Android shell
  ([DEVICE_TESTING.md](../testing/DEVICE_TESTING.md#devices)).
- Without a device: `npm run test:native-ar`, `npm run test:android-lockfile`, and
  `npm run device:preflight`, which checks the APK, the shells' CORS answers and the bundle's host.

## Known gaps

From [mobile/README.md](../../mobile/README.md#not-done) and [Not done yet](README.md#not-done-yet):

- AR capture on a real phone: the prompts, the native session, the 8th Wall fallback in the shell,
  GLB export, and the sign-in return on Android.
- The identifier `com.companionintelligence.scan` is provisional, and permanent once on Google
  Play.
- The session token is in the WebView's `localStorage`; it should move to the Keystore before a
  store build.
- The ARCore disclosure has had no legal review and has not been seen on a device. Whether to show
  it before the first AR session is the owner's call.
- The keyframe upload does not send the depth map yet (`FrameObservation.depthUrl`).
- A saved origin is not restored in a later session: the origin file is written, and nothing
  reads it back.
- WebXR comes last in the fallback order, and the Android WebView has no WebXR AR
  ([AR_DEVICE_SUPPORT.md](../operations/AR_DEVICE_SUPPORT.md#where-they-exist-read-from-documents-on-2026-11-16-no-device-run)).
- Store builds wait on the measurement step and the owner's sign-off on the XR Engine licence.
