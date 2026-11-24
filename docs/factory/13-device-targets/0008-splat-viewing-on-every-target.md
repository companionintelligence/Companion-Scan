> **Type:** Frontend
> **Wave:** 13-device-targets
> **Branch:** `feat/splat-viewing-everywhere`
> **Commit style:** `feat(viewer): summary`
> **Design:** this ticket is the spec
> **Dependencies:** 0006

## Goal

On every target, a person can go from a finished capture to its splat in a few taps. Captures from every target reach `splat-train` through the session routes. Until this wave splats were viewable in the desktop and web viewers, but no capture target linked from a finished scan to its splat, and no native target could show one.

## Non-goals

- Do not add a second splat pipeline or a second viewer. Reuse `viewer.html` and the Quest app's viewer (0006).
- Do not train on a device. On-device training stays a recorded option, with Splatelier (Apache-2.0) and splatify-anything (PolyForm Noncommercial) as references only.

## Pinned conventions

- ADR 0001, ADR 0003 and ADR 0007. Every target's frames go through `POST /sessions/:id/keyframes`. `splat-train` is one of the keyframe job types (`KEYFRAME_JOB_TYPES`, `server/main.ts:5266`).
- How each target views a splat:

  | Target | Where it is viewed |
  |---|---|
  | Web, 8th Wall | the web viewer, in the browser |
  | Web, WebXR | the web viewer; on Quest Browser, in 2D |
  | Android apps | the web viewer inside the shell's WebView |
  | iOS app | the web viewer inside the shell's WebView |
  | Quest app | the Spatial SDK splat module (0006) |

- A splat link points at the existing viewer route for the scan. No new route is added.

## Before implementation

- Read `viewer.html`, `src/viewer/splat-toolbox.ts`, the splat artifact route in `server/main.ts`, and the splat job manifests (`.splat-train.manifest.json` and the rest).
- Read ADR 0007, on selectable backends and on which captures are reconstruction captures.

## Open questions & answers

- Q: Do the shells' WebViews render the viewer's splats at a usable frame rate? — OPEN until a device run.
- Q: Does `xr-world.html` show splats in VR on Quest? — OPEN. Read `src/viewer/xr-world.ts`.
- Q: Should a capture that ADR 0007 says is not a reconstruction capture (a rotation-only sweep) still offer the link? — A: No. The link appears only when `splat-train` finished ok.

## Files impacted

- Changed: the scanner's finish screen (`src/main.ts` or its UI module), possibly `src/viewer/splat-toolbox.ts`, and the docs pages in `docs/targets/`.

## Schema required

None.

## Definition of Done

- [ ] After `splat-train` finishes, the scanner shows a link to the scan's splat in the viewer.
- [ ] Each target page says how that target views a splat, and what has not run on a device.

## Tests

- [ ] A Playwright mock test: a finished `splat-train` manifest shows the link; a failed one does not.
- [ ] `npm run verify` passes.

```bash
npx playwright test --project=chromium-mock tests/<new-splat-link>.spec.ts
npm run verify
```

## Acceptance Criteria

- [ ] Given a finished splat job, when the person opens the link on any capture target, then the viewer loads the scan's splat.

## Risks / potential issues

- **Risk:** Splat files are large on phones and headsets. — **Mitigation:** Prefer the compressed output where the viewer supports it.
- **Risk:** WebView limits differ from Safari and Chrome. — **Mitigation:** Record the first shell runs.

## Subtasks

1. [ ] Find the finished-splat signal the viewer already reads.
2. [ ] Add the link on the scanner's finish screen.
3. [ ] Add the mock test.
4. [ ] Update the target pages.
