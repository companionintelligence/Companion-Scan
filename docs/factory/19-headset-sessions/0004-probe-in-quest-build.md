> **Type:** Infra
> **Wave:** 19-headset-sessions
> **Branch:** `phase1/headsets`
> **Commit style:** `Quest Build: summary`
> **Design:** this ticket is the spec
> **Dependencies:** None

## Goal

Build and test the Android XR probe (`android-xr/`) in CI. It compiles eight of the Quest app's files from `meta/`, so
a change there can break it, and no workflow built it.

## Non-goals

- Do not dispatch any workflow, or add a push or pull-request trigger: every workflow here is started by hand.
- Do not change the probe or the Quest app.

## Pinned conventions

- The Quest app's job in `.github/workflows/quest-build.yml` is the model: pinned actions, `persist-credentials:
  false`, JDK 21, the runner's own SDK with `platforms;android-36` and `build-tools;35.0.0`, `--no-daemon`, and the
  APK kept for 14 days.
- `tests/unit/node/native_release.test.ts` holds every native suite to a workflow job.

## Before implementation

- `.github/workflows/quest-build.yml`, `android-xr/README.md`, `android-xr/quest-shared/build.gradle.kts`.

## Open questions & answers

- Q: A job of its own, or steps in the Quest app's job? — A: A job of its own, so one failing does not hide the other.

## Files impacted

- Changed: `.github/workflows/quest-build.yml`, `tests/unit/node/native_release.test.ts`, `android-xr/README.md`,
  `docs/targets/meta-quest.md`, `docs/targets/android-webxr.md` (its CI line was stale), and the count of shared
  files (eight, not seven) in those pages and wave 17's 0003.

## Schema required

None.

## Definition of Done

- [x] Quest Build has an `android-xr` job that runs `:probe:testDebugUnitTest` and `:probe:assembleDebug`, and keeps
  the APK.
- [x] `native_release.test.ts` fails if the job goes.

## Tests

- [x] `npm run test:native-release` and `npm run verify`.
- [x] The job's two commands, run here in `android-xr/`: 49 of 49 tests, and the APK.

## Acceptance Criteria

- [ ] Given a dispatch of Quest Build, then both jobs pass. Not run: the owner dispatches workflows.

## Risks / potential issues

- None beyond a second job's runner minutes when the workflow is dispatched.

## Subtasks

1. [x] The job and its test (commit 26ab478).
