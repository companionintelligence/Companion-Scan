package com.companionintelligence.scan.quest.capture

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** CaptureController.FramePlan: what one camera frame is wanted for (FN-173, FN-176). */
class CaptureGatesTest {
    private fun plan(
        capturing: Boolean = true,
        uploading: Boolean = true,
        keyframeDue: Boolean = true,
        hasWriter: Boolean = true,
        datasetDue: Boolean = true,
        backlog: Int = 0,
        visionReady: Boolean = true,
        visionDue: () -> Boolean = { true },
    ) = CaptureController.FramePlan.of(capturing, uploading, { keyframeDue }, hasWriter, { datasetDue }, backlog, visionReady, visionDue)

    @Test
    fun outsideACaptureNothingIsWantedAndTheVisionGateIsNotSpent() {
        var asked = 0
        val p = plan(capturing = false, visionDue = { asked++; true })
        assertFalse(p.any)
        assertFalse("the vision hook runs on a capture's frames only", p.vision)
        assertEquals("its rate gate is left for the next capture", 0, asked)
    }

    @Test
    fun duringACaptureEachWorkerGetsTheFramesItsGateLetsThrough() {
        val p = plan()
        assertTrue(p.keyframe && p.dataset && p.vision)
        assertFalse(plan(uploading = false).keyframe)
        assertFalse(plan(keyframeDue = false).keyframe)
        assertFalse(plan(hasWriter = false).dataset)
        assertFalse(plan(visionReady = false).vision)
    }

    @Test
    fun aDatasetWriterThatFellBehindDropsTheFrameAndCountsIt() {
        val full = plan(backlog = CaptureController.DATASET_QUEUE)
        assertFalse(full.dataset)
        assertTrue("counted as dropped", full.datasetDropped)
        val room = plan(backlog = CaptureController.DATASET_QUEUE - 1)
        assertTrue(room.dataset)
        assertFalse(room.datasetDropped)
        assertFalse("a frame the gate did not let through is not a drop", plan(datasetDue = false, backlog = 99).datasetDropped)
    }
}
