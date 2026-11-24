> **Type:** Backend
> **Wave:** 13-device-targets
> **Branch:** `dt/physag3d`
> **Commit style:** `feat(physag3d): summary`
> **Design:** this ticket is the spec; `docs/pipelines/physag3d.md` describes the job
> **Dependencies:** None

## Goal

Let the common server turn a Thing seen in a keyframe into a textured, physically interactive 3D asset, through PhysAg3D (MIT), as an optional WorldJob that the operator configures and a person requests. The owner asked for it on 2026-11-23.

## Non-goals

- Do not run PhysAg3D on the server box's GPU. It needs at least 28 GiB of free GPU memory on a Linux host with TRELLIS.2, DINOv3 and BiRefNet, and PhysAg3D delegates generation to that host itself.
- Do not enqueue the job automatically. It can run for hours and sends an image to an outside service.
- Do not add fields to `WorldDetection` or other schema types. Results live in the WorldJob record and its artifacts.
- Do not bundle, download or install PhysAg3D, its models, Blender or the Codex CLI.

## Pinned conventions

- ADR 0001: the job extends `WorldJob` (ADR 0003) as the type `thing-interactive-asset`. Nothing adds a parallel queue. The input reuses the session keyframe store.
- Optional tools report `skipped` with a hint when unconfigured, like `person-4d-reconstruct` and the splat tools.
- Configuration is environment only: `PHYSAG3D_DIR`, `PHYSAG3D_CONFIG`, `PHYSAG3D_PYTHON` (default `python3`) and `PHYSAG3D_RUNS_DIR` (default `scans/<scan>.interactive/`). Each one is documented in `.env.example`. The GLB size cap reuses `UPLOAD_MAX_SCAN_BYTES`.
- The outcome comes from `delivery.json`'s `status`, never from the exit code. `execute.py run` exits 0 whatever its worker did.

## Before implementation

- Read PhysAg3D's README and `execute.py` for the interface: `verify`, `doctor`, `prepare`, `plan`, `run`, and the `delivery.json` contract.
- Read `server/person4d/person_4d.ts` and the splat drivers for the skipped-with-hint and spawn-seam patterns.

## Open questions & answers

- Q: Does a run hold the single job slot? — A: Yes, for hours, so every other job waits, including each upload's `optimize-scan`. OPEN: a delegated job that releases the slot while it waits is a follow-up decision for the owner.
- Q: Who can the worker reach? — A: It runs a shell as the server's user. The controller should run as a separate unprivileged user or on another host. The server does not enforce this. OPEN for the owner.
- Q: Does a case's copy of the keyframe outlive the session's deletion or the keyframe purge? — A: It did in the first commit. The fix is on `dt/physag3d`; see the branch's report.
- Q: Does Codex confine what the worker reads? — OPEN, unverified.

## Files impacted

New: `server/physag3d/physag3d.ts`, `server/physag3d/asset_files.ts`, `tests/unit/server/physag3d.test.ts`, `docs/pipelines/physag3d.md`.
Changed: `src/world/types.ts`, `server/main.ts`, `server/capabilities.ts`, `server/scan_deletion.ts`, `server/wp-a-keyframes.ts`, `server/run_with_deadline.ts`, `.env.example`, `docs/operations/PRIVACY.md`, and three Deno test files.

## Schema required

`WorldJobType` gains `'thing-interactive-asset'`. The payload is `{ keyframe: { sessionId, index }, thingId? }`. No other schema change.

## Definition of Done

- [ ] An unconfigured server reports `skipped` with a hint.
- [ ] The prepare, plan and run commands, each with its deadline, are tested through the spawn seam.
- [ ] `delivery.json` paths cannot leave the case folder.
- [ ] A session's deletion and the keyframe purge leave no copy of its frames in case folders.
- [ ] `PRIVACY.md` says what leaves the box when the job is configured.
- [ ] One real PhysAg3D run on an operator's setup is recorded.

## Tests

- [ ] `tests/unit/server/physag3d.test.ts`
- [ ] `tests/unit/server/scan_deletion.test.ts`
- [ ] `tests/unit/server/keyframe_routes.test.ts`

```
deno task check
deno task test
npm run verify
```

## Acceptance Criteria

- [ ] Given no `PHYSAG3D_*` configuration, when the job is requested, then it completes as skipped with a hint and nothing is spawned.
- [ ] Given a configured install, when a job is requested for a keyframe, then the refined GLB and the delivery report land as the job's artifacts.

## Risks / potential issues

- **Risk:** hours of slot holding stall every other job. — **Mitigation:** opt-in, one at a time, and a follow-up decision on a slot-releasing delegate.
- **Risk:** a shell running as the server's user. — **Mitigation:** documented; run the controller as another user or on another host.
- **Risk:** the server's deadline kills `execute.py`, but the worker can outlive it. — **Mitigation:** documented; the operator stops the worker.
- **Risk:** licences. PhysAg3D is MIT. DINOv3 carries its own restrictive licence. The agent uses the operator's own Codex and ChatGPT terms. — **Mitigation:** the server bundles none of it.

## Subtasks

1. [ ] Driver, wiring and tests.
2. [ ] The retention fix and the `PRIVACY.md` update.
3. [ ] A recorded real run on an operator's setup.
