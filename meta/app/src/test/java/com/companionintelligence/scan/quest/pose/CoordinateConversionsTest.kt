package com.companionintelligence.scan.quest.pose

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.double
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.Random
import kotlin.math.PI
import kotlin.math.sqrt

/**
 * Checks the conventions in CoordinateConversions against oracles that do not use it: the server's own
 * poseToMatrix formula, Android's documented lens projection, an OpenGL pinhole camera, mq3drecon's reading of
 * the lens pose, and the Spatial SDK's own classes.
 */
class CoordinateConversionsTest {
    private val random = Random(20261123)

    private fun randomQuat() =
        Quat(random.nextGaussian(), random.nextGaussian(), random.nextGaussian(), random.nextGaussian()).normalized()

    private fun randomVec(scale: Double) =
        Vec3(random.nextGaussian() * scale, random.nextGaussian() * scale, random.nextGaussian() * scale)

    private fun randomPose() = RigidPose(randomVec(2.0), randomQuat())

    private fun assertVec(message: String, expected: Vec3, actual: Vec3, tol: Double = 1e-9) {
        assertEquals("$message x", expected.x, actual.x, tol)
        assertEquals("$message y", expected.y, actual.y, tol)
        assertEquals("$message z", expected.z, actual.z, tol)
    }

    private fun assertSameRotation(message: String, expected: Quat, actual: Quat, tol: Double = 1e-6) {
        assertEquals(message, 0.0, angleBetween(expected, actual), tol)
    }

    /**
     * server/splat/splat_train_dataset.ts poseToMatrix, restated line for line: normalise the quaternion, expand
     * it into a row-major rotation, put the position in the last column. No flip. It is held to the server's own
     * output by [theRestatedServerMatrixIsTheServersOwn], so the oracle cannot drift from the function it stands for.
     */
    private fun serverPoseToMatrix(px: Double, py: Double, pz: Double, x0: Double, y0: Double, z0: Double, w0: Double): Array<DoubleArray> {
        val n = sqrt(x0 * x0 + y0 * y0 + z0 * z0 + w0 * w0).takeIf { it > 0 } ?: 1.0
        val qx = x0 / n
        val qy = y0 / n
        val qz = z0 / n
        val qw = w0 / n
        val xx = qx * qx; val yy = qy * qy; val zz = qz * qz
        val xy = qx * qy; val xz = qx * qz; val yz = qy * qz
        val wx = qw * qx; val wy = qw * qy; val wz = qw * qz
        return arrayOf(
            doubleArrayOf(1 - 2 * (yy + zz), 2 * (xy - wz), 2 * (xz + wy), px),
            doubleArrayOf(2 * (xy + wz), 1 - 2 * (xx + zz), 2 * (yz - wx), py),
            doubleArrayOf(2 * (xz - wy), 2 * (yz + wx), 1 - 2 * (xx + yy), pz),
            doubleArrayOf(0.0, 0.0, 0.0, 1.0),
        )
    }

    private fun serverMatrix(pose: RigidPose) = serverPoseToMatrix(
        pose.position.x, pose.position.y, pose.position.z,
        pose.rotation.x, pose.rotation.y, pose.rotation.z, pose.rotation.w,
    )

    private fun column(m: Array<DoubleArray>, c: Int) = Vec3(m[0][c], m[1][c], m[2][c])

    private fun det3(m: Array<DoubleArray>): Double =
        m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) -
            m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) +
            m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0])

    /**
     * pose-to-matrix.fixture.json (src/test/resources) lists poses and the matrices the server's poseToMatrix makes of
     * them, and tests/unit/server/native_quest_pose_fixture.test.ts holds the file to the server function. A change to
     * that function fails the server test; the fixture regenerated for it then fails this one, until the restatement above
     * and Quat.toMatrix follow it (FN-171).
     */
    @Test
    fun theRestatedServerMatrixIsTheServersOwn() {
        val text = javaClass.getResourceAsStream("/pose-to-matrix.fixture.json")!!.bufferedReader().use { it.readText() }
        val cases = (Json.parseToJsonElement(text) as JsonObject)["cases"]!!.jsonArray
        assertTrue("the fixture lists its poses", cases.size >= 6)
        for (entry in cases) {
            val case = entry.jsonObject
            val name = case["name"]!!.jsonPrimitive.content
            val pose = case["pose"]!!.jsonObject
            val p = pose["position"]!!.jsonObject
            val q = pose["rotation"]!!.jsonObject
            fun n(o: JsonObject, key: String) = o[key]!!.jsonPrimitive.double
            val expected = case["matrix"]!!.jsonArray.map { row -> row.jsonArray.map { it.jsonPrimitive.double } }
            val restated = serverPoseToMatrix(n(p, "x"), n(p, "y"), n(p, "z"), n(q, "x"), n(q, "y"), n(q, "z"), n(q, "w"))
            val rotation = Quat(n(q, "x"), n(q, "y"), n(q, "z"), n(q, "w")).toMatrix()
            for (r in 0 until 4) {
                for (c in 0 until 4) {
                    assertEquals("$name: the restated poseToMatrix, m[$r][$c]", expected[r][c], restated[r][c], 1e-12)
                    if (r < 3 && c < 3) assertEquals("$name: Quat.toMatrix, m[$r][$c]", expected[r][c], rotation[r][c], 1e-12)
                }
            }
        }
    }

    // ── Spatial SDK → Companion Scan ────────────────────────────────────────────────────────────────────────

    // An angle near zero from acos is only good to ~3e-8 rad, so exact round trips compare components.
    private fun assertSameComponents(expected: Quat, actual: Quat) {
        assertEquals(expected.x, actual.x, 0.0)
        assertEquals(expected.y, actual.y, 0.0)
        assertEquals(expected.z, actual.z, 0.0)
        assertEquals(expected.w, actual.w, 0.0)
    }

    @Test
    fun companionScanRoundTripIsExact() {
        repeat(200) {
            val pose = randomPose()
            val back = CoordinateConversions.companionScanToSpatial(CoordinateConversions.spatialToCompanionScan(pose))
            assertVec("position", pose.position, back.position, 0.0)
            assertSameComponents(pose.rotation, back.rotation)
        }
    }

    @Test
    fun oneMetreForwardIsMinusOneZ() {
        // A point 1 m in front of a viewer at the scene origin looking down the SDK's +Z (Vector3.Forward).
        val p = CoordinateConversions.mirrorZ(Vec3(0.0, 0.0, 1.0))
        assertVec("point", Vec3(0.0, 0.0, -1.0), p)
        // A camera at the origin with the identity rotation: its viewing direction in the server's matrix is
        // minus the third column (session_priors.ts), which must be that same point's direction.
        val m = serverMatrix(CoordinateConversions.spatialToCompanionScan(RigidPose.IDENTITY))
        assertVec("view direction", Vec3(0.0, 0.0, -1.0), -column(m, 2))
        assertVec("up", Vec3(0.0, 1.0, 0.0), column(m, 1))
    }

    @Test
    fun aYawTowardsPlusXLooksAlongPlusX() {
        // Turned a quarter turn about +Y, the SDK camera's forward (+Z) points along +X.
        val yaw = Quat.fromAxisAngle(Vec3.Y, PI / 2)
        assertVec("SDK forward", Vec3.X, yaw.rotate(Vec3.Z), 1e-12)
        val m = serverMatrix(CoordinateConversions.spatialToCompanionScan(RigidPose(Vec3(1.0, 1.6, 2.0), yaw)))
        assertVec("view direction (−Z column)", Vec3.X, -column(m, 2))
        assertVec("up (+Y column)", Vec3.Y, column(m, 1))
        assertVec("position", Vec3(1.0, 1.6, -2.0), column(m, 3))
        assertEquals("a rotation, not a reflection", 1.0, det3(m), 1e-9)
    }

    @Test
    fun viewingDirectionUpAndPositionAreTheMirrorOfTheSdkOnes() {
        repeat(200) {
            val pose = randomPose()
            val m = serverMatrix(CoordinateConversions.spatialToCompanionScan(pose))
            val mirror = { v: Vec3 -> Vec3(v.x, v.y, -v.z) }
            assertVec("view", mirror(pose.rotation.rotate(Vec3.Z)), -column(m, 2))
            assertVec("up", mirror(pose.rotation.rotate(Vec3.Y)), column(m, 1))
            assertVec("right", mirror(pose.rotation.rotate(Vec3.X)), column(m, 0))
            assertVec("position", mirror(pose.position), column(m, 3))
            assertEquals(1.0, det3(m), 1e-9)
        }
    }

    // ── Spatial SDK → mq3drecon hmd_poses.csv ───────────────────────────────────────────────────────────────

    @Test
    fun mq3dreconRoundTripIsExact() {
        repeat(50) {
            val pose = randomPose()
            val back = CoordinateConversions.mq3dreconHmdToSpatial(CoordinateConversions.spatialToMq3dreconHmd(pose))
            assertVec("position", pose.position, back.position, 0.0)
            assertSameComponents(pose.rotation, back.rotation)
        }
    }

    /**
     * mq3drecon's legacy reader (dataio/image_data_io.py load_camera_characteristics + models/transforms.py
     * apply_local_transform), restated: translation (x, y, −z); quaternion (−x, −y, z, w), inverted, then
     * composed with a half turn about X; camera = hmd ∘ that. The app's camera pose must equal it, so a dataset
     * with raw lens values and SDK head poses gives mq3drecon the cameras the uploader sends.
     */
    @Test
    fun mq3dreconReadingOfTheRawLensPoseGivesTheAppsCameraPose() {
        repeat(200) {
            val head = randomPose()
            val t = floatArrayOf(random.nextGaussian().toFloat() * 0.05f, random.nextGaussian().toFloat() * 0.05f, random.nextGaussian().toFloat() * 0.05f)
            val q = randomQuat()
            val qa = floatArrayOf(q.x.toFloat(), q.y.toFloat(), q.z.toFloat(), q.w.toFloat())

            val transl = Vec3(t[0].toDouble(), t[1].toDouble(), -t[2].toDouble())
            val flipped = Quat(-qa[0].toDouble(), -qa[1].toDouble(), qa[2].toDouble(), qa[3].toDouble())
            val local = flipped.inverse() * Quat.fromAxisAngle(Vec3.X, PI)
            val mq3dPosition = head.position + head.rotation.rotate(transl)
            val mq3dRotation = head.rotation * local

            val app = CoordinateConversions.cameraPoseInScene(
                CoordinateConversions.spatialToMq3dreconHmd(head),
                CoordinateConversions.headFromCamera(t, qa),
            )
            assertVec("position", mq3dPosition, app.position, 1e-6)
            assertSameRotation("rotation", mq3dRotation, app.rotation)
        }
    }

    // ── Lens extrinsics ─────────────────────────────────────────────────────────────────────────────────────

    @Test
    fun aHalfTurnLensRotationMeansTheCameraLooksWhereTheHeadLooks() {
        // device → camera = half turn about X: optical axis along −Z_device (forward), image down along −Y_device.
        val c = CoordinateConversions.headFromCamera(floatArrayOf(0.03f, -0.01f, -0.05f), floatArrayOf(1f, 0f, 0f, 0f))
        assertSameRotation("rotation", Quat.IDENTITY, c.rotation)
        assertVec("translation", Vec3(0.03, -0.01, 0.05), c.position, 1e-7)
    }

    @Test
    fun anIdentityLensRotationMeansTheCameraFacesTheWearer() {
        // Camera axes equal to the device's: the optical axis is +Z_device, out of the display, towards the face.
        val c = CoordinateConversions.headFromCamera(floatArrayOf(0f, 0f, 0f), floatArrayOf(0f, 0f, 0f, 1f))
        assertVec("forward", Vec3(0.0, 0.0, -1.0), c.rotation.rotate(Vec3.Z), 1e-12)
    }

    @Test
    fun aMissingLensPoseIsTheIdentity() {
        val c = CoordinateConversions.headFromCamera(null, floatArrayOf(1f, 2f))
        assertVec("translation", Vec3.ZERO, c.position, 0.0)
        assertSameRotation("rotation", Quat.IDENTITY, c.rotation, 0.0)
    }

    /**
     * End to end against Android's documented projection. A point is placed in front of the camera in Camera2's
     * own frame (p_C), taken to the scene with the documented p_C = R·(p_D − t), and projected two ways:
     * Camera2's u = fx·x/z + cx, v = fy·y/z + cy; and the app's keyframe pose through the server's matrix and an
     * OpenGL pinhole camera (looks down −Z, +Y up, v down the image), which is how a Nerfstudio trainer reads
     * transforms.json. They must agree for any lens rotation, head pose and intrinsics.
     */
    @Test
    fun keyframePoseProjectsLikeCamera2() {
        repeat(300) {
            val head = randomPose()
            val lensQ = randomQuat()
            val lensT = randomVec(0.05)
            val fx = 400 + random.nextDouble() * 600
            val fy = fx * (0.95 + random.nextDouble() * 0.1)
            val cx = 600 + random.nextDouble() * 80
            val cy = 440 + random.nextDouble() * 80
            val pCam = Vec3(random.nextGaussian(), random.nextGaussian(), 0.5 + random.nextDouble() * 4)

            // Camera2: p_D = Rᵀ p_C + t; the head frame is the device frame with Z flipped (assumption A2).
            val pDevice = lensQ.conjugate().rotate(pCam) + lensT
            val pScene = head.transformPoint(Vec3(pDevice.x, pDevice.y, -pDevice.z))
            val uA = fx * pCam.x / pCam.z + cx
            val vA = fy * pCam.y / pCam.z + cy

            val keyframe = CoordinateConversions.keyframePose(
                head,
                CoordinateConversions.headFromCamera(
                    floatArrayOf(lensT.x.toFloat(), lensT.y.toFloat(), lensT.z.toFloat()),
                    floatArrayOf(lensQ.x.toFloat(), lensQ.y.toFloat(), lensQ.z.toFloat(), lensQ.w.toFloat()),
                ),
            )
            val m = serverMatrix(keyframe)
            val world = CoordinateConversions.mirrorZ(pScene)
            val d = Vec3(world.x - m[0][3], world.y - m[1][3], world.z - m[2][3])
            val local = Vec3(
                m[0][0] * d.x + m[1][0] * d.y + m[2][0] * d.z,
                m[0][1] * d.x + m[1][1] * d.y + m[2][1] * d.z,
                m[0][2] * d.x + m[1][2] * d.y + m[2][2] * d.z,
            )
            assertTrue("in front of the OpenGL camera", local.z < 0)
            val uB = cx + fx * local.x / -local.z
            val vB = cy - fy * local.y / -local.z
            // Float lens values limit the agreement to about a micro-pixel per pixel of focal length.
            assertEquals("u", uA, uB, 1e-3)
            assertEquals("v", vA, vB, 1e-3)
        }
    }

    // ── Intrinsics ──────────────────────────────────────────────────────────────────────────────────────────

    @Test
    fun aSquareArrayIsCentreCroppedToFourByThree() {
        val k = CoordinateConversions.intrinsicsForStream(
            floatArrayOf(500f, 500f, 640f, 640f, 0f),
            PixelRect(0, 0, 1280, 1280),
            PixelRect(0, 0, 1280, 1280),
            1280, 960,
        )
        assertEquals(500.0, k.fx, 1e-9)
        assertEquals(500.0, k.fy, 1e-9)
        assertEquals(640.0, k.cx, 1e-9)
        assertEquals(480.0, k.cy, 1e-9)
        assertEquals(1280, k.width)
        assertEquals(960, k.height)
    }

    @Test
    fun aSameAspectStreamIsOnlyScaled() {
        val k = CoordinateConversions.intrinsicsForStream(
            floatArrayOf(800f, 810f, 641f, 479f, 0.5f),
            PixelRect(0, 0, 1280, 960),
            PixelRect(0, 0, 1280, 960),
            640, 480,
        )
        assertEquals(400.0, k.fx, 1e-9)
        assertEquals(405.0, k.fy, 1e-9)
        assertEquals(320.5, k.cx, 1e-9)
        assertEquals(239.5, k.cy, 1e-9)
    }

    @Test
    fun thePreCorrectionOffsetIsRemoved() {
        val k = CoordinateConversions.intrinsicsForStream(
            floatArrayOf(600f, 600f, 648f, 488f, 0f),
            PixelRect(0, 0, 1296, 976),
            PixelRect(8, 8, 1288, 968),
            1280, 960,
        )
        assertEquals(640.0, k.cx, 1e-9)
        assertEquals(480.0, k.cy, 1e-9)
    }

    @Test
    fun aWideArrayIsCroppedAtTheSides() {
        val k = CoordinateConversions.intrinsicsForStream(
            floatArrayOf(500f, 500f, 800f, 480f, 0f),
            PixelRect(0, 0, 1600, 960),
            PixelRect(0, 0, 1600, 960),
            1280, 960,
        )
        assertEquals(640.0, k.cx, 1e-9)
        assertEquals(480.0, k.cy, 1e-9)
        assertEquals(500.0, k.fx, 1e-9)
    }

    @Test
    fun fovYComesFromFy() {
        assertEquals(90.0, PinholeIntrinsics(480.0, 480.0, 640.0, 480.0, 1280, 960).fovYDeg, 1e-9)
        val half = PinholeIntrinsics(480.0, 480.0, 640.0, 480.0, 1280, 960).scaledTo(640, 480)
        assertEquals(240.0, half.fy, 1e-9)
        assertEquals(90.0, half.fovYDeg, 1e-9)
    }

    // ── Scene helpers ───────────────────────────────────────────────────────────────────────────────────────

    @Test
    fun yawFacingTurnsPlusZOntoTheDirection() {
        for (d in listOf(Vec3.X, Vec3(0.0, 0.0, -1.0), Vec3(-1.0, 0.3, 1.0))) {
            val flat = Vec3(d.x, 0.0, d.z)
            val expected = flat * (1.0 / flat.length())
            assertVec("dir $d", expected, CoordinateConversions.yawFacing(d).rotate(Vec3.Z), 1e-12)
        }
    }

    @Test
    fun theSplatMirrorIsTheSameZMirror() {
        val p = Vec3(0.4, 1.2, -3.0)
        val s = CoordinateConversions.SPLAT_MIRROR_SCALE
        assertVec("scaled", CoordinateConversions.companionScanPointToScene(p), Vec3(p.x * s.x, p.y * s.y, p.z * s.z), 0.0)
    }

    // ── The Spatial SDK's own classes ───────────────────────────────────────────────────────────────────────

    /**
     * Pins the SDK conventions this file relies on to the SDK's own code (meta-spatial-sdk 0.15.0 on the unit
     * test classpath): the (w, x, y, z) constructor, Quaternion × Vector3 = q·v·q⁻¹, Pose.forward() = q·(+Z), and
     * Vector3.Forward = +Z.
     */
    @Test
    fun theSdkUsesTheSameQuaternionAndForwardConventions() {
        repeat(50) {
            val q = randomQuat()
            val v = randomVec(1.0)
            val sdkQ = com.meta.spatial.core.Quaternion(q.w.toFloat(), q.x.toFloat(), q.y.toFloat(), q.z.toFloat())
            val sdkV = sdkQ * com.meta.spatial.core.Vector3(v.x.toFloat(), v.y.toFloat(), v.z.toFloat())
            assertVec("q·v", q.rotate(v), Vec3(sdkV.x.toDouble(), sdkV.y.toDouble(), sdkV.z.toDouble()), 1e-5)
            val forward = com.meta.spatial.core.Pose(com.meta.spatial.core.Vector3(0f, 0f, 0f), sdkQ).forward()
            assertVec("forward", q.rotate(Vec3.Z), Vec3(forward.x.toDouble(), forward.y.toDouble(), forward.z.toDouble()), 1e-5)
        }
        val f = com.meta.spatial.core.Vector3.Forward
        assertVec("Vector3.Forward", Vec3.Z, Vec3(f.x.toDouble(), f.y.toDouble(), f.z.toDouble()), 0.0)
    }
}
