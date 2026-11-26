# PICO

PICO makes standalone VR and MR headsets that run PICO OS, which is built on Android. Two
generations of it matter here:

- **PICO OS 5** runs on the headsets on sale: PICO 4 Ultra, PICO 4 (with 4 Pro and 4 Enterprise)
  and the Neo3 series.
- **PICO OS 6** runs only on PICO Space Pro and on the PICO Emulator. PICO says Space Pro
  launches globally in 2026; until then there is an early access programme.

Scan has two ways onto a PICO headset, and neither has run on one yet:

1. **The [WebXR-only Android build](android-webxr.md).**
   - On PICO OS 6, PICO documents WebXR in the system WebView, with passthrough AR, hit test and
     anchors. There the APK may capture.
   - On PICO OS 5 the pages read do not say whether the WebView has WebXR.
2. **PICO Browser**, opening the server's `/webxr.html`. That is the existing
   [Web, WebXR](web-webxr.md) target, and it needs no build. PICO documents WebXR in its browser
   on both generations.

Plan: [wave 17](../factory/17-xr-device-targets/README.md).

## The devices and the platform, as PICO's documentation describes them

Read on 2026-11-24. Nothing here was checked on a device. The [sources](#sources) are at the end.

| What | What the documents say |
|---|---|
| PICO OS 5 headsets | PICO 4 Ultra has a Snapdragon XR2 Gen 2, two 32 MP colour passthrough cameras, a depth-sensing (iToF) camera and four tracking cameras. PICO 4, 4 Pro and 4 Enterprise have an XR2, four monochrome fisheye cameras and one RGB camera. Each comes with two 6DoF controllers. |
| PICO OS 6 | Runs only on PICO Space Pro and the PICO Emulator. Older devices stay on PICO OS 5. |
| Android version | No page read gives the Android version or the API level of either OS. |
| Android apps | Existing Android apps run on PICO OS 6 unchanged, in "2D app compatibility mode". PICO's table of app types lists native 2D Android apps. |
| Google Play Services | "PICO OS 6 does not currently integrate GMS components and does not support Google Play Services." The pages read say nothing on this for PICO OS 5. |
| WebXR on PICO OS 6 | PICO OS 6 has three web runtimes on one Chromium (M138): the Web App Runtime, PICO Browser and the WebView. All three can start a WebXR session. The modules listed are the WebXR Device API, Gamepads, Hand Input, Layers, Augmented Reality (passthrough), Plane Detection, Hit Test and Anchors. One note for the current alpha of PICO OS 6: a WebXR session also shows the web window, pending a fix. |
| WebXR on PICO OS 5 | PICO Browser and the WebView use Chromium M125. PICO's PICO 4 Ultra page describes the built-in browser as having WebXR support, with a WebXR MR API and WebXR hand input. No page read says whether the WebView on PICO OS 5 has WebXR. |
| Cameras | Three statements, for three routes. (1) Showing passthrough (Unity OpenXR SDK 1.4.0; Neo3, PICO 4 and PICO 4 Ultra on system 5.7.0 or later): "the app is unable to access any images or videos of users' surroundings". (2) PICO's Camera Pack sample gives a Unity app "passthrough RGB camera access" through PICO's Unity SDK (`com.bytedance.pico.xr`, version 6.2.0, public on GitHub as `Pico-Developer/PICO-Unity-SDK`; namespace `ByteDance.PICO.CameraPack`, component `PXR_CamTextureManager`). Its manifest asks for `android.permission.CAMERA`, and the camera does not start until the headset camera permission is granted. It names its two headsets by codename: `sparrow`, which no page read identifies, and `swan` (Project Swan, now PICO Space Pro); environment depth is `swan` only. It runs on a headset only, not in the Unity editor or a simulator. (3) The Spatial SDK's camera-driven features run in SpatialML (SecureMR), a protected runtime that keeps passthrough imagery and frames inside it. No page read says what a WebView's `getUserMedia`, or an app's Camera2, gets. |
| Input | PICO OS 6: eye tracking, gaze and pinch, hand tracking, PICO controllers and motion trackers, plus keyboards, mice and game controllers. |
| Back | "PICO devices lack a physical back button and system-level navigation hand gestures". So an app must offer Back in its own interface. |
| Developer mode | Settings, then General, then About. Keep clicking Software Version until Developer appears in the left panel, open Developer, and turn on USB Debug. This is from PICO's Unreal Integration SDK 3.4.0 guide. |
| adb | Android Studio lists a connected PICO OS 6 device and installs on it (Spatial SDK 6.2.x quickstart). |
| Emulator | The PICO Emulator runs the full PICO OS 6 image. It runs on Windows, with 8 GB of GPU memory, and on Apple-silicon macOS. |

## Why the APK runs WebXR alone on a PICO headset

The headset gets the [WebXR-only Android build](android-webxr.md); that page says what the build
is, how to make it, and what was checked. These are the reasons for it on this device:

- **No ARCore.** Classic ARCore needs Google Play Services for AR, and PICO OS 6 has no Google
  Play Services. The pages read say nothing about ARCore on PICO OS 5.
- **WebXR is PICO's documented runtime for web content.** On PICO OS 6 every web runtime has it,
  the app's WebView included.
- **No 8th Wall.** The engine takes its camera through `getUserMedia`. The only route to camera
  frames that PICO documents is its Unity SDK's Camera Pack, and no page says what a WebView's
  camera stream shows. That is unverified: [first-run check 6](#first-run-on-a-pico-headset-what-to-record) shows it.
- **No PICO libraries or manifest entries.** PICO's native route for PICO OS 6, the PICO Spatial
  SDK, needs `minSdk` and `compileSdk` 35, Kotlin 2.0 or later, and PICO's own versions of
  Jetpack Compose modules. The shell is a Java Capacitor app with `minSdk` 24, so a native PICO
  runtime would be a separate app, as the Quest app is
  ([ticket 0005](../factory/17-xr-device-targets/0005-native-pico-capture.md)).

## The capture path to try first

- **PICO OS 6:** the APK itself, since its WebView has WebXR, and PICO Browser's `/webxr.html` to
  compare.
- **PICO OS 5:** PICO Browser, at `https://<host>:<port>/webxr.html` on the person's own Scan server.

The scanner asks for an `immersive-ar` session with `hit-test` required, and `dom-overlay`,
`local-floor` and `anchors` optional (`src/ar/webxr.ts`):

- PICO OS 6 lists hit test and anchors.
- It does not list `dom-overlay`. Without it the scanner's page is not drawn inside the session,
  as on Quest Browser. The scanner then draws its own panel in the session (wave 19, 0002): the
  scan's status, and Start scan, Stop scan and Capture on the controller's trigger or a pinch.
- Keyframe images come from a separate `getUserMedia` stream (`facingMode: 'environment'`). If PICO
  gives it no passthrough camera, the session still tracks and hit-tests, and frame capture is
  off. The console then reads `[webxr] No camera stream — frame capture disabled`.
- On a headset, the WebXR viewer pose is the eyes' pose, and the passthrough cameras sit apart
  from the eyes. A keyframe's field of view is read from the first XR view's projection
  (`getCameraFovY` in `src/ar/webxr.ts`), which on a headset is an eye's display, not a camera.
  Both are inferred from the code, not measured.

## Status

**Not run on a PICO headset or on the PICO Emulator** (2026-11-24). The emulator needs Windows or
macOS, and this work was done on Linux. The build's own status is on
[android-webxr.md](android-webxr.md#status).

## Run

1. Turn on developer mode, as in [the table above](#the-devices-and-the-platform-as-picos-documentation-describes-them).
2. Connect the headset to the computer with a USB cable, and allow USB debugging when the headset
   asks. A device that `adb devices` lists as `unauthorized` is waiting for that answer.
3. `adb install -r mobile/android/app/build/outputs/apk/debug/app-debug.apk`, built as on
   [android-webxr.md](android-webxr.md#build).
4. Open Scan on the headset, and set the Scan server on the first-run screen's Server row.

## First run on a PICO headset: what to record

[FIRST_RUN_PICO_4_PRO.md](../testing/FIRST_RUN_PICO_4_PRO.md) runs this list on a PICO 4 Pro, with the commands. This
list is what the first run should write down,
with the date, the device and its PICO OS version, back into [Status](#status) and into
[AR_DEVICE_SUPPORT.md](../operations/AR_DEVICE_SUPPORT.md). The answers decide
[ticket 0005](../factory/17-xr-device-targets/0005-native-pico-capture.md).

1. **The platform.** Record what no page gives:
   - the PICO OS version (Settings, General, About);
   - `adb shell getprop ro.build.version.release`, `ro.build.version.sdk` and `ro.product.model`;
   - `adb shell pm list features`, all of it.
2. **The window.**
   - How does the APK open, and does the portrait window suit the headset?
   - Do the controller's ray and a pinch act as taps?
   - The headset has no Back button: can every screen of Scan be left from Scan's own controls?
3. **Sign-in.** The shell signs in through a browser sheet and comes back on
   `com.companionintelligence.scan://auth`. Does the sheet open, in which browser, and does the
   return reach the app?
4. **WebXR in the WebView.** Open `chrome://inspect` on the computer: the debug build's WebView is
   inspectable. In its console, record:
   - `navigator.xr`, and `await navigator.xr?.isSessionSupported('immersive-ar')`;
   - `await Capacitor.Plugins.ScanAR.capabilities()`;
   - the start screen's line.
5. **A scan in the APK, where the WebView has WebXR.** Record:
   - whether the `immersive-ar` session starts with passthrough;
   - which features it was granted (the console's `[webxr]` lines);
   - whether the scanner's page is visible during the session;
   - whether the web window shows at the same time (PICO's alpha note).
6. **The cameras.**
   - In the WebView console, after allowing the camera:
     `(await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput')`.
   - Then note whether a scan captures frames, and what they show.
   - `adb shell dumpsys media.camera`: each camera's id, facing and sizes.
7. **PICO Browser.** Open `/webxr.html`, as [above](#the-capture-path-to-try-first). Run checks 5
   and 6 there, and say how they differ from the APK.
8. **Location.** Does the Places map get a fix, and how accurate is it?

## Known gaps

- **PICO OS 5's WebView:** no page read says whether it has WebXR. Until check 4 runs, the APK
  should be expected not to capture there.
- **Camera frames:** PICO documents them for apps only through the Camera Pack in its Unity SDK.
  In the APK or the browser a capture may get poses and hit tests and no images.
- **A native capture app** for PICO would be a separate app, like `meta/` for Quest
  ([ticket 0005](../factory/17-xr-device-targets/0005-native-pico-capture.md)). Its one documented
  route to frames is a Unity app with Camera Pack, so it would not share code with the Kotlin Quest app.
- **Not run:** no PICO headset, and no PICO Emulator, which runs on Windows and macOS only.
- **The build's own gaps** (the ARCore notice, the portrait lock, the store's implied features, the
  provisional identifiers) are on [android-webxr.md](android-webxr.md#known-gaps).

## Sources

Read on 2026-11-24, at `developer.picoxr.com`:

- [Developer documentation](https://developer.picoxr.com/document/)
- [PICO devices](https://developer.picoxr.com/document/discover/xr-devices/)
- [Spatial app types](https://developer.picoxr.com/document/discover/spatial-app-types/)
- [PICO Space Pro and PICO OS 6 FAQ](https://developer.picoxr.com/document/discover/faqs-for-project-swan-and-pico-os-6/)
- [Web platform on PICO OS](https://developer.picoxr.com/document/web/), [Web API](https://developer.picoxr.com/document/web/web-api) and [WebXR API](https://developer.picoxr.com/document/web/webxr)
- Spatial SDK 6.2.x: [overview](https://developer.picoxr.com/document/spatial-sdk/), [Port Android apps](https://developer.picoxr.com/document/spatial-sdk/port-android-apps/), [Create and run a spatial project](https://developer.picoxr.com/document/spatial-sdk/create-your-first-spatial-app/)
- [Test and preview](https://developer.picoxr.com/document/unreal/test-and-build/?v=3.4.0) (developer mode; Unreal Integration SDK 3.4.0)
- [SpatialML: privacy and data boundaries](https://developer.picoxr.com/document/pico-unity-spatialml/concepts-privacy-and-data-boundaries/?v=6.2.x)
- [PICO 4 Ultra](https://developer.picoxr.com/pico4-ultra/)
- [Passthrough](https://developer.picoxr.com/document/unity-openxr/passthrough/) (PICO Unity OpenXR SDK 1.4.0)

And PICO's [Camera Pack sample](https://github.com/Pico-Developer/PICO-Unity-SDK-Samples-CameraPack)
(MIT; its README, `docs/pico-camera-pack-sample.md`, its Android manifest and its `Packages/manifest.json`, last pushed 2026-11-14).
