package com.companionintelligence.scan.androidxr.probe

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.ImageFormat
import android.hardware.camera2.CameraAccessException
import android.hardware.camera2.CameraCaptureSession
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraDevice
import android.hardware.camera2.CameraManager
import android.hardware.camera2.CameraMetadata
import android.hardware.camera2.CaptureFailure
import android.hardware.camera2.CaptureRequest
import android.hardware.camera2.CaptureResult
import android.hardware.camera2.TotalCaptureResult
import android.hardware.camera2.params.OutputConfiguration
import android.hardware.camera2.params.SessionConfiguration
import android.media.Image
import android.media.ImageReader
import android.os.Handler
import android.os.HandlerThread
import android.os.SystemClock
import android.util.Log
import android.util.Range
import com.companionintelligence.scan.quest.capture.YuvFrame
import com.companionintelligence.scan.quest.capture.YuvPlane
import com.companionintelligence.scan.quest.pose.CameraClock
import com.companionintelligence.scan.quest.pose.CameraTimestampSource
import com.companionintelligence.scan.quest.pose.ClockOffsets
import com.companionintelligence.scan.quest.pose.PixelRect
import java.util.concurrent.Executor

/**
 * Camera 0 through Camera2, YUV_420_888 frames from an ImageReader, and every frame's capture result (exposure, rolling
 * shutter skew, readout time). The Quest app's PassthroughCamera has the same shape, but it finds its camera by Meta's
 * vendor keys; this one takes [CameraChoice]'s pick.
 *
 * Everything runs on one HandlerThread. [Listener.onCameraFrame] gets an Image that is closed as soon as it returns.
 */
class AuraCamera(private val context: Context, private val listener: Listener) {

    interface Listener {
        fun onCameraOpened(facts: CameraFacts, clock: CameraClock)

        /** On the camera thread. The image is closed when this returns, so copy what is kept. */
        fun onCameraFrame(image: Image, frameRealtimeNs: Long, arrivalRealtimeNs: Long)

        /** On the camera thread. */
        fun onCaptureTiming(timing: CaptureTiming)

        fun onCameraState(message: String, isError: Boolean)
    }

    private val thread = HandlerThread("aura-camera").apply { start() }
    private val handler = Handler(thread.looper)
    private val executor = Executor { handler.post(it) }

    // Touched on the camera thread only.
    private var device: CameraDevice? = null
    private var session: CameraCaptureSession? = null
    private var reader: ImageReader? = null

    private val manager: CameraManager get() = context.getSystemService(CameraManager::class.java)

    /** Every camera Camera2 lists to this app. */
    fun describeCameras(): List<CameraDescription> = manager.cameraIdList.map { describe(it, manager.getCameraCharacteristics(it)) }

    /** Opens [CameraChoice]'s camera at [wanted] (or the nearest size it offers). Needs the CAMERA permission. */
    @SuppressLint("MissingPermission")
    fun open(wanted: PixelSize) {
        handler.post {
            if (device != null || reader != null) return@post
            try {
                val cameras = manager.cameraIdList.map { it to manager.getCameraCharacteristics(it) }
                val choice = CameraChoice.choose(cameras.map { (id, c) -> describe(id, c) })
                if (choice == null) {
                    listener.onCameraState("No back-facing colour camera with YUV outputs among ${cameras.map { it.first }}", true)
                    return@post
                }
                val characteristics = cameras.first { it.first == choice.id }.second
                val size = CameraChoice.chooseSize(choice.yuvSizes, wanted)
                if (size == null) {
                    listener.onCameraState("Camera ${choice.id} offers no YUV_420_888 size", true)
                    return@post
                }
                val facts = readFacts(choice.id, characteristics, size)
                val clock = CameraClock(facts.timestampSource, ANDROID_CLOCK_OFFSETS)
                val imageReader = ImageReader.newInstance(size.width, size.height, ImageFormat.YUV_420_888, MAX_IMAGES)
                imageReader.setOnImageAvailableListener({ r ->
                    val image = r.acquireNextImage() ?: return@setOnImageAvailableListener
                    val arrival = SystemClock.elapsedRealtimeNanos()
                    try {
                        listener.onCameraFrame(image, clock.toRealtimeNs(image.timestamp), arrival)
                    } catch (e: RuntimeException) {
                        Log.w(TAG, "frame handler failed", e)
                    } finally {
                        image.close()
                    }
                }, handler)
                reader = imageReader
                manager.openCamera(choice.id, executor, object : CameraDevice.StateCallback() {
                    override fun onOpened(camera: CameraDevice) {
                        device = camera
                        startSession(camera, imageReader, facts)
                        listener.onCameraOpened(facts, clock)
                    }

                    override fun onDisconnected(camera: CameraDevice) {
                        closeOnThread()
                        camera.close()
                        listener.onCameraState("Camera ${choice.id} disconnected", true)
                    }

                    override fun onError(camera: CameraDevice, error: Int) {
                        closeOnThread()
                        camera.close()
                        listener.onCameraState("Camera ${choice.id} error $error (CameraDevice.StateCallback.ERROR_*)", true)
                    }
                })
            } catch (e: SecurityException) {
                closeOnThread()
                listener.onCameraState("openCamera: SecurityException: ${e.message}", true)
            } catch (e: CameraAccessException) {
                closeOnThread()
                listener.onCameraState("openCamera: CameraAccessException ${e.reason}: ${e.message}", true)
            } catch (e: IllegalArgumentException) {
                closeOnThread()
                listener.onCameraState("openCamera: IllegalArgumentException: ${e.message}", true)
            }
        }
    }

    fun close() {
        handler.post { closeOnThread() }
    }

    fun shutdown() {
        handler.post {
            closeOnThread()
            thread.quitSafely()
        }
    }

    private fun startSession(camera: CameraDevice, imageReader: ImageReader, facts: CameraFacts) {
        val results = object : CameraCaptureSession.CaptureCallback() {
            // The start of readout arrives on its own callback (API 34, when SENSOR_READOUT_TIMESTAMP is HARDWARE), keyed
            // by frame number, before the frame's result. All of these run on the camera thread.
            private val readouts = object : LinkedHashMap<Long, Long>() {
                override fun removeEldestEntry(eldest: MutableMap.MutableEntry<Long, Long>?) = size > 64
            }

            override fun onReadoutStarted(s: CameraCaptureSession, request: CaptureRequest, timestamp: Long, frameNumber: Long) {
                readouts[frameNumber] = timestamp
            }

            override fun onCaptureCompleted(s: CameraCaptureSession, request: CaptureRequest, result: TotalCaptureResult) {
                val readout = readouts.remove(result.frameNumber)
                val timestamp = result.get(CaptureResult.SENSOR_TIMESTAMP) ?: return
                listener.onCaptureTiming(
                    CaptureTiming(
                        sensorTimestampNs = timestamp,
                        exposureNs = result.get(CaptureResult.SENSOR_EXPOSURE_TIME),
                        rollingShutterSkewNs = result.get(CaptureResult.SENSOR_ROLLING_SHUTTER_SKEW),
                        readoutTimestampNs = readout,
                        frameDurationNs = result.get(CaptureResult.SENSOR_FRAME_DURATION),
                    ),
                )
            }

            override fun onCaptureFailed(s: CameraCaptureSession, request: CaptureRequest, failure: CaptureFailure) {
                readouts.remove(failure.frameNumber)
            }
        }
        val callback = object : CameraCaptureSession.StateCallback() {
            override fun onConfigured(s: CameraCaptureSession) {
                session = s
                try {
                    val request = camera.createCaptureRequest(CameraDevice.TEMPLATE_PREVIEW).apply {
                        addTarget(imageReader.surface)
                        // A steady 30 frames a second when the camera offers it (the Aura's camera 0 lists [30, 30]).
                        if (facts.aeTargetFpsRanges.contains(30 to 30)) set(CaptureRequest.CONTROL_AE_TARGET_FPS_RANGE, Range(30, 30))
                    }.build()
                    s.setRepeatingRequest(request, results, handler)
                    listener.onCameraState("Camera ${facts.id} streaming ${facts.stream}", false)
                } catch (e: CameraAccessException) {
                    listener.onCameraState("setRepeatingRequest: CameraAccessException ${e.reason}: ${e.message}", true)
                } catch (e: IllegalStateException) {
                    listener.onCameraState("setRepeatingRequest: IllegalStateException: ${e.message}", true)
                }
            }

            override fun onConfigureFailed(s: CameraCaptureSession) {
                listener.onCameraState("Camera ${facts.id}: the capture session could not be configured", true)
            }
        }
        try {
            camera.createCaptureSession(
                SessionConfiguration(SessionConfiguration.SESSION_REGULAR, listOf(OutputConfiguration(imageReader.surface)), executor, callback),
            )
        } catch (e: CameraAccessException) {
            listener.onCameraState("createCaptureSession: CameraAccessException ${e.reason}: ${e.message}", true)
        }
    }

    private fun closeOnThread() {
        try {
            session?.close()
        } catch (_: IllegalStateException) {
        }
        session = null
        device?.close()
        device = null
        reader?.close()
        reader = null
    }

    private fun describe(id: String, c: CameraCharacteristics): CameraDescription {
        val capabilities = c.get(CameraCharacteristics.REQUEST_AVAILABLE_CAPABILITIES) ?: IntArray(0)
        return CameraDescription(
            id = id,
            facing = facing(c),
            backwardCompatible = CameraMetadata.REQUEST_AVAILABLE_CAPABILITIES_BACKWARD_COMPATIBLE in capabilities,
            depthOutput = CameraMetadata.REQUEST_AVAILABLE_CAPABILITIES_DEPTH_OUTPUT in capabilities,
            yuvSizes = yuvSizes(c),
        )
    }

    private fun readFacts(id: String, c: CameraCharacteristics, stream: PixelSize): CameraFacts {
        val pre = c.get(CameraCharacteristics.SENSOR_INFO_PRE_CORRECTION_ACTIVE_ARRAY_SIZE)
        val active = c.get(CameraCharacteristics.SENSOR_INFO_ACTIVE_ARRAY_SIZE)
        val pixelArray = c.get(CameraCharacteristics.SENSOR_INFO_PIXEL_ARRAY_SIZE)
        val physical = c.get(CameraCharacteristics.SENSOR_INFO_PHYSICAL_SIZE)
        return CameraFacts(
            id = id,
            facing = facing(c),
            hardwareLevel = when (c.get(CameraCharacteristics.INFO_SUPPORTED_HARDWARE_LEVEL)) {
                CameraMetadata.INFO_SUPPORTED_HARDWARE_LEVEL_LEGACY -> "LEGACY"
                CameraMetadata.INFO_SUPPORTED_HARDWARE_LEVEL_LIMITED -> "LIMITED"
                CameraMetadata.INFO_SUPPORTED_HARDWARE_LEVEL_FULL -> "FULL"
                CameraMetadata.INFO_SUPPORTED_HARDWARE_LEVEL_3 -> "LEVEL_3"
                CameraMetadata.INFO_SUPPORTED_HARDWARE_LEVEL_EXTERNAL -> "EXTERNAL"
                else -> "UNKNOWN"
            },
            capabilities = (c.get(CameraCharacteristics.REQUEST_AVAILABLE_CAPABILITIES) ?: IntArray(0)).map(::capabilityName),
            timestampSource = CameraTimestampSource.fromCamera2(c.get(CameraCharacteristics.SENSOR_INFO_TIMESTAMP_SOURCE)),
            readoutTimestamp = when (c.get(CameraCharacteristics.SENSOR_READOUT_TIMESTAMP)) {
                CameraMetadata.SENSOR_READOUT_TIMESTAMP_HARDWARE -> "HARDWARE"
                CameraMetadata.SENSOR_READOUT_TIMESTAMP_NOT_SUPPORTED -> "NOT_SUPPORTED"
                else -> null
            },
            lensPoseTranslation = c.get(CameraCharacteristics.LENS_POSE_TRANSLATION),
            lensPoseRotation = c.get(CameraCharacteristics.LENS_POSE_ROTATION),
            lensPoseReference = when (c.get(CameraCharacteristics.LENS_POSE_REFERENCE)) {
                null -> null
                CameraMetadata.LENS_POSE_REFERENCE_PRIMARY_CAMERA -> "PRIMARY_CAMERA"
                CameraMetadata.LENS_POSE_REFERENCE_GYROSCOPE -> "GYROSCOPE"
                CameraMetadata.LENS_POSE_REFERENCE_UNDEFINED -> "UNDEFINED"
                CameraMetadata.LENS_POSE_REFERENCE_AUTOMOTIVE -> "AUTOMOTIVE"
                else -> "UNKNOWN"
            },
            intrinsicCalibration = c.get(CameraCharacteristics.LENS_INTRINSIC_CALIBRATION),
            distortion = c.get(CameraCharacteristics.LENS_DISTORTION),
            focalLengthsMm = c.get(CameraCharacteristics.LENS_INFO_AVAILABLE_FOCAL_LENGTHS) ?: FloatArray(0),
            physicalSizeMm = physical?.let { it.width to it.height },
            pixelArraySize = pixelArray?.let { PixelSize(it.width, it.height) },
            preCorrectionActiveArray = pre?.let { PixelRect(it.left, it.top, it.right, it.bottom) },
            activeArray = active?.let { PixelRect(it.left, it.top, it.right, it.bottom) },
            sensorOrientation = c.get(CameraCharacteristics.SENSOR_ORIENTATION),
            yuvSizes = yuvSizes(c),
            aeTargetFpsRanges = (c.get(CameraCharacteristics.CONTROL_AE_AVAILABLE_TARGET_FPS_RANGES) ?: emptyArray())
                .map { it.lower to it.upper },
            stream = stream,
        )
    }

    private fun facing(c: CameraCharacteristics) = when (c.get(CameraCharacteristics.LENS_FACING)) {
        CameraMetadata.LENS_FACING_BACK -> Facing.BACK
        CameraMetadata.LENS_FACING_FRONT -> Facing.FRONT
        CameraMetadata.LENS_FACING_EXTERNAL -> Facing.EXTERNAL
        else -> Facing.UNKNOWN
    }

    private fun yuvSizes(c: CameraCharacteristics): List<PixelSize> =
        c.get(CameraCharacteristics.SCALER_STREAM_CONFIGURATION_MAP)
            ?.getOutputSizes(ImageFormat.YUV_420_888)
            ?.map { PixelSize(it.width, it.height) }
            ?: emptyList()

    private fun capabilityName(value: Int) = when (value) {
        CameraMetadata.REQUEST_AVAILABLE_CAPABILITIES_BACKWARD_COMPATIBLE -> "BACKWARD_COMPATIBLE"
        CameraMetadata.REQUEST_AVAILABLE_CAPABILITIES_DEPTH_OUTPUT -> "DEPTH_OUTPUT"
        CameraMetadata.REQUEST_AVAILABLE_CAPABILITIES_LOGICAL_MULTI_CAMERA -> "LOGICAL_MULTI_CAMERA"
        CameraMetadata.REQUEST_AVAILABLE_CAPABILITIES_MONOCHROME -> "MONOCHROME"
        CameraMetadata.REQUEST_AVAILABLE_CAPABILITIES_RAW -> "RAW"
        CameraMetadata.REQUEST_AVAILABLE_CAPABILITIES_SYSTEM_CAMERA -> "SYSTEM_CAMERA"
        else -> value.toString()
    }

    companion object {
        private const val TAG = "AuraCamera"
        private const val MAX_IMAGES = 4

        /** realtime − monotonic, read now (the Quest's PassthroughCamera reads it the same way). */
        val ANDROID_CLOCK_OFFSETS = ClockOffsets { SystemClock.elapsedRealtimeNanos() - System.nanoTime() }
    }
}

/** Copies an Image's three planes out of the camera's buffers, whole (the Quest's `Image.toYuvFrame`, for camera 0). */
fun Image.copyToYuvFrame(realtimeNs: Long): YuvFrame {
    val p = planes
    require(p.size == 3) { "expected three YUV planes, got ${p.size}" }
    fun copy(plane: Image.Plane): YuvPlane {
        val buffer = plane.buffer.duplicate()
        buffer.rewind()
        val bytes = ByteArray(buffer.remaining())
        buffer.get(bytes)
        return YuvPlane(bytes, plane.rowStride, plane.pixelStride)
    }
    return YuvFrame(width, height, timestamp, realtimeNs, copy(p[0]), copy(p[1]), copy(p[2]))
}
