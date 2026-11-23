> **Type:** Frontend
> **Wave:** 13-ar-runtime-targets
> **Branch:** `feat/locar-spike`
> **Commit style:** `feat(ar): ...`
> **Design:** [ADR 0012](../../adr/0012-locar-js-is-a-geo-viewer-not-a-scanning-provider.md). This ticket is the spec.
> **Dependencies:** [0001](0001-locar-spike.md), [0002](0002-locar-role.md)

## Goal

"Places around you": each saved Place with a pin, drawn over the camera at its GPS position, with a list nearest first, on locar.js in browsers and the Android shell. In the iOS shell, the pins go to the native geo view instead ([0006](0006-ios-geo-view.md)). Tapping a marker or a list row opens the Place's card: how far and which way it is, then what the map's pin popup shows.

## Non-goals

- No capture, keyframe or alignment use. GPS places to metres.
- No new server route, and no Place writes.
- No store build. The wrapper's policy is [0004](0004-wrapper-engine-and-start-page.md).

## Pinned conventions

- ADR 0001. The viewer reuses:
  - `GET /project-locations`, the map's pins route (`server/main.ts`), read with the map's own entry type, `ProjectLocationEntry` (`src/viewer/geomap.ts`);
  - `latLngToScene` (`src/viewer/map-plane-math.ts`) for placement;
  - `declinationDeg` and `trueBearingDeg` (`src/world/declination.ts`);
  - `compassReadingFromEvent` (`src/geo/compass-heading.ts`) for the heading;
  - `openLegalNotices` (`src/ui/legal-notices.ts`);
  - `openShellDialog` (`src/ui/shell-dialog.ts`) for the Place card;
  - `apiUrl` (`src/shared/api-base.ts`);
  - in a native shell, the editor's server dialog: `changeServer` (`src/viewer/shell-menu.ts`) over the shared server form (`src/ui/server-setting.ts`), with the address `src/shared/api-base.ts` keeps on the device.
- It adds no env var, no storage key and no connection.
- One placement rule for the camera and every Place: `scenePlacement` in `src/ar/locar-placement.ts`, installed as the instance's `lonLatToWorldCoords`. The origin is the first accepted fix.
- Declination: positions are turned into the compass frame, true = magnetic + D, east positive. Where the model refuses, nothing is turned and the status line says so.
- The page's controls sit above locar's canvas, which locar puts at z-index 999.

## Before implementation

- `src/ar/locar-placement.ts`, `server/main.ts` (`GET /project-locations`), and `src/geo/compass-heading.ts` (`compassReadingFromEvent`).

## Open questions & answers

- Why `/project-locations` and not `/projects`? It is the route the map already uses for pins, and it carries no notes, floors or areas. The viewer places each entry by its pin, and its card shows the entry's name, address, scan count and last capture. It writes nothing.
- Is it guarded? As much as the map is. Sign-in or `SCAN_REQUIRE_AUTH=1` guards it, and an open install answers any caller.
- What does it need in a native shell? The Scan server's address. A shell's page is not on the server's origin. With no address saved or built in, the page opens the editor's server dialog at once. The dialog tests an address with `GET /health`, saves it on the device and reloads the page. Until then the page asks nobody for pins: a root-relative path would reach the app's own bundle, which can answer 200 with a page. A "Scan server" button shows the server in use and opens the same dialog. A browser shows neither: its server is the page's own origin.
- Can it sign in? No. It has no sign-in control. A session the app already holds is sent, through the shell's fetch wrapper (`installShellSession`, `src/shared/shell-sign-in.ts`), but the locar wrapper is a separate app and holds none ([0004](0004-wrapper-engine-and-start-page.md)). When the pins route answers 401 or 403, the page says the server asks for sign-in.
- What happens on iOS? In the iOS shell, when ScanAR has `openGeoView`, the page hands the pins to the native geo view. In Safari it runs on locar, reading iOS's `webkitCompassHeading`.

## Files impacted

- `locar-viewer.html`, `src/ar/locar-viewer.ts` and `src/ar/locar-placement.ts`
- `src/ar/native-bridge.ts`: the optional `openGeoView` and `closeGeoView` methods on the ScanAR interface
- `src/viewer/geomap.ts` and `src/ui/shell-dialog.ts`: reused unchanged, for the route's entry type and the card's dialog
- `src/viewer/shell-menu.ts` and `src/ui/server-setting.ts`: comments only, naming the viewer as a user of `changeServer`
- `vite.config.ts` (input `locarViewer`)
- `tests/mock-locar-viewer.spec.ts`, `tests/unit/node/locar_placement.test.ts`

## Schema required

N/A. It reads an existing route's existing shape.

## Definition of Done

- [x] The card: a list row opens the South test place's card (Distance 50 m, Direction 180 deg true (S), Scans 0). After one orientation event turns locar's camera to the east marker, a tap near it opens the East test place's card. With the phone lying flat, every marker is level with the camera plane, and a tap opens nothing. With the earlier picking, which let such a marker count, that check fails.
- [x] Placement unit tests pass (14 of 14), including the eight compass points, which marker a tap means (the nearest in front of the camera within its radius, never one without a finite screen point), the declination signs (New York west, Seattle east, London near zero), and that the camera and a Place keep their true separation under the turn.
- [x] The Chromium viewer test passes. It uses a fix in Seattle and four mocked pins, of which two are usable. They are drawn where the declination turn (13 to 17 degrees) puts them, and listed nearest first with true distance and bearing. Legal notices opens, and only `/project-locations` is read.
- [x] The Chromium shell tests pass, with a stand-in Capacitor bridge and a mocked server on another origin. In the Android shell, with no server saved, the page opens the server dialog and asks nobody for pins while a fix comes in. It refuses an http address and saves nothing. After a good address is saved and the dialog's reload, it reads the pins from the saved server only. In the iOS shell, after the same steps, it hands the two usable pins to `openGeoView`. With the guards taken out, both tests fail.
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
- In a native shell, `apiUrl` uses the Scan server address saved in that app's own storage. The locar wrapper is a separate app ([0004](0004-wrapper-engine-and-start-page.md)), so on first launch it has none, and the page asks for one. It reads Places only from a server that answers the pins route without sign-in, since it cannot sign in.

## Subtasks

- [x] Placement module and tests
- [x] Viewer page and Chromium test
- [x] iOS hand-off to [0006](0006-ios-geo-view.md)
- [x] The Scan server address in a native shell
- [x] The Place card, from a marker or a list row
