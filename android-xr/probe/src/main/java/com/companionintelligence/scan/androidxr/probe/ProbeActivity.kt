package com.companionintelligence.scan.androidxr.probe

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.ImageFormat
import android.graphics.Rect
import android.graphics.Typeface
import android.graphics.YuvImage
import android.media.Image
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import androidx.activity.ComponentActivity
import androidx.activity.result.contract.ActivityResultContracts
import androidx.lifecycle.lifecycleScope
import com.companionintelligence.scan.quest.capture.RateGate
import com.companionintelligence.scan.quest.capture.YuvFrame
import com.companionintelligence.scan.quest.pose.CameraClock
import com.companionintelligence.scan.quest.pose.EpochTracker
import com.companionintelligence.scan.quest.pose.PoseRingBuffer
import com.companionintelligence.scan.quest.upload.KeyframeMeta
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonObject
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.IOException
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.ThreadPoolExecutor
import java.util.concurrent.TimeUnit

/**
 * Wave 17 ticket 0003's probe: camera 0's frames and the glasses' pose on one clock, and a short recording in the shape
 * of a Scan session (RecordingFormat). It is a spike, not the capture runtime: it uploads nothing and has no network
 * access, and each part (the XR session, the camera, the recording) reports on its own, so one that fails does not hide
 * the others.
 *
 * One run per launch. Start it with the panel's button (TAB then ENTER from adb), or with
 *
 *     adb shell am start -n com.companionintelligence.scan.androidxr.probe/.ProbeActivity --ez autostart true
 *
 * Extras: `autostart` (boolean), `seconds` (3 to 120, default 15), `size` ("WxH", default 1920x1080, camera 0's active
 * array) and `keyframe_ms` (200 to 5000, default 500: a keyframe every half second, so even glasses at rest give a
 * recording). The report goes to logcat under the tag ScanXrProbe and into the recording's probe.json.
 */
class ProbeActivity : ComponentActivity(), AuraCamera.Listener {

    data class Options(val autostart: Boolean, val seconds: Int, val size: PixelSize, val keyframeMs: Int) {
        companion object {
            fun from(intent: Intent?) = Options(
                autostart = intent?.getBooleanExtra("autostart", false) ?: false,
                seconds = (intent?.getIntExtra("seconds", 15) ?: 15).coerceIn(3, 120),
                size = PixelSize.parse(intent?.getStringExtra("size")) ?: CameraChoice.DEFAULT_SIZE,
                keyframeMs = (intent?.getIntExtra("keyframe_ms", 500) ?: 500).coerceIn(200, 5000),
            )
        }
    }

    private lateinit var options: Options
    private lateinit var status: TextView
    private lateinit var runButton: Button
    private val main = Handler(Looper.getMainLooper())

    private val poses = PoseRingBuffer()
    private val epochs = EpochTracker()
    private val pairing = PosePairing(poses)
    private var sampler: XrPoseSampler? = null
    private var xrOutcome: XrPoseSampler.Outcome? = null
    private var camera: AuraCamera? = null

    @Volatile private var recorder: ProbeRecorder? = null
    @Volatile private var facts: CameraFacts? = null
    @Volatile private var intrinsics: CameraFacts.StreamIntrinsics? = null
    @Volatile private var recording = false
    private var started = false
    @Volatile private var stopped = false
    private var startedAtUnixMs = 0L
    private var nextIndex = 0 // the processing thread's

    private val frames = ArrayList<FrameRecord>()
    private val timings = ConcurrentHashMap<Long, CaptureTiming>()
    private val keyframeOutcomes = ConcurrentHashMap<Long, String>()
    private lateinit var keyframeGate: RateGate
    private val processing = ThreadPoolExecutor(1, 1, 0, TimeUnit.MILLISECONDS, ArrayBlockingQueue(2)) { r ->
        Thread(r, "probe-keyframes")
    }

    private val reportLines = ArrayList<Pair<String, String>>()

    private val permissionRequest = registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) {
        afterPermissions()
    }

    private val stopTimer = Runnable { stopRun("${options.seconds} s are up") }
    private val refresh = object : Runnable {
        override fun run() {
            render()
            if (started && !stopped) main.postDelayed(this, 500)
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        options = Options.from(intent)
        keyframeGate = RateGate(options.keyframeMs * 1_000_000L)
        val pad = (16 * resources.displayMetrics.density).toInt()
        runButton = Button(this).apply {
            text = "Run probe"
            setOnClickListener { startRun() }
        }
        status = TextView(this).apply {
            typeface = Typeface.MONOSPACE
            textSize = 13f
        }
        val title = TextView(this).apply {
            text = "Scan XR probe: camera 0 and the head pose on one clock"
            textSize = 18f
        }
        val column = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(pad, pad, pad, pad)
            addView(title)
            addView(runButton)
            addView(status)
        }
        setContentView(ScrollView(this).apply { addView(column) })
        report("probe", "Scan XR probe ${versionName()}")
        report("device", "${Build.MANUFACTURER} ${Build.MODEL}, Android ${Build.VERSION.RELEASE} (API ${Build.VERSION.SDK_INT}), build ${Build.ID}")
        report("options", "${options.seconds} s, ${options.size} requested, a keyframe every ${options.keyframeMs} ms")
        if (options.autostart) startRun()
    }

    override fun onDestroy() {
        if (started && !stopped) stopRun("the activity was destroyed")
        camera?.shutdown()
        super.onDestroy()
    }

    // ── The run ────────────────────────────────────────────────────────────────────────────────────────────────

    private fun startRun() {
        if (started) return
        started = true
        startedAtUnixMs = System.currentTimeMillis()
        runButton.isEnabled = false
        main.post(refresh)
        val missing = PERMISSIONS.filter { checkSelfPermission(it) != PackageManager.PERMISSION_GRANTED }
        if (missing.isEmpty()) {
            afterPermissions()
        } else {
            // The system dialog asks the wearer; the probe never grants anything itself.
            report("permissions asked for", missing.joinToString { it.substringAfterLast('.') })
            permissionRequest.launch(missing.toTypedArray())
        }
    }

    private fun afterPermissions() {
        for (p in PERMISSIONS) report(p.substringAfterLast('.'), if (granted(p)) "granted" else "not granted")
        // The recording starts with the run, so poses.csv and probe.json are written even when the camera never opens.
        recorder = try {
            ProbeRecorder(File(File(getExternalFilesDir(null), "recordings"), folderName()))
        } catch (e: IOException) {
            report("recording", "could not start: ${e.message}")
            null
        }
        lifecycleScope.launch {
            val s = XrPoseSampler(this@ProbeActivity, poses, epochs)
            sampler = s
            val outcome = s.start()
            xrOutcome = outcome
            report("Session.create", outcome.create)
            outcome.configure?.let { report("configure: device tracking", it) }
            if (!outcome.sampling) report("head pose", "not sampled: the frames below have no pose")
            openCamera()
            main.postDelayed(stopTimer, options.seconds * 1000L)
        }
    }

    private fun openCamera() {
        if (!granted(Manifest.permission.CAMERA)) {
            report("camera", "not opened: CAMERA not granted")
            return
        }
        val cam = AuraCamera(this, this)
        camera = cam
        try {
            for (c in cam.describeCameras()) {
                val kinds = buildList {
                    if (c.backwardCompatible) add("colour")
                    if (c.depthOutput) add("depth")
                }.ifEmpty { listOf("neither colour nor depth") }
                report("camera ${c.id}", "${c.facing}, ${kinds.joinToString(" and ")}, YUV ${c.yuvSizes.joinToString(" ").ifEmpty { "none" }}")
            }
        } catch (e: Exception) {
            report("cameras", "could not be listed: ${e.javaClass.simpleName}: ${e.message}")
        }
        cam.open(options.size)
    }

    private fun stopRun(reason: String) {
        if (stopped) return
        stopped = true
        recording = false
        main.removeCallbacks(stopTimer)
        report("run ended", reason)
        camera?.close()
        sampler?.stop()
        Thread({ finishRun() }, "probe-finish").start()
    }

    /** On its own thread: lets the last keyframes finish, then writes the summary and the recording's files. */
    private fun finishRun() {
        processing.shutdown()
        try {
            processing.awaitTermination(5, TimeUnit.SECONDS)
        } catch (_: InterruptedException) {
        }
        val poseRecords = sampler?.records().orEmpty()
        val frameRecords = synchronized(frames) { ArrayList(frames) }
        val poseSummary = ProbeStats.poses(poseRecords)
        val frameSummary = ProbeStats.frames(frameRecords)
        report("head pose updates", "${poseSummary.updates}, tracked ${poseSummary.tracked}, ${fmt(poseSummary.trackedRateHz)} Hz")
        report("tracking states", poseSummary.trackingStates.entries.joinToString { "${it.key} ${it.value}" }.ifEmpty { "none" })
        report("pose age at handling (ms)", "median ${fmt(poseSummary.ageMsMedian)}, p95 ${fmt(poseSummary.ageMsP95)}, max ${fmt(poseSummary.ageMsMax)}")
        report("XR clock against boot clock", "drift ${fmt(poseSummary.clockDriftUs)} us (${fmt(poseSummary.clockDriftPpm)} ppm), worst ${fmt(poseSummary.clockResidualUsMax)} us")
        report("epoch bumps", "${poseSummary.epochBumps}")
        report("camera frames", "${frameSummary.frames}, ${fmt(frameSummary.rateHz)} Hz")
        report(
            "frame latency (ms)",
            when {
                frameSummary.frames == 0 -> "no frames"
                else -> "min ${fmt(frameSummary.latencyMsMin)}, median ${fmt(frameSummary.latencyMsMedian)}, max ${fmt(frameSummary.latencyMsMax)}" +
                    if (frameSummary.cameraClockPlausible) "" else "  IMPLAUSIBLE: the camera clock may not be the boot clock"
            },
        )
        val outcomes = keyframeOutcomes.values.groupingBy { if (RecordingFormat.KEYFRAME_FILE.matches(it)) "written" else it }.eachCount()
        report("keyframes", if (outcomes.isEmpty()) "none wanted" else outcomes.entries.joinToString { "${it.key} ${it.value}" })
        val r = recorder
        if (r == null) {
            report("recording", "none: its folder could not be made")
        } else {
            val json = probeJson(poseSummary, frameSummary, r)
            try {
                r.finish(poseRecords, frameRecords, timings, keyframeOutcomes, json)
                report("recording", "${r.directory.absolutePath} (${r.keyframesWritten} keyframes, ${r.bytesWritten / 1000} kB)")
            } catch (e: IOException) {
                report("recording", "not finished: ${e.message}")
            }
        }
        report("done", "launch the probe again for another run")
        Log.i(TAG, "=== report ===\n" + synchronized(reportLines) { reportLines.joinToString("\n") { "${it.first}: ${it.second}" } })
    }

    // ── Camera callbacks (camera thread) ───────────────────────────────────────────────────────────────────────

    override fun onCameraOpened(facts: CameraFacts, clock: CameraClock) {
        this.facts = facts
        val streamIntrinsics = facts.streamIntrinsics()
        intrinsics = streamIntrinsics
        report("camera opened", "${facts.id}, ${facts.facing}, ${facts.hardwareLevel}, ${facts.stream} YUV_420_888")
        report("camera clock", clock.label)
        report("readout timestamp", facts.readoutTimestamp ?: "not reported")
        report(
            "lens pose",
            if (facts.hasLensPose) {
                "${facts.lensPoseTranslation?.joinToString()} / ${facts.lensPoseRotation?.joinToString()} (${facts.lensPoseReference})"
            } else {
                "not reported: the keyframe pose is the device pose"
            },
        )
        report(
            "intrinsics",
            streamIntrinsics?.let {
                "${it.source}: fx ${fmt(it.intrinsics.fx)}, fy ${fmt(it.intrinsics.fy)}, cx ${fmt(it.intrinsics.cx)}, cy ${fmt(it.intrinsics.cy)}"
            } ?: "none: no keyframes will be written",
        )
        // The recorder was made when the run started (afterPermissions); a camera that opens after the run ended records nothing.
        recording = recorder != null && !stopped
    }

    override fun onCameraFrame(image: Image, frameRealtimeNs: Long, arrivalRealtimeNs: Long) {
        if (!recording) return
        synchronized(frames) { frames += FrameRecord(image.timestamp, frameRealtimeNs, arrivalRealtimeNs) }
        if (!keyframeGate.due(frameRealtimeNs)) return
        val frame = image.copyToYuvFrame(frameRealtimeNs)
        try {
            processing.execute { processKeyframe(frame) }
        } catch (_: RejectedExecutionException) {
            keyframeOutcomes[frame.cameraTimestampNs] = "dropped: the keyframe worker was busy"
        }
    }

    override fun onCaptureTiming(timing: CaptureTiming) {
        if (recording) timings[timing.sensorTimestampNs] = timing
    }

    override fun onCameraState(message: String, isError: Boolean) {
        report(if (isError) "camera error" else "camera", message)
    }

    // ── Keyframes (processing thread) ──────────────────────────────────────────────────────────────────────────

    private fun processKeyframe(frame: YuvFrame) {
        val f = facts ?: return
        val r = recorder ?: return
        val streamIntrinsics = intrinsics
        if (streamIntrinsics == null) {
            keyframeOutcomes[frame.cameraTimestampNs] = "not written: no intrinsics"
            return
        }
        val devicePose = when (val paired = pairing.poseAt(frame.realtimeNs)) {
            is PosePairing.Result.Paired -> paired.pose
            else -> {
                keyframeOutcomes[frame.cameraTimestampNs] = "not written: no pose ($paired)"
                return
            }
        }
        val pose = AndroidXrConversions.keyframePose(devicePose, f.headFromCamera)
        val grid = streamIntrinsics.intrinsics.let {
            if (it.width == frame.width && it.height == frame.height) it else it.scaledTo(frame.width, frame.height)
        }
        val index = nextIndex
        val capturedAt = System.currentTimeMillis() - (SystemClock.elapsedRealtimeNanos() - frame.realtimeNs) / 1_000_000
        val meta = KeyframeMeta(
            index = index,
            timestampMs = frame.realtimeNs / 1e6,
            capturedAtUnixMs = capturedAt,
            pose = pose,
            epoch = epochs.epochAt(frame.realtimeNs),
            intrinsics = grid,
            sourceWidth = f.stream.width,
            sourceHeight = f.stream.height,
        ).toJson()
        try {
            r.writeKeyframe(index, encodeJpeg(frame), meta)
            nextIndex = index + 1
            keyframeOutcomes[frame.cameraTimestampNs] = RecordingFormat.keyframeFileName(index)
        } catch (e: IOException) {
            keyframeOutcomes[frame.cameraTimestampNs] = "not written: ${e.message}"
        }
    }

    private fun encodeJpeg(frame: YuvFrame): ByteArray {
        val out = ByteArrayOutputStream(512 * 1024)
        YuvImage(frame.toNv21(), ImageFormat.NV21, frame.width, frame.height, null)
            .compressToJpeg(Rect(0, 0, frame.width, frame.height), JPEG_QUALITY, out)
        return out.toByteArray()
    }

    // ── Report ─────────────────────────────────────────────────────────────────────────────────────────────────

    private fun probeJson(poseSummary: ProbeStats.PoseSummary, frameSummary: ProbeStats.FrameSummary, r: ProbeRecorder): String {
        val f = facts
        val xr = xrOutcome
        return buildJsonObject {
            put("probe", "Scan XR probe ${versionName()}")
            put("startedAtUnixMs", startedAtUnixMs)
            putJsonObject("device") {
                put("manufacturer", Build.MANUFACTURER)
                put("model", Build.MODEL)
                put("android", Build.VERSION.RELEASE)
                put("sdk", Build.VERSION.SDK_INT)
                put("build", Build.ID)
            }
            putJsonObject("options") {
                put("seconds", options.seconds)
                put("size", options.size.toString())
                put("keyframeMs", options.keyframeMs)
                put("jpegQuality", JPEG_QUALITY)
            }
            putJsonObject("permissions") {
                for (p in PERMISSIONS) put(p, granted(p))
            }
            putJsonObject("xr") {
                put("library", "androidx.xr.arcore:arcore 1.0.0, androidx.xr.runtime:runtime 1.0.0")
                put("sessionCreate", xr?.create)
                put("configureDeviceTracking", xr?.configure)
                put("sampling", xr?.sampling ?: false)
                put("updatesWithoutPerceptionState", sampler?.updatesWithoutPerceptionState ?: 0)
                put("viewpoints", sampler?.viewpoints ?: JsonNull)
            }
            put("camera", f?.let(ProbeJson::camera) ?: JsonNull)
            put("intrinsics", ProbeJson.intrinsics(intrinsics))
            put("cameraInDevice", f?.let(ProbeJson::cameraInDevice) ?: JsonNull)
            putJsonObject("summary") {
                put("poses", ProbeJson.poseSummary(poseSummary))
                put("frames", ProbeJson.frameSummary(frameSummary))
                put("keyframesWritten", r.keyframesWritten)
                put("keyframeBytes", r.bytesWritten)
            }
            putJsonObject("files") {
                put("keyframes", ProbeRecorder.KEYFRAMES)
                put("poses", ProbeRecorder.POSES)
                put("frames", ProbeRecorder.FRAMES)
            }
        }.toString()
    }

    private fun report(key: String, value: String) {
        synchronized(reportLines) { reportLines += key to value }
        Log.i(TAG, "$key: $value")
        main.post { render() }
    }

    private fun render() {
        val lines = synchronized(reportLines) { reportLines.map { "${it.first.padEnd(28)} ${it.second}" } }
        val live = if (started && !stopped) {
            val frameCount = synchronized(frames) { frames.size }
            "\nlive: ${frameCount} frames, ${poses.size()} poses in the buffer, keyframes ${recorder?.keyframesWritten ?: 0}, epoch ${epochs.current()}"
        } else {
            ""
        }
        status.text = lines.joinToString("\n") + live
    }

    private fun granted(permission: String) = checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED

    private fun versionName(): String = try {
        packageManager.getPackageInfo(packageName, 0).versionName ?: "?"
    } catch (_: PackageManager.NameNotFoundException) {
        "?"
    }

    private fun folderName(): String = SimpleDateFormat("yyyyMMdd-HHmmss", Locale.ROOT)
        .apply { timeZone = TimeZone.getTimeZone("UTC") }
        .format(Date(startedAtUnixMs))

    private fun fmt(v: Double?): String = v?.let { String.format(Locale.ROOT, "%.2f", it) } ?: "n/a"

    companion object {
        private const val TAG = "ScanXrProbe"

        /** The web client sends quality 0.8 (src/capture/keyframes.ts), as the Quest app does. */
        private const val JPEG_QUALITY = 80

        val PERMISSIONS = listOf(Manifest.permission.CAMERA, "android.permission.HEAD_TRACKING")
    }
}
