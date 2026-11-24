package com.companionintelligence.scan.quest.pose

import kotlin.math.abs
import kotlin.math.acos
import kotlin.math.cos
import kotlin.math.min
import kotlin.math.sin
import kotlin.math.sqrt

/*
 * Plain rigid-body algebra in doubles. No frame convention is chosen here: every change of convention lives in
 * CoordinateConversions.kt. Nothing in this file touches Android or the Spatial SDK, so the JVM unit tests run
 * the same code the app runs.
 */

/** A point or direction. Units are metres wherever a position is meant. */
data class Vec3(val x: Double, val y: Double, val z: Double) {
    operator fun plus(o: Vec3) = Vec3(x + o.x, y + o.y, z + o.z)
    operator fun minus(o: Vec3) = Vec3(x - o.x, y - o.y, z - o.z)
    operator fun times(s: Double) = Vec3(x * s, y * s, z * s)
    operator fun unaryMinus() = Vec3(-x, -y, -z)
    fun dot(o: Vec3) = x * o.x + y * o.y + z * o.z
    fun cross(o: Vec3) = Vec3(y * o.z - z * o.y, z * o.x - x * o.z, x * o.y - y * o.x)
    fun length() = sqrt(dot(this))
    fun isFinite() = x.isFinite() && y.isFinite() && z.isFinite()

    companion object {
        val ZERO = Vec3(0.0, 0.0, 0.0)
        val X = Vec3(1.0, 0.0, 0.0)
        val Y = Vec3(0.0, 1.0, 0.0)
        val Z = Vec3(0.0, 0.0, 1.0)
    }
}

/**
 * A rotation quaternion in the Hamilton convention, stored as (x, y, z, w).
 *
 * [rotate] computes q · v · q⁻¹ for a column vector v. That is what the Spatial SDK's own
 * `Quaternion.times(Vector3)` computes (read from the meta-spatial-sdk 0.15.0 bytecode) and what the server's
 * `poseToMatrix` expands into a matrix (server/splat/splat_train_dataset.ts). The SDK's Quaternion constructor
 * takes (w, x, y, z), so adapters copy components by name, never by position.
 */
data class Quat(val x: Double, val y: Double, val z: Double, val w: Double) {
    /** Hamilton product: (this * o) applies o first, then this. */
    operator fun times(o: Quat) = Quat(
        w * o.x + x * o.w + y * o.z - z * o.y,
        w * o.y - x * o.z + y * o.w + z * o.x,
        w * o.z + x * o.y - y * o.x + z * o.w,
        w * o.w - x * o.x - y * o.y - z * o.z,
    )

    operator fun unaryMinus() = Quat(-x, -y, -z, -w)
    fun conjugate() = Quat(-x, -y, -z, w)
    fun dot(o: Quat) = x * o.x + y * o.y + z * o.z + w * o.w
    fun norm() = sqrt(dot(this))
    fun isFinite() = x.isFinite() && y.isFinite() && z.isFinite() && w.isFinite()

    fun normalized(): Quat {
        val n = norm()
        require(n > 1e-12 && n.isFinite()) { "cannot normalise a zero or non-finite quaternion" }
        return Quat(x / n, y / n, z / n, w / n)
    }

    /** Inverse of a unit quaternion. */
    fun inverse(): Quat = normalized().conjugate()

    /** q · v · q⁻¹, for a unit quaternion. */
    fun rotate(v: Vec3): Vec3 {
        val u = Vec3(x, y, z)
        val t = u.cross(v) * 2.0
        return v + t * w + u.cross(t)
    }

    /** Row-major 3×3 rotation matrix, the same expansion as the server's poseToMatrix. */
    fun toMatrix(): Array<DoubleArray> {
        val q = normalized()
        val xx = q.x * q.x
        val yy = q.y * q.y
        val zz = q.z * q.z
        val xy = q.x * q.y
        val xz = q.x * q.z
        val yz = q.y * q.z
        val wx = q.w * q.x
        val wy = q.w * q.y
        val wz = q.w * q.z
        return arrayOf(
            doubleArrayOf(1 - 2 * (yy + zz), 2 * (xy - wz), 2 * (xz + wy)),
            doubleArrayOf(2 * (xy + wz), 1 - 2 * (xx + zz), 2 * (yz - wx)),
            doubleArrayOf(2 * (xz - wy), 2 * (yz + wx), 1 - 2 * (xx + yy)),
        )
    }

    companion object {
        val IDENTITY = Quat(0.0, 0.0, 0.0, 1.0)

        /** Right-hand-rule rotation of [radians] about [axis] (applied with [rotate]). */
        fun fromAxisAngle(axis: Vec3, radians: Double): Quat {
            val n = axis.length()
            require(n > 1e-12) { "axis must be non-zero" }
            val s = sin(radians / 2) / n
            return Quat(axis.x * s, axis.y * s, axis.z * s, cos(radians / 2))
        }
    }
}

/** The angle in radians between two rotations, the same for q and −q. */
fun angleBetween(a: Quat, b: Quat): Double {
    val d = abs(a.normalized().dot(b.normalized()))
    return 2 * acos(min(1.0, d))
}

/** Spherical interpolation along the shorter arc; t = 0 gives [a], t = 1 gives [b] (or −b). */
fun slerp(a: Quat, b: Quat, t: Double): Quat {
    val qa = a.normalized()
    var qb = b.normalized()
    var d = qa.dot(qb)
    if (d < 0) {
        qb = -qb
        d = -d
    }
    if (d > 0.9995) {
        return Quat(
            qa.x + (qb.x - qa.x) * t,
            qa.y + (qb.y - qa.y) * t,
            qa.z + (qb.z - qa.z) * t,
            qa.w + (qb.w - qa.w) * t,
        ).normalized()
    }
    val theta = acos(d)
    val s = sin(theta)
    val wa = sin((1 - t) * theta) / s
    val wb = sin(t * theta) / s
    return Quat(
        qa.x * wa + qb.x * wb,
        qa.y * wa + qb.y * wb,
        qa.z * wa + qb.z * wb,
        qa.w * wa + qb.w * wb,
    ).normalized()
}

/**
 * A rigid transform from a child frame to a parent frame: p_parent = rotation.rotate(p_child) + position.
 * A camera-to-world pose is one of these with the camera as the child.
 */
data class RigidPose(val position: Vec3, val rotation: Quat) {
    /** this ∘ child: the child's frame expressed in this pose's parent frame. */
    operator fun times(child: RigidPose) =
        RigidPose(position + rotation.rotate(child.position), (rotation * child.rotation).normalized())

    fun transformPoint(p: Vec3) = rotation.rotate(p) + position

    fun inverse(): RigidPose {
        val inv = rotation.inverse()
        return RigidPose(-inv.rotate(position), inv)
    }

    fun isFinite() = position.isFinite() && rotation.isFinite()

    companion object {
        val IDENTITY = RigidPose(Vec3.ZERO, Quat.IDENTITY)
    }
}

/** Linear interpolation of position and slerp of rotation. */
fun lerpPose(a: RigidPose, b: RigidPose, t: Double) =
    RigidPose(a.position + (b.position - a.position) * t, slerp(a.rotation, b.rotation, t))
