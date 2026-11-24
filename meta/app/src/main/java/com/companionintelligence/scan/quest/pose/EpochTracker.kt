package com.companionintelligence.scan.quest.pose

/**
 * The keyframe `epoch`: which stretch of tracking a pose is in. The web client bumps it when its AR runtime
 * reports a discontinuity (src/ar/frame-epoch.ts), and the server treats frames of different epochs as possibly
 * not sharing one coordinate frame (server/register/session_priors.ts picks one epoch's poses).
 *
 * Here it is bumped when the activity hears a recenter (VrActivity.onRecenter), and when consecutive head poses
 * jump further than a head can move in one frame ([noteJump]). The capture uses the STAGE reference space, which the SDK
 * says a recenter does not move, so a recenter bump may be unnecessary; it is kept because a missed discontinuity
 * corrupts a reconstruction and a spurious one only splits the frames.
 *
 * This is not the web's FrameEpochTracker, and does not try to be: the headset has no tracking state, relocalization or
 * reset to report, only the viewer pose. What the two share is their numbers where the inputs allow:
 *
 * - [JUMP_METRES] is the web's FRAME_JUMP_TRANSLATION_M, 0.30 m.
 * - [REFRACTORY_NS] is the web's FRAME_JUMP_REFRACTORY_MS, 500 ms: a jump within it of the last bump is the same one.
 * - [JUMP_DEGREES] stays 25°, for a device reason. The web compares a pose with where its motion predicted the camera
 *   would be, and bumps on 8° of yaw that nothing explains. This compares raw head poses one display frame apart
 *   (72 to 120 Hz), with no prediction, so a fast head turn is all unexplained motion: 8° in one 72 Hz frame is 576°/s,
 *   which a quick turn of the head can reach, and 25° is 1800°/s, which it cannot.
 * - [JUMP_WINDOW_NS] stays 100 ms, for the same reason: samples are one display frame apart, and a longer gap (a stalled
 *   render loop) says nothing about how far the head could have moved.
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

    /**
     * A tracking jump at [atRealtimeNs]: bumps the epoch unless the last bump was less than [REFRACTORY_NS] before it, in
     * which case it is the same discontinuity still settling. Returns whether it bumped.
     */
    @Synchronized
    fun noteJump(atRealtimeNs: Long): Boolean {
        val last = changes.lastOrNull()
        if (last != null && atRealtimeNs - last < REFRACTORY_NS) return false
        bump(atRealtimeNs)
        return true
    }

    /** The epoch a pose at [realtimeNs] belongs to: the number of bumps at or before it. */
    @Synchronized
    fun epochAt(realtimeNs: Long): Int = changes.count { it <= realtimeNs }

    @Synchronized
    fun current(): Int = changes.size

    companion object {
        /** Only samples less than this far apart are compared (see the class comment for why it is not the web's). */
        const val JUMP_WINDOW_NS = 100_000_000L

        /** The web's FRAME_JUMP_TRANSLATION_M. */
        const val JUMP_METRES = 0.30

        /** A device number, not the web's 8° of yaw: see the class comment. */
        const val JUMP_DEGREES = 25.0

        /** The web's FRAME_JUMP_REFRACTORY_MS. */
        const val REFRACTORY_NS = 500_000_000L

        /** True when two head poses [dtNs] apart differ by more than a head moves in that time. */
        fun isTrackingJump(previous: RigidPose, next: RigidPose, dtNs: Long): Boolean {
            if (dtNs <= 0 || dtNs > JUMP_WINDOW_NS) return false
            if ((next.position - previous.position).length() > JUMP_METRES) return true
            return Math.toDegrees(angleBetween(previous.rotation, next.rotation)) > JUMP_DEGREES
        }
    }
}
