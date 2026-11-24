> **Type:** iOS
> **Wave:** 15-ar-runtime-targets
> **Branch:** `feat/locar-spike`
> **Commit style:** `feat(ios): ...`
> **Design:** This ticket is the spec. The decision is [0003](0003-ios-renderer.md).
> **Dependencies:** [0003](0003-ios-renderer.md)

## Goal

An iOS geo view on ARKit-CoreLocation with SceneKit. It is opened by the viewer ([0005](0005-locar-viewer.md)) in the iOS shell, shows one label per Place at its pin, and is compiled by CI, because the build host has no Xcode.

## Non-goals

- No change to the scanner's `ARSCNView`, its session, its configuration or its saved world maps.
- No RealityKit ([0003](0003-ios-renderer.md)).
- No store build.

## Pinned conventions

- The library is a Swift package pinned by revision in the Xcode project: `https://github.com/AndrewHartAR/ARKit-CoreLocation`, `c74634de4313183e281b323941a5d51fcd165533` (`develop`, 2025-12-30). Its product is `ARCL`. Its module is named after its target, `ARKit-CoreLocation`, while CocoaPods names it `ARCL`, so the Swift file imports whichever exists.
- The iOS shell registers exactly one plugin, ScanAR (`tests/unit/node/wp-docs-device-claims.test.ts` pins that). So the geo view is two methods on ScanAR (`openGeoView`, `closeGeoView`), not a new plugin.
- The geo view runs the library's own session. ScanAR refuses to open it while a scan session runs, because ARKit runs one session at a time.
- Teardown: `pause()` stops the session and the library's location timer. CoreLocation stops only when the view is released, so the controller releases it when it disappears.
- Labels ignore altitude, because a Place's pin has no trustworthy height.
- ADR 0009, ADR 0010, ADR 0012 (ScanAR's capture view is drawn with RealityKit) and ADR 0014.

## Before implementation

- `mobile/ios/App/App/ScanARPlugin.swift` and `ScanBridgeViewController.swift`, and `project.pbxproj`.
- Upstream at the pinned revision: `SceneLocationView.swift` (the public extension with `run`, `pause` and `addLocationNodeWithConfirmedLocation`) and `LocationNode.swift` (`ignoreAltitude`).

## Open questions & answers

- Why not swap the scanner's view? See [0003](0003-ios-renderer.md). A swap either never starts the library's loop, or replaces the scanner's configuration and world map.
- Can it be compiled here? No. The Mobile Build workflow's iOS Simulator job compiles it, on GitHub's macOS runner, when run by hand.

## Files impacted

- `mobile/ios/App/App/GeoViewController.swift` (new)
- `mobile/ios/App/App/ScanARPlugin.swift`: two methods, a property, and two entries in the method table
- `mobile/ios/App/App.xcodeproj/project.pbxproj`: the file, the remote package reference, and the `ARCL` product linked into App
- `src/ar/native-bridge.ts`: the optional methods on the ScanAR interface

## Schema required

N/A.

## Definition of Done

- [x] The Mobile Build iOS Simulator job compiles the branch. Run 45256020164, at `8858c08` on 2026-11-23, succeeded. It fetched the package, built it as the module `ARKit_CoreLocation`, and compiled `GeoViewController.swift` and `ScanARPlugin.swift` with no error or warning in either. The same run's Android debug job passed too.
- [ ] A device run: labels at the Places' directions, and the view closes and stops location.
- Before any store build, not this ticket:
  - [ ] The location purpose string in `Info.plist` covers placing labels in the geo view.
  - [ ] `docs/operations/PRIVACY.md` has a row for the geo view.
  - [ ] Notices for the iOS app's Swift packages. None are generated today, for Capacitor's either.

## Tests

- CI only, for the Swift. The web side's interface change is type-checked by `tsc --noEmit`.

## Acceptance Criteria

- [x] The iOS app builds with the package resolved at the pinned revision (run 45256020164).
- [x] The scanner's view, session and world maps are untouched by this change.

## Risks / potential issues

- The Swift has not been compiled here. API names come from the library's source at the pinned revision.
- If the library keeps its view alive through a retain cycle, CoreLocation would keep running after the view closes. Check this on a device.

## Subtasks

- [x] Geo view controller and ScanAR methods
- [x] Swift package pinned in the Xcode project
- [x] CI compile (run 45256020164)
- [ ] Device run
