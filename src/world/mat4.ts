/**
 * Column-major 4x4 matrices, the layout `THREE.Matrix4.fromArray` reads and every `localToWorld`, `sessionToProject`
 * and patch `matrix` in this repo is written in. The editor's transform tools (src/viewer/transform-tools.ts), the
 * register proposal (./register-proposal.ts), a scan's placement (./scan-placement.ts) and the anchor placement
 * (./anchor-placement.ts) each used to keep their own copy of these (F-41, FN-081). One copy each now, here.
 *
 * Pure, and imported by the server (server/register/place_register.ts, through ./register-proposal.ts) and by the
 * browser, so it has no Deno, DOM or THREE reference (ADR 0002).
 */

/** Three numbers: a position or an axis length. */
export interface Vec3Like {
  x: number
  y: number
  z: number
}

/** A unit quaternion, as `THREE.Quaternion` holds it. */
export interface QuatLike {
  x: number
  y: number
  z: number
  w: number
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/** True for exactly 16 finite numbers. Indexed, so a sparse array's holes do not slip through. */
export function isMatrix16(value: unknown): value is number[] {
  if (!Array.isArray(value) || value.length !== 16) return false
  for (let i = 0; i < 16; i++) {
    if (!isFiniteNumber(value[i])) return false
  }
  return true
}

/**
 * The column-major product `a · b`: the matrix that applies `b` first and `a` second. Both are 4x4. The caller checks
 * them with {@link isMatrix16}.
 */
export function multiplyMat4(a: readonly number[], b: readonly number[]): number[] {
  const out = new Array<number>(16)
  for (let col = 0; col < 4; col++) {
    for (let row = 0; row < 4; row++) {
      let sum = 0
      for (let k = 0; k < 4; k++) sum += a[k * 4 + row]! * b[col * 4 + k]!
      out[col * 4 + row] = sum
    }
  }
  return out
}

/**
 * Whether two 16-entry matrices are the same to within `tolerance` on every entry. Any list-like of 16 numbers is
 * compared (a `matrix.toArray()` and a typed array alike), and an entry that is NaN or infinite on either side never
 * agrees. {@link matricesAgree} is the stricter reading for a value of unknown shape.
 */
export function mat4Close(a: ArrayLike<number>, b: ArrayLike<number>, tolerance = 1e-9): boolean {
  if (a.length !== 16 || b.length !== 16) return false
  for (let i = 0; i < 16; i++) {
    if (!(Math.abs(a[i]! - b[i]!) <= tolerance)) return false
  }
  return true
}

/** Both are 16 finite numbers in an array, and no entry differs by more than `tolerance`. */
export function matricesAgree(a: unknown, b: unknown, tolerance = 1e-9): boolean {
  return isMatrix16(a) && isMatrix16(b) && mat4Close(a, b, tolerance)
}

/**
 * Position, rotation and scale of a column-major affine matrix: `Matrix4.decompose` from three.js (MIT, already a
 * dependency; see THIRD_PARTY.md), ported so the server needs no THREE. A test cross-checks it against the real one.
 *
 * A negative determinant is read as a mirror on x, as three.js reads it. An axis of length 0 cannot be divided out;
 * it contributes 0 to the rotation block, which then leaves `rotation` non-finite or meaningless: a caller that cannot
 * take that checks the axis lengths first (`decomposeMatrix` in ./register-proposal.ts refuses such a matrix, and
 * `placementTransform` in ./scan-placement.ts falls back to the identity rotation).
 */
export function decomposeMat4(m: readonly number[]): { position: Vec3Like; rotation: QuatLike; scale: Vec3Like } {
  let sx = Math.hypot(m[0]!, m[1]!, m[2]!)
  const sy = Math.hypot(m[4]!, m[5]!, m[6]!)
  const sz = Math.hypot(m[8]!, m[9]!, m[10]!)
  const det = m[0]! * (m[5]! * m[10]! - m[9]! * m[6]!) -
    m[4]! * (m[1]! * m[10]! - m[9]! * m[2]!) +
    m[8]! * (m[1]! * m[6]! - m[5]! * m[2]!)
  if (det < 0) sx = -sx

  // The rotation block with the scale divided out, named by row then column as three.js names it.
  const r = (value: number, scale: number): number => (scale === 0 ? 0 : value / scale)
  const m11 = r(m[0]!, sx), m21 = r(m[1]!, sx), m31 = r(m[2]!, sx)
  const m12 = r(m[4]!, sy), m22 = r(m[5]!, sy), m32 = r(m[6]!, sy)
  const m13 = r(m[8]!, sz), m23 = r(m[9]!, sz), m33 = r(m[10]!, sz)

  const trace = m11 + m22 + m33
  let x: number, y: number, z: number, w: number
  if (trace > 0) {
    const s = 0.5 / Math.sqrt(trace + 1)
    w = 0.25 / s
    x = (m32 - m23) * s
    y = (m13 - m31) * s
    z = (m21 - m12) * s
  } else if (m11 > m22 && m11 > m33) {
    const s = 2 * Math.sqrt(1 + m11 - m22 - m33)
    w = (m32 - m23) / s
    x = 0.25 * s
    y = (m12 + m21) / s
    z = (m13 + m31) / s
  } else if (m22 > m33) {
    const s = 2 * Math.sqrt(1 + m22 - m11 - m33)
    w = (m13 - m31) / s
    x = (m12 + m21) / s
    y = 0.25 * s
    z = (m23 + m32) / s
  } else {
    const s = 2 * Math.sqrt(1 + m33 - m11 - m22)
    w = (m21 - m12) / s
    x = (m13 + m31) / s
    y = (m23 + m32) / s
    z = 0.25 * s
  }
  return {
    position: { x: m[12]!, y: m[13]!, z: m[14]! },
    rotation: { x, y, z, w },
    scale: { x: sx, y: sy, z: sz },
  }
}
