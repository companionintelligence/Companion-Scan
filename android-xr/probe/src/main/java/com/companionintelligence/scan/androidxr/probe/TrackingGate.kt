package com.companionintelligence.scan.androidxr.probe

import com.companionintelligence.scan.quest.pose.EpochTracker
import com.companionintelligence.scan.quest.pose.RigidPose

/**
 * Which ARCore for Jetpack XR samples go into the pose buffer, and when the keyframe epoch moves.
 *
 * Only TRACKING samples count:
 * - the device state starts as an identity pose marked STOPPED (androidx.xr.arcore 1.0.0, ArDevice and OpenXrDevice);
 * - while tracking is lost, the library keeps handing out the last pose it had (OpenXrDevice: `pose ?: devicePose`).
 *
 * Neither may be interpolated into a frame's pose. When tracking comes back after being lost, the session's frame may have
 * moved, so the epoch is bumped, as the web client does on a tracking reset (src/ar/frame-epoch.ts). A jump between two
 * accepted samples faster than a head moves is a discontinuity too: the Quest's rule, EpochTracker.isTrackingJump.
 */
class TrackingGate(private val epochs: EpochTracker) {

    enum class Verdict {
        /** Tracked; into the buffer. */
        ACCEPTED,

        /** Tracked again after a loss; into the buffer, and the epoch was bumped. */
        ACCEPTED_AFTER_LOSS,

        /** Tracked, but too far from the last accepted sample; into the buffer, and the epoch was bumped. */
        ACCEPTED_AFTER_JUMP,

        /** Not tracking, or not a usable pose; kept out of the buffer. */
        REJECTED,
    }

    private var trackedBefore = false
    private var lostSinceLastAccepted = false
    private var lastPose: RigidPose? = null
    private var lastNs = 0L

    @Synchronized
    fun offer(tracking: Boolean, pose: RigidPose, atRealtimeNs: Long): Verdict {
        if (!tracking || !pose.isFinite() || pose.rotation.norm() < 0.5) {
            if (trackedBefore) lostSinceLastAccepted = true
            return Verdict.REJECTED
        }
        val verdict = when {
            lostSinceLastAccepted -> {
                epochs.bump(atRealtimeNs)
                Verdict.ACCEPTED_AFTER_LOSS
            }
            isJump(pose, atRealtimeNs) && epochs.noteJump(atRealtimeNs) -> Verdict.ACCEPTED_AFTER_JUMP
            else -> Verdict.ACCEPTED
        }
        trackedBefore = true
        lostSinceLastAccepted = false
        lastPose = pose
        lastNs = atRealtimeNs
        return verdict
    }

    private fun isJump(pose: RigidPose, atRealtimeNs: Long): Boolean {
        val previous = lastPose ?: return false
        return EpochTracker.isTrackingJump(previous, pose, atRealtimeNs - lastNs)
    }
}
