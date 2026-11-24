> **Type:** Docs / device test
> **Wave:** 16-xr-device-targets
> **Branch:** `docs/aura-first-run`
> **Commit style:** `docs(aura): summary`
> **Design:** the first-run list in `docs/targets/xreal-aura.md`
> **Dependencies:** 0001

## Goal

Run the WebXR-only build (`docs/targets/android-webxr.md`), and Chrome's `/webxr.html`, on a real XREAL Aura. Write down what the
platform exposes, so ticket 0003 can be decided on facts rather than on the documents' gaps.

## Non-goals

- Do not change code in this ticket. A defect found goes into a ticket of its own.
- Do not install anything on the device without the owner's yes for that install.
- Do not tap through Play Protect or any other device prompt on the owner's behalf.

## Pinned conventions

- The seven checks are the ones in [xreal-aura.md](../../targets/xreal-aura.md#first-run-on-an-aura-what-to-record),
  in that order. Record each with the date, the build's commit, and the device's Android version.
- Results go into `docs/targets/xreal-aura.md` (Status) and `docs/operations/AR_DEVICE_SUPPORT.md`.
  A result counts as verified only when someone ran it on the hardware and read the output back
  (`docs/targets/README.md`).
- Privacy: no coordinate, address or host name from the test site goes into the repository. Use
  `https://<host>:<port>` for the server.

## Before implementation

- `docs/targets/xreal-aura.md`, all of it.
- `docs/testing/DEVICE_TEST_KIT.md`, "Android native shell": `chrome://inspect` on a debug build.

## Open questions & answers

- Q: Which build goes on the device? — A: the Mobile Build `android-webxr` job's artifact,
  `scan-android-webxr-debug-apk`, or a local `npm run build:webxr` build. Builds signed with different keys replace each other only after an
  uninstall, which removes the app's scans.
- Q: Does the owner have the Aura on a computer that can run `adb`? — OPEN

## Files impacted

Changed: `docs/targets/xreal-aura.md`, `docs/operations/AR_DEVICE_SUPPORT.md`, this ticket.

## Schema required

None.

## Definition of Done

- [ ] All seven checks are recorded, with the date and the build.
- [ ] Ticket 0003's open questions on the camera, the API level and the feature names are answered from them.

## Tests

- [ ] None in code. The record itself is the output.

```
adb shell getprop ro.build.version.release
adb shell getprop ro.build.version.sdk
adb shell pm list features
adb shell dumpsys media.camera
adb shell dumpsys sensorservice
```

## Acceptance Criteria

- [ ] A reader of `xreal-aura.md` can tell, for each of the seven checks, what was seen on the
  device, and what was not tried.

## Risks / potential issues

- **Risk:** the WebView answers `isSessionSupported('immersive-ar')` with true, and a session then
  fails. — **Mitigation:** record both answers. The scanner's own preflight treats a yes from the
  browser as weak evidence.
- **Risk:** `dumpsys` output names the device's own identifiers. — **Mitigation:** keep only the
  camera and sensor lines in the repository.

## Subtasks

1. [ ] Install the build, with the owner's yes, and run checks 1 to 5 in the app.
2. [ ] Run check 6 in Chrome and check 7 on the Places map.
3. [ ] Write the results into the target page and AR_DEVICE_SUPPORT.md.
