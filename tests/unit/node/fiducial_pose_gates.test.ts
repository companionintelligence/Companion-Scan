/**
 * The per-frame size gate and the normal-deviation gate of `fuseTagObservations` (WP-14a amendment), the reprojection helpers that
 * went in with them, and the same gates in `estimateSessionScale`.
 *
 * The size gate is in pixels (`POSE_GRADE_MIN_SIDE_PX`, 40): a range gate in the unit the pose error is in. The boundary is tested
 * at, just under and just over it with quads scaled to an exact mean side, so a gate written with the wrong comparison fails.
 *
 * Run: node --experimental-strip-types --no-warnings --test tests/unit/node/fiducial_pose_gates.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  POSE_GRADE_MIN_SIDE_PX,
  cornerRmsPx,
  estimateSessionScale,
  fuseTagObservations,
  meanSidePx,
  poseToSession,
  projectTagCorners,
  rotationAngleBetweenDeg,
  reprojectSessionTag,
  sessionPoseToCamera,
  solveTagPose,
} from '../../../src/ar/fiducial/tag-pose.ts'
import type { Quad, TagObservation } from '../../../src/ar/fiducial/types.ts'
import { INTRINSICS_1280, INTRINSICS_640, lookAtPose, matrixFromQuat, mat3Mul, projectSessionTag, quatFromMatrix, rotY, tagPose } from '../../support/fiducial-render.ts'
import { fixedTag, gaussian, walk } from '../../support/fiducial-scene.ts'
import { mulberry32 } from '../../../src/shared/test-homes.ts'

const K = INTRINSICS_640
const SIZE_M = 0.2

/** The quad scaled about its centroid until its mean side is `side` pixels. */
function scaledToSide(corners: Quad, side: number): Quad {
  const f = side / meanSidePx(corners)
  const cx = corners.reduce((s, c) => s + c.x, 0) / 4
  const cy = corners.reduce((s, c) => s + c.y, 0) / 4
  return corners.map((c) => ({ x: cx + (c.x - cx) * f, y: cy + (c.y - cy) * f })) as unknown as Quad
}

function atSide(side: number, n: number, seed: number): TagObservation[] {
  return walk({ range: 2, frames: n, arcDeg: 40, cornerNoise: 0.03, seed }).observations.map((o) => ({ ...o, corners: scaledToSide(o.corners, side) }))
}

test('the pose-grade size is 40 pixels, and meanSidePx is the mean of the four sides', () => {
  assert.equal(POSE_GRADE_MIN_SIDE_PX, 40)
  const q: Quad = [{ x: 0, y: 0 }, { x: 30, y: 0 }, { x: 30, y: 50 }, { x: 0, y: 50 }]
  assert.equal(meanSidePx(q), 40)
  const slanted = projectTagCorners(tagPose({ x: 0, y: 0, z: 2 }, 0, 40, 0), K, SIZE_M) as unknown as Quad
  const sides = [0, 1, 2, 3].map((i) => Math.hypot(slanted[(i + 1) % 4]!.x - slanted[i]!.x, slanted[(i + 1) % 4]!.y - slanted[i]!.y))
  assert.ok(Math.abs(meanSidePx(slanted) - sides.reduce((a, b) => a + b, 0) / 4) < 1e-12)
})

test('a frame is used at exactly 40 px and over, dropped under it, and the gate names itself when every frame is under', () => {
  // One frame at a time, so the size is the only thing that differs between the cases (scaling a whole walk to one size would
  // make the frames disagree about where the tag is, and the consensus would drop them for that).
  const base = walk({ range: 2, frames: 6, arcDeg: 40, cornerNoise: 0.03, seed: 1 }).observations[3]!
  const one = (side: number, options: object = {}) => fuseTagObservations([{ ...base, corners: scaledToSide(base.corners, side) }], { tagSizeM: SIZE_M, minFrames: 1, maxPoseSpreadM: 1, maxRotationSpreadDeg: 90, ...options })
  assert.equal(one(40).dropped.tooSmall, 0, 'a frame of exactly 40 px is used')
  assert.equal(one(40.5).dropped.tooSmall, 0)
  assert.equal(one(120).dropped.tooSmall, 0)
  const under = one(39.98)
  assert.equal(under.dropped.tooSmall, 1, 'a frame of 39.98 px is not')
  assert.equal(under.status, 'rejected')
  assert.equal(under.reason, 'too-small', 'and when no frame is big enough the result is refused for that reason')
  assert.equal(under.nFrames, 0)
  assert.equal(under.pose, null)
  assert.equal(under.nFramesOffered, 1)
  // The gate is the caller's to move, and 0 turns it off.
  assert.equal(one(39.98, { minSidePx: 39 }).dropped.tooSmall, 0)
  assert.equal(one(30, { minSidePx: 0 }).dropped.tooSmall, 0)
  assert.equal(one(30, { minSidePx: 31 }).reason, 'too-small')
  assert.equal(one(60, { minSidePx: 61 }).reason, 'too-small')
  assert.equal(one(60, { minSidePx: 60 }).dropped.tooSmall, 0, 'the limit itself is used')
  // A whole walk at a size above the gate, with nothing else wrong, is fused.
  const whole = fuseTagObservations(walk({ range: 2, frames: 14, arcDeg: 40, cornerNoise: 0.03, seed: 1 }).observations, { tagSizeM: SIZE_M })
  assert.equal(whole.status, 'ok', whole.reason ?? '')
  assert.equal(whole.dropped.tooSmall, 0)
})

test('small frames among large ones are dropped and counted, and do not move the pose', () => {
  const big = walk({ range: 2, frames: 14, arcDeg: 40, cornerNoise: 0.03, seed: 2 })
  const small = big.observations.map((o) => ({ ...o, corners: scaledToSide(o.corners, 30) }))
  const mixed = fuseTagObservations([...big.observations, ...small], { tagSizeM: SIZE_M })
  assert.equal(mixed.status, 'ok', mixed.reason ?? '')
  assert.equal(mixed.nFrames, 14)
  assert.equal(mixed.dropped.tooSmall, 14)
  assert.equal(mixed.nFramesOffered, 28)
  const alone = fuseTagObservations(big.observations, { tagSizeM: SIZE_M })
  assert.deepEqual(mixed.pose, alone.pose, 'the small frames did not touch the pose')
})

test('a frame that is both too small and badly fitted is told to come closer: the size gate comes before the corner fit', () => {
  const obs = atSide(30, 10, 1).map((o) => ({ ...o, cornerFit: { refined: false, edgeRmsPx: null, edgeInlierFraction: null } }))
  const f = fuseTagObservations(obs, { tagSizeM: SIZE_M })
  assert.equal(f.reason, 'too-small')
  assert.equal(f.dropped.tooSmall, 10)
  assert.equal(f.dropped.cornerFit, 0)
  // Large and badly fitted is a corner-fit refusal, as before.
  const fitted = walk({ range: 2, frames: 10, arcDeg: 40, seed: 3 }).observations.map((o) => ({ ...o, cornerFit: { refined: false, edgeRmsPx: null, edgeInlierFraction: null } }))
  assert.equal(fuseTagObservations(fitted, { tagSizeM: SIZE_M }).reason, 'corner-fit')
})

test('the size gate is also the scale estimate\'s: frames under it do not make a ruler', () => {
  const k = 1.4
  const tag = { ...fixedTag(20, 0), position: { x: 0.3 * k, y: 1.3 * k, z: -3 * k } }
  const w = walk({ tag, range: 2, frames: 25, arcDeg: 60, cornerNoise: 0.05, seed: 4, scale: k })
  assert.ok(estimateSessionScale(w.observations, SIZE_M), 'frames at 50 px make an estimate')
  // The same walk drawn at 30 px: nothing is used, so there is nothing to estimate from.
  const small = w.observations.map((o) => ({ ...o, corners: scaledToSide(o.corners, 30) }))
  assert.equal(estimateSessionScale(small, SIZE_M), null)
  assert.ok(estimateSessionScale(small, SIZE_M, { minSidePx: 0 }), 'turning the gate off gives them back')
})

test('frames whose normal is far from the others\' are dropped when the caller says how far, and kept when it does not', () => {
  // Twenty frames of one wall tag seen from 20 to 50 degrees off its normal with 0.3 px of corner noise (a few centimetres of scatter
  // a frame at 2 m), and every fifth frame drawn from the same tag turned 15 degrees about its own vertical axis at its centre: the
  // corners move by under 3 cm, which the position consensus (4 median distances of the others) does not call an outlier.
  const w = walk({ tag: fixedTag(0, 0), range: 2, frames: 20, arcDeg: 30, centreDeg: 35, cornerNoise: 0.3, seed: 5 })
  const turned = { position: w.tag.position, rotation: quatFromMatrix(mat3Mul(matrixFromQuat(w.tag.rotation), rotY((15 * Math.PI) / 180))) }
  const g = gaussian(mulberry32(55))
  const obs = w.observations.map((o, i) => {
    if (i % 5 !== 2) return o
    const drawn = projectSessionTag(turned, w.cameras[i]!, K, SIZE_M).map((c) => ({ x: c.x + 0.3 * g(), y: c.y + 0.3 * g() }))
    return { ...o, corners: drawn as unknown as Quad }
  })
  const open = { tagSizeM: SIZE_M, maxPoseSpreadM: 1, maxRotationSpreadDeg: 90 }
  const without = fuseTagObservations(obs, open)
  const withGate = fuseTagObservations(obs, { ...open, maxNormalDeviationDeg: 8 })
  assert.ok(without.pose && withGate.pose)
  assert.equal(without.nFrames, 20, `${without.nFrames} frames kept without the gate`)
  assert.equal(withGate.nFrames, 16, `${withGate.nFrames} kept with it: the four turned frames are out`)
  assert.ok(withGate.rotationSpreadDeg < without.rotationSpreadDeg, `rotation spread ${withGate.rotationSpreadDeg} with the gate, ${without.rotationSpreadDeg} without`)
  // The gate drops frames by their normal: not counted in `dropped`, as no consensus drop is.
  assert.equal(withGate.dropped.tooSmall + withGate.dropped.cornerFit + withGate.dropped.range + withGate.dropped.viewAngle + withGate.dropped.reprojection + withGate.dropped.unsolved + withGate.dropped.intrinsics, 0)
  // A loose gate keeps what a tight one drops.
  const loose = fuseTagObservations(obs, { ...open, maxNormalDeviationDeg: 30 })
  assert.equal(loose.nFrames, without.nFrames)
})

test('sessionPoseToCamera inverts poseToSession, at any session scale, and reprojecting the tag through its camera gives the corners it was drawn with', () => {
  const rand = mulberry32(91)
  for (let i = 0; i < 40; i++) {
    const cam = lookAtPose({ x: (rand() - 0.5) * 6, y: 0.5 + rand() * 2, z: (rand() - 0.5) * 6 }, { x: (rand() - 0.5) * 2, y: 1 + rand(), z: -2 - rand() * 3 })
    const pose = tagPose({ x: (rand() - 0.5) * 0.6, y: (rand() - 0.5) * 0.4, z: 1.5 + rand() * 2 }, rand() * 360, (rand() - 0.5) * 70, (rand() - 0.5) * 50)
    const k = 0.5 + rand() * 2
    const session = poseToSession({ rotation: pose.rotation, translation: pose.translation }, cam)
    // `poseToSession` works in metres; scaling the camera-to-tag vector into session units is what the fusion does, so do the same here.
    const scaled = {
      position: { x: cam.position.x + (session.position.x - cam.position.x) * k, y: cam.position.y + (session.position.y - cam.position.y) * k, z: cam.position.z + (session.position.z - cam.position.z) * k },
      rotation: session.rotation,
    }
    const back = sessionPoseToCamera(scaled, cam, k)
    assert.ok(rotationAngleBetweenDeg(back.rotation, pose.rotation) < 1e-4)
    assert.ok(Math.hypot(back.translation.x - pose.translation.x, back.translation.y - pose.translation.y, back.translation.z - pose.translation.z) < 1e-9)
  }
  // Against the harness's own camera model: a tag fixed in the session, seen from a camera, lands where the harness draws it.
  const tag = fixedTag(25, 0, { x: 0.5, y: 1.2, z: -2.5 })
  const cam = lookAtPose({ x: 1.2, y: 1.1, z: 0.2 }, tag.position)
  const drawn = projectSessionTag(tag, cam, K, SIZE_M)
  const mine = reprojectSessionTag(tag, cam, K, SIZE_M)
  assert.ok(cornerRmsPx(mine, drawn) < 1e-9, `${cornerRmsPx(mine, drawn)} px apart`)
  // And in a session whose unit is 1.6 per metre, with the tag's size and the camera's distance in those units.
  const k = 1.6
  const tagK = { position: { x: tag.position.x * k, y: tag.position.y * k, z: tag.position.z * k }, rotation: tag.rotation }
  const camK = lookAtPose({ x: 1.2 * k, y: 1.1 * k, z: 0.2 * k }, tagK.position)
  const drawnK = projectSessionTag(tagK, camK, K, SIZE_M * k)
  assert.ok(cornerRmsPx(reprojectSessionTag(tagK, camK, K, SIZE_M, k), drawnK) < 1e-9)
  assert.equal(cornerRmsPx(drawn, drawn), 0)
  // A pose solved from the corners reprojects to them (the residual of the fit, not zero by luck): ties the helper to the solver.
  const sol = solveTagPose(drawn as unknown as Quad, K, SIZE_M)!
  const asSession = poseToSession(sol.best, cam)
  assert.ok(cornerRmsPx(reprojectSessionTag(asSession, cam, K, SIZE_M), drawn) < 1e-6)
})

test('the tag as a ruler uses the range, size and reprojection limits it is given, as the fusion does: a big tag far away makes a ruler when the caller\'s range reaches it, and not under the default', () => {
  // A 300 mm sheet 5 m away through a 1000 px lens: 60 px across, which the size gate allows, and over the 4 m the default range allows.
  const w = walk({ tag: fixedTag(20, 0), range: 5, sizeM: 0.3, intrinsics: INTRINSICS_1280, frames: 25, arcDeg: 60, cornerNoise: 0.05, seed: 6 })
  assert.equal(estimateSessionScale(w.observations, 0.3), null, 'under the default range (4 m) nothing is used')
  const reaching = estimateSessionScale(w.observations, 0.3, { maxRangeM: 10 })
  assert.ok(reaching && Math.abs(reaching.sessionUnitsPerMetre - 1) < 0.01, `${reaching?.sessionUnitsPerMetre}`)
  assert.equal(estimateSessionScale(w.observations, 0.3, { maxRangeM: 10, minRangeM: 5.5 }), null, 'a tag nearer than the near limit is left out')
  assert.equal(estimateSessionScale(w.observations, 0.3, { maxRangeM: 4.9 }), null, 'and one farther than the far limit')
  // The reprojection limit: corners that fit the square to no better than 0.05 px are left out by a limit under that, and kept by the default 2 px.
  const noisy = walk({ tag: fixedTag(20, 0), range: 2, frames: 25, arcDeg: 60, cornerNoise: 0.4, seed: 8 }).observations
  assert.ok(estimateSessionScale(noisy, SIZE_M, { minSidePx: 0 }))
  assert.equal(estimateSessionScale(noisy, SIZE_M, { minSidePx: 0, maxReprojectionRmsPx: 0.01 }), null)
})
