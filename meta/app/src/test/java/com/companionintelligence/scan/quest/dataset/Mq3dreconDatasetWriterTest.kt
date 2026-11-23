package com.companionintelligence.scan.quest.dataset

import com.companionintelligence.scan.quest.capture.CameraCalibration
import com.companionintelligence.scan.quest.capture.YuvFrame
import com.companionintelligence.scan.quest.capture.YuvPlane
import com.companionintelligence.scan.quest.pose.CameraTimestampSource
import com.companionintelligence.scan.quest.pose.PixelRect
import com.companionintelligence.scan.quest.pose.PoseRingBuffer
import com.companionintelligence.scan.quest.pose.PoseSample
import com.companionintelligence.scan.quest.pose.PoseTimeSource
import com.companionintelligence.scan.quest.pose.Quat
import com.companionintelligence.scan.quest.pose.RigidPose
import com.companionintelligence.scan.quest.pose.UnixMsMapper
import com.companionintelligence.scan.quest.pose.Vec3
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.double
import kotlinx.serialization.json.float
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File

/**
 * Writes a small synthetic recording and checks it against what mq3drecon's legacy reader expects, as read
 * from its source (src/mq3drecon/layouts/project_layout.py, dataio/image_data_io.py,
 * dataio/helpers/pose_interpolator.py, utils/image_utils.py, dataio/session_info.py). It checks folder and file
 * names, JSON keys, the CSV header and rows, the frame byte layout, and that every frame has pose rows within
 * the interpolator's 30 ms window. It does not run mq3drecon.
 */
class Mq3dreconDatasetWriterTest {
    @get:Rule
    val tmp = TemporaryFolder()

    private val width = 8
    private val height = 4
    private val ms = 1_000_000L
    private val baseRealtime = 50_000 * ms
    private val baseUnixMs = 1_763_900_000_000L

    private fun calibration(lensPose: Boolean = true) = CameraCalibration(
        cameraId = "50",
        cameraSource = 0,
        cameraPosition = 0,
        lensFacing = "BACK",
        hardwareLevel = "FULL",
        lensPoseTranslation = if (lensPose) floatArrayOf(-0.0321f, -0.0102f, -0.0598f) else null,
        lensPoseRotation = if (lensPose) floatArrayOf(0.9961947f, 0f, 0f, 0.0871557f) else null,
        lensPoseReference = "GYROSCOPE",
        intrinsicCalibration = floatArrayOf(870.5f, 869.25f, 641.5f, 479.75f, 0f),
        distortion = floatArrayOf(0.1f, -0.02f, 0.003f, 0.0004f, -0.0005f),
        availableFocalLengths = floatArrayOf(2.1f),
        physicalSizeMm = 4.8f to 3.6f,
        pixelArraySize = 1280 to 960,
        preCorrectionActiveArray = PixelRect(0, 0, 1280, 960),
        activeArray = PixelRect(0, 0, 1280, 960),
        timestampSource = CameraTimestampSource.REALTIME,
        sensorOrientation = 0,
        streamWidth = width,
        streamHeight = height,
    )

    /**
     * Android's semi-planar YUV_420_888 as an ImageReader hands it out: Y with a row stride wider than the image,
     * U and V as two views, one byte apart, of one interleaved chroma buffer (pixel stride 2).
     */
    private fun frame(n: Int, realtimeNs: Long): Triple<YuvFrame, ByteArray, ByteArray> {
        val yStride = 12
        val y = ByteArray(yStride * (height - 1) + width) { (it + n).toByte() }
        val cStride = 12
        val chromaRows = height / 2
        val chromaCols = width / 2
        val interleaved = ByteArray(cStride * (chromaRows - 1) + chromaCols * 2) { (100 + it + n).toByte() }
        val u = interleaved.copyOfRange(0, interleaved.size - 1)
        val v = interleaved.copyOfRange(1, interleaved.size)
        val f = YuvFrame(width, height, realtimeNs, realtimeNs, YuvPlane(y, yStride, 1), YuvPlane(u, cStride, 2), YuvPlane(v, cStride, 2))
        return Triple(f, u, v)
    }

    private fun json(file: File) = Json.parseToJsonElement(file.readText()) as JsonObject

    private fun JsonObject.obj(name: String) = this[name]!!.jsonObject

    private fun record(dir: File, lensPose: Boolean = true): List<YuvFrame> {
        val writer = Mq3dreconDatasetWriter(dir, calibration(lensPose), UnixMsMapper(baseRealtime, baseUnixMs), baseRealtime)
        // Head poses every 11 ms (a 90 Hz display) from 40 ms before the first frame to 40 ms after the last.
        val poses = PoseRingBuffer(256)
        var t = baseRealtime + 60 * ms
        while (t <= baseRealtime + 860 * ms) {
            val k = (t - baseRealtime).toDouble() / 1e9
            poses.add(t, RigidPose(Vec3(k, 1.6, -k / 2), Quat.fromAxisAngle(Vec3.Y, k)), t - 5_000_000_000L, PoseTimeSource.PREDICTED_DISPLAY_TIME)
            t += 11 * ms
        }
        val frames = listOf(100, 433, 766).mapIndexed { i, offsetMs -> frame(i, baseRealtime + offsetMs * ms).first }
        frames.forEach { writer.writeFrame(it) }
        val samples = ArrayList<PoseSample>()
        poses.drainSince(0, samples)
        writer.appendHeadPoses(samples.subList(0, samples.size / 2))
        writer.appendHeadPoses(samples.subList(samples.size / 2, samples.size))
        writer.close()
        assertEquals(3, writer.framesWritten)
        assertEquals(samples.size, writer.poseRowsWritten)
        return frames
    }

    @Test
    fun foldersAndFilesHaveTheNamesTheLegacyReaderLooksFor() {
        val dir = tmp.newFolder("20261123_101500")
        record(dir)
        // project_layout.py: YUV_DIR_MAP, CAMERA_CHARACTERISTICS_JSON_MAP, CAMERA_FORMAT_INFO_JSON_MAP, HMD_POSE_CSV_PATH.
        assertTrue(File(dir, "left_camera_raw").isDirectory)
        assertTrue(File(dir, "left_camera_characteristics.json").isFile)
        assertTrue(File(dir, "left_camera_image_format.json").isFile)
        assertTrue(File(dir, "hmd_poses.csv").isFile)
        // session_info.py: no session_info.json means a legacy Camera2 (NativeCamera2) recording.
        assertFalse(File(dir, "session_info.json").exists())
        assertEquals(
            setOf("left_camera_raw", "left_camera_characteristics.json", "left_camera_image_format.json", "hmd_poses.csv"),
            dir.list()!!.toSet(),
        )
        // ImagePathConfig.get_yuv_file_path: <timestamp>.yuv, where the stem parses as an int (get_yuv_timestamps).
        val names = File(dir, "left_camera_raw").list()!!.sorted()
        assertEquals(listOf("${baseUnixMs + 100}.yuv", "${baseUnixMs + 433}.yuv", "${baseUnixMs + 766}.yuv"), names)
        names.forEach { assertTrue(it, Regex("^\\d+\\.yuv$").matches(it)) }
    }

    @Test
    fun theImageFormatFileDescribesTheFrameBytes() {
        val dir = tmp.newFolder("rec")
        val frames = record(dir)
        val format = json(File(dir, "left_camera_image_format.json"))
        // image_data_io.py load_image_format_info reads exactly these keys.
        assertEquals(width, format["width"]!!.jsonPrimitive.int)
        assertEquals(height, format["height"]!!.jsonPrimitive.int)
        assertEquals("YUV_420_888", format["format"]!!.jsonPrimitive.content)
        val planes = format["planes"]!!.jsonArray
        assertEquals(3, planes.size)
        val described = planes.map { p ->
            val o = p.jsonObject
            Triple(o["bufferSize"]!!.jsonPrimitive.int, o["rowStride"]!!.jsonPrimitive.int, o["pixelStride"]!!.jsonPrimitive.int)
        }
        assertEquals(frames[0].planes.map { Triple(it.bufferSize, it.rowStride, it.pixelStride) }, described)
        val base = format.obj("baseTime")
        assertEquals(baseRealtime, base["baseMonoTimeNs"]!!.jsonPrimitive.long)
        assertEquals(baseUnixMs, base["baseUnixTimeMs"]!!.jsonPrimitive.long)

        // The .yuv file is the three plane buffers back to back (utils/image_utils.py convert_yuv420_888_to_i420:
        // Y at 0, chroma from offset planes[0].bufferSize, V after U when chroma is planar).
        for ((i, f) in frames.withIndex()) {
            val bytes = File(dir, "left_camera_raw/${baseUnixMs + listOf(100, 433, 766)[i]}.yuv").readBytes()
            assertEquals(described.sumOf { it.first }, bytes.size)
            assertArrayEquals(f.y.bytes + f.u.bytes + f.v.bytes, bytes)
            // Read it back the way that reader does, through the recorded strides, and compare pixel by pixel.
            val (ySize, yStride, _) = described[0]
            val (_, cStride, cPixelStride) = described[1]
            for (row in 0 until height) for (col in 0 until width) {
                assertEquals(f.lumaAt(col, row), bytes[row * yStride + col].toInt() and 0xFF)
            }
            for (row in 0 until height / 2) for (col in 0 until width / 2) {
                val at = ySize + row * cStride + col * cPixelStride
                val (_, uExpected, vExpected) = f.yuvAt(col * 2, row * 2)
                assertEquals("U", uExpected, bytes[at].toInt() and 0xFF)
                // With pixel stride 2 the reader takes V from inside the U buffer (NV12 order). Android's U buffer
                // is rowStride·(h/2 − 1) + w − 1 bytes, so it stops one byte short of the very last V sample; there
                // the reader gets the V buffer's first byte instead. OpenQuestCapture's files share this.
                val lastSample = row == height / 2 - 1 && col == width / 2 - 1
                if (!lastSample) assertEquals("V", vExpected, bytes[at + 1].toInt() and 0xFF)
            }
        }
    }

    @Test
    fun theCharacteristicsFileKeepsTheRawCamera2Values() {
        val dir = tmp.newFolder("rec")
        record(dir)
        val c = json(File(dir, "left_camera_characteristics.json"))
        // image_data_io.py load_camera_characteristics reads sensor.activeArraySize, intrinsics.fx…cy, pose.translation, pose.rotation.
        val active = c.obj("sensor").obj("activeArraySize")
        assertEquals(listOf(0, 0, 1280, 960), listOf("left", "top", "right", "bottom").map { active[it]!!.jsonPrimitive.int })
        val k = c.obj("intrinsics")
        assertEquals(870.5f, k["fx"]!!.jsonPrimitive.float, 0f)
        assertEquals(869.25f, k["fy"]!!.jsonPrimitive.float, 0f)
        assertEquals(641.5f, k["cx"]!!.jsonPrimitive.float, 0f)
        assertEquals(479.75f, k["cy"]!!.jsonPrimitive.float, 0f)
        val pose = c.obj("pose")
        assertEquals(listOf(-0.0321f, -0.0102f, -0.0598f), pose["translation"]!!.jsonArray.map { it.jsonPrimitive.float })
        assertEquals(listOf(0.9961947f, 0f, 0f, 0.0871557f), pose["rotation"]!!.jsonArray.map { it.jsonPrimitive.float })
        assertEquals("GYROSCOPE", pose["reference"]!!.jsonPrimitive.content)
        assertEquals(5, c["distortion"]!!.jsonArray.size)
        assertEquals("REALTIME", c.obj("sensor")["timestampSource"]!!.jsonPrimitive.content)
        assertEquals(0, c["cameraSource"]!!.jsonPrimitive.int)
        assertEquals(0, c["cameraPositionId"]!!.jsonPrimitive.int)
        val extra = c.obj("companionScan")
        assertTrue(extra["lensPoseReported"]!!.jsonPrimitive.boolean)
        assertEquals(width, extra.obj("stream")["width"]!!.jsonPrimitive.int)
    }

    @Test
    fun aMissingLensPoseStillWritesThreeAndFourValues() {
        val dir = tmp.newFolder("rec")
        record(dir, lensPose = false)
        val c = json(File(dir, "left_camera_characteristics.json"))
        // The reader indexes translation[2] before it checks the length.
        assertEquals(3, c.obj("pose")["translation"]!!.jsonArray.size)
        assertEquals(4, c.obj("pose")["rotation"]!!.jsonArray.size)
        assertFalse(c.obj("companionScan")["lensPoseReported"]!!.jsonPrimitive.boolean)
    }

    @Test
    fun thePoseCsvHasTheHeaderAndAFullRowPerSample() {
        val dir = tmp.newFolder("rec")
        record(dir)
        val lines = File(dir, "hmd_poses.csv").readLines()
        // OpenQuestCapture PoseLogger.cs HEADER; pose_interpolator.py reads unix_time, pos_*, rot_*.
        assertEquals("unix_time,ovr_timestamp,pos_x,pos_y,pos_z,rot_x,rot_y,rot_z,rot_w", lines.first())
        val rows = lines.drop(1).map { it.split(",") }
        assertTrue(rows.size > 60)
        var previous = Long.MIN_VALUE
        for (row in rows) {
            // read_csv(...).dropna() drops a row with any empty cell, so all nine must be numbers.
            assertEquals(9, row.size)
            row.forEach { cell -> assertTrue("'$cell' is a number", cell.toDoubleOrNull()?.isFinite() == true) }
            val unix = row[0].toLong()
            assertTrue("sorted", unix > previous)
            previous = unix
            val q = row.subList(5, 9).map { it.toDouble() }
            assertEquals("unit quaternion x, y, z, w", 1.0, q.sumOf { it * it }, 1e-6)
        }
        // Spatial SDK poses go in as they are (CoordinateConversions.spatialToMq3dreconHmd is the identity).
        val first = rows.first()
        assertEquals(baseUnixMs + 60, first[0].toLong())
        assertEquals(0.06, first[2].toDouble(), 1e-6)
        assertEquals(-0.03, first[4].toDouble(), 1e-6)
        assertEquals(45.06, first[1].toDouble(), 1e-6) // ovr_timestamp: the sample's XR time in seconds
    }

    @Test
    fun everyFrameHasPoseRowsWithinTheInterpolatorWindow() {
        val dir = tmp.newFolder("rec")
        record(dir)
        val poseTimes = File(dir, "hmd_poses.csv").readLines().drop(1).map { it.substringBefore(',').toLong() }
        val frameTimes = File(dir, "left_camera_raw").list()!!.map { it.removeSuffix(".yuv").toLong() }
        // pose_interpolator.py find_nearest_frames: a row at or before and a row at or after, each within 30.
        for (t in frameTimes) {
            assertTrue("a pose row at most 30 ms before $t", poseTimes.any { it <= t && t - it <= 30 })
            assertTrue("a pose row at most 30 ms after $t", poseTimes.any { it >= t && it - t <= 30 })
        }
    }

    @Test
    fun jsonNumbersAreNumbers() {
        val dir = tmp.newFolder("rec")
        record(dir)
        val format = json(File(dir, "left_camera_image_format.json"))
        val plane = format["planes"]!!.jsonArray.first().jsonObject
        assertFalse((plane["bufferSize"] as JsonPrimitive).isString)
        assertTrue(format["planes"] is JsonArray)
        val fx = json(File(dir, "left_camera_characteristics.json")).obj("intrinsics")["fx"] as JsonPrimitive
        assertFalse(fx.isString)
        assertEquals(870.5, fx.double, 0.0)
    }
}
