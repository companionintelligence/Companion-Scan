# First run on a Meta Quest 3

One pass through the scanner's Quest paths: the native app (`meta/`) and the Quest Browser at `/webxr.html`. It merges
[meta-quest.md](../targets/meta-quest.md), [web-webxr.md](../targets/web-webxr.md) and the device kit's order. Nothing
from this repository has run on a Quest yet, so every line below is a first. Write the results back into
`meta-quest.md` and `web-webxr.md` (Status) and [AR_DEVICE_SUPPORT.md](../operations/AR_DEVICE_SUPPORT.md), with the
date, the build and the headset's software version.

Sister checklists: [FIRST_RUN_XREAL_AURA.md](FIRST_RUN_XREAL_AURA.md), [FIRST_RUN_PICO_4_PRO.md](FIRST_RUN_PICO_4_PRO.md).

## Ground rules

- **Each install needs the owner's yes.**
- **Keyframes show a room.** They go only to the Scan server you set. Keep logs and screenshots out of the
  repository.
- The other Quest scanners (companion-scan-unity's "Companion Scan" and Companion-Scan-Meta's "Scan Quest") wait on
  an owner decision, and are not part of this run.

## What you need

| What | Where |
|---|---|
| A Scan server the headset can reach over HTTPS | for example `https://<host>.<tailnet>.ts.net:5173`; open `/health` in the Quest Browser first |
| The native Quest app | `cd meta && ./gradlew assembleDebug` (`app/build/outputs/apk/debug/app-debug.apk`); in the device kit, `scan-quest-debug.apk` |
| A computer with adb and desktop Chrome | for the app's logs, and `chrome://inspect` for the Quest Browser's console |

## 0. Connect

1. In the Meta Horizon app on the phone that manages the headset, open the headset's settings and turn on Developer
   Mode.
2. Connect the headset over USB and allow USB debugging in the headset.
3. `adb devices -l`. A device listed as `unauthorized` is waiting for that answer.

**Record:**

```bash
adb shell getprop ro.product.model
adb shell getprop ro.build.version.release
adb shell getprop ro.build.version.sdk
adb shell getprop ro.build.version.incremental
adb shell pm list features > quest-features.txt
adb shell dumpsys media.camera > quest-cameras.txt
```

Also note the Horizon OS version from Settings, General, About. The native app needs v74 or later.

## 1. The native app

```bash
adb install -r scan-quest-debug.apk
adb logcat -c
```

1. Start **Scan for Quest** from the app library (Unknown Sources). Allow the headset camera.
2. On its panel, enter the Scan server's `https://` address and save it. With sign-in on, press **Sign in with
   Companion Account** first.
3. Start a capture. Walk the room slowly for a minute, turning through a full circle. Stop it.
4. Read the app's log:

```bash
adb logcat -d -s CaptureController PassthroughCamera ImmersiveActivity > quest-native.txt
```

**Record:**

- The camera: the `PassthroughCamera` line `camera <id>: camera_source=… position=…`, and the `CaptureController`
  line `opened: …; timestamps …; lens pose reported=…`. That line gives the timestamp source. Note the size the panel
  says it chose, and any warning that 1280×960 was not offered.
- The upload: the frame and upload counts on the panel, and whether the session appears on the server.
- The poses: open the session in the editor and check that the keyframe cameras line up with the room. If they turn
  the wrong way or sit mirrored, say which.
- The splat viewer, once the server has built a splat: what it shows.
- Whether a system dialog (the Meta button, a permission prompt) pauses the capture, and whether the session is
  finalized.

## 2. The Quest Browser, at `/webxr.html` (no install)

1. In the Quest Browser, open `https://<host>:<port>/webxr.html`.
2. For the console: with the headset on USB, open `chrome://inspect` on the computer and inspect the Quest Browser tab.
3. The page forwards to `/?ar=webxr`. Press **Start AR**, and allow the camera when asked.

**Record:**

- The console's `[webxr]` lines: which features the session was granted. The Quest Browser is not expected to grant
  `dom-overlay`, so the page's own overlay is not drawn in the session.
- Whether the in-session status panel shows in front of you, and whether the trigger (`select`) on it starts and stops
  the scan, and captures.
- Whether a camera prompt appears, and whether the console says `[webxr] No camera stream — frame capture disabled`.
  Then `(await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput')`.
- After Stop: whether the session reaches the server, and whether its poses line up in the editor. Until a camera model
  is set, a keyframe's pose and field of view are the eyes', and the panel's last line says so (`pose: the eyes, no
  camera model set`).

### Measuring the camera, for the WebXR page

WebXR does not say where the passthrough camera is. The page takes a measured model in its address, and the headset
keeps it: `?camoffset=x,y,z` (metres in the viewer's frame: +x right, +y up, −z forward), `?campitch=<degrees>`
(negative looks down) and `?camfov=<vertical degrees>`; `?camera=clear` forgets it.

`quest-cameras.txt` from step 0 holds what Camera2 reports for each passthrough camera: its lens pose
(`android.lens.poseTranslation`, `android.lens.poseRotation`, `android.lens.poseReference`) and intrinsics
(`android.lens.intrinsicCalibration`). Send the file back: a developer turns it into those three values, and the next
session opens `/webxr.html?camoffset=…&campitch=…&camfov=…` once.

## 3. The headset editor

Open `https://<host>:<port>/xr-world.html?world=<slug>` in the Quest Browser and press Enter VR. Select a Thing with a
controller, relabel it and move it, then check that the edit is saved ([DEVICE_TEST_KIT.md](DEVICE_TEST_KIT.md)).

## What to send back

`quest-features.txt`, `quest-cameras.txt`, `quest-native.txt`, the console notes from step 2, and the date and build
for each.
