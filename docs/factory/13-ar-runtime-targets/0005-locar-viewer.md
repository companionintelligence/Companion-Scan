> **Type:** Frontend
> **Wave:** 13-ar-runtime-targets
> **Branch:** `feat/locar-spike`
> **Commit style:** `feat(ar): ...`
> **Design:** [ADR 0012](../../adr/0012-locar-js-is-a-geo-viewer-not-a-scanning-provider.md). This ticket is the spec.
> **Dependencies:** [0001](0001-locar-spike.md), [0002](0002-locar-role.md)

## Goal

"Places around you": each saved Place with a pin, drawn over the camera at its GPS position, with a list nearest first, on locar.js in browsers and the Android shell. In the iOS shell, the pins go to the native geo view instead ([0006](0006-ios-geo-view.md)).

## Non-goals

- No capture, keyframe or alignment use. GPS places to metres.
- No new server route, and no Place writes.
- No store build. The wrapper's policy is [0004](0004-wrapper-engine-and-start-page.md).

## Pinned conventions

- ADR 0001. The viewer reuses:
  - `GET /project-locations`, the map's pins route (`server/main.ts`), read as `PlaceLocation` (id, name, lat, lng);
  - `latLngToScene` (`src/viewer/map-plane-math.ts`) for placement;
  - `declinationDeg` and `trueBearingDeg` (`src/world/declination.ts`);
  - `compassReadingFromEvent` (`src/geo/compass-heading.ts`) for the heading;
  - `openLegalNotices` (`src/ui/legal-notices.ts`);
  - `apiUrl` (`src/shared/api-base.ts`).
- It adds no env var and no connection.
- One placement rule for the camera and every Place: `scenePlacement` in `src/ar/locar-placement.ts`, installed as the instance's `lonLatToWorldCoords`. The origin is the first accepted fix.
- Declination: positions are turned into the compass frame, true = magnetic + D, east positive. Where the model refuses, nothing is turned and the status line says so.
- The page's controls sit above locar's canvas, which locar puts at z-index 999.

## Before implementation

- `src/ar/locar-placement.ts`, `server/main.ts` (`GET /project-locations`), and `src/geo/compass-heading.ts` (`compassReadingFromEvent`).

## Open questions & answers

- Why `/project-locations` and not `/projects`? It is the route the map already uses for pins, and it carries no notes, floors or areas. The viewer uses each entry's id, name and pin only, and sends nothing anywhere.
- Is it guarded? As much as the map is. Sign-in or `SCAN_REQUIRE_AUTH=1` guards it, and an open install answers any caller.
- What happens on iOS? In the iOS shell, when ScanAR has `openGeoView`, the page hands the pins to the native geo view. In Safari it runs on locar, reading iOS's `webkitCompassHeading`.

## Files impacted

- `locar-viewer.html`, `src/ar/locar-viewer.ts` and `src/ar/locar-placement.ts`
- `src/ar/native-bridge.ts`: the optional `openGeoView` and `closeGeoView` methods on the ScanAR interface
- `vite.config.ts` (input `locarViewer`)
- `tests/mock-locar-viewer.spec.ts`, `tests/unit/node/locar_placement.test.ts`

## Schema required

N/A. It reads an existing route's existing shape.

## Definition of Done

- [x] Placement unit tests pass (11 of 11), including the declination signs (New York west, Seattle east, London near zero) and that the camera and a Place keep their true separation under the turn.
- [x] The Chromium viewer test passes. It uses a fix in Seattle and four mocked pins, of which two are usable. They are drawn where the declination turn (13 to 17 degrees) puts them, and listed nearest first with true distance and bearing. Legal notices opens, and only `/project-locations` is read.
- [ ] A device check on a phone: pins in the right directions against a compass, and the list.

## Tests

- `npm run test:locar`
- `VITE_URL=<preview server> npx playwright test tests/mock-locar-viewer.spec.ts --project=chromium-mock`

## Acceptance Criteria

- [x] Unusable pins (missing, non-finite or off the globe) are left out.
- [x] Every position, camera included, goes through the one placement rule.
- [x] Legal notices can be tapped above locar's canvas.

## Risks / potential issues

- GPS accuracy and local magnetic fields limit what any GPS viewer can show. The list's distances are only as good as the fix.

## Subtasks

- [x] Placement module and tests
- [x] Viewer page and Chromium test
- [x] iOS hand-off to [0006](0006-ios-geo-view.md)
