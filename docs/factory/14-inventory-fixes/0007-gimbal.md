> **Type:** Fix / Security / Docs
> **Wave:** 14-inventory-fixes
> **Branch:** `inv-gimbal` (the brief's name; the session works on a local branch of its own)
> **Commit style:** `fix(gimbal): summary`
> **Design:** this ticket is the spec
> **Dependencies:** None. Reads, never edits, `src/capture/phone-telemetry-sender.ts` (capture-core) and `.github/workflows/**` (native-apps).

## Goal

Make the gimbal subsystem do what its page, CLI, MCP tools and docs say it does. Inventory findings F-50 and FN-178 to FN-194 cover the Capture choice, Stop, parked controls, arc guards, page state, CLI defaults, docs and duplicates. Close F-12 for the gimbal backend with an optional token, an origin allowlist and a bind-address setting. Today's documented rig setup keeps working by default.

## Non-goals

- Do not edit `src/capture/**`. The phone-telemetry sender belongs to capture-core; this ticket only records what the relay expects.
- Do not edit `.github/workflows/**`, root `package.json`, `package-lock.json` or `.env.example`. List what they need.
- Do not switch the Gimbal control page from explicit pan columns to a centre/span plan. That changes what a page run does on the rig (a reach probe at every station), so it is an owner decision.
- Do not change `planDomePans`'s own default step. A dome fixture in `protocol/dome.test.mjs` encodes the 15° plan that was actually run.
- Do not put the move-to arc guard inside `moveToClosedLoop`. The arc probe and the grid call it directly, and the probe has to drive past the believed arc to find the stops.
- Do not delete files. Dead routes or code are listed as deletion candidates.
- Do not touch the 4D service (`subsystems/4d-capture/**`; server-runners).

## Pinned conventions

- **ADR 0001, reuse and don't duplicate.** This ticket adds three settings and changes one client-to-backend connection, so it states what it reuses:
  - **Token:** one name, `OSMO_BACKEND_TOKEN`, read by the backend and sent by every client (CLI, MCP server, page). It joins the existing `OSMO_BACKEND_URL` client setting. The backend does not reuse `OSMO_MCP_TOKEN`: that guards a different listener (the MCP HTTP transport). The comparison reuses the length-check-then-`timingSafeEqual` pattern in `server/mcp-server.mjs`.
  - **Origins:** `BACKEND_ALLOWED_ORIGINS`, in the existing `BACKEND_*` family (`BACKEND_PORT`, `BACKEND_TEST_ROUTES`, `BACKEND_NO_LISTEN`). I searched for a setting to reuse. `ALLOWED_ORIGIN_PREFIX` (server/main.ts) is the main app's prefix for its own tailnet origin, a different listener with prefix semantics, so it is not reused. The matching rules follow `server/origin.ts` as a parallel implementation: whole origins only, never `startsWith`, never the literal `null`.
  - **Bind:** `BACKEND_HOST` for the backend, in the same family. The page server gets `WEB_HOST`, because its port setting is the generic `PORT` and a bare `HOST` is often set by shells to the machine name.
- **Defaults keep today's reachability:**
  - Bind all interfaces.
  - No token.
  - Origins: the control page's own origin, meaning the host the browser used to reach the backend, or a loopback name, on the page server's port 8787. `BACKEND_ALLOWED_ORIGINS=*` restores today's open CORS.
  - Requests with no `Origin` header (CLI, MCP, curl) are never refused for their origin.
- **One wrap function:** `wrapDeg` in `protocol/stall.mjs`, rewritten in the modulo form (constant time, returns `NaN` for non-finite input). `JSON.parse('1e999')` is `Infinity`, and the old loop never returned on it.
- **One grid order:** `planGrid` moves to `protocol/dome.mjs`, and `server/android-capture.mjs` re-exports it.
- **One arc for every guard:** the backend's `currentArc()`. The page reads it from `status.panArc`, and the MCP tools read it from `GET /api/status`.
- **Wire shapes are additive only:**
  - `GET /api/status` gains `testRoutes`.
  - The phone-telemetry relay keeps every key, with location nulled (see "Open questions").
  - No route changes its path.
- **Privacy:** no host names, addresses or personal names. The tailnet name in files this ticket owns becomes `<tailnet>` or `example`.

## Before implementation

- Read `subsystems/osmo-ble/server/backend.mjs`: the routes, `sendJson`, the OPTIONS handler, grid-capture's NDJSON `writeHead`, the WS server, `gridCancelRequested`, `runArcProbe` and `statusPayload`.
- Read `subsystems/osmo-ble/web/backend-client.mjs`, `web/app.mjs`, `web/ui.mjs` and `web/index.html`.
- Read `subsystems/osmo-ble/server/cli.mjs` (the grid request body is built about line 452) and `server/mcp-server.mjs`.
- Read `subsystems/osmo-ble/protocol/dome.mjs`, `stall.mjs` and `motion_gate.mjs`.
- Read the existing backend tests (`server/wp-f*.test.mjs`) for the test seam: `BACKEND_NO_LISTEN`, the fake request and response, and `setScanStateForTest`.

## Open questions & answers

- Q: Does the CLI's per-station reach probe run today? — A: No. `cli.mjs` always posts `pans`, so the backend takes the explicit-list branch and `probeArc` defaults to off. `--no-probe-arc` is therefore a no-op, and the help's "does it per station already" is false. Fix: without `--pans`, the CLI posts `panCenterDeg`, `panSpanDeg` and `panStepDeg`, which is what its own comment and the README describe. **Needs a rig run.** (decided by session 0007, 2026-11-23)
- Q: Should the page send centre/span too, so page runs probe at every station? — A: Not in this ticket. The page keeps its explicit list. It builds the columns along the backend's current arc, checks them against that arc, and shows the backend's remediation on a refusal. Switching is listed for the owner. (session 0007, 2026-11-23)
- Q: Default pan step? — A: The CLI default becomes 25°, so the default plan is 7 columns × 2 rows, matching the page's Dome preset and `plan_scan_grid`. 25° clears the scanner's 20° keyframe threshold. `planDomePans`'s own default stays 15° (see Non-goals). (session 0007, 2026-11-23)
- Q: Where does the move-to guard go, and in what order? — A: In the `POST /api/move-to` route. Order: link check, read the body, scan and outside-motion check (409), then target check (400). A running scan still answers 409 whatever the target. The target check refuses a non-finite yaw or pitch, a pan outside `currentArc()` (it says whether that arc was measured or is the fallback, and points at arc-probe) and a tilt outside the grid's own -45°..+16°. (session 0007, 2026-11-23)
- Q: `gimbal_recenter` drives to pan 0, which is in the fallback dead zone. Refuse it, or retarget it? — A: Retarget it to the centre of the arc in use, `status.panArc.centerDeg`, tilt 0. **Owner decision:** the alternative is a refusal plus an override flag. (session 0007, 2026-11-23)
- Q: What does Stop do? — A: The page's Stop, `cli.mjs stop`, the MCP `stop_grid_capture` tool and the CLI's Ctrl-C during `grid` all call `POST /api/grid-stop`. On the first Ctrl-C the CLI posts grid-stop and keeps reading until `done`, so `manifest.json` is finalised. A second Ctrl-C exits. (session 0007, 2026-11-23)
- Q: The latent bug Stop exposes. — A: `gridCancelRequested` was set by grid-stop and cleared only when the next grid started. So after any stopped run, a standalone arc probe returned "stopped by request" at zero moves, and the jam message tells the operator to run exactly that. It is now cleared in the run's `finally`. Covered by a test. (session 0007, 2026-11-23)
- Q: What does a parked run unlock on the page? — A: Exactly what the backend allows while parked: the joystick, Center, the orientation and stick buttons, raw send and the test matrix. Photo and Photo ×2 stay locked for the whole run. A camera-mode run holds the phone's only MCP session, including while parked. Run stays locked, and Stop is live. (session 0007, 2026-11-23)
- Q: Phone telemetry carries lat, lng and altitude, which the relay re-broadcasts to every client and returns from `GET /api/status`. Nothing reads them: the page shows heading, pitch, roll, the label and the age. — A: The relay nulls `lat`, `lng`, `accuracyM` and `altitudeM` before caching and broadcasting. Every key stays, so `isPhoneTelemetry` still passes. **Owner decision:** relaying location is a one-line change if a consumer appears. (session 0007, 2026-11-23)
- Q: Origin default and DNS rebinding. — A: The default (same host as the request's `Host`, or loopback, on port 8787) blocks drive-by requests from other sites. It does not stop a rebinding attack that serves its page on port 8787. `OSMO_BACKEND_TOKEN`, an explicit `BACKEND_ALLOWED_ORIGINS`, or `BACKEND_HOST=127.0.0.1` closes that. **Owner decision:** whether to require one of them. (session 0007, 2026-11-23)
- Q: CORS preflight for a refused origin? — A: Answered permissively (204, origin reflected). CORS is not the gate here: every non-OPTIONS request is checked server-side before its handler runs. Reflecting the origin lets a misconfigured page read the 403's remediation instead of a bare network error. (session 0007, 2026-11-23)

## Files impacted

- **New:**
  - `subsystems/osmo-ble/server/access.mjs`: pure access rules (settings parsing, origin and token decision, CORS headers, the page server's file rule). It sits in `server/`, not `protocol/`, because it uses `node:crypto`'s `timingSafeEqual`, and `protocol/` must run in the browser.
  - `subsystems/osmo-ble/web/page-state.mjs`: pure page rules (which controls are live, the status dot, the progress bar, the grid request body).
  - `subsystems/osmo-ble/web/controls.mjs`: the helpers the Direct and Server clients shared by copy.
  - `subsystems/osmo-ble/server/backend-access.test.mjs`, `server/backend-guards.test.mjs`, `server/access.test.mjs` and `server/mcp-server.test.mjs`.
  - `tests/unit/node/gimbal_page_state.test.ts`, `tests/unit/node/gimbal_cli.test.ts` and `tests/unit/node/gimbal_page_wiring.test.ts`.
- **Changed:**
  - In `subsystems/osmo-ble/`: `server/backend.mjs`, `server/cli.mjs`, `server/mcp-server.mjs`, `server/android-capture.mjs`, `web/backend-client.mjs`, `web/app.mjs`, `web/ui.mjs`, `web/index.html`, `web/orientation.mjs`, `web/server.mjs`, `web/sw.js`, `protocol/stall.mjs`, `protocol/dome.mjs`, `protocol/dome.test.mjs`, `protocol/commands.mjs`, `protocol/constants.mjs`, `protocol/phone_telemetry.mjs`, `protocol/device_registry.test.mjs`, `package.json` (its own `test:protocol`) and `README.md`.
  - `docs/operations/GIMBAL_INTEGRATION.md` and `tests/unit/node/gimbal_stall.test.ts`.

## Schema required

None in `src/world/types.ts` or any persisted format. Wire additions, all optional to read:

- `GET /api/status` → `testRoutes: boolean`.
- `phone-telemetry` frames relayed by the backend → `lat`, `lng`, `accuracyM` and `altitudeM` always `null`.
- `POST /api/grid-capture` from the CLI → `panCenterDeg`, `panSpanDeg` and `panStepDeg` instead of `pans` when `--pans` is absent. This body shape is already in the API.

## Definition of Done

- [x] The page sends `capturePhotos: false` for Scanner app. Both orientations is disabled in that mode, and the scanner-mode rows show no photo link.
- [x] Stop on the page, `stop` in the CLI, `stop_grid_capture` in MCP, and Ctrl-C in `cli.mjs grid` all reach `POST /api/grid-stop`.
- [x] A parked run re-enables exactly the manual controls the backend allows.
- [x] `POST /api/move-to` refuses targets outside the arc in use. The MCP sweep steps along the arc, recenter goes to the arc's centre, and the yaw schemas cover ±180.
- [x] The page plans and checks pans against the backend's arc, from `status.panArc`.
- [x] The progress bar moves on every position, controls never re-enable blindly, Run unlocks on one tier, and the Server dot is green while telemetry streams.
- [x] The test matrix says when the backend's test routes are off.
- [x] The CLI's default pan step is 25°, and `--no-probe-arc` and `stop` are in its help.
- [x] GIMBAL_INTEGRATION.md, the README and the header comments match the code.
- [x] `wrapDeg`, the Direct and Server client helpers and the grid order exist once.
- [x] The backend has `OSMO_BACKEND_TOKEN`, `BACKEND_ALLOWED_ORIGINS` and `BACKEND_HOST`, enforced on HTTP and on the `/ws` upgrade. `web/server.mjs` serves only `web/` and `protocol/`, has a correct path check and has `WEB_HOST`.
- [x] `gridCancelRequested` no longer outlives the run that set it.

## Tests

- [x] `server/access.test.mjs` covers settings parsing, the origin decision (default, explicit, `*`, `null`, lookalike hosts, no Origin), the token decision (Bearer, query, wrong length) and the CORS headers.
- [x] `server/backend-access.test.mjs` runs through the real handler. It covers a refused origin (403, no frame sent), the token (401 / 200), preflight, no-Origin requests, the `/ws` upgrade refusal, and the relay nulling location.
- [x] `server/backend-guards.test.mjs` covers move-to refused outside the arc (the measured and the fallback arc), non-finite targets, the order (409 before 400), the cancel flag cleared after a stop, and `testRoutes` on status.
- [x] `protocol/dome.test.mjs` (gated): `planGrid` order, the pan columns along the arc, the sweep plan, the move-target check, and the tilt limits.
- [x] `tests/unit/node/gimbal_stall.test.ts` (gated): `wrapDeg` at ±180, large inputs and non-finite input.
- [x] `tests/unit/node/gimbal_page_state.test.ts` covers:
  - control states: sweeping, parked, linked-only, test routes off;
  - the status dot, the progress bar and the grid request body;
  - presets: their old column counts, and inward rounding.

  The scanner threshold is pinned to `src/capture/keyframes.ts` in `dome.test.mjs`.
- [x] `tests/unit/node/gimbal_cli.test.ts` runs the real CLI. It checks the help (`--no-probe-arc`, `stop`), the dry-run default (7 × 2, 25° step), and that grid posts centre/span without `--pans`.
- [x] `server/mcp-server.test.mjs` runs the real MCP server over stdio against a fake backend:
  - `stop_grid_capture` posts the stop with the token;
  - recenter aims at the fallback centre and at a measured centre;
  - the sweep walks along the arc, and an end outside it is refused before any move;
  - move-to accepts 171 and refuses tilt +30;
  - `plan_scan_grid` matches its e897380 output.
- [x] `tests/unit/node/gimbal_page_wiring.test.ts`: every element id the clients look up exists in `index.html`, and every relative import resolves inside `web/` or `protocol/`.

Results on 2026-11-23:
- `npm run verify` passed at 30e4ae1, the docs commit. The commits after it change no file the
  gate runs or reads; the four gated `test:gimbal:*` scripts were rerun at the tip and pass.
- the subsystem's `test:protocol`: 222 tests pass, 53 of them new;
- all six `tests/unit/node/gimbal_*` files: 98 pass;
- the presets keep their old column counts (7, 4, 9) and round inward on fractional measured arcs;
- the stop-flag test fails with the fix removed (mutation check).

A real page load in the built-in browser against a fake backend (loopback, non-default ports, no
BLE) confirmed:
- a parked run unlocks the joystick and Center, and locks Photo and Run;
- Stop posts `/api/grid-stop`;
- sweeping locks the manual controls;
- the test-routes note shows;
- Dome re-plans on a measured arc;
- Scanner app posts `capturePhotos: false`.

```
cd subsystems/osmo-ble && npm ci --ignore-scripts && npm run test:protocol
node --experimental-strip-types --no-warnings --test tests/unit/node/gimbal_*.test.ts
npm run test:gimbal:stall && npm run test:gimbal:control && npm run test:gimbal:link && npm run test:gimbal:protocol
npm run verify
```

## Acceptance Criteria

- [x] Given Scanner app is chosen, when Run scan is pressed, then the request body carries `capturePhotos: false` and no phone token is needed.
- [x] Given a run is parked, when the page renders, then the joystick and Center are live, and Photo and Run are not.
- [x] Given no measured arc, when `POST /api/move-to {yawDeg: 0}` arrives, then it answers 400, names the fallback arc and points at arc-probe, and sends no frame.
- [x] Given `BACKEND_ALLOWED_ORIGINS` is unset, when a page on another origin POSTs `/api/command`, then it gets 403 and no frame leaves the process. A request with no Origin still goes through.
- [x] Given `OSMO_BACKEND_TOKEN` is set, when a request or WS upgrade arrives without it, then it gets 401.
- [x] Given a run was stopped, when an arc probe is requested, then it probes instead of answering "stopped by request".
- [ ] On the rig (**needs a rig run**): a CLI grid probes at each station, a page run in Scanner app mode takes no photos, Stop ends a sweeping and a parked run, and recenter lands at the arc centre.

## Risks / potential issues

- **Risk:** a CLI grid now probes the reach at every station (about 30-85 s, driving to both stops on purpose). — **Mitigation:** it was the designed behaviour (#229). It is bounded by `PROBE_MAX_MOVES` and the 10 s move budget. `--no-probe-arc` opts out. Needs a rig run.
- **Risk:** the move-to guard refuses a target that is reachable from here when only the fallback arc is known. — **Mitigation:** the refusal says the arc is the fallback and points at `arc-probe`. The joystick and raw speed commands are unaffected.
- **Risk:** the default origin rule refuses a page opened under a different host name from the one in its backend URL (for example a short name against the full tailnet name). — **Mitigation:** the 403 names `BACKEND_ALLOWED_ORIGINS` and the origin to add.
- **Risk:** the browser can't send headers on a WebSocket, so the token goes in the `?token=` query on `/ws`. — **Mitigation:** the backend logs no request URLs. The page keeps the token in localStorage, a local convenience on a bench tool. This is noted in the README.
- **Risk:** the shared client helpers change two pages that have no DOM tests. — **Mitigation:** a wiring test (ids and imports), and one real page load in the built-in browser with no backend and no BLE.

## Subtasks

1. [x] Ticket.
2. [x] Protocol: modulo `wrapDeg`; `planGrid`, the tilt limits, arc-along columns, the sweep plan and the move-target check in `dome.mjs`; `access.mjs`.
3. [x] Backend: access gate (HTTP and WS), `BACKEND_HOST`, move-to guard, the cancel-flag fix, `testRoutes` on status, the relay nulling location, the route list.
4. [x] Page server: path check, `web/` and `protocol/` only, `WEB_HOST`.
5. [x] CLI: `stop`, Ctrl-C, the 25° default, centre/span, help, the token.
6. [x] MCP: `stop_grid_capture`, recenter, sweep, schemas, `planGrid`, header, the token.
7. [x] Page: `page-state.mjs`, `controls.mjs`, the Capture choice, Stop, parked state, the arc from status, the state bugs, the test-routes notice, the token field, the About text.
8. [x] Docs: GIMBAL_INTEGRATION.md, the README and the header comments.
9. [x] Tests, then `npm run verify`.
