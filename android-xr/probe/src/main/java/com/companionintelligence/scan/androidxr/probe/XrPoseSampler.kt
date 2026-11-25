package com.companionintelligence.scan.androidxr.probe

import android.os.SystemClock
import androidx.activity.ComponentActivity
import androidx.lifecycle.lifecycleScope
import androidx.xr.arcore.PerceptionState
import androidx.xr.arcore.RenderViewpoint
import androidx.xr.arcore.TrackingState
import androidx.xr.arcore.perceptionState
import androidx.xr.runtime.Config
import androidx.xr.runtime.CoreState
import androidx.xr.runtime.DeviceTrackingMode
import androidx.xr.runtime.Session
import androidx.xr.runtime.SessionConfigureCalibrationRequired
import androidx.xr.runtime.SessionConfigureLibraryNotLinked
import androidx.xr.runtime.SessionConfigureSuccess
import androidx.xr.runtime.SessionConfigureUnknownError
import androidx.xr.runtime.SessionCreateApkRequired
import androidx.xr.runtime.SessionCreateSuccess
import androidx.xr.runtime.SessionCreateUnknownError
import com.companionintelligence.scan.quest.pose.EpochTracker
import com.companionintelligence.scan.quest.pose.PoseRingBuffer
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonObject
import kotlin.time.ComparableTimeMark

/**
 * The glasses' pose from ARCore for Jetpack XR, on the boot clock, into the pose buffer.
 *
 * One session for the activity, configured with DeviceTrackingMode.SPATIAL (Google's device-pose page). The sampler
 * collects `Session.state` and reads each update's device state from `CoreState.perceptionState`, which the library builds
 * for that update's time mark, rather than collecting `ArDevice.state`: ArDevice emits before the session hands out the
 * matching mark, so a collector of its own would pair a pose with the wrong update.
 */
class XrPoseSampler(
    private val activity: ComponentActivity,
    private val poses: PoseRingBuffer,
    private val epochs: EpochTracker,
) {
    data class Outcome(val create: String, val configure: String?, val sampling: Boolean)

    private val gate = TrackingGate(epochs)
    private val records = ArrayList<PoseRecord>()
    private var job: Job? = null

    // Touched by the collector only.
    private var firstMark: ComparableTimeMark? = null
    private var sequence = 0L

    /** The render viewpoints' offsets from the device's central tracking point, from the first tracked update. */
    @Volatile var viewpoints: JsonObject? = null
        private set

    /** Updates that came with no perception state, so no device state either. */
    @Volatile var updatesWithoutPerceptionState = 0
        private set

    suspend fun start(): Outcome {
        // Session.create loads native libraries and reads from disk (its own documentation), so not on the main thread.
        val created = try {
            withContext(Dispatchers.IO) { Session.create(context = activity, lifecycleOwner = activity) }
        } catch (e: SecurityException) {
            return Outcome("SecurityException: ${e.message}", null, false)
        } catch (e: RuntimeException) {
            return Outcome("${e.javaClass.simpleName}: ${e.message}", null, false)
        }
        val session = (created as? SessionCreateSuccess)?.session
            ?: return Outcome(describe(created), null, false)
        val configured = try {
            withContext(Dispatchers.IO) { session.configure(Config(deviceTracking = DeviceTrackingMode.SPATIAL)) }
        } catch (e: SecurityException) {
            return Outcome(describe(created), "SecurityException: ${e.message}", false)
        } catch (e: UnsupportedOperationException) {
            return Outcome(describe(created), "UnsupportedOperationException: ${e.message}", false)
        } catch (e: IllegalStateException) {
            return Outcome(describe(created), "IllegalStateException: ${e.message}", false)
        }
        if (configured !is SessionConfigureSuccess) return Outcome(describe(created), describe(configured), false)
        job = activity.lifecycleScope.launch(Dispatchers.Default) {
            session.state.collect { handle(it) }
        }
        return Outcome(describe(created), describe(configured), true)
    }

    fun stop() {
        job?.cancel()
        job = null
    }

    fun records(): List<PoseRecord> = synchronized(records) { ArrayList(records) }

    private fun handle(core: CoreState) {
        val perception = core.perceptionState
        if (perception == null) {
            updatesWithoutPerceptionState++
            return
        }
        val stamp = XrPoseStamp.stampMark(core.timeMark, SystemClock::elapsedRealtimeNanos)
        val sinceFirst = markSinceFirst(core.timeMark)

        val device = perception.arDeviceState
        val p = device.devicePose
        val pose = AndroidXrConversions.rigidPose(
            p.translation.x, p.translation.y, p.translation.z,
            p.rotation.x, p.rotation.y, p.rotation.z, p.rotation.w,
        )
        val verdict = gate.offer(device.trackingState == TrackingState.TRACKING, pose, stamp.realtimeNs)
        if (verdict != TrackingGate.Verdict.REJECTED) {
            poses.add(stamp.realtimeNs, pose, null, stamp.source)
            if (viewpoints == null) viewpoints = describeViewpoints(perception)
        }
        val record = PoseRecord(
            sequence = sequence++,
            poseRealtimeNs = stamp.realtimeNs,
            readRealtimeNs = stamp.readRealtimeNs,
            ageNs = stamp.ageNs,
            uncertaintyNs = stamp.uncertaintyNs,
            markSinceFirstNs = sinceFirst,
            source = stamp.source,
            tracking = name(device.trackingState),
            verdict = verdict,
            epoch = epochs.epochAt(stamp.realtimeNs),
            pose = pose,
        )
        synchronized(records) { records += record }
    }

    /** This mark's distance from the first one, on the XR clock. Marks from two time sources cannot be compared. */
    private fun markSinceFirst(mark: ComparableTimeMark): Long {
        val first = firstMark ?: mark.also { firstMark = it }
        return try {
            (mark - first).inWholeNanoseconds
        } catch (_: IllegalArgumentException) {
            firstMark = mark
            0L
        }
    }

    private fun describeViewpoints(perception: PerceptionState): JsonObject = buildJsonObject {
        fun viewpoint(name: String, state: RenderViewpoint.State?) {
            if (state == null) {
                put(name, JsonNull)
                return
            }
            putJsonObject(name) {
                val t = state.localPose.translation
                val q = state.localPose.rotation
                putJsonObject("localPose") {
                    put("x", t.x)
                    put("y", t.y)
                    put("z", t.z)
                    put("qx", q.x)
                    put("qy", q.y)
                    put("qz", q.z)
                    put("qw", q.w)
                }
                val f = state.fieldOfView
                putJsonObject("fieldOfViewDeg") {
                    put("left", Math.toDegrees(f.angleLeft.toDouble()))
                    put("right", Math.toDegrees(f.angleRight.toDouble()))
                    put("up", Math.toDegrees(f.angleUp.toDouble()))
                    put("down", Math.toDegrees(f.angleDown.toDouble()))
                }
            }
        }
        viewpoint("mono", perception.monoRenderViewpointState)
        viewpoint("left", perception.leftRenderViewpointState)
        viewpoint("right", perception.rightRenderViewpointState)
    }

    private fun describe(result: Any?): String = when (result) {
        null -> "null"
        is SessionCreateApkRequired -> "SessionCreateApkRequired(${result.requiredApk})"
        is SessionCreateUnknownError -> "SessionCreateUnknownError(${result.errorMessage})"
        is SessionConfigureLibraryNotLinked -> "SessionConfigureLibraryNotLinked(${result.libraryName})"
        is SessionConfigureUnknownError -> "SessionConfigureUnknownError(${result.errorMessage})"
        is SessionConfigureCalibrationRequired -> "SessionConfigureCalibrationRequired(${result.calibrationType})"
        else -> result.javaClass.simpleName
    }

    private fun name(state: TrackingState): String = when (state) {
        TrackingState.TRACKING -> "TRACKING"
        TrackingState.PAUSED -> "PAUSED"
        TrackingState.STOPPED -> "STOPPED"
        else -> state.toString()
    }
}
