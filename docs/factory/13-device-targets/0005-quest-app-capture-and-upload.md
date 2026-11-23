> **Type:** Native app
> **Wave:** 13-device-targets
> **Branch:** `feat/quest-app-capture`
> **Commit style:** `feat(quest): summary`
> **Design:** ADR 0013
> **Dependencies:** None

## Goal

A native Quest app captures passthrough camera frames with head poses, and uploads them as keyframes to the person's Scan server, so the existing reconstruction and `splat-train` jobs run on a Quest capture. Until this wave a Quest could scan only through Quest Browser, which cannot read passthrough pixels.

## Non-goals

- Do not add server routes, job types or keyframe fields.
- Do not bundle or download model weights (ticket 0009).
- Do not implement sign-in (ticket 0010).
- Do not package the browser page (the Bubblewrap route is dropped, ADR 0013).

## Pinned conventions

- ADR 0001 and ADR 0003. The app is a new client of the existing routes:
  - `POST /sessions` (`server/main.ts:1058`).
  - `POST /sessions/:id/keyframes`, multipart `image` and `meta` (`server/main.ts:1088`).
  - `POST /sessions/:id/finalize` (`server/main.ts:1295`).
- `meta` follows the web scanner's shape (`src/capture/keyframes.ts`, around lines 426-445): `index`, `timestamp`, `capturedAt`, `pose`, `epoch`, `intrinsics`.
- `pose` is the existing `Pose` type (`src/ar/provider.ts:9`): `{ position: {x,y,z}, rotation: {x,y,z,w} }`. It is camera-to-world in OpenGL/Blender axes, which the splat dataset builder takes with no flip (`server/splat/splat_train_dataset.ts`, `poseToMatrix`, around line 435).
- The project is `meta/`. It uses applicationId `com.companionintelligence.scan.quest`, the Meta Spatial SDK 0.15.0 (Maven Central), AGP 8.13.0, Kotlin 2.1.20, JDK 21, and compileSdk 36 with minSdk and targetSdk 34.
- Camera: Camera2, the left passthrough camera, chosen by `com.meta.extra_metadata.camera_source` = 0 and `com.meta.extra_metadata.position` = 0. Size 1280x960, format YUV_420_888.
- Permissions: `horizonos.permission.HEADSET_CAMERA` and `android.permission.CAMERA`, both declared, plus the feature `android.hardware.camera2.any`.
- Head pose: `Scene.getViewerPose()`, paired with each frame by timestamp, then composed with the lens pose from Camera2.
- Every coordinate conversion lives in one Kotlin file, with tests.
- Server address: entered by the person, HTTPS only. No address, host name or key appears in code.

## Before implementation

- Read the three route handlers in `server/main.ts`, including `UPLOAD_MAX_FRAME_BYTES`, `KEYFRAME_SESSION_MAX_BYTES` and `MAX_KEYFRAMES_PER_SESSION`.
- Read the intrinsics reader just above `poseToMatrix` in `server/splat/splat_train_dataset.ts`. Checked on 2026-11-23, it reads `width` and `height` (lines 408–409), `fx` and `fy` (lines 415–416), `fovYDeg` when no focal length is given (line 419, default 55), and `cx` and `cy` (lines 428–429). It does not read `aspect`.
- Read the Spatial SDK stub sources for `Scene` (`getViewerPose`, `enablePassthrough`) and `VrActivity` (`registerFeatures`).
- Read mq3drecon's legacy layout readers (MIT), for the optional local recording.

## Open questions & answers

- Q: Is `android.permission.CAMERA` needed besides `HEADSET_CAMERA`? — OPEN. Meta's pages disagree, so both are declared.
- Q: Minimum Horizon OS? — OPEN: v74 on most pages, v76 on two.
- Q: Do camera timestamps share a clock with `getViewerPose()` samples? — OPEN. Record `SENSOR_INFO_TIMESTAMP_SOURCE` and convert when it is not REALTIME.
- Q: What is the reference frame of `LENS_POSE_*` on Quest? — OPEN. Meta says the camera configuration gives the lens pose relative to the headset centre.
- Q: What is mq3drecon's timestamp unit? — OPEN. Milliseconds is likely. Do not call the recording compatible without a test.

## Files impacted

- New: `meta/**` (project, activity, capture, pose conversion, uploader, recording writer, unit tests).
- Changed: none outside `meta/`.

## Schema required

None. Keyframe `meta` uses only fields the web scanner already sends.

## Definition of Done

- [ ] `./gradlew testDebugUnitTest assembleDebug` passes in `meta/`.
- [ ] The merged manifest has the two permissions, the camera feature, the VR launcher category and INTERNET.
- [ ] Unit tests cover the pose conversions, the timestamp pairing, the `meta` JSON shape and the recording layout.

## Tests

- [ ] JVM tests for conversion round trips and known rotations.
- [ ] A JVM test posts to a mock server and checks the route order and the multipart fields.

```bash
cd meta && ./gradlew testDebugUnitTest assembleDebug --no-daemon
```

## Acceptance Criteria

- [ ] Given a headset run, when a capture finalizes, then the session's `keyframes.jsonl` lines parse in `splat_train_dataset.ts`, and `splat-train` starts.
- [ ] Given an http address, the app refuses it.

## Risks / potential issues

- **Risk:** Pose pairing errors bend the reconstruction. — **Mitigation:** Record raw timestamps from both clocks; the first headset run checks them.
- **Risk:** The Spatial SDK terms may limit distribution. — **Mitigation:** Review before any distribution (ADR 0013).
- **Risk:** Nothing camera- or pose-related is verified off a headset, and the XR Simulator does not offer the camera API. — **Mitigation:** Say so in every status line.

## Subtasks

1. [ ] Capture: permission, camera selection, ImageReader.
2. [ ] Pose: ring buffer, pairing, the conversion file and tests.
3. [ ] Upload: sessions, keyframes, finalize, retries.
4. [ ] Optional local recording, with the layout test.
5. [ ] UI: server address, start and stop, status.
