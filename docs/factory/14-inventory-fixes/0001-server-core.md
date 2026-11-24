> **Type:** Backend / Security
> **Wave:** 14-inventory-fixes
> **Branch:** `inv-server-core` (local; not pushed)
> **Commit style:** `fix(server): summary`, one commit per area
> **Design:** this ticket is the spec; the findings are in the 2026-11-23 inventory review (F- and FN- ids)
> **Dependencies:** None to start. Two contracts are shared with other wave-14 sessions: Quest sign-in (with 0006 native-apps) and 4D clip access (with 0002 server-runners).

## Goal

Fix the inventory findings that live in the server core: the hard-coded host fallback, the world-route auth gaps, the event stream, the summaries nobody could delete, the artifacts nobody could fetch, and the job plumbing (scan checks, the deadline signal, chaining, honest results). Every behaviour change has a Deno test.

## Non-goals

- Do not rewrite git history. The old host literal is still in history; that is the owner's call.
- Do not change the open read of an **existing** world on an install without strict auth. That is the tailnet appliance default (owner decision 1 below).
- Do not edit files other sessions own: runners (`server/splat/**`, `server/colmap/**`, `server/panoptic/**`, `server/lingbot-map/**`, `server/person4d/**`, `server/physag3d/**`, `server/register/**`, `server/pipeline.ts`, `server/sensenova_vision.ts`), `src/**`, `public/**`, `scripts/**`, `package.json`. What they need is listed in the report.
- Do not add a second job queue, a second token type or a second sign-in route (ADR 0001, ADR 0003).
- Do not delete files. Dead code is listed as a deletion candidate.

## Pinned conventions

- **ADR 0001.** Everything here extends what exists:
  - World access stays the member-token model (`WorldMember`, `denyUnlessWorldRole`). A Companion session is recognised with the existing `verifySession` and `isAllowedEmail` (`server/portal_auth.ts`); no new credential.
  - Jobs stay `WorldJob`s through `createWorldJob` and the one pump (ADR 0003). The job rules become one table typed over `WorldJobType`, so a new type has to say whether it needs a scan and who starts it.
  - Body caps reuse `readTextCapped` (`server/wp-a-body.ts`) and the patches cap, `PLACE_JSON_MAX_BYTES` (1 MB).
  - Summaries stay in `SUMMARIES_DIR`. The index is the folder layout, one folder per capture session (`SESSION_ID_RE`), so deletion reuses the session ids the scan deletion already resolves (`sessionIdsLinkedToScan`).
  - Scan sidecars are served through the existing suffix allowlist (`SPLAT_ARTIFACT_MIME`), which is also the list deletion takes, so a served sidecar is a deleted sidecar. Session artifacts go through the existing `/sessions/:id/<artifact>` allowlist.
  - Event scope is an envelope field on the existing `/events` message (`scope`), so `EventPayload` in `src/shared/events.ts` (capture-core) is unchanged.
  - New settings: `CLIENT_LOGS_BROADCAST` (debug: fan phone console records out on `/events`). The 4D token is the existing `FDANYONE_TOKEN`. The Quest return URL is a constant beside `SHELL_RETURN_URL`, not a setting.
- **Hostname.** `vite.config.ts` and `server/main.ts` keep parallel implementations of one algorithm (`docs/factory/foundation-updates/0002`). Both fall back to `localhost` with one warning.
- **Privacy.** No host names, addresses or personal names in code, tests, docs or commits. The old literal is grepped with a count only.

## Before implementation

- `CLAUDE.md`, ADR 0001, ADR 0003, ADR 0004.
- `server/main.ts` (all of it), `server/portal_auth.ts`, `server/origin.ts`, `server/scan_deletion.ts`, `server/session_deletion.ts`, `server/world/world_job_pump.ts`, `server/wp-a-body.ts`, `server/wp-a-auth.ts`, `server/inference.ts`, `server/memory_push.ts`, `server/keyframe_retention.ts`, `server/place_frame_routes.ts`, `vite.config.ts`, `.env.example`.
- The spawn harness in `tests/unit/server/export_route_guard.test.ts` (main.ts serves at import, so routes are tested over HTTP against a spawned server).

## Open questions & answers

- Q: F-03, does a GET of an unknown slug 404 only when anonymous? — A: Every GET and POST on `/worlds/:slug/...` answers 404 for a slug with no file, whatever the credential: a member token cannot belong to a world that has no file, and POST /worlds is the way to create one. `default` and `project-<id>` of a Place in the registry are still built on first read; a Place's world is built with its `projectId`, through the same path as `GET /projects/:id/world`. (session 0001, 2026-11-23)
- Q: F-02, what is the role of a caller with no token on an install without strict auth? — A: The route already lets that caller act as an editor, so it gets the links at or below editor. Only an owner token gets the owner link. (session 0001)
- Q: F-05, "authenticated" or "no member token"? — A: No member token. A valid Companion session on a world route reads as a request without a world token: open reads stay open, strict-mode writes still need the world's token. It is never 403 "Invalid or expired world token". The session counts as authenticated only where the brief says so (F-04's off-box and deleting jobs). (session 0001)
- Q: F-04 on a strict install? — A: Unchanged: strict mode already needs an editor token for every job. (session 0001)
- Q: F-08, what about a summary with no server session id? — A: Accepted, as it always was, and kept apart in `SUMMARIES_DIR/unlinked/`, which clear-all removes. A plain export with no keyframe session sends no `sessionId` (capture-core, wave 14), so refusing it would refuse the common case. Refusing it (a 400, which the service worker drops) is the owner's option. (owner decision 4)
- Q: F-09, which debug setting? — A: `CLIENT_LOGS_BROADCAST=1` on the server. Off by default, so `npm run logs:watch` needs it set. (owner decision 5)
- Q: F-11, what does "fails fast" do? — A: The server logs one error naming the two settings and exits with status 1 before it listens. (session 0001)
- Q: F-27, which runners take the signal? — A: None of the runner modules accepts one today. main.ts now forwards it through `_dispatchWorldJob` to every `_run*Job`. The ones that run in this process stop on it (placeholders, export-world, thing-correspondence, optimize-scan between files, keyframe-purge, memory-push). The rest keep the overdue path; the list is in the code and in the report. (session 0001)
- Q: FN-121, rename `VITE_ENABLE_WEBRTC_LIVE`? — A: No. One name for both halves means the client build and the server gate cannot disagree. Documented on the server and in `.env.example`. (owner decision 8)
- Q: memory-push with no Companion Memory (FN-136, handed over by 0002)? — A: A completed job that says it was skipped, with the fix, like every other missing tool. (owner decision 7)
- Q: Do failed job texts and served manifests count as "replies" for FN-118? — A: Yes. A failed job's error and result are cut of server paths where they are recorded (`commitWorldJob`), and a JSON artifact served from `/scans/…` or `/sessions/…` has runner-written absolute paths cut to file names. Links into the API (`/scans/…`, `/sessions/…`, `/worlds/…`) are kept whole. (session 0001)
- Q: The rules table and the editor's `SCAN_REQUIRED_JOB_TYPES` (0005's branch) are two lists. — A: A test compares them once the editor's file is merged (it imports it by a computed name, so this branch still type-checks). (session 0001)
- Q: physag3d.test.ts (0002's file) pins main.ts's old lists. — A: Its one main.ts wiring case now points at the rules table; listed for 0002. (session 0001)

### Owner decisions (defaults kept or changed)

1. **Kept:** on an install without strict world auth, anyone who can reach the server reads an existing world (`GET /worlds/:slug`, `/patches`, `/comments`, `/jobs`) with no token. That is the tailnet appliance posture.
2. **Changed (brief):** a GET never creates a world, except `default` and a known Place's `project-<id>`.
3. **Changed (brief):** on an install without strict auth, `thing-interactive-asset`, `memory-push` and `keyframe-purge` with `dryRun: false` need an editor-or-better token or a Companion session. The editor opened with no token gets a 401 for those three and keeps every other job.
4. **Kept, with an option:** a summary that names no server session id is accepted and kept in `unlinked/`, removed only by clear-all, since nothing ties it to a scan. The owner may choose to refuse such uploads instead (a one-line 400 in `POST /upload-summary`).
5. **Changed (brief):** phone console records are not fanned out on `/events` unless `CLIENT_LOGS_BROADCAST=1`.
6. **Changed (brief):** `PORTAL_OIDC_ENABLED` without `OIDC_ISSUER_URL` stops the server at boot.
7. **Changed:** memory-push with no Companion Memory completes as skipped.
8. **Kept:** `VITE_ENABLE_WEBRTC_LIVE` is read by both the client build and the server.

## Files impacted

- Changed: `server/main.ts`, `server/portal_auth.ts`, `server/origin.ts`, `server/inference.ts`, `server/memory_push.ts`, `server/scan_deletion.ts`, `server/session_deletion.ts`, `server/keyframe_retention.ts`, `server/place_frame_routes.ts`, `server/world/world_job_pump.ts`, `vite.config.ts`, `.env.example`, `tests/server.spec.ts`, `tests/project.spec.ts`, existing Deno route tests that created a world by reading it.
- New: `server/world/job_request.ts` (the job rules table, request validation, the off-box gate), `server/world/world_access.ts` (who is calling a world route), `server/scan_summaries.ts` (where a summary lives, and its deletion), `server/scan_take_clips.ts` (the two optional 4D clip fields 0002 asked for), `server/wp-a-static.ts` (the `/editor` rewrite both servers use), `tests/unit/server/server_core_*.test.ts`, `tests/unit/server/server_core_harness.ts`.
- Also changed: `server/session_deletion.ts` (a `signal`; `.lingbot.glb` is derived), `server/wp-a-log.ts` (`withoutServerPaths`, `jsonWithoutServerPaths`), `deploy/cscan.env.example`, `tests/unit/node/stitch_wiring.test.ts`, `tests/unit/node/wp-15a-register-proposal-wiring.test.ts`, `tests/unit/server/physag3d.test.ts` (one wiring case), and the route tests that made worlds by reading them.

## Schema required

None in `src/world/types.ts`. On the wire:

- `/events` messages gain an optional `scope: { worldId, slug, projectId }` for world and Place events. Additive.
- The `hello` message gains `clientLogs: boolean`.
- `GET /worlds/:slug/share` returns only the roles at or below the caller's.

## Definition of Done

- [x] F-01: no fallback host in code; neutral `localhost` with one startup warning, in `server/main.ts` and `vite.config.ts`.
- [x] F-02: share links at or below the caller's role.
- [x] F-03: unknown slugs 404 on every world route; no world file written.
- [x] F-04: the three off-box or deleting job types need an editor token or a session with strict auth off.
- [x] F-05: a session Bearer or `?token=` is never a 403 on any world route.
- [x] F-07: the ollama engine logs counts and timing only.
- [x] F-08: summaries indexed by session, deleted with the session, the scan and clear-all.
- [x] F-09: client logs gated; world and Place events scoped.
- [x] F-10: `FDANYONE_TOKEN` admitted on the clip and pose-track routes only; `shell=quest` sign-in.
- [x] F-11: whoami cookie allowlist; fail fast; JSON caps; job payload validation; no paths in error replies.
- [x] F-22: COLMAP manifest and poses served; panoptic-lift sidecars served and deleted with the scan.
- [x] F-24: sensenova-vision, panoptic-scan and panoptic-lift need a scan.
- [x] F-27: the signal reaches every runner in main.ts; the runners that cannot take it are listed.
- [x] F-28: panoptic-lift chained after panoptic-scan; request-only types marked in the rules table.
- [x] F-29: splat-train's worker and result name the backend; memory-push says whether the GLB went.
- [x] F-30: /process-scan uses the scan's Place world and no newest-GLB fallback; `.lingbot.glb` is not a scan; a bad `limit` is the default.
- [x] FN-070, FN-110, FN-119, FN-121, FN-122, FN-123, FN-141, FN-146, FN-147, FN-148.
- [x] `deno task check`, `deno task test` and `npm run verify` pass.

## Tests

- [x] `server_core_hostname.test.ts`: the resolver falls back to `localhost`, says so, and keeps each earlier source.
- [x] `server_core_world_access.test.ts`: F-02, F-03, F-04, F-05 over HTTP, in the open and strict modes.
- [x] `server_core_portal.test.ts`: Quest return URL, whoami allowlist on the cookie, the boot check.
- [x] `server_core_clip_token.test.ts`: `FDANYONE_TOKEN` opens the two routes and nothing else.
- [x] `server_core_inference_log.test.ts`: no model text in the log.
- [x] `server_core_events.test.ts`: client logs gated; scope on job events.
- [x] `server_core_summaries.test.ts`: index and deletion with session, scan, clear-all.
- [x] `server_core_jobs.test.ts`: payload validation, body caps, scan checks, chaining, results, /process-scan, limit, dedupe.
- [x] `server_core_artifacts.test.ts`: the new served files, and their deletion.

```bash
source ~/.nvm/nvm.sh && nvm use 22.23.2
export ONNXRUNTIME_NODE_INSTALL_CUDA=skip PATH="$HOME/.deno/bin:$PATH"
deno task check
deno test --allow-read --allow-write --allow-env --allow-net --allow-run --allow-ffi tests/unit/server/server_core_*.test.ts
npm run verify
```

## Acceptance Criteria

- [x] Given no host settings and no tailscale, when the server boots, then it names `localhost`, warns once, and the old literal appears nowhere in the owned files (count 0).
- [x] Given an editor token, when it asks for share links, then the owner link is not among them.
- [x] Given an anonymous GET of `/worlds/<new-slug>`, then the answer is 404 and no file appears in `WORLDS_DIR`.
- [x] Given strict auth off and no token, when a memory-push is queued, then it is refused with 401; with an editor token it is queued.
- [x] Given a valid Companion session as Bearer, when it reads a world, then it is not 403.
- [x] Given a summary uploaded for a session, when that session or its scan is deleted, then the summary is gone.

## Risks / potential issues

- **Risk:** a client that created worlds by reading them breaks. — **Mitigation:** none in `src/` does: the editor reads `default`, a Place world, or a slug from a share link, which exists. Tests that relied on it now create the world first.
- **Risk:** the editor opened with no token loses Publish (memory-push) on an open install. — **Mitigation:** that is the brief's change; the 401 names the fix (open the editor from a share link, or sign in).
- **Risk:** a summary from a plain export (no keyframe session) still cannot be deleted with its scan. — **Mitigation:** it is kept apart in `unlinked/`, clear-all removes it, and refusing it is owner decision 4.
- **Risk:** `npm run logs:watch` shows nothing by default. — **Mitigation:** `.env.example` documents `CLIENT_LOGS_BROADCAST=1`; the docs line is listed for docs-drift.
- **Risk:** other sessions add `signal` options to their runners at the same time. — **Mitigation:** main.ts passes the signal only where an option exists today; the report asks 0002 to add `signal?: AbortSignal` and names the call sites.
- **Risk:** spawn tests are slow on a shared machine. — **Mitigation:** one harness, few boots per file, targeted runs while working.

## Subtasks

1. [x] Ticket (this file).
2. [x] F-01 hostname.
3. [x] World access: F-02, F-03, F-04, F-05.
4. [x] Sign-in: F-10 Quest and 4D token, F-11 whoami and boot check.
5. [x] F-07 and FN-146 inference.
6. [x] F-09 and FN-122 events.
7. [x] F-11 body caps, job payloads, error replies (FN-112, FN-118).
8. [x] F-08 summaries.
9. [x] F-22 artifacts.
10. [x] Jobs: F-24, F-27, F-28, F-29, F-30, FN-123, FN-147, FN-148.
11. [x] FN-070, FN-110, FN-119, FN-121, FN-141.
12. [x] Gate and report.
