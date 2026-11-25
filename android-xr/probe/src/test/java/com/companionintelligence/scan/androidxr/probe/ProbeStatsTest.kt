package com.companionintelligence.scan.androidxr.probe

import com.companionintelligence.scan.quest.pose.PoseTimeSource
import com.companionintelligence.scan.quest.pose.RigidPose
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ProbeStatsTest {
    private val ms = 1_000_000L

    /** Updates every 22 ms on the XR clock; the boot clock runs [ppm] parts per million faster. */
    private fun updates(count: Int, ppm: Double = 0.0, age: Long = 25 * ms): List<PoseRecord> = (0 until count).map { i ->
        val sinceFirst = i * 22 * ms
        val boot = 7_000 * ms + (sinceFirst * (1 + ppm / 1e6)).toLong()
        PoseRecord(
            sequence = i.toLong(),
            poseRealtimeNs = boot,
            readRealtimeNs = boot + age,
            ageNs = age,
            uncertaintyNs = 1_000,
            markSinceFirstNs = sinceFirst,
            source = PoseTimeSource.XR_UPDATE_TIME,
            tracking = "TRACKING",
            verdict = TrackingGate.Verdict.ACCEPTED,
            epoch = 0,
            pose = RigidPose.IDENTITY,
        )
    }

    @Test
    fun aSteadyRunReportsItsRateAndNoDrift() {
        val s = ProbeStats.poses(updates(46))
        assertEquals(46, s.updates)
        assertEquals(46, s.tracked)
        assertEquals(1000.0 / 22, s.trackedRateHz!!, 1e-9)
        assertEquals(25.0, s.ageMsMedian!!, 1e-9)
        assertEquals(0.0, s.clockDriftUs!!, 1e-9)
        assertEquals(0.0, s.clockResidualUsMax!!, 1e-9)
        assertEquals(1.0, s.uncertaintyUsMax!!, 1e-9)
        assertEquals(0, s.epochBumps)
    }

    @Test
    fun clocksAtTwoRatesShowAsDrift() {
        // 100 ppm over 45 × 22 ms = 0.99 s is 99 µs.
        val s = ProbeStats.poses(updates(46, ppm = 100.0))
        assertEquals(99.0, s.clockDriftUs!!, 0.01)
        assertEquals("over the boot clock's 990.1 ms", 100.0, s.clockDriftPpm!!, 0.05)
        assertEquals(99.0, s.clockResidualUsMax!!, 0.01)
    }

    @Test
    fun rejectedUpdatesAndBumpsAreCountedApart() {
        val records = updates(10).mapIndexed { i, r ->
            when (i) {
                0, 1 -> r.copy(verdict = TrackingGate.Verdict.REJECTED, tracking = "STOPPED")
                5 -> r.copy(verdict = TrackingGate.Verdict.ACCEPTED_AFTER_LOSS)
                7 -> r.copy(verdict = TrackingGate.Verdict.ACCEPTED_AFTER_JUMP)
                else -> r
            }
        }
        val s = ProbeStats.poses(records)
        assertEquals(10, s.updates)
        assertEquals(8, s.tracked)
        assertEquals(2, s.epochBumps)
        assertEquals(linkedMapOf("STOPPED" to 2, "TRACKING" to 8), s.trackingStates)
        assertEquals(listOf("STOPPED", "TRACKING"), s.trackingStates.keys.toList())
    }

    @Test
    fun readTimeStampsStayOutOfTheClockCheck() {
        val records = updates(5).map { it.copy(source = PoseTimeSource.READ_TIME) }
        val s = ProbeStats.poses(records)
        assertNull(s.clockDriftUs)
        assertNull(s.ageMsMedian)
    }

    @Test
    fun framesThatArriveSoonAfterTheirTimestampArePlausible() {
        val frames = (0 until 31).map { i -> FrameRecord(i * 33_333_333L, 5_000 * ms + i * 33_333_333L, 5_000 * ms + i * 33_333_333L + 41 * ms) }
        val s = ProbeStats.frames(frames)
        assertEquals(31, s.frames)
        assertEquals(30.0, s.rateHz!!, 1e-6)
        assertEquals(41.0, s.latencyMsMedian!!, 1e-9)
        assertTrue(s.cameraClockPlausible)
    }

    @Test
    fun aCameraOnAnotherClockIsCaught() {
        // Stamped on CLOCK_MONOTONIC after an hour of sleep since boot, read as if it were the boot clock.
        val hour = 3_600_000 * ms
        val frames = (0 until 5).map { i -> FrameRecord(i * 33 * ms, i * 33 * ms, hour + i * 33 * ms + 40 * ms) }
        assertFalse(ProbeStats.frames(frames).cameraClockPlausible)
        // A frame stamped after it arrived is impossible too.
        assertFalse(ProbeStats.frames(listOf(FrameRecord(0, 100 * ms, 99 * ms))).cameraClockPlausible)
        assertFalse("no frames, no claim", ProbeStats.frames(emptyList()).cameraClockPlausible)
    }

    @Test
    fun percentilesAreNearestRank() {
        val values = (1..20).map { it.toDouble() }
        assertEquals(10.0, ProbeStats.percentile(values, 0.5)!!, 0.0)
        assertEquals(19.0, ProbeStats.percentile(values, 0.95)!!, 0.0)
        assertEquals(1.0, ProbeStats.percentile(values, 0.0)!!, 0.0)
        assertNull(ProbeStats.percentile(emptyList(), 0.5))
    }
}
