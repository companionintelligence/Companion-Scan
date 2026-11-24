> **Type:** Native app
> **Wave:** 13-device-targets
> **Branch:** `feat/ios-realitykit-view`
> **Commit style:** `feat(ios): summary`
> **Design:** ADR 0012
> **Dependencies:** None

## Goal

The iOS shell draws its native AR camera with RealityKit's `ARView` in place of SceneKit's `ARSCNView`, with the `ScanAR` contract unchanged. Until this wave `ScanARPlugin.swift` was the only file that imported SceneKit, and drew the camera with an `ARSCNView` (`mobile/ios/App/App/ScanARPlugin.swift:58` and `:158`).

## Non-goals

- Do not change the JavaScript contract (`src/ar/native-bridge.ts`, `src/ar/native.ts`).
- Do not train or render splats natively (later option, ADR 0012).
- Do not touch `ArSessionPlugin.swift`, which is unregistered.
- Do not raise the deployment target above iOS 16.4.

## Pinned conventions

- ADR 0009 is the contract, and ADR 0012 is the decision.
- `ARView` is used with camera mode `.ar` and `automaticallyConfigureSession = false`. The plugin runs the same `ARWorldTrackingConfiguration` as before.
- Hit samples (`sample(atNormalized:in:from:)` at `:562` and `hitGrid(in:from:timestamp:)` at `:580`, before the change) come from ARKit raycasts. They return the same fields, units and frames.
- New Swift files, if any, are added to the App target in `project.pbxproj` (PBXBuildFile, PBXFileReference, the App group, and the Sources phase).
- No Xcode on the build host. The compile check is the iOS Simulator job of `.github/workflows/mobile-build.yml` (`macos-26`, `CODE_SIGNING_ALLOWED=NO`), on a pushed ref.

## Before implementation

- Read `ScanARPlugin.swift` whole, `ScanBridgeViewController.swift`, `src/ar/native-bridge.ts` and the "Native AR capture" section of `mobile/README.md`.
- Read Checklist D in `docs/testing/DEVICE_TESTING.md`. Its rows are the device test for this ticket.

## Open questions & answers

- Q: Do raycasts answer the same as the SceneKit hit tests did? — OPEN. Estimated planes, existing planes and feature points can differ. The first device run compares hit samples.
- Q: Does the contain fit survive the view swap? — OPEN until a device run. The rect and `cameraAspect` must be unchanged.
- Q: Did an earlier CI run compile the shell? — A: Run 45232956898, on `main` at `1e8f34f`, compiled the SceneKit version on 2026-11-23.

## Files impacted

- Changed: `mobile/ios/App/App/ScanARPlugin.swift`, possibly `mobile/ios/App/App.xcodeproj/project.pbxproj`.
- Docs to update after the change: `mobile/README.md` and `docs/targets/ios.md`.

## Schema required

None.

## Definition of Done

- [ ] No SceneKit import in the App target.
- [ ] The `mobile-build.yml` iOS job is green on the pushed ref.
- [ ] `npm run test:native-ar` passes, so the web side of the contract is unchanged.

## Tests

- [ ] CI: iOS Simulator build.
- [ ] Local: `npm run test:native-ar` and `npm run test:mobile-config`.

```bash
gh workflow run mobile-build.yml --ref <pushed-branch>
npm run test:native-ar && npm run test:mobile-config
```

## Acceptance Criteria

- [ ] Given an iPhone run of Checklist D, rows 1 to 3 behave as before: camera behind the web view, pose events, and a wall hit test whose rotation is not identity.

## Risks / potential issues

- **Risk:** An API signature is wrong, and nothing here compiles Swift. — **Mitigation:** Read the diff line by line; let CI judge; keep the change small.
- **Risk:** ARView's own render loop costs frame time. — **Mitigation:** Record frame timing in the first device run.

## Subtasks

1. [ ] Swap `ARSCNView` for `ARView`, and configure the session explicitly.
2. [ ] Replace the hit sampling with raycasts.
3. [ ] Remove the SceneKit import.
4. [ ] Push, and dispatch the iOS job.
5. [ ] Update `mobile/README.md` and `docs/targets/ios.md`.
