package com.companionintelligence.scan.androidxr.probe

import androidx.xr.runtime.math.Pose
import androidx.xr.runtime.math.Quaternion
import androidx.xr.runtime.math.Vector3
import com.companionintelligence.scan.quest.pose.CoordinateConversions
import com.companionintelligence.scan.quest.pose.Quat
import com.companionintelligence.scan.quest.pose.RigidPose
import com.companionintelligence.scan.quest.pose.Vec3
import com.companionintelligence.scan.quest.pose.angleBetween
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.double
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Pins AndroidXrConversions to Jetpack XR's own math classes (androidx.xr.runtime 1.0.0, on the unit-test classpath) and
 * to the server's poseToMatrix, through the fixture meta/'s CoordinateConversionsTest also reads.
 */
class AndroidXrConversionsTest {

    private val jetpackTolerance = 1e-6 // its classes are Float

    private fun close(expected: Vec3, actual: Vector3, message: String) {
        assertEquals("$message x", expected.x, actual.x.toDouble(), jetpackTolerance)
        assertEquals("$message y", expected.y, actual.y.toDouble(), jetpackTolerance)
        assertEquals("$message z", expected.z, actual.z.toDouble(), jetpackTolerance)
    }

    private fun close(expected: Vec3, actual: Vec3, tolerance: Double, message: String) {
        assertEquals("$message x", expected.x, actual.x, tolerance)
        assertEquals("$message y", expected.y, actual.y, tolerance)
        assertEquals("$message z", expected.z, actual.z, tolerance)
    }

    private fun jetpack(p: RigidPose) = Pose(
        Vector3(p.position.x.toFloat(), p.position.y.toFloat(), p.position.z.toFloat()),
        Quaternion(p.rotation.x.toFloat(), p.rotation.y.toFloat(), p.rotation.z.toFloat(), p.rotation.w.toFloat()),
    )

    private fun fromJetpack(p: Pose) = AndroidXrConversions.rigidPose(
        p.translation.x, p.translation.y, p.translation.z,
        p.rotation.x, p.rotation.y, p.rotation.z, p.rotation.w,
    )

    /** The row-major camera-to-world matrix, as the server's poseToMatrix builds it (Quat.toMatrix is held to it in meta/). */
    private fun matrix(p: RigidPose): Array<DoubleArray> {
        val r = p.rotation.toMatrix()
        return arrayOf(
            doubleArrayOf(r[0][0], r[0][1], r[0][2], p.position.x),
            doubleArrayOf(r[1][0], r[1][1], r[1][2], p.position.y),
            doubleArrayOf(r[2][0], r[2][1], r[2][2], p.position.z),
            doubleArrayOf(0.0, 0.0, 0.0, 1.0),
        )
    }

    private fun column(m: Array<DoubleArray>, c: Int) = Vec3(m[0][c], m[1][c], m[2][c])

    private val samples = listOf(
        RigidPose.IDENTITY,
        RigidPose(Vec3(0.4, 1.6, -2.0), Quat.fromAxisAngle(Vec3.Y, Math.toRadians(90.0))),
        RigidPose(Vec3(-1.0, 1.2, 0.5), Quat.fromAxisAngle(Vec3.X, Math.toRadians(-30.0))),
        RigidPose(Vec3(2.0, 0.9, 3.0), Quat.fromAxisAngle(Vec3(1.0, 2.0, -0.5), 1.1)),
    )

    @Test
    fun jetpackXrIsRightHandedYUpLookingDownMinusZ() {
        close(Vec3(1.0, 0.0, 0.0), Vector3.Right, "Right")
        close(Vec3(0.0, 1.0, 0.0), Vector3.Up, "Up")
        close(Vec3(0.0, 0.0, -1.0), Vector3.Forward, "Forward")
        close(Vec3(0.0, 0.0, 1.0), Vector3.Backward, "Backward")
        // Right × Up = Backward: right-handed.
        close(Vec3.X.cross(Vec3.Y), Vector3.Backward, "Right × Up")
    }

    @Test
    fun itsQuaternionTakesXyzwAndRotatesAsOursDoes() {
        for (p in samples) {
            val q = Quaternion(p.rotation.x.toFloat(), p.rotation.y.toFloat(), p.rotation.z.toFloat(), p.rotation.w.toFloat())
            assertEquals(p.rotation.x, q.x.toDouble(), jetpackTolerance)
            assertEquals(p.rotation.w, q.w.toDouble(), jetpackTolerance)
            for (v in listOf(Vec3.X, Vec3.Y, Vec3.Z, Vec3(0.3, -0.7, 0.2))) {
                close(p.rotation.rotate(v), q * Vector3(v.x.toFloat(), v.y.toFloat(), v.z.toFloat()), "q·$v·q⁻¹")
            }
        }
    }

    @Test
    fun aDevicePoseComesThroughUnchangedWhenTheCameraReportsNoLensPose() {
        val noLens = CoordinateConversions.headFromCamera(null, null)
        for (p in samples) {
            val device = fromJetpack(jetpack(p))
            val keyframe = AndroidXrConversions.keyframePose(device, noLens)
            close(device.position, keyframe.position, 1e-12, "position")
            assertEquals("rotation", 0.0, angleBetween(device.rotation, keyframe.rotation), 1e-6)
        }
    }

    /** The keyframe camera looks where the glasses look, and its image's up is theirs: what the server reads. */
    @Test
    fun theKeyframeCameraLooksDownTheDevicesForward() {
        val noLens = CoordinateConversions.headFromCamera(null, null)
        for (p in samples) {
            val device = jetpack(p)
            val m = matrix(AndroidXrConversions.keyframePose(fromJetpack(device), noLens))
            // server/register/session_priors.ts reads the viewing direction as minus the third column.
            close(-column(m, 2), device.forward, "viewing direction")
            close(column(m, 1), device.up, "image up")
            close(column(m, 0), device.right, "image right")
        }
    }

    /**
     * pose-to-matrix.fixture.json: for each of its poses taken as a Jetpack XR device pose, the probe's keyframe pose is a
     * pose the server turns into the fixture's matrix.
     */
    @Test
    fun theServersMatrixOfAKeyframeIsTheFixturesMatrixOfTheDevicePose() {
        val text = javaClass.getResourceAsStream("/pose-to-matrix.fixture.json")!!.bufferedReader().use { it.readText() }
        val cases = (Json.parseToJsonElement(text) as JsonObject)["cases"]!!.jsonArray
        assertTrue("the fixture lists its poses", cases.size >= 6)
        val noLens = CoordinateConversions.headFromCamera(null, null)
        for (entry in cases) {
            val case = entry.jsonObject
            val name = case["name"]!!.jsonPrimitive.content
            val pose = case["pose"]!!.jsonObject
            fun n(o: JsonObject, key: String) = o[key]!!.jsonPrimitive.double
            val p = pose["position"]!!.jsonObject
            val q = pose["rotation"]!!.jsonObject
            // The Jetpack XR math classes normalise; poseToMatrix normalises too, so a quaternion off unit length agrees.
            val device = fromJetpack(
                Pose(
                    Vector3(n(p, "x").toFloat(), n(p, "y").toFloat(), n(p, "z").toFloat()),
                    Quaternion(n(q, "x").toFloat(), n(q, "y").toFloat(), n(q, "z").toFloat(), n(q, "w").toFloat()),
                ),
            )
            val actual = matrix(AndroidXrConversions.keyframePose(device, noLens))
            val expected = case["matrix"]!!.jsonArray.map { row -> row.jsonArray.map { it.jsonPrimitive.double } }
            for (r in 0 until 4) {
                for (c in 0 until 4) {
                    assertEquals("$name: m[$r][$c]", expected[r][c], actual[r][c], jetpackTolerance)
                }
            }
        }
    }

    /**
     * With a lens pose, the chain through the Spatial SDK's mirrored frame (the Quest's) equals the composition made
     * directly in Jetpack XR's frame under X1: p_D = Rᵀ·p_C + t, and the camera's Y-up, Z-back frame is the half turn
     * about X of Camera2's Y-down, Z-forward one.
     */
    @Test
    fun theMirroredQuestChainEqualsTheDirectComposition() {
        val t = floatArrayOf(0.031f, -0.012f, -0.018f)
        val raw = Quat.fromAxisAngle(Vec3(0.2, 1.0, 0.1), 2.9).normalized() // device → camera, as Camera2 gives it
        val r = floatArrayOf(raw.x.toFloat(), raw.y.toFloat(), raw.z.toFloat(), raw.w.toFloat())
        val headFromCamera = CoordinateConversions.headFromCamera(t, r)
        val rawF = Quat(r[0].toDouble(), r[1].toDouble(), r[2].toDouble(), r[3].toDouble())
        val direct = RigidPose(
            Vec3(t[0].toDouble(), t[1].toDouble(), t[2].toDouble()),
            (rawF.inverse() * Quat(1.0, 0.0, 0.0, 0.0)).normalized(),
        )
        for (p in samples) {
            val viaQuest = AndroidXrConversions.keyframePose(p, headFromCamera)
            val expected = p * direct
            close(expected.position, viaQuest.position, 1e-12, "position")
            assertEquals("rotation", 0.0, angleBetween(expected.rotation, viaQuest.rotation), 1e-6)
        }
    }

    /**
     * A camera that looks out of the glasses: its optical axis is the device's −Z, its image's down the device's −Y
     * (Camera2's R = a half turn about X). Its keyframe pose is the device's, moved by the lens offset.
     */
    @Test
    fun aForwardLookingCameraOffsetFromTheDevice() {
        val t = floatArrayOf(0.0f, 0.02f, -0.01f)
        val halfTurnX = floatArrayOf(1f, 0f, 0f, 0f)
        val headFromCamera = CoordinateConversions.headFromCamera(t, halfTurnX)
        for (p in samples) {
            val device = jetpack(p)
            val keyframe = AndroidXrConversions.keyframePose(fromJetpack(device), headFromCamera)
            val m = matrix(keyframe)
            close(-column(m, 2), device.forward, "viewing direction")
            close(column(m, 1), device.up, "image up")
            close(p.position + p.rotation.rotate(Vec3(0.0, 0.02, -0.01)), keyframe.position, 1e-6, "camera centre")
        }
    }
}
