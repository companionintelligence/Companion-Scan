# Web, 8th Wall: iPhone and iPad Safari

The scanner as a web page, tracked by the 8th Wall XR Engine. This is the path for iPhone and
iPad Safari, which have no WebXR AR.

## What it is

- `index.html` loads the engine, `public/xr.js`, with the `slam` chunk preloaded, on every load
  except three: `?ar=webxr` (the [WebXR path](web-webxr.md)), `?mock=xr8` (the scripted engine the
  tests use), and the desktop app, which carries no engine.
- `src/main.ts` waits for the engine and starts the scanner on the 8th Wall provider,
  `src/ar/eighthwall.ts`. If the engine does not arrive, the scanner tries WebXR, which Safari does
  not have.
- 8th Wall runs its own SLAM. It needs no ARCore and no WebXR, so the same page uses it in any
  browser opened at `/`, Android Chrome included. Android Chrome reaches WebXR only with
  `?ar=webxr`, which `/webxr.html` adds.
- The engine is Niantic Spatial's XR Engine: free to use, proprietary, and not open source. It
  carries its own licence agreement, reproduced in the header of `public/xr.js` and separate from
  this repository's licence ([NOTICE.md](../../NOTICE.md)).
- The web app is a PWA: it can be added to the home screen, and its offline queue holds uploads,
  keyframes, patches, jobs, summaries and project writes until the network returns.

## Status

- **iPhone and iPad Safari: not verified.** No run on an iPhone or iPad is recorded.
  [AR_DEVICE_SUPPORT.md](../operations/AR_DEVICE_SUPPORT.md) marks the iPhone 8th Wall path
  UNVERIFIED ("the platform 8th Wall exists for, never measured here"), and the device
  [results matrix](../testing/DEVICE_TESTING.md#results-matrix) in DEVICE_TESTING.md is empty.
- **The one 8th Wall device result is in Android Chrome.** On an XREAL Beam Pro the engine
  starts, tracks NORMAL and fits the camera to the canvas, but only about 2 starts in 8 get past
  the camera stream to video; the rest stall there. Expect to press Start more than once
  ([AR_DEVICE_SUPPORT.md](../operations/AR_DEVICE_SUPPORT.md#xreal-beam-pro)).
- **Build.** The web bundle built at commit `81e437c`, the tree `main` merged as `e897380`
  (#282), on 2026-11-23 ([Builds of the merged tree](README.md#builds-of-the-merged-tree)).
- **The automated tests use a scripted engine, not the real one.**
  `public/test-fixtures/xr8-mock.js`, loaded with `?mock=xr8`, sends poses, feature points and a
  fake camera feed. Playwright cannot drive Safari on a real iPhone (`playwright.config.ts`).

## Entry points and files

| What | Where |
|---|---|
| Scanner and uploader | `/?project=default`, the entry [DEVICE_TESTING.md](../testing/DEVICE_TESTING.md#prerequisites) uses |
| Share-link entry | `scanner.html?world=default`, the entry [DEVICE_TEST_KIT.md](../testing/DEVICE_TEST_KIT.md#surfaces) uses. `scanner.html` forwards to `/` with its query and hash |
| Triage page | `/smoke.html?debug=remote` |
| Page and engine loader | `index.html` |
| Runtime choice | `src/main.ts`, section 3 (AR runtime detection) |
| Provider | `src/ar/eighthwall.ts`, behind `ARProvider` (`src/ar/provider.ts`) |
| Engine files | `public/xr.js`, `public/xr-slam.js` (the `slam` chunk), `public/xr-face.js`, `public/resources/` |
| Scripted engine for tests | `public/test-fixtures/xr8-mock.js` |
| Offline queue | `public/sw.js`, `src/pwa.ts` |

## Build

A phone opens the page the server serves, so there is nothing to install on the device.

- Development: `npm start` serves the app over HTTPS on `:5173` and the API on `:8000`
  ([README.md](../../README.md#quick-setup)).
- Production bundle: `npm run build` (type check, then `vite build`).
  [DEPLOY.md](../operations/DEPLOY.md) serves it with `vite preview` under systemd.
- Public site: the same static build on Cloudflare Pages, with no server behind it, so sign-in,
  saved projects, Companion Memory and the vision model are not there
  ([DEPLOY.md](../operations/DEPLOY.md#the-public-site-scancicomputer)).

The engine is committed at `public/xr.js`: there is nothing to download.

## Run

1. Put the phone on the tailnet: the Tailscale app installed, logged in, VPN on. Safari opens the
   camera only over HTTPS, and a `tailscale cert` certificate loads with no warning.
2. On the box, start the servers: `npm start`, or the systemd units in
   [DEPLOY.md](../operations/DEPLOY.md).
3. On the box, run `npm run qr -- "/?project=default"` and scan the code with the phone. Or type
   `https://<host>:5173/?project=default` into Safari.
4. Select or create a Place, calibrate, and tap **Scan a Place**. The camera and motion prompts
   must come from that tap.

To read the phone's console on the box, run `npm run logs:watch` and add `?debug=remote` to the
page address.

## Test

On a device:

- [DEVICE_TESTING.md](../testing/DEVICE_TESTING.md): the
  [60-second triage](../testing/DEVICE_TESTING.md#60-second-triage--smokehtml) first, then
  [Checklist A](../testing/DEVICE_TESTING.md#checklist-a--iphone-safari-8th-wall-slam) with its
  calibrated-origin rows (A-origin). Record the run in the
  [results matrix](../testing/DEVICE_TESTING.md#results-matrix).
- [DEVICE_TEST_KIT.md](../testing/DEVICE_TEST_KIT.md): `npm run device:preflight` on the box, then
  [Phone, web scanner](../testing/DEVICE_TEST_KIT.md#phone-web-scanner).
- The room-loop benchmark in DEVICE_TESTING.md asks for one device on each runtime, this one
  included, and the compass spin test (B2 step 4) is run on iPhone Safari as well.

Without a device:

- `npm test` (WebKit, desktop) and `npm run test:mobile` (WebKit with the iPhone 15 profile).
  `npm run test:iphone` runs the same profile against the live tailnet address: no real device,
  no USB.
- `npm run test:mock` runs the `mock-*` specs in headless Chromium; the `mock-xr8-*` ones run the
  scanner on the scripted engine. `npm run test:box` runs that loop on its own servers.
- WebKit cannot grant camera and motion permission from a script, so those prompts are checked on
  a device.

## Known gaps

- Nothing on this path has run on an iPhone or iPad.
- The hosted web app serves the engine and shows no Niantic notice; the apps show one. Whether
  section 1.3.2 of the Agreement asks the web app for one is the owner's call
  ([mobile/README.md](../../mobile/README.md#gates)).
- Person capture opens its own camera stream beside the engine's. Whether iOS Safari allows both
  is Checklist C1, which has not run
  ([DEVICE_TESTING.md](../testing/DEVICE_TESTING.md#c1--8th-wall-camera-contention-blocking-may-reorder-the-feature)).
- Safari has no WebXR AR. On iOS the WebXR path needs a WebXR browser such as HelloXR
  ([web-webxr.md](web-webxr.md)).
