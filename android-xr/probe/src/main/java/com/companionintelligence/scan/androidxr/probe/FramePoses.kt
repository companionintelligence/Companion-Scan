package com.companionintelligence.scan.androidxr.probe

import com.companionintelligence.scan.quest.pose.PoseRingBuffer
import com.companionintelligence.scan.quest.pose.RigidPose

/**
 * The device pose at every camera frame's time, joined after a run from its tracked pose samples: the pose columns of
 * frames.csv. The keyframes are paired live (PosePairing); this pairs every frame the same way, through the Quest's ring
 * buffer and its interpolation, so a calibration has a pose for each frame. Pure Kotlin: FramePosesTest runs it.
 */
object FramePoses {

    /**
     * @property pose the interpolated device pose, or null when no tracked samples lie within [join]'s gap either side
     * @property beforeNs how long before the frame the last tracked sample was, or null when there is none
     * @property afterNs how long after the frame the next tracked sample was, or null when there is none
     */
    data class FramePose(val pose: RigidPose?, val beforeNs: Long?, val afterNs: Long?)

    fun join(poses: List<PoseRecord>, frames: List<FrameRecord>, maxGapNs: Long = 50_000_000L): List<FramePose> {
        val tracked = poses.filter { it.verdict != TrackingGate.Verdict.REJECTED }.sortedBy { it.poseRealtimeNs }
        val buffer = PoseRingBuffer(maxOf(2, tracked.size))
        for (r in tracked) buffer.add(r.poseRealtimeNs, r.pose, null, r.source)
        val times = tracked.map { it.poseRealtimeNs }
        return frames.map { frame ->
            val t = frame.frameRealtimeNs
            val next = firstAfter(times, t)
            FramePose(
                pose = buffer.interpolate(t, maxGapNs),
                beforeNs = if (next > 0) t - times[next - 1] else null,
                afterNs = if (next < times.size) times[next] - t else null,
            )
        }
    }

    /** The index of the first time after [t] in the sorted [times], or times.size when none is. */
    private fun firstAfter(times: List<Long>, t: Long): Int {
        var lo = 0
        var hi = times.size
        while (lo < hi) {
            val mid = (lo + hi) ushr 1
            if (times[mid] <= t) lo = mid + 1 else hi = mid
        }
        return lo
    }
}
