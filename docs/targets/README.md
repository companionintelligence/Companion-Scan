# Device targets

Companion Scan captures a Place on a phone or a headset and sends it to one Scan server. A
target is one way to run the capture side: a browser runtime, or an app built from this
repository. The desktop app is the one target that does not capture: it is the editor and viewer.

Each page says what the target is, what has run on a device and what has not, its entry points
and files, and how to build, run and test it. A status here repeats what the owning document
records, and links to it. A result counts as verified only when someone ran it on the hardware
and read the output back, the rule of [AR_DEVICE_SUPPORT.md](../operations/AR_DEVICE_SUPPORT.md)
and [PLATFORM_SUPPORT.md](../operations/PLATFORM_SUPPORT.md).

## Matrix

| Target | Devices | AR runtime | Entry point | Status | Page |
|---|---|---|---|---|---|
| Web, 8th Wall | iPhone and iPad, Safari | the 8th Wall XR Engine (`public/xr.js`) | `/?project=default` | In code. No run on an iPhone or iPad is recorded. | [web-8thwall.md](web-8thwall.md) |
| Web, WebXR | Android Chrome with ARCore, Meta Quest Browser | WebXR `immersive-ar` | `/webxr.html` | In code. On Android one session start was seen, and tracking was not reached. Quest support is documented, not verified. | [web-webxr.md](web-webxr.md) |
| Android app, ARCore | Android phones and tablets | ARCore through `ScanAR`, then 8th Wall, then WebXR | the app (`mobile/`) | In code. The debug build compiled before the branches were merged. Not run on a device. | [android-arcore.md](android-arcore.md) |
| Android app, 8th Wall | Android phones and tablets | 8th Wall only | the app, built with `VITE_AR_RUNTIME=8thwall` | A build switch with a unit test. No build of it and no device run is recorded. | [android-8thwall.md](android-8thwall.md) |
| Meta Quest app | Meta Quest | native (planned) | none | Planned. No code in this tree. | [meta-quest.md](meta-quest.md) |
| iOS app | iPhone | ARKit through `ScanAR`, drawn in RealityKit's `ARView`, then 8th Wall | the app (`mobile/`) | In code. The Swift compiled in the workflow's iOS Simulator job on 2026-11-23 (run 45247696203). Not run on a device. | [ios.md](ios.md) |
| Desktop app | Windows, macOS, Linux | none: no capture | the app (`desktop/`) | In code. Built by workflows run by hand. Sign-in has not run against a real Portal. | [desktop/README.md](../../desktop/README.md) |
| Scan server | Linux; macOS and Windows unverified | none | `server/main.ts` | Runs on Linux: verified on one host. | [server.md](server.md) |

Every capture target uses one contract, `ARProvider` (`src/ar/provider.ts`), so the scanner above
it does not change with the runtime. There are three providers: 8th Wall (`src/ar/eighthwall.ts`),
WebXR (`src/ar/webxr.ts`) and native (`src/ar/native.ts`, ADR 0009). `src/main.ts` picks one when
the page loads: in a browser, 8th Wall unless the address says `?ar=webxr`; in the phone apps,
native first ([ADR 0009](../adr/0009-native-ar-runtime-beside-8th-wall.md)).

Planning for the device targets is in wave 13:
[factory/13-device-targets/README.md](../factory/13-device-targets/README.md).

## Where the checklists are

- [testing/DEVICE_TESTING.md](../testing/DEVICE_TESTING.md): the per-device checklists (A for
  iPhone Safari, B for Android Chrome WebXR, C for person capture, D for the iOS app), the results
  matrix, the room-loop benchmark and the remote-controlled Android setup.
- [testing/DEVICE_TEST_KIT.md](../testing/DEVICE_TEST_KIT.md): the preflight (`npm run device:preflight`),
  each surface with what was checked on the dev box and what only a device shows, and the steps for
  each device.
- [operations/AR_DEVICE_SUPPORT.md](../operations/AR_DEVICE_SUPPORT.md): which devices ran the live
  scanner, and which runtimes have anchors.

## Releases

The desktop app and the Android app are built from this repository and published only as GitHub
pre-releases, by [`.github/workflows/native-release.yml`](../../.github/workflows/native-release.yml).
They are not in any app store. iOS is not built for release.

Each app carries `THIRD-PARTY-NOTICES.txt` (generated from the lockfiles for exactly what that
bundle contains) and `LICENSE.txt`, and shows both under Legal notices. No server address, API
key or secret is built into either app, and no model weights ship in them.

### Building the apps

```bash
npm ci
npm ci --prefix desktop && npm run build --prefix desktop     # this OS's installers
npm ci --prefix mobile && npm run build:web --prefix mobile   # then:
(cd mobile && npx cap sync android) && (cd mobile/android && ./gradlew assembleRelease)
```

Both web builds go through [`scripts/native/build-web.mjs`](../../scripts/native/build-web.mjs),
which builds without the service worker, leaves the engine out of the desktop app, leaves model
weights and test files out of both, refuses a `.env` file that sets a `VITE_` variable, and writes
the notices. The Android release build signs from four environment variables or the git-ignored
`mobile/android/keystore.properties` ([mobile/README.md](../../mobile/README.md#publishing)).

### Publishing a pre-release

1. Set the next version in all six places, and raise the Android `versionCode` by one.
   `node scripts/native/check-versions.mjs` says whether they agree.
2. Dispatch **Native Release** with the tag `v<version>` (for example `v0.2.0`; `v0.1.0` is the
   container pre-release) and `android_signing`: `auto` signs with the release key when the four
   repository secrets `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`
   and `ANDROID_KEY_PASSWORD` are set, with a throwaway key made in the job and never stored when
   none of them is, and stops when only some are. The tag must not exist yet, as a release or as
   a git tag: the release makes it on the commit it built, and the workflow stops if it finds
   one, before building and again just before publishing.
3. The workflow builds every installer and the APK, and publishes only when all of them
   succeeded: a GitHub pre-release with the installers, the APK, `LICENSE`,
   `THIRD-PARTY-NOTICES.txt`, `SHA256SUMS.txt` and notes on installing each one.

The APK it publishes is the default build, native first. No workflow builds the 8th Wall APK
([android-8thwall.md](android-8thwall.md)).

### Not done yet

- The identifiers are provisional: `computer.ci.scan.desktop` and `com.companionintelligence.scan`.
  They name where each app keeps its local data, so change them before people rely on a build.
- AR capture in the Android app has not run on a phone, and Companion Account sign-in has not run
  against a real Portal on either app.
- The installers are not code-signed or notarized, so Windows and macOS warn on first open.
- iOS, Google Play and the App Store are out of scope here: they need the owner's Apple and
  Google accounts ([mobile/README.md](../../mobile/README.md#publishing)).
