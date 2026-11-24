# 0015. The scene is right-handed (x east, y up, z south), and a Place has one georeference

- **Status:** Proposed
- **Date:** 2026-11-17
- **Related:** ADR 0001 (the reuse rule this follows), ADR 0002 (the pure modules are browser-safe), ADR 0004 (world
  writes are serialized), ADR 0005 (rules 3 and 5: the accuracy and verification rules this obeys),
  `src/world/enu.ts` (the exact earth model and the scene mapping), `src/world/declination.ts` (WMM2025),
  `src/world/georef.ts` and `server/world/world_origin.ts` (this decision, as code),
  `docs/product/PLACE_SCAN_DESIGN.md` ("Spatial Alignment Contract"), ADR 0011 (frame generations: a georeference names
  the frame it was made against by that frame's `frameId`, as `anchorRef`, an optional field).

## Context

A Place frame is built from geometry (ADR 0005): the landmark is the origin and the landmark-to-heading-marker
direction is +Z. Two scans of one Place line up with each other through it, and nothing in this decision changes that.
What no part of the product did was put that frame on the Earth, and the map half of the work (the editor's lat/lng
readout, a 1:1 map, a GeoPose or Companion Memory export) needs exactly that. Five facts, each read in the code, made it
impossible by construction:

1. **The scene was a mirror.** A world declares its axes as x east, y up, z north (`LocalFrame.axes.z`). That set of
   axes is left-handed (east x up points south), and every AR session is right-handed. A session placed in it by a
   rotation (`composeYUpTransform` is one) comes out mirrored east to west whatever the compass and GPS say, by up to
   8 m for a feature 4 m from the origin (`tests/unit/server/world_registration.test.ts` measures it). No rotation can undo
   a mirror.
2. **Nothing registered a Place.** `Project.geoPose` is the creating phone's one-shot fix, indoors, with its own
   compass heading attached. `anchorBearingDeg` is the bearing of the *session's* +Z, which is where the AR runtime
   happened to start, not the Place's (+Z is the baseline the person walked), and nothing reads it. `world.originGeoPose`
   was the newest located scan's fix. The editor nevertheless printed ENU and a latitude and longitude from that origin.
3. **A scan with no calibration was placed from one snapshot.** One GPS fix and one compass heading, taken at the
   moment of export wherever the person then stood, with no gate on accuracy or age, GPS altitude as the height (a null
   altitude read as 0, which drops a scan 30 m), the raw device heading as the yaw, then frozen.
4. **A compass reads magnetic north.** Every web heading is magnetic (WebKit passes `magneticHeading`; Chrome's
   `deviceorientationabsolute` is the magnetometer), so a bearing for a map needs a declination, and `declination.ts`
   supplies one from WMM2025. Indoor error in steel buildings is tens of degrees, and what an iPhone's heading follows
   under tilt is unverified.
5. **A map click is the better reference, and has a floor.** An origin picked on imagery cannot be better than the
   imagery (a vendor's CE90 of 4 to 5 m is about 3.5 m as a 68% radius), and a bearing from a one to three metre
   landmark-to-marker baseline is 5.7 to 17 degrees at 0.3 m of click noise, from a 30 m building edge under one degree.

## Decision

**1. The scene is x east, y up, z south.** It is right-handed, like three.js and WebXR, and a camera looking along -z
faces north with east on its right. A local east, north, up offset is carried into it by `sceneFromEnu`:
`scene = (E, U, -N)`, a rotation of -90 degrees about x (determinant +1). `src/world/enu.ts` is the one place geography
is converted: nothing yaws a (east, up, north) triple, nothing maps z to north, and a test fails if either happens. A
frame whose +Z has true bearing `b` is the scene frame turned about +Y by `180 - b` degrees (`sceneYawForBearingDeg`), so
a session or a Place frame reaches the scene by rotation alone. Latitude, longitude and any absolute metre value stay in
doubles in JSON: a Float32 holds a latitude to 0.42 m and an ECEF coordinate to 0.5 m, so only Place-local metres reach a
GLB or the GPU.

**2. A Place has at most one georeference, and it is written through one route.** `Project.georeference` (the type is
`ProjectGeoreference` in `src/world/types.ts`) holds the origin (latitude, longitude, an ellipsoidal height or null, and
the horizontal accuracy as an R68 radius), the true bearing of the Place frame's +Z, that bearing's one-sigma accuracy,
`convention: 2` (the sign rule of `BEARING_CONVENTION`), `datum: 'WGS84'`, how it was obtained (`source`), the
declination used when a compass was, when it was registered, when a person confirmed it, and `anchorRef`, the identity
of the Place frame it was made against (a frame's `frameId`, never its `createdAt`). `Project.georefVersion` counts the
accepted writes. `PUT /projects/:id/georeference` takes `{ georeference, expectedVersion }` and is a compare-and-swap on
that version: the same shape as `PUT /projects/:id/spatial-frame`, so 409 carries the record the Place holds, 400 carries
the validator's reason, and the client sends the no-queue header (a save that cannot reach the server says so: "Saving a
location needs a connection"). A whole-record PUT can neither write nor erase it. The origin is the Place frame's
(0, 0, 0), the landmark on the floor. A record stored in the registry is read for use as a record that must be well formed and
whose claims are held to the floors of today (a floor a device measurement raises later does not make a Place forget its
registration: `readStoredGeoreference`); and a record whose `anchorRef` names another frame than the one the Place holds now is
not used at all (the Place's alignment was made again after the location was saved: the world forgets it, the editor says "set for
an earlier alignment", the HUD flag says "Location is for an earlier alignment" and offers "Set location again", and a save again binds
it to the new one). Both ids have to be known for that: **a frame written before frame ids were
minted (WP-08, ADR 0011) has none, and when it is replaced the registration stands and nothing here can see it.**

**3. Accuracy is stated as it was obtained, and no better (ADR 0005 rules 3 and 5).** `validateGeoreference` refuses a
number that is not finite or not in range, and refuses an accuracy below the floor of the source it claims:

| source | origin floor (R68) | bearing floor (sigma) |
| --- | --- | --- |
| `map-click`, `footprint-snap` | 3.5 m | 1 degree |
| `typed` | 3.5 m | 1 degree |
| `survey` | 0.05 m | 0.1 degree |
| `gps-compass` | 10 m | 15 degrees (25 on an iPhone) |
| `course-over-ground` | 10 m | 5 degrees |

A bearing from a short baseline is held to 8 degrees at least (`predictedBearingSigmaDeg`, which the map editor will
use before it writes the record). A seed (`gps-compass`) is a best-accuracy fix of the first 60 s of a walk and the
circular mean of steady compass samples, its bearing accuracy is `max(circular SD, 15)` and at least 25 on iOS until the
spin test has run on a phone; it is **approximate, it is never averaged into a registration a person confirmed, and it
is never stored as confirmed without the person pressing Confirm**. `Project.georeference` never takes a phone's
`coords.altitude` (mean sea level on iOS, the ellipsoid on Android). Every one of these numbers is adopted, not
measured, and is a named constant in `src/world/georef.ts` that says so.

The Place location panel (`src/viewer/georeference-panel.ts`) writes the record by numbers, and what it does with a record it
saves again is decided here so that a save does not unmake what the record was. With every number unchanged the new record
keeps the old one's source and what it rested on (a compass seed stays a seed, with its declination, its scans and the accuracy
it claimed; a map click stays a map click), and it keeps the height while the latitude and longitude are unchanged, because the
panel has no field for it. The two buttons, Save as approximate and Confirm, decide only whether the record is confirmed. A number
the person changes makes it `typed`.

**4. A calibrated scan is placed through the georeference.**
`localToWorld = T(sceneFromEnu(geodeticToEnu(worldOrigin, georeference.origin))) x Ry(180 - bearing) x projectTransform`,
in column-major 4x4 matrices applied as `M * p` (the layout of `ScanManifest.localToWorld`), where `worldOrigin` is
`resolveWorldOrigin`: the georeference's origin, else the located scan with the best accuracy (not the newest), else none.
With a georeference the world's origin *is* its origin, so the translation is zero and the scene's (0, 0, 0) is the
landmark. Heights are Place-local: the Place floor is y = 0, and the vertical offset is never taken from a GPS altitude.
A scan in another frame (a one-point frame, a known-distance one) is not carried by the Place's georeference.

**5. A georeference never moves a person's work.** `world.georefVersion` records the version the world's placements
were made under. When the Place's version differs, the server places again every scan that a person did not place, and
a scan a person placed stays where it is. A person placed a scan when a placement patch that still counts holds it
somewhere other than where its calibration put it (`isHandPlaced`): a scan whose only moves were undone, and one whose last
move was "reset to calibrated", are at their calibration and nobody placed them, so they follow the new record, and the
moves still holding a reset scan are taken back by records the server writes into the patch log (`revertsPatchId`, as an undo
does), so that the editor, which replays the log, draws the scan where the server put it. The editor replays only the moves
that still count (`replayedScanPlacement`). A scan a person placed is flagged `placementStale` only when the georeference now
puts it somewhere other than where it is **and** somewhere other than where the version it was placed under put it: a
registration confirmed with every number as it was, or an origin that moved (which moves the whole scene with it), changed
nothing for the scan and is no news. Things and their observations follow the scans that were placed again by the same
movement (a Thing's position is the detection of the scan that first saw it). A scan already in a world keeps the
matrix it has in every other case. A Place with no georeference keeps every placement it has, byte for byte
(`tests/unit/server/world_placement_golden.test.ts`), and a calibrated scan in it sits at its `projectTransform` as it is.

**6. A world file that declares `z: 'north'` is a legacy world, and is flagged, not recomputed.** The placements in it
that came from GPS and compass are mirrored (point 1). Nothing converts it silently: the editor says "mirrored placement"
and offers "Re-place by GPS", which opens the Place location panel; the first georeference saved there declares the
world `z: 'south'` and places its scans again by point 5. A new world declares `z: 'south'`.

**7. A scan with no calibration is placed by GPS and compass only when it can say how well.** The capture samples,
and no longer snapshots: the best-accuracy fix of the first 60 s of the walk, and the circular mean (with its spread) of
the true bearing of the session's +Z, from steady compass samples read with the AR pose at the same instant and the
declination of the place. The server places the scan by `T(sceneFromEnu(E, 0, N)) x Ry(180 - bearing)`, with the walk added
back when the camera had moved more than 3 m from the session's origin at the fix (the fix is where the phone was, not where
the session began; the placement's uncertainty carries the bearing's error over that distance), and puts it on
the grid, flagged as not placed, when the fix is worse than 25 m, was taken more than 60 s before the walk began or more than 60 s
after it (the capture records the best fix of the first minute with the camera's position at it, and a later one is where the
phone then was, with no way back to the session's origin: when no fix arrived in the first minute the scan goes to the grid), or
the bearing's spread is over 30 degrees, or when it has no bearing at all (an older sidecar holds a device heading, which is not the session's). Mixed
Places are allowed (D6): `ScanManifest.placementSource` and `placementUncertaintyM` say, in the scan list, what put each scan
where it is, a scan a person placed says so and makes no claim about the map, and a scan that is not in the Place frame says so,
once on its own line and once in the editor's banner. In a Place that has scans in its frame the others are left out of matching
Things between scans until they are calibrated (`scansOutsidePlaceFrame`); in a Place with none, every scan takes part, as it
always did. A scan the previous build placed by GPS in a world that declares `z: 'north'` is stamped `gps-compass` and no
uncertainty: its placement is the phone's own heading in mirrored axes, and no figure is one this build can stand behind.

**8. Readouts and exports say what they know.** The editor prints a latitude and longitude only for a georeferenced
Place, and says "Local (no georeference)" otherwise. The whole-Place glTF carries a `georeference` block in its scene
extras, or an explicit `null`; the Companion Memory event carries `spatial_frame.georeference`, and its `location`
carries the phone's heading as `device_heading_at_export` with `northReference: 'magnetic'` (the old `bearing` key is still
written, named in `deprecated_keys`, so a consumer that reads it keeps working). Each scan node of the whole-Place glTF says how it was placed (`placementSource`,
`placementUncertaintyM`, `placementStale`, `placedByHand`), because the scene's `georeference` describes the Place frame and a
reader could otherwise take a GPS placement, a grid slot or a hand move for a georeferenced scan. An OGC GeoPose is available
as `toGeoPoseBasicQuaternion` (the Basic-Quaternion schema) and is off unless an export asks for it.

## What this reuses (ADR 0001)

- `ProjectSpatialFrame`'s write pattern (a counter, `expectedRevision`, 409 with the current record), copied for the
  georeference route and its client; its validator pattern for `validateGeoreference`.
- `Project.georeference`, `Project.georefVersion`, `ScanManifest.placementSource`, `placementUncertaintyM`,
  `placementStale` and `LocalFrame.axes.z: 'south'`, which the schema work added ahead of this one.
- `GeoPose` for `Project.geoPose` (the Place's pin, unchanged) and for `world.originGeoPose`, which is now the
  georeference's origin carried as a `GeoPose`. `ProjectGeoreference.origin` is not a `GeoPose` on purpose: a `GeoPose`
  is a phone's fix whose coordinates may be missing and which carries the phone's heading and an address, and a
  registration has a position or it has none.
- `composeYUpTransform`, `sceneFromEnu`, `sceneYawForBearingDeg`, `geodeticToEnu` and `declinationDeg`: no new
  geodesy, no new rotation code, no new declination model.
- The compass pairing of `GeoTracker.pairedCompass` for the bearing samples, `ScanManifest` for where a scan is, the
  Place registry for where the record lives, and the one world-file writer (`withWorldLock`) for recomputing.

New, because nothing existing does the job: `src/world/georef.ts` (the record's validator, the bearing and accuracy
arithmetic, the GeoPose export, seed aggregation), `src/world/geo-session.ts` and `src/geo/session-seed.ts` (the session record
and the sampler that makes it), `server/world/world_origin.ts` (the placement decisions, and the few functions
`server/main.ts` calls to make them), `server/world/georef_write.ts` (the compare-and-swap), `server/world/georef_routes.ts` (the
two routes) and `server/world/georef_seed.ts` (the compass estimate behind the one read route,
`GET /projects/:id/georeference-seed`, because no existing route exposes a scan's compass data), `src/world/georef-client.ts` (the
client the Place location panel and, later, the map editor share), and the editor's readout, scan-list lines and panel
(`src/viewer/georef-hud.ts`, `placement-note.ts`, `georeference-form.ts`, `georeference-panel.ts`). `server/main.ts` and
`src/viewer/viewer.ts` hold a few lines each that call into them, and nothing in them imports either (ADR 0004).

## Consequences

**Easier.** A Place can be dropped on a map by one origin and one bearing, and everything in it follows: the editor's
readout, the exports, and later the map editor and a 1:1 plane. The mirror cannot come back unnoticed (a test names the
determinant and the direction of north). A scan's list entry says how it was placed and how sure that is. Two sessions
of one room with different start headings place every feature to 1e-9 m through the same record.

**Harder.** The record has two lifetimes to keep apart: the geometry of the frame, which a calibration owns, and the
record that relates it to the Earth, which a person owns. A replaced frame leaves the georeference behind
(`anchorRef` is how that is seen, once frames have ids). A legacy world stays mirrored until someone chooses to re-place it, and its scan
list carries a flag until then. The placement of an uncalibrated scan from an older build, which has no session bearing,
becomes "on the grid" in a new world: it was never right, and it no longer pretends.

**What this does not solve.** A georeference is as good as its source. A compass seed indoors is approximate to tens of
degrees; a map click is no better than the imagery, about 3.5 m. Nothing here makes either a verified fact, and nothing
says one is. The compass sign and handedness are settled by computation and by a physical model; what a phone's compass
reports under tilt needs the spin test (DX3) and a surveyed bearing (DX7). WMM2025 is valid to the end of 2029: from
2030 a seed has no declination and a scan with no true bearing goes to the grid.

**Revisit** when a device measurement replaces an adopted constant, when WMM2030 is released, when counsel has read the
8th Wall licence (a registration made against engine frames), or if the map editor needs a different record.
