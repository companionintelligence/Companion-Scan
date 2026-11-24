> **Type:** Native apps / Infra
> **Wave:** 14-inventory-fixes
> **Branch:** `inv-native-apps`
> **Commit style:** `fix(native): summary`, `feat(quest): summary`, `ci: summary`
> **Design:** this ticket is the spec. It answers the inventory findings F-31 to F-36 and FN-152 to FN-177, plus FN-193, at main e897380.
> **Dependencies:** server-core (0001) adds the server half of `shell=quest` (wave 13, ticket 0010). The gimbal session (0007) owns the gimbal tests this ticket's workflow runs.

## Goal

The two ScanAR plugins keep one contract and one pose convention. The Quest app signs in, and it uploads to the server on the web client's numbers or on documented device numbers. CI has a job for every native and subsystem test suite. Anything left unwired is listed for the owner.

## Non-goals

- Do not wire the native features the page never calls: `saveWorldMap`, `captureDepth`, `worldMapState` and the Android origin anchor (F-32). List them.
- Do not delete `ArSessionPlugin.java`, `ArSessionPlugin.swift`, `src/ar/native-provider.ts` or any other file (F-34). List them.
- Do not change what `capabilities().supported` means. The page's runtime choice (`src/ar/runtime-select.ts`, scanner-ui's file) stays as it is today.
- Do not edit `package.json`, `package-lock.json`, `vite.config.ts`, `NOTICE.md` or another session's files. List what they need.
- Do not push, and do not open a PR. Every workflow stays `workflow_dispatch` only, as `deno-ci.yml`'s gated block keeps it.
- Do not port the web's `FrameEpochTracker` to Kotlin.

## Pinned conventions

- **ADR 0001.** The Quest sign-in reuses the shell sign-in that exists today: `GET /authenticate/oidc?shell=…&challenge=…`, then a one-time code (43 base64url characters, 60 s), then `POST /authenticate/shell/exchange {code, verifier}` → `{token, email, name}`, then `Authorization: Bearer <token>` (`server/portal_auth.ts`, `src/shared/shell-sign-in.ts`). The Quest's return URL is the one wave 13 fixed: `com.companionintelligence.scan.quest://auth`. No new route, token type, env var or queue.
- **The ScanAR pose convention (F-33), from the SDK documentation:**
  - ARCore's `Camera.getPose()` is "relative to the image readout". It differs from `getDisplayOrientedPose()` "by a local rotation about the Z axis by a multiple of 90°". `getProjectionMatrix` "reflects the current display geometry and display rotation".
  - ARKit's `ARCamera.transform` is "constant with respect to device orientation", and its x-axis lies along the long axis of the device. `projectionMatrix(for: .portrait, …)` is portrait.
  - So both plugins send the display-oriented camera-to-world transform:
    - Android: `camera.getDisplayOrientedPose()`.
    - iOS: `simd_inverse(camera.viewMatrix(for: .portrait))`.
  - +Y is the top of the portrait JPEG, and -Z is the view direction. Positions do not change.
  - The fix is at the source: a fixed roll in `native-codec.ts` would be wrong on a phone whose `SENSOR_ORIENTATION` is 270.
- **Tracking strings.** Both platforms send only these words:
  - `normal`, `notAvailable`, `limited`;
  - `limited.initializing`, `limited.excessiveMotion`, `limited.insufficientFeatures`;
  - `limited.relocalizing`, which only ARKit sends. ARCore has no relocalization state, and none is invented: the codec test and the `native.ts` header depend on that.
- **The Quest app's numbers follow the web** (`src/capture/keyframes.ts` DEFAULTS, `UPLOAD_RETRIES`, the 5 s drain; `src/ar/frame-epoch.ts` `FRAME_JUMP_TRANSLATION_M`, `FRAME_JUMP_REFRACTORY_MS`). The one exception is a number with a device reason, and that reason is written beside the constant.
- **New Node test cases** go into test files a `package.json` script already runs, because `package.json` belongs to no session. A new file would need a `tests/unit/node/wp-*.test.ts` name to be run by `npm run test:wave`; none was needed. New Deno tests go under `tests/unit/deno/`, which `deno task test` runs whole.
- **No host names, addresses, personal names or home paths** anywhere. Use `<host>` placeholders.

## Before implementation

- Read SESSION_RULES.md (wave 14), `src/ar/native.ts`, `src/ar/native-bridge.ts`, `src/ar/native-codec.ts`, both `ScanARPlugin` sources, `ScanARRenderer.java` and `src/shared/shell-sign-in.ts`.
- Read every Quest source under `meta/app/src/main` and its tests.
- Read the tests that read the native sources:
  - `native_ar_codec`, `native_provider` and `wp-09b-native-provider`;
  - `wp-docs-config-honesty` and `wp-docs-device-claims`, whose premise is that only the unregistered `ArSessionPlugin.java` calls `requestInstall`;
  - `native_release`, which pins the workflows.

## Open questions & answers

- Q: Does the page ever call `ScanAR.start()` on a phone without ARCore? — A: No. `chooseNativeRuntime` picks native only when `capabilities().supported`. So `start()` asks Google Play to install ARCore, `capabilities()` reports `installable`, and the page's choice is unchanged. Choosing native for an installable phone is an owner decision, and a one-line change in scanner-ui's `runtime-select.ts` (decided by native-apps, 2026-11-23).
- Q: What does ARKit do on resume without a handler? — A: Apple's `sessionShouldAttemptRelocalization(_:)` page: "If by default you don't implement this function, ARKit spends a few seconds trying to relocalize before restarting your session". A restart is a new coordinate frame. So the plugin returns true for a named Place, whose frame is the point of its world map, and false otherwise. For other sessions the session then "restarts immediately", and the page already reads a relocalization or a long loss as a new epoch. Apple also says that with true, "the app stays in relocalizing state indefinitely" if the person never goes back, and the person can stop and restart the scan (decided by native-apps, 2026-11-23). Needs a device run.
- Q: Remove the desktop plist's camera and location keys (FN-166)? — A: No. The editor's "Scan a Place" link opens `/`, where `src/main.ts` starts the geo tracker (`navigator.geolocation.watchPosition`), and the WebXR scanner link is in the bundle too. On macOS a request for a key the app does not declare can end the process. The strings are reworded to say what is true. Removing the keys is an owner decision, once the desktop bundle carries no capture page (decided by native-apps, 2026-11-23).
- Q: Quest keyframe numbers, a device reason or not? — A: None given. The comment's reason, that "a head moves more", argues for the opposite. Also, 500 ms and 8° reach the server's 2000-keyframe cap in about 17 minutes. Aligned to 1200 ms, 0.30 m and 20° (decided by native-apps, 2026-11-23).
- Q: Quest epoch numbers? — A: The translation floor is aligned to 0.30 m, and a 500 ms refractory window is added, as on the web. The 25° rotation and the 100 ms window are kept, with the device reason written beside them. The headset compares raw display-rate head poses with no motion prediction: 8° in one 72 Hz frame is 576°/s, within a fast head turn, while 25° is 1800°/s (decided by native-apps, 2026-11-23).
- Q: Quest 408 and 429 retries? — A: Kept. They are HTTP semantics (RFC 9110, RFC 6585), not a device number, and they are listed for capture-core as a web follow-up (decided by native-apps, 2026-11-23).

## Files impacted

- **Changed:**
  - `mobile/android/app/src/main/java/com/companionintelligence/scan/ScanARPlugin.java` and `ScanARRenderer.java`
  - `mobile/android/app/src/test/java/com/getcapacitor/myapp/ExampleUnitTest.java` and `mobile/android/app/src/androidTest/java/com/getcapacitor/myapp/ExampleInstrumentedTest.java`
  - `mobile/ios/App/App/ScanARPlugin.swift` and `Info.plist`, `mobile/README.md` and `mobile/package.json`
  - `src/ar/native.ts`, `src/ar/native-bridge.ts`, `scripts/native/build-web.mjs`
  - `meta/app/src/main/AndroidManifest.xml` and `meta/app/src/main/java/com/companionintelligence/scan/quest/**`, for sign-in, splat names, vision, dataset, upload and constants, and their tests
  - `desktop/src-tauri/Info.plist`
  - `.github/workflows/mobile-build.yml` and `desktop-build.yml`
  - the tests `native_ar_codec`, `native_ar_provider`, `native_provider`, `native_build`, `native_release` and `wp-09b-native-provider`, plus the one premise case in each of `wp-docs-config-honesty` and `wp-docs-device-claims`
- **New:**
  - `mobile/android/app/src/main/java/com/companionintelligence/scan/ScanARRules.java`
  - `meta/app/src/main/java/com/companionintelligence/scan/quest/auth/*.kt` and their tests
  - `meta/app/src/test/resources/pose-to-matrix.fixture.json`
  - `tests/unit/deno/native_quest_pose_fixture.test.ts`
  - `.github/workflows/quest-build.yml` and `.github/workflows/subsystem-tests.yml`

## Schema required

- `NativeARCapabilities.installable?: boolean` (src/ar/native-bridge.ts) is optional. It is true on Android when ARCore can run but is missing or too old, so `start()` would ask Google Play for it.
- Nothing else changes. The `transform` wire field keeps its shape, and its documentation now states its orientation.

## Definition of Done

- [x] **Android `start()` (F-31):**
  - [x] It answers with the running session only when depth is unchanged. A new `hitGrid` is applied, and new depth restarts the session.
  - [x] It refuses depth the device lacks, as iOS does.
  - [x] It asks Google Play to install ARCore, and resolves or rejects each call exactly once, across the install, a decline, a stop and a destroy.
- [x] Android tracking strings follow the pinned list. `everTracked` decides whether a PAUSED with no reason still reads as initializing.
- [x] iOS answers `sessionShouldAttemptRelocalization(_:)`, and logs `sessionInterruptionEnded(_:)`.
- [x] Both plugins' headers and `mobile/README.md` describe the camera permission path.
- [x] Both plugins send the display-oriented transform. `native-bridge.ts` states it, and a source-reading test fails if either goes back to the sensor pose.
- [x] `NativeARProvider.start()` waits for a pending `stop()` (FN-157).
- [x] **Quest:**
  - [x] Sign-in with PKCE through the system browser, with the intent filter and an origin-scoped Bearer header.
  - [x] Splat names the server serves.
  - [x] Vision runs only while capturing.
  - [x] A bounded dataset queue.
  - [x] A 413 skips one frame.
  - [x] Numbers are aligned or documented.
  - [x] A shared `poseToMatrix` fixture.
- [x] iOS Info.plist is portrait only with `arkit`. Android's template tests are real tests. The desktop plist strings are true.
- [x] **Workflows:**
  - [x] Quest build and tests.
  - [x] Android unit tests, and the instrumented-test compile.
  - [x] Desktop `cargo test`.
  - [x] Gimbal and 4D tests.
  - [x] An 8th Wall APK.
- [x] Shell bundles leave out the dev pages (FN-164).
- [x] `mobile/README.md` lists the capability keys (FN-165).

## Tests

- [x] Android JVM: `ScanARRules`, covering tracking names, install steps and start plans, in `ExampleUnitTest`. `OriginAnchorStoreTest` passes.
- [x] Android instrumented: `ExampleInstrumentedTest` asserts the real package and the sign-in intent filter. It compiles here and needs a device or emulator to run.
- [x] Quest JVM:
  - [x] PKCE against RFC 7636 Appendix B;
  - [x] return-URL parsing, a replayed code and an expired pending sign-in;
  - [x] the exchange against the HTTPS mock server;
  - [x] Bearer only to the server's origin;
  - [x] the 413 cases;
  - [x] splat names;
  - [x] the selector and epoch numbers;
  - [x] the fixture read by `CoordinateConversionsTest`.
- [x] Deno: `native_quest_pose_fixture.test.ts` checks the fixture against the real `poseToMatrix`.
- [x] Node:
  - [x] the codec reads the display-oriented pose from both sources;
  - [x] the provider's stop/start race;
  - [x] `build-web.mjs` dev pages and `--ar-runtime`;
  - [x] the workflows' jobs and pins.

```bash
source ~/.nvm/nvm.sh && nvm use 22.23.2 && export ONNXRUNTIME_NODE_INSTALL_CUDA=skip PATH="$HOME/.deno/bin:$PATH"
# The Android project needs the web bundle synced in first: npm ci --prefix mobile, npm run build --prefix mobile.
# :app only: the generated capacitor-cordova-android-plugins module's instrumented-test classpath fails its duplicate-class check.
(cd mobile/android && ./gradlew --max-workers=4 -Dorg.gradle.jvmargs=-Xmx3g testDebugUnitTest assembleDebug :app:assembleDebugAndroidTest --no-daemon)
(cd meta && ./gradlew --max-workers=4 -Dorg.gradle.jvmargs=-Xmx3g :app:testDebugUnitTest :app:assembleDebug --no-daemon)
npm run test:native-ar && npm run test:native-provider && npm run test:native-build && npm run test:native-release && npm run test:wave
deno test --allow-read tests/unit/deno/native_quest_pose_fixture.test.ts
# cap sync leaves a copy of the 8th Wall engine in mobile/android/app/src/main/assets/public (git-ignored), and the
# engine-quarantine test reads every file of the tree outside the folders it skips, so remove that copy first.
rm -rf mobile/android/app/src/main/assets/public
npm run verify
```

## Acceptance Criteria

- [ ] The overlay and the keyframe pose come from the same orientation as the projection and the JPEG. Needs a device run on each platform. Decided from the SDK documentation, and checked in the decode-side tests.
- [ ] Given a server with sign-in on, the Quest app signs in and its uploads are accepted. Needs a headset and server-core's `shell=quest`. The JVM tests run the exchange against an HTTPS mock server.
- [x] A change to the server's `poseToMatrix` fails the Deno test. A fixture regenerated for it then fails the Kotlin test until the Kotlin copy follows.

## Lists for the owner (F-32, F-34, FN-172, FN-161)

Checked by grep at this branch's head. Nothing in these lists was wired or deleted.

- **F-32 and FN-154: native features the page never calls.** No file of `src/` outside `native.ts` and `native-bridge.ts` calls any of these:
  - `NativeARProvider.saveWorldMap()`. An iOS map is saved only by the autosave of the Place named in `?world=`.
  - `NativeARProvider.captureDepth()`. The session is never started with depth, so it would answer null on both platforms.
  - `NativeARProvider.worldMapState()`.
  - Android's `setOriginAnchor()` and `getOriginAnchor()`. `OriginAnchorStore.write()` writes `scan-origin-anchor.json`, and nothing reads it back.
  - `capabilities().installable`, new in this ticket. The page's runtime choice does not read it.
- **F-34 and FN-153: the ArSession design**, unregistered on both platforms. Deletion candidates, pending the owner's ADR 0009 decision:
  - `mobile/android/app/src/main/java/com/companionintelligence/scan/ArSessionPlugin.java` compiles into the APK. `MainActivity` registers only `ScanARPlugin`.
  - `mobile/ios/App/App/ArSessionPlugin.swift` is not in the Xcode target's sources.
  - `src/ar/native-provider.ts` has no importer in `src/`, and its registration test is skipped. It reuses the class name `NativeARProvider` and keeps its own epoch counter.
  - Its `requestInstall` call is no longer the tree's only one, since `ScanARPlugin.start()` now asks.
- **FN-172: Quest test-only and unused code.** Deletion candidates:
  - Called only from tests: `CoordinateConversions.keyframePose`, `companionScanToSpatial`, `mq3dreconHmdToSpatial` and `companionScanPointToScene`. The app composes `cameraPoseInScene` and `spatialToCompanionScan` inline in `CaptureController`.
  - Also called only from tests: `Quat.toMatrix` and `RigidPose.transformPoint`. `Quat.toMatrix` is now held to the `poseToMatrix` fixture.
  - `CaptureController.Status.uploading` is set and never read.
  - `Mq3dreconLayout.SESSION_INFO_JSON` is declared and never written.
- **FN-161: entitlements, a note only.**
  - Nothing under `mobile/ios` declares entitlements: no `.entitlements` file, and no `CODE_SIGN_ENTITLEMENTS`. So there are no associated domains, keychain groups or app groups.
  - The sign-in return uses the custom URL scheme in `Info.plist`.
  - Moving the session token to the app's own Keychain items needs no entitlement.
  - An `https` sign-in return through universal links would need the associated-domains entitlement and a file served by the server.
- **Owner decisions:**
  - Whether the page starts the native runtime on an `installable` ARCore phone. That is a one-line change in `src/ar/runtime-select.ts`.
  - Whether `quest-build.yml`, `subsystem-tests.yml` and `mobile-build.yml` run on push or pull request. Every workflow is `workflow_dispatch` only, as `deno-ci.yml`'s gated block keeps it.
  - Removing the desktop plist's camera and location keys, once the desktop bundle carries no capture page.
  - Moving the Quest token, like the phone shells' token, to the Keystore before a store build.
  - A debug-only `applicationIdSuffix` for the 8th Wall APK (wave 13, ticket 0004, not done), so that both builds install side by side.

## Risks / potential issues

- **Risk:** Nothing here runs on a device. Swift is not compiled here. — **Mitigation:** Swift changes are small and use API families the file already compiles with (`projectionMatrix(for:…)`). Everything is marked "needs a device run", and the iOS part "not compiled until CI runs on a push".
- **Risk:** The ARCore install flow pauses the activity. — **Mitigation:** The call is kept across the pause and finished in `handleOnResume()`, rejected in `handleOnDestroy()` and `stop()`, and never resolved twice.
- **Risk:** The Quest intent filter sits on the immersive activity. — **Mitigation:** The activity is `singleTask`, so the return is handled in `onNewIntent()`, and in `onCreate()` on a cold start. Needs a headset.
- **Risk:** Two doc-honesty tripwires flip. — **Mitigation:** Only their premise changes. The check that `NOTICE.md` does not say Google Play installs ARCore stays, because the page still never reaches the install: `capabilities()` reports `supported` only once ARCore is installed, and the page picks native from `supported`.
- **Risk:** Behaviour changes the owner should know about. — **Mitigation:** They are listed here and in the report:
  - An iOS session without a named Place now restarts at once after an interruption, instead of after ARKit's few seconds of relocalization.
  - Quest keyframes drop from up to two a second to one per 1.2 s at most, about 0.8 a second.
  - The Quest's 25° epoch number rests on an estimate of head speed, not a measurement.
  - `start()` waits for a pending `stop()` without a bound, because a start that went ahead of a late stop would be torn down by it. Both plugins always answer `stop()`.
- **Risk:** `cargo test` has never run anywhere, because this host has no Rust toolchain. — **Mitigation:** It runs in `desktop-build.yml` only. The release workflow is left as it was, until a desktop-build run has passed the tests.

## Subtasks

1. [x] Android plugin: start options, depth, install, tracking strings, pose, rules and tests.
2. [x] iOS plugin: pose, relocalization, permission notes, Info.plist.
3. [x] Web: bridge contract, provider race, codec source tests, the two premise cases.
4. [x] Quest: sign-in, splats, vision, dataset, 413, numbers, fixture.
5. [x] Build script, mobile scripts, workflows, desktop plist, README.
6. [x] Gradle builds and tests, then `npm run verify`, then commit.
