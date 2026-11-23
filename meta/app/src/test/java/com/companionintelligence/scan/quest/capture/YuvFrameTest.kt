package com.companionintelligence.scan.quest.capture

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Test

class YuvFrameTest {
    /**
     * A 4×2 frame. Y has a row stride of 6 (padding), chroma is 2×1. [semiPlanar] gives Android's interleaved
     * layout: one chroma buffer U0 V0 U1 V1 with the V plane starting one byte in, pixel stride 2.
     */
    private fun frame(semiPlanar: Boolean): YuvFrame {
        val y = YuvPlane(
            byteArrayOf(10, 11, 12, 13, 0, 0, 20, 21, 22, 23),
            rowStride = 6,
            pixelStride = 1,
        )
        return if (semiPlanar) {
            val chroma = byteArrayOf(100, 200.toByte(), 101, 201.toByte())
            YuvFrame(4, 2, 0, 0, y, YuvPlane(chroma.copyOfRange(0, 3), 4, 2), YuvPlane(chroma.copyOfRange(1, 4), 4, 2))
        } else {
            YuvFrame(4, 2, 0, 0, y, YuvPlane(byteArrayOf(100, 101), 2, 1), YuvPlane(byteArrayOf(200.toByte(), 201.toByte()), 2, 1))
        }
    }

    @Test
    fun planarAndSemiPlanarGiveTheSameNv21() {
        val expected = byteArrayOf(10, 11, 12, 13, 20, 21, 22, 23, 200.toByte(), 100, 201.toByte(), 101)
        assertArrayEquals(expected, frame(semiPlanar = false).toNv21())
        assertArrayEquals(expected, frame(semiPlanar = true).toNv21())
    }

    @Test
    fun samplesReadThroughTheStrides() {
        val f = frame(semiPlanar = true)
        assertEquals(22, f.lumaAt(2, 1))
        assertEquals(Triple(13, 101, 201), f.yuvAt(3, 0))
        assertEquals(listOf(10, 3, 3), f.planes.map { it.bufferSize })
    }
}
