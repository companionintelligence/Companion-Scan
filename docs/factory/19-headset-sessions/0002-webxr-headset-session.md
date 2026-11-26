> **Type:** Frontend
> **Wave:** 19-headset-sessions
> **Branch:** `phase1/headsets`
> **Commit style:** `WebXR: summary`
> **Design:** this ticket is the spec
> **Dependencies:** None

## Goal

Make the WebXR scanner usable inside a headset session. Quest Browser, PICO and Chrome on Android XR do not draw the
page's `dom-overlay`, so today a headset user sees no HUD and has no control once the session starts. And on a headset
the viewer pose and the view's projection are the eyes', not the camera's that the keyframes come from.

## Non-goals

- Do not change the phone path: a session that was granted `dom-overlay` behaves as before.
- Do not add a second scan, stream or capture path: the panel presses the scanner's own controls.
- Do not build a default camera offset for any device: none has been measured.
- Do not change the keyframe `meta` shape.

## Pinned conventions

- **ADR 0001.** No new type in the domain model, no server change. The panel drives `#stream-btn`, `#capture-btn` and
  the keyframe consent dialog's own buttons, so consent, busy guards and streaming stay the scanner's. The camera model
  changes only what `captureFrame()` stamps on a frame (`RawFrame.pose`) and what `getCameraFovY()` and
  `getCameraAspect()` answer, which the keyframe intrinsics and the capture camera already read.
- `select` is the input: WebXR fires it for a controller's trigger and for a hand's pinch.
- The camera model comes from the address (`?camoffset=x,y,z`, `?campitch=`, `?camfov=`; `?camera=clear`) and is kept
  in `localStorage` under `scan-xr-camera-model`, a new key.

## Before implementation

- `src/ar/webxr.ts` (`setUpSession`, the frame loop, `captureFrame`), `src/main.ts` (`stream-btn`, `capture-btn`),
  `src/ui/keyframe-consent-ui.ts`, `src/test/webxr-emulation.ts`, `tests/mock-webxr-emulated.spec.ts`.

## Open questions & answers

- Q: When does the panel show? — A: When the session has no `dom-overlay` (`domOverlayState` absent). `?xrpanel=on` or
  `off` overrides it.
- Q: Head-mounted or not? — A: A viewer pose with more than one view. Only then can the camera model apply.
- Q: Where do the consent question's words come from? — A: From the open dialog itself (its heading and paragraphs),
  so the panel shows what the page would, and imports none of the consent modules, which only `main.ts` may
  (`wp-15b-keyframe-controller.test.ts`, "no part of the app but the consent modules and the panel row reads the
  answer").
- Q: What if the panel cannot be built (no 2-D canvas)? — A: The session starts without it; the panel is an aid.

## Files impacted

- New: `src/ar/xr-panel-layout.ts`, `src/ar/xr-session-panel.ts`, `src/ar/xr-camera-model.ts`,
  `tests/mock-webxr-session-panel.spec.ts`, `tests/unit/node/wp-19-xr-session-panel.test.ts`,
  `tests/unit/node/wp-19-xr-camera-model.test.ts`.
- Changed: `src/ar/webxr.ts`, `docs/targets/pico.md`, `docs/targets/xreal-aura.md`, `docs/factory/atlas.html`.
  `docs/targets/web-webxr.md` belongs to the phones-and-web branch, so it is left for that branch: its Quest lines
  still describe the page without the panel.

## Schema required

None.

## Definition of Done

- [x] With no `dom-overlay`, a world-locked panel shows the scanner's status, and `select` on its buttons starts and
  stops streaming, captures, and answers the consent question.
- [x] With a camera model on a head-mounted session, frames carry the camera's pose and the camera's field of view.

## Tests

- [x] Unit: the panel's layout, placement and ray test; the camera model's parsing, storage and pose
  (`wp-19-xr-session-panel.test.ts`, `wp-19-xr-camera-model.test.ts`, in `npm run test:wave`).
- [x] Playwright on the iwer emulator, with no `dom-overlay`: the panel shows, and a trigger press on its buttons
  reaches the scanner's own controls (`tests/mock-webxr-session-panel.spec.ts`).
- [x] `npm run verify`.

## Acceptance Criteria

- [x] Given an emulated Quest 3 session without `dom-overlay`, when the trigger is pressed on Start, then the scanner's
  stream toggle runs.
- [ ] Given a real headset, the same. Not run: no headset was connected (the checklists, 0001).

## Risks / potential issues

- **Risk:** a real headset fires `select` differently (on release, not press). — **Mitigation:** one action per
  `select`, whichever moment it comes.

## Subtasks

1. [x] The panel, the camera model, their tests and the docs.
