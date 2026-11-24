# 0014. locar.js is a geo viewer beside the AR runtimes, not a scanning provider

- **Status:** Accepted on 2026-11-23 by the owner (ticket 15-ar-runtime-targets/0002).
- **Date:** 2026-11-23
- **Related issue:** none

## Context

The scanner reaches AR through one contract, `ARProvider` (`src/ar/provider.ts`). The runtimes that implement it are 8th Wall (`public/xr.js`), WebXR, and, in the Scan shells, the phone's own ARKit or ARCore session (ADR 0009). A runtime that scans needs 6-DoF pose, feature points, hit tests and anchors. ADR 0005 requires a spatial frame to be established by geometry and verified by measurement.

On 2026-11-23 the owner asked for four build targets: the web on locar.js (AR-js-org, MIT), an Android wrapper of that build, an Android ARCore APK, and an iOS build with ARKit-CoreLocation.

locar.js 0.2.12 is a location-based layer on three.js. It supplies:

- a camera feed, from a `<video>` element that its `Webcam` creates;
- a GPS position, from `navigator.geolocation.watchPosition`, started by `LocAR.startGps()` and not by `App.start()`;
- a 3-DoF device orientation, from `DeviceOrientationControls`;
- objects placed at a longitude and latitude, through `lonLatToWorldCoords`, the seam that places the camera and every object alike.

It has no 6-DoF visual tracking, no feature points, no hit tests, no anchors and no depth. The member-by-member check against `ARProvider` is the table in `docs/factory/15-ar-runtime-targets/README.md`.

Two more facts decide how locar can be used:

- **Its default projection is Web Mercator** (EPSG:3857). Its scale is about 1/cos(latitude): with a fix in Paris, Chromium draws a point 20 m north at about 30.4 m.
- **Its `three` dependency is `^0.181.0`, and this repo pins `^0.184.0`.** An npm `overrides` entry (`"locar": { "three": "$three" }`) makes locar use the root copy. The lockfile has no nested `three`, and Chromium raises no "Multiple instances of Three.js" warning.

## Decision

1. locar.js is a **view-only geo runtime**. It draws Places at their GPS positions over the camera feed (`docs/factory/15-ar-runtime-targets/0005-locar-viewer.md`). It is not registered as an `ARProvider`, so no capture path, keyframe or frame can come from it.
2. **One placement rule** places the camera and every object. It is installed as the instance's `lonLatToWorldCoords`, and it gives exact WGS-84 ENU about locar's first accepted fix, through `latLngToScene` (`src/viewer/map-plane-math.ts`, built on `src/world/enu.ts`). Those are locar's own axes, east at +x and north at −z, so the repo keeps one geo convention (ADR 0001). locar's Web Mercator default is not used.
3. **Declination.** locar turns the camera with the compass, so the scene's −z is magnetic north. Positions, of the camera and of every Place alike, are turned into that frame by the WMM2025 declination (`src/world/declination.ts`). Where the model refuses, nothing is turned, and the page says so.
4. **iOS.** In the iOS shell, the viewer hands its pins to a native geo view built on ARKit-CoreLocation with SceneKit (`docs/factory/15-ar-runtime-targets/0006-ios-geo-view.md`, decision 0003). In browsers and in the Android shell, it runs on locar.
5. The scanner keeps the AR runtimes it has: 8th Wall, WebXR and native. Scanning still needs SLAM.

## Consequences

- A locar view ships without any change to capture, the frame model or the `ARProvider` contract.
- GPS places content to metres, not to the centimetres that ADR 0005's frame verification needs. A locar view can find a Place, but it cannot align a scan to one.
- The repo gains a dependency, `locar`, and a `three` override. locar is MIT by its licence file, though its package.json declares no licence. The native shells' notices name it MIT through `DECLARED_LICENCES` in `scripts/native/third-party-notices.mjs`, and `THIRD_PARTY.md` lists it. The web build carries no notices file, for locar as for every other package.
- The scene axes are not one convention in the repo yet. `src/world/enu.ts:36-39` says the choice between z north and z south has not been made. On 2026-11-16 the owner accepted the alignment investigation's recommended defaults, among them a right-handed scene with x east, y up and z south. The viewer uses z south, which is locar's own. It stores nothing in a scene frame, so the choice moves no saved data.
- The wrapper's engine policy and start page are a separate open decision (`docs/factory/15-ar-runtime-targets/0004-wrapper-engine-and-start-page.md`), because `scripts/native/build-web.mjs` requires the XR Engine in the mobile bundle.
- Revisit this decision when a device run shows whether GPS-only overlays help people find Places, or when the owner chooses a different role for locar.js.
