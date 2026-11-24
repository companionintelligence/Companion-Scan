/**
 * The heading spread of `fuseTagObservations` and the mount helpers it shares with the frame builder (`tag-mount.ts`), the reprojection error the
 * fusion reports, and the fusion at a session scale that is not the metre.
 *
 * R1's spread gate is on the HEADING: the one rotation a tag fixes for the Place frame, because roll and pitch come from gravity. What the first build gated was
 * the whole orientation, tilt as well, which a few pixels of corner noise scatters about twice as much (and for a flat tag, about five times), so a read
 * whose heading was good to a fraction of a degree was refused for a tilt the frame never uses. The heading spread here is checked against a scatter the
 * test builds itself: a tag turned about the vertical by known amounts from frame to frame, with exact corners, so the number has one right answer.
 *
 * The scale tests state one property: the same scene drawn in a session counting 1.7 units to the metre is the same scene. Every length the fusion reports in
 * metres comes out the same, and every decision it makes (which solution a frame keeps, which frames are outliers, whether the mirror still stands) is
 * the same, because each is made on a distance, and a distance made in the wrong unit would change one of them.
 *
 * Run: node --experimental-strip-types --no-warnings --test tests/unit/node/fiducial_pose_heading.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { axisBearingDeg, classifyMount, HORIZONTAL_MIN_NORMAL_Y, tagHeadingAxis, WALL_MAX_NORMAL_Y, wrapDeg } from '../../../src/ar/fiducial/tag-mount.ts'
import * as frameModule from '../../../src/ar/fiducial/tag-frame.ts'
import { tagFrameTransform } from '../../../src/ar/fiducial/tag-frame.ts'
import {
  MAX_ASPECT_MISMATCH,
  fuseTagObservations,
  intrinsicsProblem,
  poseToSession,
  quatToMatrix,
  rotationAngleBetweenDeg,
  solveTagPose,
} from '../../../src/ar/fiducial/tag-pose.ts'
import type { CameraIntrinsics, Quad, TagObservation } from '../../../src/ar/fiducial/types.ts'
import { INTRINSICS_640, mat3Mul, matrixFromQuat, projectSessionTag, quatFromMatrix, rotY, type SessionPoseLike } from '../../support/fiducial-render.ts'
import { fixedTag, flatTag, walk, type WalkOptions } from '../../support/fiducial-scene.ts'

const K = INTRINSICS_640
const SIZE_M = 0.2
const FIT = { refined: true, edgeRmsPx: 0.1, edgeInlierFraction: 1 }

/** The gates a session passes, opened wide where a test is about something else. */
const OPEN = { tagSizeM: SIZE_M, minSidePx: 0, minFrames: 12, maxPoseSpreadM: 10, maxRotationSpreadDeg: 90, maxRangeM: 10, maxViewAngleDeg: 80, maxReprojectionRmsPx: 5 }

const median = (v: number[]): number => {
  const a = [...v].sort((x, y) => x - y)
  const n = a.length
  return n % 2 ? a[(n - 1) / 2]! : 0.5 * (a[n / 2 - 1]! + a[n / 2]!)
}

/** `tag` turned `deg` about the session's vertical axis (a heading change and nothing else). */
function turnedAboutVertical(tag: SessionPoseLike, deg: number): SessionPoseLike {
  return { position: tag.position, rotation: quatFromMatrix(mat3Mul(rotY((deg * Math.PI) / 180), matrixFromQuat(tag.rotation))) }
}

/** Exact corners of a tag whose heading is `base + offsets[i]` in frame i, from the cameras of a walk round it. */
function headingScatter(tag: SessionPoseLike, camera: Omit<WalkOptions, 'frames' | 'tag'>, offsetsDeg: readonly number[]): TagObservation[] {
  const w = walk({ ...camera, tag, frames: offsetsDeg.length, cornerNoise: 0 })
  return w.cameras.map((cam, i) => ({
    corners: projectSessionTag(turnedAboutVertical(tag, offsetsDeg[i]!), cam, K, SIZE_M) as unknown as Quad,
    intrinsics: K,
    cameraPose: cam,
    timestampMs: i * 125,
    cornerFit: FIT,
  }))
}

// ===============================================================================================
// The mount helpers
// ===============================================================================================

test('the mount limits, the classifier and the heading axis live in one place, which the frame builder re-exports', () => {
  assert.equal(frameModule.WALL_MAX_NORMAL_Y, WALL_MAX_NORMAL_Y)
  assert.equal(frameModule.HORIZONTAL_MIN_NORMAL_Y, HORIZONTAL_MIN_NORMAL_Y)
  assert.equal(frameModule.classifyMount, classifyMount)
  assert.equal(WALL_MAX_NORMAL_Y, 0.3)
  assert.equal(HORIZONTAL_MIN_NORMAL_Y, 0.9)
})

test('the heading axis is the wall tag\'s normal and the flat tag\'s printed up, its bearing is atan2(x, z), and differences wrap into (-180, 180]', () => {
  // The identity rotation: the tag's x, y, z are the session's, so its normal is +z and its up is +y.
  const identity = [1, 0, 0, 0, 1, 0, 0, 0, 1]
  assert.deepEqual(tagHeadingAxis(identity, 'wall'), [0, 0, 1])
  assert.deepEqual(tagHeadingAxis(identity, 'horizontal'), [0, 1, 0])
  // A tag whose columns are all different: the axis is the column, not the row.
  const m = [1, 2, 3, 4, 5, 6, 7, 8, 9]
  assert.deepEqual(tagHeadingAxis(m, 'wall'), [3, 6, 9])
  assert.deepEqual(tagHeadingAxis(m, 'horizontal'), [2, 5, 8])
  assert.equal(axisBearingDeg([0, 0, 1]), 0)
  assert.equal(axisBearingDeg([1, 0, 0]), 90)
  assert.equal(axisBearingDeg([-1, 0, 0]), -90)
  assert.equal(Math.abs(axisBearingDeg([0, 0, -1])), 180)
  assert.ok(Math.abs(axisBearingDeg([1, 5, 1]) - 45) < 1e-12, 'the vertical part does not enter')
  for (const [input, want] of [[0, 0], [180, 180], [-180, 180], [190, -170], [-190, 170], [359.5, -0.5], [-359.5, 0.5], [540, 180], [-540, 180], [360, 0], [1e-9, 1e-9]] as const) {
    assert.ok(Math.abs(wrapDeg(input) - want) < 1e-9, `${input} wraps to ${wrapDeg(input)}, not ${want}`)
  }
})

// ===============================================================================================
// The heading spread
// ===============================================================================================

test('the heading spread of a wall tag and of a flat tag is 1.4826 times the median absolute deviation of their headings: a tag turned 0.5 degrees either way is 0.741 degrees', () => {
  const alternate = Array.from({ length: 16 }, (_, i) => (i % 2 ? 0.5 : -0.5))
  const cases: Array<[string, SessionPoseLike, Omit<WalkOptions, 'frames' | 'tag'>]> = [
    ['wall', fixedTag(20, 0), { range: 2, arcDeg: 30, centreDeg: 35 }],
    ['flat', flatTag(30), { range: 1.5, arcDeg: 30, heightM: 0.9 }],
  ]
  for (const [name, tag, camera] of cases) {
    const f = fuseTagObservations(headingScatter(tag, camera, alternate), OPEN)
    assert.equal(f.status, 'ok', `${name}: ${f.reason}`)
    assert.equal(f.nFrames, 16)
    // One dimension: sigma = 1.4826 x MAD. (Not the 1.126 that a distance in three dimensions has: that would say 0.563.)
    assert.ok(Math.abs(f.headingSpreadDeg - 0.5 * 1.4826) < 2e-3, `${name}: heading spread ${f.headingSpreadDeg}`)
    // The whole orientation moved by the same half degree each frame, in three dimensions: 1.126 x 0.5.
    assert.ok(Math.abs(f.rotationSpreadDeg - 0.5 * 1.1260) < 2e-3, `${name}: rotation spread ${f.rotationSpreadDeg}`)
  }
})

test('the heading is the scatter of the angle about the vertical only: a tag that scatters in its tilt and not in its heading has no heading spread', () => {
  // A wall tag tipped back and forth by 2 degrees about its own horizontal axis: its normal nods up and down, and its bearing stays where it is.
  const tag = fixedTag(20, 0)
  const w = walk({ range: 2, tag, frames: 16, arcDeg: 30, centreDeg: 35, cornerNoise: 0 })
  const nodded = w.cameras.map((cam, i): TagObservation => {
    const tipped = { position: tag.position, rotation: quatFromMatrix(mat3Mul(matrixFromQuat(tag.rotation), [1, 0, 0, 0, Math.cos(((i % 2 ? 2 : -2) * Math.PI) / 180), -Math.sin(((i % 2 ? 2 : -2) * Math.PI) / 180), 0, Math.sin(((i % 2 ? 2 : -2) * Math.PI) / 180), Math.cos(((i % 2 ? 2 : -2) * Math.PI) / 180)])) }
    return { corners: projectSessionTag(tipped, cam, K, SIZE_M) as unknown as Quad, intrinsics: K, cameraPose: cam, timestampMs: i * 125, cornerFit: FIT }
  })
  const f = fuseTagObservations(nodded, OPEN)
  assert.equal(f.status, 'ok', f.reason ?? '')
  assert.ok(f.rotationSpreadDeg > 1.5, `the whole orientation scatters ${f.rotationSpreadDeg} degrees`)
  assert.ok(f.headingSpreadDeg < 0.2 * f.rotationSpreadDeg, `the heading scatters ${f.headingSpreadDeg} degrees of it`)
})

test('the heading is taken round the branch cut: a tag facing -z with headings of 179.5 and -179.5 degrees scatters by half a degree, not by 359', () => {
  const alternate = Array.from({ length: 16 }, (_, i) => (i % 2 ? 0.5 : -0.5))
  const tag = fixedTag(180, 0)
  assert.ok(Math.abs(axisBearingDeg(tagHeadingAxis(matrixFromQuat(tag.rotation), 'wall'))) > 179.9)
  const f = fuseTagObservations(headingScatter(tag, { range: 2, arcDeg: 30, centreDeg: 215 }, alternate), OPEN)
  assert.equal(f.status, 'ok', f.reason ?? '')
  assert.ok(Math.abs(f.headingSpreadDeg - 0.5 * 1.4826) < 2e-3, `${f.headingSpreadDeg}`)
})

test('the heading gate is the caller\'s: off by default, and over it the fusion is refused as a spread; a flat tag is judged on its own axis', () => {
  const alternate = Array.from({ length: 16 }, (_, i) => (i % 2 ? 0.8 : -0.8))
  for (const [tag, camera] of [
    [fixedTag(20, 0), { range: 2, arcDeg: 30, centreDeg: 35 }],
    [flatTag(30), { range: 1.5, arcDeg: 30, heightM: 0.9 }],
  ] as const) {
    const obs = headingScatter(tag, camera, alternate)
    const open = fuseTagObservations(obs, OPEN)
    assert.equal(open.status, 'ok', 'no heading gate unless asked for')
    assert.ok(open.headingSpreadDeg > 1.1 && open.headingSpreadDeg < 1.25, `${open.headingSpreadDeg}`)
    const gated = fuseTagObservations(obs, { ...OPEN, maxHeadingSpreadDeg: 1 })
    assert.equal(gated.status, 'rejected')
    assert.equal(gated.reason, 'spread')
    assert.ok(gated.pose, 'a rejected result still carries the numbers')
    assert.equal(fuseTagObservations(obs, { ...OPEN, maxHeadingSpreadDeg: open.headingSpreadDeg }).status, 'ok', 'at the limit it passes')
    assert.equal(fuseTagObservations(obs, { ...OPEN, maxHeadingSpreadDeg: open.headingSpreadDeg - 1e-6 }).reason, 'spread')
    // The whole-orientation gate is its own: a loose heading gate does not stand in for a tight one.
    assert.equal(fuseTagObservations(obs, { ...OPEN, maxHeadingSpreadDeg: 10, maxRotationSpreadDeg: 0.5 }).reason, 'spread')
  }
})

test('a tag between the wall and the horizontal limits has no heading, and a heading gate cannot refuse it before the frame builder says it is tilted', () => {
  const tilted = fixedTag(20, 60)
  const obs = headingScatter(tilted, { range: 2, arcDeg: 30, centreDeg: 35 }, Array.from({ length: 16 }, (_, i) => (i % 2 ? 0.8 : -0.8)))
  const f = fuseTagObservations(obs, { ...OPEN, maxHeadingSpreadDeg: 0.1 })
  assert.equal(f.status, 'ok', f.reason ?? '')
  assert.ok(Number.isNaN(f.headingSpreadDeg))
  const frame = tagFrameTransform(f, { floorY: 0, mountHeightM: null, sessionUnitsPerMetre: 1 })
  assert.deepEqual([frame.status, (frame as { reason: string }).reason], ['refused', 'tilted'])
  // A rejected fusion with no frame has none either.
  assert.ok(Number.isNaN(fuseTagObservations([], OPEN).headingSpreadDeg))
})

// ===============================================================================================
// The reprojection error is the error of the solutions the fusion used
// ===============================================================================================

test('the reprojection error the fusion reports is the median over the solutions it kept, not over the best ones: a frame the consensus gave its alternate reports the alternate\'s', () => {
  // A wall tag seen 10 degrees off straight on, 0.5 px of corner noise: in some frames the better fit is the mirror solution, and the frames' agreement chooses the other.
  let checked = 0
  for (const seed of [2, 5, 12]) {
    const w = walk({ tag: fixedTag(0, 0), range: 2, frames: 16, arcDeg: 10, centreDeg: 10, cornerNoise: 0.5, seed, dtMs: 125 })
    const obs = w.observations.map((o) => ({ ...o, cornerFit: FIT }))
    const f = fuseTagObservations(obs, OPEN)
    assert.ok(f.pose && f.nFrames === 16, `seed ${seed}`)
    const fused = quatToMatrix(f.pose.rotation)
    const best: number[] = []
    const kept: number[] = []
    for (const o of obs) {
      const s = solveTagPose(o.corners, o.intrinsics, SIZE_M)!
      best.push(s.best.reprojectionRmsPx)
      // The solution a frame kept is the one whose session pose is nearer the fused pose.
      const near = [s.best, ...(s.alternate ? [s.alternate] : [])].map((c) => {
        const p = poseToSession(c, o.cameraPose)
        const d = Math.hypot(p.position.x - f.pose!.position.x, p.position.y - f.pose!.position.y, p.position.z - f.pose!.position.z) + SIZE_M * ((rotationAngleBetweenDeg(quatToMatrix(p.rotation), fused) * Math.PI) / 180)
        return { d, rms: c.reprojectionRmsPx }
      })
      kept.push(near.sort((a, b) => a.d - b.d)[0]!.rms)
    }
    assert.ok(Math.abs(median(kept) / median(best) - 1) > 0.05, `seed ${seed}: the scene has to be one where the two medians differ (${median(kept)} and ${median(best)})`)
    assert.ok(Math.abs(f.reprojectionRmsPx - median(kept)) < 1e-6, `seed ${seed}: reported ${f.reprojectionRmsPx}, solutions kept ${median(kept)}, best ones ${median(best)}`)
    checked++
  }
  assert.equal(checked, 3)
})

// ===============================================================================================
// A session whose unit is not the metre
// ===============================================================================================

/** The same scene at two session scales: everything in session units is `k` times larger, and the corners drawn are the same pixels. */
function atScale(k: number, over: Parameters<typeof walk>[0]): TagObservation[] {
  const base = over.tag ?? fixedTag(20, 0)
  const tag = { position: { x: base.position.x * k, y: base.position.y * k, z: base.position.z * k }, rotation: base.rotation }
  return walk({ ...over, tag, scale: k }).observations.map((o) => ({ ...o, cornerFit: FIT }))
}

test('the fusion is the same scene at any session scale: every length it reports in metres, and every decision it makes, is the same at 1.7 units to the metre as at 1', () => {
  const scenes: Array<[string, Parameters<typeof walk>[0]]> = [
    ['a wall tag seen from the side', { range: 2, frames: 20, arcDeg: 30, centreDeg: 35, cornerNoise: 0.3, seed: 5, tag: fixedTag(0, 0) }],
    ['a nearly face-on tag, where the mirror solutions compete', { range: 2, frames: 16, arcDeg: 10, centreDeg: 10, cornerNoise: 0.5, seed: 12, tag: fixedTag(0, 0) }],
    ['a nearly face-on tag, another draw', { range: 2, frames: 16, arcDeg: 10, centreDeg: 10, cornerNoise: 0.5, seed: 2, tag: fixedTag(0, 0) }],
    ['a flat tag', { range: 1.5, frames: 16, arcDeg: 30, heightM: 0.9, cornerNoise: 0.4, seed: 7, tag: flatTag(30) }],
  ]
  for (const [name, scene] of scenes) {
    const one = fuseTagObservations(atScale(1, scene), { ...OPEN, maxNormalDeviationDeg: 8 })
    for (const k of [1.7, 0.4]) {
      const scaled = fuseTagObservations(atScale(k, scene), { ...OPEN, sessionUnitsPerMetre: k, maxNormalDeviationDeg: 8 })
      assert.equal(scaled.status, one.status, `${name} at ${k}`)
      assert.equal(scaled.nFrames, one.nFrames, `${name} at ${k}: the frames kept (the outlier cut is made in metres)`)
      assert.equal(scaled.ambiguous, one.ambiguous, `${name} at ${k}: whether the mirror still stands (a spread compared in metres)`)
      for (const field of ['poseSpreadM', 'rotationSpreadDeg', 'headingSpreadDeg', 'reprojectionRmsPx', 'rangeM'] as const) {
        assert.ok(Math.abs(scaled[field] / one[field] - 1) < 1e-6, `${name} at ${k}: ${field} ${scaled[field]} against ${one[field]}`)
      }
      // The pose is the same place, counted in the session's units.
      const p = one.pose!.position
      const q = scaled.pose!.position
      assert.ok(Math.hypot(q.x - p.x * k, q.y - p.y * k, q.z - p.z * k) < 1e-6 * k, `${name} at ${k}: the position`)
      assert.ok(rotationAngleBetweenDeg(quatToMatrix(scaled.pose!.rotation), quatToMatrix(one.pose!.rotation)) < 1e-3, `${name} at ${k}: the orientation`)
    }
  }
})

test('a frame far from the others is an outlier whatever the session counts in: the cut is a distance, in session units, and the floor under it is a centimetre of metres', () => {
  // Frames whose tilt is wrong by 25 degrees move the tag's corners by a few centimetres (about a quarter of its width) and not its centre: the corner-distance outlier test is what catches
  // them, and it measures in units of the tag's size, so it has to measure in the session's.
  const base = walk({ tag: fixedTag(0, 0), range: 2, frames: 20, arcDeg: 30, centreDeg: 35, cornerNoise: 0.1, seed: 9 })
  const turned = { position: base.tag.position, rotation: quatFromMatrix(mat3Mul(matrixFromQuat(base.tag.rotation), rotY((25 * Math.PI) / 180))) }
  const make = (k: number): TagObservation[] => {
    const w = walk({ tag: { position: { x: base.tag.position.x * k, y: base.tag.position.y * k, z: base.tag.position.z * k }, rotation: base.tag.rotation }, range: 2, frames: 20, arcDeg: 30, centreDeg: 35, cornerNoise: 0.1, seed: 9, scale: k })
    return w.observations.map((o, i) => {
      if (i % 5 !== 2) return { ...o, cornerFit: FIT }
      const t = { position: { x: turned.position.x * k, y: turned.position.y * k, z: turned.position.z * k }, rotation: turned.rotation }
      return { ...o, corners: projectSessionTag(t, w.cameras[i]!, K, SIZE_M * k) as unknown as Quad, cornerFit: FIT }
    })
  }
  const kept = (k: number): number => fuseTagObservations(make(k), { ...OPEN, sessionUnitsPerMetre: k }).nFrames
  const atOne = kept(1)
  for (const k of [1.7, 0.4]) assert.equal(kept(k), atOne, `${k} units to the metre keeps ${kept(k)} frames, 1 keeps ${atOne}`)
  assert.ok(atOne < 20, `the scene has outliers for the cut to find (${atOne} of 20 kept)`)
})

test('the floor under the outlier cut is a centimetre of metres whatever the session counts in: a frame 8 mm from the others is kept at 1 and at 1.7 units to the metre, and one 15 mm away is dropped at both', () => {
  // Every frame exact but one, which has the tag moved by a known number of metres: the others agree to rounding, so the cut is the floor and nothing else.
  const base = fixedTag(20, 0)
  const make = (k: number, movedM: number): TagObservation[] => {
    const tag = { position: { x: base.position.x * k, y: base.position.y * k, z: base.position.z * k }, rotation: base.rotation }
    const w = walk({ tag, range: 2, frames: 16, arcDeg: 30, centreDeg: 35, cornerNoise: 0, seed: 1, dtMs: 125, scale: k })
    return w.observations.map((o, i) => {
      if (i !== 5) return { ...o, cornerFit: FIT }
      const moved = { position: { x: tag.position.x + movedM * k, y: tag.position.y, z: tag.position.z }, rotation: tag.rotation }
      return { ...o, corners: projectSessionTag(moved, w.cameras[i]!, K, SIZE_M * k) as unknown as Quad, cornerFit: FIT }
    })
  }
  for (const k of [1, 1.7]) {
    const kept = (movedM: number): number => fuseTagObservations(make(k, movedM), { ...OPEN, sessionUnitsPerMetre: k }).nFrames
    assert.equal(kept(0), 16, `k ${k}`)
    assert.equal(kept(0.008), 16, `k ${k}: 8 mm is inside the centimetre`)
    assert.equal(kept(0.015), 15, `k ${k}: 15 mm is outside it`)
  }
})

// ===============================================================================================
// The aspect check
// ===============================================================================================

test('the aspect check names a projection and a pixel array that disagree about the frame, at 2 %: 1.5 % is a camera, 2.5 % and 10 % are not', () => {
  assert.equal(MAX_ASPECT_MISMATCH, 0.02)
  const at = (ratio: number): CameraIntrinsics => ({ fx: 500 * ratio, fy: 500, cx: 320, cy: 240, width: 640, height: 480 })
  assert.equal(intrinsicsProblem(at(1)), null)
  assert.equal(intrinsicsProblem(at(1.015)), null, '1.5 % apart is a camera')
  assert.equal(intrinsicsProblem(at(0.985)), null)
  assert.equal(intrinsicsProblem(at(1.0199)), null, 'just inside')
  assert.equal(intrinsicsProblem(at(1.0201)), 'aspect-mismatch', 'just outside')
  assert.equal(intrinsicsProblem(at(1.025)), 'aspect-mismatch')
  assert.equal(intrinsicsProblem(at(0.975)), 'aspect-mismatch')
  assert.equal(intrinsicsProblem(at(1.1)), 'aspect-mismatch')
  assert.equal(intrinsicsProblem(at(1 / 1.1)), 'aspect-mismatch')
})
