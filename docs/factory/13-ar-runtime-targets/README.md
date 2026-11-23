# 13-ar-runtime-targets

The four build targets the owner asked for on 2026-11-23, how each one is built, and what is decided. Drafted and decided the same day.

## Build tree

| Target | Runtime | How it is built | Ticket |
| --- | --- | --- | --- |
| Web, on locar.js | locar.js 0.2.12 (MIT) on the bundle's own three.js | `npm run build`. It emits `locar-viewer.html` (Places around you) and `locar.html` (the spike) | [0005](0005-locar-viewer.md), [0001](0001-locar-spike.md) |
| Android, web wrapper on locar.js | The viewer page inside the Capacitor shell | The shell's web build (`scripts/native/build-web.mjs mobile`), then the viewer copied over `index.html`, `cap sync android` and `assembleRelease` | [0004](0004-wrapper-engine-and-start-page.md) |
| Android, ARCore APK | The native ARCore plugin (`ScanARPlugin.java`) in the shell | The shell's default web build, `cap sync android` and `assembleRelease` | none: the shell already does this (ADR 0009) |
| iOS, ARKit-CoreLocation on SceneKit | `GeoViewController.swift`, opened by `ScanAR.openGeoView` | The Mobile Build workflow's iOS Simulator job, on GitHub's macOS runner. The build host has no Xcode | [0006](0006-ios-geo-view.md) |

The target list named RealityKit for iOS. On 2026-11-23 the owner chose SceneKit instead ([0003](0003-ios-renderer.md)). ARKit-CoreLocation renders with SceneKit, and the repo has no RealityKit code.

None of the four targets has run on a device.

## What the parallel build tree supplies

A parallel build the same day, on commit `4125bb1`, produced the 8th Wall and WebXR web builds and two debug APKs. That commit is `build/ar-runtime-variant`, which adds `VITE_AR_RUNTIME=8thwall`, and this wave's branch is cut from it. That build's ARCore debug APK was checked by entry name and by signer: `application-debuggable` is set, it is signed with the Android debug certificate, and it bundles the 8th Wall engine files. Its iOS Simulator job ran on `main` at `1e8f34f` (Mobile Build run 45232956898, success).

## What locar.js can and cannot supply to `ARProvider`

Each member of `src/ar/provider.ts` was checked against locar 0.2.12, from its npm build and its upstream source. "Partial" means locar supplies raw material and an adapter would do the work. "No" means the contract's documented stub, or omission for an optional member.

| Member | Required | locar | Why |
| --- | --- | --- | --- |
| `start(canvas)` | yes | partial | The canvas is a constructor option. `start()` resolves on the orientation grant, and only `LocAR.startGps()` starts GPS |
| `stop()` | yes | partial | `App` has no teardown. It would be composed from `stopGps`, `Webcam.dispose`, `DeviceOrientationControls.dispose` and `setAnimationLoop(null)` |
| `captureFrame()` | yes | partial | Only the raw video element. Nothing captures a frame, timestamps it or stamps it with a pose |
| `hitTest()` | yes | no | Returns `null`, the contract's no-hit answer. locar's ray cast hits its own objects, not the room |
| `hitTestAsync`, `hitTestBurstAsync` | no | no | Omitted |
| `featurePoints()` | yes | no | Returns `[]` |
| `getPose()` | yes | partial | A 3-DoF orientation, plus x and z from GPS. GPS never sets y |
| `isTracking()` | yes | partial | Only a proxy: a first accepted fix and a first orientation event |
| `trackingStatus()` | yes | no | The constant `'UNKNOWN'`, which `trackingIsUsable` and `trackingIsStableForPlacement` accept (`src/ar/tracking-quality.ts`) |
| `getCameraFovY()` | yes | partial | Derived from an assumed horizontal FOV, not from the device. locar defaults to 80 deg, and the spike and viewer set 60 |
| `getCameraAspect()` | yes | yes | `camera.aspect` |
| `scaleKind`, `scaleReady`, `scaleMode` | no | no | locar's default units are Web Mercator, not metric |
| `anchors` | no | no | No anchor API |
| `onPreflightVerdict`, `getTrackingDiagnostics`, `getFrameEpoch`, `onFrameDiscontinuity` | no | no | locar has none of these signals |
| `getScene()` | no | partial | A live `THREE.Scene`, in a GPS frame rather than a SLAM frame |

So locar cannot scan a room, and ADR 0012 makes it a viewer.

## How the locar pages place, orient and check

- **Placement.** One rule, `scenePlacement` in `src/ar/locar-placement.ts`, is installed on the instance as `lonLatToWorldCoords`, the seam locar places both the camera and every object through. The origin is locar's first accepted fix. Positions are exact WGS-84 ENU through `latLngToScene` (`src/viewer/map-plane-math.ts`), with east at +x and north at −z, which are locar's own axes. `src/world/geo.ts`'s `geoToEnu` uses z north and would mirror the map, so it is not used here. locar's default, Web Mercator, scales distance by about 1/cos(latitude).
- **Declination.** locar turns the camera with the compass, so the scene's −z is magnetic north. The viewer turns positions, of the camera and of every Place alike, into that frame by the WMM2025 declination (`src/world/declination.ts`: true = magnetic + D, east positive). Nothing drifts as the user walks. Where the model refuses (NOAA's blackout zone, a date outside 2025.0 to 2030.0, or an unusable origin), nothing is turned and the page says so. The spike turns nothing.
- **Heading.** Read with the scanner's own `compassReadingFromEvent` (`src/geo/compass-heading.ts`): iOS's `webkitCompassHeading`, or an absolute orientation event. A relative event counts from wherever the phone faced at page load, so it is ignored.
- **Camera.** The page reports the camera from the webcam's own `webcamstarted` event. `App.start()` resolves on the orientation grant and says nothing about the camera.
- **Stacking.** locar puts its canvas at z-index 999. The pages put their status, list and Legal notices button above it, or the canvas takes every tap.
- **Pins.** The viewer reads `GET /project-locations`, the map's own pins route, and uses each Place's id, name and pin. It sends nothing anywhere. When sign-in is off and `SCAN_REQUIRE_AUTH` is unset, that route answers any caller, as it already does for the map.

## Decisions

| # | Question | Decision |
| --- | --- | --- |
| [0002](0002-locar-role.md) | The role of locar.js | A, a view-only geo runtime (ADR 0012). Owner, 2026-11-23 |
| [0003](0003-ios-renderer.md) | The iOS renderer | SceneKit with ARKit-CoreLocation. Owner, 2026-11-23: "use SceneKit for iOS". It is built as a separate geo view rather than a swap of the scanner's view, for the reasons in [0006](0006-ios-geo-view.md) |
| [0004](0004-wrapper-engine-and-start-page.md) | The wrapper's engine policy and start page | Open |

## Mobile facts

- **Android permissions.** INTERNET, CAMERA, ACCESS_FINE_LOCATION and ACCESS_COARSE_LOCATION. The ARCore camera feature is `required="false"`, so the app runs without ARCore, on the web runtimes.
- **Signing.** The release workflow chooses `auto`, `keystore`, `throwaway` or `skip` (`mobile/README.md`). Gradle takes all four `ANDROID_SIGNING_*` values or none. Android updates an app only from the same key, so a build signed with another key needs the old one uninstalled first, and that deletes the app's data.
- **Engine files.** `scripts/native/build-web.mjs` requires the 8th Wall files in the mobile bundle, and `check-xr-engine.mjs` checks their bytes. So any wrapper built today ships `xr.js` and the rest.
- **Build residue.** `cap sync android` copies the web bundle, engine included, into `mobile/android/app/src/main/assets/public`. That folder is git-ignored, but `test:quarantine` walks the working tree and fails while the copy is there. Delete it after an APK build, as the build-tree script does.
- **Licence conflict.** `docs/audits/2026-11-11-publish-readiness.md:23` says the bundled `public/xr.js` carries a PolyForm Noncommercial restriction. `mobile/README.md:19` names the XR Engine License Agreement for the same file. The repo does not settle which is right.
- **Notices.** The web bundle has no notices file. Only the native shells generate one. locar's package.json declares no licence, so `scripts/native/third-party-notices.mjs` names it MIT from its licence file (`DECLARED_LICENCES`). No notices are generated for the iOS app's Swift packages yet ([0006](0006-ios-geo-view.md)).

## Not in this wave

- Store builds. The engine licence is unresolved, and the app id `com.companionintelligence.scan` is provisional: "An Android id is permanent once uploaded" (`mobile/README.md`).
- Using locar for scanning, keyframes or alignment. ADR 0005 needs geometry and measurement, and GPS offers neither.
- Changes to the job system or the stored Place format. The only server change is a clock option on `runKeyframePurge`, for its test.

## Verification at commit

- `npm run verify`: each of its 98 steps was run on its own, so one failure cannot hide another, and 98 of 98 pass. That includes `deno task test`, whose retention test now pins its clock (`runKeyframePurge` takes an optional `now`), `test:quarantine`, and the new `test:locar`.
- Chromium, against a preview of the built site: the two spike tests and the viewer test pass with retries off.
- `deno install --frozen` passes, so `deno.lock` matches the manifests.
- Not run on any device. The iOS Swift is compiled only by the Mobile Build workflow.

## Atlas

Until this wave's atlas pass, the atlas did not describe locar.js. The pass added a planned card for the locar.js viewer in AR Capture and this wave's card, which fills the gap for the viewer. The native shells, the iOS geo view and the mobile build's engine rule still have no base entry. That is left for the wave that changes them.

## Tickets

| # | Title | Type | Depends on | State |
| --- | --- | --- | --- | --- |
| [0001](0001-locar-spike.md) | locar.js spike with the shared placement rule | Frontend spike | `4125bb1` | Built |
| [0002](0002-locar-role.md) | The role locar plays | Decision | 0001 | Decided: A |
| [0003](0003-ios-renderer.md) | The iOS renderer | Decision | none | Decided: SceneKit |
| [0004](0004-wrapper-engine-and-start-page.md) | Wrapper engine policy and start page | Decision and infra | 0002, 0005 | Open |
| [0005](0005-locar-viewer.md) | Places around you: the locar.js viewer | Frontend | 0001, 0002 | Built |
| [0006](0006-ios-geo-view.md) | iOS geo view: ARKit-CoreLocation on SceneKit | iOS | 0003 | Built for CI |
