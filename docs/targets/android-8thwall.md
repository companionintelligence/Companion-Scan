# Android app, 8th Wall

The same Android shell as [android-arcore.md](android-arcore.md), built so that the scanner
starts on the 8th Wall engine and never on the phone's ARCore session.

## What it is

- A web build made with `VITE_AR_RUNTIME=8thwall` forces the 8th Wall runtime when the page's
  address names no `?ar=` value (`buildForcedRuntime` in `src/ar/runtime-select.ts`, read in
  `src/main.ts` section 3). The native ARKit or ARCore runtime is then never chosen. Any other
  value, or none, forces nothing, so the default build is unchanged.
- An address that names a runtime still wins: `?ar=webxr` opens WebXR in this build too.
- The page still asks `ScanAR.capabilities()` once. It does not wait for ARCore, and it starts no
  native session.
- The engine is bundled unmodified, as in the default build, and the status line reads
  "8th Wall ready" when the engine has loaded. If the engine does not load, the scanner tries
  WebXR, which the Android WebView does not have.
- Everything else is the default shell: the same `applicationId`, `com.companionintelligence.scan`,
  the same Scan server setting, sign-in, permissions and notices.

## Status

- **A build switch and its unit test only.** The switch came with
  `tests/unit/node/native_ar_runtime_select.test.ts`, which checks that `8thwall` forces 8th Wall
  and every other value forces nothing.
- **Built once, locally.** At commit `81e437c`, the tree `main` merged as `e897380` (#282), the
  steps under [Build](#build) made a debug APK of about 41 MB, whose main web chunk differs from the
  default build's ([Builds of the merged tree](README.md#builds-of-the-merged-tree)). That build
  ran from a script outside this repository. No script in the repository and no workflow sets
  `VITE_AR_RUNTIME`: the Native Release and Mobile Build workflows build the default, native-first
  APK.
- **Not run on a device.** The 8th Wall path has not run inside the shell on any build
  ([mobile/README.md](../../mobile/README.md#gates)). The one 8th Wall device result is in Android
  Chrome, not in the shell: on an XREAL Beam Pro, about 2 starts in 8 reach video
  ([AR_DEVICE_SUPPORT.md](../operations/AR_DEVICE_SUPPORT.md#xreal-beam-pro)).

## Entry points and files

| What | Where |
|---|---|
| The switch | `buildForcedRuntime()` in `src/ar/runtime-select.ts` |
| Where it is read | `src/main.ts`: the `?ar=` value, else `buildForcedRuntime(import.meta.env.VITE_AR_RUNTIME)` |
| Provider | `src/ar/eighthwall.ts`, engine `public/xr.js` |
| The shell | as in [android-arcore.md](android-arcore.md#entry-points-and-files) |

## Build

These are the steps the 2026-11-23 build ran. `scripts/native/build-web.mjs` refuses a
`.env` file that sets a `VITE_` variable, and passes the environment it was started with to Vite,
so set the variable on the command line. From `mobile/`, after `npm ci` in the repo root:

```bash
VITE_AR_RUNTIME=8thwall npm run build:web
npx cap sync android
(cd android && ./gradlew assembleDebug)
```

The two Android builds share the `applicationId`, so on one device each replaces the other: they
cannot be installed side by side. Android installs an update only when it is signed with the same
key. A build signed with another key needs the installed app removed first, and that removes the
scans it keeps on the phone.

## Run

As for the default shell ([android-arcore.md](android-arcore.md#run)): install the APK, set the
Scan server on the Server row, then tap Walk the room. ARCore is not needed on the phone.

## Test

There is no checklist for this build. On a device, use the 8th Wall rows that apply:

- Install and set up the app as in the
  [Android native shell](../testing/DEVICE_TEST_KIT.md#android-native-shell) steps of
  DEVICE_TEST_KIT.md, building the web bundle as above.
- Read the status line before AR starts: it should read "8th Wall ready", and the console should
  show no `[native-ar] trackingStatus:` line.
- With `?debug=remote,verbose` and `npm run logs:watch`, the provider's camera lines
  (`[8thwall] Camera status: ...`, then `[8thwall] trackingStatus: NORMAL`) say whether the start
  reached video, as [AR_DEVICE_SUPPORT.md](../operations/AR_DEVICE_SUPPORT.md#practical-guidance)
  describes for the browser.
- [Checklist A](../testing/DEVICE_TESTING.md#checklist-a--iphone-safari-8th-wall-slam) steps 4 to 8
  are the 8th Wall capture steps on an iPhone; they are the closest written steps for this build.

Without a device: `npm run test:native-ar` runs `native_ar_runtime_select.test.ts`.

## Known gaps

- No workflow builds this APK, and no install or run of it is recorded.
- The two Android builds replace each other on a device, so comparing ARCore and 8th Wall on one
  phone means reinstalling.
- The XR Engine licence sign-off that gates any store build applies here as in the default build
  ([mobile/README.md](../../mobile/README.md#gates)).
