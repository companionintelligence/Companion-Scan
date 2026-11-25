package com.companionintelligence.scan.androidxr.probe

import com.companionintelligence.scan.quest.pose.CoordinateConversions
import com.companionintelligence.scan.quest.pose.PinholeIntrinsics
import com.companionintelligence.scan.quest.pose.PixelRect
import kotlin.math.abs

/**
 * Intrinsics for a camera that reports no LENS_INTRINSIC_CALIBRATION, estimated from its focal length and sensor size.
 * Everything made from it is marked as an estimate (probe.json, `intrinsics.source`).
 *
 * On the Aura (`dumpsys media.camera`, 2026-11-24), camera 0 reports:
 * - a 2.4 mm focal length;
 * - a physical size of 3.2 × 2.4 mm (4:3);
 * - a pixel array and an active array of 1920 × 1080 (16:9).
 *
 * Camera2 defines the physical size as the full pixel array's, but with these values the pixels would not be square
 * (1.667 µm across, 2.222 µm down). A 16:9 frame from a 4:3 sensor can only be a full-width crop, so the estimate takes the
 * width's pitch for both axes: f = 2.4 mm / (3.2 mm / 1920) = 1440 px. At 1920 × 1080 that is a 67.4° by 41.1° field of
 * view, with the principal point at the centre. The height's pitch would give 1080 px instead. Both go into probe.json, and
 * only a calibration settles which, if either, is right.
 *
 * The stream's grid comes from the active array by the Quest's rule A3 (CoordinateConversions.intrinsicsForStream:
 * centre-cropped to the stream's aspect, then scaled).
 */
object FocalLengthIntrinsics {

    /**
     * @property intrinsics in the stream's pixel grid
     * @property focalPxFromWidth the focal length in active-array pixels from the width's pitch, which [intrinsics] uses
     * @property focalPxFromHeight the same from the height's pitch
     * @property squarePixels whether the two pitches agree to within 1 %
     */
    data class Estimate(
        val intrinsics: PinholeIntrinsics,
        val focalPxFromWidth: Double,
        val focalPxFromHeight: Double,
        val squarePixels: Boolean,
    )

    fun estimate(
        focalLengthMm: Float,
        physicalWidthMm: Float,
        physicalHeightMm: Float,
        pixelArrayWidth: Int,
        pixelArrayHeight: Int,
        activeArray: PixelRect,
        streamWidth: Int,
        streamHeight: Int,
    ): Estimate? {
        if (!(focalLengthMm > 0f && physicalWidthMm > 0f && physicalHeightMm > 0f)) return null
        if (pixelArrayWidth <= 0 || pixelArrayHeight <= 0 || activeArray.width <= 0 || activeArray.height <= 0) return null
        val pitchX = physicalWidthMm.toDouble() / pixelArrayWidth
        val pitchY = physicalHeightMm.toDouble() / pixelArrayHeight
        val fromWidth = focalLengthMm / pitchX
        val fromHeight = focalLengthMm / pitchY
        val calibration = floatArrayOf(
            fromWidth.toFloat(),
            fromWidth.toFloat(),
            activeArray.width / 2f,
            activeArray.height / 2f,
            0f,
        )
        val intrinsics = CoordinateConversions.intrinsicsForStream(calibration, activeArray, activeArray, streamWidth, streamHeight)
        return Estimate(intrinsics, fromWidth, fromHeight, squarePixels = abs(pitchX - pitchY) <= 0.01 * pitchX)
    }
}
