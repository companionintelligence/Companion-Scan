package com.companionintelligence.scan.androidxr.probe

import com.companionintelligence.scan.androidxr.probe.TrackingGate.Verdict
import com.companionintelligence.scan.quest.pose.EpochTracker
import com.companionintelligence.scan.quest.pose.Quat
import com.companionintelligence.scan.quest.pose.RigidPose
import com.companionintelligence.scan.quest.pose.Vec3
import org.junit.Assert.assertEquals
import org.junit.Test

class TrackingGateTest {
    private val ms = 1_000_000L
    private fun at(x: Double) = RigidPose(Vec3(x, 1.6, 0.0), Quat.IDENTITY)

    @Test
    fun theStartingIdentityPoseIsKeptOut() {
        val epochs = EpochTracker()
        val gate = TrackingGate(epochs)
        // ArDevice starts as Pose() and STOPPED, until the runtime reports tracking.
        assertEquals(Verdict.REJECTED, gate.offer(false, RigidPose.IDENTITY, 0))
        assertEquals(Verdict.REJECTED, gate.offer(false, RigidPose.IDENTITY, 22 * ms))
        // The first tracked pose is no discontinuity, however far it is from the identity.
        assertEquals(Verdict.ACCEPTED, gate.offer(true, at(0.8), 44 * ms))
        assertEquals(0, epochs.current())
    }

    @Test
    fun trackingThatComesBackStartsANewEpoch() {
        val epochs = EpochTracker()
        val gate = TrackingGate(epochs)
        assertEquals(Verdict.ACCEPTED, gate.offer(true, at(0.0), 0))
        assertEquals(Verdict.ACCEPTED, gate.offer(true, at(0.01), 22 * ms))
        // Lost: the library hands out the last pose it had, frozen.
        assertEquals(Verdict.REJECTED, gate.offer(false, at(0.01), 44 * ms))
        assertEquals(Verdict.REJECTED, gate.offer(false, at(0.01), 66 * ms))
        assertEquals(Verdict.ACCEPTED_AFTER_LOSS, gate.offer(true, at(0.02), 88 * ms))
        assertEquals(1, epochs.current())
        assertEquals("a frame before the loss keeps epoch 0", 0, epochs.epochAt(80 * ms))
        assertEquals(1, epochs.epochAt(88 * ms))
        assertEquals(Verdict.ACCEPTED, gate.offer(true, at(0.03), 110 * ms))
        assertEquals(1, epochs.current())
    }

    @Test
    fun aJumpNoHeadCouldMakeStartsANewEpochOnce() {
        val epochs = EpochTracker()
        val gate = TrackingGate(epochs)
        gate.offer(true, at(0.0), 0)
        assertEquals(Verdict.ACCEPTED_AFTER_JUMP, gate.offer(true, at(0.5), 22 * ms))
        assertEquals(1, epochs.current())
        // Within the refractory 500 ms the same discontinuity is still settling.
        assertEquals(Verdict.ACCEPTED, gate.offer(true, at(1.0), 44 * ms))
        assertEquals(1, epochs.current())
        // Samples further apart than EpochTracker.JUMP_WINDOW_NS say nothing about how fast the head moved.
        assertEquals(Verdict.ACCEPTED, gate.offer(true, at(3.0), 300 * ms))
        assertEquals(1, epochs.current())
        // A turn of 40° in one update, past the refractory time, is a new jump.
        assertEquals(Verdict.ACCEPTED, gate.offer(true, at(3.0), 578 * ms))
        val turned = RigidPose(at(3.0).position, Quat.fromAxisAngle(Vec3.Y, Math.toRadians(40.0)))
        assertEquals(Verdict.ACCEPTED_AFTER_JUMP, gate.offer(true, turned, 600 * ms))
        assertEquals(2, epochs.current())
    }

    @Test
    fun anUnusablePoseIsKeptOutAndCountsAsALoss() {
        val epochs = EpochTracker()
        val gate = TrackingGate(epochs)
        gate.offer(true, at(0.0), 0)
        assertEquals(Verdict.REJECTED, gate.offer(true, RigidPose(Vec3(Double.NaN, 0.0, 0.0), Quat.IDENTITY), 22 * ms))
        assertEquals(Verdict.REJECTED, gate.offer(true, RigidPose(Vec3.ZERO, Quat(0.0, 0.0, 0.0, 0.1)), 44 * ms))
        assertEquals(Verdict.ACCEPTED_AFTER_LOSS, gate.offer(true, at(0.0), 66 * ms))
    }
}
