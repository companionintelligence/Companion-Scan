package com.companionintelligence.scan.quest.vision

import com.companionintelligence.scan.quest.capture.YuvFrame
import com.companionintelligence.scan.quest.capture.YuvPlane
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class VisionHookTest {
    @get:Rule
    val tmp = TemporaryFolder()

    private fun flatFrame(y: Int, u: Int, v: Int) = YuvFrame(
        4, 4, 0, 0,
        YuvPlane(ByteArray(16) { y.toByte() }, 4, 1),
        YuvPlane(ByteArray(4) { u.toByte() }, 2, 1),
        YuvPlane(ByteArray(4) { v.toByte() }, 2, 1),
    )

    @Test
    fun grayStaysGrayAndChannelsArePlanar() {
        val out = yuvToPlanarRgb(flatFrame(128, 128, 128), 2, 3)
        assertEquals(18, out.size)
        out.forEach { assertEquals(128 / 255f, it, 1e-6f) }
    }

    @Test
    fun fullRangeBt601Red() {
        // Y 76, U 85, V 255 is close to pure red in full-range BT.601.
        val out = yuvToPlanarRgb(flatFrame(76, 85, 255), 1, 1)
        assertTrue("r ${out[0]}", out[0] > 0.95f)
        assertTrue("g ${out[1]}", out[1] < 0.05f)
        assertTrue("b ${out[2]}", out[2] < 0.05f)
    }

    @Test
    fun withNoModelFileTheHookSaysSo() {
        val model = OnnxVisionModel(tmp.newFolder("models"))
        model.load()
        val status = model.status
        assertTrue(status is VisionStatus.NotInstalled)
        assertTrue((status as VisionStatus.NotInstalled).expectedPath.endsWith(".onnx"))
        assertNull(model.analyze(flatFrame(0, 128, 128)))
        model.close()
    }
}
