package com.companionintelligence.scan.quest.upload

import com.companionintelligence.scan.quest.pose.PinholeIntrinsics
import com.companionintelligence.scan.quest.pose.RigidPose
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonObject

/**
 * The `meta` field of POST /sessions/:id/keyframes, in the shape the web client sends (src/capture/keyframes.ts,
 * `_captureKeyframe`): index, timestamp, capturedAt, pose { position, rotation }, epoch and intrinsics
 * { fovYDeg, aspect, width, height, sourceWidth, sourceHeight }. The server stores the record as it is and adds
 * file, bytes and receivedAt (server/wp-a-keyframes.ts).
 *
 * Two deliberate differences, both within what the server reads:
 * - `intrinsics` also carries fx, fy, cx, cy. The splat dataset builder prefers them to fovYDeg and rescales them
 *   from width × height to the JPEG's real size (server/splat/splat_train_dataset.ts, `deriveIntrinsics`), so
 *   width and height here must be the grid fx … cy are in: the uploaded JPEG's.
 * - `timestamp` is the frame's capture time in milliseconds on the headset's boot clock (the web client sends its
 *   own frame clock). Only ordering is meaningful across devices.
 *
 * Nothing from the on-device vision model goes in here.
 */
data class KeyframeMeta(
    val index: Int,
    val timestampMs: Double,
    val capturedAtUnixMs: Long,
    /** Camera-to-world, Companion Scan convention (CoordinateConversions.keyframePose). */
    val pose: RigidPose,
    /** Which stretch of tracking the pose is in; bumped when the scene frame may have moved (a recenter or a jump). */
    val epoch: Int,
    /** In the uploaded JPEG's pixel grid. */
    val intrinsics: PinholeIntrinsics,
    val sourceWidth: Int,
    val sourceHeight: Int,
) {
    fun toJson(): String {
        require(index in 0..MAX_INDEX) { "index must be 0…$MAX_INDEX (server/main.ts MAX_KEYFRAMES_PER_SESSION)" }
        require(epoch >= 0) { "epoch must be non-negative" }
        require(pose.isFinite()) { "pose must be finite" }
        val numbers = listOf(timestampMs, intrinsics.fx, intrinsics.fy, intrinsics.cx, intrinsics.cy, intrinsics.fovYDeg)
        require(numbers.all { it.isFinite() }) { "timestamp and intrinsics must be finite" }
        return buildJsonObject {
            put("index", index)
            put("timestamp", timestampMs)
            put("capturedAt", capturedAtUnixMs)
            putJsonObject("pose") {
                putJsonObject("position") {
                    put("x", pose.position.x)
                    put("y", pose.position.y)
                    put("z", pose.position.z)
                }
                putJsonObject("rotation") {
                    put("x", pose.rotation.x)
                    put("y", pose.rotation.y)
                    put("z", pose.rotation.z)
                    put("w", pose.rotation.w)
                }
            }
            put("epoch", epoch)
            putJsonObject("intrinsics") {
                put("fovYDeg", intrinsics.fovYDeg)
                put("aspect", intrinsics.aspect)
                put("width", intrinsics.width)
                put("height", intrinsics.height)
                put("sourceWidth", sourceWidth)
                put("sourceHeight", sourceHeight)
                put("fx", intrinsics.fx)
                put("fy", intrinsics.fy)
                put("cx", intrinsics.cx)
                put("cy", intrinsics.cy)
            }
        }.toString()
    }

    companion object {
        /** server/main.ts: MAX_KEYFRAMES_PER_SESSION = 2000, index 0…1999. */
        const val MAX_INDEX = 1999
    }
}
