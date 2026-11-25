# Android app, WebXR only

The Android shell of [android-arcore.md](android-arcore.md), built so that the scanner runs WebXR
and nothing else. It is for devices that run apps on Android but have no ARCore. Two have pages:

- [XREAL Aura](xreal-aura.md): wired XR glasses, with apps running on Android XR on a Compute Puck.
- [PICO](pico.md): PICO's headsets, on PICO OS 5 (PICO 4, PICO 4 Ultra, Neo3) and PICO OS 6 (PICO Space Pro).

Whether this APK can scan depends on the device's WebView having WebXR. Each device page says
what its documents state, and what the first run there must find out:

- PICO OS 6: PICO documents WebXR in its WebView.
- Android XR and PICO OS 5: their documents do not say.

Plan: [wave 17](../factory/17-xr-device-targets/README.md).

## What it is

- **WebXR only.** The web bundle is built with `VITE_AR_RUNTIME=webxr`
  (`scripts/native/build-web.mjs --ar-runtime=webxr`). `pageForcedRuntime` in
  `src/ar/runtime-select.ts` then forces WebXR, whatever the address says.
- **No ARCore session.** The scanner never starts one, but it still asks
  `ScanAR.capabilities()` once at start, so ARCore's availability check runs. The ARCore library
  stays in the APK, because the Android project is the default one.
- **No 8th Wall engine.** The bundle leaves the engine out, as the desktop app's does
  (`bundlesEngine`). So:
  - `index.html` asks for no `xr.js`. `vite.config.ts` writes
    `<meta name="scan-ar-runtime" content="webxr">` at the top of `<head>`, and the loader reads it.
  - The engine's notice is gone from `THIRD-PARTY-NOTICES.txt` and from Legal notices
    (`engineInBundle` in `src/ar/engine-state.ts`).
  - ARCore's disclosure stays, because the library is in the APK.
- **No runtime switch.** The button that switches between WebXR and 8th Wall is hidden: this
  bundle has no 8th Wall.
- **Where WebXR is missing.** In a WebView without WebXR, the start screen's headline reads "WebXR is not
  available here", and the app does not capture.
  - The line under it says: "To capture, open your Scan server's /webxr.html page in the browser."
  - The app is then the editor, the viewer, the Places map, the Scan server setting and sign-in.
  - Before [0006](../factory/17-xr-device-targets/0006-webxr-build-help-line.md), that line asked for
    Google Play Services for AR. The first install on an Aura showed it.
- **Everything else is the default shell:** the `applicationId` `com.companionintelligence.scan`,
  the sign-in return, the permissions, the Scan server setting, and the portrait lock.
- **No device's own libraries, permissions or manifest entries.** Native runtimes for Android XR
  and for PICO are tickets of their own (wave 17, 0003 and 0005).

## Status

- **Installed on one XREAL Aura, where it opens but cannot capture** (2026-11-24, from `60e9681`).
  - The puck's WebView has no WebXR.
  - The details are on [xreal-aura.md](xreal-aura.md#status).
  - It has not run on a PICO headset.
- **Builds here** (2026-11-24). On `main` at `1deaad7`, this change's tree:
  - built a bundle of 63.8 MB with no engine files;
  - built a debug APK of about 25 MB, with no engine files in its assets.
  - `aapt2 dump badging` shows the default build's package, version and permissions.
- **Checked in Chromium, not on a device:**
  - Served on its own, the built bundle requested no `xr.js`. Its start screen read "WebXR is
    not available here", and the runtime switch was hidden.
  - A dev server run with `VITE_AR_RUNTIME=webxr`, and with no `?ar=` in the address, chose WebXR
    under the `?mock=webxr` emulator and requested no `xr.js`. No session was started.
- **CI:** the Mobile Build workflow has a job for this build, "Android, WebXR only (debug APK)".
  It checks that the bundle left the engine out before Gradle runs. It has not run yet. Native
  Release does not build this APK.
- **Unit tests:**
  - `native_ar_runtime_select.test.ts`: the forced runtime.
  - `native_build.test.ts`: the build option, the scripts, the workflow job, and which bundles
    carry the engine.
  - `desktop_engine_state.test.ts`: runs `index.html`'s loader against every address, app and
    build, and holds it to `engineExpected`.
  - `wp-14-scanner-ui-runtime-switch.test.ts`: the hidden switch.
  - `legal_notices.test.ts` and `third_party_notices.test.ts`: the notices.

## Entry points and files

| What | Where |
|---|---|
| The forced runtime | `buildForcedRuntime()` and `pageForcedRuntime()` in `src/ar/runtime-select.ts`, read in `src/main.ts` section 3 |
| The engine left out | `bundlesEngine()` in `scripts/native/build-web.mjs`, `engineInBundle()` in `src/ar/engine-state.ts` |
| The loader | the engine loader in `index.html`, the `forcedRuntimeMeta` plugin in `vite.config.ts` |
| The notices | `bundleNotices({ engineBundled })` in `scripts/native/third-party-notices.mjs`; `openLegalNotices()` in `src/ui/legal-notices.ts` |
| Provider | `src/ar/webxr.ts` |
| The shell | as in [android-arcore.md](android-arcore.md#entry-points-and-files) |
| CI | the `android-webxr` job in `.github/workflows/mobile-build.yml` |

## Build

JDK 21, and the Android SDK with platform 36 (`ANDROID_HOME` set), as for
[android-arcore.md](android-arcore.md#build). From the repo root:

```bash
npm ci
npm ci --prefix mobile
npm run build:webxr --prefix mobile
(cd mobile/android && ./gradlew assembleDebug)
```

`npm run build:webxr` runs `npm run build:web:webxr` (the web bundle), then `cap sync android`.
Its devices run Android, so the iOS project never gets this bundle. The APK is
`mobile/android/app/build/outputs/apk/debug/app-debug.apk`. It is a debug build: use it on your own
device only.

This APK and the ARCore build share the `applicationId`, so on one device each replaces the other.
Android installs an update only when it is signed with the same key. A build signed with another
key needs the installed app removed first, which removes the scans it keeps on the device.

## Test

- On a device: the first-run lists on [xreal-aura.md](xreal-aura.md#first-run-on-an-aura-what-to-record)
  and [pico.md](pico.md#first-run-on-a-pico-headset-what-to-record).
- Without a device: the unit tests above, and `npm run test:native-ar`.

## Known gaps

- **Not captured on any device.**
  - On the one Aura it was installed on, the WebView had no WebXR.
  - It has not run on a PICO headset or an XR emulator.
- **The ARCore notice shows** in Legal notices, though this build never starts ARCore, because the
  library is in the APK. Taking it out means the Android project must differ per build.
- **The portrait lock** stays, as in every Android build. Changing it for this build alone needs a
  manifest change behind a Gradle switch, kept in step with the web flag.
- **Google Play.** The build is not published there. The manifest implies features, which
  `aapt2 dump badging` lists: `android.hardware.camera` (from `CAMERA`), `android.hardware.location`,
  `android.hardware.screen.portrait` and `android.hardware.faketouch`. A store uses them to filter
  devices. An `adb install` ignores them: the system does not check `uses-feature` at install.
- **The identifiers are provisional**, as in [android-arcore.md](android-arcore.md#known-gaps).
