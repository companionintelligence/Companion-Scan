/**
 * The Place frame a marker defines (`src/ar/fiducial/tag-frame.ts`): its matrix convention, the mounts it takes and refuses, the floor
 * it uses, and the one property that makes a printed marker worth having, that two sessions which disagree about where their own origin
 * is agree about where a physical point is in the frame the marker defines.
 *
 * The convention is column-major, the layout of `transformPoint` in `src/world/geo.ts`, and is checked against that function, against
 * `twoPointToProjectTransform` (the same rotation about the vertical, the same sign of it) and against `invertAffine` from
 * `src/world/anchor-placement.ts`, which is documented to invert a rotation about Y with a uniform scale. Where a number is checked, the
 * expected value is computed here from the tag's own axes, not by the code under test.
 *
 * Run: node --experimental-strip-types --no-warnings --test tests/unit/node/fiducial_tag_frame.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  FLOOR_MOUNT_DISAGREE_M,
  HORIZONTAL_MIN_NORMAL_Y,
  TAG_HEIGHT_MAX_M,
  TAG_HEIGHT_MIN_M,
  WALL_MAX_NORMAL_Y,
  classifyMount,
  tagFrameTransform,
  type TagFrame,
  type TagFrameOptions,
  type TagFrameRefused,
} from '../../../src/ar/fiducial/tag-frame.ts'
import { invertAffine } from '../../../src/world/anchor-placement.ts'
import { transformPoint, twoPointToProjectTransform } from '../../../src/world/geo.ts'
import type { FusedTagPose } from '../../../src/ar/fiducial/types.ts'
import type { Pose } from '../../../src/ar/provider.ts'
import { mat3Mul, matrixFromQuat, quatFromMatrix, rotX, rotY, rotZ } from '../../support/fiducial-render.ts'
import { flatTag, fixedTag } from '../../support/fiducial-scene.ts'
import { mulberry32 } from '../../../src/shared/test-homes.ts'

const DEG = Math.PI / 180

function fused(pose: Pose | null): Pick<FusedTagPose, 'status' | 'pose'> {
  return { status: pose ? 'ok' : 'rejected', pose }
}

function ok(result: TagFrame | TagFrameRefused): TagFrame {
  assert.equal(result.status, 'ok', result.status === 'refused' ? `refused: ${result.reason}` : '')
  return result as TagFrame
}

function refused(result: TagFrame | TagFrameRefused): TagFrameRefused {
  assert.equal(result.status, 'refused')
  return result as TagFrameRefused
}

const near = (a: number, b: number, eps = 1e-9): boolean => Math.abs(a - b) <= eps
const dist = (a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }): number => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)

/** A wall tag facing the direction `yawDeg` (session yaw: 0 faces +z, 90 faces +x), centre at `position`. */
function wallTag(yawDeg: number, position = { x: 1.3, y: 1.4, z: -2.1 }): Pose {
  return fixedTag(yawDeg, 0, position)
}

const BASE: TagFrameOptions = { floorY: 0.1, mountHeightM: null, sessionUnitsPerMetre: 1 }

test('mount classification: below 0.3 a wall, above 0.9 flat, and the band between, limits included, is tilted', () => {
  assert.equal(WALL_MAX_NORMAL_Y, 0.3)
  assert.equal(HORIZONTAL_MIN_NORMAL_Y, 0.9)
  for (const [n, want] of [[0, 'wall'], [0.299999, 'wall'], [-0.299999, 'wall'], [0.3, 'tilted'], [-0.3, 'tilted'], [0.3001, 'tilted'], [0.6, 'tilted'], [0.9, 'tilted'], [-0.9, 'tilted'], [0.9001, 'horizontal'], [-0.9001, 'horizontal'], [1, 'horizontal'], [-1, 'horizontal']] as const) {
    assert.equal(classifyMount(n), want, `normal y ${n}`)
  }
})

test('a wall tag: +Z is its outward normal, +X its printed right, the origin is under its centre at the floor, and metres are metres', () => {
  for (const yaw of [0, 20, 90, 135, -60, 180]) {
    const pose = wallTag(yaw)
    const frame = ok(tagFrameTransform(fused(pose), { ...BASE }))
    assert.equal(frame.mount, 'wall')
    const R = matrixFromQuat(pose.rotation)
    const normal = { x: R[2]!, y: R[5]!, z: R[8]! }
    const right = { x: R[0]!, y: R[3]!, z: R[6]! }
    const m = frame.sessionToProject
    const at = (p: { x: number; y: number; z: number }) => transformPoint(m, p)
    const c = pose.position
    // The tag's centre is straight above the origin, as high above the floor as it is.
    assert.ok(dist(at(c), { x: 0, y: c.y - 0.1, z: 0 }) < 1e-9, `yaw ${yaw}: centre at ${JSON.stringify(at(c))}`)
    // One metre out from the wall along its outward normal is one metre along +Z.
    assert.ok(dist(at({ x: c.x + normal.x, y: c.y + normal.y, z: c.z + normal.z }), { x: 0, y: c.y - 0.1, z: 1 }) < 1e-9, `yaw ${yaw}: +Z`)
    // One metre to the tag's printed right is one metre along +X.
    assert.ok(dist(at({ x: c.x + right.x, y: c.y + right.y, z: c.z + right.z }), { x: 1, y: c.y - 0.1, z: 0 }) < 1e-9, `yaw ${yaw}: +X`)
    // Up is up: the vertical is untouched, and the floor is y = 0.
    assert.ok(dist(at({ x: c.x, y: 0.1, z: c.z }), { x: 0, y: 0, z: 0 }) < 1e-9)
    assert.ok(dist(at({ x: c.x, y: 1.1, z: c.z }), { x: 0, y: 1, z: 0 }) < 1e-9)
    assert.ok(near(frame.tagHeightM, c.y - 0.1))
    assert.deepEqual(frame.originSession, { x: c.x, y: 0.1, z: c.z })
    assert.ok(near(frame.headingYawDeg, ((yaw + 540) % 360) - 180) || near(Math.abs(frame.headingYawDeg), 180), `heading ${frame.headingYawDeg} for yaw ${yaw}`)
    assert.equal(frame.floorSource, 'datum')
    assert.deepEqual(frame.flags, [])
    assert.equal(frame.floorGapM, null)
  }
})

test('the matrix is a rotation about the vertical with a uniform scale, column-major, and agrees with the two-point frame', () => {
  const pose = wallTag(37, { x: -0.8, y: 1.2, z: -3.4 })
  const frame = ok(tagFrameTransform(fused(pose), { floorY: -0.05, mountHeightM: null, sessionUnitsPerMetre: 1 }))
  const m = frame.sessionToProject
  assert.equal(m.length, 16)
  // Layout: the bottom row of a column-major affine matrix is the last element of each column.
  assert.deepEqual([m[3], m[7], m[11], m[15]], [0, 0, 0, 1])
  // Rotation about Y only: the y column is (0, 1, 0) and the y row is (0, 1, 0).
  assert.deepEqual([m[4], m[5], m[6]], [0, 1, 0])
  assert.deepEqual([m[1], m[9]], [0, 0])
  // Orthonormal, determinant +1.
  const col = (i: number) => [m[i * 4]!, m[i * 4 + 1]!, m[i * 4 + 2]!]
  const dot = (a: number[], b: number[]) => a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!
  for (let i = 0; i < 3; i++) assert.ok(near(dot(col(i), col(i)), 1))
  assert.ok(near(dot(col(0), col(2)), 0))
  const det = m[0]! * (m[5]! * m[10]! - m[9]! * m[6]!) - m[4]! * (m[1]! * m[10]! - m[9]! * m[2]!) + m[8]! * (m[1]! * m[6]! - m[5]! * m[2]!)
  assert.ok(near(det, 1), `determinant ${det}`)
  // The same rotation, with the same sign, as the two-point frame whose heading marker lies along the tag's outward normal.
  const R = matrixFromQuat(pose.rotation)
  const landmark = { x: pose.position.x, y: -0.05, z: pose.position.z }
  const marker = { x: landmark.x + R[2]!, y: -0.05, z: landmark.z + R[8]! }
  const two = twoPointToProjectTransform(landmark, marker)
  for (let i = 0; i < 16; i++) assert.ok(near(m[i]!, two[i]!, 1e-9), `element ${i}: ${m[i]} against the two-point frame's ${two[i]}`)
  // A uniform scale of 1 / k inverts with the helper written for it, at any k.
  for (const k of [1, 1.7, 0.4]) {
    const f = ok(tagFrameTransform(fused(pose), { floorY: -0.05, mountHeightM: null, sessionUnitsPerMetre: k }))
    const inv = invertAffine(f.sessionToProject)
    assert.ok(inv, `k ${k} did not invert`)
    for (const p of [{ x: 0.4, y: 0.5, z: -1.2 }, { x: -3, y: 2, z: 0.1 }]) {
      const there = transformPoint(f.sessionToProject, p)
      assert.ok(dist(transformPoint(inv!, there), p) < 1e-9)
    }
    // Lengths are session units over k: a metre of session is 1 / k of a project metre.
    const a = transformPoint(f.sessionToProject, { x: 0, y: 0, z: 0 })
    const b = transformPoint(f.sessionToProject, { x: 1, y: 0, z: 0 })
    assert.ok(near(dist(a, b), 1 / k))
  }
})

test('a flat tag: +Z is the printed up axis, and it makes no difference whether it faces up or down', () => {
  for (const spin of [0, 30, 100, -75, 180]) {
    const pose = flatTag(spin, { x: 0.2, y: 0.74, z: -2 })
    const frame = ok(tagFrameTransform(fused(pose), { floorY: 0, mountHeightM: null, sessionUnitsPerMetre: 1 }))
    assert.equal(frame.mount, 'horizontal')
    const R = matrixFromQuat(pose.rotation)
    const up = { x: R[1]!, y: R[4]!, z: R[7]! }
    assert.ok(Math.abs(up.y) < 1e-9, 'the printed up axis of a flat tag is horizontal')
    const c = pose.position
    assert.ok(dist(transformPoint(frame.sessionToProject, { x: c.x + up.x, y: c.y, z: c.z + up.z }), { x: 0, y: 0.74, z: 1 }) < 1e-9, `spin ${spin}: +Z is up the page`)
    assert.ok(near(frame.tagHeightM, 0.74))
  }
  // The same tag on a ceiling, face down: a half turn about the printed up axis.
  const flat = flatTag(40, { x: 0, y: 2.4, z: -1 })
  const half = quatFromMatrix(mat3Mul(matrixFromQuat(flat.rotation), rotX(Math.PI)))
  const ceiling = ok(tagFrameTransform(fused({ position: flat.position, rotation: half }), { floorY: 0, mountHeightM: null, sessionUnitsPerMetre: 1 }))
  assert.equal(ceiling.mount, 'horizontal')
  assert.ok(dist(transformPoint(ceiling.sessionToProject, { x: 0, y: 2.4, z: -1 }), { x: 0, y: 2.4, z: 0 }) < 1e-9)
})

test('roll and pitch come from gravity: a wall tag leaning 15 degrees gives the same frame as one that is plumb, and the tag\'s own tilt does not tip it', () => {
  const plumb = wallTag(50)
  const leaning = { position: plumb.position, rotation: quatFromMatrix(mat3Mul(matrixFromQuat(plumb.rotation), rotX(15 * DEG))) }
  const a = ok(tagFrameTransform(fused(plumb), BASE))
  const b = ok(tagFrameTransform(fused(leaning), BASE))
  assert.ok(Math.abs(b.normalY) > 0.2 && Math.abs(b.normalY) < WALL_MAX_NORMAL_Y)
  // The up column of the matrix is exactly vertical in both; the heading differs only by the horizontal part of the leaning normal, which is the same direction.
  assert.deepEqual([b.sessionToProject[4], b.sessionToProject[5], b.sessionToProject[6]], [0, 1, 0])
  for (let i = 0; i < 16; i++) assert.ok(near(a.sessionToProject[i]!, b.sessionToProject[i]!, 1e-9), `element ${i}`)
  // A tag that rolls in its own plane (turned about its normal) is the same wall tag at another roll: the frame does not turn with it.
  const rolled = { position: plumb.position, rotation: quatFromMatrix(mat3Mul(matrixFromQuat(plumb.rotation), rotZ(25 * DEG))) }
  const c = ok(tagFrameTransform(fused(rolled), BASE))
  for (let i = 0; i < 16; i++) assert.ok(near(a.sessionToProject[i]!, c.sessionToProject[i]!, 1e-9), `element ${i} after a roll`)
})

test('tilted tags are refused with the measured normal, and a mount the sheet states that the normal contradicts is refused, not overruled', () => {
  // A wall tag tipped back by 18 to 64 degrees has a normal 0.31 to 0.90 up: neither a wall nor flat. At 66 degrees (0.913) it is a flat tag.
  for (const tiltDeg of [18, 30, 45, 60, 64]) {
    const pose = { position: { x: 0, y: 1.3, z: -2 }, rotation: quatFromMatrix(mat3Mul(matrixFromQuat(wallTag(10).rotation), rotX(tiltDeg * DEG))) }
    const r = refused(tagFrameTransform(fused(pose), BASE))
    assert.equal(r.reason, 'tilted', `${tiltDeg} degrees`)
    assert.ok(r.normalY !== null && Math.abs(Math.abs(r.normalY) - Math.sin(tiltDeg * DEG)) < 1e-9)
  }
  const nearlyFlat = { position: { x: 0, y: 1.3, z: -2 }, rotation: quatFromMatrix(mat3Mul(matrixFromQuat(wallTag(10).rotation), rotX(66 * DEG))) }
  assert.equal(ok(tagFrameTransform(fused(nearlyFlat), BASE)).mount, 'horizontal')
  const wall = wallTag(10)
  assert.equal(refused(tagFrameTransform(fused(wall), { ...BASE, mount: 'horizontal' })).reason, 'mount-mismatch')
  assert.equal(ok(tagFrameTransform(fused(wall), { ...BASE, mount: 'wall' })).mount, 'wall')
  const flat = flatTag(10)
  assert.equal(refused(tagFrameTransform(fused(flat), { ...BASE, mount: 'wall', floorY: 0 })).reason, 'mount-mismatch')
  assert.equal(ok(tagFrameTransform(fused(flat), { ...BASE, mount: 'horizontal', floorY: 0 })).mount, 'horizontal')
})

test('the floor: a fitted floor when there is one, the sheet\'s mount height (flagged) when there is not, both compared, and neither refused', () => {
  const pose = wallTag(30, { x: 0, y: 1.5, z: -2 })
  // The mount height alone: the floor is the tag's height less it, flagged.
  const fromHeight = ok(tagFrameTransform(fused(pose), { floorY: null, mountHeightM: 1.2, sessionUnitsPerMetre: 1 }))
  assert.equal(fromHeight.floorSource, 'mount-height')
  assert.ok(near(fromHeight.floorY, 0.3))
  assert.deepEqual(fromHeight.flags, ['floor-from-mount-height'])
  assert.ok(near(fromHeight.tagHeightM, 1.2))
  assert.equal(fromHeight.floorGapM, null)
  // In a session whose unit is 2 per metre the mount height is converted to session units.
  const units = ok(tagFrameTransform(fused({ position: { x: 0, y: 3, z: -4 }, rotation: pose.rotation }), { floorY: null, mountHeightM: 1.2, sessionUnitsPerMetre: 2 }))
  assert.ok(near(units.floorY, 3 - 2.4))
  assert.ok(near(units.tagHeightM, 1.2))
  // Both, agreeing: the fitted floor is used, with the gap reported and no flag.
  const agree = ok(tagFrameTransform(fused(pose), { floorY: 0.32, mountHeightM: 1.2, sessionUnitsPerMetre: 1 }))
  assert.equal(agree.floorSource, 'datum')
  assert.ok(near(agree.floorGapM!, 0.02))
  assert.deepEqual(agree.flags, [])
  // Both, disagreeing by more than the limit: the fitted floor still wins, and the frame says they disagree. At the limit exactly it does not.
  const apart = ok(tagFrameTransform(fused(pose), { floorY: 0.3 + FLOOR_MOUNT_DISAGREE_M + 0.001, mountHeightM: 1.2, sessionUnitsPerMetre: 1 }))
  assert.equal(apart.floorSource, 'datum')
  assert.deepEqual(apart.flags, ['floor-disagrees-with-mount-height'])
  assert.ok(near(apart.floorGapM!, FLOOR_MOUNT_DISAGREE_M + 0.001))
  assert.deepEqual(ok(tagFrameTransform(fused(pose), { floorY: 0.3 - FLOOR_MOUNT_DISAGREE_M + 1e-9, mountHeightM: 1.2, sessionUnitsPerMetre: 1 })).flags, [])
  // Both, in a session whose unit is 1.7 per metre (8th Wall's responsive scale is not metres): the sheet's height is a length in metres and is converted to session units
  // before it is compared, and the gap comes back in metres. Two centimetres apart agree; sixteen are over the 15 and are said to disagree.
  const k = 1.7
  const tagK = fused({ position: { x: 0, y: 1.5 * k, z: -2 * k }, rotation: pose.rotation })
  const agreeK = ok(tagFrameTransform(tagK, { floorY: 0.32 * k, mountHeightM: 1.2, sessionUnitsPerMetre: k }))
  assert.equal(agreeK.floorSource, 'datum')
  assert.ok(near(agreeK.floorGapM!, 0.02, 1e-9), `${agreeK.floorGapM}`)
  assert.deepEqual(agreeK.flags, [])
  assert.ok(near(agreeK.tagHeightM, 1.18, 1e-9), 'the tag is 1.18 m above the fitted floor, in metres')
  const apartK = ok(tagFrameTransform(tagK, { floorY: 0.46 * k, mountHeightM: 1.2, sessionUnitsPerMetre: k }))
  assert.deepEqual(apartK.flags, ['floor-disagrees-with-mount-height'])
  assert.ok(near(apartK.floorGapM!, 0.16, 1e-9), `${apartK.floorGapM}`)
  // The same at the other side of 1: a session whose unit is 0.4 m.
  const small = 0.4
  const tagS = fused({ position: { x: 0, y: 1.5 * small, z: -2 * small }, rotation: pose.rotation })
  assert.ok(near(ok(tagFrameTransform(tagS, { floorY: 0.32 * small, mountHeightM: 1.2, sessionUnitsPerMetre: small })).floorGapM!, 0.02, 1e-9))
  // Neither: nothing says where y = 0 is.
  assert.equal(refused(tagFrameTransform(fused(pose), { floorY: null, mountHeightM: null, sessionUnitsPerMetre: 1 })).reason, 'no-floor')
})

test('numbers that cannot make a frame are refused: no pose, a scale that is not a positive number, heights that are not heights, a tag below the floor or far above it', () => {
  const pose = wallTag(0, { x: 0, y: 1.4, z: -2 })
  assert.equal(refused(tagFrameTransform(fused(null), BASE)).reason, 'not-fused')
  assert.equal(refused(tagFrameTransform({ status: 'rejected', pose }, BASE)).reason, 'not-fused', 'a rejected fusion is not a pose, whatever it carries')
  assert.equal(refused(tagFrameTransform(fused({ position: { x: NaN, y: 1, z: 1 }, rotation: pose.rotation }), BASE)).reason, 'not-fused')
  for (const k of [0, -1, NaN, Infinity]) assert.equal(refused(tagFrameTransform(fused(pose), { ...BASE, sessionUnitsPerMetre: k })).reason, 'bad-scale', `k ${k}`)
  for (const h of [-0.01, NaN, TAG_HEIGHT_MAX_M + 0.01]) assert.equal(refused(tagFrameTransform(fused(pose), { floorY: null, mountHeightM: h, sessionUnitsPerMetre: 1 })).reason, 'bad-height', `mount height ${h}`)
  assert.equal(refused(tagFrameTransform(fused(pose), { ...BASE, floorY: NaN })).reason, 'bad-height')
  // The floor above the tag's centre by more than the limit, and far below it.
  assert.equal(refused(tagFrameTransform(fused(pose), { ...BASE, floorY: 1.4 - TAG_HEIGHT_MIN_M + 0.01 })).reason, 'bad-height')
  assert.equal(ok(tagFrameTransform(fused(pose), { ...BASE, floorY: 1.4 - TAG_HEIGHT_MIN_M - 0.01 })).status, 'ok')
  assert.equal(refused(tagFrameTransform(fused(pose), { ...BASE, floorY: 1.4 - TAG_HEIGHT_MAX_M - 0.01 })).reason, 'bad-height')
  // A tag on the floor reads a little below it (a fitted floor is a few centimetres out): allowed.
  assert.equal(ok(tagFrameTransform(fused(flatTag(0, { x: 0, y: -0.03, z: -1 })), { floorY: 0, mountHeightM: null, sessionUnitsPerMetre: 1 })).status, 'ok')
})

test('the property a marker is for: two sessions that put their own origins and headings anywhere agree where a physical point is in the frame the tag defines', () => {
  // A room, in "world" coordinates: a tag on a wall, and a few physical points (a doorway, a chair, the far corner), 5 m from the tag.
  const tagWorld = wallTag(0, { x: 4, y: 1.3, z: 2 })
  const points = [{ x: 4.6, y: 0, z: 6.9 }, { x: 1.2, y: 0.5, z: 5.5 }, { x: 8.1, y: 1.1, z: 3.3 }]
  const rand = mulberry32(7)
  const projected: Array<Array<{ x: number; y: number; z: number }>> = []
  for (let session = 0; session < 6; session++) {
    // This session's frame: the world turned about the vertical by an arbitrary angle and moved, with its y axis along gravity, and its units
    // scaled by an arbitrary k (the runtime's unit).
    const yaw = rand() * 2 * Math.PI
    const k = 0.6 + rand() * 1.6
    const shift = { x: (rand() - 0.5) * 8, y: (rand() - 0.5) * 0.4, z: (rand() - 0.5) * 8 }
    const toSession = (p: { x: number; y: number; z: number }) => {
      const c = Math.cos(yaw)
      const s = Math.sin(yaw)
      return { x: (c * p.x + s * p.z) * k + shift.x, y: p.y * k + shift.y, z: (-s * p.x + c * p.z) * k + shift.z }
    }
    // The tag, as this session would measure it: its pose, in this session's frame and units.
    const R = mat3Mul(rotY(yaw), matrixFromQuat(tagWorld.rotation))
    const measured: Pose = { position: toSession(tagWorld.position), rotation: quatFromMatrix(R.map((v) => v)) }
    // Its rotation in the session is the world rotation turned by the session's yaw; sign convention checked by the property itself below.
    const frame = ok(tagFrameTransform(fused(measured), { floorY: shift.y, mountHeightM: null, sessionUnitsPerMetre: k }))
    projected.push(points.map((p) => transformPoint(frame.sessionToProject, toSession(p))))
  }
  for (let i = 1; i < projected.length; i++) {
    for (let p = 0; p < points.length; p++) assert.ok(dist(projected[i]![p]!, projected[0]![p]!) < 1e-9, `session ${i}, point ${p}: ${JSON.stringify(projected[i]![p])} against ${JSON.stringify(projected[0]![p])}`)
  }
  // And those coordinates are the room's, in metres, from the tag: the point 4.9 m from the wall along its normal is 4.9 m along +Z.
  assert.ok(Math.abs(projected[0]![0]!.z - 4.9) < 1e-9, `${projected[0]![0]!.z}`)
})
