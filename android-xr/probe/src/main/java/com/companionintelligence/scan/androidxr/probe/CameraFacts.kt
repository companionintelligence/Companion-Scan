package com.companionintelligence.scan.androidxr.probe

import com.companionintelligence.scan.quest.pose.CameraTimestampSource
import com.companionintelligence.scan.quest.pose.CoordinateConversions
import com.companionintelligence.scan.quest.pose.PinholeIntrinsics
import com.companionintelligence.scan.quest.pose.PixelRect
import com.companionintelligence.scan.quest.pose.RigidPose
import kotlin.math.PI
import kotlin.math.atan

/**
 * The Camera2 characteristics of the camera the probe opened, kept as Camera2 reported them, so probe.json records them
 * unconverted and every derived value can be recomputed. Pure Kotlin: AuraCamera fills it from CameraCharacteristics.
 * The Quest's CameraCalibration is the same idea, tied to Meta's vendor keys.
 */
data class CameraFacts(
    val id: String,
    val facing: Facing,
    val hardwareLevel: String,
    val capabilities: List<String>,
    val timestampSource: CameraTimestampSource,
    /** SENSOR_READOUT_TIMESTAMP's name (HARDWARE, NOT_SUPPORTED), or null when the camera does not say. */
    val readoutTimestamp: String?,
    /** LENS_POSE_TRANSLATION, metres, Android sensor axes; null when not reported. */
    val lensPoseTranslation: FloatArray?,
    /** LENS_POSE_ROTATION, (x, y, z, w); null when not reported. */
    val lensPoseRotation: FloatArray?,
    /** LENS_POSE_REFERENCE's name; null when not reported. */
    val lensPoseReference: String?,
    /** LENS_INTRINSIC_CALIBRATION: fx, fy, cx, cy, skew in pre-correction active array pixels; null when not reported. */
    val intrinsicCalibration: FloatArray?,
    /** LENS_DISTORTION; null when not reported. */
    val distortion: FloatArray?,
    val focalLengthsMm: FloatArray,
    val physicalSizeMm: Pair<Float, Float>?,
    val pixelArraySize: PixelSize?,
    val preCorrectionActiveArray: PixelRect?,
    val activeArray: PixelRect?,
    val sensorOrientation: Int?,
    val yuvSizes: List<PixelSize>,
    val aeTargetFpsRanges: List<Pair<Int, Int>>,
    /** The YUV_420_888 stream the probe opened. */
    val stream: PixelSize,
) {
    /** True when the lens pose was reported in full; otherwise [headFromCamera] is partly or wholly the identity. */
    val hasLensPose: Boolean
        get() = (lensPoseTranslation?.size ?: 0) >= 3 && (lensPoseRotation?.size ?: 0) >= 4

    /** The camera in the device frame, Spatial SDK convention, as AndroidXrConversions.keyframePose takes it. */
    val headFromCamera: RigidPose
        get() = CoordinateConversions.headFromCamera(lensPoseTranslation, lensPoseRotation)

    /** Intrinsics in the stream's grid, with where they came from. */
    data class StreamIntrinsics(
        val intrinsics: PinholeIntrinsics,
        val source: String,
        val estimate: FocalLengthIntrinsics.Estimate?,
    )

    /**
     * From LENS_INTRINSIC_CALIBRATION when the camera reports a plausible one, otherwise estimated from the focal length
     * and physical size ([FocalLengthIntrinsics]); null when neither is possible, and then the probe writes no keyframes.
     *
     * Plausible means a positive focal length giving a horizontal field of view between 10° and 170°, and a principal
     * point inside the active array. The Aura's depth camera reports fx = fy = 2.4 and a principal point of (0, 0), which
     * look like its focal length in millimetres copied over, so a reported calibration is not taken on trust.
     */
    fun streamIntrinsics(): StreamIntrinsics? {
        val active = activeArray ?: return null
        val calibration = intrinsicCalibration
        if (calibration != null && isPlausible(calibration, active)) {
            val intrinsics = CoordinateConversions.intrinsicsForStream(
                calibration, preCorrectionActiveArray ?: active, active, stream.width, stream.height,
            )
            return StreamIntrinsics(intrinsics, SOURCE_CALIBRATION, null)
        }
        val focal = focalLengthsMm.firstOrNull() ?: return null
        val physical = physicalSizeMm ?: return null
        val pixels = pixelArraySize ?: return null
        val estimate = FocalLengthIntrinsics.estimate(
            focal, physical.first, physical.second, pixels.width, pixels.height, active, stream.width, stream.height,
        ) ?: return null
        val why = if (calibration == null) "not reported" else "implausible: ${calibration.joinToString(", ")}"
        return StreamIntrinsics(estimate.intrinsics, "$SOURCE_ESTIMATE (LENS_INTRINSIC_CALIBRATION $why)", estimate)
    }

    // FloatArray fields make the generated equals compare identities; nothing compares facts.

    companion object {
        const val SOURCE_CALIBRATION = "LENS_INTRINSIC_CALIBRATION"
        const val SOURCE_ESTIMATE = "estimate from the focal length and physical size"

        fun isPlausible(calibration: FloatArray, active: PixelRect): Boolean {
            if (calibration.size < 4) return false
            val fx = calibration[0]
            val fy = calibration[1]
            val cx = calibration[2]
            val cy = calibration[3]
            if (!(fx > 0f && fy > 0f)) return false
            val fovX = 2 * atan(active.width / (2.0 * fx)) * 180 / PI
            if (fovX < 10.0 || fovX > 170.0) return false
            return cx > 0f && cx < active.width && cy > 0f && cy < active.height
        }
    }
}
