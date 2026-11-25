package com.companionintelligence.scan.androidxr.probe

import com.companionintelligence.scan.quest.pose.CameraTimestampSource
import com.companionintelligence.scan.quest.pose.PixelRect
import com.companionintelligence.scan.quest.pose.RigidPose
import com.companionintelligence.scan.quest.pose.angleBetween
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** FocalLengthIntrinsics and CameraFacts.streamIntrinsics, with camera 0's characteristics as the Aura reported them. */
class CameraIntrinsicsTest {
    private val active = PixelRect(0, 0, 1920, 1080)

    private fun estimate(width: Int, height: Int) =
        FocalLengthIntrinsics.estimate(2.4f, 3.2f, 2.4f, 1920, 1080, active, width, height)!!

    private fun auraCamera0(stream: PixelSize, calibration: FloatArray? = null) = CameraFacts(
        id = "0",
        facing = Facing.BACK,
        hardwareLevel = "LIMITED",
        capabilities = listOf("BACKWARD_COMPATIBLE"),
        timestampSource = CameraTimestampSource.REALTIME,
        readoutTimestamp = "HARDWARE",
        lensPoseTranslation = null,
        lensPoseRotation = null,
        lensPoseReference = null,
        intrinsicCalibration = calibration,
        distortion = null,
        focalLengthsMm = floatArrayOf(2.4f),
        physicalSizeMm = 3.2f to 2.4f,
        pixelArraySize = PixelSize(1920, 1080),
        preCorrectionActiveArray = active,
        activeArray = active,
        sensorOrientation = 0,
        yuvSizes = listOf(PixelSize(1920, 1080), PixelSize(1280, 720)),
        aeTargetFpsRanges = listOf(15 to 30, 30 to 30),
        stream = stream,
    )

    @Test
    fun theAurasNumbersGiveAWidthBasedFocalLength() {
        val e = estimate(1920, 1080)
        assertEquals(1440.0, e.focalPxFromWidth, 1e-3)
        assertEquals(1080.0, e.focalPxFromHeight, 1e-3)
        assertFalse("1.667 µm across, 2.222 µm down", e.squarePixels)
        assertEquals(1440.0, e.intrinsics.fx, 1e-3)
        assertEquals(1440.0, e.intrinsics.fy, 1e-3)
        assertEquals(960.0, e.intrinsics.cx, 1e-9)
        assertEquals(540.0, e.intrinsics.cy, 1e-9)
        assertEquals(41.11, e.intrinsics.fovYDeg, 0.01)
    }

    @Test
    fun aSmallerStreamIsTheActiveArrayScaledOrCropped() {
        val scaled = estimate(1280, 720).intrinsics
        assertEquals(960.0, scaled.fx, 1e-3)
        assertEquals(640.0, scaled.cx, 1e-9)
        assertEquals(360.0, scaled.cy, 1e-9)
        // 4:3 from a 16:9 array: centre-cropped across, not scaled (the Quest's rule A3).
        val cropped = estimate(1440, 1080).intrinsics
        assertEquals(1440.0, cropped.fx, 1e-3)
        assertEquals(720.0, cropped.cx, 1e-9)
        assertEquals(540.0, cropped.cy, 1e-9)
    }

    @Test
    fun squarePixelsAreSaidSo() {
        val square = FocalLengthIntrinsics.estimate(2.4f, 3.2f, 1.8f, 1920, 1080, active, 1920, 1080)!!
        assertTrue(square.squarePixels)
        assertEquals(square.focalPxFromWidth, square.focalPxFromHeight, 1e-3)
    }

    @Test
    fun missingSizesGiveNoEstimate() {
        assertNull(FocalLengthIntrinsics.estimate(0f, 3.2f, 2.4f, 1920, 1080, active, 1920, 1080))
        assertNull(FocalLengthIntrinsics.estimate(2.4f, 0f, 2.4f, 1920, 1080, active, 1920, 1080))
        assertNull(FocalLengthIntrinsics.estimate(2.4f, 3.2f, 2.4f, 0, 1080, active, 1920, 1080))
        assertNull(FocalLengthIntrinsics.estimate(2.4f, 3.2f, 2.4f, 1920, 1080, PixelRect(0, 0, 0, 0), 1920, 1080))
    }

    @Test
    fun withNoCalibrationTheKeyframesCarryTheEstimateAndSaySo() {
        val s = auraCamera0(PixelSize(1920, 1080)).streamIntrinsics()!!
        assertTrue(s.source, s.source.startsWith(CameraFacts.SOURCE_ESTIMATE))
        assertTrue(s.source, s.source.contains("not reported"))
        assertNotNull(s.estimate)
        assertEquals(1440.0, s.intrinsics.fx, 1e-3)
    }

    @Test
    fun aPlausibleCalibrationIsUsed() {
        val s = auraCamera0(PixelSize(1280, 720), floatArrayOf(1500f, 1500f, 955f, 545f, 0f)).streamIntrinsics()!!
        assertEquals(CameraFacts.SOURCE_CALIBRATION, s.source)
        assertNull(s.estimate)
        assertEquals(1000.0, s.intrinsics.fx, 1e-3)
        assertEquals(955.0 * 2 / 3, s.intrinsics.cx, 1e-3)
    }

    /** The Aura's depth camera reports [2.4, 2.4, 0, 0, 0]: its focal length in millimetres, by the look of it. */
    @Test
    fun aPlaceholderCalibrationIsNotTakenOnTrust() {
        assertFalse(CameraFacts.isPlausible(floatArrayOf(2.4f, 2.4f, 0f, 0f, 0f), active))
        assertFalse("a principal point outside the array", CameraFacts.isPlausible(floatArrayOf(1440f, 1440f, 2000f, 540f), active))
        assertFalse("a 179° field of view", CameraFacts.isPlausible(floatArrayOf(8f, 8f, 960f, 540f), active))
        assertFalse("too short", CameraFacts.isPlausible(floatArrayOf(1440f, 1440f), active))
        assertTrue(CameraFacts.isPlausible(floatArrayOf(1440f, 1440f, 960f, 540f, 0f), active))
        val s = auraCamera0(PixelSize(1920, 1080), floatArrayOf(2.4f, 2.4f, 0f, 0f, 0f)).streamIntrinsics()!!
        assertTrue(s.source, s.source.contains("implausible"))
        assertEquals(1440.0, s.intrinsics.fx, 1e-3)
    }

    @Test
    fun withNoLensPoseTheCameraSitsAtTheDeviceOrigin() {
        val f = auraCamera0(PixelSize(1920, 1080))
        assertFalse(f.hasLensPose)
        // By value: the Z mirror of a zero translation is −0.0, which a data class's equals tells from 0.0.
        assertEquals(0.0, f.headFromCamera.position.length(), 0.0)
        assertEquals(0.0, angleBetween(RigidPose.IDENTITY.rotation, f.headFromCamera.rotation), 1e-9)
    }
}
