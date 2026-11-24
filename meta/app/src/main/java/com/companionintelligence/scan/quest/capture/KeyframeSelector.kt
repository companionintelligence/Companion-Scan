package com.companionintelligence.scan.quest.capture

import com.companionintelligence.scan.quest.pose.RigidPose
import com.companionintelligence.scan.quest.pose.angleBetween

/**
 * Picks keyframes the way the web client's KeyframeStreamer does (src/capture/keyframes.ts), with its numbers: no more
 * often than [minIntervalNs] (1200 ms), and only once the camera has moved [minTranslationM] (0.30 m) or turned
 * [minRotationDeg] (20°) since the last keyframe, by the same rotation measure (angleBetween, 2·acos|q1·q2|).
 *
 * The headset used 500 ms, 0.08 m and 8° until wave 14, on the reasoning that a head moves more than a phone. That
 * argues for the opposite: a camera that moves more crosses the same thresholds sooner. At two keyframes a second a
 * capture reached the server's 2000-keyframe cap (server/main.ts MAX_KEYFRAMES_PER_SESSION) in under 17 minutes.
 *
 * Two web gates have no counterpart here. The web skips frames while its AR runtime says tracking is unusable; the
 * Spatial SDK gives the app no tracking state, only the viewer pose. The web scales a frame down to a 1280-pixel long
 * edge; the passthrough stream is chosen at 1280×960 (PassthroughCamera.WANTED_WIDTH), so a frame already is that, and a
 * camera that offers only a larger size sends it as it is, with the warning the panel shows.
 *
 * Thread-safe: the camera thread asks [intervalElapsed] before copying a frame, and the processing thread makes
 * the decision with the frame's own interpolated pose.
 */
class KeyframeSelector(
    private val minIntervalNs: Long = 1_200_000_000L,
    private val minTranslationM: Double = 0.30,
    private val minRotationDeg: Double = 20.0,
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
