package com.companionintelligence.scan.quest.capture

import android.graphics.ImageFormat
import android.graphics.Rect
import android.graphics.YuvImage
import android.media.Image
import android.os.SystemClock
import android.util.Log
import com.companionintelligence.scan.quest.dataset.Mq3dreconDatasetWriter
import com.companionintelligence.scan.quest.pose.CameraClock
import com.companionintelligence.scan.quest.pose.CoordinateConversions
import com.companionintelligence.scan.quest.pose.EpochTracker
import com.companionintelligence.scan.quest.pose.PoseRingBuffer
import com.companionintelligence.scan.quest.pose.PoseSample
import com.companionintelligence.scan.quest.pose.RigidPose
import com.companionintelligence.scan.quest.pose.UnixMsMapper
import com.companionintelligence.scan.quest.upload.KeyframeMeta
import com.companionintelligence.scan.quest.upload.KeyframeUploader
import com.companionintelligence.scan.quest.vision.VisionModel
import com.companionintelligence.scan.quest.vision.VisionStatus
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.IOException
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.ThreadPoolExecutor
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger

/**
 * Joins camera frames to head poses and hands them on: JPEG keyframes to the uploader, raw frames to the local
 * mq3drecon dataset, and an occasional frame to the vision hook.
 *
 * Threads: [onCameraFrame] runs on the camera thread and only decides whether a frame is wanted and copies it;
 * the JPEG encode and pose lookup run on a processing thread, file writes on a dataset thread, the model on a
 * vision thread and HTTP on the uploader's thread. The render thread only writes head poses into the ring buffer
 * (ImmersiveActivity.onSceneTick). Each worker has a short queue and drops work rather than pile it up.
 */
class CaptureController(
    private val poses: PoseRingBuffer,
    private val epochs: EpochTracker,
    private val uploader: KeyframeUploader,
    private val vision: VisionModel,
) : PassthroughCamera.Listener {

    data class Status(
        val camera: String,
        val cameraError: Boolean,
        val clock: String?,
        val capturing: Boolean,
        val uploading: Boolean,
        val framesSeen: Int,
        val keyframesTaken: Int,
        val framesWithoutPose: Int,
        val framesDropped: Int,
        val epoch: Int,
        val dataset: String?,
        val vision: String,
        val warnings: List<String>,
    )

    @Volatile var calibration: CameraCalibration? = null
        private set
    @Volatile private var clock: CameraClock? = null
    @Volatile private var cameraState = "Camera not opened yet"
    @Volatile private var cameraError = false
    @Volatile private var capturing = false
    @Volatile private var uploading = false
    @Volatile private var dataset: Mq3dreconDatasetWriter? = null
    @Volatile private var lastVision: String? = null

    private val selector = KeyframeSelector()
    private val datasetGate = RateGate(DATASET_PERIOD_NS)
    private val visionGate = RateGate(VISION_PERIOD_NS)
    private val visionIdle = AtomicBoolean(true)

    private val framesSeen = AtomicInteger()
    private val keyframesTaken = AtomicInteger()
    private val framesWithoutPose = AtomicInteger()
    private val framesDropped = AtomicInteger()

    private val processing = singleThread("keyframe-processing", 2)
    private val visionThread = singleThread("vision", 1)
    private val datasetThread = Executors.newSingleThreadScheduledExecutor { r -> Thread(r, "dataset-writer") }
    private var poseDrain: ScheduledFuture<*>? = null
    private var poseSequence = 0L

    init {
        // Opening a model can take seconds, so it happens here rather than on the main thread.
        visionThread.execute { vision.load() }
    }

    // ── Camera callbacks ────────────────────────────────────────────────────────────────────────────────────

    override fun onCameraOpened(calibration: CameraCalibration, clock: CameraClock) {
        this.calibration = calibration
        this.clock = clock
        cameraState = "Left passthrough camera ${calibration.cameraId}, ${calibration.streamWidth}×${calibration.streamHeight} YUV_420_888"
        cameraError = false
        Log.i(TAG, "opened: $cameraState; timestamps ${clock.label}; lens pose reported=${calibration.hasLensPose}")
    }

    override fun onCameraState(message: String, isError: Boolean) {
        cameraState = message
        cameraError = isError
        if (isError) Log.w(TAG, message) else Log.i(TAG, message)
    }

    override fun onCameraFrame(image: Image, clock: CameraClock) {
        val realtime = clock.toRealtimeNs(image.timestamp)
        framesSeen.incrementAndGet()
        val active = capturing
        val writer = dataset
        val wantKeyframe = active && uploading && selector.intervalElapsed(realtime) && uploader.hasRoom()
        val wantDataset = active && writer != null && datasetGate.due(realtime)
        val wantVision = vision.status is VisionStatus.Ready && visionIdle.get() && visionGate.due(realtime)
        if (!wantKeyframe && !wantDataset && !wantVision) return

        val frame = image.toYuvFrame(realtime)
        if (wantDataset) datasetThread.execute { writeDatasetFrame(writer, frame) }
        if (wantKeyframe && !submit(processing) { processKeyframe(frame) }) framesDropped.incrementAndGet()
        if (wantVision && visionIdle.compareAndSet(true, false)) {
            if (!submit(visionThread) { runVision(frame) }) visionIdle.set(true)
        }
    }

    // ── Capture control (main thread) ───────────────────────────────────────────────────────────────────────

    /**
     * Starts a capture. [upload] says whether keyframes go to the uploader (whose session the caller has
     * started); [datasetDir], when not null, is where the local mq3drecon dataset is written.
     */
    fun start(upload: Boolean, datasetDir: File?): String? {
        refusal(upload)?.let { return it }
        val cal = calibration ?: return "The camera is not open yet"
        val camClock = clock ?: return "The camera is not open yet"
        selector.reset()
        datasetGate.reset()
        keyframesTaken.set(0)
        framesWithoutPose.set(0)
        framesDropped.set(0)
        if (datasetDir != null) {
            val baseRealtime = SystemClock.elapsedRealtimeNanos()
            val mapper = UnixMsMapper(baseRealtime, System.currentTimeMillis())
            val writer = try {
                Mq3dreconDatasetWriter(datasetDir, cal, mapper, camClock.fromRealtimeNs(baseRealtime))
            } catch (e: IllegalStateException) {
                return "Could not create the local dataset: ${e.message}"
            } catch (e: IOException) {
                return "Could not create the local dataset: ${e.message}"
            }
            // Start a little before now so the first frame has a pose row before it (mq3drecon wants one
            // within 30 ms on each side).
            poseSequence = maxOf(0L, (poses.latest()?.sequence ?: 0L) - POSE_ROWS_BEFORE_START)
            dataset = writer
            poseDrain = datasetThread.scheduleWithFixedDelay({ drainPoses(writer) }, 250, 250, TimeUnit.MILLISECONDS)
        }
        uploading = upload
        capturing = true
        return null
    }

    /** Why a capture could not start now, or null when it can. Checked before a server session is opened. */
    fun refusal(upload: Boolean): String? {
        val cal = calibration ?: return "The camera is not open yet"
        if (clock == null) return "The camera is not open yet"
        if (capturing) return "A capture is already running"
        if (upload && cal.streamIntrinsics() == null) {
            return "The camera reported no intrinsic calibration, so keyframes cannot carry intrinsics"
        }
        return null
    }

    fun stop() {
        if (!capturing) return
        capturing = false
        uploading = false
        val writer = dataset ?: return
        dataset = null
        poseDrain?.cancel(false)
        poseDrain = null
        // The last pose rows after the last frame arrive with the next few rendered frames.
        datasetThread.schedule({
            drainPoses(writer)
            try {
                writer.close()
            } catch (e: IOException) {
                Log.w(TAG, "dataset close failed", e)
            }
            Log.i(TAG, "dataset closed: ${writer.directory} (${writer.framesWritten} frames, ${writer.poseRowsWritten} pose rows)")
        }, 200, TimeUnit.MILLISECONDS)
        lastDataset = writer
    }

    @Volatile private var lastDataset: Mq3dreconDatasetWriter? = null

    fun status(): Status {
        val cal = calibration
        val writer = dataset ?: lastDataset
        val warnings = buildList {
            if (cal != null && !cal.hasLensPose) add("The camera reported no lens pose; the camera is assumed to sit at the head origin, looking forward")
            if (cal != null && cal.streamIntrinsics() == null) add("The camera reported no intrinsic calibration")
            if (cal != null && (cal.streamWidth != PassthroughCamera.WANTED_WIDTH || cal.streamHeight != PassthroughCamera.WANTED_HEIGHT)) {
                add("1280×960 was not offered; using ${cal.streamWidth}×${cal.streamHeight}")
            }
        }
        val visionText = when (val s = vision.status) {
            is VisionStatus.NotInstalled -> "No model installed (put a .onnx file at ${s.expectedPath})"
            is VisionStatus.Failed -> "Model not usable: ${s.reason}"
            is VisionStatus.Ready -> "${s.modelName}: ${lastVision ?: "waiting for a frame"}"
        }
        return Status(
            camera = cameraState,
            cameraError = cameraError,
            clock = clock?.label,
            capturing = capturing,
            uploading = uploading,
            framesSeen = framesSeen.get(),
            keyframesTaken = keyframesTaken.get(),
            framesWithoutPose = framesWithoutPose.get(),
            framesDropped = framesDropped.get(),
            epoch = epochs.current(),
            dataset = writer?.let {
                "${it.directory.name}: ${it.framesWritten} frames, ${it.bytesWritten / 1_000_000} MB, ${it.poseRowsWritten} pose rows" +
                    if (it === dataset) "" else " (closed)"
            },
            vision = visionText,
            warnings = warnings,
        )
    }

    fun shutdown() {
        stop()
        processing.shutdownNow()
        visionThread.shutdownNow()
        datasetThread.shutdown()
    }

    // ── Workers ─────────────────────────────────────────────────────────────────────────────────────────────

    private fun processKeyframe(frame: YuvFrame) {
        val cal = calibration ?: return
        val head = awaitHeadPose(frame.realtimeNs)
        if (head == null) {
            framesWithoutPose.incrementAndGet()
            return
        }
        val cameraInScene = CoordinateConversions.cameraPoseInScene(head, cal.headFromCamera)
        // Checked before the selector remembers this frame, so a frame the uploader cannot take does not count
        // as the last keyframe.
        if (!uploader.hasRoom()) return
        if (!selector.take(frame.realtimeNs, cameraInScene)) return
        val intrinsics = cal.streamIntrinsics()?.let {
            if (it.width == frame.width && it.height == frame.height) it else it.scaledTo(frame.width, frame.height)
        } ?: return
        val jpeg = encodeJpeg(frame)
        if (jpeg.size > MAX_JPEG_BYTES) {
            framesDropped.incrementAndGet()
            return
        }
        val pose = CoordinateConversions.spatialToCompanionScan(cameraInScene)
        val capturedAt = System.currentTimeMillis() - (SystemClock.elapsedRealtimeNanos() - frame.realtimeNs) / 1_000_000
        val epoch = epochs.epochAt(frame.realtimeNs)
        val queued = uploader.offer(jpeg) { index ->
            KeyframeMeta(
                index = index,
                timestampMs = frame.realtimeNs / 1e6,
                capturedAtUnixMs = capturedAt,
                pose = pose,
                epoch = epoch,
                intrinsics = intrinsics,
                sourceWidth = cal.streamWidth,
                sourceHeight = cal.streamHeight,
            ).toJson()
        }
        if (queued) keyframesTaken.incrementAndGet()
    }

    /** Waits (on a worker thread) until the ring buffer has a sample after [realtimeNs], then interpolates. */
    private fun awaitHeadPose(realtimeNs: Long): RigidPose? {
        val deadline = System.nanoTime() + POSE_WAIT_NS
        while (true) {
            val newest = poses.newestTimeNs()
            if (newest != null && newest >= realtimeNs) return poses.interpolate(realtimeNs)
            if (System.nanoTime() > deadline) return null
            try {
                Thread.sleep(4)
            } catch (_: InterruptedException) {
                return null
            }
        }
    }

    private fun writeDatasetFrame(writer: Mq3dreconDatasetWriter, frame: YuvFrame) {
        try {
            writer.writeFrame(frame)
        } catch (e: IOException) {
            Log.w(TAG, "dataset frame not written", e)
        } catch (e: IllegalStateException) {
            // The writer closed between the frame being taken and written.
        }
    }

    private fun drainPoses(writer: Mq3dreconDatasetWriter) {
        val batch = ArrayList<PoseSample>(64)
        poseSequence = poses.drainSince(poseSequence, batch)
        try {
            writer.appendHeadPoses(batch)
            writer.flush()
        } catch (e: IOException) {
            Log.w(TAG, "pose rows not written", e)
        } catch (e: IllegalStateException) {
            // Closed.
        }
    }

    private fun runVision(frame: YuvFrame) {
        try {
            val result = vision.analyze(frame) ?: return
            lastVision = "${result.summary} (${result.elapsedMs} ms)"
            Log.i(TAG, "vision: ${result.summary} in ${result.elapsedMs} ms")
        } catch (e: Exception) {
            lastVision = "error: ${e.message}"
            Log.w(TAG, "vision model failed", e)
        } finally {
            visionIdle.set(true)
        }
    }

    private fun encodeJpeg(frame: YuvFrame): ByteArray {
        val out = ByteArrayOutputStream(256 * 1024)
        YuvImage(frame.toNv21(), ImageFormat.NV21, frame.width, frame.height, null)
            .compressToJpeg(Rect(0, 0, frame.width, frame.height), JPEG_QUALITY, out)
        return out.toByteArray()
    }

    companion object {
        private const val TAG = "CaptureController"

        /** 3 frames a second, OpenQuestCapture's default capture rate. */
        private const val DATASET_PERIOD_NS = 333_333_333L
        private const val VISION_PERIOD_NS = 1_000_000_000L
        private const val POSE_WAIT_NS = 120_000_000L
        private const val POSE_ROWS_BEFORE_START = 30L

        /** The web client sends quality 0.8 (src/capture/keyframes.ts). */
        private const val JPEG_QUALITY = 80

        /** Under server/main.ts UPLOAD_MAX_FRAME_BYTES (12 MB by default) with room for the multipart envelope. */
        private const val MAX_JPEG_BYTES = 11_000_000

        private fun singleThread(name: String, queue: Int) = ThreadPoolExecutor(
            1, 1, 0, TimeUnit.MILLISECONDS, ArrayBlockingQueue(queue),
            { r -> Thread(r, name) },
            ThreadPoolExecutor.AbortPolicy(),
        )

        private fun submit(executor: ThreadPoolExecutor, work: () -> Unit): Boolean = try {
            executor.execute { work() }
            true
        } catch (_: java.util.concurrent.RejectedExecutionException) {
            false
        }
    }
}
