# Aura room scanner (Unity)

Unity client for the Companion Scan room scanner on Android XR glasses (Aura). It does what the web scanner does, against the same server API: it opens a capture session, sends pose-tagged keyframes while the wearer walks, then finalizes or withdraws the session. The server is `server/main.ts` in the Companion-Scan repo.

**Status: scaffold.** The engine-free Core is verified by a .NET harness. The Unity-facing code compiles against compile-only API stubs. Nothing has run in the Unity Editor or on an Aura yet.

Reference: [android/xr-unity-samples](https://github.com/android/xr-unity-samples) (`AndroidXRUnitySamples`). Its packages and versions are used here. Its camera capture is a technique to reference, not code to copy.

## Layout

- `Assets/AuraScanner/Core/`: engine-free logic (`noEngineReferences`). Pose convention, keyframe trigger, record JSON, upload retry rule, frame orientation.
- `Assets/AuraScanner/Unity/`: engine-facing code, namespace `AuraScanner.Runtime`.
  - `AuraScanController.cs`: the MonoBehaviour. Start, Stop, Withdraw, and an IMGUI HUD. Check that the HUD is legible in the headset.
  - `CompanionClient.cs`: the server's session routes as coroutines.
  - `HeadPoseSource.cs`: head pose from OpenXR, converted to the server's convention.
  - `IFrameSource.cs`, `WebCamFrameSource.cs`, `PlaceholderFrame.cs`: camera frames, and generated frames for testing.
- `Tests/CoreHarness/`: a .NET 8 console program that checks `Core`. It compiles the Core sources directly, not copies.

## Build and run

You need Unity 6000.3.14f1 (`ProjectSettings/ProjectVersion.txt`), Android Build Support, and an Aura.

1. Open `unity/aura-scanner` in Unity Hub. The first open resolves `Packages/manifest.json`, which fetches `com.google.xr.extensions` from GitHub, and writes `.meta` files. Commit the `.meta` files after that first open.
2. Packages match the reference sample: `com.unity.xr.androidxr-openxr` 1.4.1, `com.unity.xr.openxr` 1.18.0, `com.unity.xr.management` 4.7.0, Android XR extensions v1.5.0, URP 17.3.0.
3. Set Player settings by hand. They are not generated here. Use Android minimum API level 30 and ARM64, the reference sample's values. Check the rest against the reference's `ProjectSettings`, which this scaffold does not copy. Enable the OpenXR and Android XR features under XR Plug-in Management for Android.
4. Make a scene with an empty GameObject that has `AuraScanController`. Set `serverUrl` to the server's HTTPS tailnet address, because Android blocks cleartext HTTP by default. Do not commit a real `bearerToken`, since the scene file keeps it.
5. First run: tick `placeholderFrames`. It sends generated JPEGs, which checks the upload path without a camera. Those frames show no room, so do not reconstruct from them.

## Server contract

When sign-in is on, every `/sessions` route sits behind the Companion session guard (`server/main.ts`, `SESSION_GUARDED_PATHS`). Send the session token as `Authorization: Bearer`.

| Call | Body | Reply |
|---|---|---|
| `POST /sessions` | none | `201` with `sessionId` |
| `POST /sessions/:id/keyframes` | multipart `image` (JPEG file) and `meta` (JSON text) | `{ ok, index }` |
| `POST /sessions/:id/finalize` | JSON `{}` | the session record |
| `DELETE /sessions/:id` | none | removes that session's frames. `404` once gone |

`meta` carries `index` (integer, from 0, below 2000), `timestamp` (ms), `capturedAt` (epoch ms), `epoch` (tracking stretch), `pose` (`position` and `rotation`, in the server's convention) and `intrinsics` (`fovYDeg`, `aspect`, `width`, `height`, `sourceWidth`, `sourceHeight`). `KeyframeRecord` writes this shape, and the harness checks it.

The keyframe trigger uses the web client's values: 1.2 s minimum interval, and 0.30 m or 20° of change (`src/capture/keyframes.ts`). Only one upload is in flight at a time. Retries follow the web client's rule. After a failure, capture pauses for 10 s.

## Coordinates

Unity is left-handed with +Z forward. The server and WebXR are right-handed with −Z forward. `PoseConvention` mirrors Z: position `(x, y, -z)`, rotation `(-qx, -qy, qz, qw)`. The harness checks that the mirrored Unity forward equals the converted −Z forward, across 500 random rotations. That confirms the algebra. The walk checks below confirm the signs on real tracking.

`epoch` advances each time head tracking returns after a loss, because the new stretch may sit in a new coordinate frame.

## Verified here

- `dotnet run --project Tests/CoreHarness`: 1054 checks, 0 failed (.NET SDK 8.0.133).
- The Unity-facing code compiles against compile-only stubs of the Unity API, for both the Android branch and the editor branch, with 0 errors and 0 warnings. The stubs copy the signatures the code calls. They are not Unity, so the first real compile happens in the Editor.
- `Packages/manifest.json` and the two `.asmdef` files parse as JSON.

Not verified: anything in the Unity Editor, or on an Aura.

## Device checks

Run these in order. Each one answers a question the code cannot answer.

1. **Upload path, placeholder frames.** Start, walk a few metres, Stop. The server's `scans/sessions/<id>/` folder should hold `kf-NNNNN.jpg` files and `keyframes.jsonl`, and `session.json` should record `finalizedAt`.
2. **Pose sign.** Walk straight ahead toward a wall. `pose.position.z` in `keyframes.jsonl` should decrease, because the converted forward is −Z. Turn right by 90°. The forward direction, meaning the converted −Z axis, should swing toward +X. If either sign is wrong, fix it in `PoseConvention`.
3. **Head tracking.** Position and rotation must both be tracked, which means 6DoF. Without position tracking nothing is captured, and the HUD shows no keyframes. Lose tracking briefly, for example by moving out of view of the tracking cameras, and check that `epoch` advances after it recovers.
4. **Camera.** The log line `[aura-scan] frame WxH, rotation R, mirrored M` gives the device's values. An uploaded JPEG should be upright and not mirrored. If the Aura does not expose a camera through WebCamTexture, Start reports "no camera frames". The next step is a Camera2 plugin behind `IFrameSource`, using the approach in the reference sample's `Gemini/Scripts/Plugins/Camera/Java/CameraCapturePlugin.java`. Check that code's licence (Apache-2.0) before any port.
5. **Field of view.** `fovYDegrees` defaults to 60 and is not measured. Calibrate it before the intrinsics are trusted for reconstruction.
6. **Failure handling.** Stop the server mid-walk. The HUD counts failures, capture pauses 10 s after each one, and capture resumes when the server returns.
7. **Withdraw.** Withdraw consent. The session's frames are deleted (`DELETE` returns 200), and a repeat returns 404.
8. **Pause.** Send the app to the background. The session is finalized.

## Open decisions

- **Sign-in.** The Quest app signs in through the system browser and sends the token as `Authorization: Bearer`, returning to a fixed URL the server allows (`QUEST_RETURN_URL`, `server/portal_auth.ts`). The Aura app has no sign-in yet. Either reuse that return URL or add an Aura one on the server. The server change needs an owner decision.
- **Consent copy.** Start is the wearer's yes, shown only as a HUD button. The web client has a consent step (`src/capture/keyframe-consent*.ts`), and the Aura wording should match it.
- **Camera route.** WebCamTexture first. Switch to a Camera2 plugin if device check 4 fails.
- **Server address.** `serverUrl` is a placeholder. It needs the tailnet HTTPS address of the Scan server, reachable from the Aura.

## Not in this scaffold

- The scene and prefab (make them in the Editor).
- Player settings and XR feature setup beyond the list above.
- The sign-in flow.
- The Camera2 plugin.
- Scan upload and the World Editor. The server reconstructs from the session.
