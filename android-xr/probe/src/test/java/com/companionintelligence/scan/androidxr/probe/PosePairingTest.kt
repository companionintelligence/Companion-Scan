package com.companionintelligence.scan.androidxr.probe

import com.companionintelligence.scan.quest.pose.PoseRingBuffer
import com.companionintelligence.scan.quest.pose.PoseTimeSource
import com.companionintelligence.scan.quest.pose.Quat
import com.companionintelligence.scan.quest.pose.RigidPose
import com.companionintelligence.scan.quest.pose.Vec3
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class PosePairingTest {
    private val ms = 1_000_000L
    private fun at(x: Double) = RigidPose(Vec3(x, 1.6, 0.0), Quat.IDENTITY)

    /** A clock that moves only when the pairing pauses, by 4 ms a pause, running [onPause] each time. */
    private class FakeTime(private val onPause: (Int) -> Unit = {}) {
        var now = 0L
        var pauses = 0
        fun nanoTime() = now
        fun pause() {
            pauses++
            now += 4_000_000L
            onPause(pauses)
        }
    }

    @Test
    fun aFrameBetweenTwoUpdatesGetsTheirInterpolation() {
        val poses = PoseRingBuffer(16)
        poses.add(100 * ms, at(0.0), null, PoseTimeSource.XR_UPDATE_TIME)
        poses.add(122 * ms, at(0.22), null, PoseTimeSource.XR_UPDATE_TIME)
        val time = FakeTime()
        val result = PosePairing(poses, nanoTime = time::nanoTime, pause = time::pause).poseAt(111 * ms)
        assertTrue(result is PosePairing.Result.Paired)
        assertEquals(0.11, (result as PosePairing.Result.Paired).pose.position.x, 1e-12)
        assertEquals("no wait when the later sample is already in", 0, time.pauses)
    }

    @Test
    fun itWaitsForTheUpdateAfterTheFrame() {
        val poses = PoseRingBuffer(16)
        poses.add(100 * ms, at(0.0), null, PoseTimeSource.XR_UPDATE_TIME)
        // The next update reaches the buffer during the third pause.
        val time = FakeTime { if (it == 3) poses.add(122 * ms, at(0.22), null, PoseTimeSource.XR_UPDATE_TIME) }
        val result = PosePairing(poses, nanoTime = time::nanoTime, pause = time::pause).poseAt(111 * ms)
        assertEquals(0.11, (result as PosePairing.Result.Paired).pose.position.x, 1e-12)
        assertEquals(3, time.pauses)
    }

    @Test
    fun noLaterUpdateWithinTheWaitIsSaid() {
        val poses = PoseRingBuffer(16)
        poses.add(100 * ms, at(0.0), null, PoseTimeSource.XR_UPDATE_TIME)
        val time = FakeTime()
        val result = PosePairing(poses, maxWaitNs = 150 * ms, nanoTime = time::nanoTime, pause = time::pause).poseAt(111 * ms)
        assertEquals(PosePairing.Result.NoLaterSample, result)
        assertTrue("it waited out the 150 ms", time.now > 150 * ms)
    }

    @Test
    fun aGapInTrackingIsNotBridged() {
        val poses = PoseRingBuffer(16)
        poses.add(100 * ms, at(0.0), null, PoseTimeSource.XR_UPDATE_TIME)
        poses.add(200 * ms, at(1.0), null, PoseTimeSource.XR_UPDATE_TIME)
        val time = FakeTime()
        assertEquals(
            PosePairing.Result.NoSampleEitherSide,
            PosePairing(poses, nanoTime = time::nanoTime, pause = time::pause).poseAt(150 * ms),
        )
        assertEquals(
            "older than the buffer",
            PosePairing.Result.NoSampleEitherSide,
            PosePairing(poses, nanoTime = time::nanoTime, pause = time::pause).poseAt(50 * ms),
        )
    }

    @Test
    fun anInterruptedWaitStops() {
        val poses = PoseRingBuffer(16)
        val result = PosePairing(poses, pause = { throw InterruptedException() }).poseAt(1 * ms)
        assertEquals(PosePairing.Result.Interrupted, result)
        assertTrue(Thread.interrupted()) // clears the flag for the next test
    }
}
