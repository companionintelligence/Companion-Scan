package com.companionintelligence.scan.androidxr.probe

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class CameraChoiceTest {
    private val auraYuv = listOf(
        PixelSize(1920, 1080), PixelSize(1440, 1080), PixelSize(1280, 720), PixelSize(640, 480), PixelSize(320, 240),
    )

    /** What the Aura showed apps on 2026-11-24 (dumpsys media.camera). */
    private val aura = listOf(
        CameraDescription("0", Facing.BACK, backwardCompatible = true, depthOutput = false, yuvSizes = auraYuv),
        CameraDescription("1", Facing.FRONT, backwardCompatible = true, depthOutput = false, yuvSizes = auraYuv),
        CameraDescription("11", Facing.BACK, backwardCompatible = false, depthOutput = true, yuvSizes = emptyList()),
    )

    @Test
    fun onTheAuraItIsCameraZero() {
        assertEquals("0", CameraChoice.choose(aura)?.id)
        assertEquals("0", CameraChoice.choose(aura.reversed())?.id)
    }

    @Test
    fun neitherTheAvatarNorTheDepthCameraCanWin() {
        assertNull(CameraChoice.choose(aura.filter { it.id != "0" }))
        // A depth camera that also lists YUV sizes is still not a colour camera.
        val depthWithYuv = CameraDescription("11", Facing.BACK, backwardCompatible = false, depthOutput = true, yuvSizes = auraYuv)
        assertNull(CameraChoice.choose(listOf(depthWithYuv, aura[1])))
    }

    @Test
    fun withoutAZeroTheFirstBackColourCameraIsTaken() {
        val others = listOf(
            aura[1],
            CameraDescription("7", Facing.BACK, backwardCompatible = true, depthOutput = false, yuvSizes = auraYuv),
            CameraDescription("8", Facing.BACK, backwardCompatible = true, depthOutput = false, yuvSizes = auraYuv),
        )
        assertEquals("7", CameraChoice.choose(others)?.id)
        val zeroWithoutYuv = CameraDescription("0", Facing.BACK, backwardCompatible = true, depthOutput = false, yuvSizes = emptyList())
        assertEquals("a camera 0 with no YUV outputs is passed over", "7", CameraChoice.choose(listOf(zeroWithoutYuv) + others)?.id)
    }

    @Test
    fun theStreamIsTheWantedSizeOrTheNearestOffered() {
        assertEquals(PixelSize(1920, 1080), CameraChoice.chooseSize(auraYuv, CameraChoice.DEFAULT_SIZE))
        assertEquals(PixelSize(1280, 720), CameraChoice.chooseSize(auraYuv, PixelSize(1280, 720)))
        assertEquals(PixelSize(1280, 720), CameraChoice.chooseSize(auraYuv, PixelSize(1280, 960)))
        assertNull(CameraChoice.chooseSize(emptyList(), CameraChoice.DEFAULT_SIZE))
    }

    @Test
    fun sizesParseFromTheIntentExtra() {
        assertEquals(PixelSize(1280, 720), PixelSize.parse("1280x720"))
        assertEquals(PixelSize(1440, 1080), PixelSize.parse(" 1440X1080 "))
        assertNull(PixelSize.parse(null))
        assertNull(PixelSize.parse("1280"))
        assertNull(PixelSize.parse("0x720"))
        assertNull(PixelSize.parse("wide x tall"))
        assertEquals("1920x1080", CameraChoice.DEFAULT_SIZE.toString())
    }
}
