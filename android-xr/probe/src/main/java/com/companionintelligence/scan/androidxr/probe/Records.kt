package com.companionintelligence.scan.androidxr.probe

import com.companionintelligence.scan.quest.pose.PoseTimeSource
import com.companionintelligence.scan.quest.pose.RigidPose

/** One ARCore for Jetpack XR update as the probe saw it, kept or not. A row of poses.csv. */
data class PoseRecord(
    /** 0 for the first update handled, then +1 per update. */
    val sequence: Long,
    /** The pose's time on the boot clock ([XrPoseStamp]). */
    val poseRealtimeNs: Long,
    /** When the probe handled it, on the boot clock (the middle of the bracket around the age read). */
    val readRealtimeNs: Long,
    /** The update's time mark's age when handled, on the XR clock. */
    val ageNs: Long,
    val uncertaintyNs: Long,
    /** This update's mark minus the first handled update's, on the XR clock: the rate check's reference. */
    val markSinceFirstNs: Long,
    val source: PoseTimeSource,
    /** The library's TrackingState (TRACKING, PAUSED, STOPPED). */
    val tracking: String,
    val verdict: TrackingGate.Verdict,
    /** The keyframe epoch at [poseRealtimeNs], after the gate's verdict. */
    val epoch: Int,
    /** The device pose, Jetpack XR's frame (which is the keyframe frame). */
    val pose: RigidPose,
)

/** One camera frame as it reached the probe. A row of frames.csv, with its [CaptureTiming] joined in. */
data class FrameRecord(
    /** Image.getTimestamp(), on the camera's clock: the start of exposure. */
    val cameraTimestampNs: Long,
    /** The same instant on the boot clock (CameraClock). */
    val frameRealtimeNs: Long,
    /** When the ImageReader handed it to the probe, on the boot clock. */
    val arrivalRealtimeNs: Long,
)

/** The capture result for one frame, joined to its [FrameRecord] by the sensor timestamp. */
data class CaptureTiming(
    val sensorTimestampNs: Long,
    val exposureNs: Long?,
    val rollingShutterSkewNs: Long?,
    /** The start of readout (CaptureCallback.onReadoutStarted, API 34), when the camera reports it. */
    val readoutTimestampNs: Long?,
    val frameDurationNs: Long?,
)
