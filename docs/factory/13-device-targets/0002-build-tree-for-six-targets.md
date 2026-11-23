> **Type:** Infra
> **Wave:** 13-device-targets
> **Branch:** `build/build-tree`
> **Commit style:** `build(targets): summary`
> **Design:** this ticket is the spec (lanes described in this wave's README)
> **Dependencies:** 0005, 0007

## Goal

One command builds every device target from one pinned commit, and CI builds the two that need it (iOS, and the Quest app as a cross-check). Until this wave the targets were built by hand, from a script kept outside the repo.

## Non-goals

- Do not sign release builds or publish anything. Debug builds and the iOS Simulator app only.
- Do not upload to any store.
- Do not change the release workflow (`.github/workflows/native-release.yml`).

## Pinned conventions

- ADR 0001: reuse `scripts/native/build-web.mjs` for both shell bundles, and `.github/workflows/mobile-build.yml` for CI. Do not add a second web build or a second mobile workflow.
- Lanes:
  - **Lane A** runs `npm run build` (root, `dist/`) beside `./gradlew testDebugUnitTest assembleDebug` in `meta/`.
  - **Lane B** runs, one after another, the ARCore APK (no `VITE_AR_RUNTIME`) and the 8th Wall APK (`VITE_AR_RUNTIME=8thwall`).
  - **Lane C** runs `mobile-build.yml` on a pushed ref.
- Only one Gradle build runs at a time.
- After each `cap sync android`, remove `mobile/android/app/src/main/assets/public`. It holds a copy of the vendored engine, which the legal sweep would read (`tests/unit/node/engine_internals_quarantine.test.ts`).
- Artifact names carry the target and the short commit: `web-<sha>.tar.gz`, `apk-arcore-debug-<sha>.apk`, `apk-8thwall-debug-<sha>.apk`, `meta-quest-debug-<sha>.apk`. The iOS artifact keeps the CI name `scan-ios-simulator-app`.
- The environment needs `ONNXRUNTIME_NODE_INSTALL_CUDA=skip` for every `npm ci` and Deno task, JDK 21, and Android SDK platform 36.

## Before implementation

- Read `scripts/native/build-web.mjs`, `mobile/package.json` and `.github/workflows/mobile-build.yml`.
- Read the local build-tree script the coordinator used on 2026-11-23. It is outside the repo; the lanes in this wave's README are its content.

## Open questions & answers

- Q: Should CI build the Quest app? — A: Yes, as a separate job in `mobile-build.yml`. It needs no SDK beyond what the runner's Android SDK has. The Spatial SDK comes from Maven Central — OPEN until a CI run confirms it.
- Q: Where do local artifacts go? — A: A git-ignored folder under the repo, such as `build/targets/<date>-<sha>/` — OPEN.

## Files impacted

- New: `scripts/native/build-targets.mjs` (lanes A and B, plus the lane C dispatch).
- Changed: `package.json` (a `build:targets` script), `.github/workflows/mobile-build.yml` (a `quest` job), `.gitignore`.

## Schema required

None.

## Definition of Done

- [ ] `npm run build:targets` builds the web tarball and three APKs from a clean worktree and writes a status file.
- [ ] `mobile-build.yml` has a Quest job that uploads `meta-quest-debug-<sha>.apk`.
- [ ] A failing lane does not hide the others' results.

## Tests

- [ ] A node unit test checks the lane order and the artifact names (no build run).
- [ ] A dispatched `mobile-build.yml` run is green for all three jobs.

```bash
npm run build:targets
gh workflow run mobile-build.yml --ref <pushed-branch>
```

## Acceptance Criteria

- [ ] Given a clean worktree at one commit, when the tree runs, then every artifact name carries that commit.
- [ ] Given the 8th Wall APK and the ARCore APK, when their main JS chunks are compared, then they differ, because `VITE_AR_RUNTIME` reached the bundle.

## Risks / potential issues

- **Risk:** Two Vite builds in one worktree at once share caches. — **Mitigation:** Lane A pairs Vite with Gradle only; lane B runs after lane A.
- **Risk:** The Android lockfile check runs only on release classpaths. — **Mitigation:** Keep the existing lockfile step in `mobile-build.yml` first.
- **Risk:** The Spatial SDK's licence terms may restrict CI artifacts. — **Mitigation:** Keep retention short (14 days, as today), and review the terms (ADR 0013).

## Subtasks

1. [ ] Port the lanes to `scripts/native/build-targets.mjs`.
2. [ ] Add the `build:targets` script and the ignore rule.
3. [ ] Add the Quest job to `mobile-build.yml`.
4. [ ] Add the unit test for lane order and names.
5. [ ] Run locally, then dispatch CI on a pushed branch.
