package com.companionintelligence.scan.quest.upload

import com.companionintelligence.scan.quest.pose.PinholeIntrinsics
import com.companionintelligence.scan.quest.pose.Quat
import com.companionintelligence.scan.quest.pose.RigidPose
import com.companionintelligence.scan.quest.pose.Vec3
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.double
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Test

class KeyframeMetaTest {
    private val intrinsics = PinholeIntrinsics(fx = 870.0, fy = 868.0, cx = 641.0, cy = 479.0, width = 1280, height = 960)

    private fun meta(index: Int = 7, pose: RigidPose = RigidPose(Vec3(0.1, 1.6, -0.3), Quat(0.0, 0.3826834, 0.0, 0.9238795))) =
        KeyframeMeta(
            index = index,
            timestampMs = 123456.789,
            capturedAtUnixMs = 1_763_900_000_123L,
            pose = pose,
            epoch = 0,
            intrinsics = intrinsics,
            sourceWidth = 1280,
            sourceHeight = 960,
        )

    private fun parse(text: String) = Json.parseToJsonElement(text) as JsonObject

    @Test
    fun hasTheWebClientsFieldsPlusFxFyCxCy() {
        val json = parse(meta().toJson())
        // src/capture/keyframes.ts sends index, timestamp, capturedAt, pose, epoch, intrinsics (arRunId only with a run).
        assertEquals(setOf("index", "timestamp", "capturedAt", "pose", "epoch", "intrinsics"), json.keys)
        val pose = json["pose"]!!.jsonObject
        assertEquals(setOf("position", "rotation"), pose.keys)
        assertEquals(setOf("x", "y", "z"), pose["position"]!!.jsonObject.keys)
        assertEquals(setOf("x", "y", "z", "w"), pose["rotation"]!!.jsonObject.keys)
        val k = json["intrinsics"]!!.jsonObject
        assertEquals(
            setOf("fovYDeg", "aspect", "width", "height", "sourceWidth", "sourceHeight", "fx", "fy", "cx", "cy"),
            k.keys,
        )
        assertEquals(1280, k["width"]!!.jsonPrimitive.int)
        assertEquals(960, k["height"]!!.jsonPrimitive.int)
        assertEquals(870.0, k["fx"]!!.jsonPrimitive.double, 0.0)
        assertEquals(intrinsics.fovYDeg, k["fovYDeg"]!!.jsonPrimitive.double, 1e-12)
        assertEquals(1_763_900_000_123L, json["capturedAt"]!!.jsonPrimitive.long)
        assertEquals(-0.3, pose["position"]!!.jsonObject["z"]!!.jsonPrimitive.double, 0.0)
    }

    @Test
    fun indexIsAnIntegerLiteral() {
        // server/main.ts: Number.isInteger(meta['index']).
        val index = parse(meta(index = 42).toJson())["index"]!!.jsonPrimitive
        assertFalse(index.isString)
        assertEquals("42", index.content)
    }

    @Test
    fun indexStopsAt1999() {
        meta(index = 0).toJson()
        meta(index = 1999).toJson()
        assertThrows(IllegalArgumentException::class.java) { meta(index = 2000).toJson() }
        assertThrows(IllegalArgumentException::class.java) { meta(index = -1).toJson() }
    }

    @Test
    fun nonFiniteNumbersAreRefused() {
        assertThrows(IllegalArgumentException::class.java) {
            meta(pose = RigidPose(Vec3(Double.NaN, 0.0, 0.0), Quat.IDENTITY)).toJson()
        }
    }
}
