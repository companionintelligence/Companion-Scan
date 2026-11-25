package com.companionintelligence.scan.quest.pose

import kotlin.math.abs

/*
 * Which clock every timestamp is on, and the conversions between them.
 *
 * The pose ring buffer, the camera frames and the local dataset all use one clock: Android's boot clock,
 * SystemClock.elapsedRealtimeNanos() (CLOCK_BOOTTIME), called "realtime" below to match Camera2's
 * SENSOR_INFO_TIMESTAMP_SOURCE_REALTIME. Head pose does not come from Camera2, so the pose sampler stamps each
 * sample itself, on that clock.
 */

/** Camera2's `SENSOR_INFO_TIMESTAMP_SOURCE`: 0 = UNKNOWN, 1 = REALTIME. */
enum class CameraTimestampSource(val camera2Value: Int) {
    /**
     * Monotonic, "roughly in the same timebase as SystemClock#uptimeMillis" (Camera2 documentation), which on
     * Android is CLOCK_MONOTONIC, the clock System.nanoTime() reads.
     */
    UNKNOWN(0),

    /** The same timebase as SystemClock#elapsedRealtimeNanos. */
    REALTIME(1);

    companion object {
        fun fromCamera2(value: Int?): CameraTimestampSource = if (value == REALTIME.camera2Value) REALTIME else UNKNOWN
    }
}

/** Reads realtime − monotonic (the time the device has spent in deep sleep since boot). Injected for tests. */
fun interface ClockOffsets {
    fun realtimeMinusMonotonicNs(): Long
}

/**
 * Puts camera timestamps on the realtime clock. A REALTIME camera needs nothing. An UNKNOWN (monotonic) camera
 * gets the current realtime − monotonic offset added, read at conversion time; the offset only changes while the
 * device sleeps, which it does not do mid-capture.
 */
class CameraClock(val source: CameraTimestampSource, private val offsets: ClockOffsets) {
    fun toRealtimeNs(cameraTimestampNs: Long): Long = when (source) {
        CameraTimestampSource.REALTIME -> cameraTimestampNs
        CameraTimestampSource.UNKNOWN -> cameraTimestampNs + offsets.realtimeMinusMonotonicNs()
    }

    fun fromRealtimeNs(realtimeNs: Long): Long = when (source) {
        CameraTimestampSource.REALTIME -> realtimeNs
        CameraTimestampSource.UNKNOWN -> realtimeNs - offsets.realtimeMinusMonotonicNs()
    }

    /** A short label for logs, the panel and the dataset metadata. */
    val label: String get() = when (source) {
        CameraTimestampSource.REALTIME -> "REALTIME (boot clock, used as is)"
        CameraTimestampSource.UNKNOWN -> "UNKNOWN (monotonic, converted to the boot clock)"
    }
}

/** How a head pose sample was stamped. */
enum class PoseTimeSource {
    /**
     * The OpenXR predicted display time of the frame the pose was read in, converted to realtime. Used when the
     * SDK's frame timing is valid and its time is within [PoseClock.MONOTONIC_PLAUSIBILITY_NS] of
     * System.nanoTime(), which is what XrTime on CLOCK_MONOTONIC would look like. That check is a heuristic.
     */
    PREDICTED_DISPLAY_TIME,

    /** The time the pose was read. Biased early if the SDK hands out a display-time-predicted pose. */
    READ_TIME,

    /**
     * Android XR only (the probe in android-xr/, which compiles this file): the time mark of the ARCore for Jetpack XR
     * update the pose came from, moved onto realtime by the mark's age. The library asks its OpenXR runtime for the device
     * at that time; whether the runtime returns the pose at that time or the last one it had is not documented. The Quest
     * app never stamps a pose this way.
     */
    XR_UPDATE_TIME,
}

data class PoseStamp(val realtimeNs: Long, val source: PoseTimeSource, val xrTimeNs: Long?)

/**
 * Stamps a head pose. `Scene.getViewerPose()` returns a pose with no time. A renderer normally locates the head
 * at the frame's predicted display time, some tens of milliseconds after it is read, so stamping with the read
 * time would lag every pose by that much. When the frame timing is usable the pose is stamped with the display
 * time instead. Which pose time the SDK uses is not documented; both the choice and the lead are reported.
 */
object PoseClock {
    /** How far an XrTime may sit from System.nanoTime() and still be read as being on CLOCK_MONOTONIC. */
    const val MONOTONIC_PLAUSIBILITY_NS = 500_000_000L

    fun stamp(
        readRealtimeNs: Long,
        readMonotonicNs: Long,
        predictedDisplayTimeNs: Long?,
        timingValid: Boolean,
    ): PoseStamp {
        if (timingValid && predictedDisplayTimeNs != null && predictedDisplayTimeNs > 0 &&
            abs(predictedDisplayTimeNs - readMonotonicNs) < MONOTONIC_PLAUSIBILITY_NS
        ) {
            val realtime = predictedDisplayTimeNs + (readRealtimeNs - readMonotonicNs)
            return PoseStamp(realtime, PoseTimeSource.PREDICTED_DISPLAY_TIME, predictedDisplayTimeNs)
        }
        return PoseStamp(readRealtimeNs, PoseTimeSource.READ_TIME, predictedDisplayTimeNs)
    }
}

/**
 * Maps realtime nanoseconds to Unix milliseconds from one (realtime, Unix) pair read together at the start of a
 * recording, the way OpenQuestCapture maps its camera and pose clocks (baseMonoTimeNs / baseUnixTimeMs). Frame
 * names and `hmd_poses.csv`'s `unix_time` both come from here, so they agree to the millisecond.
 */
class UnixMsMapper(val baseRealtimeNs: Long, val baseUnixMs: Long) {
    fun unixMs(realtimeNs: Long): Long = baseUnixMs + Math.floorDiv(realtimeNs - baseRealtimeNs, 1_000_000L)
}
