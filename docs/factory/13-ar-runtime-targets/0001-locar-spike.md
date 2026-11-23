> **Type:** Frontend spike
> **Wave:** 13-ar-runtime-targets
> **Branch:** `feat/locar-spike`
> **Commit style:** `feat(ar): ...`
> **Design:** This ticket is the spec. See also [ADR 0012](../../adr/0012-locar-js-is-a-geo-viewer-not-a-scanning-provider.md).
> **Dependencies:** Commit `4125bb1` (`build/ar-runtime-variant`, which adds `VITE_AR_RUNTIME=8thwall`). This branch is cut from it, so it lands first or with this branch.

## Goal

Show that locar.js 0.2.12 runs on the bundle's own three.js, with the camera feed, a GPS fix and a compass heading, and that it places in metres relative to the first fix. Record what it cannot do.

## Non-goals

- Do not register locar in `src/main.ts` or in the `ARProvider` switch.
- Do not place server data. That is [0005](0005-locar-viewer.md).
- Do not change the default build or the 8th Wall path.

## Pinned conventions

- Dependency: `locar` `^0.2.12` (MIT, from its licence file), with an npm `overrides` entry `"locar": { "three": "$three" }`. The lockfile has no nested `three`, and the change to it is the locar entries alone.
- Placement: the shared rule in `src/ar/locar-placement.ts` (`scenePlacement`), installed as the instance's `lonLatToWorldCoords`. `?projection=mercator` leaves locar's own Web Mercator in place, as the control.
- `window.__locarSpike` is a test hook, not product API.
- ADR 0001: no schema, no env var and no connection is added.

## Before implementation

- `src/ar/provider.ts`, `src/viewer/map-plane-math.ts` (`latLngToScene`, `sceneToLatLng`) and `src/world/enu.ts`.
- locar: `node_modules/locar/dist/locar.d.ts`, and its upstream source for the npm 0.2.12 release, `lib/three/locar.ts` (`startGps` at lines 87 to 116, `watchPosition` at 97; `lonLatToWorldCoords` and `add`).

## Open questions & answers

- Does `App.start()` start GPS? No. Only `LocAR.startGps()` does, so the page calls it after its handlers are registered.
- Does `App.start()` mean the camera runs? No. It resolves on the orientation grant. The page reports the camera from the webcam's `webcamstarted` event, registered right after `new App(...)`.
- Why can't the page's controls be tapped by default? locar sets its canvas to z-index 999. The pages put their own controls above it.
- Does Web Mercator distort metres? Yes. With a fix in Paris, a marker 20 m north sits at z = −20 under the shared rule, and at about −30.4 under locar's own projection.
- Does `three` resolve to one copy? Yes. The lockfile has no nested copy, and Chromium shows no "Multiple instances of Three.js" warning.

## Files impacted

- `package.json`, `package-lock.json`, `deno.lock` (the locar entries; `deno install --frozen` passes)
- `vite.config.ts` (rollup inputs `locar` and `locarViewer`)
- `locar.html`, `src/ar/locar-spike.ts`, `src/ar/locar-placement.ts` (shared with 0005)
- `tests/mock-locar-spike.spec.ts`, `tests/unit/node/locar_placement.test.ts`
- `THIRD_PARTY.md`, `scripts/native/third-party-notices.mjs` (locar declared MIT)

## Schema required

N/A. No schema, config variable or connection.

## Definition of Done

- [x] Placement unit tests pass (11 of 11), against distances worked out separately from the code.
- [x] Chromium spike tests pass (2 of 2): the camera reports through `webcamstarted`; the marker is 20 m north of a Paris fix at z = −20; the Mercator control puts it at about −30.4; an absolute event for a phone held upright and facing west reads 270, and a relative event does not move it.
- [x] `tsc --noEmit`, `npm run typecheck:tests` and the web build pass.
- [ ] Device checks on a phone: camera feed visible, fix, heading against a compass.

## Tests

- `npm run test:locar`
- `VITE_URL=<preview server> npx playwright test tests/mock-locar-spike.spec.ts --project=chromium-mock`

## Acceptance Criteria

- [x] The camera feed is visible behind the scene: the page's black is on `html`, not on `body`, so it no longer covers locar's video.
- [x] Placement is relative to the first fix, in metres, anywhere on the globe.
- [x] The heading is a compass reading, and relative events are ignored.

## Risks / potential issues

- One headless run logged a WebGL "context lost" warning during teardown. It was not a page error.
- Chromium only. No phone has run the spike.

## Subtasks

- [x] Spike page and placement rule
- [x] Independent unit tests
- [x] Chromium tests, with the Mercator control
- [x] Review fixes (camera visibility, fix-relative placement, compass heading, camera signal, iPadOS permission)
