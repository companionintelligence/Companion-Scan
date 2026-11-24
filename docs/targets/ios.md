# iOS app

The iOS app: the Scan web app inside the Capacitor 8 shell (`mobile/`), with the phone's own ARKit
session as the AR runtime. It is the scanner and the editor, for iPhone. The full shell reference
is [mobile/README.md](../../mobile/README.md).

## What it is

- The shell bundles the web app and talks to the person's own Scan server, whose https address is
  set in the app ([README.md](../../README.md#the-scan-server-in-the-android-ios-and-desktop-apps)).
- `ScanBridgeViewController` registers one plugin, `ScanAR` (`ScanARPlugin.swift`). It runs an ARKit
  world-tracking session and shows the camera in RealityKit's `ARView` beneath the web view,
  which is transparent while the session runs. The camera image is fitted whole inside the web view
  ("contain"), and the scanner draws its Three.js scene over it from the native pose and
  projection. The web side is `NativeARProvider` (`src/ar/native.ts`, ADR 0009).
- **Which runtime starts.** When `ScanAR.capabilities()` reports `supported`, the page chooses the
  native runtime and the status line reads "ARKit ready", which says only that it was chosen. A
  phone without ARKit starts on 8th Wall (`public/xr.js`, bundled unmodified). A native session
  that fails to start hands the same canvas to 8th Wall, then WebXR. `?ar=webxr` and `?ar=8thwall`
  keep their web runtimes.
- `ScanAR` hands the page camera frames (`captureFrame`, a portrait JPEG with pose and
  projection), exact hit tests (`hitTest`), pose, feature-point and hit-grid events, and LiDAR depth
  on a phone that has it.
- **World maps** (ADR 0010). `saveWorldMap({ name })` keeps an ARKit world map on the phone, under
  the Place's slug from `?world=`, and `start({ worldMap })` relocalizes into it. A named session
  autosaves every minute, when the app goes to the background, when ARKit is interrupted, and on
  stop. `default` never gets a map. Maps are excluded from backups and never uploaded.
- An ARKit interruption (backgrounding, or another app on the camera) is reported as tracking
  `notAvailable`, and the session is not reset.
- The app is for iPhone only (`TARGETED_DEVICE_FAMILY = 1`), iOS 16.4 or later, portrait only.
  Sign-in runs in the system browser sheet and comes back on
  `com.companionintelligence.scan://auth`.
- **RealityKit: compiled, not run on a device.** Since 2026-11-23 the native view is RealityKit's
  `ARView` in camera mode `.ar`, and the plugin still configures and runs the session itself. Hit
  samples are ARKit raycasts through the view. The JavaScript contract did not change. Until then
  the view was SceneKit's `ARSCNView`. The iOS Simulator job compiled it on commit `20b2e46` (run
  45247696203), and again on the merged tree (`81e437c`, run 45260987425). See
  [ADR 0012](../adr/0012-the-ios-shell-draws-its-native-ar-view-with-realitykit.md) and
  [wave 13](../factory/13-device-targets/README.md).

## Status

- **Not run on a device.** No ARKit iPhone has run `ScanAR`: tracking, interruptions,
  relocalization, depth and autosave are verified only on a phone, and none of them has been
  ([mobile/README.md](../../mobile/README.md#native-ar-capture)).
- **Build: the merged tree compiles for the iOS Simulator.** The Mobile Build workflow's iOS
  Simulator job compiled commit `81e437c`, the tree `main` merged as `e897380` (#282), on
  2026-11-23 (run 45260987425); the same run built the Android debug APK
  ([Builds of the merged tree](README.md#builds-of-the-merged-tree)). No device build has been
  made: that needs a Mac with Xcode and the owner's Apple signing team, and the build host here
  has no Xcode.
- **Sign-in: on the simulator only.** The full round trip, the status row after a restart and the
  return from the sheet ran on the iOS simulator against a local stand-in for the Portal, not the
  real one ([mobile/README.md](../../mobile/README.md#companion-account-sign-in)).
- **Releases: none.** iOS is not built for release, and nothing goes to the App Store or
  TestFlight from this repository.

## Entry points and files

| What | Where |
|---|---|
| Shell config | `mobile/capacitor.config.ts` (`appId` `com.companionintelligence.scan`) |
| Xcode project | `mobile/ios/App/App.xcodeproj`, with the local Swift package `mobile/ios/App/CapApp-SPM` |
| Bridge and plugin | `mobile/ios/App/App/ScanBridgeViewController.swift`, `mobile/ios/App/App/ScanARPlugin.swift` |
| Privacy manifest | `mobile/ios/App/App/PrivacyInfo.xcprivacy` (drafted, no collected data types) |
| Web side | `src/ar/native.ts`, `src/ar/native-bridge.ts`, `src/ar/runtime-select.ts` |
| Not used | `ArSessionPlugin.swift` is in the tree, unregistered, and not in the Xcode target ([DEVICE_TEST_KIT.md](../testing/DEVICE_TEST_KIT.md#ar-in-the-shells)) |

## Build

On a Mac with Xcode. From `mobile/`, after `npm ci` in the repo root:

```bash
npm ci
npm run build:web          # VITE_API_BASE=https://<host>:5173 first names a default server
npx cap sync ios
```

Open `mobile/ios/App/App.xcodeproj`, set your Apple development team under Signing &
Capabilities, and run on the phone. `cap sync ios` takes the Swift Package Manager path because
`ios/App/CapApp-SPM` is tracked. The TestFlight steps need the owner's Apple account
([mobile/README.md](../../mobile/README.md#publishing)).

## Run

1. Give the app its Scan server on the first-run Server row (Add server, then
   `https://<host>:5173` for a dev box), unless the build named one. An address saved on the phone
   beats the build's.
2. Tap Walk the room, pick or create a Place, and confirm. The camera and motion prompts should
   appear.
3. To drive the plugin, turn on Web Inspector on the phone (Settings, Safari, Advanced) and use
   the console from Safari's Develop menu on the Mac.

## Test

- [Checklist D](../testing/DEVICE_TESTING.md#checklist-d--native-arkit-scan-ios-shell) in
  DEVICE_TESTING.md, rows 1 to 10: the camera fit, tracking, a wall hit test, backgrounding, world
  map save and restore, and LiDAR depth. Use an iPhone with LiDAR for the depth rows and one without
  for the rest.
- [DEVICE_TEST_KIT.md](../testing/DEVICE_TEST_KIT.md#iphone-native-shell-needs-a-mac-and-xcode):
  read `Capacitor.Plugins.ScanAR.capabilities()`; `supported` should be true. A native start logs
  `[native-ar] trackingStatus:` lines; the warning `[native-ar] the native session did not start;
  using the web runtime:` means it fell back to 8th Wall.
- Without a device: `npm run test:native-ar` (the web side against a fake plugin), and
  `npm run device:preflight`, which checks the iOS manifest, the permission keys and the Swift
  syntax.

## Known gaps

From [mobile/README.md](../../mobile/README.md#not-done):

- `ScanAR` on a device, and a signed device build from Xcode: the merged tree has only been
  compiled for the simulator.
- A saved world map is not linked to the Place's frame: a map's origin is where its first session
  started (ADR 0010).
- The keyframe upload does not send the depth map yet (`FrameObservation.depthUrl`).
- The session token is in the WebView's `localStorage`; it should move to the Keychain before a
  store build.
- The notices file is generated once for both shells, so on iOS it still carries the Android-only
  ARCore sentence.
- `PrivacyInfo.xcprivacy` is a draft: the privacy policy and the App Privacy answers are open.
- The App Store and TestFlight need the owner's Apple account. A bare wrapper around an AR app is a
  high review risk under Apple 4.2.1, and the store gates ask for measurement first.
