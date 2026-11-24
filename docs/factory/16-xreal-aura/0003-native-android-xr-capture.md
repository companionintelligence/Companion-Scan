> **Type:** Native / Android
> **Wave:** 16-xreal-aura
> **Branch:** `feat/android-xr-runtime`
> **Commit style:** `feat(android-xr): summary`
> **Design:** to be settled from 0002's results, and recorded in an ADR before any code
> **Dependencies:** 0002, and the owner's go-ahead

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
- **Google's documented pieces, as read on 2026-11-24.** Check them again when the work starts:
  they are previews.
  - ARCore for Jetpack XR's device pose needs the runtime permission
    `android.permission.HEAD_TRACKING` on immersive devices. Whether wired XR glasses count as
    immersive is not stated.
  - Plane tracking and hit tests need `android.permission.SCENE_UNDERSTANDING_COARSE`.
  - Google's setup page lists `androidx.xr.runtime:runtime` and `androidx.xr.arcore:arcore` at
    `1.1.0-alpha` versions. Its release table shows a stable `1.0.0` for both.
  - XREAL's getting-started page names `androidx.xr:xr-compose:1.0.0` with `minSdk 35`. That
    coordinate matches none on Google's pages.

## Before implementation

- 0002's record, all of it.
- `mobile/android/app/src/main/java/com/companionintelligence/scan/ScanARPlugin.java`,
  `src/ar/native.ts`, `src/ar/native-bridge.ts`, `src/ar/runtime-select.ts`.
- `meta/app/src/main/java/com/companionintelligence/scan/quest/pose/` and `capture/`, with their tests.
- `mobile/android/app/gradle.lockfile`, `tests/unit/node/android_lockfile.test.ts`, and `ANDROID_LICENCES` in
  `scripts/native/third-party-notices.mjs`: every new library needs a lock line and a licence entry.

## Open questions & answers

- Q: Can an app open the glasses' camera, and which permission does it need? — OPEN (0002, check 4)
- Q: Which Android version and API level does the puck run? Can the shell's `minSdk 24` and
  `compileSdk 36` stay? — OPEN (0002, check 1)
- Q: Do the Jetpack XR libraries go into every Android build, or only into the Aura build behind
  a switch? The phone builds would carry preview libraries they never use, and the release lock
  would grow. — OPEN
- Q: Home Space or Full Space? A capture needs the pose of the glasses, not of a panel. — OPEN
- Q: The pose is the glasses', and the camera sits apart from it. Where does the offset between
  them come from? — OPEN

## Files impacted

To be settled with the design. Likely:

- `mobile/android/app/build.gradle`, `mobile/android/variables.gradle` and `mobile/android/app/gradle.lockfile`;
- the ScanAR plugin, or a new Android XR backend beside it;
- `scripts/native/third-party-notices.mjs`;
- `src/ar/native-bridge.ts` (an `engine` value for Android XR), `src/ar/runtime-select.ts`, and the target page.

## Schema required

None expected. Keyframes keep today's `meta` shape.

## Definition of Done

- [ ] An ADR records the design, chosen from 0002's results.
- [ ] On an Aura, a capture's keyframes reach the server, and their poses line up in the editor.

## Tests

- [ ] JVM unit tests for the pose conversion, against the server's `poseToMatrix` fixture, as the Quest app's are.
- [ ] `npm run test:native-ar` for the provider choice with an Android XR answer.

```
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
  decide from 0002. A pose-only capture is not a scan, and the ticket may end at the ADR.
- **Risk:** the APIs are previews and change. — **Mitigation:** pin versions in the lockfile, and
  re-read Google's pages when work starts.

## Subtasks

1. [ ] Read 0002's record, and write the ADR.
2. [ ] Add the libraries behind the variant switch the ADR chooses, with their lock lines and notices.
3. [ ] Add the runtime, its unit tests, and the target page's update.
4. [ ] Run it on an Aura, with the owner's yes for each install.
