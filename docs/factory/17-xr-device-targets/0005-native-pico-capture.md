> **Type:** Native / PICO
> **Wave:** 17-xr-device-targets
> **Branch:** `feat/pico-capture-app`
> **Commit style:** `feat(pico): summary`
> **Design:** to be settled from 0004's results, and recorded in an ADR before any code
> **Dependencies:** 0004, and the owner's go-ahead

## Goal

Capture on PICO headsets with the passthrough RGB camera, in a native app beside the Android shell,
as the Quest app is beside it (ADR 0013). The app pairs camera frames with the head pose and sends
keyframes to the person's own Scan server, where the existing reconstruction and splat jobs run.

## Non-goals

- Do not add a second upload path. Keyframes go through `POST /sessions`,
  `POST /sessions/:id/keyframes` and `POST /sessions/:id/finalize`, as every target's do.
- Do not put PICO's SDKs into the Android shell.
  - The PICO Spatial SDK needs `minSdk` and `compileSdk` 35, Kotlin 2.0 or later, AGP 8.8 or later,
    and PICO's own builds of Jetpack Compose modules (Spatial SDK 6.2.x, "Port Android apps").
  - The shell is a Java Capacitor app with `minSdk` 24 and a locked release classpath.
- Do not declare manifest entries that no PICO page or PICO sample names.

## Pinned conventions

- **ADR 0001:** the app is a new client of the existing session routes, as the Quest app is.
  - `meta` keeps the web scanner's shape.
  - The pose is camera-to-world in OpenGL/Blender axes, which is what the splat dataset builder
    reads (`poseToMatrix`).
- **ADR 0013 is the precedent:** a native app that feeds the same server.
- **Camera access, as PICO's material says on 2026-11-24.** Read it again when work starts.
  - PICO's Unity OpenXR SDK 1.4.0, "Passthrough": "The PICO system directly processes the
    passthrough images, so the app is unable to access any images or videos of users'
    surroundings." That page covers showing passthrough (Neo3, PICO 4 and PICO 4 Ultra, system
    5.7.0 or later), not reading it.
  - PICO's Camera Pack sample (`github.com/Pico-Developer/PICO-Unity-SDK-Samples-CameraPack`, MIT,
    last pushed 2026-11-14) gives "passthrough RGB camera access" to a Unity app:
    - it uses PICO's Unity SDK (`com.bytedance.pico.xr`, the Project Swan SDK), namespace
      `ByteDance.PICO.CameraPack`, component `PXR_CamTextureManager`. Its `Packages/manifest.json`
      takes PICO Unity SDK 6.2.0 from the public GitHub repository `Pico-Developer/PICO-Unity-SDK`
      (`?path=/XR#6.2.0`); its README and Chinese guide describe a local copy instead. GitHub
      reports no standard licence for that repository;
    - it is built with Unity 6000.3.13f1, URP 17.3.0, Vulkan (not OpenGL), IL2CPP and ARM64
      (`docs/pico-camera-pack-sample.md`);
    - its manifest asks for `android.permission.CAMERA`;
    - `PXR_CamTextureManager` does not start until the headset camera permission is granted;
    - the RGB camera works on both target headsets, codenamed `sparrow` and `swan`, and
      environment depth only on `swan`. No page read identifies `sparrow`;
    - the camera is not available in the Unity editor or a simulator.
  - `swan` is Project Swan, the name PICO's FAQ address still carries for PICO Space Pro. The
    sample does not say which headset `sparrow` is.
  - The PICO Spatial SDK's camera route is SpatialML (SecureMR), a protected runtime where reading
    data out is an explicit export. Whether that export can carry whole frames is not stated.
- **So the one documented route to frames is a Unity app** on PICO's Unity SDK with Camera Pack.
  That differs from the Quest app, which is Kotlin on Meta's Spatial SDK, so its code cannot be
  shared directly. Port its pose conventions with their tests, against the same `poseToMatrix`
  fixture (`meta/app/src/test/resources`, `tests/unit/server/native_quest_pose_fixture.test.ts`).

## Before implementation

- 0004's record, all of it.
- `docs/adr/0013-the-quest-app-is-a-native-spatial-sdk-app-that-feeds-the-same-server.md` and
  `docs/targets/meta-quest.md`.
- `meta/app/src/main/java/com/companionintelligence/scan/quest/pose/` and `capture/`, with their tests.
- The Camera Pack sample's `HandJointsOverlay` scripts (`CameraFrameGate`, `CameraFrameTiming`,
  `CameraFramePoseUtility`), which pair camera frames with tracking data on a timestamp.

## Open questions & answers

- Q: A Unity app with Camera Pack, or a Spatial SDK app if SpatialML can export frames? — OPEN
  (the ADR, after 0004)
- Q: Which headset is `sparrow`, and does Camera Pack run on the owner's headset and PICO OS
  version? — OPEN (0004)
- Q: Does `PXR_CamTextureManager` give each frame's timestamp, intrinsics and lens pose, so a frame
  can be paired with the head pose as the Quest app does? — OPEN (PICO's SDK reference)
- Q: Under which licences do PICO's Unity SDK and the Camera Pack's upstream (QuestCameraKit) let
  the app be distributed? GitHub reports no standard licence for `Pico-Developer/PICO-Unity-SDK`.
  — OPEN (to be reviewed before any distribution, as for the Meta Spatial SDK)

## Files impacted

To be settled with the design. Likely:

- a new app folder beside `meta/`;
- a CI workflow like `.github/workflows/quest-build.yml`;
- an ADR;
- `docs/targets/pico.md`.

## Schema required

None expected. Keyframes keep today's `meta` shape.

## Definition of Done

- [ ] An ADR records the design, chosen from 0004's results.
- [ ] On a PICO headset, a capture's keyframes reach the server, and their poses line up in the editor.

## Tests

- [ ] The pose conversion, against the server's `poseToMatrix` fixture, as the Quest app's is.
- [ ] The upload client, against an HTTPS mock server.

## Acceptance Criteria

- [ ] Given a PICO headset on which Camera Pack runs: when a capture runs, the session's keyframes
  reach the server, each with a pose and intrinsics, and the existing jobs build a scan from them.

## Risks / potential issues

- **Risk:** the owner's headset or PICO OS version has no Camera Pack. — **Mitigation:** decide
  from 0004. The browser and WebView paths remain, without frames.
- **Risk:** a Unity app is a second toolchain in the repository, beside Gradle and Capacitor. —
  **Mitigation:** the ADR weighs it against the Spatial SDK route. Nothing in Unity runs here
  without a Unity 6 editor, and Camera Pack runs only on a headset.
- **Risk:** the PICO APIs are new (the sample was last pushed 2026-11-14) and may change. —
  **Mitigation:** pin the SDK version the ADR chooses, and re-read the sample and the SDK reference
  when work starts.

## Subtasks

1. [ ] Read 0004's record and PICO's SDK reference for Camera Pack, and write the ADR.
2. [ ] Build the app and its unit tests, with a CI job like Quest Build.
3. [ ] Run it on a PICO headset, with the owner's yes for each install.
