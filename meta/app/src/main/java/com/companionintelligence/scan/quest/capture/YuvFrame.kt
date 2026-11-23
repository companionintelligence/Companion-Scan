package com.companionintelligence.scan.quest.capture

/**
 * One plane of a YUV_420_888 image, copied out of the camera's buffer byte for byte (the whole remaining
 * buffer, padding included), with the strides Camera2 reported for it.
 */
class YuvPlane(val bytes: ByteArray, val rowStride: Int, val pixelStride: Int) {
    val bufferSize: Int get() = bytes.size
}

/**
 * A camera frame copied off the ImageReader so the Image can be closed at once. Pure Kotlin (the copy itself is
 * in PassthroughCamera.kt), so the NV21 conversion and the dataset writer are testable on the JVM.
 *
 * With pixelStride 2 the U and V buffers are two views of one interleaved chroma buffer, as Android hands them
 * out; each is still copied whole. Concatenating y, u and v gives the `.yuv` layout mq3drecon reads.
 */
class YuvFrame(
    val width: Int,
    val height: Int,
    /** Image.getTimestamp(), on the camera's own clock. */
    val cameraTimestampNs: Long,
    /** The same instant on the realtime clock (see pose/Clocks.kt). */
    val realtimeNs: Long,
    val y: YuvPlane,
    val u: YuvPlane,
    val v: YuvPlane,
) {
    val planes: List<YuvPlane> get() = listOf(y, u, v)

    /** NV21 (full Y plane, then interleaved V, U), the input android.graphics.YuvImage takes for JPEG encoding. */
    fun toNv21(): ByteArray {
        val out = ByteArray(width * height * 3 / 2)
        var o = 0
        for (row in 0 until height) {
            val start = row * y.rowStride
            if (y.pixelStride == 1) {
                System.arraycopy(y.bytes, start, out, o, width)
                o += width
            } else {
                for (col in 0 until width) out[o++] = y.bytes[start + col * y.pixelStride]
            }
        }
        val chromaWidth = width / 2
        val chromaHeight = height / 2
        for (row in 0 until chromaHeight) {
            val uRow = row * u.rowStride
            val vRow = row * v.rowStride
            for (col in 0 until chromaWidth) {
                out[o++] = v.bytes[vRow + col * v.pixelStride]
                out[o++] = u.bytes[uRow + col * u.pixelStride]
            }
        }
        return out
    }

    /** Luma at (col, row). */
    fun lumaAt(col: Int, row: Int): Int = y.bytes[row * y.rowStride + col * y.pixelStride].toInt() and 0xFF

    /** (Y, U, V) at (col, row), chroma from the 2×2 block it belongs to. */
    fun yuvAt(col: Int, row: Int): Triple<Int, Int, Int> {
        val cc = col / 2
        val cr = row / 2
        val uu = u.bytes[cr * u.rowStride + cc * u.pixelStride].toInt() and 0xFF
        val vv = v.bytes[cr * v.rowStride + cc * v.pixelStride].toInt() and 0xFF
        return Triple(lumaAt(col, row), uu, vv)
    }
}
