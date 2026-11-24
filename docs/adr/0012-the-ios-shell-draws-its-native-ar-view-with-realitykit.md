# 0012. The iOS shell draws its native AR view with RealityKit

- **Status:** Accepted, on the owner's request of 2026-11-23. Compile verification in CI; device verification pending.
- **Date:** 2026-11-23
- **Related issue:** none (wave `docs/factory/13-device-targets/`)

## Context

The iOS shell (`mobile/ios`) runs the `ScanAR` plugin (ADR 0009). Until this decision, `ScanARPlugin.swift` ran an ARKit world-tracking session and drew the camera with an `ARSCNView`, so SceneKit was the renderer under the web view. `ScanARPlugin.swift` was the only file that imported SceneKit.

Two places left RealityKit open:

- The 2026-11-13 goal-readiness audit listed "whether RealityKit is wanted at all" as an owner decision (`docs/audits/2026-11-13-goal-readiness.md`, line 359).
- `ArSessionPlugin.swift`, the second plugin that no shell registers, says "RealityKit is out of scope".

On 2026-11-23 the owner asked for an iOS RealityKit build among the six device targets.

Two iPhone projects informed the scope, as references only, with no code copied:

- Splatelier (Apache-2.0) trains and views Gaussian splats on the phone with MLX and Slang kernels compiled to Metal, and views them with MetalSplatter.
- splatify-anything (PolyForm Noncommercial 1.0.0) trains on the phone with its own Metal kernels and exports COLMAP and SOG.

## Decision

1. `ScanARPlugin` draws the camera with RealityKit's `ARView`, with camera mode `.ar`. The plugin configures and runs the session itself, as it did before: `automaticallyConfigureSession` is off, and the `ARWorldTrackingConfiguration` is unchanged.
2. The plugin's JavaScript contract does not change: method names, parameters, return shapes, events, units and frames (ADR 0009, `src/ar/native-bridge.ts`).
3. Hit samples come from ARKit raycasts through the `ARView` or its session, and return the same fields in the same frame.
4. SceneKit leaves the App target.
5. Capture does not change. ARKit frames become keyframes, which reach the existing reconstruction and `splat-train` WorldJobs through the existing session routes (ADR 0001, ADR 0003). No second pipeline is added.
6. On-device splat training on iOS is out of scope for this decision. It is recorded as a later option in the wave plan.

## Consequences

- This machine has no Xcode, so the change is verified only by the iOS Simulator job of `.github/workflows/mobile-build.yml`, on a pushed ref. No device run has happened.
- Raycasts may answer differently from the SceneKit hit tests they replace, for estimated planes, existing planes and feature points. The first device run should compare hit samples against the Android shell's.
- RealityKit opens later options without committing to them: a scene-understanding mesh on LiDAR phones, and a native splat renderer (MetalSplatter, MIT) beside the web viewer.
- The decision about `ArSessionPlugin` (keep or remove the second native design) stays open.
