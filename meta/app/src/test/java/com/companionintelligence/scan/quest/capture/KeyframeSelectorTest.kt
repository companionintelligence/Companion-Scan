package com.companionintelligence.scan.quest.capture

import com.companionintelligence.scan.quest.pose.Quat
import com.companionintelligence.scan.quest.pose.RigidPose
import com.companionintelligence.scan.quest.pose.Vec3
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class KeyframeSelectorTest {
    private val ms = 1_000_000L
    private val still = RigidPose(Vec3(0.0, 1.6, 0.0), Quat.IDENTITY)

    /** The web client's numbers (src/capture/keyframes.ts DEFAULTS): 1200 ms, 0.30 m, 20°. */
    @Test
    fun theWebClientsIntervalAndMovement() {
        val s = KeyframeSelector()
        assertTrue("the first frame", s.take(0, still))
        assertFalse("too soon", s.intervalElapsed(1_199 * ms))
        assertFalse("too soon, even having moved", s.take(1_199 * ms, RigidPose(Vec3(1.0, 1.6, 0.0), Quat.IDENTITY)))
        assertTrue(s.intervalElapsed(1_200 * ms))
        assertFalse("not moved", s.take(1_300 * ms, still))
        assertFalse("moved 29 cm", s.take(1_400 * ms, RigidPose(Vec3(0.29, 1.6, 0.0), Quat.IDENTITY)))
        assertTrue("moved 30 cm", s.take(1_500 * ms, RigidPose(Vec3(0.30, 1.6, 0.0), Quat.IDENTITY)))
        val turned = { deg: Double -> RigidPose(Vec3(0.30, 1.6, 0.0), Quat.fromAxisAngle(Vec3.Y, Math.toRadians(deg))) }
        assertFalse("turned 19°", s.take(2_800 * ms, turned(19.0)))
        assertTrue("turned 20.5°", s.take(2_900 * ms, turned(20.5)))
        s.reset()
        assertTrue("after a reset", s.take(2_901 * ms, still))
    }

    @Test
    fun aCaptureOfAQuarterHourStaysUnderTheServersKeyframeCap() {
        // A head always moves, so every interval is taken: one keyframe per 1.2 s is 750 in 15 minutes, under the
        // server's 2000 (server/main.ts MAX_KEYFRAMES_PER_SESSION). At the old 500 ms it was 1800.
        val s = KeyframeSelector()
        var taken = 0
        var t = 0L
        while (t < 15 * 60 * 1_000 * ms) {
            if (s.take(t, RigidPose(Vec3(t / 1e9, 1.6, 0.0), Quat.IDENTITY))) taken++
            t += 33 * ms
        }
        assertTrue("$taken keyframes", taken in 700..760)
    }

    @Test
    fun rateGateLetsOneFramePerPeriodThrough() {
        val gate = RateGate(333 * ms)
        assertTrue(gate.due(0))
        assertFalse(gate.due(100 * ms))
        assertTrue(gate.due(333 * ms))
        assertFalse(gate.due(665 * ms))
        assertTrue(gate.due(666 * ms))
    }
}
