/**
 * The pose and frame maths the capture code shares: one home for each computation the providers, the calibration, the
 * anchors and the keyframer used to write out for themselves (wave 14, ticket 0004; F-40, FN-029, FN-030, FN-038).
 *
 * Where two copies computed the same quantity under different rules for a degenerate input, the quantity is computed
 * once here and each rule keeps its own name, so the difference shows where it is used:
 *
 *  - `rotationAngleDeg`: the full turn between two orientations. A zero quaternion reads as no turn, never NaN
 *    (the runtime anchors' rule). src/ar/tap-sampling.ts wants NaN there and asks `isRotation` first.
 *  - `yawAboutVerticalDeg` and `yawTwistDeg`: one quantity, the twist about +Y of the relative rotation. The first reads
 *    a zero quaternion as no turn and keeps (-180, 180] (src/ar/anchors.ts). The second is NaN when either orientation
 *    is not a rotation, and keeps [-180, 180] (src/ar/frame-epoch.ts).
 *  - `cameraHeadingDeg`: a different quantity, which is why it has a different name. It is the heading of ONE camera's
 *    view direction, so differencing two of them is right for a camera and wrong for a frame turned under it (see
 *    yawAboutVerticalDeg). src/capture/pose-delta.ts re-exports it as `yawDegFromQuat`.
 *
 * Copies that are not here, and why:
 *  - `rotationAngleBetweenDeg` (src/ar/fiducial/tag-pose.ts) takes two 3x3 matrices, not quaternions.
 *  - `intrinsicsFromProjection` (the same file) gives pixel focal lengths and a principal point for an image size,
 *    not a field of view.
 *  - closure's least-squares turn (src/ar/closure.ts) and frame-fit's heading (src/world/frame-fit.ts) accumulate the
 *    cross term with opposite signs, and frame-fit's pass also collects the mirrored sums its verdict needs.
 *
 * Pure and import-free: the browser, the Node tests and (should it ever need one) the server can import it, and
 * nothing it reaches is outside the directories the Docker image copies.
 */

/** A quaternion, x y z the vector part and w the scalar part, as `Pose['rotation']` and `Quat` spell it. */
export interface QuatLike {
  x: number
  y: number
  z: number
  w: number
}

/** A point or a vector, as `Pose['position']` and `Vec3` spell it. */
export interface Vec3Like {
  x: number
  y: number
  z: number
}

const RAD_TO_DEG = 180 / Math.PI

/** Wrap an angle in degrees to (-180, 180]. */
export function wrapDeg(deg: number): number {
  const wrapped = ((deg + 180) % 360 + 360) % 360 - 180
  // ((-180 + 180) % 360) maps exactly -180 onto -180; normalise to +180 so the
  // range is half-open and a 180-degree turn reads the same whichever way the
  // operator walked around the loop.
  return wrapped === -180 ? 180 : wrapped
}

/** Whether `q` can stand for a rotation: four finite numbers, not all zero. */
export function isRotation(q: QuatLike | null | undefined): q is QuatLike {
  if (!q) return false
  const n = Math.hypot(q.x, q.y, q.z, q.w)
  return Number.isFinite(n) && n > 0
}

/**
 * The rotation that takes `from` to `to`: `to` times the conjugate of `from`, in the Hamilton convention, so it is
 * expressed in the world frame. Not normalised: its callers take ratios of its parts, which a length does not change.
 */
export function relativeRotation(from: QuatLike, to: QuatLike): QuatLike {
  return {
    x: -to.w * from.x + to.x * from.w - to.y * from.z + to.z * from.y,
    y: -to.w * from.y + to.x * from.z + to.y * from.w - to.z * from.x,
    z: -to.w * from.z - to.x * from.y + to.y * from.x + to.z * from.w,
    w: to.w * from.w + to.x * from.x + to.y * from.y + to.z * from.z,
  }
}

/**
 * The angle, in degrees, of the turn that takes rotation `a` to rotation `b`: 0 to 180, whichever way it goes, and the
 * same for q and -q. Two equal rotations give 0 to within rounding (under 1e-13 degrees). Taken as an arctangent of the
 * relative rotation's parts, so a quaternion that is a rounding error off unit length cannot give NaN (an arccosine of
 * 1.0000000000000002 would), and a small angle keeps its precision (an arccosine of a dot product near 1 does not).
 * A zero quaternion reads as no turn: 0, not NaN. Ask {@link isRotation} first where that must be told apart.
 */
export function rotationAngleDeg(a: QuatLike, b: QuatLike): number {
  const r = relativeRotation(a, b)
  return 2 * Math.atan2(Math.hypot(r.x, r.y, r.z), Math.abs(r.w)) * RAD_TO_DEG
}

/** The twist about +Y of the turn from `a` to `b`, radians, the short way round: -π to π. 0 for a zero quaternion. */
function twistAboutVerticalRad(a: QuatLike, b: QuatLike): number {
  const r = relativeRotation(a, b)
  let y = r.y
  let w = r.w
  // A rotation and its negation are the same rotation; take the short way round.
  if (w < 0) {
    w = -w
    y = -y
  }
  return 2 * Math.atan2(y, w)
}

/**
 * The turn about world +Y that is part of the turn from `a` to `b`, degrees in (-180, 180], counter-clockwise from above
 * positive. This is the twist of the relative rotation about the vertical axis. Differencing two headings extracted from
 * the poses instead ({@link cameraHeadingDeg}) is right for a camera but not for an anchor whose own +Y lies flat, such
 * as one made on a wall: it jumps by about 90 degrees for a one degree tilt.
 *
 * A zero quaternion reads as no turn: 0, never NaN (the runtime anchors' rule, src/ar/anchors.ts). {@link yawTwistDeg}
 * is the same twist under the frame tracker's rule.
 */
export function yawAboutVerticalDeg(a: QuatLike, b: QuatLike): number {
  return wrapDeg(twistAboutVerticalRad(a, b) * RAD_TO_DEG)
}

/**
 * The turn between two orientations about the world's vertical axis, in degrees, signed:
 * positive when the turn is counter-clockwise seen from above (a rotation about +Y), from
 * -180 to 180.
 *
 * Both are camera orientations in the session frame, which is gravity-aligned, so a frame
 * that was redefined turns the world about the vertical and this is the heading change.
 * It is the twist of the relative rotation about +Y, not its full angle: a quick tilt of
 * the phone changes the full angle and does not change the heading, and a tilt is what a
 * person does when tapping. `NaN` when either orientation is not a rotation ({@link isRotation}),
 * which is the one way it differs from {@link yawAboutVerticalDeg} (and -180 is kept at the seam).
 */
export function yawTwistDeg(a: QuatLike, b: QuatLike): number {
  if (!isRotation(a) || !isRotation(b)) return Number.NaN
  const na = Math.hypot(a.x, a.y, a.z, a.w)
  const nb = Math.hypot(b.x, b.y, b.z, b.w)
  return twistAboutVerticalRad(
    { x: a.x / na, y: a.y / na, z: a.z / na, w: a.w / na },
    { x: b.x / nb, y: b.y / nb, z: b.z / nb, w: b.w / nb },
  ) * RAD_TO_DEG
}

/**
 * Compass-style heading about the vertical axis, in degrees, from a rotation
 * quaternion — the device's forward axis projected onto the horizontal plane.
 * The heading of ONE orientation: not {@link yawAboutVerticalDeg}, which is the
 * twist of the turn BETWEEN two, and the two agree only for a camera that is
 * turned and not tilted. src/capture/pose-delta.ts re-exports this as
 * `yawDegFromQuat`, the name it had there.
 *
 * This is the convention `src/viewer/viewer.ts`'s `updateWorldHud()` already
 * uses (`atan2` of `camera.getWorldDirection()`), and it agrees with
 * `src/world/geo.ts`'s `composeYUpTransform()` and `world/anchor-marker.ts`.
 * Keeping them in agreement matters: a yaw printed by this readout has to mean
 * the same thing as a yaw fed into a calibration transform, or the benchmark
 * measures one convention while the wave tunes another.
 *
 * **Not** the standard Y-Euler extraction, which an earlier version of this
 * used. That formula agrees with the projected-forward heading only when pitch
 * is zero, and the benchmark protocol explicitly has the operator point the
 * device at the floor: at a 50-degree downward hold it reported 20.4 degrees
 * for a true heading of 30, a 9.6-degree error against a benchmark whose
 * rotational drift target is 5. The instrument's own error was nearly twice
 * the threshold it exists to measure.
 *
 * Near-vertical pitch degrades the forward axis's horizontal projection toward
 * zero length, where its direction is noise. The device's up axis is exactly
 * horizontal in that pose and carries the same heading, so whichever of the two
 * has the longer horizontal projection is used. For a yaw-then-pitch rotation
 * both yield the identical angle, so the switch is seamless rather than a step.
 *
 * The up axis must be flipped when the device is tilted back rather than
 * forward: pointing straight down its up axis lies along the heading, but
 * pointing straight up it lies against it, and using it unflipped puts the
 * readout 180 degrees out for exactly half of the poses it exists to rescue.
 *
 * Identity rotation returns 0. Roll is not modelled; a handheld scanning device
 * has little, and "heading" is not well defined under large roll anyway.
 */
export function cameraHeadingDeg(q: QuatLike): number {
  const { x, y, z, w } = q

  // Body +Z (forward) and +Y (up) rotated into world space — the third and
  // second columns of the quaternion's rotation matrix.
  const fx = 2 * (x * z + w * y)
  const fy = 2 * (y * z - w * x)
  const fz = 1 - 2 * (x * x + y * y)
  const ux = 2 * (x * y - w * z)
  const uz = 2 * (y * z + w * x)

  if (Math.hypot(fx, fz) >= Math.hypot(ux, uz)) {
    return Math.atan2(fx, fz) * RAD_TO_DEG
  }
  // Tilted back (forward axis rising) means the up axis points behind the
  // heading, not along it.
  const flip = fy < 0 ? 1 : -1
  return Math.atan2(flip * ux, flip * uz) * RAD_TO_DEG
}

/** The conjugate of `q`: the inverse rotation, for a unit quaternion. */
export function conjugateQuat(q: QuatLike): QuatLike {
  return { x: -q.x, y: -q.y, z: -q.z, w: q.w }
}

/**
 * `v` rotated by `q`, which is normalised here: v' = v + w t + q x t, with t = 2 q x v and q the vector part. The
 * caller checks that `q` is a rotation first (a zero quaternion gives NaN). To rotate by the inverse, pass
 * {@link conjugateQuat}(q).
 */
export function rotateVectorByQuat(q: QuatLike, v: Vec3Like): Vec3Like {
  const n = Math.hypot(q.x, q.y, q.z, q.w)
  const qx = q.x / n
  const qy = q.y / n
  const qz = q.z / n
  const qw = q.w / n
  const tx = 2 * (qy * v.z - qz * v.y)
  const ty = 2 * (qz * v.x - qx * v.z)
  const tz = 2 * (qx * v.y - qy * v.x)
  return {
    x: v.x + qw * tx + (qy * tz - qz * ty),
    y: v.y + qw * ty + (qz * tx - qx * tz),
    z: v.z + qw * tz + (qx * ty - qy * tx),
  }
}

/**
 * The quaternion of a 3x3 rotation matrix given row-major (r00 r01 r02, r10 r11 r12, r20 r21 r22), by Shepperd's
 * method: the branch is picked by the largest of the trace and the three diagonal terms, so the divisor is never small
 * and every branch stays numerically stable. Not normalised: a matrix that is a rounding error off orthonormal gives a
 * quaternion the same rounding error off unit length, and a caller that needs unit length divides by its norm.
 */
export function quatFromRotationMatrix(m: ArrayLike<number>): QuatLike {
  const r00 = m[0]!
  const r01 = m[1]!
  const r02 = m[2]!
  const r10 = m[3]!
  const r11 = m[4]!
  const r12 = m[5]!
  const r20 = m[6]!
  const r21 = m[7]!
  const r22 = m[8]!
  const trace = r00 + r11 + r22
  if (trace > 0) {
    const s = Math.sqrt(trace + 1) * 2
    return { x: (r21 - r12) / s, y: (r02 - r20) / s, z: (r10 - r01) / s, w: 0.25 * s }
  }
  if (r00 > r11 && r00 > r22) {
    const s = Math.sqrt(1 + r00 - r11 - r22) * 2
    return { x: 0.25 * s, y: (r01 + r10) / s, z: (r02 + r20) / s, w: (r21 - r12) / s }
  }
  if (r11 > r22) {
    const s = Math.sqrt(1 + r11 - r00 - r22) * 2
    return { x: (r01 + r10) / s, y: 0.25 * s, z: (r12 + r21) / s, w: (r02 - r20) / s }
  }
  const s = Math.sqrt(1 + r22 - r00 - r11) * 2
  return { x: (r02 + r20) / s, y: (r12 + r21) / s, z: 0.25 * s, w: (r10 - r01) / s }
}

/**
 * Vertical field of view in degrees from a column-major perspective projection: 2·atan(1 / P[5]), P[5] being the
 * vertical focal term. NaN when P[5] is not a positive finite number, so a caller keeps what it had rather than take a
 * lens from nonsense. Both web providers read their lens with it. src/ar/native-codec.ts's `fovYDegFromProjection` is
 * the same number with a throw in place of the NaN.
 */
export function projectionFovYDeg(p: ArrayLike<number> | null | undefined): number {
  const f = p?.[5]
  return typeof f === 'number' && Number.isFinite(f) && f > 0 ? 2 * Math.atan(1 / f) * RAD_TO_DEG : Number.NaN
}

/** Width over height from a column-major perspective projection: P[5] / P[0]. NaN unless both focal terms are positive finite numbers. */
export function projectionAspect(p: ArrayLike<number> | null | undefined): number {
  const fx = p?.[0]
  const fy = p?.[5]
  const usable = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0
  return usable(fx) && usable(fy) ? fy / fx : Number.NaN
}

/**
 * How far the camera walked through `poses`, in metres, from index `fromIndex` on: the sum of the straight-line
 * distances between consecutive positions. A pose whose position is not a finite number is skipped and the walk goes
 * on from the last good one, so one bad sample neither adds nothing nor adds a jump. An index outside the list reads
 * as the nearest end, so a trail that was emptied after the index was taken measures what it holds now.
 */
export function pathLengthM(poses: ReadonlyArray<{ position: Vec3Like }>, fromIndex = 0): number {
  const start = Math.min(Math.max(Number.isFinite(fromIndex) ? Math.floor(fromIndex) : 0, 0), poses.length)
  let length = 0
  let last: Vec3Like | null = null
  for (let i = start; i < poses.length; i++) {
    const position = poses[i]!.position
    if (!position || !Number.isFinite(position.x) || !Number.isFinite(position.y) || !Number.isFinite(position.z)) continue
    if (last) length += Math.hypot(position.x - last.x, position.y - last.y, position.z - last.z)
    last = position
  }
  return length
}
