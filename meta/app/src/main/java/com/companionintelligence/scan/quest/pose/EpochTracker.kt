package com.companionintelligence.scan.quest.pose

/**
 * The keyframe `epoch`: which stretch of tracking a pose is in. The web client bumps it when its AR runtime
 * reports a discontinuity (src/ar/frame-epoch.ts), and the server treats frames of different epochs as possibly
 * not sharing one coordinate frame (server/register/session_priors.ts picks one epoch's poses).
 *
 * Here it is bumped when the activity hears a recenter (VrActivity.onRecenter), and when consecutive head poses
 * jump further than a head can move in one frame. The capture uses the STAGE reference space, which the SDK says
 * a recenter does not move, so a recenter bump may be unnecessary; it is kept because a missed discontinuity
 * corrupts a reconstruction and a spurious one only splits the frames.
 *
 * Epochs are looked up by time, so a frame taken just before a bump keeps the old epoch even if it is processed
 * after it.
 */
class EpochTracker {
    private val changes = ArrayList<Long>()

    @Synchronized
    fun bump(atRealtimeNs: Long) {
        val last = changes.lastOrNull()
        changes.add(if (last != null && atRealtimeNs <= last) last + 1 else atRealtimeNs)
    }

    /** The epoch a pose at [realtimeNs] belongs to: the number of bumps at or before it. */
    @Synchronized
    fun epochAt(realtimeNs: Long): Int = changes.count { it <= realtimeNs }

    @Synchronized
    fun current(): Int = changes.size

    companion object {
        /** Only samples less than this far apart are compared. */
        const val JUMP_WINDOW_NS = 100_000_000L
        const val JUMP_METRES = 0.25
        const val JUMP_DEGREES = 25.0

        /** True when two head poses [dtNs] apart differ by more than a head moves in that time. */
        fun isTrackingJump(previous: RigidPose, next: RigidPose, dtNs: Long): Boolean {
            if (dtNs <= 0 || dtNs > JUMP_WINDOW_NS) return false
            if ((next.position - previous.position).length() > JUMP_METRES) return true
            return Math.toDegrees(angleBetween(previous.rotation, next.rotation)) > JUMP_DEGREES
        }
    }
}
