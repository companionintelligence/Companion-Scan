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

    @Test
    fun atMostTwoASecondAndOnlyAfterMoving() {
        val s = KeyframeSelector()
        assertTrue("the first frame", s.take(0, still))
        assertFalse("too soon", s.intervalElapsed(499 * ms))
        assertFalse("too soon, even having moved", s.take(499 * ms, RigidPose(Vec3(1.0, 1.6, 0.0), Quat.IDENTITY)))
        assertTrue(s.intervalElapsed(500 * ms))
        assertFalse("not moved", s.take(600 * ms, still))
        assertTrue("moved 10 cm", s.take(700 * ms, RigidPose(Vec3(0.1, 1.6, 0.0), Quat.IDENTITY)))
        assertTrue("turned 10°", s.take(1_300 * ms, RigidPose(Vec3(0.1, 1.6, 0.0), Quat.fromAxisAngle(Vec3.Y, Math.toRadians(10.0)))))
        s.reset()
        assertTrue("after a reset", s.take(1_301 * ms, still))
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
