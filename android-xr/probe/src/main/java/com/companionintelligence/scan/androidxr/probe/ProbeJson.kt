package com.companionintelligence.scan.androidxr.probe

import com.companionintelligence.scan.quest.pose.PinholeIntrinsics
import com.companionintelligence.scan.quest.pose.PixelRect
import com.companionintelligence.scan.quest.pose.RigidPose
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonObject

/** The parts of probe.json that come from pure data. Pure Kotlin, like the facts it writes. */
object ProbeJson {

    fun camera(f: CameraFacts): JsonObject = buildJsonObject {
        put("id", f.id)
        put("facing", f.facing.name)
        put("hardwareLevel", f.hardwareLevel)
        put("capabilities", JsonArray(f.capabilities.map(::JsonPrimitive)))
        put("timestampSource", f.timestampSource.name)
        put("readoutTimestamp", f.readoutTimestamp?.let(::JsonPrimitive) ?: JsonNull)
        put("lensPoseTranslation", floats(f.lensPoseTranslation))
        put("lensPoseRotation", floats(f.lensPoseRotation))
        put("lensPoseReference", f.lensPoseReference?.let(::JsonPrimitive) ?: JsonNull)
        put("intrinsicCalibration", floats(f.intrinsicCalibration))
        put("distortion", floats(f.distortion))
        put("focalLengthsMm", floats(f.focalLengthsMm))
        put("physicalSizeMm", f.physicalSizeMm?.let { JsonArray(listOf(JsonPrimitive(it.first), JsonPrimitive(it.second))) } ?: JsonNull)
        put("pixelArraySize", f.pixelArraySize?.let(::size) ?: JsonNull)
        put("preCorrectionActiveArray", f.preCorrectionActiveArray?.let(::rect) ?: JsonNull)
        put("activeArray", f.activeArray?.let(::rect) ?: JsonNull)
        put("sensorOrientation", f.sensorOrientation?.let(::JsonPrimitive) ?: JsonNull)
        put("yuvSizes", JsonArray(f.yuvSizes.map(::size)))
        put("aeTargetFpsRanges", JsonArray(f.aeTargetFpsRanges.map { JsonArray(listOf(JsonPrimitive(it.first), JsonPrimitive(it.second))) }))
        put("stream", size(f.stream))
    }

    /** Where the keyframes' intrinsics came from, and what they are; null when the probe had none and wrote no keyframes. */
    fun intrinsics(s: CameraFacts.StreamIntrinsics?): JsonElement {
        if (s == null) return JsonNull
        return buildJsonObject {
            put("source", s.source)
            put("pinhole", pinhole(s.intrinsics))
            s.estimate?.let { e ->
                putJsonObject("estimate") {
                    put("focalPxFromWidth", e.focalPxFromWidth)
                    put("focalPxFromHeight", e.focalPxFromHeight)
                    put("squarePixels", e.squarePixels)
                    put("note", "takes the width's pixel pitch for both axes; only a calibration settles it")
                }
            }
        }
    }

    /** The camera in the device frame, and where that came from. */
    fun cameraInDevice(f: CameraFacts): JsonObject = buildJsonObject {
        put(
            "source",
            if (f.hasLensPose) {
                "LENS_POSE_TRANSLATION and LENS_POSE_ROTATION, under assumption X1 (AndroidXrConversions.kt)"
            } else {
                "none reported, so the keyframe pose is the device pose"
            },
        )
        put("headFromCameraSpatialConvention", pose(f.headFromCamera))
    }

    fun pinhole(i: PinholeIntrinsics): JsonObject = buildJsonObject {
        put("fx", i.fx)
        put("fy", i.fy)
        put("cx", i.cx)
        put("cy", i.cy)
        put("width", i.width)
        put("height", i.height)
        put("fovYDeg", i.fovYDeg)
        put("fovXDeg", 2 * Math.toDegrees(kotlin.math.atan(i.width / (2 * i.fx))))
    }

    fun pose(p: RigidPose): JsonObject = buildJsonObject {
        putJsonObject("position") {
            put("x", p.position.x)
            put("y", p.position.y)
            put("z", p.position.z)
        }
        putJsonObject("rotation") {
            put("x", p.rotation.x)
            put("y", p.rotation.y)
            put("z", p.rotation.z)
            put("w", p.rotation.w)
        }
    }

    fun poseSummary(s: ProbeStats.PoseSummary): JsonObject = buildJsonObject {
        put("updates", s.updates)
        put("tracked", s.tracked)
        put("trackedRateHz", num(s.trackedRateHz))
        put("ageMsMedian", num(s.ageMsMedian))
        put("ageMsP95", num(s.ageMsP95))
        put("ageMsMax", num(s.ageMsMax))
        put("uncertaintyUsMax", num(s.uncertaintyUsMax))
        put("clockDriftUs", num(s.clockDriftUs))
        put("clockDriftPpm", num(s.clockDriftPpm))
        put("clockResidualUsMax", num(s.clockResidualUsMax))
        put("epochBumps", s.epochBumps)
    }

    fun frameSummary(s: ProbeStats.FrameSummary): JsonObject = buildJsonObject {
        put("frames", s.frames)
        put("rateHz", num(s.rateHz))
        put("latencyMsMin", num(s.latencyMsMin))
        put("latencyMsMedian", num(s.latencyMsMedian))
        put("latencyMsMax", num(s.latencyMsMax))
        put("cameraClockPlausible", s.cameraClockPlausible)
    }

    private fun num(v: Double?): JsonElement = v?.let(::JsonPrimitive) ?: JsonNull

    private fun floats(values: FloatArray?): JsonElement = values?.let { a -> JsonArray(a.map(::JsonPrimitive)) } ?: JsonNull

    private fun size(s: PixelSize) = JsonArray(listOf(JsonPrimitive(s.width), JsonPrimitive(s.height)))

    private fun rect(r: PixelRect) =
        JsonArray(listOf(JsonPrimitive(r.left), JsonPrimitive(r.top), JsonPrimitive(r.right), JsonPrimitive(r.bottom)))
}
