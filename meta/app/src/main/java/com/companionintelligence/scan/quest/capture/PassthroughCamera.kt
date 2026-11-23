package com.companionintelligence.scan.quest.capture

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.ImageFormat
import android.hardware.camera2.CameraAccessException
import android.hardware.camera2.CameraCaptureSession
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraDevice
import android.hardware.camera2.CameraManager
import android.hardware.camera2.CameraMetadata
import android.hardware.camera2.params.OutputConfiguration
import android.hardware.camera2.params.SessionConfiguration
import android.media.Image
import android.media.ImageReader
import android.os.Handler
import android.os.HandlerThread
import android.os.SystemClock
import android.util.Log
import android.util.Size
import com.companionintelligence.scan.quest.pose.CameraClock
import com.companionintelligence.scan.quest.pose.CameraTimestampSource
import com.companionintelligence.scan.quest.pose.ClockOffsets
import com.companionintelligence.scan.quest.pose.PixelRect
import java.util.concurrent.Executor
import kotlin.math.abs

/**
 * The left passthrough camera through Camera2, delivering YUV_420_888 frames from an ImageReader.
 *
 * What Meta documents and this follows: the Passthrough Camera API is Camera2 on Horizon OS v74+, Quest 3 and
 * 3S, behind the runtime permission horizonos.permission.HEADSET_CAMERA. Passthrough cameras are told apart by the
 * vendor characteristics com.meta.extra_metadata.camera_source (0 = passthrough) and
 * com.meta.extra_metadata.position (0 = left, 1 = right, from the wearer's view). They offer 1280×960 among
 * other sizes, at about 60 Hz with 20–40 ms latency; Meta warns against always taking the largest size, so the
 * app asks for 1280×960 and, if that is missing, takes the offered size closest to it. Head pose does not come
 * from Camera2.
 *
 * The vendor keys are found by name among CameraCharacteristics.getKeys() and read whatever type the camera
 * hands back (OpenQuestCapture gets a byte array and takes its first byte), so no key type is assumed.
 *
 * Everything runs on one HandlerThread. [Listener.onCameraFrame] is called on it with an Image that is closed
 * as soon as the listener returns, so the listener must copy what it keeps.
 */
class PassthroughCamera(private val context: Context, private val listener: Listener) {

    interface Listener {
        fun onCameraOpened(calibration: CameraCalibration, clock: CameraClock)

        /** On the camera thread. The image is closed when this returns. */
        fun onCameraFrame(image: Image, clock: CameraClock)

        fun onCameraState(message: String, isError: Boolean)
    }

    private val thread = HandlerThread("passthrough-camera").apply { start() }
    private val handler = Handler(thread.looper)
    private val executor = Executor { handler.post(it) }

    // Touched on the camera thread only.
    private var device: CameraDevice? = null
    private var session: CameraCaptureSession? = null
    private var reader: ImageReader? = null
    private var opening = false

    /** Opens the camera once the HEADSET_CAMERA permission is granted. Does nothing if it is open or opening. */
    @SuppressLint("MissingPermission")
    fun open() {
        handler.post {
            if (device != null || opening) return@post
            try {
                val manager = context.getSystemService(CameraManager::class.java)
                val found = findLeftPassthrough(manager)
                if (found == null) {
                    listener.onCameraState(
                        "No left passthrough camera found. The Passthrough Camera API needs a Quest 3 or 3S on Horizon OS v74 or later.",
                        true,
                    )
                    return@post
                }
                val (id, characteristics) = found
                val size = chooseSize(characteristics)
                if (size == null) {
                    listener.onCameraState("Camera $id offers no YUV_420_888 output", true)
                    return@post
                }
                val calibration = readCalibration(id, characteristics, size)
                val clock = CameraClock(calibration.timestampSource, ANDROID_CLOCK_OFFSETS)
                val imageReader = ImageReader.newInstance(size.width, size.height, ImageFormat.YUV_420_888, MAX_IMAGES)
                imageReader.setOnImageAvailableListener({ r ->
                    val image = r.acquireLatestImage() ?: return@setOnImageAvailableListener
                    try {
                        listener.onCameraFrame(image, clock)
                    } catch (e: RuntimeException) {
                        Log.w(TAG, "frame handler failed", e)
                    } finally {
                        image.close()
                    }
                }, handler)
                reader = imageReader
                opening = true
                manager.openCamera(id, object : CameraDevice.StateCallback() {
                    override fun onOpened(camera: CameraDevice) {
                        opening = false
                        device = camera
                        startSession(camera, imageReader)
                        listener.onCameraOpened(calibration, clock)
                    }

                    override fun onDisconnected(camera: CameraDevice) {
                        opening = false
                        closeOnThread()
                        camera.close()
                        listener.onCameraState("Camera disconnected", true)
                    }

                    override fun onError(camera: CameraDevice, error: Int) {
                        opening = false
                        closeOnThread()
                        camera.close()
                        listener.onCameraState("Camera error $error", true)
                    }
                }, handler)
            } catch (e: SecurityException) {
                closeOnThread()
                listener.onCameraState("Camera permission missing: ${e.message}", true)
            } catch (e: CameraAccessException) {
                closeOnThread()
                listener.onCameraState("Camera not available: ${e.message}", true)
            } catch (e: IllegalArgumentException) {
                closeOnThread()
                listener.onCameraState("Camera could not be opened: ${e.message}", true)
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

    private fun startSession(camera: CameraDevice, imageReader: ImageReader) {
        val callback = object : CameraCaptureSession.StateCallback() {
            override fun onConfigured(s: CameraCaptureSession) {
                session = s
                try {
                    val request = camera.createCaptureRequest(CameraDevice.TEMPLATE_PREVIEW).apply {
                        addTarget(imageReader.surface)
                    }.build()
                    s.setRepeatingRequest(request, null, handler)
                    listener.onCameraState("Camera streaming", false)
                } catch (e: CameraAccessException) {
                    listener.onCameraState("Camera request failed: ${e.message}", true)
                } catch (e: IllegalStateException) {
                    listener.onCameraState("Camera request failed: ${e.message}", true)
                }
            }

            override fun onConfigureFailed(s: CameraCaptureSession) {
                listener.onCameraState("Camera session could not be configured", true)
            }
        }
        try {
            camera.createCaptureSession(
                SessionConfiguration(
                    SessionConfiguration.SESSION_REGULAR,
                    listOf(OutputConfiguration(imageReader.surface)),
                    executor,
                    callback,
                ),
            )
        } catch (e: CameraAccessException) {
            listener.onCameraState("Camera session failed: ${e.message}", true)
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
        opening = false
    }

    private fun findLeftPassthrough(manager: CameraManager): Pair<String, CameraCharacteristics>? {
        for (id in manager.cameraIdList) {
            val characteristics = manager.getCameraCharacteristics(id)
            val source = vendorInt(characteristics, KEY_CAMERA_SOURCE)
            val position = vendorInt(characteristics, KEY_CAMERA_POSITION)
            Log.i(TAG, "camera $id: camera_source=$source position=$position")
            if (source == PASSTHROUGH_SOURCE && position == LEFT_POSITION) return id to characteristics
        }
        return null
    }

    private fun chooseSize(characteristics: CameraCharacteristics): Size? {
        val sizes = characteristics.get(CameraCharacteristics.SCALER_STREAM_CONFIGURATION_MAP)
            ?.getOutputSizes(ImageFormat.YUV_420_888)
            ?: return null
        if (sizes.isEmpty()) return null
        sizes.firstOrNull { it.width == WANTED_WIDTH && it.height == WANTED_HEIGHT }?.let { return it }
        val wantedArea = WANTED_WIDTH.toLong() * WANTED_HEIGHT
        return sizes.minByOrNull { abs(it.width.toLong() * it.height - wantedArea) }
    }

    private fun readCalibration(id: String, c: CameraCharacteristics, size: Size): CameraCalibration {
        val pre = c.get(CameraCharacteristics.SENSOR_INFO_PRE_CORRECTION_ACTIVE_ARRAY_SIZE)
        val active = c.get(CameraCharacteristics.SENSOR_INFO_ACTIVE_ARRAY_SIZE)
        val pixelArray = c.get(CameraCharacteristics.SENSOR_INFO_PIXEL_ARRAY_SIZE)
        val physical = c.get(CameraCharacteristics.SENSOR_INFO_PHYSICAL_SIZE)
        return CameraCalibration(
            cameraId = id,
            cameraSource = vendorInt(c, KEY_CAMERA_SOURCE),
            cameraPosition = vendorInt(c, KEY_CAMERA_POSITION),
            lensFacing = when (c.get(CameraCharacteristics.LENS_FACING)) {
                CameraMetadata.LENS_FACING_FRONT -> "FRONT"
                CameraMetadata.LENS_FACING_BACK -> "BACK"
                CameraMetadata.LENS_FACING_EXTERNAL -> "EXTERNAL"
                else -> "UNKNOWN"
            },
            hardwareLevel = when (c.get(CameraCharacteristics.INFO_SUPPORTED_HARDWARE_LEVEL)) {
                CameraMetadata.INFO_SUPPORTED_HARDWARE_LEVEL_LEGACY -> "LEGACY"
                CameraMetadata.INFO_SUPPORTED_HARDWARE_LEVEL_LIMITED -> "LIMITED"
                CameraMetadata.INFO_SUPPORTED_HARDWARE_LEVEL_FULL -> "FULL"
                CameraMetadata.INFO_SUPPORTED_HARDWARE_LEVEL_3 -> "LEVEL_3"
                CameraMetadata.INFO_SUPPORTED_HARDWARE_LEVEL_EXTERNAL -> "EXTERNAL"
                else -> "UNKNOWN"
            },
            lensPoseTranslation = c.get(CameraCharacteristics.LENS_POSE_TRANSLATION),
            lensPoseRotation = c.get(CameraCharacteristics.LENS_POSE_ROTATION),
            lensPoseReference = when (c.get(CameraCharacteristics.LENS_POSE_REFERENCE)) {
                CameraMetadata.LENS_POSE_REFERENCE_PRIMARY_CAMERA -> "PRIMARY_CAMERA"
                CameraMetadata.LENS_POSE_REFERENCE_GYROSCOPE -> "GYROSCOPE"
                CameraMetadata.LENS_POSE_REFERENCE_UNDEFINED -> "UNDEFINED"
                CameraMetadata.LENS_POSE_REFERENCE_AUTOMOTIVE -> "AUTOMOTIVE"
                else -> "UNKNOWN"
            },
            intrinsicCalibration = c.get(CameraCharacteristics.LENS_INTRINSIC_CALIBRATION),
            distortion = c.get(CameraCharacteristics.LENS_DISTORTION),
            availableFocalLengths = c.get(CameraCharacteristics.LENS_INFO_AVAILABLE_FOCAL_LENGTHS) ?: FloatArray(0),
            physicalSizeMm = physical?.let { it.width to it.height },
            pixelArraySize = pixelArray?.let { it.width to it.height },
            preCorrectionActiveArray = pre?.let { PixelRect(it.left, it.top, it.right, it.bottom) },
            activeArray = active?.let { PixelRect(it.left, it.top, it.right, it.bottom) },
            timestampSource = CameraTimestampSource.fromCamera2(c.get(CameraCharacteristics.SENSOR_INFO_TIMESTAMP_SOURCE)),
            sensorOrientation = c.get(CameraCharacteristics.SENSOR_ORIENTATION),
            streamWidth = size.width,
            streamHeight = size.height,
        )
    }

    companion object {
        private const val TAG = "PassthroughCamera"
        const val KEY_CAMERA_SOURCE = "com.meta.extra_metadata.camera_source"
        const val KEY_CAMERA_POSITION = "com.meta.extra_metadata.position"
        const val PASSTHROUGH_SOURCE = 0
        const val LEFT_POSITION = 0
        const val WANTED_WIDTH = 1280
        const val WANTED_HEIGHT = 960
        private const val MAX_IMAGES = 4

        /** realtime − monotonic, read now. */
        val ANDROID_CLOCK_OFFSETS = ClockOffsets { SystemClock.elapsedRealtimeNanos() - System.nanoTime() }

        /** A vendor characteristic as an Int, whatever type the camera reports it as, or null when it is absent. */
        fun vendorInt(characteristics: CameraCharacteristics, name: String): Int? {
            val key = characteristics.keys.firstOrNull { it.name == name } ?: return null
            @Suppress("UNCHECKED_CAST")
            val value = try {
                characteristics.get(key as CameraCharacteristics.Key<Any>)
            } catch (e: IllegalArgumentException) {
                Log.w(TAG, "could not read $name", e)
                return null
            }
            return when (value) {
                is Int -> value
                is Byte -> value.toInt()
                is Long -> value.toInt()
                is ByteArray -> value.firstOrNull()?.toInt()
                is IntArray -> value.firstOrNull()
                is LongArray -> value.firstOrNull()?.toInt()
                else -> null
            }
        }
    }
}

/** Copies an Image's three planes out of the camera's buffers (whole buffers, padding included). */
fun Image.toYuvFrame(realtimeNs: Long): YuvFrame {
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
