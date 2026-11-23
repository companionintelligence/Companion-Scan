> **Type:** Docs
> **Wave:** 13-device-targets
> **Branch:** `docs/device-targets`
> **Commit style:** `docs(targets): summary`
> **Design:** this ticket is the spec
> **Dependencies:** None

## Goal

Make `README.md` and the docs device-target oriented. A reader can answer, for each of the six targets and for the common server, what it is, its status, its entry points, and how to build, run and test it.

## Non-goals

- Do not change code, workflows, `package.json` or `scripts/`.
- Do not describe planned work (the Quest app, the RealityKit view) as built.
- Do not move or rewrite the device checklists in `docs/testing/DEVICE_TESTING.md`; link to them.
- Do not remove existing exposure of private data in files the ticket does not otherwise touch. That is a separate owner decision.

## Pinned conventions

- Target names, used everywhere: "Web, 8th Wall", "Web, WebXR", "Android app, ARCore", "Android app, 8th Wall", "Quest app", "iOS app". The common server is "the server". The desktop app is a non-capture target.
- New pages live in `docs/targets/`: `README.md` (index and matrix), `web-8thwall.md`, `web-webxr.md`, `android-arcore.md`, `android-8thwall.md`, `meta-quest.md`, `ios.md`, `server.md`.
- Each page has the same sections: what it is, status, entry points and files, build, run, test, known gaps.
- Use `<host>` for the server host. Never write a Tailscale host name, a Tailscale IP, a device fleet name, a home path, or any street address or coordinates.
- Status words follow the repo's existing practice: say what was checked, on what, and what has not run on a device.
- Facts to state per target, as they stood when this wave was planned:
  - Web, 8th Wall: `index.html` loads `public/xr.js` unless `?ar=webxr`.
  - Web, WebXR: `webxr.html` forwards to `/?ar=webxr`. The session requires `hit-test` and asks for `dom-overlay`, `local-floor` and `anchors` (`src/ar/webxr.ts:166-174`).
  - Android app, ARCore: native first, then 8th Wall, then WebXR (`src/ar/runtime-select.ts`).
  - Android app, 8th Wall: the same shell built with `VITE_AR_RUNTIME=8thwall` (`buildForcedRuntime`), with the same applicationId.
  - Quest app: planned, no code (ADR 0013).
  - iOS app: ARKit through `ScanAR`, drawn by an `ARSCNView`. RealityKit is planned (ADR 0012).

## Before implementation

- Run `grep -rln "README\|docs/" tests/unit` (about 41 files) and list what each test asserts and about which file. Run them all for a green baseline.
- Run `grep -rn "README.md#" .` and list every inbound anchor.
- Read `README.md`, `mobile/README.md`, `desktop/README.md`, `docs/testing/DEVICE_TESTING.md` and `docs/testing/DEVICE_TEST_KIT.md`.

## Open questions & answers

- Q: Who ticks this ticket's boxes? — A: The docs agent did the work in branch `dt/docs`. The coordinator ticks the boxes when that branch merges into the wave's integration branch (decided by the coordinator, 2026-11-23).
- Q: Does a sentence a doc test checks have to stay in its file? — A: No. It may move if the test's path or anchor moves with it. No assertion may be loosened, skipped or deleted (decided by the coordinator, 2026-11-23).

## Files impacted

- New: `docs/targets/README.md`, `docs/targets/web-8thwall.md`, `docs/targets/web-webxr.md`, `docs/targets/android-arcore.md`, `docs/targets/android-8thwall.md`, `docs/targets/meta-quest.md`, `docs/targets/ios.md`, `docs/targets/server.md`.
- Changed: `README.md`. `mobile/README.md` and `desktop/README.md` only where links break. Doc-reading tests under `tests/unit/` only where a checked sentence moved.

## Schema required

None.

## Definition of Done

- [ ] The top of `README.md` is a device-target matrix that links each target's page.
- [ ] Every target page and `server.md` exist, with the pinned sections.
- [ ] Every inbound `README.md#` anchor still resolves.
- [ ] Every doc-reading test passes, with no assertion loosened.

## Tests

- [ ] Every test found by the grep in "Before implementation" passes before and after.
- [ ] `npm run test:public-site`, `npm run test:device-docs` and `npm run test:device-doc` pass.

```bash
source ~/.nvm/nvm.sh && nvm use 22.23.2
for f in $(grep -rln "README\|docs/" tests/unit/node); do node --experimental-strip-types --no-warnings --test "$f"; done
npm run test:public-site && npm run test:device-docs && npm run test:device-doc
```

## Acceptance Criteria

- [ ] Given a new reader, when they open `README.md`, then within one screen they can find the page for their device target.
- [ ] Given any target page, when it says something works, then it says what that was checked on.
- [ ] A grep of the new pages for Tailscale names, IPs and home paths finds nothing.

## Risks / potential issues

- **Risk:** A doc test checks exact wording in `README.md`. Moving text breaks it. — **Mitigation:** Baseline first; move test paths with the text; never loosen.
- **Risk:** `mobile/README.md` links into `README.md` by anchor. — **Mitigation:** Keep heading text, or update every link.
- **Risk:** The rework restates facts that later tickets change, such as the RealityKit view. — **Mitigation:** Date planned items, and flip them when their tickets land.

## Subtasks

1. [ ] Baseline the doc tests and inbound anchors.
2. [ ] Write `docs/targets/` pages from the pinned facts.
3. [ ] Restructure the top of `README.md` and remove duplication by linking.
4. [ ] Fix broken links in `mobile/README.md` and `desktop/README.md`.
5. [ ] Re-run all doc tests and the three npm scripts.
