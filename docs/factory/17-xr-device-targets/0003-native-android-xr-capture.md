> **Type:** Native / Android
> **Wave:** 17-xr-device-targets
> **Branch:** `feat/android-xr-runtime`
> **Commit style:** `feat(android-xr): summary`
> **Design:** to be settled from 0002's results, and recorded in an ADR before any runtime code. The probe in
> `android-xr/` ([its README](../../../android-xr/README.md)) is the spike that feeds that ADR; it is not runtime code.
> **Dependencies:** 0002, and the owner's go-ahead (given 2026-11-24: work started)

## Goal

Capture on XREAL Aura from inside the app, through the native runtime contract that ARCore and
ARKit already use (`ScanAR`, `NativeARProvider`, ADR 0009). The pose would come from Android XR's
own tracking. The frames would come from the glasses' camera, if apps may open it.

## Non-goals

- Do not add a second upload path. Keyframes go through `POST /sessions`,
  `POST /sessions/:id/keyframes` and `POST /sessions/:id/finalize`, as every target's do.
- Do not build a Unity, Godot or OpenXR app.
- Do not change the phone builds' behaviour, or their locked release dependencies, without a
  variant switch that keeps them as they are.

## Pinned conventions

- **ADR 0001:** this extends `ScanAR` and the `ARProvider` contract, and adds no second provider
  family. The keyframe `pose` stays camera-to-world in OpenGL/Blender axes, which is what the
  splat dataset builder reads (`poseToMatrix`).
- **ADR 0009:** native first, then the web runtimes, inside the shell.
- **The Quest app is the reference** for pairing camera frames with a head pose on one clock
  (`meta/`: `pose/` and `capture/`). Share that code, or port it with its tests. Do not copy it
  without its tests.
  - The probe shares it: `android-xr/quest-shared/` compiles seven of the Quest's pure-Kotlin files from `meta/`, and
    the Quest's own tests stay where they are.
- **Google's documented pieces, read again on 2026-11-24** ([sources](#sources)):
  - ARCore for Jetpack XR's device pose needs the runtime permission `android.permission.HEAD_TRACKING` "on immersive
    devices". Whether wired XR glasses count as immersive is still not stated. Google's XR permissions page lists
    neither `HEAD_TRACKING` nor `CAMERA`, and says every permission it does list is a dangerous one.
  - Plane tracking and hit tests need `android.permission.SCENE_UNDERSTANDING_COARSE`. A capture needs neither.
  - The libraries are no longer previews only. Google Maven lists stable `1.0.0` releases of `androidx.xr.runtime:runtime`,
    `androidx.xr.arcore:arcore` and `androidx.xr.scenecore:scenecore`. `1.1.0-alpha02` and `1.1.0-alpha03` are the
    previews. Every 1.0.0 artifact declares `minSdk 24`.
  - XREAL's getting-started page names `androidx.xr:xr-compose:1.0.0` with `minSdk 35`. That coordinate matches none on
    Google's pages. An app with `minSdk 35` would not install on the Aura, which runs API 34.

## Before implementation

- 0002's record, all of it.
- `mobile/android/app/src/main/java/com/companionintelligence/scan/ScanARPlugin.java`,
  `src/ar/native.ts`, `src/ar/native-bridge.ts`, `src/ar/runtime-select.ts`.
- `meta/app/src/main/java/com/companionintelligence/scan/quest/pose/` and `capture/`, with their tests.
- `mobile/android/app/gradle.lockfile`, `tests/unit/node/android_lockfile.test.ts`, and `ANDROID_LICENCES` in
  `scripts/native/third-party-notices.mjs`: every new library needs a lock line and a licence entry.

## Open questions & answers

Sources are listed at the end ([Sources](#sources)). "The library's code" means the 1.0.0 sources jars on Google
Maven, read on 2026-11-24.

- Q: Can an app open the glasses' camera, and which permission does it need? — In part. Opening it is still OPEN, and
  the probe is the test.
  - Camera2 lists three cameras open to apps (0002): `auracamerahal/0`, back-facing; `avatar/1`, front-facing; and
    camera 11, a depth camera. The other four are SYSTEM_CAMERA devices.
  - Google told the press in February 2025 that an Android XR app reads the world-facing stream as `camera_id` 0, and
    the avatar stream as 1, through Camera2 or CameraX, after the ordinary camera permission (UploadVR). No Google page
    read says so, and none mentions wired glasses.
  - Unity's Android XR camera feature says it "does not support AR Foundation image capture". XREAL's pages say only
    that the RGB camera "provides visual input for Google Gemini".
  - **Camera 0's static characteristics, read on the Aura with `dumpsys media.camera` on 2026-11-24** (no install, no
    launch, camera lines only):
    - LIMITED hardware level, `BACKWARD_COMPATIBLE` only, and `SENSOR_INFO_TIMESTAMP_SOURCE` = **REALTIME**.
    - **No `LENS_POSE_TRANSLATION`, `LENS_POSE_ROTATION` or `LENS_POSE_REFERENCE`.**
    - **No `LENS_INTRINSIC_CALIBRATION` or `LENS_DISTORTION`.**
    - Focal length 2.4 mm. Physical size 3.2 × 2.4 mm (4:3), against a pixel array and active array of 1920 × 1080
      (16:9).
    - YUV, PRIV and JPEG at 1920×1080, 1440×1080, 1280×720, 640×480 and 320×240. AE target ranges [15, 30] and [30, 30].
    - `SENSOR_READOUT_TIMESTAMP` = HARDWARE. Its results carry the exposure time and the rolling shutter skew.
    - The depth camera's calibration looks like placeholders: fx = fy = 2.4 with the principal point at (0, 0), and a
      lens pose of zero translation and a half turn about Y, relative to the primary camera.
  - The permission is `android.permission.CAMERA`. The probe asks for it and logs `openCamera`'s exact answer.
- Q: Which Android version and API level does the puck run? Can the shell's `minSdk 24` and
  `compileSdk 36` stay? — A (0002, 2026-11-24): Android 14, API 34.
  - `minSdk 24` and `compileSdk 36` can stay.
  - The puck also reports `android.software.xr.api.openxr` (65538), `android.software.xr.api.spatial` (4) and
    `android.hardware.xr.input.hand_tracking`.
- Q: Do the Jetpack XR libraries go into every Android build, or only into a build for Android XR
  behind a switch? — A (2026-11-24, a recommendation; the owner decides it in the ADR): **a separate app, as `meta/` is
  for the Quest.**
  - `androidx.xr.arcore:arcore:1.0.0` brings in `arcore-play-services`, and through it `com.google.ar:core:1.56.0`.
    The shell locks `com.google.ar:core:1.57.0` (`mobile/android/variables.gradle`), so this would be a second route to
    ARCore in the phone builds' resolution, and their strict release lock would grow by Jetpack XR, coroutines,
    lifecycle and media3 (through scenecore). The phones never use any of it.
  - Its API is Kotlin coroutines: `Session.create` is a suspend function and every state is a `StateFlow`. The shell's
    native code is Java, with no Kotlin plugin.
  - The WebXR-only build, which PICO shares, would carry it too, unused.
  - A separate application id installs beside the WebXR build, as the probe does.
- Q: Home Space or Full Space? A capture needs the pose of the glasses, not of a panel. — A (2026-11-24): **Home Space.**
  - The device pose is a session setting (`DeviceTrackingMode.SPATIAL`), not a feature of a space.
  - Google's device-pose page lists wired XR glasses. Its spaces page says apps open in Home Space by default, and that
    only spatialization needs Full Space. It is silent on perception in either space.
  - The pose is "relative to the world origin" of the session (the device-pose page), not a panel's.
  - Observed on 2026-11-24: a Jetpack XR 1.0.0 probe from another project, started in Home Space on this Aura, got
    `SessionCreateSuccess`, then `SessionConfigureSuccess` for device tracking, then `TRACKING` and 136 head-pose updates
    in 3 s (about 45 Hz). Its permissions had been granted.
  - The Scan probe declares `XR_ACTIVITY_START_MODE_HOME_SPACE` and measures this again.
- Q: How does an app get the glasses' head pose, and on which clock? — A (2026-11-24, from the documentation and the
  library's code; not yet measured):
  - **The pose.** ARCore for Jetpack XR: `Session.create(context, lifecycleOwner)`, then
    `session.configure(Config(deviceTracking = DeviceTrackingMode.SPATIAL))`.
    - The device state is `ArDevice.getInstance(session).state`, or each update's `CoreState.perceptionState`
      `.arDeviceState`.
    - It needs `HEAD_TRACKING`, as above.
    - Its frame is right-handed, +Y up, looking down −Z (`Vector3.Forward` is (0, 0, −1)): the keyframe convention
      already.
    - Updates come about every 20 ms plus their own work: `OpenXrRuntime.update` waits a fixed 20 ms.
  - **Its clock.** Each update marks the time on the OpenXR runtime's own clock (`OpenXrTimeSource` reads `XrTime`). It
    asks the runtime for the device at that time, waits 20 ms, and hands the mark on as `CoreState.timeMark`
    (`OpenXrRuntime.update`, `Session.update`).
    - `CoreState.perceptionState` is built for that same update (`PerceptionStateExtender`).
    - `ArDevice.State` itself has no time. A collector of `ArDevice.state` gets the pose before the session hands out
      its mark, so it can pair a pose with the wrong update.
  - **On the boot clock.** The probe reads the mark's age, `timeMark.elapsedNow()`, which comes from that same XR clock,
    between two boot-clock reads: pose time = (before + after) / 2 − age.
    - Camera 0 stamps its frames on the boot clock (REALTIME, above), so frames and poses meet there, as on the Quest.
    - The probe checks over each run that the two clocks keep one rate.
  - **Not known.** What the runtime returns for that time: a pose located at it, or the last one it had.
    `DeviceTrackingMode.SPATIAL` says "the last known 6DoF ... pose", with "generally a delay". The stamp is the update's
    time, then, and how far the pose lags it is unmeasured until a recording is calibrated.
- Q: The pose is the glasses', and the camera sits apart from it. Where does the offset between
  them come from? — A (2026-11-24): **not from the platform, as far as anything read shows. It needs a calibration.**
  - Camera 0 reports no lens pose (above).
  - The only offsets Jetpack XR gives are the render viewpoints': `RenderViewpoint.State.localPose`, "a local offset
    from the device's central tracking point". Those are the displays, not the camera. The probe records them.
  - No Google or XREAL page gives the camera's place on the glasses. The device pose's origin is "the center of the
    device" (the library's `DeviceState`).
  - So the offset comes from a recording: structure-from-motion camera poses set against the device poses, a hand–eye
    solve (AX = XB). The same reconstruction gives the intrinsics, which are missing too, and the time offset between a
    frame and its pose.
  - Until then the probe's keyframe pose is the device pose. Its intrinsics are estimated from the focal length and the
    sensor's width: 1440 px at 1920 × 1080, a 67.4° × 41.1° field of view. Both are marked as such in `probe.json`.

## Plan

1. **The probe** (this branch): `android-xr/`, a separate Gradle project with two modules, as `meta/` is one.
   - Camera 0 through Camera2.
   - The device pose from ARCore for Jetpack XR, on the boot clock.
   - Pairing frame to pose by the Quest's own ring buffer and maths.
   - A recording in the shape of a Scan session.
   - JVM tests for every pure part. No device run.
2. **Run it on the Aura**, with the owner's yes for the install, and with nobody wearing the glasses unless the owner is.
   1. At rest: does camera 0 open with `CAMERA` alone (or what does `openCamera` say)? Then the frame rate and latency,
      the pose rate and age, whether the two clocks keep one rate, whether frames pair with poses, and the render
      viewpoints.
   2. Worn, turning slowly round a room: a recording to calibrate.
3. **Calibrate** from the worn recording:
   - the intrinsics (structure from motion with one shared camera, or a checkerboard);
   - the camera's offset from the device pose (hand–eye);
   - the time offset, from the rotation rates of the two pose streams.

   Then decide whether one constant per glasses model is enough.
4. **The ADR**, numbered after the last one in `docs/adr/`. For the owner:
   - a separate app (recommended above) or the shell behind a variant;
   - whether the app uploads itself, like the Quest app, or reports through `ScanAR` to a WebView build;
   - where the calibration lives.
5. **The runtime**:
   - capture and upload through the existing routes, with the Quest's uploader shared the same way, if it is a separate
     app;
   - its lock lines and notices;
   - the target page;
   - a run on the Aura.

## Progress

**2026-11-24: questions answered, and the probe built** (`android-xr/`, [README](../../../android-xr/README.md)):

- `./gradlew :probe:testDebugUnitTest :probe:assembleDebug` in `android-xr/` passes: 49 JVM tests in 9 classes, and a
  22 MB debug APK, arm64 only.
  - Each tested part was broken once on purpose, and its test failed every time (20 changes).
- The Quest app gained one value, `PoseTimeSource.XR_UPDATE_TIME`, the probe's stamp, and one branch for it. Its 108
  JVM tests still pass, and its debug APK still builds.
- The Aura was read once with `dumpsys media.camera`, for camera 0's characteristics (above). Nothing was installed or
  launched on it.
- Not done: everything on a device, the calibration and the ADR.

## Files impacted

This branch:

- `android-xr/`: the probe and `quest-shared/` (new);
- `meta/app/src/main/java/com/companionintelligence/scan/quest/pose/Clocks.kt` (`PoseTimeSource.XR_UPDATE_TIME`) and
  `ImmersiveActivity.kt` (its branch in the panel text);
- this ticket, the wave README and `docs/targets/xreal-aura.md`.

Later, with the design:

- the runtime itself, in `android-xr/` or behind a shell variant, as the ADR decides;
- if in the shell: `mobile/android/app/build.gradle`, `mobile/android/variables.gradle`, `mobile/android/app/gradle.lockfile`,
  `scripts/native/third-party-notices.mjs`, `src/ar/native-bridge.ts` (an `engine` value for Android XR) and
  `src/ar/runtime-select.ts`;
- the target page.

## Schema required

None expected. Keyframes keep today's `meta` shape.

## Definition of Done

- [ ] An ADR records the design, chosen from 0002's results and the probe's runs.
- [ ] On an Aura, a capture's keyframes reach the server, and their poses line up in the editor.

## Tests

- [x] The probe's JVM tests, which need no device: the boot-clock stamp, the Jetpack XR pose conversion (pinned to
  Jetpack XR's own classes and to the server's `poseToMatrix` fixture), the tracking gate, the recording's shape against
  `server/wp-a-keyframes.ts`, the camera choice, the intrinsics estimate, the pairing (each keyframe live, every frame
  after the run) and the statistics.
- [ ] JVM unit tests for the runtime's pose conversion, against the server's `poseToMatrix` fixture, as the Quest app's are.
- [ ] `npm run test:native-ar` for the provider choice with an Android XR answer, if the runtime goes through `ScanAR`.

```
(cd android-xr && ./gradlew :probe:testDebugUnitTest :probe:assembleDebug)
(cd meta && ./gradlew :app:testDebugUnitTest)
(cd mobile/android && ./gradlew testDebugUnitTest)
npm run test:native-ar
npm run test:android-lockfile && npm run test:notices
```

## Acceptance Criteria

- [ ] Given an Aura on which 0002 found the camera open to apps: when a capture runs, then the
  session's keyframes reach the server, each with a pose and intrinsics, and the existing jobs
  build a scan from them.

## Risks / potential issues

- **Risk:** the camera is closed to apps, so there are poses and no frames. — **Mitigation:**
  the probe's first run settles it. A pose-only capture is not a scan, and the ticket may end at the ADR.
- **Risk:** the APIs change. — **Mitigation:** pin versions (1.0.0, stable), lock them, and re-read Google's pages when
  the runtime starts.
- **Risk:** the HAL's own calibration is missing (camera 0) or placeholder (camera 11). — **Mitigation:** calibrate from
  a recording, and never trust a reported calibration without a plausibility check (`CameraFacts.isPlausible`).
- **Risk:** the pose lags its stamp by an unknown amount. — **Mitigation:** measure it from a worn recording (step 3)
  before the runtime trusts the pairing.

## Subtasks

1. [x] Answer the open questions, and build the probe (this branch).
2. [ ] Run the probe on an Aura, with the owner's yes for the install.
3. [ ] Calibrate from a worn recording: intrinsics, the camera's offset, the time offset.
4. [ ] Write the ADR.
5. [ ] Add the libraries behind the switch or app the ADR chooses, with their lock lines and notices.
6. [ ] Add the runtime, its unit tests, and the target page's update.
7. [ ] Run it on an Aura, with the owner's yes for each install.

## Sources

Read on 2026-11-24.

- Google:
  - [Track a device's pose using ARCore for Jetpack XR](https://developer.android.com/develop/xr/jetpack-xr-sdk/arcore/device-pose)
  - [Understand permissions for XR](https://developer.android.com/develop/xr/permissions)
  - [Transition from Home Space to Full Space](https://developer.android.com/develop/xr/jetpack-xr-sdk/transition-home-space-to-full-space)
  - [Understand the types of Android XR devices](https://developer.android.com/develop/xr/devices)
  - [Add XR to an existing app](https://developer.android.com/develop/xr/jetpack-xr-sdk/add-xr-to-existing)
  - Google Maven's group indexes for [androidx.xr.arcore](https://dl.google.com/android/maven2/androidx/xr/arcore/group-index.xml),
    [androidx.xr.runtime](https://dl.google.com/android/maven2/androidx/xr/runtime/group-index.xml) and
    [androidx.xr.scenecore](https://dl.google.com/android/maven2/androidx/xr/scenecore/group-index.xml)
  - The library's code, in the 1.0.0 sources jars on Google Maven:
    - `androidx.xr.arcore:arcore-openxr`: `OpenXrRuntime.kt`, `OpenXrTimeSource.kt`, `OpenXrDevice.kt`, `DeviceState.kt`
      and `OpenXrPerceptionManager.kt`;
    - `androidx.xr.arcore:arcore`: `ArDevice.kt`, `PerceptionState.kt`, `PerceptionStateExtender.kt` and
      `RenderViewpoint.kt`;
    - `androidx.xr.runtime:runtime`: `Session.kt`, `CoreState.kt`, `XrCapabilities.kt` (`DeviceTrackingMode`) and
      `math/` (`Vector3`, `Quaternion` and `Pose`).
    - Their POMs give the dependencies named above.
- The press: [UploadVR, "Android XR Will Let Apps Access The Passthrough Camera View, Google Confirms"](https://www.uploadvr.com/android-xr-will-give-developers-passthrough-access/),
  8 February 2025, quoting Google's statement.
- Unity: [Android XR camera feature](https://docs.unity3d.com/Packages/com.unity.xr.androidxr-openxr@1.0/manual/features/camera.html).
- XREAL: [Aura developers](https://tutorials.xreal.com/docs/aura/developers/),
  [Getting started](https://tutorials.xreal.com/docs/aura/developers/getting-started) and
  [Hardware overview](https://tutorials.xreal.com/docs/aura/introducing-aura/hardware-overview).
- On the device: `dumpsys media.camera` on the Aura (2026-11-24), camera lines only.
