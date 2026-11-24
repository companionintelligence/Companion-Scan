> **Type:** Frontend
> **Wave:** 13-device-targets
> **Branch:** `feat/quest-browser-webxr-modules`
> **Commit style:** `feat(webxr): summary`
> **Design:** this ticket is the spec
> **Dependencies:** None

## Goal

The WebXR scanner uses the modules Meta documents for Quest Browser, and starts on a Quest when hit testing is refused. Until this wave the session required `hit-test` and asked for `dom-overlay`, `local-floor` and `anchors` (`src/ar/webxr.ts:166-174`), whatever the browser.

## Non-goals

- Do not read passthrough pixels. Meta's mixed-reality page says a page cannot.
- Do not change the 8th Wall or native runtimes.
- Do not raise the app's persistent-anchor cap above what is verified on a headset.

## Pinned conventions

- ADR 0001: this extends the existing session request in `src/ar/webxr.ts` and the anchors code in `src/ar/anchors.ts` (`ANCHORS_FEATURE = 'anchors'`, line 139). No new provider, type or config variable.
- These are the "Meta extensions": the modules Meta's mixed-reality page for Quest Browser names, read on 2026-11-23.
  - AR (passthrough through `immersive-ar`).
  - Plane Detection (`plane-detection`). Planes are horizontal or vertical rectangles. Wait 2 to 3 s after session creation before reading `detectedPlanes`.
  - Anchors, with `requestPersistentHandle` and `restorePersistentAnchor`, at 8 persistent anchors per site.
- The app's own cap is `MAX_PERSISTENT_ANCHORS` = 5 (`docs/operations/AR_DEVICE_SUPPORT.md:289`). Keep it.
- `plane-detection` is added as an optional feature, never a required one.

## Before implementation

- Read `src/ar/webxr.ts` (session request and fallbacks), `src/ar/anchors.ts`, `src/test/webxr-emulation.ts`, `tests/mock-webxr-emulated.spec.ts` and `tests/mock-webxr-session-failure.spec.ts`.
- Read the Quest Browser rows of `docs/operations/AR_DEVICE_SUPPORT.md` (around lines 199-220). The doc says no row is verified.

## Open questions & answers

- Q: Does Quest Browser grant `hit-test`? — OPEN. Meta's page does not list it. Until a headset answers, a Quest session must start without it, falling back to planes.
- Q: Does the iwer emulator implement `plane-detection`? — OPEN. Check `src/test/webxr-emulation.ts` and the iwer version in `package.json`.
- Q: Which Quest models does the page cover? — A: It names Quest 2 and Quest Pro. Quest 3 is not stated (read 2026-11-23).

## Files impacted

- Changed: `src/ar/webxr.ts`, possibly `src/ar/anchors.ts`, `tests/mock-webxr-emulated.spec.ts`.
- New: a unit test for the feature list, under `tests/unit/node/`.

## Schema required

None.

## Definition of Done

- [ ] The session asks for `plane-detection` as optional.
- [ ] A session refused with `hit-test` required is retried with `hit-test` optional, and the scanner samples planes instead.
- [ ] The status line says which hit source is live.

## Tests

- [ ] A unit test pins the required and optional feature lists.
- [ ] A Playwright test on the iwer Quest 3 emulator starts a session without `hit-test`.
- [ ] `npm run verify` passes.

```bash
node --experimental-strip-types --no-warnings --test tests/unit/node/<new>.test.ts
npx playwright test --project=chromium-mock tests/mock-webxr-emulated.spec.ts
npm run verify
```

## Acceptance Criteria

- [ ] Given a browser that refuses `hit-test`, when Start AR is tapped, then a session starts and points come from planes.
- [ ] Given Android Chrome with ARCore, then nothing changes: `hit-test` is still used.

## Risks / potential issues

- **Risk:** A retry after a refused session can leave the page without the user gesture a second `requestSession` needs. — **Mitigation:** Request with `hit-test` optional from the start on Quest Browser (user-agent check), and test both paths.
- **Risk:** Plane rectangles are coarse, so point density drops. — **Mitigation:** Say so in the status line, and record point counts in the first headset run.
- **Risk:** None of this is verified on a headset. — **Mitigation:** Run the Quest rows of the device checklist before calling it done.

## Subtasks

1. [ ] Read the session request and the emulator.
2. [ ] Add `plane-detection` (optional) and the hit-source fallback.
3. [ ] Add the unit test and the emulator test.
4. [ ] Update `docs/targets/web-webxr.md` and `docs/operations/AR_DEVICE_SUPPORT.md`.
5. [ ] Record the first headset run.
