> **Type:** Frontend
> **Wave:** 17-xr-device-targets
> **Branch:** `fix/aura-first-run-webxr-help`
> **Commit style:** `fix(webxr-build): summary`
> **Design:** this ticket is the spec
> **Dependencies:** 0001; found by 0002

## Goal

The WebXR-only Android build tells a reader what to do when its WebView has no WebXR. Before this
change it gave the ARCore build's advice. The first install on an XREAL Aura (0002, 2026-11-24) found
the puck's WebView without `navigator.xr`, and the start screen said "Live capture needs Google Play
Services for AR on this phone." That build never starts ARCore, and the Aura has no ARCore.

## Non-goals

- Do not change the Start button's headline, "WebXR is not available here": it is right.
- Do not change the advice of the ARCore build, the 8th Wall build, the iOS app, the desktop app or a browser.
- Do not build a link to the Scan server's address. The help line names the page, and its reader opens it on
  their own server.

## Pinned conventions

- `showArHelp()` in `src/main.ts` picks its advice by app shell (FN-009). It now also takes the
  build's forced runtime, `buildForcedRuntime(import.meta.env.VITE_AR_RUNTIME)`, which `main()`
  already holds as `buildRuntime`.
  - The Android app with `buildRuntime === 'webxr'` gets the new line.
  - Every other case keeps its line.
- The new line, "To capture, open your Scan server's /webxr.html page in the browser.", is 11 words,
  within `showArHelpWordsMax()` (12).
- `/webxr.html` is the capture path the device pages name first where the WebView has no WebXR
  (`docs/targets/xreal-aura.md`, `docs/targets/pico.md`).
- No schema, config variable or client↔server connection changes, so ADR 0001 has nothing to extend here.

## Before implementation

- `showArHelp()` and its one call on the no-runtime path in `src/main.ts`.
- `tests/unit/node/wp-14-scanner-ui-boot.test.ts` (FN-009, F-16).
- The source-shape tests that read the call: `desktop_engine_state.test.ts` and `wp-b-scanner-flow.test.ts`.

## Open questions & answers

- Q: Should the line carry the server's address? — A: No. In the shell, `location.origin` is
  `https://localhost`, which is no help to a reader. The server's address is the one they entered
  themselves, so naming the page is enough.

## Files impacted

Changed: `src/main.ts`, `tests/unit/node/wp-14-scanner-ui-boot.test.ts`,
`tests/unit/node/desktop_engine_state.test.ts`, `tests/unit/node/wp-b-scanner-flow.test.ts`,
`docs/targets/android-webxr.md`, this ticket, the wave README, `docs/factory/atlas.html`.

## Schema required

None.

## Definition of Done

- [x] The WebXR-only Android build's help line names `/webxr.html` in the browser, and not Play Services.
- [x] The ARCore and 8th Wall builds, the iOS and desktop apps and the browsers say what they said before.
- [x] The new line fits the start screen's word budget.

## Tests

- [x] `wp-14-scanner-ui-boot.test.ts`, "the Android app's WebXR-only build sends the reader to the browser, not to Google Play Services for AR".
  - It fails with the branch reverted.
  - The F-16 harness hands the block `buildRuntime`.
- [x] The two source-shape tests accept the call with the runtime and the new signature.
- [x] `npm run verify`.

## Acceptance Criteria

- [x] A WebXR-only build in a WebView without WebXR shows "WebXR is not available here" on the Start button, and the
  `/webxr.html` line under it.

## Risks / potential issues

- **Not yet seen on a device.** The puck left adb before a rebuilt APK could go on, so the next install should confirm
  the line.

## Subtasks

- [x] The branch in `showArHelp()`, and the argument at its call.
- [x] The tests.
- [x] The build page, the wave README and the atlas.
