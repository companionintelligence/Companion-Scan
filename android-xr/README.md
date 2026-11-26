# Android XR probe (XREAL Aura)

A small Android app that tests whether an XREAL Aura can capture the way the Quest app does: Camera2 frames from the
glasses' camera, each paired with the glasses' pose on the same clock. It writes a short recording in the shape of a Scan
capture session. It is the spike for wave 17 ticket
[0003](../docs/factory/17-xr-device-targets/0003-native-android-xr-capture.md), not the capture runtime: it uploads
nothing, and it has no network access.

**Status:** it builds here and its JVM unit tests pass. **It ran on an Aura at rest on 2026-11-24**, installed at the
owner's word ([report](reports/2026-11-24-xreal-aura-probe.txt)):
- with `CAMERA` and `HEAD_TRACKING` both granted, camera 0 opened at 30 Hz and the head pose tracked at 43 Hz;
- with neither granted, the session still configured but nothing tracked. A run with one and not the other is still to
  do;
- every frame was paired with a pose on the boot clock;
- 28 keyframes were recorded in the server's shape.

A worn run is still to do. Each install needs the owner's yes.

## What it does

1. Asks for `android.permission.CAMERA` and `android.permission.HEAD_TRACKING` through the system dialog, if they are
   not granted yet. It never grants anything itself.
2. Starts an ARCore for Jetpack XR session (1.0.0) and configures `DeviceTrackingMode.SPATIAL`. It collects
   `Session.state` and reads each update's device pose from `CoreState.perceptionState`.
   - The pose is stamped on the boot clock with the update's time mark (`XrPoseStamp.kt`).
   - It keeps only `TRACKING` samples, and starts a new keyframe epoch when tracking comes back (`TrackingGate.kt`).
3. Opens camera 0, the back-facing colour camera (`CameraChoice.kt`), as YUV_420_888 at 1920×1080 by default, the size
   of its active array.
   - It logs every frame: the timestamp, when it arrived, and the exposure, rolling shutter skew and readout time.
4. Every 500 ms it takes a keyframe:
   - it waits for the pose after the frame's timestamp, and interpolates (`PosePairing.kt`);
   - it composes the keyframe pose with the camera's lens pose (`AndroidXrConversions.kt`);
   - it writes the JPEG and its line in the recording.
5. After 15 s it stops, prints a report to logcat under the tag `ScanXrProbe`, and writes `probe.json`.

Each part reports on its own. A session that does not start still leaves the camera's report, and a camera that does not
open still leaves the pose statistics.

## What it shares with the Quest app

`quest-shared/` compiles eight of the Quest app's pure-Kotlin files from where they live in `meta/`, so there is one copy
of each:

- `pose/`: clocks, pose maths, the pose ring buffer, coordinate conversions and epochs;
- `capture/KeyframeSelector.kt` and `capture/YuvFrame.kt`;
- `upload/KeyframeMeta.kt`, the keyframe's meta shape.

The files are named one by one in `quest-shared/build.gradle.kts`, so nothing that needs the Meta Spatial SDK comes
with them. A file that moves in `meta/` fails this build. The Quest app's own tests (`meta/app/src/test`) test those
files. The Quest Build workflow runs the probe's tests and builds its APK in a job of its own, beside the Quest app's, so a
change in `meta/` that breaks the probe shows there. The probe's tests test what it adds:

- the stamp, with injected clocks;
- the Jetpack XR pose conversion, pinned to Jetpack XR's own math classes and to the server's `poseToMatrix` fixture
  (`meta/app/src/test/resources/pose-to-matrix.fixture.json`);
- the tracking gate;
- the recording's names and lines, against the server's own source (`server/wp-a-keyframes.ts`);
- the camera choice, the intrinsics estimate, the pairing (live and after the run) and the statistics.

The Camera2 code is the probe's own. The Quest's `PassthroughCamera` finds its camera by Meta's vendor keys.

## The recording

In the app's own external files folder, `files/recordings/<UTC start time>/`:

| File | What |
|---|---|
| `kf-NNNNN.jpg` | keyframes, as the server names a session's frames |
| `keyframes.jsonl` | one line per keyframe: the Quest app's keyframe meta (`KeyframeMeta.toJson`), then `file`, `bytes` and `receivedAt`, as the server appends them (`server/wp-a-keyframes.ts`) |
| `poses.csv` | every Jetpack XR update: the pose's boot-clock time, the mark's age, the tracking state, the gate's verdict, the epoch and the pose |
| `frames.csv` | every camera frame: its timestamp, boot-clock time and arrival, exposure, rolling shutter skew and readout time; the device pose at its timestamp, interpolated after the run from the tracked samples (`FramePoses.kt`), with the gaps to the samples either side; and what became of it as a keyframe |
| `probe.json` | the device, permissions, session results, camera 0's characteristics as Camera2 gave them, where the intrinsics and the camera's offset came from, the render viewpoints and the summary |

The keyframe pose is camera-to-world in the OpenGL/Blender axes the server reads. On the Aura, camera 0 reports no lens
pose and no intrinsic calibration (2026-11-24). So:

- the keyframe pose is the glasses' device pose itself;
- the intrinsics are an estimate from the focal length and the sensor size (`FocalLengthIntrinsics.kt`), marked as such
  in `probe.json`.

Both wait on a calibration (ticket 0003, the plan).

**The pictures show a room.** Keep a recording out of the repository (`android-xr/.gitignore` has `recordings/`), and
delete it once it has been read.

## Build

You need JDK 21 and the Android SDK (platform 36). No NDK is needed.

```bash
cd android-xr
./gradlew :probe:testDebugUnitTest :probe:assembleDebug
```

The APK is `probe/build/outputs/apk/debug/probe-debug.apk`, about 22 MB, for arm64 only. Its merged manifest asks for:

- `CAMERA` and `HEAD_TRACKING`;
- `WAKE_LOCK`, which comes from `androidx.media3:media3-exoplayer` through scenecore.

It has no `INTERNET`. `com.google.ar:core` (through `arcore-play-services`) adds its package queries and its
`InstallActivity`. That is Jetpack XR's runtime for phones, and Android XR does not use it.

The three Jetpack XR libraries (`runtime`, `scenecore` and `arcore`, all 1.0.0) are the set another project's Jetpack XR
probe ran with on this Aura. With them it created a session, configured device tracking and tracked, in Home Space, on
2026-11-24. The manifest starts the activity in Home Space too.

## Run on an Aura (each install needs the owner's yes)

1. Check that nobody is wearing or using the glasses, then install: `adb install -r probe/build/outputs/apk/debug/probe-debug.apk`.
2. Start it from the launcher, or by adb, which runs at once:
   `adb shell am start -n com.companionintelligence.scan.androidxr.probe/.ProbeActivity --ez autostart true`.
   - Extras: `--ei seconds 30`, `--es size 1280x720`, `--ei keyframe_ms 1000`.
   - The first launch asks for the camera and head-tracking permissions, and waits until someone answers. The probe
     never answers for them. So either the owner, wearing the glasses, answers both prompts once, or the owner says yes,
     in words, to granting them over adb:
     `adb shell pm grant com.companionintelligence.scan.androidxr.probe android.permission.CAMERA` (and the same for
     `android.permission.HEAD_TRACKING`). After that, a run at rest needs nobody to answer anything.
3. Read the report: `adb logcat -d -s ScanXrProbe -v raw`.
4. Pull the recording: `adb pull /sdcard/Android/data/com.companionintelligence.scan.androidxr.probe/files/recordings/`.

A run with the glasses at rest shows whether the camera opens and how the clocks behave. A run worn, turning the head
slowly, gives a recording a calibration can use.
