package com.companionintelligence.scan.quest.capture

import com.companionintelligence.scan.quest.pose.RigidPose
import com.companionintelligence.scan.quest.pose.angleBetween

/**
 * Picks keyframes the way the web client's KeyframeStreamer does (src/capture/keyframes.ts): no more often than
 * [minIntervalNs], and only once the camera has moved [minTranslationM] or turned [minRotationDeg] since the last
 * keyframe. The defaults give at most two keyframes a second; a head turns and moves more than a phone held out
 * in front, so the thresholds are lower than the web client's 0.30 m and 20°.
 *
 * Thread-safe: the camera thread asks [intervalElapsed] before copying a frame, and the processing thread makes
 * the decision with the frame's own interpolated pose.
 */
class KeyframeSelector(
    private val minIntervalNs: Long = 500_000_000L,
    private val minTranslationM: Double = 0.08,
    private val minRotationDeg: Double = 8.0,
) {
    private var lastTimeNs: Long? = null
    private var lastPose: RigidPose? = null

    @Synchronized
    fun intervalElapsed(realtimeNs: Long): Boolean {
        val last = lastTimeNs ?: return true
        return realtimeNs - last >= minIntervalNs
    }

    /** True, and remembered as the last keyframe, when a frame at [realtimeNs] with camera pose [pose] qualifies. */
    @Synchronized
    fun take(realtimeNs: Long, pose: RigidPose): Boolean {
        if (!intervalElapsed(realtimeNs)) return false
        val previous = lastPose
        if (previous != null && !moved(previous, pose)) return false
        lastTimeNs = realtimeNs
        lastPose = pose
        return true
    }

    @Synchronized
    fun reset() {
        lastTimeNs = null
        lastPose = null
    }

    private fun moved(a: RigidPose, b: RigidPose): Boolean {
        if ((b.position - a.position).length() >= minTranslationM) return true
        return Math.toDegrees(angleBetween(a.rotation, b.rotation)) >= minRotationDeg
    }
}

/** Lets one frame through every [periodNs] (the local dataset records at a fixed rate, like OpenQuestCapture). */
class RateGate(private val periodNs: Long) {
    private var nextNs: Long? = null

    @Synchronized
    fun due(realtimeNs: Long): Boolean {
        val next = nextNs
        if (next != null && realtimeNs < next) return false
        nextNs = realtimeNs + periodNs
        return true
    }

    @Synchronized
    fun reset() {
        nextNs = null
    }
}
