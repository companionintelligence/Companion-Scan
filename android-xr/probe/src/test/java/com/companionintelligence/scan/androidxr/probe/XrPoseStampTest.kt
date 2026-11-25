package com.companionintelligence.scan.androidxr.probe

import com.companionintelligence.scan.quest.pose.PoseTimeSource
import org.junit.Assert.assertEquals
import org.junit.Test
import kotlin.time.Duration.Companion.milliseconds
import kotlin.time.Duration.Companion.nanoseconds
import kotlin.time.TestTimeSource

class XrPoseStampTest {

    /** A boot clock that advances by [step] every read, starting at [start]. */
    private class BootClock(var now: Long, private val step: Long) {
        fun read(): Long = now.also { now += step }
    }

    @Test
    fun theMarkIsPutOnTheBootClockByItsAge() {
        // The XR clock and the boot clock have unrelated origins; only their rates are the same.
        val xr = TestTimeSource()
        xr += 5_000.milliseconds
        val mark = xr.markNow() // the update locates the device here
        xr += 37.milliseconds // the library's 20 ms wait, its own work, and the trip to the probe
        val boot = BootClock(now = 900_000_000_000L, step = 2_000) // each read takes 2 µs
        val stamp = XrPoseStamp.stampMark(mark) { boot.read() }
        assertEquals(PoseTimeSource.XR_UPDATE_TIME, stamp.source)
        assertEquals(37_000_000L, stamp.ageNs)
        // Reads at 900 000 000 000 and 900 000 002 000: the middle, less the age.
        assertEquals(900_000_001_000L - 37_000_000L, stamp.realtimeNs)
        assertEquals(1_000L, stamp.uncertaintyNs)
        assertEquals(900_000_001_000L, stamp.readRealtimeNs)
    }

    @Test
    fun twoUpdatesKeepTheirXrDistanceOnTheBootClock() {
        val xr = TestTimeSource()
        val boot = BootClock(now = 1_000_000_000L, step = 0)
        val first = xr.markNow()
        xr += 22.milliseconds
        val second = xr.markNow()
        xr += 25.milliseconds
        // Both are handled now, late and in one go: their stamps stay 22 ms apart.
        boot.now += 47_000_000L
        val a = XrPoseStamp.stampMark(first) { boot.read() }
        val b = XrPoseStamp.stampMark(second) { boot.read() }
        assertEquals(22_000_000L, b.realtimeNs - a.realtimeNs)
        assertEquals((second - first), (b.realtimeNs - a.realtimeNs).nanoseconds)
    }

    @Test
    fun anAgeThatNoClockWouldGiveFallsBackToTheReadTime() {
        val negative = XrPoseStamp.stamp(10_000L, -1L, 10_000L)
        assertEquals(PoseTimeSource.READ_TIME, negative.source)
        assertEquals(10_000L, negative.realtimeNs)
        val tooOld = XrPoseStamp.stamp(10_000L, XrPoseStamp.MAX_PLAUSIBLE_AGE_NS + 1, 10_000L)
        assertEquals(PoseTimeSource.READ_TIME, tooOld.source)
        val oldest = XrPoseStamp.stamp(2_000_000_000L, XrPoseStamp.MAX_PLAUSIBLE_AGE_NS, 2_000_000_000L)
        assertEquals(PoseTimeSource.XR_UPDATE_TIME, oldest.source)
        assertEquals(1_000_000_000L, oldest.realtimeNs)
    }

    @Test
    fun anOddBracketRoundsItsUncertaintyUp() {
        val stamp = XrPoseStamp.stamp(100L, 0L, 103L)
        assertEquals(101L, stamp.realtimeNs)
        assertEquals(2L, stamp.uncertaintyNs)
    }

    @Test(expected = IllegalArgumentException::class)
    fun aBracketThatRunsBackwardsIsRefused() {
        XrPoseStamp.stamp(200L, 0L, 100L)
    }
}
