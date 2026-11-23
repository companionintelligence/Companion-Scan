package com.companionintelligence.scan.quest.dataset

import com.companionintelligence.scan.quest.capture.CameraCalibration
import com.companionintelligence.scan.quest.capture.YuvFrame
import com.companionintelligence.scan.quest.pose.CoordinateConversions
import com.companionintelligence.scan.quest.pose.PinholeIntrinsics
import com.companionintelligence.scan.quest.pose.PixelRect
import com.companionintelligence.scan.quest.pose.PoseSample
import com.companionintelligence.scan.quest.pose.UnixMsMapper
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObjectBuilder
import kotlinx.serialization.json.add
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import kotlinx.serialization.json.putJsonObject
import java.io.BufferedWriter
import java.io.Closeable
import java.io.File
import java.io.FileOutputStream
import java.util.Locale

/**
 * The names mq3drecon's legacy (Camera2) reader looks for, from its src/mq3drecon/layouts/project_layout.py
 * (`YUV_DIR_MAP`, `CAMERA_CHARACTERISTICS_JSON_MAP`, `CAMERA_FORMAT_INFO_JSON_MAP`, `HMD_POSE_CSV_PATH`) and the
 * `hmd_poses.csv` header OpenQuestCapture's PoseLogger.cs writes. Only the left camera is recorded.
 */
object Mq3dreconLayout {
    const val RAW_DIR = "left_camera_raw"
    const val CHARACTERISTICS_JSON = "left_camera_characteristics.json"
    const val IMAGE_FORMAT_JSON = "left_camera_image_format.json"
    const val HMD_POSES_CSV = "hmd_poses.csv"
    const val FRAME_SUFFIX = ".yuv"

    /** session_info.json is deliberately not written: without it mq3drecon treats a recording as legacy Camera2. */
    const val SESSION_INFO_JSON = "session_info.json"

    val HMD_POSE_COLUMNS = listOf(
        "unix_time", "ovr_timestamp",
        "pos_x", "pos_y", "pos_z",
        "rot_x", "rot_y", "rot_z", "rot_w",
    )
}

/**
 * Writes one recording in the layout mq3drecon's legacy reader takes (and OpenQuestCapture writes):
 *
 *     <dir>/left_camera_raw/<unixMs>.yuv        the three YUV_420_888 plane buffers back to back
 *     <dir>/left_camera_image_format.json       width, height, format, per-plane strides, baseTime
 *     <dir>/left_camera_characteristics.json    raw Camera2 lens pose, intrinsics, distortion, sensor arrays
 *     <dir>/hmd_poses.csv                       every head pose sample, Unity convention (see CoordinateConversions)
 *
 * Frame names and `unix_time` share one [UnixMsMapper], so mq3drecon's pose interpolator, which wants a pose row
 * within 30 ms either side of each frame (dataio/helpers/pose_interpolator.py), finds them.
 *
 * What Mq3dreconDatasetWriterTest checks is the names, the JSON keys and the CSV header those readers use, and
 * the byte layout of a frame. It does not run mq3drecon. Two known gaps, kept rather than papered over: mq3drecon
 * takes the image size from `sensor.activeArraySize` and uses the intrinsics unscaled, while this app records a
 * 1280×960 stream (OpenQuestCapture records at the pixel array size), so the two agree only if the active array
 * is 1280×960; and the lens pose is written raw, as Camera2 gave it, because mq3drecon applies its own flips.
 *
 * Not thread-safe across instances; one instance is driven from a single dataset thread.
 */
class Mq3dreconDatasetWriter(
    val directory: File,
    private val calibration: CameraCalibration,
    private val unixMs: UnixMsMapper,
    /** The camera-clock timestamp that corresponds to [UnixMsMapper.baseUnixMs] (written as baseMonoTimeNs). */
    private val baseCameraTimestampNs: Long,
) : Closeable {
    private val rawDir = File(directory, Mq3dreconLayout.RAW_DIR)
    private val poses: BufferedWriter
    private var formatWritten = false
    private var closed = false

    // Read by the panel on the main thread while the dataset thread writes.
    @Volatile var framesWritten = 0
        private set
    @Volatile var bytesWritten = 0L
        private set
    @Volatile var poseRowsWritten = 0
        private set

    init {
        check(rawDir.isDirectory || rawDir.mkdirs()) { "could not create $rawDir" }
        File(directory, Mq3dreconLayout.CHARACTERISTICS_JSON).writeText(characteristicsJson(calibration))
        poses = File(directory, Mq3dreconLayout.HMD_POSES_CSV).bufferedWriter()
        poses.write(Mq3dreconLayout.HMD_POSE_COLUMNS.joinToString(","))
        poses.write("\n")
    }

    /** Writes one frame as `left_camera_raw/<unixMs>.yuv`; the image format file goes with the first frame. */
    @Synchronized
    fun writeFrame(frame: YuvFrame): File? {
        check(!closed) { "writer is closed" }
        if (!formatWritten) {
            File(directory, Mq3dreconLayout.IMAGE_FORMAT_JSON).writeText(imageFormatJson(frame))
            formatWritten = true
        }
        val file = File(rawDir, "${unixMs.unixMs(frame.realtimeNs)}${Mq3dreconLayout.FRAME_SUFFIX}")
        if (file.exists()) return null // two frames in one millisecond: keep the first
        FileOutputStream(file).use { out ->
            for (plane in frame.planes) out.write(plane.bytes)
        }
        framesWritten++
        bytesWritten += frame.planes.sumOf { it.bufferSize.toLong() }
        return file
    }

    /**
     * Appends head pose samples (Spatial SDK scene, see PoseRingBuffer) as `hmd_poses.csv` rows. Every column is
     * filled: mq3drecon reads the file with `dropna()`, so an empty `ovr_timestamp` would drop the row.
     * `ovr_timestamp` is the OpenXR time in seconds when the sample has one, otherwise the realtime clock in
     * seconds; mq3drecon does not read it.
     */
    @Synchronized
    fun appendHeadPoses(samples: List<PoseSample>) {
        check(!closed) { "writer is closed" }
        for (s in samples) {
            val pose = CoordinateConversions.spatialToMq3dreconHmd(s.pose)
            if (!pose.isFinite()) continue
            val seconds = (s.xrTimeNs ?: s.realtimeNs) / 1e9
            val p = pose.position
            val q = pose.rotation
            poses.write(
                String.format(
                    Locale.ROOT,
                    "%d,%.9f,%.6f,%.6f,%.6f,%.8f,%.8f,%.8f,%.8f\n",
                    unixMs.unixMs(s.realtimeNs), seconds, p.x, p.y, p.z, q.x, q.y, q.z, q.w,
                ),
            )
            poseRowsWritten++
        }
    }

    @Synchronized
    fun flush() {
        if (!closed) poses.flush()
    }

    @Synchronized
    override fun close() {
        if (closed) return
        closed = true
        poses.close()
    }

    private fun imageFormatJson(frame: YuvFrame): String = PRETTY.encodeToString(
        JsonElement.serializer(),
        buildJsonObject {
            put("width", frame.width)
            put("height", frame.height)
            put("format", "YUV_420_888")
            putJsonArray("planes") {
                for (plane in frame.planes) {
                    add(
                        buildJsonObject {
                            put("rowStride", plane.rowStride)
                            put("pixelStride", plane.pixelStride)
                            put("bufferSize", plane.bufferSize)
                        },
                    )
                }
            }
            putJsonObject("baseTime") {
                // Same meaning as OpenQuestCapture's: unix ms = baseUnixTimeMs + (Image.getTimestamp() - baseMonoTimeNs) / 1e6.
                // The value is on the camera's own clock, which is monotonic only when its timestamp source is UNKNOWN.
                put("baseMonoTimeNs", baseCameraTimestampNs)
                put("baseUnixTimeMs", unixMs.baseUnixMs)
            }
            putJsonObject("companionScan") {
                put("cameraTimestampSource", calibration.timestampSource.name)
                put("baseRealtimeNs", unixMs.baseRealtimeNs)
            }
        },
    )

    companion object {
        private val PRETTY = Json { prettyPrint = true }

        /** OpenQuestCapture's CameraMetadata field names (CameraMetaData.cs), plus a `companionScan` block mq3drecon ignores. */
        fun characteristicsJson(c: CameraCalibration): String = PRETTY.encodeToString(
            JsonElement.serializer(),
            buildJsonObject {
                put("cameraId", c.cameraId)
                c.cameraSource?.let { put("cameraSource", it) }
                c.cameraPosition?.let { put("cameraPositionId", it) }
                put("lensFacing", c.lensFacing)
                put("hardwareLevel", c.hardwareLevel)
                putJsonObject("pose") {
                    // mq3drecon indexes translation[2] before it checks the length, so three entries are always
                    // written. A camera that reported no pose gets the value that means "looks where the head
                    // looks" (zero offset, half turn about X: see CoordinateConversions.headFromCamera), flagged
                    // below as not reported.
                    floatArray("translation", c.lensPoseTranslation?.takeIf { it.size >= 3 } ?: floatArrayOf(0f, 0f, 0f))
                    floatArray("rotation", c.lensPoseRotation?.takeIf { it.size >= 4 } ?: floatArrayOf(1f, 0f, 0f, 0f))
                    put("reference", c.lensPoseReference)
                }
                val k = c.intrinsicCalibration
                putJsonObject("intrinsics") {
                    put("fx", k?.getOrNull(0) ?: 0f)
                    put("fy", k?.getOrNull(1) ?: 0f)
                    put("cx", k?.getOrNull(2) ?: 0f)
                    put("cy", k?.getOrNull(3) ?: 0f)
                    put("skew", k?.getOrNull(4) ?: 0f)
                }
                floatArray("distortion", c.distortion ?: FloatArray(0))
                putJsonObject("sensor") {
                    floatArray("availableFocalLengths", c.availableFocalLengths)
                    c.physicalSizeMm?.let { (w, h) -> putJsonObject("physicalSize") { put("width", w); put("height", h) } }
                    c.pixelArraySize?.let { (w, h) -> putJsonObject("pixelArraySize") { put("width", w); put("height", h) } }
                    c.preCorrectionActiveArray?.let { rect("preCorrectionActiveArraySize", it) }
                    c.activeArray?.let { rect("activeArraySize", it) }
                    put("timestampSource", c.timestampSource.name)
                }
                putJsonObject("companionScan") {
                    put("lensPoseReported", c.hasLensPose)
                    c.sensorOrientation?.let { put("sensorOrientation", it) }
                    putJsonObject("stream") {
                        put("width", c.streamWidth)
                        put("height", c.streamHeight)
                        put("format", "YUV_420_888")
                    }
                    c.streamIntrinsics()?.let { intrinsics("streamIntrinsics", it) }
                    put(
                        "note",
                        "pose, intrinsics and sensor are raw Camera2 values. streamIntrinsics are the same intrinsics " +
                            "moved to the recorded stream's pixel grid (centre crop of the active array, then scale).",
                    )
                }
            },
        )

        private fun JsonObjectBuilder.floatArray(name: String, values: FloatArray) {
            putJsonArray(name) { for (v in values) add(if (v.isFinite()) v else 0f) }
        }

        private fun JsonObjectBuilder.rect(name: String, r: PixelRect) {
            putJsonObject(name) {
                put("left", r.left)
                put("top", r.top)
                put("right", r.right)
                put("bottom", r.bottom)
            }
        }

        private fun JsonObjectBuilder.intrinsics(name: String, k: PinholeIntrinsics) {
            putJsonObject(name) {
                put("fx", k.fx)
                put("fy", k.fy)
                put("cx", k.cx)
                put("cy", k.cy)
                put("width", k.width)
                put("height", k.height)
            }
        }
    }
}
