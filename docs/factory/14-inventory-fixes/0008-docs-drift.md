> **Type:** Docs
> **Wave:** 14-inventory-fixes
> **Branch:** the `inv-docs-5f4624` worktree's branch, cut from `refactor-base-e897380`
> **Commit style:** `docs(scope): summary`
> **Design:** this ticket is the spec; the wave plan is [README.md](README.md)
> **Dependencies:** None. The other seven tickets report the sentences their changes make false, and those are applied after they merge.

## Goal

Make the docs say what the code at `e897380` does, and plan wave 14 in the atlas. Where the
docs and the code disagree, the code wins. The findings are the owner's inventory's F-45, F-46,
F-47, F-49 (its `CLAUDE.md` half) and the device-support contradictions.

## Non-goals

- Do not change code, tests, `package.json`, `.env.example` or any file another wave-14 session
  owns (`docs/pipelines/`, `docs/product/UX_FLOW.md`, `docs/operations/GIMBAL_INTEGRATION.md`).
- Do not describe as landed anything that is not merged to `main`. Every wave-14 diff is planned.
- Do not copy ticket content into the atlas: one-line before/after and a pointer.
- Do not rewrite dated history (old tickets, `docs/audits/`) beyond what the tense rule needs.

## Pinned conventions

- Code wins. Each corrected sentence was checked against the code at `e897380`, by file and line.
- The atlas rules in `docs/FACTORY.md` § "The atlas": a badge-free sentence is base description
  and must be true; a diff is `was` → `now` plus a `wave/ticket` tag; `planned`, `done` (merged to
  `main`) or `underway`.
- A wave README states atlas gaps in the past tense, as gaps filled.
- Builds are cited by commit and run id. `81e437c` is the tree #282 merged as `e897380`
  (`git diff 81e437c e897380` is empty).
- No host names, personal names, IP addresses or home paths. The F-01 fallback host is named
  as "a developer machine's host name", never printed.
- ADR 0001 applies to docs too: one atlas, one wave README, no second copy of a table.

## Before implementation

- The review folder outside the repository (`scan-builds/2026-11-23-review/`): `SESSION_RULES.md`,
  `curated-findings.json` (F-45 to F-47, F-49) and `views/findings-raw.txt` (FN-120, FN-125,
  FN-126, FN-134, FN-136, FN-149, FN-176, FN-177).
- The build record for `81e437c` and `gh run view 45260987425`.
- `docs/FACTORY.md`, `docs/factory/atlas.html`, `docs/factory/13-device-targets/`.
- The doc-claim tests: `tests/unit/node/wp-docs-config-honesty.test.ts` and
  `tests/unit/node/wp-docs-device-claims.test.ts`.

## Open questions & answers

- Q: Wave 13's card read 0 of 11. Which of its tickets did #282 merge? — A: Read in the code at
  `e897380`: 0001, 0005, 0007 and 0011 landed; 0006 landed without a scan list (a name is typed);
  0009 landed as a hook only (it runs whether or not a capture is running, and nothing maps its
  output onto `WorldDetection`); 0002, 0003, 0004, 0008 and 0010 did not land. Every ticket
  file's checkboxes are unchecked. (docs-drift, 2026-11-23)
- Q: The atlas config tables list `CANVAS_FRAME_COUNT`, `CANVAS_RESOLUTION` and
  `DEPTH_POINT_RADIUS_PX`, which no code reads. Drop or mark? — A: Mark. They are wave 11's
  planned settings; the rows now say so. (docs-drift, 2026-11-23)
- Q: The F-01 host name is also printed in older tickets and in `docs/testing/`. Scrub them
  here? — A: First only the atlas. Then the owner said yes (2026-11-23), so every doc this ticket
  owns had its host names, tailnet device addresses and home paths replaced with placeholders.
  Code, specs, scripts and other sessions' docs that carry them are listed for their owners.
  Git history keeps the old text. (owner, 2026-11-23)
- Q: PLATFORM_SUPPORT calls Brush "binary + version only" and "not run", and points at ADR 0007's
  Brush run on the same host. Which holds? — A: ADR 0007 records one end-to-end training run
  (a session made from a synthetic walkthrough video, 166 s). Both rows now say so; the adapter
  wgpu used is not recorded. (docs-drift, 2026-11-23)

## Files impacted

Changed:

- `CLAUDE.md`, `README.md`
- `docs/architecture.md`
- `docs/targets/README.md`, `server.md`, `ios.md`, `android-arcore.md`, `android-8thwall.md`,
  `meta-quest.md`, `web-8thwall.md`, `web-webxr.md`
- `docs/operations/PLATFORM_SUPPORT.md`, `docs/operations/AR_DEVICE_SUPPORT.md`
- `docs/testing/DEVICE_TEST_KIT.md`
- `docs/factory/atlas.html`
- For the host-name scrub: ADR 0006, the audit of 2026-11-13, tickets in waves 09 to 12 and
  foundation-updates, `docs/operations/COLMAP_SETUP.md`, `docs/splat-detect.md`, and
  `docs/testing/` (`DEVICE_TESTING.md`, `HOUSE_VALIDATION.md`, `TEST_INFRA.md`,
  `user-test-suite.md`)

New:

- `docs/factory/14-inventory-fixes/README.md`
- `docs/factory/14-inventory-fixes/0008-docs-drift.md` (this file)

## Schema required

None.

## Definition of Done

- [x] `CLAUDE.md`'s do-not-rename table has `'ci-xr-projects'`, and it no longer calls
      `person-4d-reconstruct` the only job type that delegates.
- [x] `architecture.md` and `targets/server.md` say 23 job types, 22 accepted by the API, 17
      runners and 6 No-op placeholders, and describe only outputs the placeholders produce.
- [x] `targets/server.md` no longer says a missing tool never fails a job.
- [x] The target pages record the builds at `81e437c` (run 45260987425 and the local APKs), and
      `meta-quest.md` no longer says the stream is always 1280x960.
- [x] PLATFORM_SUPPORT's Brush rows and AR_DEVICE_SUPPORT's tablet row agree with the records
      they cite.
- [x] The atlas: wave 13's card and badges say what #282 merged; the CORS, OIDC, world-auth, RTC
      and photo-ingest entries match the code; the seven missing features have entries; the
      unread settings are marked.
- [x] The wave-14 README and atlas card, with planned diffs for every ticket.

## Tests

- [x] `tests/unit/node/wp-docs-config-honesty.test.ts` and
      `tests/unit/node/wp-docs-device-claims.test.ts` pass.
- [x] `npm run verify` passes.

```
node --experimental-strip-types --no-warnings --test tests/unit/node/wp-docs-config-honesty.test.ts tests/unit/node/wp-docs-device-claims.test.ts
npm run verify
```

## Acceptance Criteria

- [x] Every sentence this ticket changed cites, or can be checked against, a file and line at
      `e897380`, a commit or a run id.
- [x] No wave-14 diff is marked done.
- [x] No host name, personal name or home path is added.

## Risks / potential issues

- **Risk:** the other seven tickets make some of these sentences false as they merge (for example
  the missing-tool exceptions, the runners' tool lookup, the Quest sign-in gap). — **Mitigation:**
  those sentences are dated "as of `e897380`" and each has a planned wave-14 diff; the sessions
  report the sentences their changes make false.
- **Risk:** a doc-claim test reads text this ticket rewrote. — **Mitigation:** both doc-claim
  tests ran after every rewrite, and the atlas's calibration card and `ScanCalibration` row were
  not touched.

## Subtasks

1. [x] Read the session rules, the findings and the doc-claim tests.
2. [x] Correct `CLAUDE.md` (F-49).
3. [x] Correct the job counts and table (F-46).
4. [x] Record the `81e437c` builds on the target pages (F-47).
5. [x] Reconcile PLATFORM_SUPPORT and AR_DEVICE_SUPPORT.
6. [x] Correct the atlas and add the missing entries (F-45).
7. [x] Write the wave-14 README and the atlas card with planned diffs.
8. [x] Run the doc tests and `npm run verify`.
