package com.companionintelligence.scan.androidxr.probe

import kotlin.math.abs

/** A width and height in pixels (android.util.Size without the Android dependency). */
data class PixelSize(val width: Int, val height: Int) {
    override fun toString() = "${width}x$height"

    companion object {
        /** "1920x1080" → 1920 × 1080; null for anything else. */
        fun parse(text: String?): PixelSize? {
            val parts = text?.trim()?.lowercase()?.split('x') ?: return null
            if (parts.size != 2) return null
            val w = parts[0].toIntOrNull() ?: return null
            val h = parts[1].toIntOrNull() ?: return null
            return if (w > 0 && h > 0) PixelSize(w, h) else null
        }
    }
}

enum class Facing { BACK, FRONT, EXTERNAL, UNKNOWN }

/** What the probe needs to know about one Camera2 camera to choose camera 0. Filled from CameraCharacteristics. */
data class CameraDescription(
    val id: String,
    val facing: Facing,
    /** REQUEST_AVAILABLE_CAPABILITIES has BACKWARD_COMPATIBLE: an ordinary colour camera. */
    val backwardCompatible: Boolean,
    /** REQUEST_AVAILABLE_CAPABILITIES has DEPTH_OUTPUT. */
    val depthOutput: Boolean,
    /** The YUV_420_888 output sizes. */
    val yuvSizes: List<PixelSize>,
)

/**
 * Which camera and which stream size the probe opens.
 *
 * The Aura shows apps three cameras (`dumpsys media.camera`, 2026-11-24): `auracamerahal/0`, back-facing and
 * BACKWARD_COMPATIBLE, with YUV, PRIV and JPEG outputs; `avatar/1`, front-facing, apparently Android XR's synthetic avatar
 * stream; and `depthcamerahal/11`, back-facing and DEPTH_OUTPUT only. Google's note on Android XR (February 2025) names
 * camera_id 0 as "the main world-facing camera stream". The choice is the back-facing, backward-compatible camera with YUV
 * outputs, "0" first, so neither the avatar camera nor the depth camera can win.
 */
object CameraChoice {
    const val PREFERRED_ID = "0"

    /** The stream equal to camera 0's active array on the Aura, so no crop or scale assumption enters its intrinsics. */
    val DEFAULT_SIZE = PixelSize(1920, 1080)

    fun choose(cameras: List<CameraDescription>): CameraDescription? {
        val usable = cameras.filter { it.facing == Facing.BACK && it.backwardCompatible && it.yuvSizes.isNotEmpty() }
        return usable.firstOrNull { it.id == PREFERRED_ID } ?: usable.firstOrNull()
    }

    /** [wanted] when it is offered, otherwise the offered size closest to it in area (the Quest's rule, PassthroughCamera). */
    fun chooseSize(offered: List<PixelSize>, wanted: PixelSize): PixelSize? {
        if (offered.isEmpty()) return null
        offered.firstOrNull { it == wanted }?.let { return it }
        val area = wanted.width.toLong() * wanted.height
        return offered.minByOrNull { abs(it.width.toLong() * it.height - area) }
    }
}
