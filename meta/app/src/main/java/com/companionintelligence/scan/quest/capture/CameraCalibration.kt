package com.companionintelligence.scan.quest.capture

import com.companionintelligence.scan.quest.pose.CameraTimestampSource
import com.companionintelligence.scan.quest.pose.CoordinateConversions
import com.companionintelligence.scan.quest.pose.PinholeIntrinsics
import com.companionintelligence.scan.quest.pose.PixelRect
import com.companionintelligence.scan.quest.pose.RigidPose

/**
 * The Camera2 characteristics of the chosen passthrough camera, kept raw (as Camera2 reported them) so that the
 * local dataset can record them unconverted, the way OpenQuestCapture does, and so every derived value can be
 * recomputed offline. Pure Kotlin: PassthroughCamera.kt fills it from CameraCharacteristics.
 */
data class CameraCalibration(
    val cameraId: String,
    /** Vendor key com.meta.extra_metadata.camera_source (0 = passthrough), or null when the camera lacks it. */
    val cameraSource: Int?,
    /** Vendor key com.meta.extra_metadata.position (0 = left, 1 = right, from the wearer's view). */
    val cameraPosition: Int?,
    val lensFacing: String,
    val hardwareLevel: String,
    /** LENS_POSE_TRANSLATION, metres, Android sensor axes. Null when Camera2 did not report it. */
    val lensPoseTranslation: FloatArray?,
    /** LENS_POSE_ROTATION, quaternion (x, y, z, w), device → camera. */
    val lensPoseRotation: FloatArray?,
    /** LENS_POSE_REFERENCE as a name (PRIMARY_CAMERA, GYROSCOPE, UNDEFINED, AUTOMOTIVE). */
    val lensPoseReference: String,
    /** LENS_INTRINSIC_CALIBRATION: fx, fy, cx, cy, skew, in pre-correction active array pixels. */
    val intrinsicCalibration: FloatArray?,
    /** LENS_DISTORTION: kappa_1 … kappa_5 (radial k1, k2, k3, tangential p1, p2). */
    val distortion: FloatArray?,
    val availableFocalLengths: FloatArray,
    val physicalSizeMm: Pair<Float, Float>?,
    val pixelArraySize: Pair<Int, Int>?,
    val preCorrectionActiveArray: PixelRect?,
    val activeArray: PixelRect?,
    val timestampSource: CameraTimestampSource,
    /** SENSOR_ORIENTATION in degrees, recorded for diagnosis only (the lens pose already carries the rotation). */
    val sensorOrientation: Int?,
    /** The YUV_420_888 stream size the app opened. */
    val streamWidth: Int,
    val streamHeight: Int,
) {
    /** The camera's pose in the head frame (Spatial SDK convention), from the raw lens pose. */
    val headFromCamera: RigidPose
        get() = CoordinateConversions.headFromCamera(lensPoseTranslation, lensPoseRotation)

    /** True when the lens pose was reported in full; otherwise headFromCamera is partly the identity. */
    val hasLensPose: Boolean
        get() = (lensPoseTranslation?.size ?: 0) >= 3 && (lensPoseRotation?.size ?: 0) >= 4

    /**
     * Intrinsics in the stream's pixel grid, or null when Camera2 gave no calibration. See
     * [CoordinateConversions.intrinsicsForStream] for the cropping assumption.
     */
    fun streamIntrinsics(): PinholeIntrinsics? {
        val calibration = intrinsicCalibration ?: return null
        val active = activeArray ?: return null
        if (calibration.size < 4 || calibration[0] <= 0f || calibration[1] <= 0f) return null
        return CoordinateConversions.intrinsicsForStream(
            calibration,
            preCorrectionActiveArray ?: active,
            active,
            streamWidth,
            streamHeight,
        )
    }

    // FloatArray fields make the generated equals compare identities; nothing compares calibrations.
}
