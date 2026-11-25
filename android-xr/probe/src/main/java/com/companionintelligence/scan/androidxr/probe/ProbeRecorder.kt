package com.companionintelligence.scan.androidxr.probe

import java.io.BufferedWriter
import java.io.File
import java.io.IOException

/**
 * Writes one probe recording into [directory], laid out as [RecordingFormat] describes: `kf-NNNNN.jpg` and
 * `keyframes.jsonl` as each keyframe is taken, then `poses.csv`, `frames.csv` and `probe.json` when the run ends.
 *
 * The folder is the app's own external files folder, so `adb pull` reaches it, and nothing else does: the probe has no
 * network access (AndroidManifest.xml). The pictures are of a room, so a recording stays out of the repository.
 */
class ProbeRecorder(val directory: File) {
    private val keyframes: BufferedWriter

    var keyframesWritten = 0
        private set
    var bytesWritten = 0L
        private set

    init {
        if (!directory.isDirectory && !directory.mkdirs()) throw IOException("could not create $directory")
        keyframes = File(directory, KEYFRAMES).bufferedWriter()
    }

    /** Writes keyframe [index]: its JPEG, then its keyframes.jsonl line. */
    @Synchronized
    fun writeKeyframe(index: Int, jpeg: ByteArray, metaJson: String) {
        val name = RecordingFormat.keyframeFileName(index)
        File(directory, name).writeBytes(jpeg)
        keyframes.write(RecordingFormat.keyframeLine(metaJson, name, jpeg.size, System.currentTimeMillis()))
        keyframes.newLine()
        keyframes.flush()
        keyframesWritten++
        bytesWritten += jpeg.size
    }

    /** Closes keyframes.jsonl and writes the run's other files. */
    @Synchronized
    fun finish(
        poses: List<PoseRecord>,
        frames: List<FrameRecord>,
        timings: Map<Long, CaptureTiming>,
        keyframeOutcomes: Map<Long, String>,
        probeJson: String,
    ) {
        keyframes.close()
        File(directory, POSES).bufferedWriter().use { w ->
            w.write(RecordingFormat.POSES_HEADER)
            w.newLine()
            for (r in poses) {
                w.write(RecordingFormat.poseRow(r))
                w.newLine()
            }
        }
        val framePoses = FramePoses.join(poses, frames)
        File(directory, FRAMES).bufferedWriter().use { w ->
            w.write(RecordingFormat.FRAMES_HEADER)
            w.newLine()
            frames.forEachIndexed { i, r ->
                val outcome = keyframeOutcomes[r.cameraTimestampNs] ?: ""
                w.write(RecordingFormat.frameRow(r, timings[r.cameraTimestampNs], framePoses[i], outcome))
                w.newLine()
            }
        }
        File(directory, PROBE).writeText(probeJson)
    }

    companion object {
        const val KEYFRAMES = "keyframes.jsonl"
        const val POSES = "poses.csv"
        const val FRAMES = "frames.csv"
        const val PROBE = "probe.json"
    }
}
