> **Type:** Backend / Refactor
> **Wave:** 14-inventory-fixes
> **Branch:** `inv-server-runners` (session 0002, server-runners)
> **Commit style:** `type(scope): summary`
> **Design:** this ticket is the spec. Findings are the inventory review of main @ e897380: F-26, F-29, F-43 and the reader findings FN-132 to FN-140, FN-150, FN-151, FN-187, FN-188.
> **Dependencies:** none to start. Two follow-ups need other sessions (see "Needs from other sessions").

## Goal

Make the runners and the capability report agree about every external tool. Make the off-box 4D
path able to produce a real sequence from what the appliance sends, and test it end to end. Fold
the runner helpers that were copied five times into one copy each.

## Non-goals

- Do not edit any file outside the server-runners row of the wave's session rules. In particular
  `server/main.ts`, `server/prompt.ts`, `server/memory_push.ts`, `server/inference.ts`,
  `.env.example`, `src/**`, `docs/**` outside `docs/pipelines/**`, `package.json`.
- Do not add a top-level `server/*.ts` file. Shared code goes into files this session owns
  (`server/exec_probe.ts`, `server/run_with_deadline.ts`, `server/pipeline.ts`).
- Do not delete files. The test-only stacks (FN-140) stay. They are listed for the owner.
- Do not change a default security posture: the 4d-capture service stays open when no token is
  set, and keeps binding every interface by default.
- Do not run 4DAnyone or a real Brush train. Nothing here can (no 44 GiB CUDA device), and stub
  mode stays the way to exercise the path.
- Do not add env vars that a runner does not already read, except where a new subsystem knob is
  unavoidable. Those are listed under Schema.

## Pinned conventions

- **ADR 0001 (reuse, don't duplicate).** This ticket extends, and adds nothing parallel:
  - the tool table and resolver already in `server/capabilities.ts` (`toolSpecs`, `resolveTool`)
    move into `server/exec_probe.ts`. That module already holds `isRunnable` and `whichPath`, the
    two primitives the resolver is made of. `capabilities.ts` re-exports and builds on them, and
    every runner resolves through the same function.
  - `budgetFromEnv`'s rule (`server/run_with_deadline.ts`) is the one integer rule:
    `Math.floor(Number(raw))`, kept when it is finite and at least 1, else the default. It is the
    rule `person_4d.ts` already had and tested. `intFromEnv` and `numFromEnv` sit beside it.
  - the Person4D submit payload (`buildSubmitRequest`, `Person4DClip`) is extended with optional
    fields. No new route, no new job type, no new manifest type.
  - the 4D clip contract between server-core and server-runners: the service fetches `clip.url`
    and `poseTrackUrl` with `Authorization: Bearer <FDANYONE_TOKEN>`, and checks the same token
    on its own routes.
- **Resolution order** (`docs/operations/PLATFORM_SUPPORT.md`): an explicit option or env var
  wins and is only probed, then `PATH`, then the documented fallback. An env var naming nothing
  is reported missing, never replaced by a fallback.
- **A missing tool is a skip:** `status: 'skipped'`, a `skippedReason` naming what was looked for,
  and a `remediation` taken from the same table the capability report prints. A tool that is
  present and fails is an `error`.
- **No axis flip** for Companion Scan poses: they are OpenGL camera-to-world, which is what
  Nerfstudio wants (`poseToMatrix` in `server/splat/splat_train_dataset.ts`). The subsystem keeps
  its own copy because it is outside both builds, and a parity test holds the two equal.
- **Comments cite symbols, not `file:line`.** Eight sessions are moving lines at once.

## Before implementation

- `server/capabilities.ts` (`toolSpecs`, `resolveTool`, `probeCapabilities`, `assessPipelines`)
  and `tests/unit/deno/capabilities.test.ts`.
- `server/exec_probe.ts`, `server/run_with_deadline.ts`.
- Every runner's resolution and skip path: `splat_train.ts`, `spirula_train.ts`,
  `colmap_poses.ts` (`locateColmapBin`), `lingbot_map.ts`, `splat_finish.ts`, `splat_detect.ts`,
  `panoptic_scan.ts`, `physag3d.ts`, `sensenova_vision.ts`.
- How `server/main.ts` turns each runner's skip into a job result (it is not this session's file,
  so every skip must fill the field the handler already prints).
- `subsystems/4d-capture/**`, `server/person4d/person_4d.ts`, `src/capture/pose-track.ts`
  (the pose-track file format), `server/http_range.ts` (the clip route's 8 MiB range contract).
- `tests/unit/node/wp-docs-config-honesty.test.ts`: every `budgetFromEnv` call under `server/`
  must have its default in `.env.example`, so this ticket adds none.

## Open questions & answers

- Q: Where does the shared resolver live, given no new top-level `server/*.ts`? — A:
  `server/exec_probe.ts`, beside `isRunnable` and `whichPath`. (session 0002, 2026-11-23)
- Q: Which integer rounding rule wins? — A: floor first, then at least 1, else the default.
  0.5 used to pass the `> 0` test and floor to 0 in three runners. COLMAP's `parseInt` accepted
  `12abc` as 12. Both now take the default. (session 0002, 2026-11-23)
- Q: `canonicalizeLabel` is private to `server/prompt.ts`, which this session must not edit. How
  does `thing_match.ts` use it? — A: through the exported `normalizeDetections`, which applies it.
  Exporting it is listed for server-core. (session 0002, 2026-11-23)
- Q: Things already stored under the old canon (tv as `monitor`, `office chair` as `office`)? —
  A: they still match. The old normaliser is kept as `legacyThingLabel`, used only to recognise a
  stored Thing, never to name a new one. (session 0002, 2026-11-23)
- Q: Which frame are pose-track poses in? — A: the device's own session frame. `pose-track.ts`
  samples `provider.getPose()` raw. A multi-camera take therefore needs each member's
  session-to-Place transform, which only `main.ts` has. The payload gains an optional per-clip
  `localToWorld`. A clip without one cannot join a multi-camera take, which then densifies the
  best clip and says why. (session 0002, 2026-11-23)
- Q: Where does the service get a clip's duration? — A: the pose track's `durationMs`, then
  ffprobe on the downloaded clip, then the submitted `durationMs`. `session.json` records none,
  so the path works without a server-core change. (session 0002, 2026-11-23)
- Q: Brush flags in the subsystem? — A: `brush-cli --help` on a local build lists
  `--total-train-iters`, not the `--total-steps` the subsystem passed. Aligned with
  `server/splat/splat_train.ts`'s `buildBrushArgs`. (session 0002, 2026-11-23)
- Q: Does `/health` on the 4d-capture service need the token? — A: yes, when one is set. Every
  route checks it, so there is one rule. (session 0002, 2026-11-23)
- Q: Default for `HIP_VISIBLE_DEVICES` in splat-detect? — A: no pin (`''` in the manifest), like
  `BRUSH_DEVICE`. The multi-GPU host it was written on must now set it. Listed for the owner.
  (session 0002, 2026-11-23)
- Q: Deno's node:fs `access()` asks for the uid, which `deno task test` does not grant. — A: the
  subsystem checks files with `stat` and mode bits (the appliance's `isRunnable` rule), so its
  code runs under the Deno test runner too. (session 0002, 2026-11-23)
- Q: Should an unmeasured default Ollama address count as found in the capability report? — A:
  no. It is found only once its health request answers; an operator's OLLAMA_HOST counts as
  configured. `?versions=0` makes no network call. (session 0002, 2026-11-23)
- Q: The test-only stacks (FN-140): `server/gis/place_index.ts`, and the joint COLMAP
  registration (`colmap_joint.ts`, `colmap_sessions.ts`, `register/pair_list.ts`,
  `register/session_priors.ts` apart from `keyedRecords`, `register/sim3_chain.ts`). — A:
  left in place. Wiring or deleting them is the owner's decision. (session 0002, 2026-11-23)

## Files impacted

Changed:
- `server/exec_probe.ts`: tool table, `locateTool`, `resolveHome`, `toolSkip`.
- `server/run_with_deadline.ts`: `intFromEnv`, `numFromEnv`, `isValidSessionDir`,
  `writeRunnerManifest`, `finishRun`, and an optional abort signal on `runWithDeadline`.
- New `server/splat/auto_poses.ts`: the pose-less auto-COLMAP block both trainers share.
- `server/lfm-driver-onnx.ts`: `onnxModelPaths`, so the report names the directory the driver opens.
- `server/migrations/migrate_jobs.ts`: a comment that claimed to mirror main.ts.
- `server/splat/splat_quality.ts`: the shared `numFromEnv`.
- `server/capabilities.ts`: built on the shared table; new rows `splat-finish-node`,
  `splat-transform-cli`, `sensenova-bash`, `sensenova-dir`, `sensenova-model`, `fdanyone-host`,
  `companion-memory`, `inference-engine`; new stages `splat-finish`, `sensenova-vision`,
  `person-4d-reconstruct`, `memory-push`, `capture-inference`; symbol citations instead of line
  numbers; the ingest stage no longer claims `/ingest-photos` needs ffmpeg.
- Runners: `server/splat/splat_train.ts`, `spirula_train.ts`, `splat_finish.ts`,
  `splat_detect.ts`, `splat_align.ts`, `server/colmap/colmap_poses.ts`,
  `server/lingbot-map/lingbot_map.ts`, `server/panoptic/panoptic_scan.ts`,
  `server/panoptic/panoptic_lift.ts`, `server/person4d/person_4d.ts`, `server/sensenova_vision.ts`,
  `server/pipeline.ts`, `server/thing_match.ts`, `server/capture/station_movement.ts`,
  `server/physag3d/physag3d.ts`.
- `subsystems/4d-capture/**`: `server/service.mjs` (factory, auth, bind address, take-id check,
  resubmit after error), `server/pipeline.mjs` (download, extract, pose sampling, intrinsics,
  frame naming), `stages/train.mjs`, `stages/frameset.mjs`, `stages/densify.mjs`, new
  `stages/fetch.mjs`, `stages/extract.mjs`, `stages/pose.mjs`, `stages/tools.mjs`, its tests and
  README.
- `docs/pipelines/4d-person.md`, `docs/pipelines/splat-train.md`, others where a sentence changed.

New tests: `tests/unit/deno/wp-runners-*.test.ts` and `subsystems/4d-capture/test/*.test.mjs`.

## Schema required

- `Person4DClip` (server/person4d/person_4d.ts) gains two optional fields, both sent in the
  submit payload as given and `null` when absent:
  - `durationMs?: number | null`, the clip's length in ms;
  - `localToWorld?: number[] | null`, the member scan's column-major session-to-Place matrix
    (`ScanManifest.localToWorld`), only for a member that is in the Place frame.
- 4d-capture service env (subsystem only, documented in its README):
  - `FDANYONE_TOKEN`: the shared secret, the same name the appliance uses. Unset leaves the routes
    open, as today.
  - `LISTEN_HOST`: bind address. Unset binds every interface, as today.
  - `FFMPEG_BIN`, `FFPROBE_BIN`: frame extraction tools, then PATH.
- `ToolCapability` (capabilities.ts) gains optional `reachable?: boolean` and `detail?: string`,
  filled only for the new `service` kind and only when probing with versions on.
- No manifest type changes. `SplatDetectManifest.params.hipVisibleDevices` stays a string; `''`
  means no pin.

## Definition of Done

- [x] Ticket written before code.
- [x] One resolver: every runner and `capabilities.ts` call `locateTool` with the same table.
- [x] Brush and Spirula found only on PATH train instead of skipping.
- [x] LingBot-Map's interpreter, splat-finish's node and SenseNova's bash, when missing, are
      skips with a remediation.
- [x] New probes in the capability report, with no network call when `versions=0`.
- [x] One copy each of `isValidSessionDir`, `intFromEnv`, `numFromEnv`, the manifest writer,
      the read-only Draco glTF IO, the auto-COLMAP block, and `sampleEvenly`.
- [x] `thing_match.ts` names Things with `server/prompt.ts`'s canon.
- [x] The 4D service downloads, extracts, poses and names a real sequence from the appliance's
      payload, checks the token, binds where told, and is tested end to end from Deno.
- [x] splat_detect's header and HIP default, panoptic_lift's justification, and the docs agree
      with the code.
- [x] `npm run verify` passes (2026-11-23, after the review fixes: Deno 2149 passed, 0 failed, 10 ignored; 93 node suites, 0 failed; the subsystem's own 53 tests pass with `npm test` there).

## Tests

- [x] `tests/unit/deno/wp-runners-tool-resolve.test.ts`: env, then PATH, then fallback; an env
      var naming nothing is missing; the report and a runner resolve the same path.
- [x] `tests/unit/deno/wp-runners-skips.test.ts`: Brush on PATH trains; a missing LingBot
      interpreter, splat-finish node and SenseNova bash each skip with a remediation and a
      manifest.
- [x] `tests/unit/deno/wp-runners-env.test.ts`: `intFromEnv` and `numFromEnv` edges.
- [x] `tests/unit/deno/wp-runners-thing-canon.test.ts`: prompt canon, the residual folds, and
      stored Things under the old canon.
- [x] `tests/unit/deno/wp-runners-4d-e2e.test.ts`: `runPerson4D` against the real service on an
      ephemeral port and a clip server built on `rangedResponse` that demands the token.
- [x] `tests/unit/deno/wp-runners-capabilities.test.ts`: the new rows and stages.
- [x] `subsystems/4d-capture/test/*.test.mjs`: fetch, extract, pose sampling, transforms,
      service auth.
- [x] Existing tests that pinned old behaviour are changed deliberately (COLMAP's bare `colmap`,
      `normalizeThingLabel('Television')`, splat-detect's HIP default).

```
deno task check
deno test --allow-read --allow-write --allow-env --allow-net --allow-run --allow-ffi tests/unit/deno/wp-runners-*.test.ts
(cd subsystems/4d-capture && node --test test/*.test.mjs)
npm run verify
```

## Acceptance Criteria

- [x] Given `brush-cli` only on PATH, when a splat-train job runs, then it trains, and
      `GET /capabilities` shows the same path with `via: 'path'`.
- [x] Given no `python3` on PATH and no `LINGBOT_MAP_PYTHON`, when lingbot-map-reconstruct runs,
      then the job completes as skipped and the session manifest says why.
- [x] Given a running 4d-capture service with `FDANYONE_TOKEN` set, when a request arrives
      without the token, then it gets 401.
- [x] Given a single-clip take and a stubbed 4DAnyone, ffmpeg and Brush, when it runs, then the
      sequence directory holds `frame-NNNNN.ply` files that `/sequence` lists and `/frames`
      serves, and the appliance lands them.

## Risks / potential issues

- **Risk:** the 4DAnyone output format (`cameras.json`) is unverified; the camera parser accepts
  three shapes and refuses anything else by name. — **Mitigation:** stated as unverified in the
  README's confidence table. A wrong guess errors; it does not train identity poses.
- **Risk:** a multi-clip take densifies until server-core sends `localToWorld`. —
  **Mitigation:** the result says why (`pathReason`), and the need is listed.
- **Risk:** splat-detect on the multi-GPU host now sees every GPU. — **Mitigation:** set
  `HIP_VISIBLE_DEVICES` there. Listed for the owner.
- **Risk:** the COLMAP runner now runs an absolute path from PATH instead of the bare name. —
  **Mitigation:** the same binary either way. The pinned test changes on purpose.
- **Risk:** other sessions edit the importers of these modules. — **Mitigation:** every
  exported name and signature stays, with re-exports where code moved.

## Subtasks

1. [x] Shared resolver and table in `exec_probe.ts`; `capabilities.ts` on top; new probes.
2. [x] Runner helpers in `run_with_deadline.ts`; runners on the resolver and helpers; uniform
       skips.
3. [x] Draco IO, auto-COLMAP block, `sampleEvenly`, thing canon.
4. [x] 4D: payload fields; subsystem fetch, extract, pose, intrinsics, naming, auth, bind; tests.
5. [x] splat_detect header and HIP, panoptic_lift justification.
6. [x] `docs/pipelines/*`, the subsystem README.
7. [x] `npm run verify`, commit, report.
