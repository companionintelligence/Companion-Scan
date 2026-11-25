package com.companionintelligence.scan.androidxr.probe

import com.companionintelligence.scan.quest.pose.PoseTimeSource
import kotlin.math.abs
import kotlin.math.max

/** The numbers a probe run reports. Pure Kotlin: ProbeStatsTest runs it. */
object ProbeStats {

    data class PoseSummary(
        val updates: Int,
        val tracked: Int,
        /** Tracked updates per second over the tracked span; null with fewer than two. */
        val trackedRateHz: Double?,
        val ageMsMedian: Double?,
        val ageMsP95: Double?,
        val ageMsMax: Double?,
        val uncertaintyUsMax: Double?,
        /**
         * The XR clock against the boot clock over the run: how far the last stamp's distance from the first differs from
         * the marks' own distance, in microseconds. Zero when the two clocks run at one rate.
         */
        val clockDriftUs: Double?,
        /** [clockDriftUs] over the run's length, in parts per million. */
        val clockDriftPpm: Double?,
        /** The largest such difference at any update, in microseconds. */
        val clockResidualUsMax: Double?,
        val epochBumps: Int,
        /** How many updates came in each of the library's tracking states, in the order first seen. */
        val trackingStates: Map<String, Int>,
    )

    fun poses(records: List<PoseRecord>): PoseSummary {
        val tracked = records.filter { it.verdict != TrackingGate.Verdict.REJECTED }
        val marked = records.filter { it.source == PoseTimeSource.XR_UPDATE_TIME }
        val ages = marked.map { it.ageNs / 1e6 }.sorted()
        val rate = if (tracked.size >= 2) {
            val span = tracked.last().poseRealtimeNs - tracked.first().poseRealtimeNs
            if (span > 0) (tracked.size - 1) * 1e9 / span else null
        } else {
            null
        }
        var residualMax: Double? = null
        var drift: Double? = null
        var ppm: Double? = null
        if (marked.size >= 2) {
            val first = marked.first()
            for (r in marked) {
                val residual = (r.poseRealtimeNs - first.poseRealtimeNs) - (r.markSinceFirstNs - first.markSinceFirstNs)
                residualMax = max(residualMax ?: 0.0, abs(residual) / 1e3)
            }
            val last = marked.last()
            val residual = (last.poseRealtimeNs - first.poseRealtimeNs) - (last.markSinceFirstNs - first.markSinceFirstNs)
            drift = residual / 1e3
            val span = last.poseRealtimeNs - first.poseRealtimeNs
            if (span > 0) ppm = residual * 1e6 / span
        }
        return PoseSummary(
            updates = records.size,
            tracked = tracked.size,
            trackedRateHz = rate,
            ageMsMedian = percentile(ages, 0.5),
            ageMsP95 = percentile(ages, 0.95),
            ageMsMax = ages.lastOrNull(),
            uncertaintyUsMax = marked.maxOfOrNull { it.uncertaintyNs / 1e3 },
            clockDriftUs = drift,
            clockDriftPpm = ppm,
            clockResidualUsMax = residualMax,
            epochBumps = records.count {
                it.verdict == TrackingGate.Verdict.ACCEPTED_AFTER_LOSS || it.verdict == TrackingGate.Verdict.ACCEPTED_AFTER_JUMP
            },
            trackingStates = records.groupingBy { it.tracking }.eachCount(),
        )
    }

    data class FrameSummary(
        val frames: Int,
        val rateHz: Double?,
        val latencyMsMin: Double?,
        val latencyMsMedian: Double?,
        val latencyMsMax: Double?,
        /**
         * Every frame reached the probe between 0 and [MAX_PLAUSIBLE_LATENCY_NS] after its own timestamp, on the boot
         * clock. A camera whose timestamps are on another clock shows up here only when that clock is more than about half
         * a second away from the boot clock (for example once the device has slept since boot).
         */
        val cameraClockPlausible: Boolean,
    )

    const val MAX_PLAUSIBLE_LATENCY_NS = 500_000_000L

    fun frames(records: List<FrameRecord>): FrameSummary {
        val latencies = records.map { it.arrivalRealtimeNs - it.frameRealtimeNs }
        val sortedMs = latencies.map { it / 1e6 }.sorted()
        val rate = if (records.size >= 2) {
            val span = records.last().frameRealtimeNs - records.first().frameRealtimeNs
            if (span > 0) (records.size - 1) * 1e9 / span else null
        } else {
            null
        }
        return FrameSummary(
            frames = records.size,
            rateHz = rate,
            latencyMsMin = sortedMs.firstOrNull(),
            latencyMsMedian = percentile(sortedMs, 0.5),
            latencyMsMax = sortedMs.lastOrNull(),
            cameraClockPlausible = latencies.isNotEmpty() && latencies.all { it in 0..MAX_PLAUSIBLE_LATENCY_NS },
        )
    }

    /** Nearest-rank percentile of an already sorted list; null for an empty one. */
    fun percentile(sorted: List<Double>, p: Double): Double? {
        if (sorted.isEmpty()) return null
        val rank = kotlin.math.ceil(p * sorted.size).toInt().coerceIn(1, sorted.size)
        return sorted[rank - 1]
    }
}
