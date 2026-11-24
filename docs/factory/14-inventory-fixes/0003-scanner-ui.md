> **Type:** Frontend
> **Wave:** 14-inventory-fixes
> **Branch:** session 0003's worktree branch (scanner-ui), cut from `refactor-base-e897380`
> **Commit style:** `fix(scanner): summary`, `test(scanner): summary`
> **Design:** this ticket is the spec. The findings are F-06, F-13 to F-18 and F-44 of the inventory at e897380, and the FN items listed below.
> **Dependencies:** None. capture-core (0004) owns `src/ar/**` (except `runtime-select.ts`), `src/capture/**`, `src/project/**` and `src/shared/**` (except `debug-flags.ts`), so this ticket reads those files and changes none of them.

## Goal

The scanner's own UI does what the inventory found it does not:

- detection pins show on every AR runtime;
- a phone app with no working runtime can still reach its Server row, Legal notices, sign-in return and help;
- an upload made offline in a phone or desktop app is kept and sent later;
- every dead end in the boot is reported on the screen the person is looking at.

It also removes the duplicates that F-44 names in the scanner UI.

## Non-goals

- Do not change the default web runtime (F-18). 8th Wall stays the default wherever xr.js loads.
- Do not edit the AR providers (`src/ar/eighthwall.ts`, `webxr.ts`, `native*.ts`), `src/capture/**`, `src/project/**`, `src/export/**` or `src/shared/**` other than `debug-flags.ts`. Their owners are other sessions.
- Do not queue the large XHR uploads (`/ingest-video`, `/ingest-photos`, person clips) anywhere. The service worker does not queue them either (`src/capture/clip-upload.ts`, "Why not the offline queue").
- Do not rename any store, key or cache in CLAUDE.md's "Do not rename" table. The page queue uses the service worker queue's database name and store unchanged.
- Do not delete files. Dead UI is listed under Risks instead.

## Pinned conventions

- **ADR 0001.** Nothing here adds a type, env var, job queue or connection:
  - The offline path for the apps reuses the service worker queue's contract (SM-056, `src/shared/offline-queue.ts`):
    - a queued write answers `202` with `X-Companion-Queued-Offline: 1` and `{ ok: false, queuedOffline: true, queueId, message }`;
    - `X-Companion-No-Queue: 1` keeps a write out.
    The callers that already read that contract work unchanged: `exportToGLB` reports `queued-offline`, and the scanner then says "Saved on this phone".
  - The records use the same database (`companion-scan-offline-queue`), the same store (`requests`), the same id format (`<ms>-<kind>-<random>`), the same kinds and the same bounds as `public/sw.js`. Only the place that runs the queue is new: the page, in a shell that has no worker.
  - The page notices use `public/sw.js`'s message types (`offline-queued`, `offline-flushed`, `offline-dropped`, `offline-gave-up`, `offline-rejected`, `offline-queue-failed`), and `src/pwa.ts`'s one handler shows both.
  - Places are read with `fetchPlaceList()` (`src/project/frame-sync.ts`), which already has the timeout and the queued-offline check. The picker's own `fetchProjects()` goes.
  - Colours come from `CV_PALETTE` (`src/shared/cv-palette.ts`), read-only. The scanner UI keeps an alias list (couch is sofa, monitor is tv) and no colour table of its own.
  - Take and client ids come from `newTakeId()` and `newClientId()` (`src/shared/take-id.ts`). They use `crypto.randomUUID()` only, so they are browser-safe in a secure context, and the person capture only runs in one.
- `?debug=` stays a comma-separated token list (`src/shared/debug-flags.ts`); `'geo'` joins the `DebugFlag` union.
- The status line is written only through `writeStatus()` (`src/ui/status-line.ts`).
- New unit tests are `tests/unit/node/wp-14-scanner-ui-*.test.ts`, so `npm run test:wave` (part of `npm run verify`) runs them without a `package.json` change.

## Before implementation

- `src/main.ts` whole, `src/ui/overlay.ts`, `src/ui/panel.ts`, `src/ui/history.ts`, `src/ui/status-line.ts`, `src/pwa.ts`, `public/sw.js`, `src/shared/offline-queue.ts`, `src/shared/shell-sign-in.ts` (the shell's fetch wrapper), `src/export/gltf.ts` (`uploadToServer`), `src/capture/keyframes.ts` (how a failed frame upload backs off).
- The source-shape tests that pin `main.ts`: `desktop_engine_state.test.ts`, `wp-b-scanner-flow.test.ts`, `wp-main4-*`, `wp-main5-*`, `wp-pre7-*`, `wp-15b-keyframe-controller.test.ts`, `wp-09b-wiring.test.ts` and `tests/support/startup-budget.ts` (`SHOW_AR_HELP_LINES`).

## Open questions & answers

- Q: F-15 asks for either an IndexedDB retry queue or at least a "not sent, will retry" state. Which one? — A: **The IndexedDB retry queue.** (Decided by session 0003, 2026-11-23.) The reasons:
  1. It is the only choice that keeps the scan. On a phone, the GLB of a failed upload exists only in memory (`triggerDownload` cannot save on mobile). A retry button re-exports whatever the page still holds, so an app that is closed while offline loses the scan. A queued request survives the app being closed and is sent when the app next starts.
  2. It needs no change to any caller. `exportToGLB`, the summary upload and the keyframe finalize already read SM-056. A shell queue that answers in that contract turns today's "Export failed — server rejected it" (which is false when offline) into the existing "Saved on this phone, syncs when you are back online", in code that capture-core owns and this ticket does not touch.
  3. It adds no second shape of queued record. The records are the service worker's, in the same database.

  It is narrower than the worker's queue, on purpose. It queues `POST /upload-scan`, `POST /upload-summary` and `POST /sessions/<id>/finalize` only. It does not queue:
  - `/projects`, because a shell cannot send the no-queue header (`noQueueHeaders()` needs a controlling worker), a Place create must be refused offline, and frames have their own pending store;
  - keyframe images and `POST /sessions`, because withdrawing consent drops queued frames only from the worker's queue (`dropQueuedKeyframes`), and the streamer already backs off;
  - `/process-scan`, because the person waits for its answer.
- Q: Should the pins be driven only from a `main.ts` loop, with the 8th Wall pipeline module removed? — A: No. The 8th Wall module stays, because it draws in step with the engine's render on the one path that works today. A `requestAnimationFrame` loop in `main.ts` runs for every runtime and ticks the pins whenever the pipeline has not ticked them in the last 100 ms. That covers WebXR, native ARKit and ARCore, and a native session that hands over to 8th Wall or WebXR.
- Q: FN-022 asks for the setup order to be fixed. Should the camera-frame auto-start and the probe log move before the calibration too? — A: Only the WebRTC broadcaster moves. It does not depend on the calibration. The other two stay after it, for documented reasons:
  - The auto-start must come after the calibration because the calibration can change the Place ("Wrong Place? Choose another"), and the default is on only for a Place scan. `wp-15b-keyframe-controller.test.ts` pins this.
  - The probe log is armed after the calibration so that a probe tap is never a point the frame was built from (`main.ts`, the `installProbeLog` comment).
  So FN-022 is partly fixed, and the camera-frame default during calibration is listed for the owner.
- Q: Gate `?mock=webxr`'s emulator in `main.ts` too? — A: Not in this ticket. The brief limits F-06 to `__playwright_hooks`. Listed as a follow-up.
- Q: capture-core (0004) added the one display table for labels, `labelDisplayRgb` / `labelDisplayCss` in `src/shared/cv-palette.ts` (their commit e6595cc), and `gltf.ts` uses it. Should the scanner UI call it? — A: Yes, once both branches are merged. This branch is cut from e897380, where those functions do not exist, so importing them would fail `npm run verify` here. So `src/ui/category-color.ts` matches labels by the same rule now: the first key a label contains, in the old tables' order, with couch, monitor and bookcase drawn as sofa, tv and shelf. Its colours come from `CV_PALETTE`. After the merge it returns `labelDisplayCss(label)`, and its key list goes. Until then, desk, door, window, wall, floor and ceiling are the default grey on screen, where the GLB gives them their old colours. (Session 0003, 2026-11-23, after a note from 0004.)
- Q: FN-009 asks for the motion-refusal line per shell. Which line does a browser get? — A: Safari's, as before, in every browser. Only WebKit on iOS and iPadOS asks for motion access at all, and iPadOS Safari reports a Mac user agent, so the user agent cannot pick the line. Only the iOS app gets its own line. The no-runtime advice is chosen by app first (desktop, iOS, Android) and by user agent only in a browser.
- Q: `tests/mock-ui-mobile.spec.ts` rewrites the screenshots in `docs/ui-flow/mobile/` when it runs. Should this branch commit them? — A: No. That folder belongs to docs-drift, and a local run also moves measurements in screens this ticket does not touch (fonts, browser build). The run's changes were restored. The help button now shows on the start screen, and the pins and panel take the palette's colours, so the screenshots should be regenerated once on the merged tree.

## Files impacted

- New: `src/ui/category-color.ts`, `src/ui/detection-edit-form.ts`, `src/ui/frame-loop.ts`, `src/ui/platform-advice.ts`, `src/ui/queue-notice.ts`, `src/page-upload-queue.ts`, tests `tests/unit/node/wp-14-scanner-ui-*.test.ts` (six files), `tests/mock-session-read-only.spec.ts`, `tests/mock-export-offline-shell.spec.ts`.
- Changed: `src/main.ts`, `src/ui/overlay.ts`, `src/ui/panel.ts`, `src/ui/history.ts`, `src/ui/status-line.ts` (comment), `src/pwa.ts`, `public/sw.js` (adds `kind` to `offline-queued`), `index.html`, `src/ar/runtime-select.ts`, `src/shared/debug-flags.ts`, `tests/ar-scan.spec.ts`, `tests/unit/node/desktop_engine_state.test.ts` (harness stubs for the shell checks `showArHelp` now makes).

## Schema required

None. The page queue writes the records `public/sw.js` writes: `{ id, url, method, headers, body, createdAt, attempts, lastError? }` in `companion-scan-offline-queue` / `requests`, version 1. The one difference is that `Authorization` is never stored, because the shell's fetch wrapper adds the current token when the request is sent again.

## Definition of Done

- [x] **F-13:** pins are positioned on WebXR and native sessions from a frame loop in `main.ts`. The 8th Wall pipeline module still drives them on 8th Wall.
- [x] **F-14 and FN-002:**
  - onboarding, the help button and the shell sign-in return are wired before the insecure-context and no-runtime returns;
  - `#help-btn` is above `#start-screen`.
- [x] **F-15 and FN-003:** a shell page queues the three writes above while offline and sends them when it can.
- [x] **F-16:** a failure of the fallback from 8th Wall to WebXR goes through the no-runtime path: the classified reason goes to `#ar-help` and the Start button, and `arRuntimeError` is set.
- [x] **F-17:** a read-only tab says why it refuses, on the start screen, at boot and on every refused tap.
- [x] **F-18 and FN-013:** the runtime switch keeps the page's other query parameters. The default runtime is unchanged.
- [x] **F-06 and FN-016:** `window.__playwright_hooks` is installed only in a dev build or under `?mock=`.
- [x] **F-44:**
  - the scanner UI has one colour lookup, built on `CV_PALETTE` and matched as capture-core's display table matches (the swap to `labelDisplayCss` once both are merged is in Open questions);
  - one detection edit form;
  - Places are read only through `fetchPlaceList()`.
- [x] **FN-007, FN-009, FN-010, FN-011, FN-012, FN-015, FN-017, FN-018, FN-019, FN-028, FN-054 and FN-108:** as listed under Subtasks. FN-022 is done in part, as above.

## Tests

- [x] `wp-14-scanner-ui-shared-ui.test.ts`:
  - every palette label gets its palette colour, aliases map, and a label no table knows gets the palette's default;
  - labels are matched by the old tables' rule, and text gets a lighter mix;
  - the edit form's save rule, its markup and its callbacks;
  - source shape: no colour table and no form markup are left in the three UI files.
- [x] `wp-14-scanner-ui-frame-loop.test.ts`:
  - the loop ticks once per frame, keeps going after a throw, and stops;
  - the pipeline grace rule;
  - `AROverlay.frame()` places a pin on a runtime with no pipeline module, and does nothing for an empty scan;
  - the loop is started once AR runs, for every runtime.
- [x] `wp-14-scanner-ui-page-queue.test.ts`:
  - a network failure or timeout on a queueable write answers the SM-056 202 and stores the request; a cancel is not queued;
  - an excluded path or a no-queue header is not stored;
  - `Authorization` is not stored;
  - a store that refuses answers 507;
  - a flush replays oldest first and deletes, keeps a retriable status, gives up after five attempts, stops a pass on a network error, and runs one pass at a time;
  - the count and age bounds;
  - the bounds, kinds, database and store equal `public/sw.js`'s literals.
- [x] `wp-14-scanner-ui-notices.test.ts`: the queued notice is worded per kind, only a scan touches the autosave line, a loss is sticky, and every write goes through `writeStatus` (FN-010, FN-011).
- [x] `wp-14-scanner-ui-runtime-switch.test.ts`: `runtimeSwitchHref` keeps the other parameters and sets or clears `ar` as webxr.html does. The default runtime is unchanged. `?debug=geo,pose` arms both (FN-007).
- [x] `wp-14-scanner-ui-boot.test.ts`, source shape plus harness runs of `main.ts`'s own text:
  - onboarding, help and sign-in come before the early returns, and the help button's z-index sits between the start screen and the overlay;
  - the 8th Wall-to-WebXR fallback, in four cases;
  - the read-only notice reaches the start screen;
  - advice and the motion line are chosen per shell, and `appShell()` reads each shell;
  - hooks are gated;
  - FN-012, FN-014, FN-015, FN-017, FN-019, FN-022 and FN-028.
- [x] `tests/mock-session-read-only.spec.ts`: a second tab shows the read-only notice on its start screen, at load and after a refused tap.
- [x] `tests/mock-export-offline-shell.spec.ts`: in a faked Capacitor shell with the worker blocked, an `/upload-scan` made offline gets the SM-056 202 and is stored in the real IndexedDB queue with no token, then is replayed and the queue empties once the page is back online (F-15). The real apps still need a device run.
- [x] Changed: `desktop_engine_state.test.ts`'s `showArHelp` harness passes `appShell`.

Run at the head of this branch against a local Deno API (`INFERENCE_MODE=mock`, data dirs in a scratch folder) and Vite on spare ports. The result was 72 passed across 18 spec files (2.3 min). `tests/ar-scan.spec.ts` was typechecked only: it runs in the webkit projects against live servers.

```bash
VITE_URL=https://localhost:<vite port> API_URL=http://localhost:<api port> npx playwright test --project=chromium-mock \
  mock-export-offline-shell mock-session-read-only mock-ftue mock-scanner-startup-budget mock-motion-permission mock-pin-edit \
  mock-xr8-scan mock-webxr-emulated mock-webxr-session-failure mock-export-outcome mock-session-reload mock-offline-queue \
  mock-start-tap-race mock-status-line mock-native-ar mock-ui-mobile mock-ui-keyboard mock-keyframe-consent --workers=2 --retries=0
```

The first run, before the last three source commits, was 71 passed across 17 files:

```bash
VITE_URL=https://localhost:<vite port> API_URL=http://localhost:<api port> npx playwright test --project=chromium-mock \
  mock-session-read-only mock-ftue mock-scanner-startup-budget mock-motion-permission mock-pin-edit mock-xr8-scan \
  mock-webxr-emulated mock-webxr-session-failure mock-export-outcome mock-session-reload mock-offline-queue \
  mock-start-tap-race mock-status-line mock-native-ar mock-ui-mobile mock-ui-keyboard mock-keyframe-consent --workers=2 --retries=0
```

```bash
source ~/.nvm/nvm.sh && nvm use 22.23.2
export ONNXRUNTIME_NODE_INSTALL_CUDA=skip PATH="$HOME/.deno/bin:$PATH"
node --experimental-strip-types --no-warnings --test tests/unit/node/wp-14-scanner-ui-*.test.ts
npm run verify
```

## Acceptance Criteria

- [ ] Given a WebXR or native session with a detection in view, when the scanner runs, then the pin is shown and follows the object (**needs a device run**).
- [ ] Given a phone app on a device with no AR runtime, when the person taps `?`, then onboarding opens with the Server row and Legal notices (**needs a device run**).
- [ ] Given a phone app offline, when a scan is exported, then the scanner says it is saved on the phone, and after reconnecting the scan reaches the server (**needs a device run**; the queue itself passes in Chromium with a faked shell, `tests/mock-export-offline-shell.spec.ts`).
- [x] Given an 8th Wall engine that loads but whose provider fails, and no WebXR, when the boot gives up, then `#ar-help` shows the reason and a confirm in an open Place picker reports "AR did not start". (Checked by a harness run of the fallback block: the reason reaches `showArHelp` and `arRuntimeError`, which arms the existing gate.)
- [x] Given a second scanner tab, then its start screen says the scanner is open in another tab. (`tests/mock-session-read-only.spec.ts`.)
- [x] Given `/?debug=pose&ar=webxr`, when the switch is followed back, then `debug=pose` survives. (`runtimeSwitchHref`, unit-tested. The link itself was not followed in a browser.)

## Risks / potential issues

- **Risk:** The page queue wraps `fetch` on top of the shell's token wrapper. **Mitigation:** It is installed only when `isNativeShell()` is true and the build has no service worker. It passes every other request through untouched, and it never stores `Authorization`.
- **Risk:** A request that reached the server but lost its answer is queued and sent again, so a scan can be duplicated. The worker has the same property. **Mitigation:** None beyond the worker's. Noted for the owner.
- **Risk:** `window.requestAnimationFrame` must keep firing during an immersive WebXR session. **Mitigation:** The WebXR provider already depends on that (Three's `setAnimationLoop` comment in `src/ar/webxr.ts`). **Needs a device run.**
- **Risk:** The motion-denial and no-runtime copy for the iOS and Android apps is new. **Mitigation:** Each line has at most 12 words, the budget `SHOW_AR_HELP_LINES` assumes. **Needs a device run** to confirm that the remedies are the right ones.
- **Dead UI, listed rather than deleted:** `#gimbal-link` (index.html) is hidden by markup and by a `!important` rule, and nothing unhides it.

## Subtasks

1. [x] Ticket.
2. [x] F-16 fallback guard, F-14 boot order and help z-index, FN-019 desktop line, F-17 read-only start-screen notice.
3. [x] F-13 frame loop and the overlay's provider tick; FN-018 comment; FN-010 overlay duplicates removed.
4. [x] F-44: colour lookup, shared edit form, `fetchPlaceList()`.
5. [x] F-15 page queue; FN-011 wording; FN-010 writers through `writeStatus`; `sw.js` sends `kind`.
6. [x] F-06 hooks; FN-007 `geo` flag; FN-009 per-shell advice; FN-012; FN-013; FN-015; FN-017; FN-022; FN-028 and FN-108.
7. [x] FN-054 `ar-scan.spec.ts`; the read-only spec; unit tests; `npm run verify` (passes at the head of this branch).
