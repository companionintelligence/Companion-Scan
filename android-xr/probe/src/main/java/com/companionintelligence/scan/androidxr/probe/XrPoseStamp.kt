package com.companionintelligence.scan.androidxr.probe

import com.companionintelligence.scan.quest.pose.PoseTimeSource
import kotlin.time.TimeMark

/**
 * Puts an ARCore for Jetpack XR pose on the boot clock, `SystemClock.elapsedRealtimeNanos()` ("realtime" in the Quest's
 * pose/Clocks.kt), which is the clock Camera2 stamps camera 0's frames on: the Aura's camera 0 reports
 * SENSOR_INFO_TIMESTAMP_SOURCE = REALTIME (read with `dumpsys media.camera`, 2026-11-24).
 *
 * What the library does, read in androidx.xr.arcore:arcore-openxr 1.0.0 (OpenXrRuntime.update) and
 * androidx.xr.arcore:arcore 1.0.0 (PerceptionStateExtender): each update marks the time on an OpenXR time source
 * (OpenXrTimeSource, which reads the runtime's XrTime), asks the runtime for the device at that XrTime, waits 20 ms, and
 * hands the mark on as `CoreState.timeMark`. `CoreState.perceptionState.arDeviceState` is the device state of that same
 * update. `ArDevice.State` itself carries no time.
 *
 * So a pose belongs to its update's mark, and the mark's age, `timeMark.elapsedNow()`, is read on that same XR clock when
 * the sample is handled. Reading realtime just before and just after the age gives the mark on the boot clock:
 *
 *     poseRealtime = (before + after) / 2 − age, give or take (after − before) / 2
 *
 * That assumes the XR clock and the boot clock run at the same rate over one age (tens of milliseconds). [ProbeStats]
 * checks the rate over a whole run, from the marks' own differences.
 *
 * What the runtime returns for that XrTime is not documented: a pose located at it, or the last one it had
 * (`DeviceTrackingMode.SPATIAL`: "provides the last known 6DoF ... pose", with "generally a delay"). The stamp is the
 * update's time, then, not a measured pose time, and the lag between them stays unmeasured until a recording is calibrated.
 */
object XrPoseStamp {
    /** An age past this, or below zero, says the mark is not on a clock this code understands. */
    const val MAX_PLAUSIBLE_AGE_NS = 1_000_000_000L

    /**
     * @property realtimeNs the pose's time on the boot clock
     * @property source [PoseTimeSource.XR_UPDATE_TIME] normally; [PoseTimeSource.READ_TIME] when the age was implausible
     * @property ageNs the mark's age as the XR clock gave it
     * @property uncertaintyNs half the realtime bracket around the age read
     * @property readRealtimeNs the middle of that bracket: when the sample was handled
     */
    data class Stamp(
        val realtimeNs: Long,
        val source: PoseTimeSource,
        val ageNs: Long,
        val uncertaintyNs: Long,
        val readRealtimeNs: Long,
    )

    /** Reads [mark]'s age between two reads of [realtimeNs] and stamps it: what the sampler does for each update. */
    fun stampMark(mark: TimeMark, realtimeNs: () -> Long): Stamp {
        val before = realtimeNs()
        val age = mark.elapsedNow().inWholeNanoseconds
        val after = realtimeNs()
        return stamp(before, age, after)
    }

    fun stamp(realtimeBeforeNs: Long, ageNs: Long, realtimeAfterNs: Long): Stamp {
        require(realtimeAfterNs >= realtimeBeforeNs) { "the realtime bracket runs backwards" }
        val width = realtimeAfterNs - realtimeBeforeNs
        val read = realtimeBeforeNs + width / 2
        val uncertainty = (width + 1) / 2
        if (ageNs < 0 || ageNs > MAX_PLAUSIBLE_AGE_NS) {
            return Stamp(read, PoseTimeSource.READ_TIME, ageNs, uncertainty, read)
        }
        return Stamp(read - ageNs, PoseTimeSource.XR_UPDATE_TIME, ageNs, uncertainty, read)
    }
}
