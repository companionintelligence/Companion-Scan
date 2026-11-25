package com.companionintelligence.scan.androidxr.probe

import com.companionintelligence.scan.quest.pose.PinholeIntrinsics
import com.companionintelligence.scan.quest.pose.PoseTimeSource
import com.companionintelligence.scan.quest.pose.Quat
import com.companionintelligence.scan.quest.pose.RigidPose
import com.companionintelligence.scan.quest.pose.Vec3
import com.companionintelligence.scan.quest.upload.KeyframeMeta
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

class RecordingFormatTest {

    /** The server's keyframe writer, read from the repository (the probe's tests run in android-xr/probe). */
    private val serverKeyframes: String by lazy { File("../../server/wp-a-keyframes.ts").readText() }

    @Test
    fun keyframeFilesAreNamedAsTheServerNamesThem() {
        assertEquals("kf-00000.jpg", RecordingFormat.keyframeFileName(0))
        assertEquals("kf-00042.jpg", RecordingFormat.keyframeFileName(42))
        assertEquals("kf-01999.jpg", RecordingFormat.keyframeFileName(KeyframeMeta.MAX_INDEX))
        for (i in listOf(0, 7, 1999)) assertTrue(RecordingFormat.KEYFRAME_FILE.matches(RecordingFormat.keyframeFileName(i)))
        assertFalse(RecordingFormat.KEYFRAME_FILE.matches("kf-0001.jpg"))
        assertTrue(
            "server/wp-a-keyframes.ts still names its files /^kf-\\d{5}\\.jpg$/",
            serverKeyframes.contains("export const KEYFRAME_FILE_RE = /^kf-\\d{5}\\.jpg\$/"),
        )
    }

    @Test(expected = IllegalArgumentException::class)
    fun anIndexPastTheServersCapIsRefused() {
        RecordingFormat.keyframeFileName(KeyframeMeta.MAX_INDEX + 1)
    }

    @Test
    fun aKeyframesLineIsTheQuestMetaThenWhatTheServerAppends() {
        assertTrue(
            "server/wp-a-keyframes.ts still appends file, bytes and receivedAt to the meta",
            serverKeyframes.contains("JSON.stringify({ ...frame.meta, file: frame.name, bytes: frame.bytes.byteLength, receivedAt: Date.now() })"),
        )
        val meta = KeyframeMeta(
            index = 3,
            timestampMs = 123_456.789,
            capturedAtUnixMs = 1_763_900_000_123L,
            pose = RigidPose(Vec3(0.1, 1.6, -0.4), Quat.fromAxisAngle(Vec3.Y, 0.3)),
            epoch = 1,
            intrinsics = PinholeIntrinsics(1440.0, 1440.0, 960.0, 540.0, 1920, 1080),
            sourceWidth = 1920,
            sourceHeight = 1080,
        ).toJson()
        val line = RecordingFormat.keyframeLine(meta, "kf-00003.jpg", 204_800, 1_763_900_000_456L)
        val parsed = Json.parseToJsonElement(line).jsonObject
        val metaKeys = Json.parseToJsonElement(meta).jsonObject.keys.toList()
        assertEquals(listOf("index", "timestamp", "capturedAt", "pose", "epoch", "intrinsics"), metaKeys)
        assertEquals(metaKeys + listOf("file", "bytes", "receivedAt"), parsed.keys.toList())
        assertEquals(Json.parseToJsonElement(meta).jsonObject["pose"], parsed["pose"])
        assertEquals(3, parsed["index"]!!.jsonPrimitive.int)
        assertEquals("kf-00003.jpg", parsed["file"]!!.jsonPrimitive.content)
        assertEquals(204_800, parsed["bytes"]!!.jsonPrimitive.int)
        assertEquals(1_763_900_000_456L, parsed["receivedAt"]!!.jsonPrimitive.long)
        assertFalse("one line", line.contains('\n'))
    }

    @Test(expected = IllegalArgumentException::class)
    fun aLineNeedsAKeyframeFileName() {
        RecordingFormat.keyframeLine("{}", "frame.jpg", 1, 0)
    }

    @Test
    fun csvRowsHaveTheirHeadersColumns() {
        val pose = PoseRecord(
            sequence = 0, poseRealtimeNs = 1, readRealtimeNs = 2, ageNs = 3, uncertaintyNs = 4, markSinceFirstNs = 5,
            source = PoseTimeSource.XR_UPDATE_TIME, tracking = "TRACKING", verdict = TrackingGate.Verdict.ACCEPTED, epoch = 0,
            pose = RigidPose(Vec3(1.0, 2.0, 3.0), Quat.IDENTITY),
        )
        val columns = RecordingFormat.POSES_HEADER.split(',').size
        assertEquals(columns, RecordingFormat.poseRow(pose).split(',').size)
        assertTrue(RecordingFormat.poseRow(pose).startsWith("0,1,2,3,4,5,XR_UPDATE_TIME,TRACKING,ACCEPTED,0,1.000000000,"))

        val frame = FrameRecord(cameraTimestampNs = 10, frameRealtimeNs = 10, arrivalRealtimeNs = 45_000_010)
        val frameColumns = RecordingFormat.FRAMES_HEADER.split(',').size
        assertEquals(17, frameColumns)
        assertEquals("10,10,45000010" + ",".repeat(frameColumns - 3), RecordingFormat.frameRow(frame, null, null, ""))
        val timing = CaptureTiming(10, exposureNs = 8_000_000, rollingShutterSkewNs = 16_000_000, readoutTimestampNs = 8_000_010, frameDurationNs = 33_333_333)
        val framePose = FramePoses.FramePose(RigidPose(Vec3(1.0, 2.0, 3.0), Quat.IDENTITY), beforeNs = 5_000_000, afterNs = 17_000_000)
        val row = RecordingFormat.frameRow(frame, timing, framePose, "kf-00000.jpg")
        assertEquals(frameColumns, row.split(',').size)
        assertEquals(
            "10,10,45000010,8000000,16000000,8000010,33333333,5000000,17000000," +
                "1.000000000,2.000000000,3.000000000,0.000000000,0.000000000,0.000000000,1.000000000,kf-00000.jpg",
            row,
        )
        // A frame between samples too far apart has its gaps and no pose.
        val noPose = RecordingFormat.frameRow(frame, null, FramePoses.FramePose(null, 70_000_000, 90_000_000), "")
        assertEquals("10,10,45000010,,,,,70000000,90000000" + ",".repeat(8), noPose)
        // A reason with a comma is quoted, so the row keeps its columns.
        assertTrue(RecordingFormat.frameRow(frame, null, null, "not written: no pose (a, b)").endsWith(",\"not written: no pose (a, b)\""))
    }
}
