> **Type:** Decision
> **Wave:** 13-ar-runtime-targets
> **Branch:** None. This is a decision, not a change.
> **Commit style:** N/A
> **Design:** [ADR 0012](../../adr/0012-locar-js-is-a-geo-viewer-not-a-scanning-provider.md), accepted
> **Dependencies:** [0001](0001-locar-spike.md)

## Goal

Decide the role locar.js plays in the scanner: a viewer beside the AR runtimes, or a limited `ARProvider` shell.

## Non-goals

- The iOS renderer ([0003](0003-ios-renderer.md)) and the engine policy ([0004](0004-wrapper-engine-and-start-page.md)).

## Pinned conventions

- ADR 0005: frames are established by geometry and verified by measurement. GPS gives neither, so no role may present GPS placement as alignment.
- ADR 0001: a viewer reuses the Place types and an existing route. It adds no new place store.

## Before implementation

- The member-by-member table in the [wave README](README.md).
- `src/ar/provider.ts`, and `src/ar/tracking-quality.ts`. `trackingIsUsable` and `trackingIsStableForPlacement` return `true` for `'UNKNOWN'`, the only status a locar shell could give.

## Open questions & answers

- Which option? **A, the viewer runtime. Accepted by the owner on 2026-11-23.**
- Where does a viewer read Places from? From `GET /project-locations`, the map's own pins route, using each Place's id, name and pin only ([0005](0005-locar-viewer.md)). That route, and `GET /projects`, are guarded only when sign-in is on or `SCAN_REQUIRE_AUTH=1`. On an open install they answer any caller, as they already do for the map.
- How is true north handled? Designed in [0005](0005-locar-viewer.md): positions, of the camera and of every Place alike, are turned into the compass frame by the WMM2025 declination.

## Options

- **A. Viewer runtime (ADR 0012), chosen.** Show Places at their GPS positions over the camera feed. Not an `ARProvider`, so no capture path can receive it. Accuracy is GPS-level: it finds a Place, but it does not align a scan to one.
- **B. Limited `ARProvider` shell.** Implement the type with the documented stubs (`hitTest` returns `null`, `featurePoints` returns `[]`, `trackingStatus` returns `'UNKNOWN'`, and the optional members are omitted). The scanner could then open a session it cannot use for capture, so the capture path would need a guard.
- **C. Drop locar from the four targets.** Keep the web and wrapper builds on the 8th Wall and WebXR path.

## Files impacted

ADR 0012 (status) and the atlas card. The viewer itself is [0005](0005-locar-viewer.md).

## Schema required

N/A.

## Definition of Done

- [x] The owner chose A on 2026-11-23, recorded above.
- [x] ADR 0012 is accepted, and the atlas card matches.

## Tests

N/A for the decision. The viewer's tests are in [0005](0005-locar-viewer.md).

## Acceptance Criteria

The decision is recorded, and the ADR and the atlas card say the same thing.

## Risks / potential issues

- The viewer shows GPS-level positions, which a user could read as precise.

## Subtasks

- [x] Owner decision
- [x] ADR 0012 and the atlas card updated
