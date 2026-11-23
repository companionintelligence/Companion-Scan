package com.companionintelligence.scan.quest.pose

import kotlin.math.PI
import kotlin.math.atan

/**
 * Every change of coordinate convention in the app, in one place. Pure Kotlin: no Android or Spatial SDK type
 * appears here, so CoordinateConversionsTest checks exactly what the app runs.
 *
 * ## The frames
 *
 * **S, the Spatial SDK scene** (what `Scene.getViewerPose()` returns and `Transform` takes). +X right, +Y up,
 * +Z forward, so left-handed. Evidence, all from meta-spatial-sdk 0.15.0: `Vector3.Right/Up/Forward` are
 * (1,0,0), (0,1,0) and (0,0,1) and `Pose.forward()` returns the rotation's third column (both read from the AAR
 * bytecode); `Scene.getEyeOffsets()` documents "Positive X values offset to the right, Positive Y values offsets
 * up, and positive Z offsets forward"; `Quaternion.times(Vector3)` is the Hamilton q·v·q⁻¹. A head pose maps the
 * head frame (X right, Y up, Z forward) into S.
 *
 * **G, the Companion Scan keyframe frame.** Camera-to-world in the OpenGL/Blender convention: right-handed, +Y
 * up, the camera looks down its own −Z with +X right and +Y up in the image. The splat dataset builder drops the
 * pose straight into a Nerfstudio `transform_matrix` with no flip (server/splat/splat_train_dataset.ts,
 * `poseToMatrix`), and the registration code reads the viewing direction as minus the third column
 * (server/register/session_priors.ts, `pairImagesFromKeyframes`).
 *
 * **U, the mq3drecon `hmd_poses.csv` frame.** Unity: Y-up, left-handed, head-to-world, quaternion (x, y, z, w)
 * (mq3drecon models/transforms.py `CoordinateSystem.UNITY`; dataio/helpers/pose_interpolator.py reads the
 * columns). OpenQuestCapture writes it from OVRPlugin's head pose after OVR's conversion to Unity coordinates
 * (Assets/RealityLog/Scripts/Runtime/OVR/PoseLogger.cs).
 *
 * **D, the Android device frame** that Camera2's `LENS_POSE_TRANSLATION` and `LENS_POSE_ROTATION` are given in:
 * the Android sensor coordinate system, right-handed, +X right, +Y up, +Z out of the display. On a headset the
 * display faces the wearer, so +Z points backwards out of the face.
 *
 * **C, the Camera2 camera frame**: +X along image rows, +Y down the image, +Z along the optical axis into the
 * scene (OpenCV style). The `CameraCharacteristics.LENS_INTRINSIC_CALIBRATION` documentation writes the
 * projection as K · [R | −R·t] with R from `LENS_POSE_ROTATION` and t from `LENS_POSE_TRANSLATION`, so
 * p_C = R · (p_D − t): R turns device coordinates into camera coordinates and t is the optical centre in D.
 *
 * ## Assumptions (none of these has been checked on a headset)
 *
 * - **A1.** S is the right-handed OpenXR space mirrored in Z, the way Unity's is. Then S and U are the same
 *   convention, up to the origin, which is arbitrary per capture anyway, and S → G is the Z mirror.
 * - **A2.** The device frame D is the head frame that `getViewerPose()` reports, with its Z flipped (so D is the
 *   head frame in right-handed form), and the lens pose origin (`LENS_POSE_REFERENCE`) is that head origin.
 *   mq3drecon reads OpenQuestCapture's raw lens pose the same way (dataio/image_data_io.py,
 *   `load_camera_characteristics`): Z-flip, invert, then a half turn about X.
 * - **A3.** Without a `SCALER_CROP_REGION`, a stream is the active array centre-cropped to the stream's aspect
 *   ratio and scaled to the stream size (Camera2's output cropping rules); see [intrinsicsForStream].
 */
object CoordinateConversions {

    /** The Z mirror diag(1, 1, −1) applied to a point: p' = M·p. */
    fun mirrorZ(p: Vec3) = Vec3(p.x, p.y, -p.z)

    /**
     * The Z mirror applied to a rotation as a change of basis, R' = M·R·M. For a quaternion that is
     * (−x, −y, z, w): the axis is mirrored and, because a mirror reverses handedness, the angle changes sign.
     */
    fun mirrorZ(q: Quat) = Quat(-q.x, -q.y, q.z, q.w)

    fun mirrorZ(pose: RigidPose) = RigidPose(mirrorZ(pose.position), mirrorZ(pose.rotation))

    /**
     * A camera-to-scene pose in S (camera looking down its +Z, +Y up) → the Companion Scan keyframe pose in G
     * (camera looking down its −Z, +Y up). The mirror acts on both sides of the transform, world and camera, so
     * the camera's forward axis +Z becomes −Z while right and up keep their meaning. Under A1 this is exact.
     */
    fun spatialToCompanionScan(cameraToScene: RigidPose): RigidPose = mirrorZ(cameraToScene)

    /** The inverse of [spatialToCompanionScan] (the mirror is its own inverse). */
    fun companionScanToSpatial(cameraToWorld: RigidPose): RigidPose = mirrorZ(cameraToWorld)

    /**
     * A head-to-scene pose in S → an `hmd_poses.csv` row's pose in U. Under A1 the two conventions are the same,
     * so this is the identity. It exists so the assumption is written down in one place, and the CSV writer
     * cannot skip it.
     */
    fun spatialToMq3dreconHmd(headToScene: RigidPose): RigidPose = headToScene

    /** The inverse of [spatialToMq3dreconHmd]. */
    fun mq3dreconHmdToSpatial(headToWorld: RigidPose): RigidPose = headToWorld

    /** A half turn about X: maps a camera frame with Y down and Z forward (C) to one with Y up and Z backward. */
    private val HALF_TURN_X = Quat(1.0, 0.0, 0.0, 0.0)

    /**
     * The camera's pose in the head frame, in the S convention (camera +X right, +Y up, +Z forward), from the raw
     * Camera2 values `LENS_POSE_TRANSLATION` (x, y, z in metres) and `LENS_POSE_ROTATION` (x, y, z, w).
     *
     * Derivation, under A2: p_D = Rᵀ·p_C + t; head coordinates are p_H = M·p_D; the S-style camera frame is
     * p_C = F·p_K with F = diag(1, −1, 1). So p_H = (M·Rᵀ·F)·p_K + M·t, and M·Rᵀ·F = (M·R·M)⁻¹ · (M·F), where
     * M·F = diag(1, −1, −1) is the half turn about X. This is the same composition mq3drecon applies to
     * OpenQuestCapture's raw values, so a dataset written with those raw values and the head poses from
     * [spatialToMq3dreconHmd] gives mq3drecon the camera poses this function gives the uploader.
     *
     * A missing or short array (Camera2 returns null when the camera cannot state its pose) gives the identity
     * for that part; the caller reports it.
     */
    fun headFromCamera(lensTranslation: FloatArray?, lensRotationXyzw: FloatArray?): RigidPose {
        val t = if (lensTranslation != null && lensTranslation.size >= 3) {
            Vec3(lensTranslation[0].toDouble(), lensTranslation[1].toDouble(), lensTranslation[2].toDouble())
        } else {
            Vec3.ZERO
        }
        val rotation = if (lensRotationXyzw != null && lensRotationXyzw.size >= 4) {
            val q = Quat(
                lensRotationXyzw[0].toDouble(),
                lensRotationXyzw[1].toDouble(),
                lensRotationXyzw[2].toDouble(),
                lensRotationXyzw[3].toDouble(),
            )
            (mirrorZ(q).inverse() * HALF_TURN_X).normalized()
        } else {
            // No lens rotation stated: assume the camera looks where the head looks.
            Quat.IDENTITY
        }
        return RigidPose(mirrorZ(t), rotation)
    }

    /** The camera's pose in S: the head pose (in S) composed with the camera's pose in the head frame. */
    fun cameraPoseInScene(headToScene: RigidPose, headFromCamera: RigidPose): RigidPose = headToScene * headFromCamera

    /**
     * The whole chain for one keyframe: interpolated head pose in S plus the lens extrinsics → the pose the
     * uploader sends as `meta.pose`.
     */
    fun keyframePose(headToScene: RigidPose, headFromCamera: RigidPose): RigidPose =
        spatialToCompanionScan(cameraPoseInScene(headToScene, headFromCamera))

    /**
     * A point of a splat trained from Companion Scan keyframes (in G) → the scene S. The splat's own points are
     * in G, so showing it in S takes the Z mirror, which no rotation can do. The splat viewer therefore gives the
     * entity a scale of [SPLAT_MIRROR_SCALE]; whether the SDK's splat renderer honours a negative scale is not
     * known (see SplatViewer).
     */
    fun companionScanPointToScene(p: Vec3): Vec3 = mirrorZ(p)

    /** Entity scale that applies the G → S mirror to a splat placed at the scene origin. */
    val SPLAT_MIRROR_SCALE = Vec3(1.0, 1.0, -1.0)

    /**
     * Yaw (about +Y in S) that turns the +Z axis to point along the horizontal part of [direction]. Used to
     * face a panel; FollowableSystem in the 0.15.0 toolkit orients a followed entity so that its +Z points away
     * from the viewer (lookRotation towards the viewer, then the default offset's half turn).
     */
    fun yawFacing(direction: Vec3): Quat {
        val flat = Vec3(direction.x, 0.0, direction.z)
        if (flat.length() < 1e-6) return Quat.IDENTITY
        val angle = kotlin.math.atan2(flat.x, flat.z)
        return Quat.fromAxisAngle(Vec3.Y, angle)
    }

    // ── Pixel grids ────────────────────────────────────────────────────────────────────────────────────────

    /**
     * Converts Camera2's intrinsic calibration to the grid of an output stream.
     *
     * `LENS_INTRINSIC_CALIBRATION` is [f_x, f_y, c_x, c_y, s] in pixels of `SENSOR_INFO_PRE_CORRECTION_ACTIVE_ARRAY_SIZE`,
     * with (0, 0) at that rectangle's top-left. Under A3 the stream is the active array, centre-cropped to the
     * stream's aspect ratio and scaled to the stream size. The pre-correction → active step here is the offset
     * between the two rectangles only; a camera with distortion correction on would also warp, which this ignores.
     * Skew is dropped (the server's pinhole model has none).
     */
    fun intrinsicsForStream(
        calibration: FloatArray,
        preCorrectionActiveArray: PixelRect,
        activeArray: PixelRect,
        streamWidth: Int,
        streamHeight: Int,
    ): PinholeIntrinsics {
        require(calibration.size >= 4) { "LENS_INTRINSIC_CALIBRATION needs at least fx, fy, cx, cy" }
        require(streamWidth > 0 && streamHeight > 0) { "stream size must be positive" }
        require(activeArray.width > 0 && activeArray.height > 0) { "active array must be non-empty" }
        val cxActive = calibration[2] + (preCorrectionActiveArray.left - activeArray.left)
        val cyActive = calibration[3] + (preCorrectionActiveArray.top - activeArray.top)

        val aw = activeArray.width.toDouble()
        val ah = activeArray.height.toDouble()
        val streamAspect = streamWidth.toDouble() / streamHeight
        val cropW: Double
        val cropH: Double
        if (streamAspect > aw / ah) {
            cropW = aw
            cropH = aw / streamAspect
        } else {
            cropH = ah
            cropW = ah * streamAspect
        }
        val offsetX = (aw - cropW) / 2
        val offsetY = (ah - cropH) / 2
        val scale = streamWidth / cropW
        return PinholeIntrinsics(
            fx = calibration[0] * scale,
            fy = calibration[1] * scale,
            cx = (cxActive - offsetX) * scale,
            cy = (cyActive - offsetY) * scale,
            width = streamWidth,
            height = streamHeight,
        )
    }
}

/** A Camera2 pixel rectangle (`android.graphics.Rect` without the Android dependency). */
data class PixelRect(val left: Int, val top: Int, val right: Int, val bottom: Int) {
    val width get() = right - left
    val height get() = bottom - top
}

/** Pinhole intrinsics in the pixel grid of a [width] × [height] image. */
data class PinholeIntrinsics(
    val fx: Double,
    val fy: Double,
    val cx: Double,
    val cy: Double,
    val width: Int,
    val height: Int,
) {
    /** Vertical field of view, the `fovYDeg` the web client sends. */
    val fovYDeg: Double get() = 2 * atan(height / (2 * fy)) * 180 / PI

    val aspect: Double get() = width.toDouble() / height

    /** The same camera in a uniformly rescaled image (for a downscaled JPEG). */
    fun scaledTo(newWidth: Int, newHeight: Int): PinholeIntrinsics {
        val sx = newWidth.toDouble() / width
        val sy = newHeight.toDouble() / height
        return PinholeIntrinsics(fx * sx, fy * sy, cx * sx, cy * sy, newWidth, newHeight)
    }
}
