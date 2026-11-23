package com.companionintelligence.scan.quest.pose

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.math.PI

class PoseRingBufferTest {
    private val ms = 1_000_000L

    private fun pose(x: Double, yawRad: Double) = RigidPose(Vec3(x, 1.6, 0.0), Quat.fromAxisAngle(Vec3.Y, yawRad))

    @Test
    fun interpolatesPositionAndRotationBetweenSamples() {
        val buffer = PoseRingBuffer(16)
        buffer.add(100 * ms, pose(0.0, 0.0), null, PoseTimeSource.READ_TIME)
        buffer.add(110 * ms, pose(1.0, PI / 2), null, PoseTimeSource.READ_TIME)
        val mid = buffer.interpolate(105 * ms)!!
        assertEquals(0.5, mid.position.x, 1e-12)
        assertEquals(0.0, angleBetween(Quat.fromAxisAngle(Vec3.Y, PI / 4), mid.rotation), 1e-9)
        val quarter = buffer.interpolate(102_500_000L)!!
        assertEquals(0.25, quarter.position.x, 1e-12)
    }

    @Test
    fun exactSampleTimesReturnTheSample() {
        val buffer = PoseRingBuffer(16)
        buffer.add(100 * ms, pose(0.0, 0.0), null, PoseTimeSource.READ_TIME)
        buffer.add(110 * ms, pose(1.0, 0.0), null, PoseTimeSource.READ_TIME)
        assertEquals(0.0, buffer.interpolate(100 * ms)!!.position.x, 0.0)
        assertEquals(1.0, buffer.interpolate(110 * ms)!!.position.x, 0.0)
    }

    @Test
    fun refusesToExtrapolateOrBridgeAGap() {
        val buffer = PoseRingBuffer(16)
        buffer.add(100 * ms, pose(0.0, 0.0), null, PoseTimeSource.READ_TIME)
        buffer.add(200 * ms, pose(1.0, 0.0), null, PoseTimeSource.READ_TIME)
        assertNull("before the oldest", buffer.interpolate(99 * ms))
        assertNull("after the newest", buffer.interpolate(201 * ms))
        assertNull("a 100 ms gap is a dropout", buffer.interpolate(150 * ms, maxGapNs = 50 * ms))
        assertNotNull("unless the caller allows it", buffer.interpolate(150 * ms, maxGapNs = 150 * ms))
    }

    @Test
    fun dropsSamplesThatGoBackInTime() {
        val buffer = PoseRingBuffer(16)
        assertTrue(buffer.add(100 * ms, pose(0.0, 0.0), null, PoseTimeSource.READ_TIME))
        assertFalse(buffer.add(100 * ms, pose(9.0, 0.0), null, PoseTimeSource.READ_TIME))
        assertFalse(buffer.add(90 * ms, pose(9.0, 0.0), null, PoseTimeSource.READ_TIME))
        assertEquals(1, buffer.size())
    }

    @Test
    fun wrapsAroundAndForgetsTheOldest() {
        val buffer = PoseRingBuffer(4)
        for (i in 0 until 10) buffer.add(i * 10 * ms, pose(i.toDouble(), 0.0), i * 10 * ms + 7, PoseTimeSource.PREDICTED_DISPLAY_TIME)
        assertEquals(4, buffer.size())
        assertNull("overwritten", buffer.interpolate(50 * ms))
        assertEquals(7.5, buffer.interpolate(75 * ms)!!.position.x, 1e-12)
        val latest = buffer.latest()!!
        assertEquals(9L, latest.sequence)
        assertEquals(90 * ms + 7, latest.xrTimeNs)
        assertEquals(PoseTimeSource.PREDICTED_DISPLAY_TIME, latest.timeSource)
    }

    @Test
    fun drainReturnsEverySampleOnceAndSkipsOverwrittenOnes() {
        val buffer = PoseRingBuffer(4)
        val out = ArrayList<PoseSample>()
        for (i in 0 until 3) buffer.add(i * ms + 1, pose(i.toDouble(), 0.0), null, PoseTimeSource.READ_TIME)
        var next = buffer.drainSince(0, out)
        assertEquals(listOf(0L, 1L, 2L), out.map { it.sequence })
        assertEquals(3L, next)
        out.clear()
        next = buffer.drainSince(next, out)
        assertTrue(out.isEmpty())
        for (i in 3 until 10) buffer.add(i * ms + 1, pose(i.toDouble(), 0.0), null, PoseTimeSource.READ_TIME)
        next = buffer.drainSince(next, out)
        assertEquals("only the four still held", listOf(6L, 7L, 8L, 9L), out.map { it.sequence })
        assertEquals(10L, next)
        assertNull(out.first().xrTimeNs)
    }
}
