package com.companionintelligence.scan.androidxr.probe

import com.companionintelligence.scan.quest.pose.PoseTimeSource
import com.companionintelligence.scan.quest.pose.Quat
import com.companionintelligence.scan.quest.pose.RigidPose
import com.companionintelligence.scan.quest.pose.Vec3
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class FramePosesTest {
    private val ms = 1_000_000L

    private fun sample(seq: Long, tMs: Long, x: Double, verdict: TrackingGate.Verdict = TrackingGate.Verdict.ACCEPTED) = PoseRecord(
        sequence = seq, poseRealtimeNs = tMs * ms, readRealtimeNs = tMs * ms + 25 * ms, ageNs = 25 * ms, uncertaintyNs = 0,
        markSinceFirstNs = tMs * ms, source = PoseTimeSource.XR_UPDATE_TIME,
        tracking = if (verdict == TrackingGate.Verdict.REJECTED) "PAUSED" else "TRACKING", verdict = verdict, epoch = 0,
        pose = RigidPose(Vec3(x, 1.6, 0.0), Quat.IDENTITY),
    )

    private fun frame(tMs: Long) = FrameRecord(tMs * ms, tMs * ms, tMs * ms + 40 * ms)

    @Test
    fun everyFrameGetsThePoseAtItsTimestamp() {
        val poses = listOf(sample(0, 100, 0.0), sample(1, 122, 0.22), sample(2, 144, 0.44))
        val joined = FramePoses.join(poses, listOf(frame(111), frame(133), frame(122)))
        assertEquals(0.11, joined[0].pose!!.position.x, 1e-12)
        assertEquals(11 * ms, joined[0].beforeNs)
        assertEquals(11 * ms, joined[0].afterNs)
        assertEquals(0.33, joined[1].pose!!.position.x, 1e-12)
        // On a sample's own time: that sample, with nothing before it.
        assertEquals(0.22, joined[2].pose!!.position.x, 1e-12)
        assertEquals(0L, joined[2].beforeNs)
        assertEquals(22 * ms, joined[2].afterNs)
    }

    @Test
    fun framesOutsideTheTrackedSamplesOrAcrossALossHaveNoPose() {
        val poses = listOf(
            sample(0, 100, 0.0),
            sample(1, 122, 0.22),
            sample(2, 144, 0.22, TrackingGate.Verdict.REJECTED), // lost: kept out of the join
            sample(3, 200, 0.5, TrackingGate.Verdict.ACCEPTED_AFTER_LOSS),
        )
        val joined = FramePoses.join(poses, listOf(frame(90), frame(160), frame(210)))
        assertNull("before the first sample", joined[0].pose)
        assertNull(joined[0].beforeNs)
        assertEquals(10 * ms, joined[0].afterNs)
        assertNull("78 ms between the samples either side", joined[1].pose)
        assertEquals(38 * ms, joined[1].beforeNs)
        assertEquals(40 * ms, joined[1].afterNs)
        assertNull("after the last sample", joined[2].pose)
        assertNull(joined[2].afterNs)
    }

    @Test
    fun aRunWithoutTrackedSamplesStillGivesEveryFrameARow() {
        val joined = FramePoses.join(emptyList(), listOf(frame(1), frame(2)))
        assertEquals(2, joined.size)
        assertNull(joined[0].pose)
        assertNull(joined[1].beforeNs)
    }
}
