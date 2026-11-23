# Wave 13 — Device targets

The scanner is one web app and one server, delivered to six device targets. Until this wave the targets were implicit: each was a branch of one runtime switch, or a paragraph in `mobile/README.md`. This wave does four things:

- names each target and gives it a build, a doc page and a test path;
- adds the two native targets the owner asked for on 2026-11-23, the Quest app and the iOS RealityKit view;
- routes every target's captures into the existing splat pipeline;
- adds a hook for on-device vision models.

ADR 0012 (iOS RealityKit) and ADR 0013 (the native Quest app) record the two decisions. The tickets below are the work.

## The six targets

| Target | Device | AR runtime | Code | Build | Before this wave | This wave |
|---|---|---|---|---|---|---|
| Web, 8th Wall | iPhone and iPad Safari | 8th Wall SLAM (`public/xr.js`) | `index.html`, `src/ar/eighthwall.ts` | `npm run build` → `dist/` | Built and served; no 2026-11 build has run on a device | Doc page; build tree lane A (0001, 0002) |
| Web, WebXR | Android Chrome with ARCore; Quest Browser | WebXR `immersive-ar` | `webxr.html`, `src/ar/webxr.ts` | the same `dist/` | Requests `hit-test` (required), `dom-overlay`, `local-floor`, `anchors` | The Quest Browser modules (0003) |
| Android app, ARCore | ARCore phones | `ScanAR` (ARCore), then 8th Wall, then WebXR | `mobile/` | `build:web`, `cap sync`, Gradle | Debug APK builds; never run on a device | Build tree lane B (0002) |
| Android app, 8th Wall | Android phones | 8th Wall only | `mobile/` with `VITE_AR_RUNTIME=8thwall` | the same, with the variable | The variable arrived with this wave's base (`buildForcedRuntime`, `src/ar/runtime-select.ts`) | Docs; side-by-side install (0004) |
| Quest app | Quest 3 and 3S, Horizon OS v74+ | Meta Spatial SDK, Camera2 passthrough | `meta/` | Gradle in `meta/` | Did not exist | Capture and upload (0005); splat viewer (0006) |
| iOS app | iPhone | `ScanAR` (ARKit), drawn by RealityKit | `mobile/ios` | GitHub macOS runner (`mobile-build.yml`) | Drawn by SceneKit (`ARSCNView`) | RealityKit view (0007) |

The desktop app (`desktop/`, the editor and viewer, no capture) is not changed by this wave.

## The common server

All capture targets use one contract, which this wave does not change (ADR 0001):

1. `POST /sessions` returns a `sessionId`.
2. `POST /sessions/:id/keyframes` takes a multipart form: `image`, a JPEG, and `meta`, a JSON string. The web scanner sends `index`, `timestamp`, `capturedAt`, `pose`, `epoch` and `intrinsics` (`src/capture/keyframes.ts`).
   - `pose` is `{ position: {x,y,z}, rotation: {x,y,z,w} }`: camera-to-world, in OpenGL/Blender axes. The splat dataset builder takes it with no flip (`server/splat/splat_train_dataset.ts`, `poseToMatrix`).
   - `intrinsics` is `{ fovYDeg, aspect, width, height, sourceWidth, sourceHeight }`. The builder also reads `fx`, `fy`, `cx` and `cy`.
3. `POST /sessions/:id/finalize` closes the session.

The existing WorldJobs do the rest: LingBot-Map reconstruction, then `splat-train`, then splat detect and finish (ADR 0003). No target gets a second pipeline. Size limits are `UPLOAD_MAX_FRAME_BYTES`, `KEYFRAME_SESSION_MAX_BYTES` and `MAX_KEYFRAMES_PER_SESSION`, all in `server/main.ts`.

What changes for the server in this wave is only who calls it: the Quest app is a new client of the same routes. Sign-in for native apps is the one open server question. The shell sign-in returns to a single fixed URL (`SHELL_RETURN_URL`, `server/portal_auth.ts`), so a server with sign-in on refuses the Quest app until ticket 0010 lands.

## Three terms this wave pins

- **"Meta extensions"** (WebXR on Quest Browser). Meta's mixed-reality page for Quest Browser, read on 2026-11-23, names three supported modules:
  - AR, which is passthrough through `immersive-ar`;
  - Plane Detection, the `plane-detection` feature;
  - Anchors, with persistent handles through `requestPersistentHandle` and `restorePersistentAnchor`, capped at 8 persistent anchors per site.

  The same page says a page cannot read passthrough pixels, and it does not list `hit-test` among the supported modules. The scanner requires `hit-test`, so ticket 0003 checks that on the iwer Quest 3 emulator and on a headset. It also adds `plane-detection` as an optional feature.
- **"Splat support."** Every capture target's frames reach `splat-train` through the session routes, and the splat files the server makes open in each target's viewer. That is the web viewer for the web targets and the shells, and the Spatial SDK splat module for the Quest app (0006, 0008). On-device training is not in this wave. Splatelier (Apache-2.0) and splatify-anything (PolyForm Noncommercial) are recorded as references only.
- **"Meta APK."** This means the native Spatial SDK app (ADR 0013). The Bubblewrap route, which packages the browser page, is dropped.

## On-device vision

At the start of this wave, inference ran on the server. The web app can load ONNX weights from `public/models`, which no app bundles because their licence is unchecked (`scripts/native/build-web.mjs`, `NATIVE_EXCLUDED`).

The plan:

- ONNX Runtime on Android and Quest: the hook lands in `meta/` in this wave.
- Core ML on iOS: later.
- No new fields in uploaded keyframes. Outputs map onto `WorldDetection` before anything is uploaded (ADR 0001, ticket 0009).

Candidate models, with each licence as its repository states it (read 2026-11-23):

| Model | Task | Licence |
|---|---|---|
| Depth Anything V2 Small | monocular depth | Apache-2.0 (Base, Large and Giant are CC-BY-NC-4.0) |
| EfficientSAM (S, Ti) | segmentation | Apache-2.0 |
| MobileSAM | segmentation | Apache-2.0 |
| RT-DETR | detection | Apache-2.0 (the page does not address weights) |
| D-FINE | detection | Apache-2.0 (its Objects365 checkpoints are not cleared for commercial use) |

No weights are fetched or bundled without the owner's yes.

## The build tree

Three lanes, all pinned to one commit:

- **Lane A** runs the web build beside the Quest Gradle build. They share no outputs.
- **Lane B** builds the two Android APKs one after another, because both write `mobile/www` and the Android assets.
- **Lane C** builds iOS on the GitHub macOS runner, on a pushed ref.

Only one Gradle build runs at a time. Ticket 0002 moves the tree into the repo and gives the Quest app a CI job.

## Tickets

| # | Ticket | Target | Depends on |
|---|---|---|---|
| 0001 | [Docs by device target](0001-docs-by-device-target.md) | all | none |
| 0002 | [Build tree for the six targets](0002-build-tree-for-six-targets.md) | all | 0005, 0007 |
| 0003 | [Quest Browser WebXR modules](0003-quest-browser-webxr-modules.md) | Web, WebXR | none |
| 0004 | [The Android 8th Wall build installs beside the ARCore build](0004-android-8thwall-side-by-side.md) | Android apps | none |
| 0005 | [Quest app: passthrough capture and upload](0005-quest-app-capture-and-upload.md) | Quest app | none |
| 0006 | [Quest app: splat viewer](0006-quest-app-splat-viewer.md) | Quest app | 0005 |
| 0007 | [iOS: RealityKit view under the web view](0007-ios-realitykit-view.md) | iOS app | none |
| 0008 | [Splat viewing on every target](0008-splat-viewing-on-every-target.md) | all | 0006 |
| 0009 | [On-device vision models](0009-on-device-vision-models.md) | Quest, Android, iOS | 0005 |
| 0010 | [Sign-in for native apps](0010-native-app-sign-in.md) | server, Quest app | 0005 |

## Atlas

This wave's atlas pass adds the Quest app and the RealityKit view to "Delivery & Distribution" and "AR Capture", adds `VITE_AR_RUNTIME` to "Config variables", and adds a wave card. Until that pass, the atlas did not mention a native Quest target.

## Verification available on this machine

- The web build, both Android APKs and the Quest APK build here.
- JVM unit tests run for the Quest app; `npm run verify` runs for the rest.
- iOS compiles only on the macOS runner.
- No target in this wave has run on a device.

## Decisions for the owner

1. The sign-in route for the Quest app (0010).
2. Which on-device model to adopt, and whether its weights ship in an app (0009).
3. A review of the Meta Spatial SDK terms before any distribution of the Quest app (ADR 0013).
4. Whether the unregistered `ArSession` plugin stays (open since ADR 0009).
