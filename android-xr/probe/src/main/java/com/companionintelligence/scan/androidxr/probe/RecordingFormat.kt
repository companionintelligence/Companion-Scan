package com.companionintelligence.scan.androidxr.probe

import com.companionintelligence.scan.quest.upload.KeyframeMeta
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import java.util.Locale

/**
 * The names and lines of a probe recording. Pure Kotlin: RecordingFormatTest checks them against the server's own shapes.
 *
 * A recording is laid out the way the server lays out a capture session (server/wp-a-keyframes.ts, `writeKeyframe`):
 * `kf-NNNNN.jpg` files and a `keyframes.jsonl` with one line per keyframe. Each line is the Quest app's keyframe meta
 * (KeyframeMeta.toJson, the body the Quest uploader sends), followed by `file`, `bytes` and `receivedAt`, as the server
 * appends them. Beside them the probe writes `poses.csv`, `frames.csv` and `probe.json`, which a session does not have.
 */
object RecordingFormat {

    /** server/wp-a-keyframes.ts KEYFRAME_FILE_RE. */
    val KEYFRAME_FILE = Regex("^kf-\\d{5}\\.jpg$")

    fun keyframeFileName(index: Int): String {
        require(index in 0..KeyframeMeta.MAX_INDEX) { "index must be 0…${KeyframeMeta.MAX_INDEX}" }
        return String.format(Locale.ROOT, "kf-%05d.jpg", index)
    }

    /** One keyframes.jsonl line: `{ ...meta, file, bytes, receivedAt }`, the server's order. */
    fun keyframeLine(metaJson: String, file: String, bytes: Int, receivedAtUnixMs: Long): String {
        require(KEYFRAME_FILE.matches(file)) { "not a keyframe file name: $file" }
        val meta = Json.parseToJsonElement(metaJson).jsonObject
        val line = LinkedHashMap(meta)
        line["file"] = JsonPrimitive(file)
        line["bytes"] = JsonPrimitive(bytes)
        line["receivedAt"] = JsonPrimitive(receivedAtUnixMs)
        return JsonObject(line).toString()
    }

    const val POSES_HEADER =
        "sequence,pose_realtime_ns,read_realtime_ns,age_ns,uncertainty_ns,mark_since_first_ns,stamp,tracking,verdict,epoch," +
            "px,py,pz,qx,qy,qz,qw"

    fun poseRow(r: PoseRecord): String = listOf(
        r.sequence, r.poseRealtimeNs, r.readRealtimeNs, r.ageNs, r.uncertaintyNs, r.markSinceFirstNs,
        r.source.name, r.tracking, r.verdict.name, r.epoch,
        num(r.pose.position.x), num(r.pose.position.y), num(r.pose.position.z),
        num(r.pose.rotation.x), num(r.pose.rotation.y), num(r.pose.rotation.z), num(r.pose.rotation.w),
    ).joinToString(",")

    const val FRAMES_HEADER =
        "camera_timestamp_ns,frame_realtime_ns,arrival_realtime_ns,exposure_ns,rolling_shutter_skew_ns,readout_timestamp_ns," +
            "frame_duration_ns,pose_before_ns,pose_after_ns,px,py,pz,qx,qy,qz,qw,keyframe"

    /**
     * One frame: its times, its capture result, the device pose at its timestamp on the same clock ([FramePoses], empty
     * when there is none), and [keyframe]: the file name, why the frame was wanted and not kept, or empty.
     */
    fun frameRow(r: FrameRecord, timing: CaptureTiming?, pose: FramePoses.FramePose?, keyframe: String): String {
        val p = pose?.pose
        return listOf(
            r.cameraTimestampNs, r.frameRealtimeNs, r.arrivalRealtimeNs,
            timing?.exposureNs ?: "", timing?.rollingShutterSkewNs ?: "", timing?.readoutTimestampNs ?: "",
            timing?.frameDurationNs ?: "",
            pose?.beforeNs ?: "", pose?.afterNs ?: "",
            p?.position?.x?.let(::num) ?: "", p?.position?.y?.let(::num) ?: "", p?.position?.z?.let(::num) ?: "",
            p?.rotation?.x?.let(::num) ?: "", p?.rotation?.y?.let(::num) ?: "", p?.rotation?.z?.let(::num) ?: "",
            p?.rotation?.w?.let(::num) ?: "",
            csvText(keyframe),
        ).joinToString(",")
    }

    private fun num(v: Double) = String.format(Locale.ROOT, "%.9f", v)

    private fun csvText(text: String) =
        if (text.any { it == ',' || it == '"' || it == '\n' }) "\"" + text.replace("\"", "\"\"") + "\"" else text
}
