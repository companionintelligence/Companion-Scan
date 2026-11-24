> **Type:** Frontend / Refactor
> **Wave:** 14-inventory-fixes
> **Branch:** `inv-editor` (session 0005, editor)
> **Commit style:** `type(editor): summary`, `type(world): summary`
> **Design:** this ticket is the spec. Findings are the inventory's, at main e897380: F-06, F-10, F-19 to F-25, F-41, F-42 and FN-019, FN-054, FN-055, FN-064, FN-066, FN-069, FN-073 to FN-075, FN-085, FN-086, FN-088 to FN-091, FN-094, FN-095.
> **Dependencies:** server-core (0001) adds the routes F-22 reads and the scan-required job types F-24 names. server-runners (0002) owns `server/register/place_register.ts`, which F-25 reports on. Neither blocks this ticket: each client change here is correct against today's server and against the one those sessions are building.

## Goal

Make the world editor (`viewer.html`, `src/viewer/**`) and the headset editor (`xr-world.html`) do what their controls say:

- every request carries the access token once;
- no test hook ships outside a dev build;
- every layer row, chip and counter reads one source of truth;
- every result the server produces for a Place either reaches the editor or says why it cannot.

Then make the duplicated world-model helpers (`src/world/**`) one copy each.

## Non-goals

- Do not edit any file another session owns (SESSION_RULES.md). The server's routes, its scan-required list, `server/register/place_register.ts`, `src/main.ts`, `src/rtc/**`, `src/capture/**` and `src/shared/**` other than `api-base.ts` and `access-token.ts` are listed under "Needs from other sessions", not changed.
- Do not rename or remove any export of `src/world/**`, `src/shared/api-base.ts` or `src/shared/access-token.ts`. The server and other sessions import them. A moved helper stays exported from its old module (re-export).
- Do not change `LAYER_ORDER` or what `defaultLayerIndex` writes for any layer but `detections` (see the open questions). The server writes those into every scan manifest.
- Do not switch the scene to z-south or move a stored placement (F-42). That is the owner decision `src/world/enu.ts` already names.
- Do not delete files. Dead code is listed as a deletion candidate.
- Do not add keyboard shortcuts (FN-060) or build the Depth and Semantic masks layers.
- No host names, addresses, coordinates or personal data in code, tests or docs.

## Pinned conventions

- **ADR 0001 (reuse, don't duplicate).** This ticket touches a client↔server connection (the `token` parameter) and the world model's shared helpers. It extends what exists and adds no type, env var, queue or route:
  - The access token stays the `?token=` world-member token, `accessTokenFrom` (`src/shared/access-token.ts`). The shell session token stays `shellSessionToken()` (`src/shared/api-base.ts`). No new credential.
  - Hidden objects stay `EditPatch.visible`. Unhide is a `visible: true` object patch on `POST /worlds/:slug/patches`, the patch the Hide button already writes with `false`.
  - The world GLB is the existing `GET /worlds/:slug/export.glb`. SenseNova output is the existing `WorldJob.result` and `artifacts[type='sensenova-output']`.
  - The scan-required job list moves to one constant in `src/world/` (`SCAN_REQUIRED_JOB_TYPES`), so the server's inline array (server/main.ts, `jobFailureReason`) can import it instead of keeping a second copy.
  - "Is this scan in the Place frame" is `isInPlaceFrame` (`src/world/frame-generations.ts`) everywhere in the editor. `isPlaceFrameMethod` keeps its one job: which methods a stored frame may carry.
- **One `token` parameter.** A URL carries at most one `token`. `addAccessToken` already sets it with `URLSearchParams.set`. `withSessionToken` replaces a `token` the URL already has, instead of appending a second.
- **Which credential goes where:**
  - A `fetch` sends the access token in the query and leaves `Authorization` to the session. In a shell, the session goes in a Bearer header that `installShellSession` adds (`src/shared/shell-sign-in.ts`). The server reads the query first for a world role (`requestToken`), and reads cookie, Bearer or query for a session (`scanSessionFor`). So the editor no longer sets `Authorization: Bearer <access token>`, which used to stop the shell adding the session.
  - An element that cannot send a header (an `<img>` texture, a download link) gets one `token`. A `/worlds/…` URL carries the access token, because it is the world's route. Any other path carries the shell's session token when there is one, and otherwise the access token. The session guard reads a shell's session from the query only on such a URL. No `/scans` or `/sessions` route reads a world token today.
- **Test hooks:** `window.__measureTool` and `window.__quality` exist only when `import.meta.env.DEV && ?mock=editor`, the gate `__editorTest` and `__stitchTest` use. `?mock=webxr` on `xr-world.html` loads the emulator only when `import.meta.env.DEV`.
- **Artifact reads tell four answers apart:**
  - `found`: 200 and JSON.
  - `not-run`: a JSON 404, the server's `{ error }` for a missing artifact.
  - `not-served`: a 404 or 200 that is not JSON. That is a server with no such route, or a static host.
  - `error`: any other status, or a network failure.
- Doc and copy style: plain sentences, what was checked, nothing the data does not hold (the repo's existing style, e.g. `src/viewer/scan-calibration-chip.ts`).

## Before implementation

- Read SESSION_RULES.md and CLAUDE.md. Done 2026-11-23.
- Re-check every line number in the findings at e897380: `viewer.ts` 160-178, 210, 1393, 1654-1679, 1901, 1925-2081, 2065, 2510-2527, 2812-2850, 2886-2888, 3105-3153, 3405, 3900-3974, 4180-4280, 4284-4354, 4705-4765, 4899-4944, 5029-5260, 5299-5332; `viewer.html` 1400-1403, 2276-2301, 2414-2470, 2584-2596, 2910, 2991-3054; `xr-world.ts` 97-101, 356-411, 527; `xr-world-model.ts` 72-76; `splat-layer.ts` 166, 501-514; `splat4d-layer.ts` 72-132; `reconstruction-quality.ts` 93-113; `panoptic-layer.ts` 201-208, 384-405; `frame-replacement.ts` 49-91; `frame-generations.ts` 58-90, 250-272; `spatial-frame.ts` 110-124; `register-proposal.ts` (world) 210-300; `scan-placement.ts` 94-230; `transform-tools.ts` 56-66, 449-456, 484-494; `register-proposal.ts` (viewer) 81-91. Done: all match.
- Green baseline for the unit tests this ticket touches: `scan_calibration_chip`, `wp-08c-*`, `wp-08s-frame-generations`, `transform_tools`, `stitch_*`, `xr_world_model`, `honest_placeholders`, `wp-15a-register-proposal*`, `shell_session`, `api_base`, `viewport_zoom`, `wp-docs-config-honesty`; Deno `layers`, `frame_generations`, `place_register`, `enu`, `scene_handedness`, `world_registration`.

## Open questions & answers

- Q: Which credential does a media URL carry when a shell page holds both an access token and a session token? — A: The one the route checks: the access token on `/worlds/…`, and the session elsewhere. A URL holds one `token`, and Hono's `query('token')` reads the first. So the old `?token=<access>&token=<session>` failed the session guard in a shell, because the guard read the access token. Listed for server-core: if a `/scans` or `/sessions` route is to admit world tokens, the server has to read every `token` value (decided by session 0005, 2026-11-23).
- Q: Does the editor keep sending `Authorization: Bearer <access token>`? — A: No. Every request that sent it also carries the token in the query, which `requestToken` reads first. In a shell the header stopped `installShellSession` adding the session Bearer, so `/projects` and `/projects/:id/world` failed the session guard there. `accessTokenHeaders` stays exported, and it now passes `extra` through unchanged (decided by session 0005, 2026-11-23).
- Q: One predicate for "in the Place frame": which one? — A: `isInPlaceFrame`. Owner decision D6 says a one-point, known-distance or bypassed scan is "not in Place frame". The server's frame counts, Thing matching and the editor's frame chip already ask it. The chip's "Different frame from this Place" warning now shows only for a scan that `isInPlaceFrame` counts as in a frame, made with a method other than the Place's frame. A scan that is in no frame gets the one "not in Place frame" chip. `server/register/place_register.ts` still asks `isPlaceFrameMethod` through `isPlaceCalibrated`. Moving it is server-runners' and the owner's call, and the report says what it would change (decided by session 0005, 2026-11-23).
- Q: Bounds visibility had two switches, the HUD Bounds button and the Detections layer row, with opposite defaults (bounds off, layer on). Which default survives one source of truth? — A: Off, today's effective view. That puts `detections` in `LAYERS_HIDDEN_BY_DEFAULT`, so `defaultLayerIndex` writes `visibleByDefault: false` for it. That is a change in what a server-written manifest says, reported against the server. Nothing in the editor or the server reads that field to decide what is drawn (decided by session 0005, 2026-11-23).
- Q: The 4D person row or the splat checkbox: which drives the 4D layer? — A: The 4D person row, `globalLayerVisible.splat4d`, as F-19 asks. "Show trained splat" drives the static splat alone, so neither is a second writer of the other's state (F-41) (decided by session 0005, 2026-11-23).
- Q: F-42: is any session placed by rotation alone mirrored east-west? — A: Yes, on one path, and fixing it is outside src/world and src/viewer. It is an owner decision, not a fix here. See "F-42 findings" below (decided by session 0005, 2026-11-23).
- Q: Which `known-failures.json` entries may go? — A: Only those for a spec re-run on this branch. The six mock-rtc-* entries were re-run (6 skipped by name). '07 render modes' was edited, not run, and stays (decided by session 0005, 2026-11-23).

## F-42 findings

Read from the code on 2026-11-23, by session 0005 and a read-only investigation agent. Every line below was checked against the file.

- **Mirrored: the server's GPS fallback.** A scan with no stored `projectTransform` is placed by `composeYUpTransform(geoToEnu(origin, fix), fix.bearing, 1)` in `scanManifestFromStored` (server/main.ts). That covers:
  - a scan exported uncalibrated;
  - a scan whose transform was refused;
  - a GPS outlier, placed on the grid.

  Its world declares `axes: { x: 'east', y: 'up', z: 'north' }` (`synthesizeWorld`). That is a rotation alone into a left-handed frame, so the scan's content is mirrored east-west against the GPS layout.
- **Wrong bearing on the same path.** `fix.bearing` is `geoBearing`: `geoFix?.bearing` (src/export/gltf.ts), from `GeoTracker.snapshot()`, which returns `bearing: this.compassBearing` (src/geo/geo-tracker.ts). That is the phone's heading at export, with no pose paired to it, not the bearing of session +Z. So the turn is wrong too, and fixing the handedness alone gains nothing on this path.
- **Not mirrored: the one-point calibration.** `oneTapToProjectTransform` (src/world/geo.ts) gives a right-handed frame with +Z north and +X west, under the current bearing rule. The scan's geometry is right in it. Three things disagree with it:
  - the `x: 'east'` label;
  - the coordinate readout (`enuToGeo` reads x as east);
  - a GPS-placed neighbour.
- **Not mirrored: the two-point calibration.** No compass enters it, and its +Z is the baseline. The compass needle calls the baseline north (a turn, not a mirror). `projectBearingDeg` is written and never read.
- **No stored reflection.** `checkPlacementMatrix` refuses a negative determinant (src/world/scan-placement.ts).
- **Done here.** src/world/enu.ts and LocalFrame (src/world/types.ts) now name these paths, and UX_FLOW.md says what placement does.
- **Not done here.** The fix needs:
  - a session-frame bearing sampled with its pose (capture side);
  - a right-handed composition in the fallback (server-core), `sceneFromEnu` with `sceneYawForBearingDeg`;
  - the owner's decision on the z-south scene, which turns every stored one-point placement half a turn.

  No stored placement moves in this ticket.
- **Also found, not fixed here.**
  - The coordinate readout's origin is `originGeoPose`, a located scan's fix, not the landmark.
  - The compass needle in a two-point Place is wrong by the baseline's bearing.

  Both are display issues to plan with the georeference work (ProjectGeoreference).

## Files impacted

- New:
  - `src/viewer/editor-layout.ts`: the drawer layout and collapse wiring, formerly inline in `viewer.html`.
  - `src/viewer/artifact-read.ts`: the four-answer artifact read.
  - `src/viewer/world-rules.ts`: the world slug, the scan placement and the GLB lookup that both editors share.
  - `src/viewer/layer-rows.ts`: which layer rows the editor lists, their counts, the toolbar metric and the hidden-object list.
  - `src/viewer/job-results.ts`: the SenseNova summary and the world GLB link.
  - `src/viewer/desktop-nav.ts`: the desktop app's scanner entry.
  - `src/viewer/html.ts`: the one HTML escape.
  - `src/world/mat4.ts`: the one column-major multiply, compare, finite-matrix check and decompose.
  - `src/world/job-types.ts`: `SCAN_REQUIRED_JOB_TYPES`.
  - Tests under `tests/unit/server/editor_*.test.ts`.
- Changed:
  - `src/viewer/viewer.ts`, `src/viewer/xr-world.ts`, `src/viewer/xr-world-model.ts`
  - `src/viewer/splat-layer.ts`, `src/viewer/splat4d-layer.ts`
  - `src/viewer/reconstruction-quality.ts`, `src/viewer/panoptic-layer.ts`
  - `src/viewer/scan-calibration-chip.ts`, `src/viewer/frame-banner.ts`
  - `src/viewer/places.ts`, `src/viewer/geomap.ts`
  - `src/viewer/register-proposal.ts`, `src/viewer/transform-tools.ts`
  - `src/viewer/object-filter.ts` (its doc comment)
  - `src/world/frame-replacement.ts`, `src/world/frame-generations.ts`, `src/world/spatial-frame.ts`
  - `src/world/register-proposal.ts`, `src/world/scan-placement.ts`, `src/world/anchor-marker.ts`, `src/world/origin-decal.ts`
  - `src/world/layers.ts`, `src/world/types.ts`, `src/world/geo.ts`, `src/world/manifests.ts`, `src/world/enu.ts`
  - `src/shared/api-base.ts`, `src/shared/access-token.ts`
  - `viewer.html`, `xr-world.html`
  - `docs/product/UX_FLOW.md`, `tests/known-failures.json`
  - Editor specs: `tests/e2e-suite.spec.ts`, `tests/mock-ui-desktop.spec.ts`, `tests/mock-editor-homes.spec.ts`, `tests/mock-editor-quality.spec.ts`
  - The unit tests of the modules above, where a claim they pin changed.

## Schema required

None. `LAYERS_HIDDEN_BY_DEFAULT` gains `detections`, which changes the `visibleByDefault` value `defaultLayerIndex` writes for that one layer. No field is added or removed.

## Definition of Done

- [x] F-06: the two hooks and `?mock=webxr` are dev-only. The specs that use them open the page with `?mock=editor`.
- [x] F-10: the GLB, LOD and manifest fetches, the SplatMesh URLs, the 4D manifest and frames, and the headset GLB and manifest fetches carry the access token. No URL the editors build carries two `token` parameters.
- [x] F-19:
  - the Depth and Semantic masks rows are not listed;
  - the 4D person row drives the 4D layer;
  - the four dead World-tab writes are gone;
  - the toolbar's layers metric counts the layer rows that have something to show.
- [x] F-20: hidden objects are listed in the Edit tab with a Show button that posts `visible: true`. No visibility writer un-hides a hidden object behind its back.
- [x] F-21: a scan with no usable frames draws no camera path or frustums. Its rows say "no frames".
- [x] F-22: the reconstruction verdict and the Placed objects panel tell not run, not served and error apart.
- [x] F-23: the SenseNova panel shows the selected scan's latest SenseNova job: its state, its result sentence and its output file names. The Project tab links the world GLB once an export-world job has completed.
- [x] F-24: the Advanced queue refuses a scan-backed job type with no scan selected, and says so.
- [x] F-25: a scan row never shows "Different frame from this Place" beside "not in Place frame".
- [x] F-41:
  - one copy each of the matrix helpers and of `newFrameId`, `frameIdOf` and `FrameReplaces`;
  - the headset editor uses the desktop editor's slug, placement and GLB-lookup rules;
  - cloud, label and bounds visibility each have one variable.
- [x] F-42: the mirror is either fixed with tests, or the note says exactly which paths it applies to. (The note: the fix is an owner decision.)
- [x] Smaller items: FN-064, FN-066, FN-073, FN-074, FN-085, FN-086 (the parts in owned files), FN-090, FN-091, FN-019, FN-054, FN-089, FN-055.
- [x] FN-075 and FN-094: tests for the areas this ticket touches.
- [ ] `npm run verify` passes.

## Tests

- [x] `tests/unit/server/editor_access_token.test.ts`: one `token`, the right one per route, no Authorization override.
- [x] `tests/unit/server/editor_artifact_read.test.ts`: the four answers, and how the reconstruction verdict and the panoptic panel word them.
- [x] `tests/unit/server/editor_layer_rows.test.ts`:
  - the rows listed;
  - the toolbar metric;
  - the "no frames" state;
  - hidden objects resolved from the patch log;
  - the scan-required job guard.
- [x] `tests/unit/server/editor_world_rules.test.ts`:
  - slug, placement and GLB lookup shared, with the headset fetches token-bearing;
  - the drawer layout and collapse wiring;
  - the desktop scanner entry;
  - the 4D manifest's token.
- [x] `tests/unit/server/editor_mat4.test.ts`: the merged helpers against three.js, and decompose against its two e897380 copies, bit for bit.
- [x] `tests/unit/server/editor_frame_predicate.test.ts`: one chip per scan row, across tier pairs.
- [x] `tests/unit/server/editor_job_results.test.ts`: the SenseNova summary (no server path) and the world GLB link.
- [x] `tests/unit/server/editor_splat_alignment.test.ts`: `resolveSplatAlignment` and `formatAlignmentStatus`.
- [x] `tests/mock-editor-inventory.spec.ts`: a fixture world through `page.route`. It checks:
  - the rows, with the camera rows' "no frames" despite a reported pose count, and the toolbar count;
  - one switch for the bounds;
  - Show's patch and its single token;
  - the world GLB link;
  - the SenseNova result, with no server path;
  - the queue guard;
  - the two "not known" panels;
  - one token on every server request.

  Run against a dev server from this branch: 4 passed.
- [x] A production `vite build`: the viewer chunk holds no `__measureTool`, `injectJob` or `__editorTest`, and the headset editor's chunk does not reference the emulator. The scanner (`src/main.ts`, not this ticket's) still loads it.
- [x] Updated:
  - `tests/unit/node/scan_calibration_chip.test.ts`: the frame warning rule, plus a cross-check with `frameChipFor`;
  - `tests/unit/server/frame_fit.test.ts`: frame-fit's two new browser-safe imports;
  - `tests/mock-xr-world.spec.ts`: re-run, 3 passed;
  - `tests/mock-rtc-*.spec.ts`: re-run, 6 skipped by name;
  - `tests/mock-ui-desktop.spec.ts`, `tests/e2e-suite.spec.ts`, `tests/mock-editor-homes.spec.ts`, `tests/mock-editor-quality.spec.ts`: edited, not run, because they need a seeded world or fixtures.

```
source ~/.nvm/nvm.sh && nvm use 22.23.2
export ONNXRUNTIME_NODE_INSTALL_CUDA=skip PATH="$HOME/.deno/bin:$PATH"
deno test --allow-read --allow-write --allow-env --allow-net --allow-run --allow-ffi tests/unit/server/editor_*.test.ts
npm run verify
```

## Acceptance Criteria

- [ ] Given a production build, when `viewer.html?mock=editor` loads, then `window.__measureTool` and `window.__quality` are undefined. When `xr-world.html?mock=webxr` loads, the emulator module is not requested.
- [ ] Given a shell page opened with `?token=T` and signed in with session S, when the editor loads a scan, then:
  - every fetch URL carries `token=T` once and no Authorization header from the editor;
  - every texture or download URL on `/scans` carries `token=S` once;
  - the world GLB link carries `token=T` once.
- [ ] Given a one-point scan in a two-point Place, when the scan list renders, then its row says "not in Place frame" and not "Different frame from this Place".
- [ ] Given a hidden object, when the person presses Show in the Edit tab's hidden list, then a `visible: true` patch is posted and the object returns after a reload.
- [ ] Given a scan whose frame set is missing or empty, then no camera path or frustums are drawn for it, and its Camera path row says "no frames".

## Risks / potential issues

- **Risk:** the specs that read the hooks now need `?mock=editor`. A spec that is not updated finds no hook. — **Mitigation:** every user of the two hooks is in an owned spec (`mock-editor-homes`, `mock-editor-quality`) and is updated here.
- **Risk:** a server that has not merged server-core's routes answers the COLMAP manifest with a non-JSON 404, so every session scan shows "not served" until it merges. — **Mitigation:** that is the true state. The line says the server does not serve the file, not that the scan is bad.
- **Risk:** on a shell, the session now rides in the query of `/scans` media URLs in place of the access token. — **Mitigation:** no `/scans` or `/sessions` route reads a world token today. If server-core makes one read it, the server must read every `token` value. Listed for server-core.
- **Risk:** `detections` hidden by default changes one field of every manifest the server writes. — **Mitigation:** reported. `layers.test.ts` keeps the manifest and the editor in step.
- **Risk:** the merged decompose must give the same numbers as both copies did, for the server's register proposal and for the editor's reset. — **Mitigation:** a test checks it against three.js and against the copies' recorded outputs.

## Subtasks

1. [x] Ticket (this file).
2. [x] F-06 hook gates.
3. [x] F-10 token helpers, and every request through them.
4. [x] F-41 shared world rules for both editors, and the merged matrix and frame-id helpers.
5. [x] F-19, F-21, F-41 visibility: layer rows, toolbar metric, no fake trail, one variable per visibility.
6. [x] F-20 hidden objects. F-24 queue guard. F-23 SenseNova and world GLB. F-22 artifact states.
7. [x] F-25 one frame predicate.
8. [x] F-42 investigation, then the fix or the note.
9. [x] Smaller items, specs, known-failures, UX_FLOW.md.
10. [ ] Tests, then `npm run verify`, then commit.
