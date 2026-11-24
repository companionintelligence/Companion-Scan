> **Type:** Refactor / Frontend
> **Wave:** 14-inventory-fixes
<<<<<<< HEAD
> **Branch:** `inv-capture-core` (local only: no push, no PR)
=======
> **Branch:** `inv-capture-core` (local only: no push, no PR)
>>>>>>> refs/heads/inv-capture-core
> **Commit style:** `refactor(capture-core): summary`, `fix(geo): summary`
> **Design:** this ticket is the spec. Findings are the inventory's at e897380: F-NN in `curated-findings.json`, FN-NNN in `views/findings-raw.txt`.
> **Dependencies:** None. Runs beside sessions 0001-0008 of this wave, each in its own files.

## Goal

Give the capture code's duplicated pose, frame and plumbing logic one home each, with tests, and point every copy this session owns at it (F-40, FN-029 to FN-038). Close the capture-side halves of F-44 (label colours), F-08 (location leaving the device), FN-041 to FN-051, and say what F-37's unwired capture code needs from the owner.

## Non-goals

- Do not edit a file this session does not own (SESSION_RULES.md, row 0004). Changes needed in `src/main.ts`, `src/ui/**`, `src/viewer/**`, `src/world/**`, `src/shared/api-base.ts`, `src/ar/native*.ts`, `server/**` or `index.html` are listed under "Needs from other sessions" in the report.
- Do not delete a file. Dead code stays and is listed, with evidence.
- Do not rename or change the value of any storage key, cache name, database name or `sourceSystem` (CLAUDE.md "Do not rename").
- Do not change an exported name or signature that another session's files import. A moved function leaves a re-export at its old path.
- Do not change a user-facing string or a console line unless this ticket says so. `src/main.ts` matches "Tracking lost", and `tests/unit/node/tracking_reason.test.ts` pins the 8th Wall log lines.
- Do not flatten copies that differ. Where two copies differ on purpose (a threshold, a refusal, a degenerate-input rule), the shared helper takes the difference as a parameter, or a thin wrapper keeps each contract under its own name.
- Do not switch the live resolver's point-cloud tier to `liftSegment` (FN-041). That changes live placement and has not been measured on the resolver's inputs.
- Do not add gltf's extra labels to `CV_PALETTE` or change its colours. It is the mock detector's match table, and `tests/unit/deno/sync.test.ts` ties it to `public/test-fixtures/xr8-mock.js`.

## Pinned conventions

- **ADR 0001, reuse.** No new type where one exists:
  - Quaternions and positions: the `{x, y, z, w}` / `{x, y, z}` shapes of `Pose` (`src/ar/provider.ts`) and `Quat`/`Vec3` (`src/world/types.ts`).
  - Captured frames: `RawFrame` (`src/ar/provider.ts`).
  - Tracking diagnostics: `TrackingDiagnostics`.
  - Consent: the basemap's per-device answer, `ConsentAnswer` `{host, allowed}` (`src/geo/basemap-layer.ts`), generalised by key. No second consent shape.
- **ADR 0001, storage keys.** `src/shared/storage-keys.ts` is the registry. It gains:
  - `PROJECTS_DB_NAME = 'ci-xr-projects'`: the value `src/project/project-store.ts` already uses, now imported from the registry. Same value.
  - The three shell keys, with the values `src/shared/api-base.ts` exports. Declared only: api-base is the editor's file, so a test keeps the two equal until api-base imports them.
  - One new key: `GEOCODE_CONSENT_KEY = 'companion-scan-geocode-consent'`. It is localStorage, and it holds the same `{host, allowed}` JSON as `BASEMAP_CONSENT_KEY`. Searched first: no existing key records a reverse-geocoder answer.
- **ADR 0001, the client↔server connection `POST /upload-summary`.** Multipart `file`, plus `sessionId` only when `isServerSessionId(store.sessionId)` (`src/shared/session-id.ts`, `SESSION_ID_RE = /^sess-[a-z0-9-]+$/`). A client-local `local-…` id is never sent. The file still uploads without it. No new field, and no new route.
- **Tests:** `tests/unit/node/wp-capture-core-*.test.ts`. `package.json` belongs to no session, so a new file runs in `npm run verify` only through an existing glob, and `test:wave` (`wp-*.test.ts`) is the one. The rules ask for names that start with the area, and these start with `wp-` to run in the gate.
- **Node test runtime:** `node --experimental-strip-types`. Use explicit `.ts` import specifiers, and no parameter properties or enums in any module a test imports.
- **Docker image:** a module the server reaches (`src/shared/cv-palette.ts`, `panoptic_lift.ts`, `session-id.ts`) gains no import outside the directories the Dockerfile copies (`tests/unit/node/wp-docker-server-imports.test.ts`). The new shared homes import nothing, or only one another.
- **Numbers:** every threshold that is moved keeps its value. A copy's threshold that differs stays a separate, named constant: 500 ms for a WebXR capture refusal, 1500 ms for ending a tripod sweep.

## Before implementation

- Read SESSION_RULES.md and CLAUDE.md (do-not-rename, ADR 0001).
- For each copy, read both sides and the tests that pin them:
  - `wp-17a-runtime-anchors` pins the anchors' zero-quaternion rule.
  - `frame_epoch.test.ts` pins `yawTwistDeg`'s NaN, and the native reasons.
  - `tap_sampling`, `wp-09b-drift-tap`, `wp-calibration-taps`.
  - `wp-c-webxr-teardown` and `wp-car-webxr-session` push into `captureQueue` as an array.
  - `tracking_quality` and `tracking_reason`.
  - `sweep_cadence`.
- Grep `tests/unit` for tests that read a source file as text before moving a symbol: the wiring, anchor-guard and quarantine tests.

## Open questions & answers

- Q: The brief wants one set of unstable tracking reasons including EXCESSIVE_MOTION and INSUFFICIENT_FEATURES. `frame_epoch.test.ts:120-126` pins the opposite: a NORMAL frame carrying one stays good. — A: follow the brief. The test is rewritten on purpose: one set, used by `classifyTracking()` and `trackingIsStableForPlacement()`. Only native layers send these two reasons, and always with LIMITED, so nothing changes for a session today. (capture-core, 2026-11-23)
- Q: Should the drift reader honour `?tap=` as the calibration sampler does (FN-034)? — A: it now builds through the one sampler, and takes an optional `search`. It does not read the address on its own: `src/main.ts` passes no `search`, and the drift check keeps reading a burst with the floor ray as a cross-check. Whether DX2's `?tap=single` arm also covers the drift check is an owner decision. Passing `search: location.search` at `src/main.ts:740` turns it on, and that file is scanner-ui's. (capture-core, 2026-11-23)
- Q: Yaw helpers. Are `yawTwistDeg` (frame-epoch), `yawAboutVerticalDeg` (anchors) and `yawDegFromQuat` (pose-delta) one function? — A: the first two are one quantity, the twist about +Y of the relative rotation, with different rules for a zero quaternion (NaN against 0) and at the seam ([-180, 180] against (-180, 180]). They share one core and keep their names and contracts. `yawDegFromQuat` is a different quantity, the heading of one camera's view direction. It moves beside the others as `cameraHeadingDeg`, and pose-delta re-exports it under its old name. (capture-core, 2026-11-23)
- Q: Are closure's `bestTurnDeg` and frame-fit's fit heading one function (FN-038)? — A: no. frame-fit accumulates `cross` with the opposite sign, and the same pass collects the mirrored sums its verdict needs. frame-fit is the editor's. Both are listed, not merged. The camera path length is one function: `pathLengthM`, which summary.ts now calls. (capture-core, 2026-11-23)
- Q: FN-041. Can the resolver's point-cloud tier call `liftSegment`? — A: not where they are equivalent, because they are not equivalent. A fixed 0.25 m cylinder whose most collinear point wins is a different policy from a cone sized by the segment's area whose nearest supported cluster wins, with abstention. A test shows them disagreeing. The one part they share, the 0.5-5.0 m depth window, now has one home. Swapping the policy is an owner decision. (capture-core, 2026-11-23)
- Q: F-37, wiring WebXR runtime anchors into the calibration commit. — A: owner decision, not wired. The anchor tests drive a hand-written stub and not iwer's emulation, `anchors.ts` records that iwer grants anchors without holding them, and an anchor made at commit would feed epoch thresholds nobody has measured. Evidence for each F-37 piece is in the report. (capture-core, 2026-11-23)
- Q: The geocoder consent card. Where is it shown, given that `src/main.ts` and `index.html` belong to scanner-ui? — A: `src/geo/` builds it, self-contained with inline styles, as the basemap's status box is, and `GeoTracker` asks through an injectable dependency. No stored answer means no request. — Needs a device run to see the card above the scanner's start screen and the AR view.
- Q: Does FN-036 refuse the mock pages' calibration taps? — A: no. iwer builds every viewer pose with `emulatedPosition` false (`node_modules/iwer/lib/frameloop/XRFrame.js`), so its burst frames now read NORMAL where they read UNKNOWN, and both pass. Only a runtime that reports an emulated pose sees a refusal, which is the finding's intent. Whether one does during a real loss is for DX6. (capture-core, 2026-11-23)
- Q: FN-039, `ReferencePhotoRole` declared twice. It is outside FN-029 to FN-038, but both files are this session's and the two declarations are identical. — A: done. The store declares it, and `reference-photo.ts` imports it as a type and re-exports it. (capture-core, 2026-11-23)
- Q: Test file names. The rules ask for names that start with the area; `package.json` is unowned, and only `wp-*.test.ts` runs in the gate without a new script. — A: `wp-capture-core-*.test.ts`, reported as a deviation. (capture-core, 2026-11-23)
- Q: What does F-37's evidence say for each piece? — A: none is deleted, and each is an owner decision:
  - Runtime anchors: `WebXRAnchors` is wired (`webxr.ts` asks for the optional feature, feeds it every frame and forwards its events to the epoch tracker), but nothing ever creates an anchor. `tryCreateAnchor`, `persistAnchor`, `restoreAnchors`, `forgetPersistedAnchor` and `createPersistentAnchorStore` have no caller in `src` beyond a doc comment in `provider.ts`; only the wp-17a tests run them. Wiring one into the commit means the modal holds a handle that `src/main.ts` releases when a calibration is dropped, and DX6 sizing the move thresholds first.
  - The printed-fiducial pipeline: `src/ar/fiducial/` is imported by `scripts/print-fiducial.mjs` (the dictionary and payload, for printing sheets) and by tests. The detector, tag pose and pose history have no runtime caller.
  - The phone telemetry sender: no importer anywhere in `src`. Only a source-text check in `compass_heading.test.ts` reads it. Its other end is the gimbal backend (`subsystems/osmo-ble`).
  - Clock sync: no importer in `src`. The server half (`server/world/take_sync.ts`, the capture room of `/rtc-signal`) is wired. The client half waits on take ids from person clips, which are scanner-ui's FN-028 and FN-108. (capture-core, 2026-11-23)

## Files impacted

- **New:**
  - `src/shared/pose-math.ts`: rotation angle, the yaw twist and camera heading, vector rotation, Shepperd matrix to quaternion, field of view and aspect from a projection, `wrapDeg` and `pathLengthM`.
  - `src/ar/tracking-reasons.ts`: the one set of unstable reasons.
  - `src/ar/provider-plumbing.ts`: the capture queue, stale-pose refusal, pose-age diagnostics, and the hidden-then-resumed bookkeeping.
  - `src/ar/canvas-taps.ts`: canvas tap handling.
  - `src/ar/reference-photo-view.ts`: the reference-photo loader and crosshair placement.
  - `src/scene/dispose.ts`: the three.js dispose traversal.
  - `src/capture/frame-image.ts`: the frame JPEG encode and `blobToDataUrl`.
  - `src/capture/video-liveness.ts`: frozen-video detection.
  - `src/geo/consent.ts`: the per-device answer by key.
  - `src/geo/geocode-consent.ts`: the geocoder's question.
  - `tests/unit/node/wp-capture-core-*.test.ts`.
- **Changed (all row 0004):**
  - Pose and frame code: `src/ar/{anchors,frame-epoch,tap-sampling,ground-gate,reference-photo,eighthwall,webxr,tracking-quality,drift-tap,project-calibration,reanchor-banner,return-visit-aids,constellation-ghosts,closure,calibration-run,provider,preflight,webxr-camera-access.d}.ts` and `src/ar/fiducial/tag-pose.ts`.
  - Capture: `src/capture/{capture,keyframes,pose-delta,sweep-cadence,probe-log,capture-intent}.ts`.
  - Inference: `src/inference/{router,server}.ts`.
  - Export and spatial: `src/export/{gltf,summary}.ts`, `src/spatial/resolver.ts`.
  - Shared: `src/shared/{cv-palette,storage-keys,panoptic_lift}.ts`.
  - Geo and project: `src/geo/{geo-tracker,basemap-layer}.ts`, `src/project/project-store.ts`.
  - The unit tests of these files that pin what changes.

## Schema required

None. `GEOCODE_CONSENT_KEY` stores the existing `ConsentAnswer` JSON. `/upload-summary` loses a field it never read; it gains nothing.

## Definition of Done

- [x] Each F-40 copy this session owns calls its shared home. Each copy in another session's file is listed for that session.
- [x] Every shared helper has a test, and every changed copy is checked against its old body on seeded inputs, or by the tests that already pin it.
- [x] F-44: `gltf.ts` colours come from `cv-palette.ts`, and the same label gets the same colour.
- [x] F-08: no reverse-geocoder request without a stored yes. The altitude row claims no datum. No `local-` id is uploaded.
- [x] FN-036, FN-041 to FN-051: fixed or documented, as each Q&A above says.
- [x] F-37: each piece listed as an owner decision, with evidence.
- [x] `npm run verify` passes: exit 0 at 6bdabd8 on 2026-11-23, and `npm run build` passes. e553acc then changed two tests (copies in place of native-codec imports) and the card's position. `tsc --noEmit` and `npm run test:wave` (2,492 pass, 0 fail) ran green at e553acc.

## Tests

- [x] `wp-capture-core-pose-math.test.ts`: every pose-math helper, and old against new on seeded inputs for each copy it replaces.
- [x] `wp-capture-core-tracking-reasons.test.ts`: one set, both readers use it, the native reasons are in it, and `BURST_POSE_JUMP_M` equals `FRAME_JUMP_TRANSLATION_M`.
- [x] `wp-capture-core-provider-plumbing.test.ts`: the queue's refusal, timeout, settle and fail; the stale-pose bound; pose age; a hidden spell; and the bounded `xrloaded` wait. 8th Wall's held-pose condition is held by a source check, not a behaviour test.
- [x] `wp-capture-core-frame-io.test.ts`: the JPEG sizing and encode (canvas stubs), the size fallback only where asked, `blobToDataUrl`, and frozen video at both thresholds.
- [x] `wp-capture-core-ui-plumbing.test.ts`: canvas taps (one touch, no second from pointerdown, two fingers ignored, removal), the photo loader's late, stale and failure paths, crosshair offset, and dispose.
- [x] `wp-capture-core-geo-privacy.test.ts`: no request without a yes, one question per device, decline, `stop()` removes the orientation listeners, the altitude row, and the summary's `sessionId`.
- [x] `wp-capture-core-palette.test.ts`: gltf's colours are cv-palette's, every `CV_PALETTE` label keeps its rgb, and alias and substring order.
- [x] `wp-capture-core-registry.test.ts`: the registry declares `ci-xr-projects` and the shell keys, equal to api-base's, and project-store uses it.
- [x] `wp-capture-core-resolver-lift.test.ts`: the two depth policies disagree on a constructed cloud, and share the depth window.
- [x] Existing tests change only where this ticket changes a pinned behaviour or reads a moved line:
  - `frame_epoch.test.ts`, for the native reasons;
  - `tap_burst_providers.test.ts`, for FN-036;
  - `wp-09b-wiring.test.ts`, for drift-tap's construction;
  - `wp-constellation-ghosts.test.ts`, for its import list;
  - `wp-e-geo-tracker`, `wp-e2-geo-backoff` and `wp-e3-geo-cache-persist`, which inject a yes consent.

```
source ~/.nvm/nvm.sh && nvm use 22.23.2
export ONNXRUNTIME_NODE_INSTALL_CUDA=skip PATH="$HOME/.deno/bin:$PATH"
node --experimental-strip-types --no-warnings --test tests/unit/node/wp-capture-core-*.test.ts
npm run test:wave
npm run verify
```

## Acceptance Criteria

- [x] `grep -n "Capture already pending" src/ar/*.ts` finds one declaration in this session's files, `provider-plumbing.ts`. `src/ar/native.ts` belongs to native-apps, keeps its own copy, and is listed for them.
- [x] `grep -rn "function blobToDataUrl" src` finds one.
- [x] `grep -rn "'TOO_MUCH_MOTION'" src/ar/*.ts` finds the reason in one module.
- [x] Given a GeoTracker with no stored answer, when a fix arrives, then no request goes to the geocoder until the person answers yes, and a no is kept on the device.
- [x] Given a session id `local-…`, when the summary uploads, then the form has a `file` and no `sessionId`.
- [x] Given `stop()`, then neither orientation listener is still attached, and a later `start()` adds them again.

## Risks / potential issues

- **Risk:** a shared helper subtly changes a number: rounding, or a degenerate case. — **Mitigation:** seeded old-against-new tests for each copy, and the existing pinned tests are kept unchanged except where noted.
- **Risk:** other sessions edit importers of these modules at the same time. — **Mitigation:** no exported name or signature is removed, and moved functions are re-exported from their old paths.
- **Risk:** the geocoder card may sit under the start screen, which is FN-004's failure. — **Mitigation:** it is fixed at the top of the window at z-index 950. The scanner's highest layer is the basemap's status box at 900, and `index.html`'s highest is 90. The top is used because the bottom holds the Scan cards, the capture button, the calibration card, the re-anchor banner and the drift check. Needs a device run.
- **Risk:** four Playwright specs give the page a GPS fix, so the card now appears in them and could take a click meant for something under it. — **Mitigation:** none in this branch, because the specs are not this session's files:
  - `mock-reanchor`, `mock-two-point-calibration`, `mock-offline-queue` and `mock-frame-generation` call `grantPermissions(['geolocation'])` and `setGeolocation`.
  - The fix is to seed `companion-scan-geocode-consent` in each spec's init script, for example `{host: 'nominatim.openstreetmap.org', allowed: false}`. That also stops them sending real lookups.
<<<<<<< HEAD
  - This is listed under the report's needs. No browser spec was run here.
=======
  - Done in a2831be, at the owner's request: each spec seeds a no in its init script.
  - The four specs then ran against this branch's own servers on spare ports with mock inference: 41 passed, 0 failed (6.7 min, chromium-mock). That is also the first browser run of the calibration card, the photo loader, the tap reader and the re-anchor flow on this branch.
>>>>>>> refs/heads/inv-capture-core
- **Risk:** adding EXCESSIVE_MOTION and INSUFFICIENT_FEATURES changes `classifyTracking` for a NORMAL frame carrying one. — **Mitigation:** no runtime sends that pair today. The native codec sends them only with LIMITED, which was already degraded.
- **Risk:** FN-036 makes WebXR burst frames carry LIMITED for an emulated pose, so a calibration burst over emulated poses is refused. That is the finding's intent. — **Mitigation:** the mock specs (`?mock=webxr`, iwer) are scanner-ui's and editor's. Whether iwer reports `emulatedPosition` is written up in the report, not softened here.

## Subtasks

1. [x] Ticket.
2. [x] pose-math, and its users.
3. [x] tracking reasons.
4. [x] provider plumbing and FN-046, FN-036.
5. [x] frame JPEG, blobToDataUrl and video liveness.
6. [x] tap readers, canvas taps, photo loader and dispose.
7. [x] F-44 palette.
8. [x] F-08: consent, the altitude label, the session id, and FN-050.
9. [x] FN-041, FN-043, FN-044, FN-047, FN-051.
10. [x] F-37 evidence.
11. [x] `npm run verify`, then the report.
