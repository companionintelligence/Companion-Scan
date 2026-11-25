package com.companionintelligence.scan.androidxr.probe

import com.companionintelligence.scan.quest.pose.PoseRingBuffer
import com.companionintelligence.scan.quest.pose.RigidPose

/**
 * The device pose at a camera frame's time: waits, on a worker thread, until the pose buffer holds a sample at or after
 * the frame, then interpolates between the samples either side (PoseRingBuffer.interpolate: position linearly, rotation
 * by slerp, never across a gap longer than [maxGapNs]). The Quest's CaptureController does the same (awaitHeadPose).
 *
 * Jetpack XR's updates come about every 20 ms plus their own work (the library's fixed delay), and a sample reaches the
 * probe after that delay, so [maxWaitNs] leaves room for several.
 */
class PosePairing(
    private val poses: PoseRingBuffer,
    private val maxWaitNs: Long = 150_000_000L,
    private val maxGapNs: Long = 50_000_000L,
    private val nanoTime: () -> Long = System::nanoTime,
    private val pause: () -> Unit = { Thread.sleep(4) },
) {
    sealed class Result {
        data class Paired(val pose: RigidPose) : Result()

        /** No tracked sample at or after the frame arrived within the wait. */
        data object NoLaterSample : Result()

        /** The frame is older than the buffer, or the samples either side are more than [maxGapNs] apart. */
        data object NoSampleEitherSide : Result()

        /** The worker was interrupted while waiting. */
        data object Interrupted : Result()
    }

    fun poseAt(frameRealtimeNs: Long): Result {
        val deadline = nanoTime() + maxWaitNs
        while (true) {
            val newest = poses.newestTimeNs()
            if (newest != null && newest >= frameRealtimeNs) {
                val pose = poses.interpolate(frameRealtimeNs, maxGapNs)
                return if (pose != null) Result.Paired(pose) else Result.NoSampleEitherSide
            }
            if (nanoTime() > deadline) return Result.NoLaterSample
            try {
                pause()
            } catch (_: InterruptedException) {
                Thread.currentThread().interrupt()
                return Result.Interrupted
            }
        }
    }
}
