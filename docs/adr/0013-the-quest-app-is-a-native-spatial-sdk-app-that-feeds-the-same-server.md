# 0013. The Quest app is a native Spatial SDK app that feeds the same server

- **Status:** Accepted, on the owner's request of 2026-11-23. Build verification here; headset verification pending.
- **Date:** 2026-11-23
- **Related issue:** none (wave `docs/factory/13-device-targets/`)

## Context

Before this decision, a Meta Quest headset could scan only through the web scanner in Quest Browser (`webxr.html`, WebXR `immersive-ar`). The Capacitor shell cannot scan on Quest. Its WebView has no WebXR, and Quest has no ARCore, so the `ScanAR` plugin has no runtime there (ADR 0009, `docs/operations/AR_DEVICE_SUPPORT.md`).

Meta's mixed-reality page for Quest Browser says a page cannot read the passthrough pixels. A WebXR page, or a packaged copy of one, gets poses and hit results but no camera frames from the headset.

Meta documents three routes:

- **Bubblewrap.** Meta's fork, `@meta-quest/bubblewrap-cli`, wraps a hosted PWA as a Quest APK. That is the same browser page, so it adds no camera access.
- **The Passthrough Camera API.** It gives native apps the headset's camera frames through Android Camera2, behind the runtime permission `horizonos.permission.HEADSET_CAMERA`. It needs Horizon OS v74 or later, on Quest 3 and 3S. It gives frames only, not head pose.
- **The Meta Spatial SDK.** Version 0.15.0 is on Maven Central. It is a Kotlin SDK for Quest apps, on OpenXR. It exposes the viewer's pose (`Scene.getViewerPose()`), turns passthrough on (`Scene.enablePassthrough`), and has a Gaussian-splat renderer module, `meta-spatial-sdk-splat`.

Two open projects informed the capture format, as references only, with no code copied:

- OpenQuestCapture (MIT) records Camera2 frames plus head poses on Quest 3.
- mq3drecon (MIT) reconstructs such recordings offline and exports COLMAP.

## Decision

1. The Quest scanner is a native Android app in `meta/`, application id `com.companionintelligence.scan.quest`, built on the Meta Spatial SDK.
2. Frames come from the left passthrough camera through Camera2, at a size chosen explicitly (1280x960), not the largest offered.
3. Head pose comes from `Scene.getViewerPose()`. It is sampled every frame and paired with each camera frame by timestamp, then composed with the lens pose that Camera2 reports. Every coordinate conversion lives in one tested place.
4. The app uploads through the existing routes only: `POST /sessions`, `POST /sessions/:id/keyframes` and `POST /sessions/:id/finalize`. Keyframe `meta` carries the existing pose convention: camera-to-world, OpenGL/Blender axes, quaternion plus position (`server/splat/splat_train_dataset.ts`). The existing reconstruction and `splat-train` WorldJobs then run unchanged (ADR 0001, ADR 0003).
5. The app can also write a local recording in mq3drecon's legacy layout, for offline reconstruction. It is called compatible only as far as a test checks.
6. On-device vision is a hook: ONNX Runtime with no weights bundled, outputs kept on the device, and no new fields in the uploaded `meta`. Candidate models and their licences are listed in the wave plan, and nothing is downloaded without the owner's yes.
7. Splats are viewed with the Spatial SDK's splat module, from files the server already makes.
8. The Bubblewrap route is dropped.
9. The person enters the server address in the app, HTTPS only. No address, host name or key is built in.

## Consequences

- New dependencies: the Meta Spatial SDK (Meta's SDK terms, to be confirmed before any distribution), ONNX Runtime (MIT) and OkHttp (Apache-2.0). The release workflow and the third-party notices do not cover `meta/` yet.
- Only the build, the manifest and the JVM unit tests are verified on this machine. The camera, the pose pairing and rendering are unverified until a headset run.
- **Sign-in is open.** The server's shell sign-in returns to one fixed URL, `SHELL_RETURN_URL` in `server/portal_auth.ts`. A server with sign-in on refuses the Quest app's uploads until the server admits a return URL for it.
- The web route through Quest Browser stays supported. It is the route for editing a Place in VR (`xr-world.html`) and for scanning without installing anything.
