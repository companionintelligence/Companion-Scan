package com.companionintelligence.scan.quest.pose

import org.junit.Assert.assertEquals
import org.junit.Test
import kotlin.math.PI
import kotlin.math.sqrt

class PoseMathTest {
    private fun assertVec(expected: Vec3, actual: Vec3, tol: Double = 1e-12) {
        assertEquals("x", expected.x, actual.x, tol)
        assertEquals("y", expected.y, actual.y, tol)
        assertEquals("z", expected.z, actual.z, tol)
    }

    @Test
    fun quarterTurnsAboutEachAxisFollowTheRightHandRule() {
        assertVec(Vec3.X, Quat.fromAxisAngle(Vec3.Y, PI / 2).rotate(Vec3.Z))
        assertVec(Vec3.Y, Quat.fromAxisAngle(Vec3.Z, PI / 2).rotate(Vec3.X))
        assertVec(Vec3.Z, Quat.fromAxisAngle(Vec3.X, PI / 2).rotate(Vec3.Y))
    }

    @Test
    fun productAppliesTheRightFactorFirst() {
        val a = Quat.fromAxisAngle(Vec3.Y, PI / 2)
        val b = Quat.fromAxisAngle(Vec3.X, PI / 2)
        val v = Vec3(0.3, -0.7, 1.1)
        assertVec(a.rotate(b.rotate(v)), (a * b).rotate(v))
    }

    @Test
    fun matrixMatchesRotate() {
        val q = Quat(0.1, -0.4, 0.3, 0.8).normalized()
        val m = q.toMatrix()
        val v = Vec3(1.5, -2.0, 0.25)
        val byMatrix = Vec3(
            m[0][0] * v.x + m[0][1] * v.y + m[0][2] * v.z,
            m[1][0] * v.x + m[1][1] * v.y + m[1][2] * v.z,
            m[2][0] * v.x + m[2][1] * v.y + m[2][2] * v.z,
        )
        assertVec(q.rotate(v), byMatrix, 1e-12)
    }

    @Test
    fun poseInverseUndoesThePose() {
        val p = RigidPose(Vec3(1.0, 2.0, 3.0), Quat(0.2, 0.3, -0.1, 0.9).normalized())
        val point = Vec3(-0.5, 0.7, 4.0)
        assertVec(point, p.inverse().transformPoint(p.transformPoint(point)), 1e-12)
        val composed = p * p.inverse()
        assertVec(Vec3.ZERO, composed.position, 1e-12)
        assertEquals(0.0, angleBetween(Quat.IDENTITY, composed.rotation), 1e-6)
    }

    @Test
    fun slerpHitsEndpointsAndHalfway() {
        val a = Quat.IDENTITY
        val b = Quat.fromAxisAngle(Vec3.Y, PI / 2)
        assertEquals(0.0, angleBetween(a, slerp(a, b, 0.0)), 1e-9)
        assertEquals(0.0, angleBetween(b, slerp(a, b, 1.0)), 1e-9)
        assertEquals(0.0, angleBetween(Quat.fromAxisAngle(Vec3.Y, PI / 4), slerp(a, b, 0.5)), 1e-9)
        // The double cover: −b is the same rotation, and slerp takes the short way to it.
        assertEquals(0.0, angleBetween(Quat.fromAxisAngle(Vec3.Y, PI / 4), slerp(a, -b, 0.5)), 1e-9)
    }

    @Test
    fun angleBetweenIgnoresSign() {
        val q = Quat.fromAxisAngle(Vec3(1.0, 1.0, 0.0), 0.6)
        assertEquals(0.0, angleBetween(q, -q), 1e-9)
        assertEquals(0.6, angleBetween(Quat.IDENTITY, q), 1e-9)
    }

    @Test
    fun lerpPoseInterpolatesBoth() {
        val a = RigidPose(Vec3.ZERO, Quat.IDENTITY)
        val b = RigidPose(Vec3(2.0, 0.0, -2.0), Quat.fromAxisAngle(Vec3.Z, PI / 2))
        val mid = lerpPose(a, b, 0.5)
        assertVec(Vec3(1.0, 0.0, -1.0), mid.position)
        assertVec(Vec3(sqrt(0.5), sqrt(0.5), 0.0), mid.rotation.rotate(Vec3.X), 1e-12)
    }
}
