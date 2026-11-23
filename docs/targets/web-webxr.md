# Web, WebXR: Android Chrome and Meta Quest Browser

The same scanner page on a native WebXR `immersive-ar` session instead of the 8th Wall engine.
It is for browsers with WebXR AR: Chrome on an Android device with ARCore, and the Meta Quest
Browser, which open it directly. Safari on iOS has no WebXR AR, so on an iPhone the page has to be
opened inside a WebXR-enabled iOS browser such as HelloXR.

## What it is

- `/webxr.html` asks `navigator.xr.isSessionSupported('immersive-ar')`. When the answer is yes, it
  forwards to the scanner at `/?ar=webxr`, keeping the rest of the query. When it is no, it says
  so and offers the 8th Wall scanner. On iOS it also offers
  [HelloXR](https://apps.apple.com/us/app/helloxr/id6757726359), a WebXR-enabled iOS browser,
  because Safari has no WebXR AR.
- Under `?ar=webxr`, `index.html` does not load the 8th Wall engine at all, and `src/main.ts`
  starts the WebXR provider, `src/ar/webxr.ts`.
- The session is requested in `start()` of `src/ar/webxr.ts`: `hit-test` is required;
  `dom-overlay`, `local-floor` and `anchors` are optional, and `document.body` is the overlay root,
  so the HUD stays visible over the camera. A runtime without `local-floor` falls back to a `local`
  reference space.
- WebXR exposes no SLAM feature points, so the point cloud grows from per-frame hit-test samples.
  Sweep the camera slowly across surfaces: points grow slower than with SLAM, as expected.
- Capture frames come from a second camera stream (`getUserMedia`) beside the session, because
  WebXR raw camera access is not used. A capture whose companion video has frozen is refused
  rather than re-encoding the old frame.
- Runtime anchors are asked for, not used yet. When the browser grants `anchors`, the capability
  exists (`src/ar/anchors.ts`), and the build makes no anchor of its own
  ([AR_DEVICE_SUPPORT.md](../operations/AR_DEVICE_SUPPORT.md#what-is-built-and-what-is-not)).
- The 🥽 button in the scanner and the WebXR scanner link in the editor move between the two
  runtimes. In WebXR mode the button links back to the 8th Wall scanner; in the 8th Wall scanner it
  appears only when `immersive-ar` is supported.
- On a headset, `xr-world.html?world=<slug>` is the world editor (`src/viewer/xr-world.ts`): enter
  VR, then select, relabel and move a Thing with a controller. The edits are saved as patches.

## Status

- **Android Chrome with ARCore: a session start was seen once, and nothing after it.** On
  2026-08-23 an ARCore Android tablet (Galaxy Tab S8 Ultra), driven over MCP from a desk and never
  moved, loaded `/webxr.html` over the Tailscale certificate, passed the support probe, forwarded,
  started an `immersive-ar` session and showed the HUD over it: Checklist B steps 1 and 2.
  Tracking, capture and the calibration decal (B2 steps 1 to 6) need a person carrying the device,
  and are unverified ([DEVICE_TESTING.md](../testing/DEVICE_TESTING.md#results--b2)).
  [AR_DEVICE_SUPPORT.md](../operations/AR_DEVICE_SUPPORT.md) lists that tablet's WebXR path as
  UNVERIFIED.
- **A device without ARCore cannot run it: verified.** On an XREAL Beam Pro, which has no ARCore,
  `isSessionSupported('immersive-ar')` answers true and `requestSession()` then rejects with
  `NotSupportedError`. Nothing in the app can fix that; the device needs Google Play Services for
  AR ([AR_DEVICE_SUPPORT.md](../operations/AR_DEVICE_SUPPORT.md#the-webxr-path-is-dead-and-permanently)).
- **Meta Quest Browser: documented claims only.** WebXR `immersive-ar` (passthrough) and anchors
  are documented, and no row of the runtime-anchor table is verified
  ([AR_DEVICE_SUPPORT.md](../operations/AR_DEVICE_SUPPORT.md#runtime-anchors-where-they-exist-and-what-the-app-does-with-them)).
  The headset editor has three Playwright tests on the iwer Quest 3 emulator and no run on a Quest
  ([DEVICE_TEST_KIT.md](../testing/DEVICE_TEST_KIT.md#surfaces)).
- **iOS through HelloXR: no run is recorded.**
- **Automated.** `?ar=webxr&mock=webxr` installs the iwer emulation runtime
  (`src/test/webxr-emulation.ts`), and the `mock-webxr-*` and `mock-xr-world` specs run on it in
  headless Chromium.

## Entry points and files

| What | Where |
|---|---|
| WebXR entry | `/webxr.html`, the entry Checklist B uses. It forwards to `/?ar=webxr` |
| Direct | `/?ar=webxr`, with any other parameter the scanner reads (`debug`, `project`, `world`) |
| Headset world editor | `xr-world.html?world=<slug>`, `src/viewer/xr-world.ts` |
| Provider | `src/ar/webxr.ts` (session features in `start()`) |
| Runtime anchors and frame epochs | `src/ar/anchors.ts`, `src/ar/frame-epoch.ts` |
| Emulation runtime | `src/test/webxr-emulation.ts` (`?mock=webxr`) |

## Build

The same web build as the 8th Wall path: `npm start` in development, `npm run build` for the
bundle that [DEPLOY.md](../operations/DEPLOY.md) serves. A device needs nothing installed.

## Run

1. On the box: `npm start`, or the systemd units in [DEPLOY.md](../operations/DEPLOY.md).
2. Android: put the device on the tailnet, run `npm run qr -- "/webxr.html"` on the box and scan
   the code. Quest: type `https://<host>:5173/webxr.html` into the Quest Browser.
3. The page forwards into the scanner. Tap **Start AR** and grant the camera.

For the headset editor, open `https://<host>:5173/xr-world.html?world=<slug>` in the Quest Browser
and press Enter VR.

## Test

On a device:

- [Checklist B](../testing/DEVICE_TESTING.md#checklist-b--android-chrome-webxr) and
  [B2](../testing/DEVICE_TESTING.md#b2--calibration-anchor-decal-webxr-renderer-verification), the
  WebXR renderer and the calibration decal, in DEVICE_TESTING.md. B2 needs an ARCore-backed Android
  device; a Quest is a useful second data point and not required.
- [Procedure 6](../testing/DEVICE_TESTING.md#procedure-6--webxr-runtimes-resets-tracking-loss-and-anchors-dx6)
  (DX6): resets, tracking loss and anchors, on a Chrome ARCore phone and on a Quest. Steps 7 to 13
  wait for WP-17b.
- [DEVICE_TEST_KIT.md](../testing/DEVICE_TEST_KIT.md#quest-headset-edit-a-place): the Quest headset
  editor steps.
- Steps 1 and 2 of Checklist B can be driven remotely over MCP
  ([remote-controlled testing](../testing/DEVICE_TESTING.md#remote-controlled-testing-android-remote-control-mcp));
  the steps after them need the device carried through a room.

Without a device: `npm run test:mock` runs the `mock-webxr-*` and `mock-xr-world` specs on the
emulator. `tests/mock-webxr-session-failure.spec.ts` imitates a device that answers true and then
refuses the session.

## Known gaps

- Nothing past a session start has run on an Android device, and nothing has run on a Quest.
- Whether the Quest Browser draws the page's overlay inside the session is not confirmed
  (Procedure 6).
- Android Chrome opens the 8th Wall scanner at `/`. It reaches this path only through
  `/webxr.html` or `?ar=webxr`. Whether Android Chrome should default to WebXR is owner decision D11.
- The companion camera stream and the session can contend for the camera. On a Lume Pad 2
  (ARCore, Chrome 151) the video froze while it still reported data; a capture is refused in that
  case (`src/ar/webxr.ts`).
- The build asks for `anchors` and makes none yet. Of these browsers only the Quest Browser
  documents persistent anchors, as a small device-local cache.
- The Android app's WebView has no WebXR AR ([android-arcore.md](android-arcore.md)).
