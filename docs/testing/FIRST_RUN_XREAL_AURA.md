# First run on an XREAL Aura

One pass through every scanner path on an XREAL Aura: the glasses on the Android XR Compute Puck. It merges the
first-run list in [xreal-aura.md](../targets/xreal-aura.md#first-run-on-an-aura-what-to-record) with the probe's
steps in [android-xr/README.md](../../android-xr/README.md) and the device kit's order. Work top to bottom. Each
section says what to record. Write the results back into `xreal-aura.md` (Status) and
[AR_DEVICE_SUPPORT.md](../operations/AR_DEVICE_SUPPORT.md), with the date, the build and the puck's software version.

Sister checklists: [FIRST_RUN_QUEST_3.md](FIRST_RUN_QUEST_3.md), [FIRST_RUN_PICO_4_PRO.md](FIRST_RUN_PICO_4_PRO.md).

## Ground rules

- **Each install needs the owner's yes,** and nobody may be wearing the glasses while adb installs or starts anything.
- **The probe never grants itself a permission.** Either the person wearing the glasses answers the prompts, or the
  owner says yes, in words, to `adb shell pm grant` (step 4).
- **A recording shows a room.** Keep recordings, screenshots and logs out of the repository, and delete them once read.
- The scanner's Android builds share one app id (`com.companionintelligence.scan`). The puck gets the WebXR-only build.
  A build signed with another key fails with `INSTALL_FAILED_UPDATE_INCOMPATIBLE`. Uninstalling it deletes that
  app's data, so that is the owner's call too.

## What you need

| What | Where |
|---|---|
| A Scan server the puck can reach over HTTPS | for example `https://<host>.<tailnet>.ts.net:5173`. Check `/health` from a browser first |
| The WebXR-only Android build | [android-webxr.md](../targets/android-webxr.md#build) (`app-debug.apk`); in the device kit, `scan-android-webxr-pico-xreal-debug.apk` |
| The Android XR probe | `cd android-xr && ./gradlew :probe:assembleDebug` (`probe/build/outputs/apk/debug/probe-debug.apk`); in the device kit, `scan-androidxr-probe-debug.apk` |
| A computer with adb and desktop Chrome | Chrome's `chrome://inspect` reads the app's WebView and Chrome's tabs on the puck |

## 0. Connect

1. On the puck: Settings, then About device. Tap Build number 7 times, then turn on USB debugging in Developer options.
2. Leave the glasses on the Glasses Port (the right side of the puck), and connect the computer to the Charging Port
   (the left side).
3. `adb devices -l`. A device listed as `unauthorized` is waiting for someone to allow USB debugging on the puck. Use
   its serial as `-s <serial>` below if more than one device is connected.
4. If the glasses' display does not come back after an adb session, plug the glasses in again (XREAL's guide).

**Record** (first-run check 1):

```bash
adb shell getprop ro.build.version.release
adb shell getprop ro.build.version.sdk
adb shell getprop ro.product.model
adb shell getprop ro.build.id
adb shell pm list features > aura-features.txt
```

2026-11-24 read Android 14, API 34, `Android_XR_Puck`, build `UXP4.261012.001.O5`. Note any change.

## 1. Chrome on the puck, at `/webxr.html` (no install)

This is the capture path to try first: Google documents WebXR `immersive-ar` with hit test and anchors for Chrome on
Android XR.

1. In Chrome on the puck, open `https://<host>:<port>/webxr.html`.
2. On the computer, open `chrome://inspect`, find the puck's Chrome tab and open its console.
3. The page forwards to `/?ar=webxr`. Tap **Start AR** (or pinch it) and allow the camera when asked.

**Record:**

- Whether the session starts, and the console's `[webxr]` lines: which features it was granted.
- Whether a camera prompt appears, and whether the console says `[webxr] No camera stream — frame capture disabled`.
  Then: `(await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput')`.
- Whether the in-session status panel shows, and whether a pinch starts and stops the scan.
- Whether the page's own overlay is drawn in the session (`dom-overlay`).
- After a short walk and Stop: whether the session reaches the server, and whether its poses line up in the editor.
- How readable the dark overlay is at the clearest and the darkest dimming levels (an additive display shows black as
  clear).

## 2. The WebXR-only app (expect no capture)

On 2026-11-24 the puck's WebView had no WebXR, so this app is expected to open without capturing. Its help line should
now send you to `/webxr.html` (ticket 0006, not yet seen on a device).

```bash
adb install -r scan-android-webxr-pico-xreal-debug.apk
```

Open **Scan** from the launcher and set the Scan server on the first-run screen's Server row.

**Record** (first-run checks 2 to 5, 7):

- Whether it opens as a panel in Home Space, whether the portrait panel fits the central part of the view, and whether
  a pinch acts as a tap.
- In `chrome://inspect`, the app's WebView console:
  - `navigator.xr`, and `await navigator.xr?.isSessionSupported('immersive-ar')`;
  - `await Capacitor.Plugins.ScanAR.capabilities()`: its `engine`, `supported` and `reason`;
  - the start screen's headline and the line under it.
- After allowing the camera:
  `(await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput')`.
- Head or puck: add `addEventListener('deviceorientation', (e) => console.log(e.alpha, e.beta, e.gamma))` in the
  console. Turn your head with the puck still, then the puck with your head still, and note which one moves the
  numbers. `adb shell dumpsys sensorservice > aura-sensors.txt` lists the sensors.
- Whether the Places map gets a location fix, and how accurate it is.

## 3. The Android XR probe, at rest

The probe pairs camera 0's frames with the glasses' pose on one clock and writes a short recording. It uploads nothing
and has no network access.

```bash
adb install -r scan-androidxr-probe-debug.apk
adb shell am start -n com.companionintelligence.scan.androidxr.probe/.ProbeActivity --ez autostart true
```

The first launch asks for the camera and head-tracking permissions and waits for an answer (see the ground rules).
Extras: `--ei seconds 30`, `--es size 1280x720`, `--ei keyframe_ms 1000`.

After the run (15 s by default):

```bash
adb logcat -d -s ScanXrProbe -v raw > aura-probe-report.txt
adb pull /sdcard/Android/data/com.companionintelligence.scan.androidxr.probe/files/recordings/ ./aura-recordings/
```

**Record:** the report's camera frame rate, pose rate, pairing gaps and keyframe count. On 2026-11-24, at rest:
camera 0 at 30 Hz and 1920×1080, the pose at 43 Hz, 28 keyframes.

## 4. The probe, one permission at a time

Two runs that have not been done: each with one permission granted and the other not. They show which permission the
pose needs and which the camera needs. Granting or revoking over adb needs the owner's yes, in words.

```bash
P=com.companionintelligence.scan.androidxr.probe
adb shell pm revoke $P android.permission.HEAD_TRACKING   # run A: camera only
adb shell pm grant  $P android.permission.CAMERA
adb shell am start -n $P/.ProbeActivity --ez autostart true
adb logcat -d -s ScanXrProbe -v raw > aura-probe-camera-only.txt

adb shell pm revoke $P android.permission.CAMERA          # run B: head tracking only
adb shell pm grant  $P android.permission.HEAD_TRACKING
adb shell am start -n $P/.ProbeActivity --ez autostart true
adb logcat -d -s ScanXrProbe -v raw > aura-probe-head-only.txt
```

Wait for each run to end (15 s) before reading its report. **Record:** whether the pose tracks, and whether the camera
opens, in each run.

## 5. The probe, worn

The run that a calibration needs, and the one that measures how far the pose lags the frames.

1. Grant both permissions again (or answer both prompts while wearing the glasses).
2. Start a longer run: `adb shell am start -n com.companionintelligence.scan.androidxr.probe/.ProbeActivity --ez autostart true --ei seconds 60`.
3. Wearing the glasses, turn slowly through a full circle in a room with texture and some straight edges, then walk two
   or three metres and back.
4. Pull the report and the recording as in step 3.

**Record:** the report, and keep the recording (outside the repository) for the calibration in ticket 0003.

## 6. The Unity Aura build (only if it is installed)

The untracked Unity scaffold (`unity/aura-scanner`) has a debug build in the device kit (`scan-unity-aura-debug.apk`,
`com.companionintelligence.scan.aura`), and its future is the owner's decision. If it goes on, record one thing only:
whether its IMGUI HUD, and the Start button, show on the glasses at all.

## What to send back

`aura-features.txt`, `aura-sensors.txt`, the probe reports, the console notes from steps 1 and 2, and the date and
build for each. Not the recordings: they show a room.
