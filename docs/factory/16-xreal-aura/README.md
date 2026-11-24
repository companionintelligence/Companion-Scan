# Wave 16 — XREAL Aura

On 2026-11-24 the owner asked for a build target for XREAL Aura, pointing at XREAL's developer
documentation (`https://tutorials.xreal.com/docs/aura/developers/`).

Aura is a pair of wired XR glasses with optical see-through displays, tracked by the glasses
themselves. Its apps run on Android XR, on the Compute Puck the glasses plug into. This wave:

- names Aura as a target;
- builds for it what can be built and tested without the device;
- lines up the device run that decides how Aura captures.

The target page is [docs/targets/xreal-aura.md](../../targets/xreal-aura.md). It holds the
device's documented facts, with sources, and the first-run list.

## What the documents settle, and what they leave open

Read on 2026-11-24:

- **Settled:**
  - A phone app runs unchanged on Android XR, as a panel in Home Space.
  - Chrome on Android XR has WebXR `immersive-ar`, with hit test and anchors.
  - Developer mode and `adb` work through the puck's ports.
- **Open:**
  - Whether an app can read the glasses' camera, and through which permission.
  - Whether the Android WebView has WebXR.
  - Whether classic ARCore runs at all.
  - Which Android version and API level the puck runs.
  - Which system feature names Android XR reports.

Two runtimes Scan already has are ruled out on Aura:

- **ARCore** (`com.google.ar.core`): no page documents it on Android XR.
- **The 8th Wall engine** tracks from the camera and the motion sensors of the device it runs on.
  Here that device is the puck, so the sensors are most likely the puck's. This is an inference,
  and the first run checks it.

That leaves WebXR, in Chrome (the existing Web, WebXR target) or in the app's WebView, and a
native runtime on Android XR's own APIs.

## Tickets

| # | Ticket | Status | Depends on |
|---|---|---|---|
| 0001 | [The Aura build: the Android shell, running WebXR alone](0001-aura-build-target.md) | done in this wave's first change; not run on a device | none |
| 0002 | [First run on an Aura](0002-first-run-on-an-aura.md) | planned; needs the owner's device | 0001 |
| 0003 | [A native capture runtime on Android XR](0003-native-android-xr-capture.md) | planned; waits on 0002's answers and the owner's go-ahead | 0002 |

## Atlas

This wave's atlas pass, on 2026-11-24, added:

- a wave card;
- a done diff on the "Android shell builds" card, for the Aura build (0001);
- a planned diff on the "Native AR runtimes (ScanAR)" card, for an Android XR runtime (0003).

Until that pass, the atlas named no Android XR or Aura target (gap filled).

## Verification available on this machine

- The Aura web bundle and its debug APK build here. Mobile Build has a job for the APK.
- Unit tests and `npm run verify` run here, and the built bundle runs in Chromium, which has no WebXR AR.
- No Aura is connected to this machine, and the XR glasses emulator is not listed for Linux
  hosts. Nothing in this wave has run on a device or an emulator.

## Decisions for the owner

1. Installing a build on an Aura: each install needs the owner's yes (0002).
2. Whether to go on to a native runtime (0003). It brings:
   - preview Jetpack XR libraries and Kotlin into the shell;
   - their lockfile and notice entries;
   - new permissions, `android.permission.HEAD_TRACKING` and the camera's.
3. Whether the Aura APK stays a target if capture turns out to belong to Chrome. The APK would
   then be the editor and viewer in a panel.
