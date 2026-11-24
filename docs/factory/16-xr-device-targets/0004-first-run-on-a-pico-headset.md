> **Type:** Docs / device test
> **Wave:** 16-xr-device-targets
> **Branch:** `docs/pico-first-run`
> **Commit style:** `docs(pico): summary`
> **Design:** the first-run list in `docs/targets/pico.md`
> **Dependencies:** 0001

## Goal

Run the WebXR-only build (`docs/targets/android-webxr.md`), and PICO Browser's `/webxr.html`, on a
real PICO headset. Write down what the platform exposes, so ticket 0005 can be decided on facts
rather than on the documents' gaps. Do it on PICO OS 5 (the headsets on sale) and, when one is
available, on PICO OS 6 (PICO Space Pro), whose WebView is documented to have WebXR.

## Non-goals

- Do not change code in this ticket. A defect found goes into a ticket of its own; the Back
  question (check 2) is the likeliest.
- Do not install anything on the device without the owner's yes for that install.
- Do not tap through any device prompt on the owner's behalf.

## Pinned conventions

- The eight checks are the ones in [pico.md](../../targets/pico.md#first-run-on-a-pico-headset-what-to-record),
  in that order. Record each with the date, the build's commit, the headset and its PICO OS version.
- Results go into `docs/targets/pico.md` (Status) and `docs/operations/AR_DEVICE_SUPPORT.md`.
  A result counts as verified only when someone ran it on the hardware and read the output back
  (`docs/targets/README.md`).
- Privacy: no coordinate, address or host name from the test site goes into the repository. Use
  `https://<host>:<port>` for the server.

## Before implementation

- `docs/targets/pico.md`, all of it.
- `docs/testing/DEVICE_TEST_KIT.md`, "Android native shell": `chrome://inspect` on a debug build.

## Open questions & answers

- Q: Which build goes on the device? — A: the Mobile Build `android-webxr` job's artifact,
  `scan-android-webxr-debug-apk`, or a local `npm run build:webxr` build. Builds signed with
  different keys replace each other only after an uninstall, which removes the app's scans.
- Q: Which PICO headset, and which PICO OS version, does the owner have? — OPEN
- Q: Can the PICO Emulator stand in for PICO OS 6? — Partly. It runs the full PICO OS 6 image, but
  only on Windows or Apple-silicon macOS, and PICO's Camera Pack sample says the passthrough camera
  is not available in the editor or simulator. Checks 4 and 5 could run there; check 6 needs a headset.

## Files impacted

Changed: `docs/targets/pico.md`, `docs/operations/AR_DEVICE_SUPPORT.md`, this ticket.

## Schema required

None.

## Definition of Done

- [ ] All eight checks are recorded, with the date, the build, the headset and its PICO OS version.
- [ ] Ticket 0005's open questions on the camera, the headset and the PICO OS version are answered from them.

## Tests

- [ ] None in code. The record itself is the output.

```
adb shell getprop ro.build.version.release
adb shell getprop ro.build.version.sdk
adb shell getprop ro.product.model
adb shell pm list features
adb shell dumpsys media.camera
```

## Acceptance Criteria

- [ ] A reader of `pico.md` can tell, for each of the eight checks, what was seen on which headset
  and PICO OS version, and what was not tried.

## Risks / potential issues

- **Risk:** the WebView answers `isSessionSupported('immersive-ar')` with true, and a session then
  fails. — **Mitigation:** record both answers. The scanner's own preflight treats a yes from the
  browser as weak evidence.
- **Risk:** a screen of Scan cannot be left without a Back button. — **Mitigation:** check 2 lists
  every such screen; the fix is a ticket of its own.
- **Risk:** `dumpsys` output names the device's own identifiers. — **Mitigation:** keep only the
  camera lines in the repository.

## Subtasks

1. [ ] Install the build, with the owner's yes, and run checks 1 to 6 in the app.
2. [ ] Run check 7 in PICO Browser and check 8 on the Places map.
3. [ ] Write the results into the target page and AR_DEVICE_SUPPORT.md.
