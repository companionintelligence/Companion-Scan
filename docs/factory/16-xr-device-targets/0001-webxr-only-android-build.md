> **Type:** Infra
> **Wave:** 16-xr-device-targets
> **Branch:** `feat/xreal-aura-target`
> **Commit style:** `feat(webxr-build): summary`
> **Design:** this ticket is the spec; the build page is `docs/targets/android-webxr.md`
> **Dependencies:** None

## Goal

Devices that run Android apps without ARCore get a build of the Android app that cannot start a
runtime that cannot work there. The scanner runs WebXR alone: no ARCore session, and no 8th Wall
engine in the bundle. Mobile Build builds it. Each device has a page saying what is known about
it and what its first run must record: XREAL Aura, and PICO headsets.

## Non-goals

- Do not add Jetpack XR, the PICO Spatial SDK, OpenXR, or any device's library, permission or
  manifest entry. They belong to native runtimes (0003, 0005), and neither maker's documents give
  `uses-feature` names to declare.
- Do not change the Android project. Product flavors would rename `releaseRuntimeClasspath`,
  which `mobile/android/app/gradle.lockfile` locks, and with it the workflows and the notices.
- Do not change the default build, the 8th Wall build or the desktop build.
- Do not unlock the portrait orientation. It would need a Gradle switch kept in step with the web
  flag, and nothing yet says the portrait window is wrong on either device (0002, 0004).

## Pinned conventions

- **ADR 0001:** this reuses the build flag the 8th Wall variant introduced, `VITE_AR_RUNTIME`, and
  its option `--ar-runtime` (`scripts/native/build-web.mjs`). It gives them a second value,
  `webxr`, and adds no new variable. Searched first: `VITE_DISABLE_PWA`, `VITE_API_BASE` and
  `VITE_AR_RUNTIME`; only the last decides the AR runtime.
- **Named by runtime**, as `build:8thwall` is: `build:web:webxr` and `build:webxr` in `mobile/`,
  and the `android-webxr` job in Mobile Build. The devices it serves are named on its page.
- **The engine.** The bundle leaves the 8th Wall engine out the way the desktop bundle already
  does: the same `ENGINE_FILES`, the same notice switch, and the same `engineExpected` rule. One
  function answers which bundles carry it: `bundlesEngine` in the build script, `engineInBundle`
  in the app.
- **The runtime.** `pageForcedRuntime(url, build)` in `src/ar/runtime-select.ts` gives the
  address's `ar` value, else the build's. A build that forces `webxr` ignores the address, because
  it has no engine to switch to.
- **The page's loader.** `index.html` cannot read `import.meta.env`, so `vite.config.ts` writes
  `<meta name="scan-ar-runtime" content="…">` at the top of `<head>` whenever `VITE_AR_RUNTIME`
  is set, in builds and in the dev server.
- **Application id:** `com.companionintelligence.scan`, as for the other Android builds.

## Before implementation

- `scripts/native/build-web.mjs` and `addVendored` in `scripts/native/third-party-notices.mjs`.
- `src/ar/runtime-select.ts`, `src/ar/engine-state.ts`, `src/main.ts` section 3, `src/ui/legal-notices.ts`.
- `index.html`'s engine loader.
- `docs/targets/android-8thwall.md`: the variant this mirrors.

## Open questions & answers

- Q: A product flavor, a Gradle property, or a web-only variant? — A: web-only, like the 8th Wall
  APK. Two independent switches, a web flag and a Gradle property, could be built out of step, and
  the only Android-side change considered, the orientation, waits on the first runs. (Decided while
  building, 2026-11-24.)
- Q: Keep the engine in the bundle and only force WebXR? — A: no. Every start would request an
  engine that can never run there (its SLAM chunk alone is 5.5 MB), and the bundle would carry a
  proprietary engine it never uses. (2026-11-24)
- Q: Should a `?ar=8thwall` address still win in this build? — A: no. There is no engine to load,
  so `pageForcedRuntime` keeps WebXR, and the runtime switch is hidden. (2026-11-24)
- Q: Should the ARCore library come out of this build? — A: not here. That needs the Android
  project to differ. Meanwhile the ARCore disclosure stays in Legal notices, since the library is in
  the APK. (2026-11-24)
- Q: PICO needs the same thing: a second build, or this one? — A: this one. The build was first
  named for Aura and renamed by its runtime when the owner asked for PICO the same
  day; a second identical APK would be the duplication ADR 0001 rules out. Each device's reasons
  stay on its own page. (2026-11-24)

## Files impacted

- New:
  - `docs/targets/android-webxr.md`, `docs/targets/xreal-aura.md` and `docs/targets/pico.md`;
  - this wave's folder.
- Changed:
  - `scripts/native/build-web.mjs` and `scripts/native/third-party-notices.mjs`;
  - `src/ar/runtime-select.ts`, `src/ar/engine-state.ts`, `src/main.ts` and `src/ui/legal-notices.ts`;
  - `index.html` and `vite.config.ts`;
  - `mobile/package.json`, `mobile/README.md` and `.github/workflows/mobile-build.yml`;
  - `docs/targets/README.md`, `docs/targets/web-webxr.md` and `docs/factory/atlas.html`.
- Tests:
  - `tests/unit/node/native_ar_runtime_select.test.ts` and `native_build.test.ts`;
  - `desktop_engine_state.test.ts` and `wp-14-scanner-ui-runtime-switch.test.ts`;
  - `legal_notices.test.ts`, `third_party_notices.test.ts` and `wp-11-wmm-bundle-notice.test.ts`.

## Schema required

None.

## Definition of Done

- [x] `node scripts/native/build-web.mjs mobile --ar-runtime=webxr` builds a bundle with no `xr.js`,
  `xr-slam.js`, `xr-face.js` or `resources/`, and with no engine notice.
- [x] `npm run build:webxr` in `mobile/` builds that bundle and syncs it into the Android project,
  and `./gradlew assembleDebug` makes an APK from it.
- [x] Mobile Build has a job that builds the APK, fails if the bundle carries an engine file, and keeps the APK for 14 days.
- [x] In that build the scanner chooses WebXR alone, asks for no `xr.js`, and hides the runtime switch.
- [x] The build page, the two device pages, the targets matrix, this wave and the atlas say what the
  build is and what is not known.

## Tests

- [x] `pageForcedRuntime` and `buildForcedRuntime`: every pairing of address and build value.
- [x] `index.html`'s loader, run against stand-ins for every address, app and build, agrees with `engineExpected`.
- [x] `bundlesEngine` and `engineInBundle` agree for each shell and runtime.
- [x] `forbiddenInBundle` and `engineProblemsInBundle` for the `webxr` build.
- [x] `parseBuildArgs` accepts `--ar-runtime=webxr` for the mobile shell only; the scripts and the workflow job are pinned.
- [x] The notices for the `webxr` build name no engine and list the same Android libraries.
- [x] Legal notices for the `webxr` build: no engine section, with the ARCore one kept.
- [x] Each new test fails with the code it covers reverted.

```
node --experimental-strip-types --no-warnings --test tests/unit/node/native_ar_runtime_select.test.ts tests/unit/node/native_build.test.ts tests/unit/node/desktop_engine_state.test.ts tests/unit/node/wp-14-scanner-ui-runtime-switch.test.ts tests/unit/node/legal_notices.test.ts tests/unit/node/third_party_notices.test.ts
npm run verify
npm run build:webxr --prefix mobile && (cd mobile/android && ./gradlew assembleDebug)
```

## Acceptance Criteria

- [x] Served on its own in Chromium, the built bundle requests no `xr.js`. Its start screen reads
  "WebXR is not available here", and the runtime switch is hidden.
- [x] A dev server started with `VITE_AR_RUNTIME=webxr`, at `?mock=webxr` with no `ar=`, chooses
  WebXR under the emulator and requests no `xr.js`. No session was started.
- [ ] The Mobile Build job runs green on GitHub. It needs a pushed branch and a dispatch.
- [ ] The APK installs and starts on an Aura (0002) and on a PICO headset (0004).

## Risks / potential issues

- **Risk:** the APK installs and shows no capture, which reads as broken. — **Mitigation:** each
  device page leads with whether its WebView is known to have WebXR, and names the browser path to
  try instead.
- **Risk:** the meta tag and `import.meta.env` disagree, so the loader and `main.ts` decide
  differently. — **Mitigation:** both read the value Vite resolves (`config.env`). The loader test
  holds `index.html` to `engineExpected`.
- **Risk:** the build installed on a phone replaces the ARCore build, which shares its id. —
  **Mitigation:** the same is true of the 8th Wall build. The build page says so.

## Subtasks

1. [x] `buildForcedRuntime` takes `webxr`; add `pageForcedRuntime`, and read it in `src/main.ts`.
2. [x] Leave the engine and its notices out of the `webxr` build; add `bundlesEngine` and `engineInBundle`.
3. [x] The meta tag in `vite.config.ts`, read by `index.html`'s loader.
4. [x] `build:web:webxr` and `build:webxr` in `mobile/package.json`; the `android-webxr` job in Mobile Build.
5. [x] The tests above.
6. [x] The build page, the device pages, the matrix, this wave and the atlas.
