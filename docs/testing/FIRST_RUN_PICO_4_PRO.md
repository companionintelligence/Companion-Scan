# First run on a PICO 4 Pro

One pass through the scanner's PICO paths: PICO Browser at `/webxr.html`, and the WebXR-only Android build. It
follows the first-run list in [pico.md](../targets/pico.md#first-run-on-a-pico-headset-what-to-record) (ticket 0004)
and the device kit's order. Nothing has run on a PICO headset yet. The answers decide whether a native PICO app is
worth building (ticket 0005): above all, whether an app or a browser can read the passthrough camera. Write the
results back into `pico.md` (Status) and [AR_DEVICE_SUPPORT.md](../operations/AR_DEVICE_SUPPORT.md), with the date,
the build and the PICO OS version.

Sister checklists: [FIRST_RUN_XREAL_AURA.md](FIRST_RUN_XREAL_AURA.md), [FIRST_RUN_QUEST_3.md](FIRST_RUN_QUEST_3.md).

## Ground rules

- **Each install needs the owner's yes.**
- **Keyframes show a room.** Keep logs and screenshots out of the repository.
- The scanner's Android builds share one app id (`com.companionintelligence.scan`). The headset gets the WebXR-only
  build. A build signed with another key fails with `INSTALL_FAILED_UPDATE_INCOMPATIBLE`, and uninstalling it deletes
  that app's data, so that is the owner's call too.
- PICO headsets have no physical Back button and no system Back gesture: every screen must be left from the app's
  own controls.

## What you need

| What | Where |
|---|---|
| A Scan server the headset can reach over HTTPS | for example `https://<host>.<tailnet>.ts.net:5173`; open `/health` in PICO Browser first |
| The WebXR-only Android build | [android-webxr.md](../targets/android-webxr.md#build) (`app-debug.apk`); in the device kit, `scan-android-webxr-pico-xreal-debug.apk` |
| A computer with adb and desktop Chrome | `chrome://inspect` reads the app's WebView, which the debug build makes inspectable |

## 0. Connect

1. On the headset: Settings, then General, then About. Keep clicking Software Version until Developer appears in the
   left panel. Open Developer and turn on USB Debug.
2. Connect the headset to the computer with a USB cable, and allow USB debugging when the headset asks.
3. `adb devices -l`. A device listed as `unauthorized` is waiting for that answer.

**Record** (check 1):

```bash
adb shell getprop ro.build.version.release
adb shell getprop ro.build.version.sdk
adb shell getprop ro.product.model
adb shell getprop ro.build.display.id
adb shell pm list features > pico-features.txt
adb shell dumpsys media.camera > pico-cameras.txt
```

Also note the PICO OS version from Settings, General, About. The PICO 4 Pro runs PICO OS 5. No PICO page gives its
Android version or API level, so these lines are the first record of them.

## 1. PICO Browser, at `/webxr.html` (no install)

PICO documents WebXR in its browser on PICO OS 5 (Chromium M125). This is the capture path to try first.

1. In PICO Browser, open `https://<host>:<port>/webxr.html`.
2. The page forwards to `/?ar=webxr`. Press **Start AR**, and allow the camera when asked.

**Record** (checks 5 to 7):

- Whether the `immersive-ar` session starts, with passthrough.
- Whether the in-session status panel shows, and whether the trigger (`select`) on it starts and stops the scan, and
  captures. PICO does not list `dom-overlay`, so the page's own overlay is not expected inside the session.
- Whether a camera prompt appears, and whether frames are captured. If the console can be read (PICO Browser's own
  developer tools, or the WebView in step 2), note whether it says `[webxr] No camera stream — frame capture disabled`.
- After Stop: whether the session reaches the server, and whether its poses line up in the editor.

## 2. The WebXR-only app

Nobody knows yet whether PICO OS 5's WebView has WebXR. Without it the app is the editor, the viewer, the Places map,
the Server row and sign-in, with no capture.

```bash
adb install -r scan-android-webxr-pico-xreal-debug.apk
```

Open **Scan** and set the Scan server on the first-run screen's Server row.

**Record** (checks 2 to 6):

- **The window:** how the app opens, whether the portrait window suits the headset, and whether the controller's ray
  and a pinch act as taps. Whether every screen can be left from Scan's own controls.
- **Sign-in:** the shell signs in through a browser sheet and comes back on `com.companionintelligence.scan://auth`.
  Whether the sheet opens, in which browser, and whether the return reaches the app.
- **WebXR in the WebView**, in `chrome://inspect`:
  - `navigator.xr`, and `await navigator.xr?.isSessionSupported('immersive-ar')`;
  - `await Capacitor.Plugins.ScanAR.capabilities()`;
  - the start screen's headline and the line under it.
- **A scan, if the WebView has WebXR:** whether the session starts with passthrough, the console's `[webxr]` lines
  (which features were granted), whether the status panel shows, and whether the web window shows at the same time.
- **The cameras**, after allowing the camera:
  `(await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput')`. Then whether a scan
  captures frames, and what they show.
- **Location** (check 8): whether the Places map gets a fix, and how accurate it is.

## What to send back

`pico-features.txt`, `pico-cameras.txt`, the console notes from steps 1 and 2, and the date, the build and the PICO OS
version. The camera answer goes first: it decides ticket 0005.
