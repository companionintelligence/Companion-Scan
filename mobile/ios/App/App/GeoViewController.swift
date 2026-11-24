import ARKit
import Capacitor
import CoreLocation
import SceneKit
import UIKit
// The package's product is ARCL, and its module is named after its target, ARKit-CoreLocation. CocoaPods names the
// module ARCL instead. Import whichever this build has.
#if canImport(ARKit_CoreLocation)
import ARKit_CoreLocation
#elseif canImport(ARCL)
import ARCL
#endif

/// A Place shown in the geo view: its name and the creating phone's pin (`Project.geoPose`, src/world/types.ts).
struct GeoPlace {
    let name: String
    let coordinate: CLLocationCoordinate2D

    /// Reads one entry of the `places` array that `ScanAR.openGeoView` receives. An entry without a name, or
    /// with a latitude or longitude that is missing, not finite or out of range, is left out.
    init?(_ object: JSObject) {
        guard let name = object["name"] as? String,
              let lat = (object["lat"] as? NSNumber)?.doubleValue,
              let lng = (object["lng"] as? NSNumber)?.doubleValue,
              lat.isFinite, lng.isFinite, abs(lat) <= 90, abs(lng) <= 180 else {
            return nil
        }
        self.name = name
        coordinate = CLLocationCoordinate2D(latitude: lat, longitude: lng)
    }
}

/// The iOS geo view: ARKit-CoreLocation's `SceneLocationView` (SceneKit) full screen, with one label per Place at
/// its pin. It is a viewer, not a capture path (ADR 0014). It runs the library's own ARKit session while it is
/// shown, so `ScanARPlugin.openGeoView` opens it only when no scan session is running, and the scanner's own view,
/// configuration and saved world maps are never touched (docs/factory/15-ar-runtime-targets/0006-ios-geo-view.md).
final class GeoViewController: UIViewController {
    private let places: [GeoPlace]
    private let onClose: () -> Void
    private var sceneLocationView: SceneLocationView?

    init(places: [GeoPlace], onClose: @escaping () -> Void) {
        self.places = places
        self.onClose = onClose
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not used: the plugin builds this controller in code")
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black

        // Explicit labels: SceneLocationView also inherits ARSCNView's init(frame:options:).
        let sceneView = SceneLocationView(trackingType: .worldTracking, frame: view.bounds, options: nil)
        sceneView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        view.addSubview(sceneView)
        sceneLocationView = sceneView

        for place in places {
            // A pin has no trustworthy height, so the label is kept at the viewer's own height.
            let location = CLLocation(coordinate: place.coordinate, altitude: 0, horizontalAccuracy: 0,
                                      verticalAccuracy: -1, timestamp: Date())
            let node = LocationAnnotationNode(location: location, image: Self.label(for: place.name))
            node.ignoreAltitude = true
            sceneView.addLocationNodeWithConfirmedLocation(locationNode: node)
        }

        var configuration = UIButton.Configuration.filled()
        configuration.title = "Close"
        configuration.baseForegroundColor = .white
        configuration.baseBackgroundColor = UIColor.black.withAlphaComponent(0.6)
        configuration.cornerStyle = .medium
        let close = UIButton(configuration: configuration, primaryAction: UIAction { [weak self] _ in
            self?.dismiss(animated: true)
        })
        close.accessibilityLabel = "Close the geo view"
        close.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(close)
        NSLayoutConstraint.activate([
            close.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 12),
            close.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor, constant: -12),
        ])
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        sceneLocationView?.run()
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        sceneLocationView?.pause()
    }

    override func viewDidDisappear(_ animated: Bool) {
        super.viewDidDisappear(animated)
        // pause() stops the library's session and its 0.5 s location timer, but not CoreLocation, which the library
        // starts when the view is created and gives no way to stop. Releasing the view releases its location
        // manager, and with it the updates. This controller is used once: the plugin builds a new one per open.
        sceneLocationView?.removeFromSuperview()
        sceneLocationView = nil
        onClose()
    }

    /// The label drawn at a Place: its name in white on a dark rounded rectangle.
    private static func label(for name: String) -> UIImage {
        let attributes: [NSAttributedString.Key: Any] = [
            .font: UIFont.systemFont(ofSize: 34, weight: .semibold),
            .foregroundColor: UIColor.white,
        ]
        let text = name as NSString
        let textSize = text.size(withAttributes: attributes)
        let padding: CGFloat = 16
        let box = CGSize(width: ceil(textSize.width) + padding * 2, height: ceil(textSize.height) + padding * 2)
        return UIGraphicsImageRenderer(size: box).image { _ in
            UIColor(white: 0, alpha: 0.7).setFill()
            UIBezierPath(roundedRect: CGRect(origin: .zero, size: box), cornerRadius: 12).fill()
            text.draw(at: CGPoint(x: padding, y: padding), withAttributes: attributes)
        }
    }
}
