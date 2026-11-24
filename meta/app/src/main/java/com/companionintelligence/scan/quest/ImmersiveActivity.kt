package com.companionintelligence.scan.quest

import android.content.ActivityNotFoundException
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import com.companionintelligence.scan.quest.auth.QuestSignIn
import com.companionintelligence.scan.quest.auth.SessionBearer
import com.companionintelligence.scan.quest.auth.SignInReturn
import com.companionintelligence.scan.quest.capture.CaptureController
import com.companionintelligence.scan.quest.capture.PassthroughCamera
import com.companionintelligence.scan.quest.pose.CoordinateConversions
import com.companionintelligence.scan.quest.pose.EpochTracker
import com.companionintelligence.scan.quest.pose.PoseClock
import com.companionintelligence.scan.quest.pose.PoseRingBuffer
import com.companionintelligence.scan.quest.pose.PoseTimeSource
import com.companionintelligence.scan.quest.pose.Quat
import com.companionintelligence.scan.quest.pose.RigidPose
import com.companionintelligence.scan.quest.pose.Vec3
import com.companionintelligence.scan.quest.splat.SplatSource
import com.companionintelligence.scan.quest.splat.SplatViewer
import com.companionintelligence.scan.quest.upload.KeyframeUploader
import com.companionintelligence.scan.quest.upload.ScanServerClient
import com.companionintelligence.scan.quest.upload.ServerAddress
import com.companionintelligence.scan.quest.vision.OnnxVisionModel
import com.meta.spatial.core.Entity
import com.meta.spatial.core.Pose
import com.meta.spatial.core.Quaternion
import com.meta.spatial.core.SpatialFeature
import com.meta.spatial.core.SpatialSDKExperimentalAPI
import com.meta.spatial.core.Vector3
import com.meta.spatial.runtime.ReferenceSpace
import com.meta.spatial.splat.SpatialSDKExperimentalSplatAPI
import com.meta.spatial.splat.SplatFeature
import com.meta.spatial.toolkit.AppSystemActivity
import com.meta.spatial.toolkit.DpPerMeterDisplayOptions
import com.meta.spatial.toolkit.Grabbable
import com.meta.spatial.toolkit.Panel
import com.meta.spatial.toolkit.PanelRegistration
import com.meta.spatial.toolkit.QuadShapeOptions
import com.meta.spatial.toolkit.Transform
import com.meta.spatial.toolkit.UIPanelSettings
import com.meta.spatial.toolkit.ViewPanelRegistration
import com.meta.spatial.vr.LocomotionSystem
import com.meta.spatial.vr.VRFeature
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.concurrent.Executors

/**
 * The immersive activity: passthrough on, one panel, and the capture pipeline.
 *
 * The render loop's only capture work is [samplePose]: read `Scene.getViewerPose()` once per frame, stamp it
 * (pose/Clocks.kt) and put it in the ring buffer. Camera frames, JPEG encoding, the local dataset's files, the
 * model and HTTP run on their own threads (CaptureController, KeyframeUploader, SplatViewer); the main thread
 * keeps only small work such as preferences and the panel's text.
 *
 * Locomotion is switched off and the reference space is STAGE, so the scene stays fixed to the room and the
 * viewer pose is a physical head pose; thumbstick movement would otherwise shift every later pose.
 *
 * Sign-in (auth/QuestSignIn): the panel opens the server's sign-in in the system browser, and the server's return,
 * com.companionintelligence.scan.quest://auth?code=…, comes back here through the manifest's intent filter. The activity
 * is singleTask, so a return while it runs arrives in [onNewIntent], and one that starts the app from cold in the intent
 * [onCreate] sees. Not yet run on a headset.
 */
class ImmersiveActivity : AppSystemActivity(), ControlPanel.Actions {
    private lateinit var settings: AppSettings
    private val poses = PoseRingBuffer()
    private val epochs = EpochTracker()
    private val uploader = KeyframeUploader()
    private val panel = ControlPanel(this)
    private val main = Handler(Looper.getMainLooper())
    /** Every request to the signed-in server carries its session (SessionBearer); a request to another host never does. */
    private val http by lazy { ScanServerClient.httpsOnlyClientBuilder().addInterceptor(SessionBearer(settings)).build() }
    private val signIn by lazy { QuestSignIn(settings, http) }
    private val signInIo = Executors.newSingleThreadExecutor { r -> Thread(r, "sign-in") }
    private lateinit var vision: OnnxVisionModel
    private lateinit var capture: CaptureController
    private lateinit var camera: PassthroughCamera
    private lateinit var splats: SplatViewer

    private var panelEntity: Entity? = null
    private var panelPlaced = false
    private var ticks = 0L
    private var lastUiMs = 0L
    private var message: String? = null
    private var lastPose: RigidPose? = null
    private var lastPoseNs = 0L
    private var poseSource: PoseTimeSource? = null
    private var displayLeadMs = 0.0

    @OptIn(SpatialSDKExperimentalSplatAPI::class)
    override fun registerFeatures(): List<SpatialFeature> = listOf(
        VRFeature(this, handMicrogestureLocomotion = false),
        SplatFeature(spatialContext, systemManager),
    )

    override fun registerPanels(): List<PanelRegistration> = listOf(
        ViewPanelRegistration(
            R.id.control_panel,
            { _, context -> panel.build(context, settings) },
            { UIPanelSettings(shape = QuadShapeOptions(width = 0.9f, height = 1.2f), display = DpPerMeterDisplayOptions()) },
        ),
    )

    override fun onCreate(savedInstanceState: Bundle?) {
        settings = AppSettings(this)
        super.onCreate(savedInstanceState)
        vision = OnnxVisionModel(File(filesDir, "models"))
        capture = CaptureController(poses, epochs, uploader, vision)
        camera = PassthroughCamera(this, capture)
        splats = SplatViewer(File(filesDir, "splats"), getExternalFilesDir("splats"), http, main)
        finishSignIn(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        finishSignIn(intent)
    }

    override fun onSceneReady() {
        super.onSceneReady()
        scene.setReferenceSpace(ReferenceSpace.STAGE)
        scene.enablePassthrough(true)
        systemManager.tryFindSystem<LocomotionSystem>()?.enableLocomotion(false)
        panelEntity = Entity.create(
            listOf(Panel(R.id.control_panel), Transform(Pose(Vector3(0f, 1.3f, 0.9f))), Grabbable()),
        )
        openCameraIfPermitted(askIfMissing = true)
    }

    override fun onSceneTick() {
        super.onSceneTick()
        samplePose()
        ticks++
        if (!panelPlaced) placePanel()
        val now = SystemClock.uptimeMillis()
        if (now - lastUiMs >= UI_PERIOD_MS) {
            lastUiMs = now
            panel.render(snapshot())
        }
    }

    override fun onResume() {
        super.onResume()
        if (::camera.isInitialized) openCameraIfPermitted(askIfMissing = false)
    }

    override fun onPause() {
        // The camera is not available in the background; a running capture ends and is finalized.
        if (::capture.isInitialized) {
            capture.stop()
            uploader.finish()
            camera.close()
        }
        super.onPause()
    }

    override fun onDestroy() {
        if (::capture.isInitialized) {
            capture.shutdown()
            camera.shutdown()
            splats.shutdown()
            vision.close()
        }
        uploader.close()
        signInIo.shutdownNow()
        super.onDestroy()
    }

    override fun onRecenter(isUserInitiated: Boolean) {
        super.onRecenter(isUserInitiated)
        epochs.bump(SystemClock.elapsedRealtimeNanos())
        panelPlaced = false
        Log.i(TAG, "recenter (user=$isUserInitiated); epoch is now ${epochs.current()}")
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode != REQUEST_CAMERA) return
        if (checkSelfPermission(HEADSET_CAMERA) == PackageManager.PERMISSION_GRANTED) {
            camera.open()
        } else {
            message = "Camera permission was not granted, so nothing can be captured. Grant it in Settings → Apps."
        }
    }

    // ── Panel actions (main thread) ─────────────────────────────────────────────────────────────────────────

    override fun onSaveAddress(text: String) {
        message = when (val parsed = ServerAddress.parse(text)) {
            is ServerAddress.Parsed.Ok -> {
                settings.serverAddress = parsed.baseUrl.toString()
                "Saved ${parsed.baseUrl}"
            }
            is ServerAddress.Parsed.Refused -> parsed.reason
        }
    }

    override fun onSignIn() {
        val server = (ServerAddress.parse(settings.serverAddress) as? ServerAddress.Parsed.Ok)?.baseUrl
        if (server == null) {
            message = "Save your server's https:// address first, then sign in"
            return
        }
        val url = signIn.begin(server)
        message = try {
            startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url.toString())).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            "Sign in in the browser. The app finishes the sign-in when the browser hands back."
        } catch (e: ActivityNotFoundException) {
            "No browser on this headset opens the sign-in page"
        }
    }

    /** Finishes a sign-in whose return is [intent]'s address, on a background thread (one HTTPS call). Any other intent is ignored. */
    private fun finishSignIn(intent: Intent?) {
        val url = intent?.dataString ?: return
        if (!url.startsWith(SignInReturn.PREFIX)) return
        signInIo.execute {
            val text = when (val result = signIn.finish(url)) {
                is QuestSignIn.Finished.SignedIn -> "Signed in${result.email?.let { " as $it" } ?: ""}"
                is QuestSignIn.Finished.Failed -> result.reason
                QuestSignIn.Finished.Ignored -> null
            }
            if (text != null) main.post { message = text }
        }
    }

    /** The sign-in line on the panel: whether the app holds a session for the saved server, and for whom. */
    private fun signInText(): String {
        val session = settings.session
        val saved = (ServerAddress.parse(settings.serverAddress) as? ServerAddress.Parsed.Ok)?.baseUrl
        return when {
            session != null && saved != null && SessionBearer.sameOrigin(saved, session.server) ->
                "signed in${session.email?.let { " as $it" } ?: ""}"
            session != null -> "signed in to another server than the saved one; sign in again for this one"
            signIn.waiting() -> "waiting for the browser"
            else -> "not signed in (needed only when the server has sign-in on)"
        }
    }

    override fun onStartCapture() {
        val address = settings.serverAddress
        val local = settings.recordLocalDataset
        var client: ScanServerClient? = null
        if (address.isNotBlank()) {
            when (val parsed = ServerAddress.parse(address)) {
                is ServerAddress.Parsed.Ok -> client = ScanServerClient(parsed.baseUrl, http)
                is ServerAddress.Parsed.Refused -> {
                    message = parsed.reason
                    return
                }
            }
        } else if (!local) {
            message = "Save a server address, or turn on the local dataset, before starting"
            return
        }
        val datasetDir = if (local) newDatasetDir() ?: run {
            message = "The external files directory is not available, so the local dataset cannot be written"
            return
        } else {
            null
        }
        // Checked first so that no server session is opened for a capture that cannot start.
        capture.refusal(upload = client != null)?.let {
            message = it
            return
        }
        if (client != null && !uploader.start(client)) {
            message = "The previous capture is still being sent; try again in a moment"
            return
        }
        val refused = capture.start(upload = client != null, datasetDir = datasetDir)
        if (refused != null) {
            if (client != null) uploader.finish()
            message = refused
            return
        }
        message = buildString {
            append("Capturing")
            if (client != null) append(", uploading to ${client.baseUrl.host}")
            if (datasetDir != null) append(", recording ${datasetDir.name}")
        }
    }

    override fun onStopCapture() {
        capture.stop()
        uploader.finish()
        message = "Stopped; sending the last keyframes and finalizing"
    }

    override fun onRecordDatasetChanged(on: Boolean) {
        settings.recordLocalDataset = on
    }

    override fun onLoadSplat(input: String) {
        settings.splatInput = input
        val server = (ServerAddress.parse(settings.serverAddress) as? ServerAddress.Parsed.Ok)?.baseUrl
        when (val resolved = SplatSource.resolve(input, server)) {
            is SplatSource.Resolved.Remote -> splats.loadRemote(resolved.url, resolved.fileName, settings.mirrorSplat)
            is SplatSource.Resolved.Refused -> message = resolved.reason
        }
    }

    override fun onShowLocalSplat() = splats.showNewestLocal(settings.mirrorSplat)

    override fun onHideSplat() = splats.hide()

    override fun onMirrorChanged(on: Boolean) {
        settings.mirrorSplat = on
        splats.setMirror(on)
    }

    override fun onRecallPanel() {
        panelPlaced = false
    }

    // ── Internals ───────────────────────────────────────────────────────────────────────────────────────────

    /**
     * Once per rendered frame, on the render thread: cheap, no I/O. `getFrameTiming()` is marked experimental in
     * 0.15.0 and is not in the published sources jar; if it throws, poses are stamped with the read time.
     */
    @OptIn(SpatialSDKExperimentalAPI::class)
    private fun samplePose() {
        val viewer = scene.getViewerPose()
        val readRealtime = SystemClock.elapsedRealtimeNanos()
        val readMonotonic = System.nanoTime()
        val timing = try {
            spatial.getFrameTiming()
        } catch (e: RuntimeException) {
            null
        }
        val stamp = PoseClock.stamp(readRealtime, readMonotonic, timing?.predictedDisplayTimeNs, timing?.isValid == true)
        // Copied by name: the SDK's Quaternion constructor order is (w, x, y, z).
        val pose = RigidPose(
            Vec3(viewer.t.x.toDouble(), viewer.t.y.toDouble(), viewer.t.z.toDouble()),
            Quat(viewer.q.x.toDouble(), viewer.q.y.toDouble(), viewer.q.z.toDouble(), viewer.q.w.toDouble()),
        )
        if (!pose.isFinite() || pose.rotation.norm() < 0.5) return
        val previous = lastPose
        if (previous != null && EpochTracker.isTrackingJump(previous, pose, stamp.realtimeNs - lastPoseNs)) {
            epochs.noteJump(stamp.realtimeNs)
        }
        if (poses.add(stamp.realtimeNs, pose, stamp.xrTimeNs, stamp.source)) {
            lastPose = pose
            lastPoseNs = stamp.realtimeNs
            poseSource = stamp.source
            if (stamp.source == PoseTimeSource.PREDICTED_DISPLAY_TIME) {
                displayLeadMs = displayLeadMs * 0.95 + (stamp.realtimeNs - readRealtime) / 1e6 * 0.05
            }
        }
    }

    /** Puts the panel 0.9 m in front of the viewer, a little below eye height, turned to face them. */
    private fun placePanel() {
        val entity = panelEntity ?: return
        val head = lastPose ?: return
        // Wait for tracking: until then the viewer pose sits at the origin.
        if (head.position.length() < 0.05 && ticks < 300) return
        val forward = head.rotation.rotate(Vec3.Z)
        val flat = Vec3(forward.x, 0.0, forward.z).let { if (it.length() < 1e-3) Vec3.Z else it * (1.0 / it.length()) }
        val at = head.position + flat * 0.9 + Vec3(0.0, -0.15, 0.0)
        val yaw = CoordinateConversions.yawFacing(flat)
        entity.setComponent(
            Transform(
                Pose(
                    Vector3(at.x.toFloat(), at.y.toFloat(), at.z.toFloat()),
                    Quaternion(yaw.w.toFloat(), yaw.x.toFloat(), yaw.y.toFloat(), yaw.z.toFloat()),
                ),
            ),
        )
        panelPlaced = true
    }

    /**
     * HEADSET_CAMERA is the one that decides; CAMERA is asked for alongside it the first time. If the camera
     * still refuses to open, PassthroughCamera reports the SecurityException on the panel.
     */
    private fun openCameraIfPermitted(askIfMissing: Boolean) {
        val missing = CAMERA_PERMISSIONS.filter { checkSelfPermission(it) != PackageManager.PERMISSION_GRANTED }
        if (askIfMissing && missing.isNotEmpty()) {
            requestPermissions(missing.toTypedArray(), REQUEST_CAMERA)
        } else if (checkSelfPermission(HEADSET_CAMERA) == PackageManager.PERMISSION_GRANTED) {
            camera.open()
        }
    }

    private fun newDatasetDir(): File? {
        val root = getExternalFilesDir(null) ?: return null
        val name = SimpleDateFormat("yyyyMMdd_HHmmss", Locale.ROOT).format(Date())
        return File(File(root, "mq3drecon"), name)
    }

    private fun snapshot(): ControlPanel.Snapshot {
        val c = capture.status()
        val u = uploader.status()
        val pose = when (poseSource) {
            null -> "no samples yet"
            PoseTimeSource.PREDICTED_DISPLAY_TIME ->
                "stamped with the predicted display time (lead %.0f ms), ${poses.size()} in buffer".format(Locale.ROOT, displayLeadMs)
            PoseTimeSource.READ_TIME -> "stamped with the read time (no usable frame timing), ${poses.size()} in buffer"
        }
        val captureText = buildString {
            append(if (c.capturing) "running" else "stopped")
            append(" — frames seen ${c.framesSeen}, keyframes ${c.keyframesTaken}, epoch ${c.epoch}")
            if (c.framesWithoutPose > 0) append(", no pose for ${c.framesWithoutPose}")
            if (c.framesDropped > 0) append(", dropped ${c.framesDropped}")
            if (c.datasetFramesDropped > 0) append(", dataset frames dropped ${c.datasetFramesDropped} (the writer fell behind)")
            c.clock?.let { append("\nCamera clock: $it") }
        }
        val uploadText = buildString {
            append(u.state.name.lowercase())
            u.sessionId?.let { append(" — session $it") }
            append(" — sent ${u.sent}, queued ${u.queued}, skipped ${u.skipped}, failed ${u.failed}")
            if (u.finalized) append(", finalized")
            u.lastError?.let { append("\n$it") }
        }
        return ControlPanel.Snapshot(
            message = message,
            camera = c.camera,
            cameraError = c.cameraError,
            signIn = signInText(),
            headPose = pose,
            capture = captureText,
            upload = uploadText,
            signInRequired = u.signInRequired,
            dataset = c.dataset ?: if (settings.recordLocalDataset) "on, starts with the capture" else "off",
            vision = c.vision,
            splat = splats.status,
            warnings = c.warnings,
            capturing = c.capturing,
        )
    }

    private companion object {
        const val TAG = "ImmersiveActivity"
        const val REQUEST_CAMERA = 1
        const val UI_PERIOD_MS = 250L

        /** Passthrough Camera API permission (Horizon OS v74+). */
        const val HEADSET_CAMERA = "horizonos.permission.HEADSET_CAMERA"

        /** Meta's pages disagree on whether android.permission.CAMERA is needed as well, so both are asked for. */
        val CAMERA_PERMISSIONS = listOf(HEADSET_CAMERA, android.Manifest.permission.CAMERA)
    }
}
