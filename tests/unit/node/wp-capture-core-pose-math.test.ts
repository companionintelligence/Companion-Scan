/**
 * Wave 14, ticket 0004 (F-40: FN-029, FN-030, FN-038): the pose and frame maths in one home, src/shared/pose-math.ts.
 *
 * Each helper is run beside the copy it replaced, copied here verbatim from e897380, on seeded inputs: the same numbers
 * where the arithmetic is the same, and the same to within rounding where the new one is better conditioned (an
 * arctangent in place of an arccosine). The degenerate-input rules that differ on purpose are pinned for each name that
 * keeps one. The old paths still export what they always did, as the same functions.
 *
 * Run: node --experimental-strip-types --no-warnings --test tests/unit/node/wp-capture-core-pose-math.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  cameraHeadingDeg,
  conjugateQuat,
  isRotation,
  pathLengthM,
  projectionAspect,
  projectionFovYDeg,
  quatFromRotationMatrix,
  relativeRotation,
  rotateVectorByQuat,
  rotationAngleDeg,
  wrapDeg,
  yawAboutVerticalDeg,
  yawTwistDeg,
  type QuatLike,
  type Vec3Like,
} from '../../../src/shared/pose-math.ts'
import * as poseDelta from '../../../src/capture/pose-delta.ts'
import * as anchors from '../../../src/ar/anchors.ts'
import * as frameEpoch from '../../../src/ar/frame-epoch.ts'
import * as closure from '../../../src/ar/closure.ts'
import { matrixToQuat } from '../../../src/ar/fiducial/tag-pose.ts'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const read = (path: string): string => readFileSync(resolve(ROOT, path), 'utf8')

// ── Seeded inputs ────────────────────────────────────────────────────────────

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function unitQuat(rand: () => number): QuatLike {
  const q = { x: rand() * 2 - 1, y: rand() * 2 - 1, z: rand() * 2 - 1, w: rand() * 2 - 1 }
  const n = Math.hypot(q.x, q.y, q.z, q.w)
  return { x: q.x / n, y: q.y / n, z: q.z / n, w: q.w / n }
}

/** A unit quaternion `deg` away from `q`, about a random axis: the small turns where an arccosine loses its digits. */
function near(q: QuatLike, deg: number, rand: () => number): QuatLike {
  const axis = { x: rand() * 2 - 1, y: rand() * 2 - 1, z: rand() * 2 - 1 }
  const n = Math.hypot(axis.x, axis.y, axis.z)
  const h = (deg * Math.PI) / 360
  const d = { x: (axis.x / n) * Math.sin(h), y: (axis.y / n) * Math.sin(h), z: (axis.z / n) * Math.sin(h), w: Math.cos(h) }
  return {
    x: d.w * q.x + d.x * q.w + d.y * q.z - d.z * q.y,
    y: d.w * q.y - d.x * q.z + d.y * q.w + d.z * q.x,
    z: d.w * q.z + d.x * q.y - d.y * q.x + d.z * q.w,
    w: d.w * q.w - d.x * q.x - d.y * q.y - d.z * q.z,
  }
}

const vec = (rand: () => number, scale = 4): Vec3Like => ({ x: (rand() * 2 - 1) * scale, y: (rand() * 2 - 1) * scale, z: (rand() * 2 - 1) * scale })
const ZERO: QuatLike = { x: 0, y: 0, z: 0, w: 0 }
const IDENTITY: QuatLike = { x: 0, y: 0, z: 0, w: 1 }
const N = 20_000

// ── The copies, as they were at e897380 ─────────────────────────────────────

const RAD_TO_DEG = 180 / Math.PI

/** src/ar/anchors.ts:376-405. */
const old = {
  relativeRotation(from: QuatLike, to: QuatLike): QuatLike {
    return {
      x: -to.w * from.x + to.x * from.w - to.y * from.z + to.z * from.y,
      y: -to.w * from.y + to.x * from.z + to.y * from.w - to.z * from.x,
      z: -to.w * from.z - to.x * from.y + to.y * from.x + to.z * from.w,
      w: to.w * from.w + to.x * from.x + to.y * from.y + to.z * from.z,
    }
  },
  rotationAngleDeg(a: QuatLike, b: QuatLike): number {
    const r = old.relativeRotation(a, b)
    return 2 * Math.atan2(Math.hypot(r.x, r.y, r.z), Math.abs(r.w)) * RAD_TO_DEG
  },
  yawAboutVerticalDeg(a: QuatLike, b: QuatLike): number {
    const r = old.relativeRotation(a, b)
    return wrapDeg(2 * Math.atan2(r.y, r.w) * RAD_TO_DEG)
  },
  /** src/ar/frame-epoch.ts:623-635. */
  yawTwistDeg(a: QuatLike, b: QuatLike): number {
    const na = Math.hypot(a.x, a.y, a.z, a.w)
    const nb = Math.hypot(b.x, b.y, b.z, b.w)
    if (!(na > 0) || !(nb > 0)) return Number.NaN
    const ax = a.x / na, ay = a.y / na, az = a.z / na, aw = a.w / na
    const bx = b.x / nb, by = b.y / nb, bz = b.z / nb, bw = b.w / nb
    let w = bw * aw + bx * ax + by * ay + bz * az
    let y = aw * by - bw * ay + az * bx - ax * bz
    if (w < 0) { w = -w; y = -y }
    return 2 * Math.atan2(y, w) * (180 / Math.PI)
  },
  /** src/capture/pose-delta.ts:73-91. */
  yawDegFromQuat(q: QuatLike): number {
    const { x, y, z, w } = q
    const fx = 2 * (x * z + w * y)
    const fy = 2 * (y * z - w * x)
    const fz = 1 - 2 * (x * x + y * y)
    const ux = 2 * (x * y - w * z)
    const uz = 2 * (y * z + w * x)
    if (Math.hypot(fx, fz) >= Math.hypot(ux, uz)) return Math.atan2(fx, fz) * RAD_TO_DEG
    const flip = fy < 0 ? 1 : -1
    return Math.atan2(flip * ux, flip * uz) * RAD_TO_DEG
  },
  /** src/ar/tap-sampling.ts:436-439, radians. */
  turnBetween(a: QuatLike, b: QuatLike): number {
    const dot = Math.abs(a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w) / (Math.hypot(a.x, a.y, a.z, a.w) * Math.hypot(b.x, b.y, b.z, b.w))
    return 2 * Math.acos(Math.min(1, dot))
  },
  /** src/capture/keyframes.ts:390-395, degrees, for the unit quaternions a provider hands it. */
  keyframeTurnDeg(a: QuatLike, b: QuatLike): number {
    const dot = Math.abs(a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w)
    return 2 * Math.acos(Math.min(1, dot)) * (180 / Math.PI)
  },
  /** src/ar/ground-gate.ts:256-267: d turned by q. */
  rotate(q: QuatLike, d: Vec3Like): Vec3Like {
    const norm = Math.hypot(q.x, q.y, q.z, q.w)
    const [qx, qy, qz, qw] = [q.x / norm, q.y / norm, q.z / norm, q.w / norm]
    const tx = 2 * (qy * d.z - qz * d.y)
    const ty = 2 * (qz * d.x - qx * d.z)
    const tz = 2 * (qx * d.y - qy * d.x)
    return { x: d.x + qw * tx + (qy * tz - qz * ty), y: d.y + qw * ty + (qz * tx - qx * tz), z: d.z + qw * tz + (qx * ty - qy * tx) }
  },
  /** src/ar/reference-photo.ts:181-195: d turned by the inverse of q. */
  rotateInverse(q: QuatLike, d: Vec3Like): Vec3Like {
    const norm = Math.hypot(q.x, q.y, q.z, q.w)
    const qx = -q.x / norm, qy = -q.y / norm, qz = -q.z / norm, qw = q.w / norm
    const tx = 2 * (qy * d.z - qz * d.y)
    const ty = 2 * (qz * d.x - qx * d.z)
    const tz = 2 * (qx * d.y - qy * d.x)
    return { x: d.x + qw * tx + (qy * tz - qz * ty), y: d.y + qw * ty + (qz * tx - qx * tz), z: d.z + qw * tz + (qx * ty - qy * tx) }
  },
  /** src/export/summary.ts:59-66. */
  summaryPath(poses: ReadonlyArray<{ position: Vec3Like }>): number {
    let length = 0
    for (let i = 1; i < poses.length; i++) {
      const a = poses[i - 1]!.position
      const b = poses[i]!.position
      const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z
      length += Math.sqrt(dx * dx + dy * dy + dz * dz)
    }
    return length
  },
  /** src/ar/webxr.ts:326-331 and src/ar/eighthwall.ts:572-575. */
  fovY: (p: ArrayLike<number>): number => 2 * Math.atan(1 / p[5]!) * (180 / Math.PI),
  aspect: (p: ArrayLike<number>): number => p[5]! / p[0]!,
  /**
   * src/ar/native-codec.ts:42-86 at e897380, the rotation half of `poseFromTransform`: Shepperd's method on the upper 3x3
   * of a column-major 4x4. Copied rather than imported because that file is another session's and may change; this is
   * the arithmetic the shared helper must match for it to be a drop-in.
   */
  nativeDecode(m: readonly number[]): QuatLike {
    const r00 = m[0]!, r01 = m[4]!, r02 = m[8]!
    const r10 = m[1]!, r11 = m[5]!, r12 = m[9]!
    const r20 = m[2]!, r21 = m[6]!, r22 = m[10]!
    const trace = r00 + r11 + r22
    let x: number, y: number, z: number, w: number
    if (trace > 0) {
      const s = Math.sqrt(trace + 1) * 2
      w = 0.25 * s; x = (r21 - r12) / s; y = (r02 - r20) / s; z = (r10 - r01) / s
    } else if (r00 > r11 && r00 > r22) {
      const s = Math.sqrt(1 + r00 - r11 - r22) * 2
      w = (r21 - r12) / s; x = 0.25 * s; y = (r01 + r10) / s; z = (r02 + r20) / s
    } else if (r11 > r22) {
      const s = Math.sqrt(1 + r11 - r00 - r22) * 2
      w = (r02 - r20) / s; x = (r01 + r10) / s; y = 0.25 * s; z = (r12 + r21) / s
    } else {
      const s = Math.sqrt(1 + r22 - r00 - r11) * 2
      w = (r10 - r01) / s; x = (r02 + r20) / s; y = (r12 + r21) / s; z = 0.25 * s
    }
    return { x, y, z, w }
  },
  /** src/ar/native-codec.ts:89-99 at e897380, without its matrix check and its throw. */
  nativeFovY: (p: readonly number[]): number => (2 * Math.atan(1 / p[5]!) * 180) / Math.PI,
  nativeAspect: (p: readonly number[]): number => p[5]! / p[0]!,
}

/** A row-major rotation matrix for q, as the fiducial code builds one. */
function matrixOf(q: QuatLike): number[] {
  const { x, y, z, w } = q
  return [
    1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w),
    2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w),
    2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y),
  ]
}

/** The same rotation as a column-major camera-to-world 4x4, as the native shells send one. */
function transformOf(q: QuatLike, t: Vec3Like): number[] {
  const r = matrixOf(q)
  return [r[0]!, r[3]!, r[6]!, 0, r[1]!, r[4]!, r[7]!, 0, r[2]!, r[5]!, r[8]!, 0, t.x, t.y, t.z, 1]
}

const sameRotation = (a: QuatLike, b: QuatLike, tol: number): boolean =>
  Math.abs(Math.abs(a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w) - 1) < tol

// ── Old against new ──────────────────────────────────────────────────────────

test('rotationAngleDeg is the anchors\' copy, number for number', () => {
  const rand = mulberry32(1)
  for (let i = 0; i < N; i++) {
    const a = unitQuat(rand)
    const b = i % 2 ? unitQuat(rand) : near(a, rand() * 2, rand)
    assert.equal(rotationAngleDeg(a, b), old.rotationAngleDeg(a, b))
  }
  assert.equal(rotationAngleDeg(IDENTITY, ZERO), 0, 'a zero quaternion is no turn, as the anchors always read it')
  assert.ok(Number.isNaN(rotationAngleDeg(IDENTITY, { x: Number.NaN, y: 0, z: 0, w: 1 })), 'NaN in, NaN out')
})

test('yawAboutVerticalDeg is the anchors\' copy to within rounding, and keeps its rules', () => {
  const rand = mulberry32(2)
  for (let i = 0; i < N; i++) {
    const a = unitQuat(rand)
    const b = unitQuat(rand)
    const was = old.yawAboutVerticalDeg(a, b)
    const now = yawAboutVerticalDeg(a, b)
    // At the seam the two spellings of one angle are 180 and -180 apart by rounding alone, so compare on the circle.
    assert.ok(Math.abs(wrapDeg(now - was)) < 1e-9, `${now} against ${was}`)
    assert.ok(now > -180 && now <= 180)
  }
  assert.equal(yawAboutVerticalDeg(IDENTITY, ZERO), 0, 'a zero quaternion has no turn')
  assert.equal(yawAboutVerticalDeg({ x: 0, y: 0, z: 0, w: 1 }, { x: 0, y: 1, z: 0, w: 0 }), 180, 'the seam is +180')
})

test('yawTwistDeg is the frame tracker\'s copy to within rounding, and keeps its NaN and its -180', () => {
  const rand = mulberry32(3)
  for (let i = 0; i < N; i++) {
    const a = unitQuat(rand)
    const u = unitQuat(rand)
    // Every third one three times unit length: the old copy normalised first, and so does the new one.
    const b = i % 3 === 0 ? { x: 3 * u.x, y: 3 * u.y, z: 3 * u.z, w: 3 * u.w } : u
    const was = old.yawTwistDeg(a, b)
    const now = yawTwistDeg(a, b)
    assert.ok(Math.abs(now - was) < 1e-9, `${now} against ${was}`)
    assert.ok(now >= -180 && now <= 180)
  }
  for (const bad of [ZERO, { x: Number.NaN, y: 0, z: 0, w: 1 }, { x: Number.POSITIVE_INFINITY, y: 0, z: 0, w: 1 }]) {
    assert.ok(Number.isNaN(yawTwistDeg(IDENTITY, bad)), JSON.stringify(bad))
    assert.ok(Number.isNaN(old.yawTwistDeg(IDENTITY, bad)), `the old copy agreed: ${JSON.stringify(bad)}`)
  }
  assert.equal(yawTwistDeg({ x: 0, y: 0, z: 0, w: 1 }, { x: 0, y: -1, z: 0, w: 0 }), -180, 'the seam keeps its sign')
  assert.equal(old.yawTwistDeg({ x: 0, y: 0, z: 0, w: 1 }, { x: 0, y: -1, z: 0, w: 0 }), -180)
})

test('the two twists are one quantity: they differ only on a zero quaternion and at the seam', () => {
  const rand = mulberry32(4)
  for (let i = 0; i < N; i++) {
    const a = unitQuat(rand)
    const b = unitQuat(rand)
    assert.ok(Math.abs(wrapDeg(yawTwistDeg(a, b) - yawAboutVerticalDeg(a, b))) < 1e-9)
  }
})

test('cameraHeadingDeg is pose-delta\'s heading, number for number, and is not the twist', () => {
  const rand = mulberry32(5)
  for (let i = 0; i < N; i++) {
    const q = unitQuat(rand)
    assert.equal(cameraHeadingDeg(q), old.yawDegFromQuat(q))
  }
  // Where the two disagree, and why they keep different names: a camera pitched 30 degrees and then rolled 40 degrees
  // about its own view direction looks the same way, so its heading does not move, but the turn between the two
  // orientations is about a tilted axis and has a twist about the vertical of 2·atan(-sin 30 · tan 20), about -20.6.
  const about = (axis: Vec3Like, deg: number): QuatLike => {
    const h = (deg * Math.PI) / 360
    return { x: axis.x * Math.sin(h), y: axis.y * Math.sin(h), z: axis.z * Math.sin(h), w: Math.cos(h) }
  }
  const mul = (p: QuatLike, q: QuatLike): QuatLike => ({
    x: p.w * q.x + p.x * q.w + p.y * q.z - p.z * q.y,
    y: p.w * q.y - p.x * q.z + p.y * q.w + p.z * q.x,
    z: p.w * q.z + p.x * q.y - p.y * q.x + p.z * q.w,
    w: p.w * q.w - p.x * q.x - p.y * q.y - p.z * q.z,
  })
  const pitched = about({ x: 1, y: 0, z: 0 }, 30)
  const rolled = mul(pitched, about({ x: 0, y: 0, z: 1 }, 40))
  assert.ok(Math.abs(wrapDeg(cameraHeadingDeg(rolled) - cameraHeadingDeg(pitched))) < 1e-9, 'the view direction did not move')
  const twist = yawAboutVerticalDeg(pitched, rolled)
  assert.ok(Math.abs(twist - 2 * Math.atan(-Math.sin(Math.PI / 6) * Math.tan(Math.PI / 9)) * RAD_TO_DEG) < 1e-9, `${twist}`)
  assert.ok(Math.abs(twist) > 20)
})

test('tap-sampling\'s turn is the shared angle in radians: the same to within an arccosine\'s rounding, NaN where it was', () => {
  const rand = mulberry32(6)
  let worst = 0
  for (let i = 0; i < N; i++) {
    const a = unitQuat(rand)
    const b = i % 2 ? unitQuat(rand) : near(a, rand() * 5, rand)
    const now = isRotation(a) && isRotation(b) ? rotationAngleDeg(a, b) * (Math.PI / 180) : Number.NaN
    worst = Math.max(worst, Math.abs(now - old.turnBetween(a, b)))
  }
  // An arccosine of a dot product within 1e-16 of one is good to about 1.5e-8 rad; the arctangent to 1e-16.
  assert.ok(worst < 5e-8, `worst ${worst}`)
  assert.ok(Number.isNaN(old.turnBetween(IDENTITY, ZERO)), 'the old copy read a zero quaternion as NaN')
  assert.equal(isRotation(ZERO), false, 'and the new one asks isRotation first, so it does too')
  const src = read('src/ar/tap-sampling.ts')
  assert.match(src, /isRotation\(a\) && isRotation\(b\) \? rotationAngleDeg\(a, b\) \* \(Math\.PI \/ 180\) : Number\.NaN/)
})

test('the keyframer\'s turn is the shared angle: the same for unit quaternions, and exact near zero where acos was not', () => {
  const rand = mulberry32(7)
  for (let i = 0; i < N; i++) {
    const a = unitQuat(rand)
    const b = i % 2 ? unitQuat(rand) : near(a, rand() * 30, rand)
    assert.ok(Math.abs(rotationAngleDeg(a, b) - old.keyframeTurnDeg(a, b)) < 1e-5)
  }
  const a = unitQuat(rand)
  const tiny = near(a, 1e-6, rand)
  assert.ok(Math.abs(rotationAngleDeg(a, tiny) - 1e-6) < 1e-10, 'a millionth of a degree is measured')
})

test('rotateVectorByQuat is ground-gate\'s rotation, and with the conjugate reference-photo\'s inverse one', () => {
  const rand = mulberry32(8)
  for (let i = 0; i < N; i++) {
    // Not unit length: both copies normalised first, and so does the shared one.
    const raw = unitQuat(rand)
    const s = 0.5 + rand() * 2
    const q = { x: raw.x * s, y: raw.y * s, z: raw.z * s, w: raw.w * s }
    const v = vec(rand)
    const turned = rotateVectorByQuat(q, v)
    const wasTurned = old.rotate(q, v)
    const back = rotateVectorByQuat(conjugateQuat(q), v)
    const wasBack = old.rotateInverse(q, v)
    for (const axis of ['x', 'y', 'z'] as const) {
      assert.ok(Math.abs(turned[axis] - wasTurned[axis]) < 1e-12)
      assert.ok(Math.abs(back[axis] - wasBack[axis]) < 1e-12)
    }
    const round = rotateVectorByQuat(conjugateQuat(q), turned)
    assert.ok(Math.hypot(round.x - v.x, round.y - v.y, round.z - v.z) < 1e-9, 'and the conjugate undoes it')
  }
})

test('quatFromRotationMatrix is the native codec\'s Shepperd decode exactly, and the fiducial one after its normalisation', () => {
  const rand = mulberry32(9)
  for (let i = 0; i < N; i++) {
    const q = unitQuat(rand)
    const m = matrixOf(q)
    const shared = quatFromRotationMatrix(m)
    const native = old.nativeDecode(transformOf(q, vec(rand)))
    assert.deepEqual(shared, native, 'the same branches and the same arithmetic as src/ar/native-codec.ts had at e897380')
    const n = Math.hypot(shared.x, shared.y, shared.z, shared.w)
    assert.deepEqual(matrixToQuat(m), { x: shared.x / n, y: shared.y / n, z: shared.z / n, w: shared.w / n })
    assert.ok(sameRotation(shared, q, 1e-9), 'and it is the rotation the matrix was built from')
  }
  // Each of Shepperd's four branches.
  for (const q of [IDENTITY, { x: 1, y: 0, z: 0, w: 0 }, { x: 0, y: 1, z: 0, w: 0 }, { x: 0, y: 0, z: 1, w: 0 }]) {
    assert.ok(sameRotation(quatFromRotationMatrix(matrixOf(q)), q, 1e-12), JSON.stringify(q))
  }
})

test('projectionFovYDeg and projectionAspect are the providers\' lens, and the native codec\'s without its throw', () => {
  const rand = mulberry32(10)
  for (let i = 0; i < 2000; i++) {
    const fovY = 20 + rand() * 120
    const aspect = 0.3 + rand() * 2
    const f = 1 / Math.tan((fovY * Math.PI) / 360)
    const p = [f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, -1.0002, -1, 0, 0, -0.020002, 0]
    assert.equal(projectionFovYDeg(p), old.fovY(p), 'the formula the web providers used')
    assert.equal(projectionAspect(p), old.aspect(p))
    assert.ok(Math.abs(projectionFovYDeg(p) - old.nativeFovY(p)) < 1e-12)
    assert.ok(Math.abs(projectionAspect(p) - old.nativeAspect(p)) < 1e-12)
    assert.ok(Math.abs(projectionFovYDeg(p) - fovY) < 1e-9)
  }
  const flat = new Float32Array([1.5, 0, 0, 0, 0, 2, 0, 0, 0, 0, -1, -1, 0, 0, -0.02, 0])
  assert.ok(projectionFovYDeg(flat) > 0, 'a typed array, as WebXR hands one')
  for (const bad of [null, undefined, [], [1, 0, 0, 0, 0, 0], [1, 0, 0, 0, 0, -2], [0, 0, 0, 0, 0, 2], [Number.NaN, 0, 0, 0, 0, 2]]) {
    const p = bad as ArrayLike<number> | null | undefined
    if (bad && (bad as number[])[5] === 2) assert.ok(projectionFovYDeg(p) > 0, 'the field of view stands without a usable aspect')
    else assert.ok(Number.isNaN(projectionFovYDeg(p)), JSON.stringify(bad))
    assert.ok(Number.isNaN(projectionAspect(p)), JSON.stringify(bad))
  }
})

test('pathLengthM is the summary\'s walk for finite poses, and skips a pose that is not a number instead of becoming NaN', () => {
  const rand = mulberry32(11)
  for (let i = 0; i < 500; i++) {
    const poses = Array.from({ length: 1 + Math.floor(rand() * 40) }, () => ({ position: vec(rand, 10) }))
    assert.ok(Math.abs(pathLengthM(poses) - old.summaryPath(poses)) < 1e-9)
  }
  const broken = [{ position: { x: 0, y: 0, z: 0 } }, { position: { x: Number.NaN, y: 0, z: 0 } }, { position: { x: 3, y: 4, z: 0 } }]
  assert.ok(Number.isNaN(old.summaryPath(broken)), 'the summary used to print NaN')
  assert.equal(pathLengthM(broken), 5)
  assert.match(read('src/export/summary.ts'), /walkedM\(poseHistory\)/)
})

test('relativeRotation takes from to to in the world frame', () => {
  const rand = mulberry32(12)
  for (let i = 0; i < 2000; i++) {
    const a = unitQuat(rand)
    const b = unitQuat(rand)
    const r = relativeRotation(a, b)
    // r * a == b, up to sign.
    const ra = {
      x: r.w * a.x + r.x * a.w + r.y * a.z - r.z * a.y,
      y: r.w * a.y - r.x * a.z + r.y * a.w + r.z * a.x,
      z: r.w * a.z + r.x * a.y - r.y * a.x + r.z * a.w,
      w: r.w * a.w - r.x * a.x - r.y * a.y - r.z * a.z,
    }
    assert.ok(sameRotation(ra, b, 1e-9))
  }
})

// ── The old paths still export the same functions ───────────────────────────

test('every old export is still there, and is the shared function', () => {
  assert.equal(poseDelta.wrapDeg, wrapDeg)
  assert.equal(poseDelta.yawDegFromQuat, cameraHeadingDeg)
  assert.equal(anchors.rotationAngleDeg, rotationAngleDeg)
  assert.equal(anchors.yawAboutVerticalDeg, yawAboutVerticalDeg)
  assert.equal(frameEpoch.yawTwistDeg, yawTwistDeg)
  assert.equal(frameEpoch.yawDeltaDeg(IDENTITY, { x: 0, y: Math.sin(Math.PI / 18), z: 0, w: Math.cos(Math.PI / 18) }).toFixed(9), '20.000000000')
  assert.equal(closure.pathLengthM, pathLengthM)
})

test('the copies are gone from the files that held them', () => {
  assert.doesNotMatch(read('src/ar/anchors.ts'), /function relativeRotation|export function rotationAngleDeg|export function yawAboutVerticalDeg/)
  assert.doesNotMatch(read('src/ar/frame-epoch.ts'), /export function yawTwistDeg/)
  assert.doesNotMatch(read('src/capture/pose-delta.ts'), /export function (wrapDeg|yawDegFromQuat)/)
  assert.doesNotMatch(read('src/ar/tap-sampling.ts'), /Math\.acos/)
  assert.doesNotMatch(read('src/capture/keyframes.ts'), /Math\.acos/)
  for (const path of ['src/ar/ground-gate.ts', 'src/ar/reference-photo.ts']) {
    assert.doesNotMatch(read(path), /const tx = 2 \* \(qy \*/, path)
  }
  assert.doesNotMatch(read('src/ar/fiducial/tag-pose.ts'), /Math\.sqrt\(tr \+ 1\)/)
  for (const path of ['src/ar/eighthwall.ts', 'src/ar/webxr.ts']) {
    assert.doesNotMatch(read(path), /Math\.atan\(1 \/ proj\[5\]\)/, path)
  }
  assert.doesNotMatch(read('src/ar/closure.ts'), /export function pathLengthM/)
})

test('pose-math.ts imports nothing', () => {
  assert.doesNotMatch(read('src/shared/pose-math.ts'), /^import /m)
})
