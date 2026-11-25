import ARKit
import Capacitor
import Combine
import CoreLocation
import RealityKit
import UIKit

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

/// The iOS geo view: one label per Place at its pin, in a RealityKit view, with an arrow and the distance to the Place
/// the viewer taps. It is a viewer, not a capture path (ADR 0014).
///
/// Each label is placed from the best source the phone has, and the status line says which:
/// - ARKit geo tracking, where ARKit has coverage at the phone's location. Each label is an `ARGeoAnchor` at the Place's
///   pin, added once ARKit reports the session localized.
/// - Otherwise world tracking aligned to gravity and heading, with each label placed from the phone's GPS and compass.
///   That is approximate: GPS and compass error move the labels by metres and degrees.
///
/// The view runs its own ARKit session, so `ScanARPlugin.openGeoView` refuses to open it while a scan session runs. It
/// owns its location and heading updates and stops them when it disappears. The scanner's view, configuration and saved
/// world maps are never touched.
final class GeoViewController: UIViewController {
    private enum Mode: Equatable {
        case waitingForLocation
        case localizing
        case geoTracked
        case approximate
        case unavailable(String)
    }

    private let places: [GeoPlace]
    private let onClose: () -> Void
    private let locationManager = CLLocationManager()
    private var arView: ARView?
    private var updateSubscription: Cancellable?
    private var location: CLLocation?
    private var heading: CLLocationDirection?
    private var sessionStarted = false
    private var geoLabelsPlaced = false
    private var lastGeoState: ARGeoTrackingStatus.State?
    private var labelRoots: [Entity] = []
    private var selectedIndex: Int?
    private var mode: Mode = .waitingForLocation {
        didSet { updateStatus() }
    }

    private let statusLabel = UILabel()
    private let selectionPanel = UIView()
    private let selectionName = UILabel()
    private let selectionDistance = UILabel()
    private let arrow = UIImageView(image: UIImage(systemName: "location.north.fill"))

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

        let arView = ARView(frame: view.bounds, cameraMode: .ar, automaticallyConfigureSession: false)
        arView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        arView.session.delegate = self
        arView.addGestureRecognizer(UITapGestureRecognizer(target: self, action: #selector(tapped(_:))))
        view.addSubview(arView)
        self.arView = arView
        updateSubscription = arView.scene.subscribe(to: SceneEvents.Update.self) { [weak self] _ in
            self?.faceLabelsToCamera()
        }

        locationManager.delegate = self
        locationManager.desiredAccuracy = kCLLocationAccuracyBest
        locationManager.distanceFilter = 1
        locationManager.headingFilter = 1

        buildOverlay()
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        startLocationIfAllowed()
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        locationManager.stopUpdatingLocation()
        locationManager.stopUpdatingHeading()
        arView?.session.pause()
    }

    override func viewDidDisappear(_ animated: Bool) {
        super.viewDidDisappear(animated)
        // Everything this view started is stopped in viewWillDisappear. Release the ARView and its scene, then tell the
        // plugin. This controller is used once: the plugin builds a new one for each open.
        updateSubscription?.cancel()
        updateSubscription = nil
        arView?.removeFromSuperview()
        arView = nil
        labelRoots.removeAll()
        onClose()
    }

    // MARK: - Location

    private func startLocationIfAllowed() {
        switch locationManager.authorizationStatus {
        case .notDetermined:
            locationManager.requestWhenInUseAuthorization()
        case .authorizedWhenInUse, .authorizedAlways:
            locationManager.startUpdatingLocation()
            locationManager.startUpdatingHeading()
        default:
            mode = .unavailable("Location is off. Turn it on in Settings to place the labels.")
        }
    }

    // MARK: - Session

    private func startSession() {
        guard let location else { return }
        guard ARWorldTrackingConfiguration.isSupported else {
            mode = .unavailable("ARKit is not available on this device.")
            return
        }
        sessionStarted = true
        guard ARGeoTrackingConfiguration.isSupported else {
            runApproximateSession(from: location)
            return
        }
        // Coverage is per place: ask ARKit whether geo tracking works where the phone is, and fall back if not.
        ARGeoTrackingConfiguration.checkAvailability(at: location.coordinate) { [weak self] available, _ in
            DispatchQueue.main.async {
                guard let self else { return }
                if available {
                    self.runGeoSession()
                } else {
                    self.runApproximateSession(from: location)
                }
            }
        }
    }

    private func runGeoSession() {
        guard let arView else { return }
        geoLabelsPlaced = false
        arView.session.run(ARGeoTrackingConfiguration(), options: [.resetTracking, .removeExistingAnchors])
        mode = .localizing
    }

    private func runApproximateSession(from origin: CLLocation) {
        guard let arView else { return }
        let configuration = ARWorldTrackingConfiguration()
        // Aligned to gravity and heading: ARKit's +X is east and -Z is north, from the phone's pose at the start.
        configuration.worldAlignment = .gravityAndHeading
        configuration.planeDetection = []
        configuration.environmentTexturing = .none
        arView.session.run(configuration, options: [.resetTracking, .removeExistingAnchors])
        placeApproximateLabels(from: origin)
        mode = .approximate
    }

    private func handleGeoState(_ state: ARGeoTrackingStatus.State) {
        switch state {
        case .localized:
            if !geoLabelsPlaced { placeGeoLabels() }
            mode = .geoTracked
        case .initializing, .localizing:
            mode = .localizing
        case .notAvailable:
            mode = .unavailable("ARKit geo tracking is not available here right now.")
        @unknown default:
            break
        }
    }

    // MARK: - Labels

    /// One `ARGeoAnchor` per Place, added once the session is localized. The label sits about eye height above the
    /// anchor, which ARKit places on the ground.
    private func placeGeoLabels() {
        guard let arView else { return }
        geoLabelsPlaced = true
        for (index, place) in places.enumerated() {
            let anchor = ARGeoAnchor(coordinate: place.coordinate)
            arView.session.add(anchor: anchor)
            let anchorEntity = AnchorEntity(anchor: anchor)
            anchorEntity.addChild(makeLabel(name: place.name, index: index, height: 1.4))
            arView.scene.addAnchor(anchorEntity)
        }
    }

    /// One label per Place, placed from the phone's own GPS fix: the offset from where the session started, on the
    /// axes ARKit uses when aligned to gravity and heading. Accuracy is that of GPS and the compass.
    private func placeApproximateLabels(from origin: CLLocation) {
        guard let arView else { return }
        for (index, place) in places.enumerated() {
            let offset = GeoMath.offset(from: origin.coordinate, to: place.coordinate)
            let anchor = AnchorEntity(world: SIMD3<Float>(Float(offset.east), 0, Float(-offset.north)))
            anchor.addChild(makeLabel(name: place.name, index: index, height: 0))
            arView.scene.addAnchor(anchor)
        }
    }

    /// A label: the Place's name in white on a dark plate, facing the viewer. Its entity is named `place-<index>` so a
    /// tap can find it.
    private func makeLabel(name: String, index: Int, height: Float) -> Entity {
        let root = Entity()
        root.name = "place-\(index)"
        root.position = SIMD3<Float>(0, height, 0)

        let text = MeshResource.generateText(name, extrusionDepth: 0.002, font: .systemFont(ofSize: 0.12, weight: .semibold))
        let bounds = text.bounds
        let plate = ModelEntity(
            mesh: .generatePlane(width: bounds.extents.x + 0.06, height: bounds.extents.y + 0.05, cornerRadius: 0.015),
            materials: [SimpleMaterial(color: UIColor(white: 0, alpha: 0.75), isMetallic: false)])
        let label = ModelEntity(mesh: text, materials: [UnlitMaterial(color: .white)])
        label.position = SIMD3<Float>(-bounds.center.x, -bounds.center.y, 0.003)
        root.addChild(plate)
        root.addChild(label)
        labelRoots.append(root)
        return root
    }

    /// Turns every label to face the camera. Runs each frame, so it is kept to a few vector operations per label.
    private func faceLabelsToCamera() {
        guard let arView, let transform = arView.session.currentFrame?.camera.transform else { return }
        let camera = SIMD3<Float>(transform.columns.3.x, transform.columns.3.y, transform.columns.3.z)
        for root in labelRoots {
            let toCamera = camera - root.position(relativeTo: nil)
            guard simd_length(toCamera) > 0.001 else { continue }
            root.setOrientation(simd_quatf(from: SIMD3<Float>(0, 0, 1), to: simd_normalize(toCamera)), relativeTo: nil)
        }
    }

    // MARK: - Selection

    @objc private func tapped(_ recognizer: UITapGestureRecognizer) {
        guard let arView else { return }
        var entity = arView.entity(at: recognizer.location(in: arView))
        while let current = entity {
            if current.name.hasPrefix("place-"), let index = Int(current.name.dropFirst("place-".count)) {
                selectedIndex = index
                refreshSelection()
                return
            }
            entity = current.parent
        }
    }

    /// Shows the distance to the selected Place and an arrow that turns toward it as the phone turns.
    private func refreshSelection() {
        guard let index = selectedIndex, places.indices.contains(index) else {
            selectionPanel.isHidden = true
            return
        }
        let place = places[index]
        selectionPanel.isHidden = false
        selectionName.text = place.name
        guard let location else {
            selectionDistance.text = "Finding your location…"
            arrow.isHidden = true
            return
        }
        let offset = GeoMath.offset(from: location.coordinate, to: place.coordinate)
        selectionDistance.text = Self.distanceText(offset.distance)
        guard let heading else {
            arrow.isHidden = true
            return
        }
        arrow.isHidden = false
        let turn = GeoMath.relativeBearing(target: offset.bearing, heading: heading)
        arrow.transform = CGAffineTransform(rotationAngle: CGFloat(turn) * .pi / 180)
    }

    private static func distanceText(_ meters: Double) -> String {
        if meters < 1000 { return "\(Int(meters.rounded())) m" }
        return String(format: "%.1f km", meters / 1000)
    }

    // MARK: - Overlay

    private func buildOverlay() {
        statusLabel.font = .systemFont(ofSize: 15, weight: .semibold)
        statusLabel.textColor = .white
        statusLabel.textAlignment = .center
        statusLabel.numberOfLines = 0
        statusLabel.backgroundColor = UIColor.black.withAlphaComponent(0.6)
        statusLabel.layer.cornerRadius = 10
        statusLabel.layer.masksToBounds = true
        statusLabel.translatesAutoresizingMaskIntoConstraints = false

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

        selectionPanel.backgroundColor = UIColor.black.withAlphaComponent(0.6)
        selectionPanel.layer.cornerRadius = 14
        selectionPanel.isHidden = true
        selectionPanel.translatesAutoresizingMaskIntoConstraints = false
        selectionName.font = .systemFont(ofSize: 20, weight: .semibold)
        selectionName.textColor = .white
        selectionDistance.font = .monospacedDigitSystemFont(ofSize: 17, weight: .regular)
        selectionDistance.textColor = UIColor.white.withAlphaComponent(0.85)
        arrow.tintColor = .systemYellow
        arrow.contentMode = .scaleAspectFit
        arrow.translatesAutoresizingMaskIntoConstraints = false
        let texts = UIStackView(arrangedSubviews: [selectionName, selectionDistance])
        texts.axis = .vertical
        let row = UIStackView(arrangedSubviews: [arrow, texts])
        row.spacing = 12
        row.alignment = .center
        row.translatesAutoresizingMaskIntoConstraints = false
        selectionPanel.addSubview(row)

        for subview in [statusLabel, close, selectionPanel] {
            view.addSubview(subview)
        }
        NSLayoutConstraint.activate([
            statusLabel.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 12),
            statusLabel.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 12),
            statusLabel.trailingAnchor.constraint(lessThanOrEqualTo: close.leadingAnchor, constant: -8),
            close.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 12),
            close.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor, constant: -12),
            selectionPanel.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 16),
            selectionPanel.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -16),
            selectionPanel.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor, constant: -16),
            row.topAnchor.constraint(equalTo: selectionPanel.topAnchor, constant: 14),
            row.bottomAnchor.constraint(equalTo: selectionPanel.bottomAnchor, constant: -14),
            row.leadingAnchor.constraint(equalTo: selectionPanel.leadingAnchor, constant: 14),
            row.trailingAnchor.constraint(equalTo: selectionPanel.trailingAnchor, constant: -14),
            arrow.widthAnchor.constraint(equalToConstant: 44),
            arrow.heightAnchor.constraint(equalToConstant: 44),
        ])
    }

    private func updateStatus() {
        let text: String
        switch mode {
        case .waitingForLocation: text = "Waiting for your location…"
        case .localizing: text = "ARKit geo tracking: localizing…"
        case .geoTracked: text = "ARKit geo tracking"
        case .approximate: text = "Approximate: GPS and compass"
        case let .unavailable(reason): text = reason
        }
        statusLabel.text = text
        statusLabel.accessibilityLabel = text
    }
}

// MARK: - Delegates

extension GeoViewController: ARSessionDelegate {
    func session(_ session: ARSession, didUpdate frame: ARFrame) {
        // Runs every frame, so it acts only when the geo-tracking state changes.
        guard let status = frame.geoTrackingStatus, status.state != lastGeoState else { return }
        lastGeoState = status.state
        let state = status.state
        DispatchQueue.main.async { [weak self] in self?.handleGeoState(state) }
    }
}

extension GeoViewController: CLLocationManagerDelegate {
    func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        startLocationIfAllowed()
    }

    func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard let latest = locations.last(where: { $0.horizontalAccuracy >= 0 }) else { return }
        location = latest
        if !sessionStarted { startSession() }
        refreshSelection()
    }

    func locationManager(_ manager: CLLocationManager, didUpdateHeading newHeading: CLHeading) {
        heading = newHeading.trueHeading >= 0 ? newHeading.trueHeading : newHeading.magneticHeading
        refreshSelection()
    }

    func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        // A transient error is not a reason to leave the view: updates keep running and the next fix replaces it.
    }
}
