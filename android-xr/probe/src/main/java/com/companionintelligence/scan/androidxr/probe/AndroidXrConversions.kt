package com.companionintelligence.scan.androidxr.probe

import com.companionintelligence.scan.quest.pose.CoordinateConversions
import com.companionintelligence.scan.quest.pose.Quat
import com.companionintelligence.scan.quest.pose.RigidPose
import com.companionintelligence.scan.quest.pose.Vec3

/**
 * Android XR's poses in the Companion Scan keyframe frame. Pure Kotlin: AndroidXrConversionsTest runs this code.
 *
 * ## The frames
 *
 * **J, Jetpack XR's frame** (androidx.xr.runtime 1.0.0, `androidx.xr.runtime.math`). `Vector3.Right`, `Up` and `Forward`
 * are (1, 0, 0), (0, 1, 0) and (0, 0, −1), so it is right-handed, +Y up, looking down −Z. `Pose.forward` is
 * `rotation * Vector3.Forward`. `Quaternion` takes (x, y, z, w), and its `times(Vector3)` is the Hamilton q·v·q⁻¹. A device
 * pose maps the device frame (the same axes) into the session's world, from "the center of the device" (the library's
 * DeviceState).
 *
 * That is the keyframe convention G of the Quest's CoordinateConversions.kt already: a device pose is the camera-to-world
 * pose of a camera at the device-pose origin, looking where the glasses look. AndroidXrConversionsTest pins all of this to
 * the library's own classes, as the Quest's test pins the Spatial SDK's.
 *
 * ## The camera's place on the glasses
 *
 * The Quest chain composes the head pose with Camera2's lens pose (CoordinateConversions.headFromCamera, which answers in
 * the Spatial SDK's mirrored frame S). Here the device pose is mirrored into S, put through that same chain, and comes back
 * mirrored into G. The mirror distributes over composition, so this is the device pose composed with the lens pose in G;
 * the test checks that against a derivation made directly in G.
 *
 * ## Assumption (not checked on a device)
 *
 * - **X1.** Camera2's device frame D (the Android sensor frame: +X right, +Y up, +Z out of the display) is the device-pose
 *   frame J, and the lens pose's origin is the device-pose origin. It is the Quest's A2 restated for J: no Z flip is
 *   needed, because J and D are both right-handed, with +Z towards the wearer. On the Aura, camera 0 reports no lens pose
 *   at all (2026-11-24), so until a calibration supplies one, the keyframe pose is the device pose itself.
 */
object AndroidXrConversions {

    /** A Jetpack XR pose's components, copied by name. */
    fun rigidPose(tx: Float, ty: Float, tz: Float, qx: Float, qy: Float, qz: Float, qw: Float): RigidPose = RigidPose(
        Vec3(tx.toDouble(), ty.toDouble(), tz.toDouble()),
        Quat(qx.toDouble(), qy.toDouble(), qz.toDouble(), qw.toDouble()),
    )

    /**
     * The keyframe pose (camera-to-world, G) of a frame taken at [devicePose] (in J, which is G). [headFromCamera] is what
     * CoordinateConversions.headFromCamera makes of Camera2's raw lens pose: the identity when the camera reports none.
     */
    fun keyframePose(devicePose: RigidPose, headFromCamera: RigidPose): RigidPose =
        CoordinateConversions.keyframePose(CoordinateConversions.mirrorZ(devicePose), headFromCamera)
}
