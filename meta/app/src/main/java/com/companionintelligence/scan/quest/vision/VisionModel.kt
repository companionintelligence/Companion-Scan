package com.companionintelligence.scan.quest.vision

import com.companionintelligence.scan.quest.capture.YuvFrame
import java.io.Closeable

/**
 * A hook for an on-device vision model over passthrough frames. In this pass its output stays on the headset:
 * a line on the panel and in the log. Nothing it produces is added to the uploaded keyframe meta.
 */
interface VisionModel : Closeable {
    val status: VisionStatus

    /** Looks for a model and opens it. Blocking (opening a model can take seconds); call off the render thread. */
    fun load()

    /** Runs the model on one frame, or returns null when no model is loaded. Blocking; call off the render thread. */
    fun analyze(frame: YuvFrame): VisionResult?
}

sealed interface VisionStatus {
    /** No model file was found. [expectedPath] is where one would be read from. */
    data class NotInstalled(val expectedPath: String) : VisionStatus

    data class Ready(val modelName: String, val inputs: String, val outputs: String) : VisionStatus

    data class Failed(val reason: String) : VisionStatus
}

data class VisionResult(val summary: String, val elapsedMs: Long)

/**
 * Converts a YUV_420_888 frame to a planar float RGB tensor (channel-first, values 0…1) of [outWidth] ×
 * [outHeight], sampling the nearest source pixel. Full-range BT.601, the JFIF convention Camera2's YUV output
 * normally uses. Pure, so it is unit-tested.
 */
fun yuvToPlanarRgb(frame: YuvFrame, outWidth: Int, outHeight: Int): FloatArray {
    require(outWidth > 0 && outHeight > 0) { "output size must be positive" }
    val plane = outWidth * outHeight
    val out = FloatArray(plane * 3)
    for (row in 0 until outHeight) {
        val sy = minOf(frame.height - 1, (row * frame.height) / outHeight)
        for (col in 0 until outWidth) {
            val sx = minOf(frame.width - 1, (col * frame.width) / outWidth)
            val (yy, u, v) = frame.yuvAt(sx, sy)
            val d = u - 128
            val e = v - 128
            val r = (yy + 1.402 * e).coerceIn(0.0, 255.0)
            val g = (yy - 0.344136 * d - 0.714136 * e).coerceIn(0.0, 255.0)
            val b = (yy + 1.772 * d).coerceIn(0.0, 255.0)
            val i = row * outWidth + col
            out[i] = (r / 255.0).toFloat()
            out[plane + i] = (g / 255.0).toFloat()
            out[2 * plane + i] = (b / 255.0).toFloat()
        }
    }
    return out
}
