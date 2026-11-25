# XREAL Aura

XREAL Aura is a pair of wired XR glasses. The glasses have optical see-through displays and do
their own tracking, and apps run on Android XR on the Compute Puck the glasses plug into. Scan has
two ways onto it, and neither has run on one yet:

1. **The [WebXR-only Android build](android-webxr.md)**: the Android shell, built to run WebXR
   alone. Android XR's WebView is not known to have WebXR, so this APK most likely has no capture
   on Aura. It is then the editor, the viewer, the Places map, the Scan server setting and sign-in,
   in a panel.
2. **Chrome on the puck**, opening the server's `/webxr.html`. That is the existing
   [Web, WebXR](web-webxr.md) target, and it needs no build. Google documents WebXR for Chrome on
   Android XR, so this is the capture path to try first ([below](#the-capture-path-to-try-first-chrome)).

Plan: [wave 17](../factory/17-xr-device-targets/README.md).

## The device, as its documentation describes it

Read on 2026-11-24. Nothing here was checked on a device. The [sources](#sources) are at the end.

| What | What the documents say |
|---|---|
| Platform | Android XR, on the Compute Puck. No page gives the Android version or API level. |
| Display | Optical see-through, with "no video passthrough". 70° diagonal field of view, 1920 × 1200 per eye, up to 120 Hz, and electrochromic dimming with five levels. |
| Tracking | 6DoF and hand tracking, from two world-facing tracking cameras on the glasses. The pages read do not mention eye tracking. |
| Cameras | One high-resolution camera on the glasses, with a privacy LED. No page says whether apps can read its frames, or through which permission. |
| Input | Hands, voice and the puck's touchpad. Bluetooth keyboards, mice and game controllers also work. |
| Radios | The specifications list Wi-Fi 6/6E and Bluetooth 5.3. Whether the puck gets a location fix is [first-run check 7](#first-run-on-an-aura-what-to-record). |
| Phone and tablet apps | They run unchanged on Android XR, as a panel in Home Space (Google). |
| ARCore | No page documents classic ARCore (`com.google.ar.core`, Google Play Services for AR) on Android XR. Android XR's own route is ARCore for Jetpack XR, a separate library. |
| WebXR | Chrome on Android XR supports WebXR, with `immersive-ar`, hit test, anchors, depth sensing, light estimation and hand input (Google). No page mentions the Android WebView. |
| Developer mode | Settings, then About device: tap Build number 7 times, then turn on USB debugging in Developer options. |
| adb | Leave the glasses on the Glasses Port (right side of the puck), and connect the computer to the Charging Port (left side). XREAL's getting-started page and FAQ say both ports support adb, but its specifications list adb under the Glasses Port only. |
| Emulator | Android Studio has an XR glasses virtual device, with a Preview API system image. Google's pages ask for a Canary build of Studio (XREAL's guide says the latest stable one) and list macOS and Windows hosts only. |

## Why the APK runs WebXR alone on an Aura

Aura's build is the [WebXR-only Android build](android-webxr.md); that page says what the build
is, how to make it, and what was checked. These are the reasons for it on this device:

- **No ARCore.** No page documents classic ARCore on Android XR.
- **No 8th Wall.** The 8th Wall engine tracks from the camera and the motion sensors of the device
  it runs on. Here the app runs on the puck, so those sensors are most likely the puck's, not the
  glasses'. That is unverified: [first-run check 5](#first-run-on-an-aura-what-to-record) settles it.
- **WebXR may not be there either.** Google documents WebXR for Chrome only, and
  [android-arcore.md](android-arcore.md#known-gaps) records that the Android WebView has no
  WebXR AR. So the start screen will most likely read "WebXR is not available here", and the APK
  will not capture. [First-run check 3](#first-run-on-an-aura-what-to-record) shows whether
  Android XR's WebView differs.
- **No Android XR libraries, permissions or manifest entries.** Jetpack XR, the
  `android.window.PROPERTY_XR_ACTIVITY_START_MODE` property, and permissions such as
  `android.permission.HEAD_TRACKING` belong to a native XR runtime: that is
  [ticket 0003](../factory/17-xr-device-targets/0003-native-android-xr-capture.md). Google's pages give no
  `uses-feature` names for Android XR, so the build declares none.

## The capture path to try first: Chrome

1. In Chrome on the puck, open `https://<host>:<port>/webxr.html` on the person's own Scan server.
2. The scanner asks for an `immersive-ar` session with `hit-test` required, and `dom-overlay`,
   `local-floor` and `anchors` optional (`src/ar/webxr.ts`). Google's list for Chrome on Android
   XR has hit test and anchors. It does not mention `dom-overlay`, and without it the scanner's
   page is not drawn inside the session.
3. Keyframe images come from a separate camera stream (`getUserMedia` with
   `facingMode: 'environment'`), not from WebXR's own camera access. No page says whether Chrome on
   Aura can open the glasses' camera. If it cannot, the session still tracks and hit-tests, and
   frame capture is off. The console then reads
   `[webxr] No camera stream — frame capture disabled`.

Three gaps on glasses, inferred from the code and not yet measured:

- The WebXR viewer pose is the eyes' pose, not the camera's. A keyframe's pose is off by the
  camera's offset from the eyes.
- A keyframe's field of view is read from the first XR view's projection (`getCameraFovY` in
  `src/ar/webxr.ts`). On a phone that view is the camera's; on glasses it is the left eye's display.
- An additive display shows black as clear, so the scanner's dark overlay may be faint against the room.

## Status

**Installed on an Aura once, and it does not capture there** (2026-11-24, ticket
[0002](../factory/17-xr-device-targets/0002-first-run-on-an-aura.md)). The build's own status is on
[android-webxr.md](android-webxr.md#status).

The WebXR-only debug build from `60e9681` went onto an Android XR Puck over USB, at the owner's word:
- `adb install` worked, with no Play Protect prompt, and the app opened in 815 ms.
- The puck already had Companion Compass's XR build.
- The values below were read on the device over adb, and from the debug WebView through the DevTools protocol.
- Nothing was tapped or granted on the device.

Checks from the first-run list:

1. **The platform.**
   - Android 14 (API 34), model `Android_XR_Puck`, build `UXP4.261012.001.O5`.
   - Its XR features are `android.software.xr.api.openxr` (65538), `android.software.xr.api.spatial` (4) and
     `android.hardware.xr.input.hand_tracking`.
   - It also has a front camera, an accelerometer and a gyroscope, and Vulkan level 1: 70 features in all.
2. **The panel:** not done.
3. **WebXR in the WebView: there is none.**
   - The WebView is `com.google.android.webview` 157.0.8103.52, and `navigator.xr` is undefined.
   - `ScanAR.capabilities()` answers `engine: "none"`, `supported: false`, "This device does not support ARCore."
   - The window is 640×1024 CSS pixels at a device pixel ratio of 1.33.
   - The help line then asked for Google Play Services for AR: ticket
     [0006](../factory/17-xr-device-targets/0006-webxr-build-help-line.md) points it at `/webxr.html`.
   - The Start button's headline was not read before the puck left adb.
4. **The cameras** (`dumpsys media.camera`): seven devices.
   - Three are open to apps:
     - `auracamerahal/0`, back-facing: YUV, PRIV and JPEG at 1920×1080, 1440×1080, 1280×720, 640×480 and 320×240;
     - `avatar/1`, front-facing, apparently Android XR's synthetic avatar camera;
     - camera 11, a depth camera (DEPTH_OUTPUT).
   - The other four are SYSTEM_CAMERA devices. A system process held two of them open, probably for tracking.
   - The WebView's `enumerateDevices()` needs the camera permission, so it was not run.
   - Camera 0's characteristics, read again on 2026-11-24 for ticket
     [0003](../factory/17-xr-device-targets/0003-native-android-xr-capture.md):
     - timestamps on the boot clock (`SENSOR_INFO_TIMESTAMP_SOURCE` REALTIME);
     - no lens pose and no intrinsic calibration or distortion;
     - a 2.4 mm focal length, and a 3.2 × 2.4 mm sensor against a 1920 × 1080 pixel array;
     - LIMITED, with a hardware readout timestamp.
     - So a keyframe's camera offset and intrinsics have to come from a calibration.
   - **Opened by an app, 2026-11-24:** ticket 0003's probe ([`android-xr/`](../../android-xr/README.md)) opened camera
     0 with `CAMERA` alone, and got 30 Hz frames whose timestamps are their start of exposure. With `HEAD_TRACKING`
     granted, ARCore for Jetpack XR tracked the glasses at 43 Hz in Home Space. Without it, nothing was TRACKING. That was
     a run at rest; a worn run is still to do. Report:
     [android-xr/reports/2026-11-24-xreal-aura-probe.txt](../../android-xr/reports/2026-11-24-xreal-aura-probe.txt).
5. **The motion sensors.**
   - Two InvenSense ICM-45686 IMUs (named "main" and "minor") and a Memsic MMC5603 magnetometer.
   - An ambient light sensor, off-body detection, and a "temperature of glasses" sensor.
   - Rotation vector, gravity and linear acceleration.
   - Which of them move with the head needs someone wearing the glasses.
6. **Chrome at `/webxr.html`:** not done.
7. **Location:** not done.

## Run

1. Turn on developer mode on the puck, as in [the table above](#the-device-as-its-documentation-describes-it).
2. Leave the glasses on the Glasses Port, connect the computer to the Charging Port, and allow USB
   debugging when the puck asks. A device that `adb devices` lists as `unauthorized` is waiting
   for that answer.
3. `adb install -r mobile/android/app/build/outputs/apk/debug/app-debug.apk`, built as on
   [android-webxr.md](android-webxr.md#build).
4. Open Scan from the launcher, and set the Scan server on the first-run screen's Server row.

XREAL's guide says to plug the glasses in again if their display does not come back after an adb
session.

## First run on an Aura: what to record

There is no checklist for this device yet. This list is what the first run should write down, with
the date, back into [Status](#status) and into
[AR_DEVICE_SUPPORT.md](../operations/AR_DEVICE_SUPPORT.md). The answers decide
[ticket 0003](../factory/17-xr-device-targets/0003-native-android-xr-capture.md).

1. **The platform.** Record what no page gives:
   - `adb shell getprop ro.build.version.release`, `ro.build.version.sdk` and `ro.product.model`;
   - `adb shell pm list features`, all of it: the XR feature names Android XR reports.
2. **The panel.**
   - Does the APK open as a panel in Home Space, and does the portrait panel fit the central part
     of the view?
   - Is its text readable at the clearest and the darkest dimming levels?
   - Does a pinch act as a tap?
3. **WebXR in the WebView.** Open `chrome://inspect` on the computer: the debug build's WebView is
   inspectable. In its console, record:
   - `navigator.xr`, and `await navigator.xr?.isSessionSupported('immersive-ar')`;
   - `await Capacitor.Plugins.ScanAR.capabilities()`: its `engine`, `supported` and `reason`;
   - the start screen's line.
4. **The cameras.**
   - `adb shell dumpsys media.camera`: each camera's id, facing and sizes.
   - In the WebView console, after allowing the camera:
     `(await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput')`.
5. **The motion sensors.**
   - In the WebView console, add
     `addEventListener('deviceorientation', (e) => console.log(e.alpha, e.beta, e.gamma))`.
   - Turn your head with the puck held still, then turn the puck with your head still, and note
     which of the two moves the numbers.
   - `adb shell dumpsys sensorservice` lists the sensors.
6. **Chrome.** Open `/webxr.html`, as [above](#the-capture-path-to-try-first-chrome), and record:
   - whether the session starts, and which features it was granted (the console's `[webxr]` lines);
   - whether the camera prompt appears and frames are captured;
   - whether the uploaded poses line up in the editor.
7. **Location.** Does the Places map get a fix, and how accurate is it? The specifications list
   Wi-Fi and Bluetooth radios.

## Known gaps

- **No capture in the APK**, because Android XR's WebView has no WebXR (check 3). A native capture path is
  [ticket 0003](../factory/17-xr-device-targets/0003-native-android-xr-capture.md), started on 2026-11-24. Its probe is
  a separate app in [`android-xr/`](../../android-xr/README.md).
  - It pairs camera 0's frames with Jetpack XR's device pose (behind `android.permission.HEAD_TRACKING`) on the boot
    clock, and records a short session.
  - It ran on an Aura at rest on 2026-11-24 (check 4 above).
  - Still to do: a worn run, the camera's calibration, and the runtime.
- **Not run:** nothing has been installed on an Aura, and no XR emulator has run here. Linux is
  not a listed host for the XR glasses emulator, which also needs a download of its own.
- **The portrait panel:** whether it suits the glasses' view is check 2, and the build's portrait
  lock stays until then.
- **The build's own gaps** (the ARCore notice, the portrait lock, Google Play's implied features,
  the provisional identifiers) are on [android-webxr.md](android-webxr.md#known-gaps).

## Sources

Read on 2026-11-24.

- XREAL:
  - [Aura developers](https://tutorials.xreal.com/docs/aura/developers/)
  - [Getting started](https://tutorials.xreal.com/docs/aura/developers/getting-started)
  - [App design guidelines](https://tutorials.xreal.com/docs/aura/developers/app-design-guidelines)
  - [Specifications](https://tutorials.xreal.com/docs/aura/specifications/)
  - [FAQ](https://tutorials.xreal.com/docs/aura/troubleshooting/faq)
- Google:
  - [Add XR to an existing app](https://developer.android.com/develop/xr/jetpack-xr-sdk/add-xr-to-existing)
  - [Home Space and Full Space](https://developer.android.com/develop/xr/jetpack-xr-sdk/transition-home-space-to-full-space)
  - [WebXR on Android XR](https://developer.android.com/develop/xr/web)
  - [Android XR permissions](https://developer.android.com/develop/xr/permissions)
  - [ARCore for Jetpack XR: device pose](https://developer.android.com/develop/xr/jetpack-xr-sdk/arcore/device-pose)
  - [XR emulator virtual devices](https://developer.android.com/develop/xr/jetpack-xr-sdk/run/create-avds/xr-headsets-glasses)
  - [Android XR app quality](https://developer.android.com/docs/quality-guidelines/android-xr/immersive)
  - [`<uses-feature>`](https://developer.android.com/guide/topics/manifest/uses-feature-element)
