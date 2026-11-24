> **Type:** Frontend
> **Wave:** 16-spatial-editor-v1 (written as a third `12-*` folder; renumbered when it was ported)
> **Branch:** `feat/spatial-editor-v1-port` (the port onto main; the branch it was written on was never pushed)
> **Commit style:** `feat(editor): ...`
> **Design:** the origin-calibration wave, whose `buildOriginDecal` this ticket adopts (`docs/factory/12-origin-calibration-v1/0001-origin-decal-and-persisted-ground-height.md`, which says the Spatial Editor "may adopt" it)
> **Dependencies:** 0004 (the scan list and the viewer's loaded scans), and the origin-calibration work, on main since #269
> **Ported:** 2026-11-24, onto main after wave 14. Where this ticket and wave 14 overlap, wave 14's code stayed and this ticket was built on it: see the README, § "Ported onto main".

## Goal

A calibrated scan's origin in the World Editor is drawn by the shared origin decal, not the older anchor marker. For a two-point calibration, the decal's heading arrow runs along the measured baseline and ends on the red heading pin.

## Non-goals

- Do not edit `src/world/origin-decal.ts` or `src/world/anchor-marker.ts`. The origin-calibration wave owns the first; the scanner still uses `buildAnchorMarker`.
- Do not pass a north yaw. The editor has no compass fix for a scan, so the decal gets no north tick.
- Do not draw the compass arrow or the calibration record text ("Heading unverified", the floor-check bypass). Both wait on decisions outside this ticket.
- Do not change the pins. The red "actual" pins and the white "expected" pins stay as they are.

## Pinned conventions

- **Origin:** local `(0, 0, 0)` of the scan root, the invariant every calibration method shares. Project `y = 0` is the floor, so the editor reads no `groundY`.
  *Ported:* root-local `(0, 0, 0)` is the AR session's origin, not the landmark. Main places the anchor at the landmark as the session tapped it, `inverse(M)·(0, 0, 0)` (`sessionAnchorPositions`, `src/world/anchor-placement.ts`), and the decal is drawn there.
- **Heading point:** `(0, 0, calibrationSeparationM)` in the scan's own frame, only when `calibrationMethod` is `two-point-ground` and the separation is set. The arrow then ends on the red heading pin.
  *Ported:* that point is in project space; the arrow ends on main's heading marker, `inverse(M)·(0, 0, separation)`, where the red heading pin stands.
- **Emphasis and gate:** `'committed'`, for `calibrationStatus` `verified` or `provisional`, as before.
- **ADR 0001:** reuses `buildOriginDecal` (`src/world/origin-decal.ts`), `originDecalPlan` (`src/world/geo.ts`), and the scan's existing calibration fields. Nothing new in `src/world/types.ts`.

## Why the scan's own heading point, not the Place frame

The web note suggested `ProjectSpatialFrame.headingMarker`. The decal is a child of the scan root, and the white "expected" pins already draw the stored frame in `worldGroup`. Pointing the arrow at the stored frame would put it on the white pin and hide the residual that the red and white pins exist to show.

## Before implementation

- `src/viewer/viewer.ts` `addAnchorMarker`, `refreshExpectedAnchorPins`, and the `__editorTest` hooks.
- `src/world/origin-decal.ts` (its header and `buildOriginDecal`) and `src/world/geo.ts` `originDecalPlan`.

## Visible consequences

- The ring stays dim. `buildAnchorMarker()` already drew a dim ring with no bearing (opacity 0.32), and the decal's no-compass ring is 0.35.
- New: the heading arrow, for two-point scans only.
- Unchanged: no north tick, the crosshair (0.35), and the pins.
- One-tap (`ground-tap-compass`) scans have no baseline, so they get the decal and no arrow.

## Files impacted

- Changed: `src/viewer/viewer.ts` (`addAnchorMarker`, the imports, `__editorTest.originDecal`), `tests/mock-spatial-editor.spec.ts` (one test), `docs/factory/16-spatial-editor-v1/README.md`, `docs/factory/atlas.html`.

## Schema required

None.

## Definition of Done

- [x] A verified or provisional scan's origin is drawn with `buildOriginDecal`.
- [x] A two-point scan's heading arrow is sized from its separation and points along +Z, where the heading pin sits. The viewer test checks the parts, not the arrow's tip.
- [x] The editor draws no north tick.
- [x] `buildAnchorMarker` is unchanged and still used by the scanner.

## Tests

- [x] `tests/mock-spatial-editor.spec.ts`: "a verified two-point scan draws its origin decal with the heading arrow and no north tick". The mock calibrates its one scan for that test only, and the test reads the decal's parts through `__editorTest.originDecal`.
- [ ] Not asserted in the viewer test: the arrow's tip in world space. The decal's own unit test (`tests/unit/node/origin_decal.test.ts`) pins the arrow's geometry, and this ticket checks only that the viewer passes it the baseline.

```
VITE_URL=http://127.0.0.1:5199 npx playwright test --project=chromium-mock mock-spatial-editor
```

## Acceptance Criteria

- Given a verified two-point scan with a separation of 1.8 m, when the editor opens, then its root holds a `calibration origin` that contains an `origin heading arrow` and no `origin north`.
- Given a scan with no calibration, then the editor draws no origin, as before.

## Risks / potential issues

- **Risk:** the origin-calibration wave changes `buildOriginDecal`'s look. **Mitigation:** this viewer depends on the function's parts, and the test checks which parts exist, not how they look.
- **Risk:** one-tap scans get a decal with no arrow, which could read as a missing feature. **Mitigation:** the arrow needs a baseline, and a one-tap scan has none.

## Subtasks

1. [x] Switch `addAnchorMarker` to `buildOriginDecal`, with the scan's own heading point.
2. [x] Add `__editorTest.originDecal` and the mock test.
3. [x] Update the wave README and the atlas.
