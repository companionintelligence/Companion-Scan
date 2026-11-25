# 0017. The iOS geo view uses ARKit geo tracking in RealityKit, not ARKit-CoreLocation

- **Status:** Accepted
- **Date:** 2026-11-24
- **Related:** ADR 0012 (ScanAR draws its capture view with RealityKit), ADR 0014 (LocAR is a geo viewer, not a
  scanning provider), `docs/factory/15-ar-runtime-targets/0006-ios-geo-view.md` (superseded in part, see below).

## Context

The iOS geo view shows one label per Place at its pin. It was built on ARKit-CoreLocation (ARCL) 1.x, a SceneKit
library pinned by commit in the Xcode project, and its spec ruled out RealityKit for it. Three things have changed:

- **ARKit geo tracking is the platform feature for this.** `ARGeoTrackingConfiguration` with `ARGeoAnchor` places
  content at latitude, longitude and altitude against Apple's geo model, from iOS 14 on A12 or newer and where ARKit
  has coverage. `ARGeoTrackingConfiguration.checkAvailability(at:)` says whether it covers a coordinate. The iOS 27.2
  SDK declares these APIs unchanged in shape.
- **RealityKit is the iOS renderer already.** ScanAR's capture view uses it (ADR 0012), so the geo view adds no second
  renderer.
- **Android and the web have moved too.** ARCore 1.57.0 is the latest on Google's Maven repository, and its Geospatial
  API is the Android counterpart. Android XR's geospatial API is in preview through ARCore for Jetpack XR. Niantic
  Spatial has released the 8th Wall engine as open source with hosted services ending on 2027-02-28, but the engine
  ships under the XR Engine License Agreement. The vendored `public/xr.js` carries that agreement, so its terms need
  review before the web target depends on it.

## Decision

The iOS geo view is rebuilt on the platform's own geo tracking, drawn in RealityKit:

1. Where `ARGeoTrackingConfiguration` has coverage at the phone's location, each Place's label is an `ARGeoAnchor` at
   its pin, added once ARKit reports the session `localized`.
2. Elsewhere, world tracking aligned to gravity and heading places each label from the phone's GPS and compass. The
   status line says which mode is active, and the labels are approximate.
3. Tapping a label shows its distance and an arrow that turns toward it with the phone's heading. The arrow and the
   distance come from `GeoMath` (`mobile/ios/App/App/GeoMath.swift`), which is unit-checked.
4. ARKit-CoreLocation is removed from the project and from `Package.resolved`.

The scanner is unchanged: its view, session, configuration and saved world maps are not touched. The geo view still
refuses to open during a scan, because ARKit runs one session at a time.

This supersedes the "no RealityKit" and "pinned ARCL" conventions of `0006-ios-geo-view.md` for the geo view only.

## Consequences

- Geo tracking needs iOS 14 or later, an A12 chip or newer, and location services. On the Simulator it reports
  unsupported, so only the device can confirm placement.
- The fallback is only as good as GPS and the compass. Labels move by metres and degrees, and the arrow shows the
  heading the compass reports, which may differ from true north by the local magnetic declination.
- One third-party Swift package is gone. The iOS build now depends only on Capacitor's packages.
- Android and Quest are unchanged. An ARCore Geospatial geo view for Android is the next step and needs its own ADR.
- The vendored 8th Wall engine's licence is a separate question, flagged for review, and this ADR does not settle it.
