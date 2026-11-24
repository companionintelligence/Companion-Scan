/**
 * The one copy of each column-major matrix helper (src/world/mat4.ts), checked against three.js and against what the
 * copies it replaced answered (F-41, FN-081): the transform tools' `multiply` and `matricesClose`, the register
 * proposal's `multiplyMat4`, `matricesAgree`, `decomposeMatrix` and `isMatrix16`, the scan placement's
 * `placementTransform`, and the sidecar matrices' row-order reading.
 */
import { assert, assertAlmostEquals, assertEquals } from './assert.ts'
import * as THREE from 'three'
import { decomposeMat4, isMatrix16, mat4Close, matricesAgree, multiplyMat4 } from '../../../src/world/mat4.ts'
import {
  decomposeMatrix,
  isMatrix16 as proposalIsMatrix16,
  matricesAgree as proposalMatricesAgree,
  multiplyMat4 as proposalMultiply,
} from '../../../src/world/register-proposal.ts'
import { placementTransform } from '../../../src/world/scan-placement.ts'
import { matricesClose, multiply } from '../../../src/viewer/transform-tools.ts'
import { matrix4FromRowMajor } from '../../../src/viewer/splat-viewer.ts'
import { test } from 'node:test'

/** A rigid-plus-scale placement: a turn about a tilted axis, a size, a move. */
function sample(seed: number, mirror = false): number[] {
  const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(Math.sin(seed), 1, Math.cos(seed)).normalize(), seed * 0.7)
  const s = 0.5 + (seed % 5) * 0.3
  const m = new THREE.Matrix4().compose(new THREE.Vector3(seed, -seed * 0.5, 2), q, new THREE.Vector3(mirror ? -s : s, s, s))
  return m.toArray()
}

test('the old names are the shared functions, not copies', () => {
  assert(proposalIsMatrix16 === isMatrix16)
  assert(proposalMultiply === multiplyMat4)
  assert(proposalMatricesAgree === matricesAgree)
})

test('multiplyMat4 is THREE.Matrix4.multiply, and the transform tools use it', () => {
  for (let seed = 0; seed < 12; seed++) {
    const a = sample(seed)
    const b = sample(seed + 3)
    const three = new THREE.Matrix4().fromArray(a).multiply(new THREE.Matrix4().fromArray(b)).toArray()
    const mine = multiplyMat4(a, b)
    for (let i = 0; i < 16; i++) assertAlmostEquals(mine[i]!, three[i]!, 1e-12)
    assertEquals(multiply(a, b), mine)
  }
})

test('decomposeMat4 is THREE.Matrix4.decompose, mirrors included', () => {
  for (const mirror of [false, true]) {
    for (let seed = 0; seed < 12; seed++) {
      const m = sample(seed, mirror)
      const position = new THREE.Vector3()
      const rotation = new THREE.Quaternion()
      const scale = new THREE.Vector3()
      new THREE.Matrix4().fromArray(m).decompose(position, rotation, scale)
      const mine = decomposeMat4(m)
      for (const [a, b] of [[mine.position.x, position.x], [mine.position.y, position.y], [mine.position.z, position.z],
        [mine.scale.x, scale.x], [mine.scale.y, scale.y], [mine.scale.z, scale.z]] as const) assertAlmostEquals(a, b, 1e-12)
      // A quaternion and its negation are one rotation.
      const sign = Math.sign(mine.rotation.w * rotation.w + mine.rotation.x * rotation.x + mine.rotation.y * rotation.y + mine.rotation.z * rotation.z) || 1
      for (const [a, b] of [[mine.rotation.x, rotation.x], [mine.rotation.y, rotation.y], [mine.rotation.z, rotation.z], [mine.rotation.w, rotation.w]] as const) {
        assertAlmostEquals(a * sign, b, 1e-9)
      }
    }
  }
})

/** Ordinary, mirrored, flattened and zero-size matrices: what the copies were ever handed, and what they were not. */
function cases(): number[][] {
  const out: number[][] = []
  for (let seed = 0; seed < 10; seed++) {
    out.push(sample(seed), sample(seed, true))
    for (const axis of [0, 1, 2]) {
      const flat = sample(seed)
      flat[axis * 4] = 0; flat[axis * 4 + 1] = 0; flat[axis * 4 + 2] = 0
      out.push(flat)
    }
  }
  out.push(new Array(16).fill(0))
  return out
}

test('decomposeMatrix answers exactly what its copy did: null for a bad or flattened matrix, the same numbers otherwise', () => {
  assertEquals(decomposeMatrix([1, 2, 3]), null)
  assertEquals(decomposeMatrix([...sample(1).slice(0, 15), Number.NaN]), null)
  for (const m of cases()) assertEquals(decomposeMatrix(m), oldDecomposeMatrix(m), JSON.stringify(m))
})

test('placementTransform answers exactly what its copy did, a copy of the matrix included', () => {
  for (const m of cases()) {
    const patch = placementTransform(m)
    assertEquals(patch, oldPlacementTransform(m), JSON.stringify(m))
    assert(patch.matrix !== m, 'a copy, not the same array')
  }
})

test('mat4Close reads any list of 16; matricesAgree only arrays of 16 finite numbers', () => {
  const a = sample(4)
  const typed = Float32Array.from(a)
  assert(mat4Close(a, a))
  assert(mat4Close(typed, typed), 'a typed array is a list of 16 numbers')
  assertEquals(matricesAgree(typed, typed), false, 'the server reads a value of unknown shape strictly')
  assertEquals(matricesClose(a, a.map((v) => v + 1e-10)), true)
  assertEquals(matricesClose(a, a.map((v) => v + 1e-6)), false)
  const nan = [...a]
  nan[3] = Number.NaN
  assertEquals(mat4Close(nan, nan), false, 'NaN never agrees, even with itself')
  assertEquals(matricesAgree(nan, nan), false)
  assertEquals(mat4Close(a, a.slice(0, 15)), false)
})

test('isMatrix16: exactly 16 finite numbers, holes and all', () => {
  assert(isMatrix16(sample(5)))
  assertEquals(isMatrix16(new Array(16)), false, 'a sparse array')
  assertEquals(isMatrix16([...sample(5).slice(0, 15), Infinity]), false)
  assertEquals(isMatrix16('not a matrix'), false)
})

test('matrix4FromRowMajor reads a sidecar matrix in row order', () => {
  const columnMajor = sample(6)
  const rowMajor = new THREE.Matrix4().fromArray(columnMajor).transpose().toArray()
  assertEquals(matrix4FromRowMajor(rowMajor).toArray(), columnMajor)
})

// ── The two copies this replaced, verbatim from e897380 apart from their names ─────────────────────────────

function oldAxisStats(m: number[]) {
  const [a0, a1, a2, , b0, b1, b2, , c0, c1, c2] = m as [
    number, number, number, number, number, number, number, number, number, number, number,
  ]
  return {
    s0: Math.hypot(a0, a1, a2),
    s1: Math.hypot(b0, b1, b2),
    s2: Math.hypot(c0, c1, c2),
    d01: a0 * b0 + a1 * b1 + a2 * b2,
    d02: a0 * c0 + a1 * c1 + a2 * c2,
    d12: b0 * c0 + b1 * c1 + b2 * c2,
    det: a0 * (b1 * c2 - b2 * c1) + a1 * (b2 * c0 - b0 * c2) + a2 * (b0 * c1 - b1 * c0),
  }
}
function oldPlacementTransform(matrix: readonly number[]): { matrix: number[]; position: { x: number; y: number; z: number }; rotation: { x: number; y: number; z: number; w: number }; scale: { x: number; y: number; z: number } } {
  const m = [...matrix] as [
    number, number, number, number, number, number, number, number,
    number, number, number, number, number, number, number, number,
  ]
  const stats = oldAxisStats(m)
  const sx = stats.det < 0 ? -stats.s0 : stats.s0
  const sy = stats.s1
  const sz = stats.s2
  // Divide each axis by its own length to leave a pure rotation (an axis of length 0 cannot be
  // normalised; such a matrix is not a placement, and gets the identity rotation).
  const r = (value: number, scale: number): number => (scale === 0 ? 0 : value / scale)
  const m11 = r(m[0], sx), m21 = r(m[1], sx), m31 = r(m[2], sx)
  const m12 = r(m[4], sy), m22 = r(m[5], sy), m32 = r(m[6], sy)
  const m13 = r(m[8], sz), m23 = r(m[9], sz), m33 = r(m[10], sz)

  let x: number
  let y: number
  let z: number
  let w: number
  const trace = m11 + m22 + m33
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
  const finite = [x, y, z, w].every(Number.isFinite)
  return {
    matrix: [...matrix],
    position: { x: m[12], y: m[13], z: m[14] },
    rotation: finite ? { x, y, z, w } : { x: 0, y: 0, z: 0, w: 1 },
    scale: { x: sx, y: sy, z: sz },
  }
}
function oldDecomposeMatrix(m: readonly number[]): { position: { x: number; y: number; z: number }; rotation: { x: number; y: number; z: number; w: number }; scale: { x: number; y: number; z: number } } | null {
  if (!isMatrix16(m)) return null
  let sx = Math.hypot(m[0]!, m[1]!, m[2]!)
  const sy = Math.hypot(m[4]!, m[5]!, m[6]!)
  const sz = Math.hypot(m[8]!, m[9]!, m[10]!)
  if (!(sx > 0 && sy > 0 && sz > 0)) return null
  const det = m[0]! * (m[5]! * m[10]! - m[9]! * m[6]!) -
    m[4]! * (m[1]! * m[10]! - m[9]! * m[2]!) +
    m[8]! * (m[1]! * m[6]! - m[5]! * m[2]!)
  if (det < 0) sx = -sx

  // The rotation block with the scale divided out, named by row then column as three.js names it.
  const m11 = m[0]! / sx, m21 = m[1]! / sx, m31 = m[2]! / sx
  const m12 = m[4]! / sy, m22 = m[5]! / sy, m32 = m[6]! / sy
  const m13 = m[8]! / sz, m23 = m[9]! / sz, m33 = m[10]! / sz

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