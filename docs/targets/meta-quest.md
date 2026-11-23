# Meta Quest app

A native app for Meta Quest headsets.

## What it is

Planned. There is no code for it in this tree: no project, no plugin and no build.

Planning: [ADR 0013](../adr/0013-the-quest-app-is-a-native-spatial-sdk-app-that-feeds-the-same-server.md)
and [wave 13](../factory/13-device-targets/README.md).

## Status

Not built. Nothing has run.

What runs on a Quest today is the web path, in the Quest Browser: the WebXR scanner
(`/webxr.html`) and the headset world editor (`xr-world.html`). Neither has run on a Quest; see
[web-webxr.md](web-webxr.md).

## Entry points and files

None in this tree.

## Build

Nothing to build.

## Run

Nothing to run. Use the Quest Browser path in [web-webxr.md](web-webxr.md#run).

## Test

No checklist exists for the app. The Quest Browser checks are
[Procedure 6](../testing/DEVICE_TESTING.md#procedure-6--webxr-runtimes-resets-tracking-loss-and-anchors-dx6)
(DX6) in DEVICE_TESTING.md and the
[headset editor steps](../testing/DEVICE_TEST_KIT.md#quest-headset-edit-a-place) in
DEVICE_TEST_KIT.md; [web-webxr.md](web-webxr.md#test) lists them with the rest of the web path.

## Known gaps

All of it: the app is planned and not built.
