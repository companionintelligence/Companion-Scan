# Wave 14 — Inventory fixes

On 2026-11-23 the owner reviewed an inventory of `main` at `e897380`, the merge of #282: every
capability and every UI element, read from the code by seven readers, with fifty curated
findings (F-01 to F-50) drawn from their 194 raw ones. The owner asked for all fifty to be fixed,
in parallel. This wave is that work: eight tickets, each carried out by one session that owns a
disjoint set of files.

The inventory is not in this repository, so each ticket is asked to restate the facts it relies
on, with the file and line at `e897380`, so that it can be checked without the inventory.

## Tickets

Each session writes its own ticket in this folder, `000N-<slug>.md`, from
[TICKET_TEMPLATE.md](../TICKET_TEMPLATE.md), before it changes code. This table is the plan as
each session was briefed on 2026-11-23; each ticket file records what was actually done, and
which findings it fixed, left partly fixed, deferred or left to the owner. All eight merged on
2026-11-23, in the order 0001, 0002, 0004, 0003, 0005, 0006, 0007, 0008. Two tickets with no
ticket file of their own followed the same day: 0009, the integration work that needed more than
one session's files (#292), and 0010, QA fixes from the browser suite (#293).

| # | Merged | Session | Owns | Findings | What it changes |
|---|---|---|---|---|---|
| [0001](0001-server-core.md) | [#284](https://github.com/companionintelligence/Companion-Scan/pull/284) | server-core | `server/main.ts`, `server/portal_auth.ts`, `server/origin.ts`, `server/inference.ts`, the world, Place, deletion and retention modules, `.env.example`, `vite.config.ts`, `deploy/` | F-01 to F-05, F-07 to F-11, F-22, F-24, F-27 to F-30 (server parts) | The server's own security and job handling. A neutral host fallback with a warning instead of a developer's host name. Share links only at or below the caller's role. A 404 for an unknown world slug instead of a world built from stored scans. A token or session for the three jobs that send data off the box or delete it, even with strict auth off. A session Bearer accepted on world routes. Inference logs with counts only. Summaries deleted with their scan. `/events` scoped, and console records sent only with debug on. The 4D clip routes admit the 4D service's token, and `shell=quest` sign-in. whoami's allowlist, a fail-fast boot for OIDC with no issuer, capped JSON bodies, and no file paths in errors. The COLMAP and panoptic-lift sidecars served and deleted with the scan. The abort signal reaches the runners. `panoptic-lift` chained after `panoptic-scan`. `/process-scan` uses the scan's Place world. |
| [0002](0002-server-runners.md) | [#285](https://github.com/companionintelligence/Companion-Scan/pull/285) | server-runners | `server/splat/`, `server/colmap/`, `server/panoptic/`, `server/lingbot-map/`, `server/person4d/`, `server/physag3d/`, `server/register/`, `server/capabilities.ts`, `subsystems/4d-capture/`, `docs/pipelines/` | F-26, F-29, F-43, and the service half of F-12 | The 4D person path end to end: the service downloads the clips with its token, extracts frames and reads the pose track, and checks that token on its own routes. One tool resolver (setting, then `PATH`, then fallback) shared by the runners and the capability report, with the missing probes added. A missing tool is a uniform skip. Shared runner helpers, and one label-synonym canon. |
| [0003](0003-scanner-ui.md) | [#287](https://github.com/companionintelligence/Companion-Scan/pull/287) | scanner-ui | `src/main.ts`, `src/ui/`, `src/pwa.ts`, `public/sw.js`, `index.html`, `webxr.html`, `scanner.html`, the scanner's specs | F-06 (`__playwright_hooks`), F-13 to F-18, F-44 (`src/ui`) | The scanner. Label pins on WebXR and native sessions. Onboarding, with the apps' Server row, Legal notices and sign-in return, wired before the AR checks can return. An offline retry for the apps, which have no service worker. A guarded 8th Wall to WebXR fallback. A visible read-only notice. The runtime switch keeps the query. Person clips carry their take and client ids. One colour table. |
| [0004](0004-capture-core.md) | [#286](https://github.com/companionintelligence/Companion-Scan/pull/286) | capture-core | `src/ar/` (but not the native or runtime-select files), `src/capture/`, `src/geo/`, `src/inference/`, `src/scene/`, `src/export/`, `src/spatial/`, `src/rtc/`, `src/project/`, most of `src/shared/` | F-40, F-37, F-08 (client side), F-44 (`gltf.ts`) | One shared home, with tests, for each piece of duplicated pose and frame maths. The reverse geocoder asks consent once, the altitude label claims no datum, and no `local-` session id is uploaded. The runtime-anchor functions are wired only if that is small and testable, and otherwise left to the owner. Exports stay stable. |
| [0005](0005-editor.md) | [#288](https://github.com/companionintelligence/Companion-Scan/pull/288) | editor | `src/viewer/`, `src/world/`, `viewer.html`, `xr-world.html`, `src/shared/api-base.ts`, `src/shared/access-token.ts`, `docs/product/UX_FLOW.md`, the editor's specs, `tests/known-failures.json` | F-06 (editor hooks), F-10 (editor requests), F-19 to F-25 (editor parts), F-41, F-42, F-48 | The editor. One access token on every request. Dead layer toggles, counters and the layers metric made real or hidden. Hide Object undoable. No invented camera path. "Not run" told apart from "not served". SenseNova output and the world GLB shown. The Advanced queue's scan guard. One frame predicate. The duplicated matrix and frame-id helpers merged. The left-handed ENU note settled. UX_FLOW.md rewritten, and specs that click only ids the page has. |
| [0006](0006-native-apps.md) | [#289](https://github.com/companionintelligence/Companion-Scan/pull/289) | native-apps | `mobile/`, `meta/`, `desktop/`, the native AR files in `src/ar/`, `src/shared/shell-sign-in.ts`, `scripts/native/`, `.github/workflows/` | F-31 to F-36 | The apps. ScanAR parity between iOS and Android, where it can be checked without a device. The 90-degree pose question settled from the SDK docs, with decode-side tests. The Quest app signs in, asks only for splat files the server serves, runs its vision hook only while capturing, and uploads through a bounded executor. The iOS plist, real Android tests, and CI jobs for `meta/`, the Gradle and Rust tests, and the subsystem tests. A build entry for the Android 8th Wall variant. |
| [0007](0007-gimbal.md) | [#290](https://github.com/companionintelligence/Companion-Scan/pull/290) | gimbal | `subsystems/osmo-ble/`, `docs/operations/GIMBAL_INTEGRATION.md`, the gimbal unit tests | F-50, and the gimbal half of F-12 | The gimbal rig. The page sends its Capture choice. A Stop control on the page, the CLI and MCP. Manual controls while a run is parked. One arc guard for move-to, sweep and recenter. The page's state bugs, and the CLI's defaults and help. Docs that match the code. An optional token, an origin allowlist and a bind setting, with today's defaults kept. |
| [0008](0008-docs-drift.md) | [#291](https://github.com/companionintelligence/Companion-Scan/pull/291) | docs-drift | `docs/` (but not `docs/pipelines/`, `UX_FLOW.md` or `GIMBAL_INTEGRATION.md`), `CLAUDE.md`, `README.md`, the atlas, this README | F-45 to F-47, F-49 (`CLAUDE.md`), the device-support docs | The docs, corrected to the code at `e897380`. Wave 13's card and badges say what #282 merged. The atlas's CORS, OIDC, RTC and photo-ingest entries, and entries for seven features it did not describe. The job counts in `architecture.md` and `targets/server.md`. The target pages record the builds at `81e437c`. `CLAUDE.md` protects `'ci-xr-projects'` and names both delegating job types. This README and the wave's atlas pass. |
| 0009 | [#292](https://github.com/companionintelligence/Companion-Scan/pull/292) | integration | the integration branch, after the eight merges | the cross-session leftovers of F-07, F-27, F-44 and F-01, and more | Work that needed more than one session's files. The abort signal at nine runner call sites, so `RUNNERS_WITHOUT_SIGNAL` keeps only `splat-align`, `panoptic-lift` and `place-register`. The scanner's colour lookup uses `labelDisplayCss`. The ONNX driver logs counts only. `playwright.config.ts`, the e2e suite and the tablet suite fall back to `localhost`. The shell storage keys are declared once. `world_export` reads GLBs through `getGltfReadIO`. The native builds leave out the AR dev pages. `test:gimbal:page` runs in `npm run verify`. The quarantine test skips `cap sync`'s copies. A queued summary is logged as queued. Keyframe uploads retry 408 and 429. `.env.example` is corrected. Deno CI installs with `ONNXRUNTIME_NODE_INSTALL_CUDA=skip`, and passes again. |
| 0010 | [#293](https://github.com/companionintelligence/Companion-Scan/pull/293) | QA | after 0009 | the browser suite's failures | `#start-screen` gets `data-probe="settled"` once the AR probe has answered, and the startup word-budget spec waits for it. "07 render modes" is off `tests/known-failures.json`. |

Four findings span sessions. F-06's three hooks are split between 0003 and 0005. F-10's missing
tokens are the editor's (0005), the clip routes' admission is the server's (0001), and the
service's download is 0002's. F-29's `server/main.ts` half (the `splat-train` worker and result
follow `SPLAT_BACKEND`, and `memory-push` says whether the GLB was attached) is 0001's, and the
resolver is 0002's. F-49's `.env.example` half is 0001's and its storage-key registry half 0004's.

F-37, F-38 and F-39 are code with no caller. Under this wave's rules nothing is deleted: the
session that owns each file lists it as a deletion candidate with its evidence, and the owner
decides. F-32 and F-34 are lists for the same reason.

## Contracts between sessions

Two changes cross a session boundary, so both sides were fixed before the work started.

**Quest sign-in** (0001 and 0006), the server half of wave 13's ticket 0010:

```
GET /authenticate/oidc?shell=quest&challenge=<base64url S256>
  → the usual CI-Portal flow
  → 302 to com.companionintelligence.scan.quest://auth?code=<one-time code, 60 s>
POST /authenticate/shell/exchange {code, verifier} → the same reply as for shell=1 and shell=desktop
```

The Quest app then sends `Authorization: Bearer <token>` on every request. It registers an
intent filter for the `com.companionintelligence.scan.quest` scheme and opens the sign-in URL in
the system browser.

**4D clip access** (0001 and 0002):

- The off-box 4d-capture service fetches `clip.url` and `poseTrackUrl` with
  `Authorization: Bearer <FDANYONE_TOKEN>`.
- When the session guard is on, the server admits exactly that token, compared in constant time,
  on `GET /sessions/:id/clip/:file` and `GET /sessions/:id/pose-track.json`, and nowhere else.
- The service checks the same token on its own routes.

## Rules every ticket keeps

- **ADR 0001.** Reuse, don't duplicate. A moved function leaves a re-export, so the sessions
  editing its importers at the same time are not broken.
- **Defaults.** A change to a default security posture that would break today's default flow
  goes behind a setting, with today's behaviour as the default, and is listed for the owner.
  Examples are open world reads on a tailnet appliance, and an editor opened with no token.
- **No deletions.** Dead code stays in place and is listed with evidence. Removing a duplicate
  function is fine when it is replaced by the shared one.
- **Privacy.** No host names, IP addresses, street addresses, coordinates, personal names or
  home-directory paths in code, tests, docs or commit messages.
- **The gate.** `npm run verify` passes on each branch. Nothing here runs on a device: a change
  that needs one says "needs a device run".
- **Local only.** Each session commits on its own branch, and nothing is pushed or opened as a
  PR without the owner.

## Atlas

This wave's atlas pass, on 2026-11-23, added:

- a wave card, at 0 of 8, since nothing of this wave is merged;
- planned before/after diffs, tagged `14-inventory-fixes/000N`, on the entries each ticket changes;
- entries for features the atlas did not describe: `export-world`, `place-register`,
  `keyframe-purge`, panoptic segmentation and lifting, SenseNova vision, thing correspondence,
  the capability report, the Companion session guard, and the scanner's start screen and
  first-run setup.

The same pass corrected the atlas to the code at `e897380`, as ticket 0008 asks. Until it:

- wave 13's card read 0 of 11, with every diff planned, although #282 had merged most of it
  (fixed: each ticket's badge now says what is in `main`);
- the CORS entry said the allowlist admits any tailnet name and private ranges by construction,
  the OIDC entry that every route 404s unless enabled, the world-auth entry that member tokens
  are the only authorization, the `/rtc-signal` entry that the relay never reads a payload, and
  the ingest entry that photo ingest runs ffmpeg (fixed);
- the config tables listed `CANVAS_FRAME_COUNT`, `CANVAS_RESOLUTION` and `DEPTH_POINT_RADIUS_PX`
  as settings, though no code reads them (fixed: marked as wave 11's planned settings);
- it said the 8th Wall provider reports a fixed 60° field of view, that `splat-align` is never
  chained, that CI runs on push, that `OLLAMA_HOST` must be a full URL, that a `Thing` does not
  exist, and that the gimbal's Dome preset is 105 positions (fixed);
- it printed developer and fleet host names (removed; the same pass, on the owner's yes, replaced
  host names, device addresses and home paths in every doc 0008 owns, and listed the code,
  specs, scripts and other sessions' docs that still carry them);
- the atlas described none of the features in the list above (gaps filled).

## Verification available here

- `npm run verify` and the targeted tests each session adds.
- The Android and Quest Gradle builds run here, one at a time. iOS compiles only on the macOS
  runner.
- No ticket in this wave runs on a device or a headset.

## Landed

All ten tickets merged on 2026-11-23. Read from the code (`8deb264` for the eight, `fe03cbf` for
0009 and 0010), each did what the table says, with these parts left over; the atlas states each
beside its diff:

- **0001 (#284).** `/events` scoping is opt-in with `?world=`, and the editor does not ask for
  its world yet. The abort signal reached the placeholder and in-process jobs only; 0009 passed it
  to nine runner call sites, and `splat-align`, `panoptic-lift` and `place-register` still run on
  past their deadline with a warning.
- **0002 (#285).** The 4D path has run only in stub mode: no 4DAnyone host exists.
- **0003 (#287).** The scanner page still loads the WebXR emulator for `?mock=webxr`. Its colour
  lookup moved onto `labelDisplayCss` in 0009; the editor keeps a table of its own
  (`src/viewer/editor.ts`).
- **0004 (#286).** The native codec keeps its own quaternion and field-of-view code; it is
  0006's file, and was not moved.
- **0005 (#288).** The note about the ENU frame is corrected; the frame itself is unchanged.
- **0006 (#289).** Everything is in code; ScanAR parity, the display-oriented poses, Quest sign-in
  and the vision gate need a device or headset run.
- **0007 (#290).** Unset, the backend now admits only the control page's own origin, not `*`.
- **0008 (#291).** The planning pass; a follow-up corrected the docs to the merged code.
- **0009 (#292) and 0010 (#293).** Nothing left over that the atlas records.

## Decisions for the owner

1. Open reads of existing worlds stay open by default (0001). Whether to close them.
2. Every default the wave keeps behind a new setting: the gimbal token and bind address (0007),
   and any server posture 0001 puts behind one.
3. The deletion candidates each session lists (F-37, F-38, F-39, and the unregistered `ArSession`
   plugin, F-34).
4. The test-only server stacks: the Place index and the joint multi-session COLMAP registration
   (0002).
5. Whether the runtime-anchor functions are wired, if 0004 finds that is not small (F-37).
6. The merge order of the eight branches, and when they are pushed (done: merged 2026-11-23).
7. Whether the ENU frame that `LocalFrame` declares should change (0005 corrected the note only).
8. Which splat analyzer is the supported one, the ROCm fork or upstream (0002).
9. Whether to require the gimbal backend's token, which closes its DNS-rebinding gap (0007).
10. Whether a reverse-geocoder request, once a device says yes, should carry fewer than six
    decimals (0004).
