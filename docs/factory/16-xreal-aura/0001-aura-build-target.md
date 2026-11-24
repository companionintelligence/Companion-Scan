> **Type:** Infra
> **Wave:** 16-xreal-aura
> **Branch:** `feat/xreal-aura-target`
> **Commit style:** `feat(aura): summary`
> **Design:** this ticket is the spec; the target page is `docs/targets/xreal-aura.md`
> **Dependencies:** None

## Goal

XREAL Aura gets a build of the Android app that installs and starts there, and that cannot start a
runtime that cannot work on Aura. The scanner runs WebXR alone: no ARCore session, and no 8th Wall
engine in the bundle. Mobile Build builds it, and the target page says what is known about the
device and what the first run must record.

## Non-goals

- Do not add Jetpack XR, OpenXR or any Android XR library, permission or manifest entry. They
  belong to a native runtime (0003), and the documents give no `uses-feature` names.
- Do not change the Android project. Product flavors would rename `releaseRuntimeClasspath`,
  which `mobile/android/app/gradle.lockfile` locks, and with it the workflows and the notices.
- Do not change the default build, the 8th Wall build or the desktop build.
- Do not unlock the portrait orientation. It would need a Gradle switch kept in step with the web
  flag, and nothing yet says the portrait panel is wrong (0002, check 2).

## Pinned conventions

- **ADR 0001:** this reuses the build flag the 8th Wall variant introduced, `VITE_AR_RUNTIME`, and
  its option `--ar-runtime` (`scripts/native/build-web.mjs`). It gives them a second value,
  `webxr`, and adds no new variable. Searched first: `VITE_DISABLE_PWA`, `VITE_API_BASE` and
  `VITE_AR_RUNTIME`; only the last decides the AR runtime.
- **The engine.** The bundle leaves the 8th Wall engine out the way the desktop bundle already
  does: the same `ENGINE_FILES`, the same notice switch, and the same `engineExpected` rule. One
  function answers which bundles carry it: `bundlesEngine` in the build script, `engineInBundle`
  in the app.
- **The runtime.** `pageForcedRuntime(url, build)` in `src/ar/runtime-select.ts` gives the
  address's `ar` value, else the build's. A build that forces `webxr` ignores the address,
  because it has no engine to switch to.
- **The page's loader.** `index.html` cannot read `import.meta.env`, so `vite.config.ts` writes
  `<meta name="scan-ar-runtime" content="…">` at the top of `<head>` whenever `VITE_AR_RUNTIME`
  is set, in builds and in the dev server.
- **Application id:** `com.companionintelligence.scan`, as for the other Android builds.

## Before implementation

- `scripts/native/build-web.mjs`, `scripts/native/third-party-notices.mjs` (`addVendored`), `src/ar/runtime-select.ts`,
  `src/ar/engine-state.ts`, `src/main.ts` section 3, `src/ui/legal-notices.ts`, and `index.html`'s engine loader.
- `docs/targets/android-8thwall.md`: the variant this mirrors.

## Open questions & answers

- Q: A product flavor, a Gradle property, or a web-only variant? — A: web-only, like the 8th Wall
  APK. Two independent switches, a web flag and a Gradle property, could be built out of step, and
  the only Android-side change considered, the orientation, waits on 0002. (Decided while building,
  2026-11-24.)
- Q: Keep the engine in the bundle and only force WebXR? — A: no. Every start would request an
  engine that can never run there (its SLAM chunk alone is 5.5 MB), and the bundle would carry a
  proprietary engine it never uses. (2026-11-24)
- Q: Should a `?ar=8thwall` address still win in this build? — A: no. There is no engine to load,
  so `pageForcedRuntime` keeps WebXR, and the runtime switch is hidden. (2026-11-24)
- Q: Should the ARCore library come out of this build? — A: not here. That needs the Android
  project to differ, so it is part of 0003. Meanwhile the ARCore disclosure stays in Legal
  notices, since the library is in the APK. (2026-11-24)

## Files impacted

- New: `docs/targets/xreal-aura.md`, and this wave's folder.
- Changed: `scripts/native/build-web.mjs`, `scripts/native/third-party-notices.mjs`, `src/ar/runtime-select.ts`,
  `src/ar/engine-state.ts`, `src/main.ts`, `src/ui/legal-notices.ts`, `index.html`, `vite.config.ts`, `mobile/package.json`,
  `.github/workflows/mobile-build.yml`, `docs/targets/README.md`, `docs/factory/atlas.html`.
- Tests: `tests/unit/node/native_ar_runtime_select.test.ts`, `native_build.test.ts`, `desktop_engine_state.test.ts`,
  `wp-14-scanner-ui-runtime-switch.test.ts`, `legal_notices.test.ts`, `third_party_notices.test.ts`.

## Schema required

None.

## Definition of Done

- [x] `node scripts/native/build-web.mjs mobile --ar-runtime=webxr` builds a bundle with no `xr.js`,
  `xr-slam.js`, `xr-face.js` or `resources/`, and with no engine notice.
- [x] `npm run build:aura` in `mobile/` builds that bundle and syncs it into the Android project, and
  `./gradlew assembleDebug` makes an APK from it.
- [x] Mobile Build has a job that builds the APK, fails if the bundle carries an engine file, and keeps the APK for 14 days.
- [x] In that build the scanner starts on WebXR alone, asks for no `xr.js`, and hides the runtime switch.
- [x] The target page, the targets matrix, this wave and the atlas say what the build is and what is not known.

## Tests

- [x] `pageForcedRuntime` and `buildForcedRuntime`: every pairing of address and build value.
- [x] `index.html`'s loader, run against stand-ins for every address, app and build, agrees with `engineExpected`.
- [x] `bundlesEngine` and `engineInBundle` agree for each shell and runtime.
- [x] `forbiddenInBundle` and `engineProblemsInBundle` for the `webxr` build.
- [x] `parseBuildArgs` accepts `--ar-runtime=webxr` for the mobile shell only; the scripts and the workflow job are pinned.
- [x] The notices for the `webxr` build name no engine and list the same Android libraries.
- [x] Legal notices for the `webxr` build: no engine section, with the ARCore one kept.

```
node --experimental-strip-types --no-warnings --test tests/unit/node/native_ar_runtime_select.test.ts tests/unit/node/native_build.test.ts tests/unit/node/desktop_engine_state.test.ts tests/unit/node/wp-14-scanner-ui-runtime-switch.test.ts tests/unit/node/legal_notices.test.ts tests/unit/node/third_party_notices.test.ts
npm run verify
npm run build:aura --prefix mobile && (cd mobile/android && ./gradlew assembleDebug)
```

## Acceptance Criteria

- [x] Served on its own in Chromium, the built bundle requests no `xr.js`. Its start screen reads
  "WebXR is not available here", and the runtime switch is hidden.
- [x] A dev server started with `VITE_AR_RUNTIME=webxr`, at `?mock=webxr` with no `ar=`, starts on
  WebXR under the emulator and requests no `xr.js`.
- [ ] The Mobile Build job runs green on GitHub. It needs a pushed branch and a dispatch.
- [ ] The APK installs and starts on an Aura (0002).

## Risks / potential issues

- **Risk:** the APK installs and shows no capture, which reads as broken. — **Mitigation:** the
  target page leads with that, and points to Chrome's `/webxr.html` as the capture path to try first.
- **Risk:** the meta tag and `import.meta.env` disagree, so the loader and `main.ts` decide
  differently. — **Mitigation:** both read the value Vite resolves (`config.env`). The loader test
  holds `index.html` to `engineExpected`.
- **Risk:** an Aura build installed on a phone replaces the ARCore build, which shares its id. —
  **Mitigation:** the same is true of the 8th Wall build. The target page says so.

## Subtasks

1. [x] `buildForcedRuntime` takes `webxr`; add `pageForcedRuntime`, and read it in `src/main.ts`.
2. [x] Leave the engine and its notices out of the `webxr` build; add `bundlesEngine` and `engineInBundle`.
3. [x] The meta tag in `vite.config.ts`, read by `index.html`'s loader.
4. [x] `build:web:aura` and `build:aura` in `mobile/package.json`; the `android-aura` job in Mobile Build.
5. [x] The tests above.
6. [x] The target page, the matrix, this wave and the atlas.
