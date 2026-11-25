import CoreLocation
import Foundation

/// Where one coordinate lies from another, on the local tangent plane at the origin.
///
/// The geo view uses this where ARKit geo tracking cannot place labels: it turns a Place's pin into metres east and north
/// of the phone, and into the direction to turn toward. Over the few kilometres a Place is seen from, the equirectangular
/// approximation here is far inside GPS error, so it stays a few lines rather than a geodesy package.
enum GeoMath {
    /// Mean Earth radius in metres (IUGG).
    static let earthRadius: Double = 6_371_008.8

    struct Offset: Equatable {
        /// Metres east of the origin. Negative is west.
        let east: Double
        /// Metres north of the origin. Negative is south.
        let north: Double

        /// Straight-line distance in metres.
        var distance: Double { (east * east + north * north).squareRoot() }

        /// Bearing from true north, clockwise, in degrees in [0, 360).
        var bearing: Double {
            let degrees = atan2(east, north) * 180 / .pi
            return degrees < 0 ? degrees + 360 : degrees
        }
    }

    /// The offset from `origin` to `target`. Longitudes are wrapped, so two points either side of the antimeridian are
    /// measured the short way round.
    static func offset(from origin: CLLocationCoordinate2D, to target: CLLocationCoordinate2D) -> Offset {
        let latitude0 = origin.latitude * .pi / 180
        let deltaLatitude = (target.latitude - origin.latitude) * .pi / 180
        var deltaLongitude = target.longitude - origin.longitude
        if deltaLongitude > 180 { deltaLongitude -= 360 }
        if deltaLongitude < -180 { deltaLongitude += 360 }
        let deltaLongitudeRadians = deltaLongitude * .pi / 180
        return Offset(
            east: deltaLongitudeRadians * earthRadius * cos(latitude0),
            north: deltaLatitude * earthRadius
        )
    }

    /// The turn from the phone's heading to a bearing, in degrees in (-180, 180]. Positive is clockwise, so the arrow
    /// should rotate by this much.
    static func relativeBearing(target: Double, heading: Double) -> Double {
        var delta = (target - heading).truncatingRemainder(dividingBy: 360)
        if delta > 180 { delta -= 360 }
        if delta <= -180 { delta += 360 }
        return delta
    }
}
