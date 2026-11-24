package com.companionintelligence.scan.quest.pose

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class EpochTrackerTest {
    private val ms = 1_000_000L
    private val head = RigidPose(Vec3(0.0, 1.6, 0.0), Quat.IDENTITY)

    @Test
    fun theTranslationFloorIsTheWebs() {
        // src/ar/frame-epoch.ts FRAME_JUMP_TRANSLATION_M = 0.30.
        assertEquals(0.30, EpochTracker.JUMP_METRES, 0.0)
        val step = { m: Double -> RigidPose(Vec3(m, 1.6, 0.0), Quat.IDENTITY) }
        assertFalse(EpochTracker.isTrackingJump(head, step(0.29), 14 * ms))
        assertTrue(EpochTracker.isTrackingJump(head, step(0.31), 14 * ms))
    }

    @Test
    fun aFastHeadTurnIsNotAJumpAndTwentyFiveDegreesInOneFrameIs() {
        // 8° in one 72 Hz frame is 576°/s, which a quick head turn reaches: the web's yaw number on raw samples would split
        // the capture. 25° in one frame is beyond a head.
        val turn = { deg: Double -> RigidPose(head.position, Quat.fromAxisAngle(Vec3.Y, Math.toRadians(deg))) }
        assertFalse(EpochTracker.isTrackingJump(head, turn(8.0), 14 * ms))
        assertFalse(EpochTracker.isTrackingJump(head, turn(24.0), 14 * ms))
        assertTrue(EpochTracker.isTrackingJump(head, turn(26.0), 14 * ms))
        assertFalse("samples further apart than the window say nothing", EpochTracker.isTrackingJump(head, turn(90.0), 150 * ms))
    }

    @Test
    fun aJumpWithinTheRefractoryWindowOfTheLastBumpIsTheSameOne() {
        // src/ar/frame-epoch.ts FRAME_JUMP_REFRACTORY_MS = 500.
        val epochs = EpochTracker()
        assertTrue(epochs.noteJump(1_000 * ms))
        assertFalse("still settling", epochs.noteJump(1_499 * ms))
        assertEquals(1, epochs.current())
        assertTrue(epochs.noteJump(1_500 * ms))
        assertEquals(2, epochs.current())
        // A recenter always bumps, and a jump right after it is folded into it.
        epochs.bump(3_000 * ms)
        assertFalse(epochs.noteJump(3_100 * ms))
        assertEquals(3, epochs.current())
        assertEquals(2, epochs.epochAt(2_999 * ms))
        assertEquals(3, epochs.epochAt(3_000 * ms))
    }
}
