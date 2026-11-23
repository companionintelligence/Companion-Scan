> **Type:** Infra
> **Wave:** 13-device-targets
> **Branch:** `build/android-8thwall-side-by-side`
> **Commit style:** `build(android): summary`
> **Design:** this ticket is the spec
> **Dependencies:** None

## Goal

The Android 8th Wall debug build installs beside the ARCore build on one phone, and `VITE_AR_RUNTIME` is documented. Until this wave both debug builds used applicationId `com.companionintelligence.scan`, so installing one replaced the other.

## Non-goals

- Do not change the release applicationId. `mobile/README.md` says it is permanent once on Google Play.
- Do not add product flavors that change the release dependency configuration, which `mobile/android/app/gradle.lockfile` locks.
- Do not add a second web build.

## Pinned conventions

- ADR 0001: `VITE_AR_RUNTIME` extends the repo's existing `VITE_` build-flag pattern (`VITE_DISABLE_PWA`, `VITE_API_BASE`, `VITE_ENABLE_WEBRTC_LIVE`, `VITE_ENABLE_PLACE_COMPOSER`). It is read once, in `src/main.ts` near line 899, through `buildForcedRuntime` (`src/ar/runtime-select.ts`). Its only meaningful value is `8thwall`.
- It is set in the process environment only. `scripts/native/build-web.mjs` refuses a `.env` file that sets a `VITE_` variable.
- The suffix is debug only: `applicationIdSuffix ".eighthwall"`, chosen by a Gradle property such as `-PscanRuntime=8thwall`, so the default debug and every release build are unchanged.

## Before implementation

- Read `mobile/android/app/build.gradle`, `mobile/android/variables.gradle`, `tests/unit/node/android_lockfile.test.ts` and the lockfile step in `.github/workflows/mobile-build.yml`.
- Read `server/origin.ts`. The shell's origin is `https://localhost` whatever the package name; confirm it does not depend on the applicationId.

## Open questions & answers

- Q: Does a second package name need its own sign-in return URL? — A: Yes, if it signs in. The shell scheme `com.companionintelligence.scan://auth` is fixed (`server/portal_auth.ts:391`). Ticket 0010 covers native sign-in.
- Q: Is the variant visible in the bundle? — A: Yes. On 2026-11-23 the 8th Wall bundle's main chunk was 3 bytes longer, and had one more `8thwall` string, than the ARCore bundle's.

## Files impacted

- Changed: `mobile/android/app/build.gradle`, `mobile/README.md`, `docs/targets/android-8thwall.md`.
- New: none.

## Schema required

None.

## Definition of Done

- [ ] `./gradlew assembleDebug -PscanRuntime=8thwall` produces a package named `com.companionintelligence.scan.eighthwall`.
- [ ] The default `assembleDebug` and the release builds are unchanged, and the lockfile check passes.
- [ ] `VITE_AR_RUNTIME` is documented in `mobile/README.md` and the target page.

## Tests

- [ ] `npm run test:android-lockfile` and `npm run test:native-ar` pass.
- [ ] `aapt dump badging` on both APKs shows two package names.

```bash
cd mobile/android && ./gradlew assembleDebug -PscanRuntime=8thwall --no-daemon
$ANDROID_HOME/build-tools/36.0.0/aapt dump badging app/build/outputs/apk/debug/app-debug.apk | head -1
npm run test:android-lockfile && npm run test:native-ar
```

## Acceptance Criteria

- [ ] Given both debug APKs, when both are installed on one phone, then both launch and keep separate data.

## Risks / potential issues

- **Risk:** The 8th Wall build reaches the same server with the same sign-in scheme. — **Mitigation:** Leave sign-in to ticket 0010, and say so in the doc.
- **Risk:** A suffix changes the files directory that the origin anchor file lives in. — **Mitigation:** None needed: separate data is the point.

## Subtasks

1. [ ] Add the property-driven debug suffix.
2. [ ] Build both APKs and check the package names.
3. [ ] Document the variable and the suffix.
