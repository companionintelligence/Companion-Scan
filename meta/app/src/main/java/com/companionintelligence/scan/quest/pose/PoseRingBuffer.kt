package com.companionintelligence.scan.quest.pose

/** One head pose sample: the pose in the Spatial SDK scene, stamped on the realtime clock (see Clocks.kt). */
data class PoseSample(
    /** 0 for the first sample ever added, then +1 per sample. */
    val sequence: Long,
    val realtimeNs: Long,
    val pose: RigidPose,
    /** The OpenXR time the sample was read with, or null when there was none. Goes into `ovr_timestamp`. */
    val xrTimeNs: Long?,
    val timeSource: PoseTimeSource,
)

/**
 * A fixed-size ring of head poses, written once per rendered frame and read by the camera pipeline.
 *
 * [add] runs on the render thread, so it allocates nothing and holds the lock only to copy a few numbers.
 * Samples must arrive in increasing time; one that does not is dropped.
 */
class PoseRingBuffer(val capacity: Int = 2048) {
    private val times = LongArray(capacity)
    private val xrTimes = LongArray(capacity)
    private val sources = arrayOfNulls<PoseTimeSource>(capacity)
    private val px = DoubleArray(capacity)
    private val py = DoubleArray(capacity)
    private val pz = DoubleArray(capacity)
    private val qx = DoubleArray(capacity)
    private val qy = DoubleArray(capacity)
    private val qz = DoubleArray(capacity)
    private val qw = DoubleArray(capacity)

    /** Number of samples ever added; the next sample's sequence. */
    private var count = 0L

    init {
        require(capacity >= 2) { "capacity must be at least 2" }
    }

    @Synchronized
    fun add(
        realtimeNs: Long,
        x: Double, y: Double, z: Double,
        rx: Double, ry: Double, rz: Double, rw: Double,
        xrTimeNs: Long?,
        source: PoseTimeSource,
    ): Boolean {
        if (count > 0 && realtimeNs <= times[slot(count - 1)]) return false
        val s = slot(count)
        times[s] = realtimeNs
        xrTimes[s] = xrTimeNs ?: Long.MIN_VALUE
        sources[s] = source
        px[s] = x; py[s] = y; pz[s] = z
        qx[s] = rx; qy[s] = ry; qz[s] = rz; qw[s] = rw
        count++
        return true
    }

    fun add(realtimeNs: Long, pose: RigidPose, xrTimeNs: Long?, source: PoseTimeSource): Boolean = add(
        realtimeNs,
        pose.position.x, pose.position.y, pose.position.z,
        pose.rotation.x, pose.rotation.y, pose.rotation.z, pose.rotation.w,
        xrTimeNs, source,
    )

    @Synchronized
    fun size(): Int = minOf(count, capacity.toLong()).toInt()

    @Synchronized
    fun latest(): PoseSample? = if (count == 0L) null else sampleAt(count - 1)

    @Synchronized
    fun newestTimeNs(): Long? = if (count == 0L) null else times[slot(count - 1)]

    /**
     * The pose at [realtimeNs], interpolated between the samples either side (position linearly, rotation by
     * slerp). Null when [realtimeNs] is outside the buffer or the two samples either side are more than
     * [maxGapNs] apart, so a tracking dropout is never bridged by a guess.
     */
    @Synchronized
    fun interpolate(realtimeNs: Long, maxGapNs: Long = 50_000_000L): RigidPose? {
        if (count == 0L) return null
        val oldest = maxOf(0L, count - capacity)
        val newest = count - 1
        val tOld = times[slot(oldest)]
        val tNew = times[slot(newest)]
        if (realtimeNs < tOld || realtimeNs > tNew) return null
        if (realtimeNs == tNew) return poseAt(newest)
        // Binary search for the last sample at or before realtimeNs.
        var lo = oldest
        var hi = newest
        while (hi - lo > 1) {
            val mid = (lo + hi) ushr 1
            if (times[slot(mid)] <= realtimeNs) lo = mid else hi = mid
        }
        val t0 = times[slot(lo)]
        val t1 = times[slot(hi)]
        if (realtimeNs == t0) return poseAt(lo)
        if (t1 - t0 > maxGapNs) return null
        val alpha = (realtimeNs - t0).toDouble() / (t1 - t0).toDouble()
        return lerpPose(poseAt(lo), poseAt(hi), alpha)
    }

    /**
     * Copies every sample with a sequence at or after [fromSequence] into [out] and returns the sequence to pass
     * next time. Samples that were overwritten before they were read are skipped; the gap is visible as a jump
     * in the returned samples' sequence numbers.
     */
    @Synchronized
    fun drainSince(fromSequence: Long, out: MutableList<PoseSample>): Long {
        val first = maxOf(fromSequence, count - capacity, 0L)
        for (seq in first until count) out.add(sampleAt(seq))
        return count
    }

    private fun slot(sequence: Long): Int = (sequence % capacity).toInt()

    private fun poseAt(sequence: Long): RigidPose {
        val s = slot(sequence)
        return RigidPose(Vec3(px[s], py[s], pz[s]), Quat(qx[s], qy[s], qz[s], qw[s]))
    }

    private fun sampleAt(sequence: Long): PoseSample {
        val s = slot(sequence)
        val xr = xrTimes[s]
        return PoseSample(
            sequence = sequence,
            realtimeNs = times[s],
            pose = poseAt(sequence),
            xrTimeNs = if (xr == Long.MIN_VALUE) null else xr,
            timeSource = sources[s] ?: PoseTimeSource.READ_TIME,
        )
    }
}
