# Meta Quest app

A native app for Meta Quest 3 and 3S, built on the Meta Spatial SDK. It reads the headset's
passthrough camera, pairs each frame with the head pose, and uploads keyframes to the person's own
Scan server, where the existing reconstruction and splat jobs run.

Decision record: [ADR 0013](../adr/0013-the-quest-app-is-a-native-spatial-sdk-app-that-feeds-the-same-server.md).
Plan: [wave 13](../factory/13-device-targets/README.md), tickets 0005 and 0006.

## What it is

- **An immersive Spatial SDK app** (`meta/`, application id `com.companionintelligence.scan.quest`):
  - It turns passthrough on and uses the STAGE reference space.
  - It switches locomotion off, so the viewer pose is a physical head pose.
  - Its one panel holds the server address, start and stop, frame and upload counts, and the splat viewer.
- **Frames** come from the left passthrough camera through Camera2, after the runtime permission
  `horizonos.permission.HEADSET_CAMERA` (and `android.permission.CAMERA`) is granted.
  - The stream is YUV_420_888. The app asks for 1280×960; when the camera does not offer that
    size, it takes the offered size closest to it in area and says so on the panel
    (`chooseSize` in `capture/PassthroughCamera.kt`, the warning in `capture/CaptureController.kt`).
  - Intrinsics, lens pose and distortion are read from the camera's characteristics.
- **Head pose** comes from `Scene.getViewerPose()`:
  - It is sampled every frame into a ring buffer on the same clock as the camera timestamps.
  - It is interpolated to each frame's time and composed with the lens pose.
  - Every coordinate conversion lives in `pose/CoordinateConversions.kt`, which states its assumptions.
- **Upload** goes through the existing routes only: `POST /sessions`, `POST /sessions/:id/keyframes` and `POST /sessions/:id/finalize`.
  - Keyframes are JPEGs, with `meta` in the web scanner's shape.
  - The pose is camera-to-world in OpenGL/Blender axes, which is what the splat dataset builder reads.
  - The app sends about two keyframes a second, and only when the head has moved.
  - HTTPS only; plain http is refused.
- **Sign-in**: when the server has sign-in on, the app opens the CI-Portal sign-in in the system
  browser with `shell=quest`, comes back on `com.companionintelligence.scan.quest://auth` with a
  one-time code, trades it for the session token, and sends that token as a Bearer header on
  every request (`auth/`). Not run on a headset.
- **A local recording**, optional, in mq3drecon's legacy layout under the app's external files folder.
  It writes `left_camera_raw/*.yuv`, the camera characteristics and image-format JSON, and `hmd_poses.csv`.
- **Splat viewer**: the Spatial SDK splat module draws a splat downloaded over HTTPS from the person's
  server, or a local file.
  - The SDK lists PLY and SPZ. From the person's server the app takes only `<scan>.splat.ply`
    (a bare name, or an https address under its `/scans/`); any `.ply` or `.spz` only from another
    https host or the local folder.
  - It refuses `.compressed.ply`, `.sog` and plain `http://` (`splat/SplatSource.kt`).
- **On-device vision hook**: ONNX Runtime, CPU provider.
  - It loads a model from the app's files folder if one is there, and says so if not.
  - No weights are bundled, and its outputs stay on the headset. It runs only while a capture runs.
  - ONNX Runtime's own telemetry is switched off: its start-up provider is removed from the manifest, and the app calls `setTelemetry(false)`.

## Status

**Builds here, not run on a headset** (2026-11-23).

- `./gradlew testDebugUnitTest assembleDebug` in `meta/` passed then with 81 JVM unit tests in 13 classes, and a debug APK of about 101 MB. ONNX Runtime adds about 36 MB of that. It passed again on commit `81e437c`, the tree `main` merged as `e897380` (#282) ([Builds of the merged tree](README.md#builds-of-the-merged-tree)).
- Since wave 14 (#289) the app has 108 JVM unit tests, in 16 test files, and the **Quest Build**
  workflow (`.github/workflows/quest-build.yml`, started by hand) runs them and builds the debug
  APK. Its run 45327834865 passed on `main` at `8deb264`, after the merge.
- The unit tests cover:
  - the pose conversions, against the server's `poseToMatrix` and the SDK's own pose classes;
  - the uploader, against an HTTPS mock server;
  - the local recording's names, keys, CSV header and byte layout.
- **Not verified:** everything on a headset. That includes the camera, the timestamp pairing, the panel, the splat rendering, and whether a dialog pauses and finalizes a capture.

## Entry points and files

- `meta/app/src/main/java/com/companionintelligence/scan/quest/ImmersiveActivity.kt`: the activity.
- `capture/`: Camera2, calibration, keyframe selection.
- `pose/`: conversions, clocks, the pose buffer, epochs.
- `upload/`: the HTTPS client for the three routes.
- `dataset/`: the local recording.
- `splat/`: the splat viewer.
- `vision/`: the ONNX Runtime hook.
- `meta/app/src/main/AndroidManifest.xml`: permissions and features.

## Build

JDK 21 and the Android SDK (platform 36) are needed. No NDK is needed.

```bash
cd meta
./gradlew testDebugUnitTest assembleDebug
```

The APK is `meta/app/build/outputs/apk/debug/app-debug.apk`. It is a debug build: use it on your own
headset only.

## Run

1. Install it on a Quest 3 or 3S in developer mode: `adb install -r app-debug.apk`. It needs Horizon OS v74 or later.
2. Start it from the app library and allow the headset camera.
3. In the panel, enter the Scan server's address (`https://<host>:<port>`) and save it.
4. Start a capture. Walk the room. Stop it.
5. The session then appears on the server like a phone's, and the existing jobs build the scan and the splat.

With sign-in on, press **Sign in with Companion Account** on the panel first; the uploads then
carry the session token.

## Test

There is no headset checklist yet. The first run should record:

- the camera's timestamp source and active array size;
- whether the uploaded poses line up in the editor;
- what the splat viewer shows.

The Quest Browser checks for the web path stay in [web-webxr.md](web-webxr.md#test).

## Known gaps

- The display-time pose stamp is a heuristic. Frame times are start of exposure, with no rolling-shutter correction.
- Frames upload as pinhole. Distortion is saved only in the local recording.
- The vision hook's only output is a text summary on the panel: nothing maps it onto
  `WorldDetection` or uploads it (wave 13 ticket 0009, the rest).
- mq3drecon was not run here. Its reader takes the image size from the camera's active array, so the recording fits only if that is 1280×960.
- Licences:
  - The Meta Spatial SDK is under the Meta Platform Technologies SDK License Agreement, which must be reviewed before the app is distributed.
  - ONNX Runtime is MIT.
  - The release workflow and the third-party notices do not cover `meta/` yet.
