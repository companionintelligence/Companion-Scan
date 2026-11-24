# Wave 17 — XR device targets: XREAL Aura and PICO

Numbered 17 because wave 15 (AR runtime targets, #283) and wave 16 (the Spatial Editor, #298)
merged first, on the same day.

On 2026-11-24 the owner asked for two build targets, each with a pointer to the maker's developer
documentation:

- **XREAL Aura** (`https://tutorials.xreal.com/docs/aura/developers/`): wired XR glasses with
  optical see-through displays, tracked by the glasses. Apps run on Android XR, on the Compute Puck
  the glasses plug into.
- **PICO** (`https://developer.picoxr.com/document/`): standalone headsets running PICO OS, which
  is built on Android. PICO OS 5 runs on the headsets on sale (PICO 4, PICO 4 Ultra, Neo3), and
  PICO OS 6 runs on PICO Space Pro (2026) and the PICO Emulator.

Both run apps on Android without ARCore, and both document WebXR in a browser. So they share one
build: the Android app with a web bundle that runs WebXR alone and leaves the 8th Wall engine out.
This wave:

- adds that build;
- gives each device a page with its documented facts, sources and a first-run list;
- lines up the device runs that decide how each captures.

Pages:

- [android-webxr.md](../../targets/android-webxr.md): the build.
- [xreal-aura.md](../../targets/xreal-aura.md) and [pico.md](../../targets/pico.md): the devices.

## What the documents settle, and what they leave open

Read on 2026-11-24:

- **Settled:**
  - Phone apps run unchanged on both: on Android XR in a panel, on PICO OS 6 in a 2D window.
  - Each documents WebXR `immersive-ar` with hit test and anchors in its browser: Chrome on
    Android XR, and PICO's browser.
  - PICO OS 6 documents WebXR in its WebView too, so on Space Pro the APK may capture.
  - PICO OS 6 has no Google Play Services, so no classic ARCore.
- **Open, and the subject of the first runs:**
  - whether apps or a WebView's `getUserMedia` can read the cameras (Aura documents nothing;
    PICO keeps frames inside a protected runtime);
  - whether the WebView has WebXR on Android XR and on PICO OS 5;
  - the Android version and API level of each;
  - on Aura, whether the motion sensors are the puck's.

## Tickets

| # | Ticket | Device | Status | Depends on |
|---|---|---|---|---|
| 0001 | [The WebXR-only Android build](0001-webxr-only-android-build.md) | both | done in this wave's first changes; not run on a device | none |
| 0002 | [First run on an Aura](0002-first-run-on-an-aura.md) | XREAL Aura | planned; needs the owner's device | 0001 |
| 0003 | [A native capture runtime on Android XR](0003-native-android-xr-capture.md) | XREAL Aura | planned; waits on 0002 and the owner's go-ahead | 0002 |
| 0004 | [First run on a PICO headset](0004-first-run-on-a-pico-headset.md) | PICO | planned; needs the owner's device | 0001 |
| 0005 | [A native capture app for PICO](0005-native-pico-capture.md) | PICO | planned; waits on 0004 and the owner's go-ahead | 0004 |

## Atlas

This wave's atlas pass, on 2026-11-24, added:

- a wave card;
- a done diff on the "Android shell builds" card, for the WebXR-only build (0001);
- a planned diff on the "Native AR runtimes (ScanAR)" card, for native runtimes on Android XR and PICO (0003, 0005).

Until that pass, the atlas named neither an Android XR nor a PICO target (gap filled).

## Verification available on this machine

- The WebXR-only bundle and its debug APK build here, and Mobile Build has a job for the APK.
- Unit tests and `npm run verify` run here. The built bundle runs in Chromium, which has no
  WebXR AR.
- No Aura or PICO headset is connected to this machine. Neither maker's emulator lists Linux as a
  host: Google's XR glasses emulator and the PICO Emulator run on Windows and macOS. Nothing in
  this wave has run on a device or an emulator.

## Decisions for the owner

1. Installing a build on either device: each install needs the owner's yes (0002, 0004).
2. Whether to go on to native runtimes (0003, 0005).
   - On Android XR that means preview Jetpack XR libraries and Kotlin in the shell, or a separate app.
   - On PICO it means a separate app, since the PICO Spatial SDK needs `minSdk` 35 and Kotlin 2.
   - Either way, new permissions, and only if the cameras are open to apps.
3. Whether the WebXR-only APK stays a target on a device whose WebView turns out to have no WebXR.
   It would then be the editor and viewer in a panel, with the browser as the capture path.
