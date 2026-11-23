> **Type:** Decision
> **Wave:** 13-ar-runtime-targets
> **Branch:** None. The work is [0006](0006-ios-geo-view.md).
> **Commit style:** N/A
> **Design:** The survey of ARKit-CoreLocation at `develop` and of `mobile/ios/App/App/` is summarised in the [wave README](README.md).
> **Dependencies:** None

## Goal

Choose how the iOS target renders the AR view with ARKit-CoreLocation's geo layer.

## Non-goals

- Store submission. The Apple account and signing are the owner's.

## Pinned conventions

- The iOS deployment target is 16.4 (`mobile/ios/App/App.xcodeproj/project.pbxproj`). The library's AR code needs iOS 11.
- `ArSessionPlugin.swift` is not in the Xcode project, and is not compiled.
- ADR 0009: native AR runtimes sit beside 8th Wall. ADR 0010: iOS world maps stay on the phone. ADR 0012: locar, and any geo view, is a viewer.

## Before implementation

- `mobile/ios/App/App/ScanARPlugin.swift` in full, then `ArSessionPlugin.swift`.
- Upstream at `develop`: `Sources/ARKit-CoreLocation/SceneLocationView.swift`, `SceneLocationManager.swift` and `LocationManager.swift`.

## Open questions & answers

- Which renderer? **SceneKit. The owner chose it on 2026-11-23 ("use SceneKit for iOS").** The earlier target line, "iOS RealityKit build using ARKit-CoreLocation", is superseded. ARKit-CoreLocation renders only with SceneKit, and a RealityKit build would have been option B, which nothing had started.
- Swap the scanner's view, or show a separate one? A separate one ([0006](0006-ios-geo-view.md)). A swap at `ScanARPlugin.swift:158` would never run the library's location loop if `run()` is not called. If `run()` is called, the scanner's configuration and saved world map are replaced. A separate view, open only while no scan runs, lets the library run as it is designed to.
- Does ARKit re-align a saved `ARWorldMap` under `gravityAndHeading`? Not verified. With a separate view, it no longer matters: the scanner's maps are never loaded into the geo view.

## Options

- **A. SceneKit with ARKit-CoreLocation, chosen.** The library, read from source:
  - `SceneLocationView` subclasses `ARSCNView`.
  - Its `run()` starts its own world-tracking configuration: horizontal planes, `gravityAndHeading` by default, and no `initialWorldMap` or `sceneDepth`.
  - Its 0.5 s location timer starts only from `run()` or from `sceneLocationManager.run()`. `pause()` stops the session and that timer.
  - CoreLocation starts when the view is created, and the library has no call that stops it. Only releasing the view stops it.
- **B. RealityKit port.** Rebuild the view, the nodes, the estimate and the labels on `ARView` and `AnchorEntity`, reusing `CLLocation+Extensions.swift` and `ScalingScheme.swift`. Not started, and not chosen.
- **C. ARKit without the geo layer.** Place content with the scanner's own `latLngToScene`. Not chosen.

## Files impacted

See [0006](0006-ios-geo-view.md).

## Schema required

N/A.

## Definition of Done

- [x] The owner chose SceneKit on 2026-11-23, recorded above.
- [x] The first ticket of the chosen option is written: [0006](0006-ios-geo-view.md).

## Tests

See [0006](0006-ios-geo-view.md).

## Acceptance Criteria

The decision is recorded, and no RealityKit work is planned under this wave.

## Risks / potential issues

- Building the geo view starts CoreLocation, which asks for location permission when the geo view first opens.

## Subtasks

- [x] Owner decision
- [x] [0006](0006-ios-geo-view.md) written
