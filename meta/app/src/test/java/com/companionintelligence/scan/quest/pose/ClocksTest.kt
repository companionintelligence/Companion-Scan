package com.companionintelligence.scan.quest.pose

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ClocksTest {
    private val offset = ClockOffsets { 5_000_000_000L } // 5 s of deep sleep since boot

    @Test
    fun aRealtimeCameraNeedsNoConversion() {
        val clock = CameraClock(CameraTimestampSource.fromCamera2(1), offset)
        assertEquals(CameraTimestampSource.REALTIME, clock.source)
        assertEquals(123L, clock.toRealtimeNs(123L))
        assertEquals(123L, clock.fromRealtimeNs(123L))
    }

    @Test
    fun anUnknownCameraIsMovedFromMonotonicToRealtime() {
        val clock = CameraClock(CameraTimestampSource.fromCamera2(0), offset)
        assertEquals(CameraTimestampSource.UNKNOWN, clock.source)
        assertEquals(5_000_000_123L, clock.toRealtimeNs(123L))
        assertEquals(123L, clock.fromRealtimeNs(clock.toRealtimeNs(123L)))
        assertEquals("a missing value is UNKNOWN", CameraTimestampSource.UNKNOWN, CameraTimestampSource.fromCamera2(null))
    }

    @Test
    fun aPlausibleDisplayTimeStampsThePose() {
        val readRealtime = 10_000_000_000L
        val readMonotonic = 5_000_000_000L
        val display = readMonotonic + 30_000_000L // 30 ms ahead
        val stamp = PoseClock.stamp(readRealtime, readMonotonic, display, timingValid = true)
        assertEquals(PoseTimeSource.PREDICTED_DISPLAY_TIME, stamp.source)
        assertEquals(readRealtime + 30_000_000L, stamp.realtimeNs)
        assertEquals(display, stamp.xrTimeNs)
    }

    @Test
    fun otherwiseTheReadTimeIsUsed() {
        val rt = 10_000_000_000L
        val mono = 5_000_000_000L
        assertEquals(PoseTimeSource.READ_TIME, PoseClock.stamp(rt, mono, mono + 30_000_000L, timingValid = false).source)
        assertEquals(PoseTimeSource.READ_TIME, PoseClock.stamp(rt, mono, null, timingValid = true).source)
        // An XrTime on some other epoch than CLOCK_MONOTONIC is not trusted.
        val far = PoseClock.stamp(rt, mono, mono + 3_600_000_000_000L, timingValid = true)
        assertEquals(PoseTimeSource.READ_TIME, far.source)
        assertEquals(rt, far.realtimeNs)
    }

    @Test
    fun unixMillisecondsShareOneBase() {
        val mapper = UnixMsMapper(baseRealtimeNs = 1_000_000_000L, baseUnixMs = 1_763_900_000_000L)
        assertEquals(1_763_900_000_000L, mapper.unixMs(1_000_000_000L))
        assertEquals(1_763_900_000_033L, mapper.unixMs(1_033_999_999L))
        assertEquals("floor, also before the base", 1_763_899_999_999L, mapper.unixMs(999_999_999L))
    }

    @Test
    fun epochsAreLookedUpByTime() {
        val epochs = EpochTracker()
        assertEquals(0, epochs.epochAt(100))
        epochs.bump(1_000)
        assertEquals(0, epochs.epochAt(999))
        assertEquals(1, epochs.epochAt(1_000))
        epochs.bump(500) // out of order: counted just after the last one
        assertEquals(2, epochs.current())
        assertEquals(1, epochs.epochAt(1_000))
        assertEquals(2, epochs.epochAt(1_001))
    }

    @Test
    fun aJumpFasterThanAHeadIsADiscontinuity() {
        val a = RigidPose(Vec3(0.0, 1.6, 0.0), Quat.IDENTITY)
        val ms = 1_000_000L
        assertFalse(EpochTracker.isTrackingJump(a, RigidPose(Vec3(0.02, 1.6, 0.0), Quat.IDENTITY), 11 * ms))
        assertTrue(EpochTracker.isTrackingJump(a, RigidPose(Vec3(0.5, 1.6, 0.0), Quat.IDENTITY), 11 * ms))
        assertTrue(EpochTracker.isTrackingJump(a, RigidPose(a.position, Quat.fromAxisAngle(Vec3.Y, Math.toRadians(40.0))), 11 * ms))
        assertFalse("too far apart to compare", EpochTracker.isTrackingJump(a, RigidPose(Vec3(0.5, 1.6, 0.0), Quat.IDENTITY), 500 * ms))
    }
}
