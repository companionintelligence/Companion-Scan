# Wave 19 — Ready for the first headset sessions

Wave 17 gave XREAL Aura and PICO a build and a page each. Nothing from this repository has run on a Quest or a PICO,
and on an Aura only the WebXR-only APK (no WebXR in its WebView) and the probe (at rest) have. This wave makes the
first sessions on all three headsets worth the owner's time:

- one first-run checklist per headset, with the exact commands;
- a WebXR page that can be driven inside a headset session, where no browser draws the page's own overlay;
- the detection service as an `/infer` engine, so a headset's frames get the same boxes on the box's GPU;
- CI for the Android XR probe, which compiles the Quest app's files.

It was drafted on 2026-11-25 from a review of every scanner path on the three headsets (the owner's planning session,
phase 1). The order is the review's: the [now] items, with Aura-native capture (wave 17, 0003) left until the probe's
worn run, and PICO-native capture (wave 17, 0005) until the first PICO run.

## Tickets

| # | Ticket | Status |
|---|---|---|
| 0001 | [First-run checklists for Aura, Quest 3 and PICO 4 Pro](0001-first-run-checklists.md) | planned |
| 0002 | [The WebXR page inside a headset session](0002-webxr-headset-session.md) | done; checked on the iwer emulator only |
| 0003 | [Grounding DINO as an `/infer` engine](0003-grounding-dino-engine.md) | done; checked against a fake service only |
| 0004 | [The Android XR probe in Quest Build](0004-probe-in-quest-build.md) | done; the workflow was not dispatched |

## Atlas

This wave's atlas pass:

- a wave card;
- a done diff on "Open-vocabulary detection service", which becomes an `/infer` engine, and the Inference
  environment rows for `INFERENCE_MODE`, `GDINO_URL` and `GDINO_TOKEN`;
- a done diff on "WebXR fallback provider", for the in-session panel and the camera model.

## Verification available on this machine

- `npm run verify`, the Playwright specs on the iwer emulator (`--project=chromium-mock`), and the probe's Gradle tests
  run here.
- No headset was connected. Every device step is in the checklists, for the owner.

## Decisions for the owner

1. Whether `INFERENCE_MODE=grounding-dino` becomes the box's default engine. It runs no description model, so each
   detection reads "A <label>" where Ollama gives a phrase.
2. The camera offsets: none is built in. Each headset's is measured once (the checklists say how) and given to the
   page as `?camoffset=` and `?camfov=`.
