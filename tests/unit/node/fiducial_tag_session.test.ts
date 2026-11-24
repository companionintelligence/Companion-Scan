/**
 * The marker session (`src/ar/fiducial/tag-session.ts`): the gates and the verdict they feed, and the state machine that turns frames into a
 * pose, a frame and what to tell the person.
 *
 * The scenes are exact: a tag fixed in the session, a camera walking round it, corners projected through the harness's own camera model
 * (`tests/support/fiducial-scene.ts`), a little noise where a test says so. So the numbers a test asserts are the geometry's, not the
 * detector's, and the module under test is the only thing that can be wrong. The rendered-frame chain (pixels, detector, session) is
 * `fiducial_tag_capture.test.ts`.
 *
 * Boundaries are tested at, and either side of, each gate: a gate written with `<` where it needs `<=` fails here.
 *
 * Run: node --experimental-strip-types --no-warnings --test tests/unit/node/fiducial_tag_session.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_FIDUCIAL_GATES,
  FALLBACK_TO_TAPS_MS,
  REGISTERED_MAX_HAMMING,
  TagSession,
  detectorOptionsForSession,
  fiducialVerdict,
  isAmbiguousView,
  type FiducialGates,
  type FiducialVerdictReason,
  type TagFrameInput,
  type TagSessionConfig,
  type TagSessionState,
} from '../../../src/ar/fiducial/tag-session.ts'
import {
  DEFAULT_MAX_EDGE_RMS_PX,
  DEFAULT_MAX_ROTATION_SPREAD_DEG,
  DEFAULT_MAX_VIEW_ANGLE_DEG,
  DEFAULT_MIN_EDGE_INLIER_FRACTION,
  DEFAULT_MIN_RANGE_M,
  MIN_SCALE_BASELINE_M,
  POSE_GRADE_MIN_SIDE_PX,
} from '../../../src/ar/fiducial/tag-pose.ts'
import { transformPoint } from '../../../src/world/geo.ts'
import type { FiducialEvidence } from '../../../src/world/fiducial-evidence.ts'
import type { Quad } from '../../../src/ar/fiducial/types.ts'
import { flatTag, fixedTag, frameInputs, walk, type WalkOptions } from '../../support/fiducial-scene.ts'
import { INTRINSICS_1280, INTRINSICS_640, matrixFromQuat } from '../../support/fiducial-render.ts'
import { mulberry32 } from '../../../src/shared/test-homes.ts'

const FAMILY = 'cscan-6x6-v1'
const WALL = fixedTag(0, 0)

function config(over: Partial<TagSessionConfig> = {}): TagSessionConfig {
  return { family: FAMILY, printedSizeMm: 200, sizeSource: 'qr', expected: null, scaleKind: 'metric', floor: () => ({ floorY: null, mountHeightM: 1.2 }), ...over }
}

/** A wall tag seen from 20 to 50 degrees off its normal at 2 m, 24 frames 400 ms apart (the camera turns 4 degrees a second): 12 are enough. */
function goodWalk(over: Partial<WalkOptions> = {}) {
  return walk({ tag: WALL, range: 2, frames: 24, arcDeg: 36, centreDeg: 35, cornerNoise: 0.1, seed: 3, dtMs: 400, ...over })
}

function play(session: TagSession, inputs: readonly TagFrameInput[]): TagSessionState {
  let state = session.state()
  for (const f of inputs) state = session.offer(f)
  return state
}

const near = (a: number, b: number, eps: number): boolean => Math.abs(a - b) <= eps

// ===============================================================================================
// Constants
// ===============================================================================================

test('the gates are the WP-14b spec\'s, adopted, and cannot be changed for everyone by one caller', () => {
  assert.deepEqual({ ...DEFAULT_FIDUCIAL_GATES }, {
    minFrames: 12,
    minDurationMs: 1000,
    minTravelM: 0.2,
    minTurnDeg: 15,
    maxAngularSpeedDegPerS: 10,
    minPoseSidePx: 40,
    minIdentitySidePx: 24,
    maxNormalDeviationDeg: 8,
    maxPoseSpreadM: 0.02,
    maxHeadingSpreadDeg: 1,
    maxRotationSpreadDeg: 3,
    maxReprojectionRmsPx: 0.8,
    minRangeM: 0.3,
    maxRangeM: 10,
    maxViewAngleDeg: 70,
    maxEdgeRmsPx: 1,
    minEdgeInlierFraction: 0.6,
    goodReprojectionRmsPx: 0.5,
    identityMinFrames: 5,
    identityWindowFrames: 8,
    maxScaleOffFraction: 0.03,
  })
  assert.equal(DEFAULT_FIDUCIAL_GATES.minPoseSidePx, POSE_GRADE_MIN_SIDE_PX)
  // The limits the session applies to a frame are the fusion's own adopted defaults, named in one place each (a frame the session counts is a frame the fusion keeps).
  assert.equal(DEFAULT_FIDUCIAL_GATES.maxRotationSpreadDeg, DEFAULT_MAX_ROTATION_SPREAD_DEG)
  assert.equal(DEFAULT_FIDUCIAL_GATES.minRangeM, DEFAULT_MIN_RANGE_M)
  assert.equal(DEFAULT_FIDUCIAL_GATES.maxViewAngleDeg, DEFAULT_MAX_VIEW_ANGLE_DEG)
  assert.equal(DEFAULT_FIDUCIAL_GATES.maxEdgeRmsPx, DEFAULT_MAX_EDGE_RMS_PX)
  assert.equal(DEFAULT_FIDUCIAL_GATES.minEdgeInlierFraction, DEFAULT_MIN_EDGE_INLIER_FRACTION)
  assert.ok(Object.isFrozen(DEFAULT_FIDUCIAL_GATES))
  assert.equal(FALLBACK_TO_TAPS_MS, 30_000)
  assert.equal(REGISTERED_MAX_HAMMING, 0)
})

test('the detector is told what the session needs: a registered tag only, read exactly, at the identity size; otherwise any tag at the default tolerance', () => {
  assert.deepEqual(detectorOptionsForSession({ expected: { family: FAMILY, tagId: 9 } }), { ids: [9], maxHamming: 0, minSidePx: 24 })
  const open = detectorOptionsForSession({ expected: null })
  assert.deepEqual(open, { minSidePx: 24 })
  assert.equal('maxHamming' in open, false, 'the detector\'s own default stands')
  assert.deepEqual(detectorOptionsForSession({ expected: null }, { ...DEFAULT_FIDUCIAL_GATES, minIdentitySidePx: 30 }), { minSidePx: 30 })
})

// ===============================================================================================
// The verdict
// ===============================================================================================

function evidence(over: Partial<FiducialEvidence> = {}): FiducialEvidence {
  return {
    tagId: 7,
    family: FAMILY,
    expectedTagId: 7,
    identityFrames: 8,
    identityWindow: 8,
    printedSizeMm: 200,
    sizeSource: 'qr',
    mount: 'wall',
    poseSpreadM: 0.01,
    headingSpreadDeg: 0.3,
    rotationSpreadDeg: 0.4,
    reprojectionRmsPx: 0.3,
    rangeM: 2.2,
    nFrames: 14,
    durationMs: 3000,
    cameraTravelM: 0.5,
    cameraTurnDeg: 20,
    ambiguityRatio: 4,
    viewAngleDeg: 35,
    sidePx: 55,
    maxAngularSpeedDegPerS: 6,
    sessionUnitsPerMetre: 1,
    scaleSource: 'runtime-metric',
    scaleOffFraction: 0.01,
    scaleBaselineM: 0.5,
    scaleResidualM: 0.004,
    ...over,
  }
}

test('verified exactly when the marker is the registered one and every gate holds; otherwise provisional with the reasons', () => {
  const v = fiducialVerdict(evidence())
  assert.deepEqual(v, { status: 'verified', reasons: [], quality: 'good' })
  // Nothing registered: nothing to match, so provisional, with the one reason that says so, and the quality still graded.
  assert.deepEqual(fiducialVerdict(evidence({ expectedTagId: null })), { status: 'provisional', reasons: ['first-calibration'], quality: 'good' })
  // Another marker than the Place's.
  assert.deepEqual(fiducialVerdict(evidence({ tagId: 3 })).reasons, ['identity-mismatch'])
  assert.equal(fiducialVerdict(evidence({ tagId: 3 })).status, 'provisional')
  // The Place's marker, read in too few of the last frames.
  assert.deepEqual(fiducialVerdict(evidence({ identityFrames: 4 })).reasons, ['identity-unconfirmed'])
  assert.equal(fiducialVerdict(evidence({ identityFrames: 5 })).status, 'verified')
  // A mismatch is named before anything about frames, whatever else is wrong.
  assert.deepEqual(fiducialVerdict(evidence({ tagId: 3, identityFrames: 1, nFrames: 2 })).reasons.slice(0, 1), ['identity-mismatch'])
})

/** Each gate: a value that passes, the value just over it that does not, and the reason. The limits themselves pass (`<=` where the gate says "at most", `<` where it says "under"). */
const BOUNDARIES: Array<{ field: keyof FiducialEvidence; pass: unknown; fail: unknown; reason: FiducialVerdictReason; also?: Partial<FiducialEvidence> }> = [
  { field: 'nFrames', pass: 12, fail: 11, reason: 'too-few-frames' },
  { field: 'durationMs', pass: 1000, fail: 999, reason: 'too-short' },
  // Motion: the camera moved far enough OR turned far enough. Each is tested with the other made too small to carry it.
  { field: 'cameraTravelM', pass: 0.2, fail: 0.199, reason: 'too-little-motion', also: { cameraTurnDeg: 0 } },
  { field: 'cameraTurnDeg', pass: 15, fail: 14.9, reason: 'too-little-motion', also: { cameraTravelM: 0 } },
  { field: 'maxAngularSpeedDegPerS', pass: 9.999, fail: 10, reason: 'too-fast' },
  { field: 'poseSpreadM', pass: 0.02, fail: 0.0201, reason: 'spread' },
  { field: 'headingSpreadDeg', pass: 1, fail: 1.0001, reason: 'heading-spread' },
  { field: 'rotationSpreadDeg', pass: 3, fail: 3.0001, reason: 'rotation-spread' },
  { field: 'reprojectionRmsPx', pass: 0.8, fail: 0.8001, reason: 'reprojection' },
  { field: 'scaleOffFraction', pass: 0.03, fail: 0.0301, reason: 'scale-mismatch' },
  { field: 'scaleOffFraction', pass: -0.03, fail: -0.0301, reason: 'scale-mismatch' },
]

test('each gate is judged at its limit and either side of it, and names itself', () => {
  for (const b of BOUNDARIES) {
    const label = `${b.field} ${String(b.pass)} / ${String(b.fail)}`
    const pass = fiducialVerdict(evidence({ [b.field]: b.pass, ...(b.also ?? {}) } as Partial<FiducialEvidence>))
    // With the other motion measure made too small to carry it, the passing side of a motion gate is the one that carries.
    if (b.field === 'cameraTravelM' || b.field === 'cameraTurnDeg') assert.equal(pass.status, 'verified', `${label}: the limit passes`)
    else assert.equal(pass.status, 'verified', `${label}: the limit passes (${pass.reasons.join(', ')})`)
    const fail = fiducialVerdict(evidence({ [b.field]: b.fail, ...(b.also ?? {}) } as Partial<FiducialEvidence>))
    assert.equal(fail.status, 'provisional', `${label}: just over fails`)
    assert.deepEqual(fail.reasons, [b.reason], label)
  }
  // Either motion measure carries it alone.
  assert.equal(fiducialVerdict(evidence({ cameraTravelM: 0, cameraTurnDeg: 20 })).status, 'verified')
  assert.equal(fiducialVerdict(evidence({ cameraTravelM: 0.5, cameraTurnDeg: 0 })).status, 'verified')
  // A number that does not exist fails every gate it feeds (a NaN compares false with everything, which must not read as a pass).
  for (const field of ['poseSpreadM', 'headingSpreadDeg', 'rotationSpreadDeg', 'reprojectionRmsPx', 'maxAngularSpeedDegPerS'] as const) {
    assert.equal(fiducialVerdict(evidence({ [field]: Number.NaN })).status, 'provisional', `${field} is NaN`)
  }
  assert.equal(fiducialVerdict(evidence({ scaleOffFraction: Number.NaN })).status, 'provisional')
})

test('the print-scale check is the metric runtime\'s: a missing or large figure is a reason there, and nothing on a runtime whose unit came from the print', () => {
  assert.deepEqual(fiducialVerdict(evidence({ scaleOffFraction: null })).reasons, ['scale-unchecked'])
  assert.deepEqual(fiducialVerdict(evidence({ scaleOffFraction: 0.05 })).reasons, ['scale-mismatch'])
  assert.deepEqual(fiducialVerdict(evidence({ scaleOffFraction: -0.05 })).reasons, ['scale-mismatch'])
  const estimated = evidence({ scaleSource: 'tag-estimate', scaleOffFraction: null, sessionUnitsPerMetre: 1.6 })
  assert.deepEqual(fiducialVerdict(estimated), { status: 'verified', reasons: [], quality: 'good' })
})

test('the quality badge is the pose gates and the reprojection error, and nothing else', () => {
  assert.equal(fiducialVerdict(evidence({ reprojectionRmsPx: 0.5 })).quality, 'good', 'the limit of good is good')
  assert.equal(fiducialVerdict(evidence({ reprojectionRmsPx: 0.5001 })).quality, 'fair')
  assert.equal(fiducialVerdict(evidence({ reprojectionRmsPx: 0.8 })).quality, 'fair')
  assert.equal(fiducialVerdict(evidence({ reprojectionRmsPx: 0.8001 })).quality, 'poor')
  assert.equal(fiducialVerdict(evidence({ poseSpreadM: 0.03 })).quality, 'poor')
  // Identity and scale reasons do not make a read poor: they say it is not verified, not that the frames were bad.
  assert.equal(fiducialVerdict(evidence({ expectedTagId: null })).quality, 'good')
  assert.equal(fiducialVerdict(evidence({ tagId: 3 })).quality, 'good')
  assert.equal(fiducialVerdict(evidence({ scaleOffFraction: 0.2 })).quality, 'good')
  // A poor read stays provisional with its reasons even on a first calibration.
  assert.deepEqual(fiducialVerdict(evidence({ expectedTagId: null, nFrames: 3 })), { status: 'provisional', reasons: ['first-calibration', 'too-few-frames'], quality: 'poor' })
})

test('verified is derived from the evidence and the gates and nothing else: 3000 random records agree with an independent statement of the rule', () => {
  const rand = mulberry32(11)
  const gates = DEFAULT_FIDUCIAL_GATES
  let verified = 0
  for (let i = 0; i < 3000; i++) {
    const e = evidence({
      tagId: rand() < 0.9 ? 7 : 3,
      expectedTagId: rand() < 0.9 ? 7 : rand() < 0.5 ? null : 3,
      identityFrames: Math.floor(rand() * 9),
      nFrames: Math.floor(rand() * 30),
      durationMs: rand() * 3000,
      cameraTravelM: rand() * 0.6,
      cameraTurnDeg: rand() * 40,
      maxAngularSpeedDegPerS: rand() * 14,
      poseSpreadM: rand() * 0.04,
      headingSpreadDeg: rand() * 1.6,
      rotationSpreadDeg: rand() * 4,
      reprojectionRmsPx: rand() * 1.4,
      scaleSource: rand() < 0.5 ? 'runtime-metric' : 'tag-estimate',
      scaleOffFraction: rand() < 0.2 ? null : (rand() - 0.5) * 0.12,
    })
    const identityOk = e.expectedTagId !== null && e.expectedTagId === e.tagId && e.identityFrames >= gates.identityMinFrames
    const poseOk =
      e.nFrames >= gates.minFrames &&
      e.durationMs >= gates.minDurationMs &&
      (e.cameraTravelM >= gates.minTravelM || e.cameraTurnDeg >= gates.minTurnDeg) &&
      e.maxAngularSpeedDegPerS < gates.maxAngularSpeedDegPerS &&
      e.poseSpreadM <= gates.maxPoseSpreadM &&
      e.headingSpreadDeg <= gates.maxHeadingSpreadDeg &&
      e.rotationSpreadDeg <= gates.maxRotationSpreadDeg &&
      e.reprojectionRmsPx <= gates.maxReprojectionRmsPx
    const scaleOk = e.scaleSource !== 'runtime-metric' || (e.scaleOffFraction !== null && Math.abs(e.scaleOffFraction) <= gates.maxScaleOffFraction)
    const v = fiducialVerdict(e)
    assert.equal(v.status === 'verified', identityOk && poseOk && scaleOk, JSON.stringify(e))
    assert.equal(v.reasons.length === 0, v.status === 'verified')
    if (v.status === 'verified') verified++
  }
  assert.ok(verified > 20 && verified < 2900, `${verified} of 3000 verified: the draws exercise both outcomes`)
})

test('stored evidence can be judged again against other gates: a stricter spread turns a verified read provisional', () => {
  const e = evidence({ poseSpreadM: 0.015 })
  assert.equal(fiducialVerdict(e).status, 'verified')
  const strict: FiducialGates = { ...DEFAULT_FIDUCIAL_GATES, maxPoseSpreadM: 0.01 }
  assert.deepEqual(fiducialVerdict(e, strict).reasons, ['spread'])
  assert.equal(fiducialVerdict(e, { ...DEFAULT_FIDUCIAL_GATES, identityMinFrames: 9 }).status, 'provisional')
})

// ===============================================================================================
// The session: a good read
// ===============================================================================================

test('a first calibration reads the marker in twelve frames: provisional with a good badge, and a frame that puts the tag where it is, in metres', () => {
  const w = goodWalk()
  const session = new TagSession(config())
  const states: TagSessionState[] = []
  for (const f of frameInputs(w, 7, FAMILY)) states.push(session.offer(f))
  const done = states.findIndex((s) => s.phase === 'done')
  assert.equal(done, 12, 'the first frame has no turning speed and is not used; twelve more are enough')
  const result = states[done]!.result!
  assert.equal(result.status, 'ok')
  assert.deepEqual(result.verdict, { status: 'provisional', reasons: ['first-calibration'], quality: 'good' })
  const e = result.evidence
  assert.equal(e.tagId, 7)
  assert.equal(e.expectedTagId, null)
  assert.equal(e.nFrames, 12)
  assert.equal(e.durationMs, 4400)
  assert.equal(e.mount, 'wall')
  assert.equal(e.scaleSource, 'runtime-metric')
  assert.equal(e.sessionUnitsPerMetre, 1)
  assert.ok(e.scaleOffFraction !== null && Math.abs(e.scaleOffFraction) < 0.005, `${e.scaleOffFraction}`)
  assert.ok(e.poseSpreadM < 0.01 && e.rotationSpreadDeg < 1 && e.reprojectionRmsPx < 0.3)
  assert.ok(near(e.rangeM, 2, 0.02))
  assert.ok(e.maxAngularSpeedDegPerS < 5)
  assert.ok(e.cameraTravelM > 0.5 && e.cameraTurnDeg > 15)
  assert.deepEqual(result.flags, ['floor-from-mount-height'])
  // The frame: the tag's plan position is the origin, the floor is 1.2 m under its centre, and a metre out from the wall is +Z.
  const tag = WALL.position
  const m = result.frame.sessionToProject
  const at = (p: { x: number; y: number; z: number }) => transformPoint(m, p)
  const R = matrixFromQuat(WALL.rotation)
  const out = at({ x: tag.x + R[2]!, y: tag.y, z: tag.z + R[8]! })
  assert.ok(Math.hypot(out.x, out.y - 1.2, out.z - 1) < 0.02, `a metre out from the wall is at ${JSON.stringify(out)}`)
  const centre = at(tag)
  assert.ok(Math.hypot(centre.x, centre.y - 1.2, centre.z) < 0.02, `the tag centre is at ${JSON.stringify(centre)}`)
  // The counters say what happened to the thirteen frames offered.
  const c = states[done]!.counts
  assert.equal(c.framesOffered, 13)
  assert.equal(c.framesWithTag, 13)
  assert.equal(c.tooFast, 1)
  assert.equal(c.accepted, 12)
  assert.equal(states[done]!.hint, null)
  assert.equal(states[done]!.progress, 1)
})

test('a registered marker, read in a good walk, is verified, and the evidence carries the identity it was verified on', () => {
  const w = goodWalk()
  const session = new TagSession(config({ expected: { family: FAMILY, tagId: 7 } }))
  const state = play(session, frameInputs(w, 7, FAMILY))
  assert.equal(state.phase, 'done')
  const r = state.result!
  assert.deepEqual(r.verdict, { status: 'verified', reasons: [], quality: 'good' })
  assert.equal(r.evidence.expectedTagId, 7)
  assert.equal(r.evidence.identityFrames, 8)
  assert.equal(r.evidence.identityWindow, 8)
  assert.deepEqual(state.identity, { subjectTagId: 7, frames: 8, window: 8 })
})

test('progress rises with the frames and reaches 1 only with the result', () => {
  const session = new TagSession(config())
  const progress: number[] = []
  for (const f of frameInputs(goodWalk(), 7, FAMILY)) {
    const s = session.offer(f)
    progress.push(s.progress)
    if (s.phase === 'done') break
  }
  for (let i = 1; i < progress.length; i++) assert.ok(progress[i]! >= progress[i - 1]! - 1e-12, `progress fell at frame ${i}: ${progress.join(', ')}`)
  assert.equal(progress[0], 0)
  assert.equal(progress[progress.length - 1], 1)
  assert.ok(progress.slice(0, -1).every((p) => p < 1), 'nothing reads as finished before the result exists')
})

test('a session that is done ignores further frames until it is reset, and reset begins again with the configuration kept', () => {
  const session = new TagSession(config())
  const inputs = frameInputs(goodWalk(), 7, FAMILY)
  const done = play(session, inputs)
  assert.equal(done.phase, 'done')
  const after = session.offer(inputs[3]!)
  assert.equal(after.result, done.result, 'the same result object')
  assert.equal(after.counts.framesOffered, done.counts.framesOffered)
  session.reset()
  const fresh = session.state()
  assert.equal(fresh.phase, 'searching')
  assert.equal(fresh.progress, 0)
  assert.equal(fresh.result, null)
  assert.deepEqual(fresh.hint, { code: 'no-tag' })
  assert.equal(fresh.counts.framesOffered, 0)
  assert.equal(play(session, inputs).phase, 'done', 'and it reads again')
})

// ===============================================================================================
// What a frame must be to count
// ===============================================================================================

/** The state after offering ONE frame (the second of a walk, so it has a turning speed) with its detection or speed changed. */
function afterOne(over: NonNullable<Parameters<typeof frameInputs>[3]>, session = new TagSession(config())): TagSessionState {
  const inputs = frameInputs(goodWalk(), 7, FAMILY, over)
  return session.offer(inputs[1]!)
}

test('a frame is a pose observation only at 40 px or more, with fitted corners, while the camera turns under 10 degrees a second', () => {
  // Size, at and either side of the limit. The detector's `sidePx` is what the session reads.
  const at = afterOne(() => ({ detection: { sidePx: 40 } }))
  assert.equal(at.counts.accepted, 1)
  assert.equal(at.counts.tooSmall, 0)
  const under = afterOne(() => ({ detection: { sidePx: 39.99 } }))
  assert.equal(under.counts.accepted, 0)
  assert.equal(under.counts.tooSmall, 1)
  assert.deepEqual(under.hint, { code: 'move-closer', sidePx: 39.99, neededPx: 40 })
  assert.equal(under.phase, 'collecting')
  // Fitted corners: a detection that says its corners are the polygon's is read for its id and counted, not used for a pose.
  const unfitted = afterOne(() => ({ detection: { refined: false } }))
  assert.equal(unfitted.counts.accepted, 0)
  assert.equal(unfitted.counts.cornerFit, 1)
  assert.deepEqual(unfitted.hint, { code: 'keep-uncovered' })
  // Speed: under 10 is used, 10 is not, an unknown speed is not.
  assert.equal(afterOne(() => ({ angularSpeedDegPerS: 9.99 })).counts.accepted, 1)
  const fast = afterOne(() => ({ angularSpeedDegPerS: 10 }))
  assert.equal(fast.counts.accepted, 0)
  assert.equal(fast.counts.tooFast, 1)
  assert.deepEqual(fast.hint, { code: 'too-fast', degPerS: 10, limitDegPerS: 10 })
  const unknown = afterOne(() => ({ angularSpeedDegPerS: null }))
  assert.equal(unknown.counts.accepted, 0)
  assert.deepEqual(unknown.hint, { code: 'too-fast', degPerS: null, limitDegPerS: 10 })
  // The order they are told in: too small before an unfitted edge before too fast.
  assert.equal(afterOne(() => ({ detection: { sidePx: 20, refined: false }, angularSpeedDegPerS: 50 })).hint?.code, 'move-closer')
  assert.equal(afterOne(() => ({ detection: { refined: false }, angularSpeedDegPerS: 50 })).hint?.code, 'keep-uncovered')
})

test('a frame whose projection and size disagree is named, not used; corners that are not a square are counted as unsolved', () => {
  const bad = afterOne(() => ({ intrinsics: { ...INTRINSICS_640, fx: INTRINSICS_640.fx * 1.5 } }))
  assert.equal(bad.counts.intrinsics, 1)
  assert.equal(bad.counts.accepted, 0)
  assert.deepEqual(bad.hint, { code: 'bad-intrinsics' })
  const collapsed: Quad = [{ x: 100, y: 100 }, { x: 200, y: 100 }, { x: 300, y: 100 }, { x: 400, y: 100 }]
  const unsolved = afterOne(() => ({ detection: { corners: collapsed, sidePx: 60 } }))
  assert.equal(unsolved.counts.unsolved, 1)
  assert.equal(unsolved.counts.accepted, 0)
})

test('no tag in view is a hint, not an error, and another tag of the family is not the registered one', () => {
  const session = new TagSession(config({ expected: { family: FAMILY, tagId: 7 } }))
  const inputs = frameInputs(goodWalk(), 9, FAMILY)
  const state = play(session, inputs.slice(0, 6))
  assert.equal(state.phase, 'searching')
  assert.deepEqual(state.hint, { code: 'other-tag', tagId: 9 })
  assert.equal(state.counts.otherTag, 6)
  assert.equal(state.counts.accepted, 0)
  assert.equal(state.result, null)
  // And a tag of another family is not read at all.
  const foreign = new TagSession(config({ expected: { family: FAMILY, tagId: 7 } }))
  const s2 = play(foreign, frameInputs(goodWalk(), 7, 'cscan-5x5-v1').slice(0, 6))
  assert.equal(s2.counts.framesWithTag, 0)
  assert.deepEqual(s2.hint, { code: 'no-tag' })
  const nothing = new TagSession(config())
  const s3 = play(nothing, frameInputs(goodWalk(), 7, FAMILY, () => ({ detection: null })).slice(0, 4))
  assert.equal(s3.phase, 'searching')
  assert.deepEqual(s3.hint, { code: 'no-tag' })
  assert.equal(s3.counts.framesOffered, 4)
  assert.equal(s3.counts.framesWithTag, 0)
})

// ===============================================================================================
// Identity
// ===============================================================================================

test('a registered marker is not verified until it has been read in five of the last eight frames, and the frames wait for it', () => {
  const w = goodWalk({ frames: 48 })
  const session = new TagSession(config({ expected: { family: FAMILY, tagId: 7 } }))
  // Every second frame has no detection: twelve accepted frames arrive by frame 26 or so, and the window never holds more than four.
  const sparse = frameInputs(w, 7, FAMILY, (i) => (i % 2 === 1 ? { detection: null } : {}))
  const blocked = play(session, sparse.slice(0, 40))
  assert.ok(blocked.counts.accepted >= 12, `${blocked.counts.accepted} frames accepted`)
  assert.equal(blocked.phase, 'collecting')
  assert.equal(blocked.result, null)
  assert.equal(blocked.identity.frames, 4)
  assert.equal(blocked.identity.window, 8)
  // Then the marker stays in view: the window fills to five and the result arrives, verified.
  const rest = frameInputs(w, 7, FAMILY).slice(40)
  const states = rest.map((f) => session.offer(f))
  const first = states.findIndex((s) => s.phase === 'done')
  assert.ok(first >= 0 && first <= 4, `done after ${first + 1} more frames`)
  const r = states[first]!.result!
  assert.equal(r.verdict.status, 'verified')
  assert.ok(r.evidence.identityFrames >= 5)
})

test('with no registered marker the first tag read in five of eight frames is the subject, and frames of any other id are left out of the pose', () => {
  const w = goodWalk({ frames: 30 })
  const session = new TagSession(config())
  // The first four frames read tag 3, then tag 5 from then on. Tag 5 holds five of the last eight at frame 8 and becomes the subject.
  const inputs = frameInputs(w, 5, FAMILY, (i) => (i < 4 ? { detection: { id: 3 } } : {}))
  const state = play(session, inputs)
  assert.equal(state.phase, 'done')
  assert.equal(state.result!.evidence.tagId, 5)
  assert.equal(state.identity.subjectTagId, 5)
  assert.ok(state.result!.evidence.nFrames <= state.counts.accepted - 3, 'the frames that read tag 3 are not in the pose')
})

// ===============================================================================================
// Frame shifts, time, and the ends of a session
// ===============================================================================================

test('a change of the runtime\'s epoch begins the read again: the frames before it are not in the same frame of reference as those after', () => {
  const w = goodWalk({ frames: 40 })
  const session = new TagSession(config())
  const inputs = frameInputs(w, 7, FAMILY, (i) => ({ epoch: i < 8 ? 0 : 1 }))
  let shiftedState: TagSessionState | null = null
  let state = session.state()
  for (const f of inputs) {
    state = session.offer(f)
    if (shiftedState === null && state.counts.frameShifts === 1) shiftedState = state
  }
  assert.ok(shiftedState, 'the shift was seen')
  assert.deepEqual(shiftedState!.hint, { code: 'frame-shifted' })
  assert.equal(shiftedState!.counts.accepted, 1, 'only the frame that came with the new epoch is kept')
  assert.equal(state.phase, 'done')
  assert.equal(state.counts.frameShifts, 1)
  // The evidence is built from frames of one epoch only: it starts at the shift, and its span is shorter than the whole walk's.
  assert.ok(state.result!.evidence.durationMs < 40 * 400 - 8 * 400)
  assert.equal(state.counts.framesOffered, 8 + state.counts.accepted + state.counts.tooFast + (state.counts.framesOffered - 8 - state.counts.accepted - state.counts.tooFast))
})

test('after thirty seconds of frame time without a result it says taps are the way, and stays that way until reset; the limit is the caller\'s', () => {
  const session = new TagSession(config())
  const blank = (t: number): TagFrameInput => ({ timestampMs: t, detections: [], intrinsics: INTRINSICS_640, cameraPose: WALL, angularSpeedDegPerS: 1, epoch: 0 })
  assert.equal(session.offer(blank(1000)).phase, 'searching')
  assert.equal(session.offer(blank(30_999)).phase, 'searching', 'a millisecond short of thirty seconds after the first frame')
  assert.equal(session.offer(blank(31_000)).phase, 'timed-out')
  assert.equal(session.offer(blank(31_100)).phase, 'timed-out', 'sticky')
  session.reset()
  assert.equal(session.offer(blank(5)).phase, 'searching')
  const quick = new TagSession(config({ fallbackAfterMs: 2000 }))
  assert.equal(quick.offer(blank(0)).phase, 'searching')
  assert.equal(quick.offer(blank(1999)).phase, 'searching')
  assert.equal(quick.offer(blank(2000)).phase, 'timed-out')
  // A read that finished is not timed out by frames that come later.
  const done = new TagSession(config())
  assert.equal(play(done, frameInputs(goodWalk(), 7, FAMILY)).phase, 'done')
})

// ===============================================================================================
// Scale
// ===============================================================================================

test('where the runtime\'s unit is not the metre, the unit is worked out from the printed size and the camera\'s travel, and the frame is in metres', () => {
  const k = 1.6
  const tag = { ...WALL, position: { x: WALL.position.x * k, y: WALL.position.y * k, z: WALL.position.z * k } }
  for (const kind of ['arbitrary', 'estimated-metric'] as const) {
    const w = walk({ tag, range: 2, frames: 24, arcDeg: 36, centreDeg: 35, cornerNoise: 0.1, seed: 3, dtMs: 400, scale: k })
    const session = new TagSession(config({ scaleKind: kind }))
    const state = play(session, frameInputs(w, 7, FAMILY))
    assert.equal(state.phase, 'done', kind)
    const r = state.result!
    assert.equal(r.scale.source, 'tag-estimate')
    assert.ok(Math.abs(r.scale.sessionUnitsPerMetre / k - 1) < 0.01, `${kind}: recovered ${r.scale.sessionUnitsPerMetre} for ${k}`)
    assert.equal(r.evidence.scaleOffFraction, null, 'the unit came from the print, so it cannot disagree with it')
    assert.equal(r.evidence.scaleSource, 'tag-estimate')
    assert.ok(near(r.evidence.rangeM, 2, 0.03), 'the range is metric whatever the session counts in')
    // A metre out from the wall is a metre along +Z, in the frame, though the session counted it as 1.6 units.
    const R = matrixFromQuat(WALL.rotation)
    const out = transformPoint(r.frame.sessionToProject, { x: tag.position.x + R[2]! * k, y: tag.position.y, z: tag.position.z + R[8]! * k })
    assert.ok(Math.hypot(out.x, out.y - 1.2, out.z - 1) < 0.03, `${kind}: ${JSON.stringify(out)}`)
    // Nothing is said to be checked that was not: the verdict has no scale reason on this runtime, and a registered tag is verified.
    assert.deepEqual(r.verdict.reasons, ['first-calibration'])
  }
})

test('the unit is worked out at the range the session reads, not at the estimator\'s own default: a 300 mm sheet 5 m away on a runtime whose unit is not the metre', () => {
  const k = 1.6
  const tag = { ...WALL, position: { x: WALL.position.x * k, y: WALL.position.y * k, z: WALL.position.z * k } }
  const w = walk({ tag, sizeM: 0.3, range: 5, intrinsics: INTRINSICS_1280, frames: 24, arcDeg: 40, centreDeg: 35, cornerNoise: 0.1, seed: 3, dtMs: 400, scale: k })
  const session = new TagSession(config({ scaleKind: 'arbitrary', printedSizeMm: 300 }))
  const state = play(session, frameInputs(w, 7, FAMILY))
  assert.equal(state.phase, 'done', `${state.phase} ${JSON.stringify(state.hint)}`)
  const r = state.result!
  assert.ok(near(r.evidence.rangeM, 5, 0.1), `${r.evidence.rangeM} m`)
  assert.ok(near(r.scale.sessionUnitsPerMetre / k, 1, 0.01), `${r.scale.sessionUnitsPerMetre}`)
  // The same sheet at 3 m (the default range reaches it) gives the same unit: the limit is not what decides it there.
  const near3 = walk({ tag, sizeM: 0.3, range: 3, intrinsics: INTRINSICS_1280, frames: 24, arcDeg: 40, centreDeg: 35, cornerNoise: 0.1, seed: 3, dtMs: 400, scale: k })
  const r3 = play(new TagSession(config({ scaleKind: 'arbitrary', printedSizeMm: 300 })), frameInputs(near3, 7, FAMILY)).result!
  assert.ok(near(r3.scale.sessionUnitsPerMetre / k, 1, 0.01))
})

test('the evidence says what the unit rests on: the camera travel the estimate used, and how far its fit disagrees with itself, in metres, whatever the session counts in', () => {
  // The runtime\'s camera positions are 6 mm out in each axis (metres), as a runtime\'s are: the fit cannot be exact and its residual is the size of that noise.
  const rand = mulberry32(77)
  const noise = (): number => (rand() + rand() + rand() + rand() - 2) * 0.006 * Math.sqrt(3)
  for (const k of [1, 1.6]) {
    const tag = { ...WALL, position: { x: WALL.position.x * k, y: WALL.position.y * k, z: WALL.position.z * k } }
    const w = walk({ tag, range: 2, frames: 40, arcDeg: 40, centreDeg: 35, cornerNoise: 0.05, seed: 3, dtMs: 400, scale: k })
    const session = new TagSession(config({ scaleKind: k === 1 ? 'metric' : 'arbitrary' }))
    const inputs = frameInputs(w, 7, FAMILY, (i) => ({ cameraPose: { position: { x: w.cameras[i]!.position.x + noise() * k, y: w.cameras[i]!.position.y + noise() * k, z: w.cameras[i]!.position.z + noise() * k }, rotation: w.cameras[i]!.rotation } }))
    const state = play(session, inputs)
    assert.equal(state.phase, 'done', `k ${k}`)
    const e = state.result!.evidence
    assert.ok(e.scaleBaselineM !== null && e.scaleBaselineM >= MIN_SCALE_BASELINE_M && e.scaleBaselineM < 1.5, `k ${k}: baseline ${e.scaleBaselineM} m`)
    // Per axis 6 mm of noise in metres is a root-mean-square disagreement of about 1 cm (three axes, less the four fitted numbers): in metres, and not in the session's own units.
    assert.ok(e.scaleResidualM !== null && e.scaleResidualM > 0.007 && e.scaleResidualM < 0.0125, `k ${k}: residual ${e.scaleResidualM} m`)
  }
})

test('the camera\'s travel is judged in metres, whatever the session counts in: a third of a metre of walking in a session whose unit is 2 m is enough, and the evidence says so in metres', () => {
  // A session unit of two metres: a walk of 0.32 m is 0.16 units, which is under the 0.2 the gate allows if it were read in the session's own unit.
  const k = 0.5
  const tag = { ...WALL, position: { x: WALL.position.x * k, y: WALL.position.y * k, z: WALL.position.z * k } }
  const w = walk({ tag, range: 2, frames: 24, arcDeg: 11, centreDeg: 35, cornerNoise: 0.05, seed: 3, dtMs: 400, scale: k })
  const session = new TagSession(config({ scaleKind: 'arbitrary' }))
  const state = play(session, frameInputs(w, 7, FAMILY))
  assert.equal(state.phase, 'done', `${state.phase} ${state.hint?.code}`)
  const e = state.result!.evidence
  assert.ok(near(e.cameraTravelM, 0.32, 0.03), `travel ${e.cameraTravelM} m`)
  assert.ok(near(e.sessionUnitsPerMetre, k, 0.01), `unit ${e.sessionUnitsPerMetre}`)
  assert.ok(e.cameraTurnDeg < DEFAULT_FIDUCIAL_GATES.minTurnDeg, 'it is the travel that passes the motion gate, not the turn')
})

test('the evidence reports the fastest the camera turned in the frames the pose is made of, not the slowest or the last', () => {
  const w = goodWalk()
  const speeds = [2, 3, 6.5, 4, 9.2, 5, 3.5, 1]
  const session = new TagSession(config({ expected: { family: FAMILY, tagId: 7 } }))
  const state = play(session, frameInputs(w, 7, FAMILY, (i) => ({ angularSpeedDegPerS: speeds[i % speeds.length]! })))
  assert.equal(state.phase, 'done')
  assert.equal(state.result!.evidence.maxAngularSpeedDegPerS, 9.2)
  assert.equal(state.result!.verdict.status, 'verified', 'under the 10 degrees a second the gate allows')
})

test('a view is ambiguous when it is near face-on and the alternate is not yet twice as bad as the best: both together, at and either side of each limit, and never from nothing', () => {
  assert.equal(isAmbiguousView(1.9, 24), true)
  assert.equal(isAmbiguousView(1.01, 0), true)
  assert.equal(isAmbiguousView(2, 24), false, 'a ratio of exactly 2 is decisive enough')
  assert.equal(isAmbiguousView(1.9, 25), false, 'a view angle of exactly 25 degrees is not near face-on')
  assert.equal(isAmbiguousView(1.5, 40), false, 'tilted: the ratio alone does not make it a view to leave')
  assert.equal(isAmbiguousView(6, 10), false, 'face-on but decisive')
  assert.equal(isAmbiguousView(null, 10), false)
  assert.equal(isAmbiguousView(1.2, null), false)
  assert.equal(isAmbiguousView(null, null), false)
})

test('without enough camera travel the unit cannot be worked out, and the session says so and goes on asking for movement', () => {
  const k = 1.6
  const tag = { ...WALL, position: { x: WALL.position.x * k, y: WALL.position.y * k, z: WALL.position.z * k } }
  // 6 degrees of arc at 2 m is 0.2 m of travel: under the 0.3 m a scale needs, and under the 15 degrees of turning the motion gate allows instead.
  const w = walk({ tag, range: 2, frames: 40, arcDeg: 6, centreDeg: 35, cornerNoise: 0.1, seed: 3, dtMs: 400, scale: k })
  const session = new TagSession(config({ scaleKind: 'arbitrary' }))
  const state = play(session, frameInputs(w, 7, FAMILY))
  assert.equal(state.phase, 'collecting')
  assert.equal(state.result, null)
  assert.deepEqual(state.hint, { code: 'move-for-scale', purpose: 'unit' })
  const f = session.finish()
  assert.equal(f.status, 'failed')
  assert.equal((f as { reason: string }).reason, 'needs-scale')
})

test('without enough movement at all the session asks for a sweep; on a metric runtime a little travel is enough for a pose, but the session waits for enough to check the print rather than finish unchecked', () => {
  const still = new TagSession(config())
  const w = goodWalk({ arcDeg: 4, frames: 40 })
  const stillState = play(still, frameInputs(w, 7, FAMILY))
  assert.equal(stillState.phase, 'collecting')
  assert.equal(stillState.result, null)
  assert.deepEqual(stillState.hint, { code: 'sweep', mount: null })
  assert.equal((still.finish() as { reason: string }).reason, 'needs-motion')
  // 8 degrees of arc at 2 m is 0.28 m of travel: it clears the 0.2 m gate and not the 0.3 m the print's scale needs. A session that finished here could never be
  // told to move 0.1 m more (it ignores frames once done), so it asks, and says what for.
  const some = new TagSession(config({ expected: { family: FAMILY, tagId: 7 } }))
  const s = play(some, frameInputs(goodWalk({ arcDeg: 8, frames: 40 }), 7, FAMILY))
  assert.equal(s.phase, 'collecting')
  assert.equal(s.result, null)
  assert.deepEqual(s.hint, { code: 'move-for-scale', purpose: 'print-check' })
  assert.ok(s.progress < 1, 'nothing reads as finished while the read is waiting for the check')
  // finish() takes the read as it is: provisional, with the check named as not done.
  const taken = some.finish()
  assert.equal(taken.status, 'ok')
  const r = taken as Extract<typeof taken, { status: 'ok' }>
  assert.equal(r.evidence.scaleOffFraction, null)
  assert.equal(r.evidence.scaleBaselineM, null)
  assert.deepEqual(r.verdict.reasons, ['scale-unchecked'])
  assert.equal(r.verdict.status, 'provisional')
})

test('when the time is up a metric read that is complete except for the print check is kept, provisional and saying so, instead of timed out', () => {
  // 40 frames 400 ms apart cover 15.6 s; the camera travels 0.28 m in all, never the 0.3 m the check needs, and by 15 s it has gone 0.27 m, over the 0.2 m the pose needs.
  const walkIt = goodWalk({ arcDeg: 8, frames: 40 })
  const early = new TagSession(config({ expected: { family: FAMILY, tagId: 7 }, fallbackAfterMs: 15_000 }))
  const states: TagSessionState[] = []
  for (const f of frameInputs(walkIt, 7, FAMILY)) states.push(early.offer(f))
  const at = states.findIndex((st) => st.phase === 'done')
  assert.ok(at >= 0, 'the read is delivered')
  assert.equal(states[at]!.counts.framesOffered, 39, 'at the first frame 15 s after the first')
  assert.equal(states.slice(0, at).every((st) => st.phase === 'collecting' && st.result === null), true, 'collecting until then')
  const r = states[at]!.result!
  assert.deepEqual(r.verdict, { status: 'provisional', reasons: ['scale-unchecked'], quality: 'good' })
  assert.equal(states[at]!.progress, 1)
  assert.equal(states[at]!.hint, null)
  // A session that never read the tag well enough has nothing to keep: it times out, as it did.
  const none = new TagSession(config({ expected: { family: FAMILY, tagId: 7 }, fallbackAfterMs: 8000 }))
  const blank = (t: number): TagFrameInput => ({ timestampMs: t, detections: [], intrinsics: INTRINSICS_640, cameraPose: WALL, angularSpeedDegPerS: 1, epoch: 0 })
  assert.equal(none.offer(blank(0)).phase, 'searching')
  assert.equal(none.offer(blank(8000)).phase, 'timed-out')
  // Nor does one that read the tag but did not move enough for a pose at all (here half the arc): the time up is not a reason to take a read that fails its own gates.
  const stalled = new TagSession(config({ expected: { family: FAMILY, tagId: 7 }, fallbackAfterMs: 8000 }))
  assert.equal(play(stalled, frameInputs(walkIt, 7, FAMILY)).phase, 'timed-out')
  // A registered marker that was not confirmed (read in 4 of the last 8 frames) is not delivered at the end of the time either: the gates on the frames themselves hold then as at any other moment.
  const unconfirmed = new TagSession(config({ expected: { family: FAMILY, tagId: 7 }, fallbackAfterMs: 15_000 }))
  const flicker = play(unconfirmed, frameInputs(walkIt, 7, FAMILY, (i) => (i % 2 === 1 ? { detection: null } : {})))
  assert.equal(flicker.phase, 'timed-out', `${flicker.phase}`)
  assert.equal(flicker.result, null)
  assert.ok(flicker.counts.accepted >= 12, 'the frames were enough: it is the identity that was not')
  // On a runtime whose unit is not the metre a read without a scale is no read at all: with too little travel to work the unit out it times out.
  const k = 1.6
  const tag = { ...WALL, position: { x: WALL.position.x * k, y: WALL.position.y * k, z: WALL.position.z * k } }
  const short = walk({ tag, range: 2, frames: 40, arcDeg: 6, centreDeg: 35, cornerNoise: 0.1, seed: 3, dtMs: 400, scale: k })
  const arbitrary = new TagSession(config({ scaleKind: 'arbitrary', fallbackAfterMs: 8000 }))
  const a = play(arbitrary, frameInputs(short, 7, FAMILY))
  assert.equal(a.phase, 'timed-out')
  assert.equal(a.result, null)
})

test('an ordinary sweep at the feed\'s 8 Hz on a metric runtime checks the print: a 100 % print is verified, 95 % and 105 % are flagged (they were not, with the session done at 0.2 m)', () => {
  // 0.15 m/s past a tag 2 m away: 0.019 m a frame at 8 Hz (4 degrees a second, inside the 10 the gate allows). Twelve frames and a second are there at
  // 0.2 m, and the 0.3 m the check needs is there four frames later.
  const run = (printScale: number) => {
    const session = new TagSession(config({ expected: { family: FAMILY, tagId: 7 } }))
    const states: TagSessionState[] = []
    for (const f of frameInputs(goodWalk({ dtMs: 125, frames: 40, arcDeg: 21, printScale }), 7, FAMILY)) states.push(session.offer(f))
    const at = states.findIndex((st) => st.phase === 'done')
    assert.ok(at >= 0, `print ${printScale}: read`)
    return { states, at, result: states[at]!.result! }
  }
  const exact = run(1)
  assert.equal(exact.result.verdict.status, 'verified', exact.result.verdict.reasons.join(', '))
  assert.ok(exact.result.evidence.cameraTravelM >= MIN_SCALE_BASELINE_M, `${exact.result.evidence.cameraTravelM} m`)
  assert.ok(exact.result.evidence.scaleBaselineM !== null && exact.result.evidence.scaleBaselineM >= MIN_SCALE_BASELINE_M)
  assert.ok(exact.result.evidence.scaleResidualM !== null && exact.result.evidence.scaleResidualM < 0.01, `${exact.result.evidence.scaleResidualM}`)
  // The twelfth frame and the first second were there before the check could be made, and the session said what it was waiting for.
  const asked = exact.states.slice(0, exact.at).filter((st) => st.hint?.code === 'move-for-scale')
  assert.ok(asked.length >= 1, 'it asked for movement while it waited')
  assert.deepEqual(asked[0]!.hint, { code: 'move-for-scale', purpose: 'print-check' })
  assert.ok(asked.every((st) => st.progress < 1))
  for (const printScale of [0.95, 1.05]) {
    const r = run(printScale).result
    assert.deepEqual(r.verdict.reasons, ['scale-mismatch'], `print ${printScale}`)
    assert.ok(near(Math.abs(r.evidence.scaleOffFraction!), 0.05, 0.008), `${printScale}: ${r.evidence.scaleOffFraction}`)
  }
})

test('a print at the wrong scale is flagged on a metric runtime beyond 3 %, and invisible to the detector; 2 % is not flagged', () => {
  const run = (printScale: number) => {
    const session = new TagSession(config({ expected: { family: FAMILY, tagId: 7 } }))
    const state = play(session, frameInputs(goodWalk({ printScale }), 7, FAMILY))
    assert.equal(state.phase, 'done', `print ${printScale}`)
    return state.result!
  }
  const exact = run(1)
  const small = run(0.95)
  const large = run(1.05)
  assert.equal(exact.verdict.status, 'verified')
  // A print 5 % small makes the tag look 5 % farther than it is, so the unit comes out 5 % short of a metre; 5 % large, 5 % over.
  assert.ok(near(small.evidence.scaleOffFraction!, -0.048, 0.008), `95 %: ${small.evidence.scaleOffFraction}`)
  assert.ok(near(large.evidence.scaleOffFraction!, 0.0526, 0.008), `105 %: ${large.evidence.scaleOffFraction}`)
  assert.deepEqual(small.verdict.reasons, ['scale-mismatch'])
  assert.deepEqual(large.verdict.reasons, ['scale-mismatch'])
  assert.equal(small.verdict.status, 'provisional')
  // What it was a flag on: the corners fit every one of them equally well. Nothing in the detection shows a uniform scale error.
  for (const r of [small, large]) assert.ok(Math.abs(r.evidence.reprojectionRmsPx - exact.evidence.reprojectionRmsPx) < 0.05, `reprojection ${r.evidence.reprojectionRmsPx} against ${exact.evidence.reprojectionRmsPx}`)
  // A print 2 % off is inside the gate.
  for (const s of [0.98, 1.02]) assert.equal(run(s).verdict.status, 'verified', `print ${s}`)
  // On a runtime whose unit came from the print the same print is accepted silently: that is the limit of the method, and the copy says the size was not checked.
  const arbitrary = new TagSession(config({ scaleKind: 'arbitrary', expected: { family: FAMILY, tagId: 7 } }))
  const a = play(arbitrary, frameInputs(goodWalk({ printScale: 0.95 }), 7, FAMILY))
  assert.equal(a.result!.verdict.status, 'verified')
  assert.equal(a.result!.evidence.scaleOffFraction, null)
})

test('a focal length 2 % off is a range 2 % off, and is not flagged; 4 % is', () => {
  const run = (focalError: number) => {
    const session = new TagSession(config({ expected: { family: FAMILY, tagId: 7 } }))
    const state = play(session, frameInputs(goodWalk({ focalError }), 7, FAMILY))
    assert.equal(state.phase, 'done', `focal ${focalError}`)
    return state.result!
  }
  const base = run(1)
  for (const factor of [1.02, 0.98]) {
    const r = run(factor)
    // The tag is drawn through a lens `factor` longer than the intrinsics claim: its range is read `factor` too short.
    assert.ok(near(r.evidence.rangeM / base.evidence.rangeM, 1 / factor, 0.004), `focal x${factor}: range ratio ${r.evidence.rangeM / base.evidence.rangeM}`)
    assert.ok(near(r.evidence.scaleOffFraction!, factor - 1, 0.006), `focal x${factor}: off ${r.evidence.scaleOffFraction}`)
    assert.equal(r.verdict.status, 'verified')
  }
  assert.deepEqual(run(1.04).verdict.reasons, ['scale-mismatch'])
  assert.deepEqual(run(0.96).verdict.reasons, ['scale-mismatch'])
})

test('the detection quad is the printed size times the family\'s fraction: a family whose quad is 0.8 of its printed edge reads the same range', () => {
  // The quad is 0.16 m across: the same size in pixels as a 0.2 m tag at 2 m is at 1.6 m.
  const w = goodWalk({ sizeM: 0.16, range: 1.6 })
  const session = new TagSession(config({ quadFraction: 0.8, printedSizeMm: 200 }))
  const state = play(session, frameInputs(w, 7, FAMILY))
  assert.equal(state.phase, 'done')
  assert.ok(near(state.result!.evidence.rangeM, 1.6, 0.03))
  assert.equal(state.result!.evidence.printedSizeMm, 200, 'the evidence keeps what is printed')
})

// ===============================================================================================
// Ambiguity, mounts and the floor
// ===============================================================================================

test('a tag seen nearly face-on is two tilts one frame cannot tell apart: a camera that moves resolves them, one that does not is never silently wrong', () => {
  const face = fixedTag(8, 0, { x: 0, y: 1.3, z: -3 })
  let resolved = 0
  let neverWrong = 0
  for (const seed of [1, 2, 3, 4]) {
    const moving = new TagSession(config())
    const m = play(moving, frameInputs(walk({ tag: face, range: 1.8, frames: 40, arcDeg: 70, cornerNoise: 0.25, seed, dtMs: 400 }), 7, FAMILY))
    if (m.phase === 'done') {
      const R = matrixFromQuat(m.result!.fused.pose!.rotation)
      const T = matrixFromQuat(face.rotation)
      const dot = R[2]! * T[2]! + R[5]! * T[5]! + R[8]! * T[8]!
      if ((Math.acos(Math.min(1, dot)) * 180) / Math.PI < 3) resolved++
    }
    const still = new TagSession(config())
    const s = play(still, frameInputs(walk({ tag: face, range: 1.8, frames: 40, arcDeg: 0, cornerNoise: 0.25, seed, dtMs: 400 }), 7, FAMILY))
    // A camera that never moves has not earned a pose: whatever the frames say, no result is offered.
    assert.notEqual(s.phase, 'done', `seed ${seed}: a static camera produced a result`)
    assert.equal(s.result, null)
    neverWrong++
  }
  assert.equal(neverWrong, 4)
  assert.equal(resolved, 4, `camera motion resolved ${resolved} of 4`)
})

test('a tilted mount ends the read with the reason, and so does a mount the sheet contradicts; a flat tag read from above is a horizontal mount', () => {
  const tilted = new TagSession(config())
  const t = play(tilted, frameInputs(walk({ tag: fixedTag(20, 40), range: 2, frames: 40, arcDeg: 36, centreDeg: 35, cornerNoise: 0.1, seed: 3, dtMs: 400 }), 7, FAMILY))
  assert.equal(t.phase, 'failed')
  assert.equal(t.failure!.reason, 'tilted')
  assert.equal(t.hint!.code, 'tilted')
  const before = t.counts.framesOffered
  assert.equal(tilted.offer(frameInputs(goodWalk(), 7, FAMILY)[3]!).counts.framesOffered, before, 'sticky')

  const contradicted = new TagSession(config({ mount: 'horizontal' }))
  const c = play(contradicted, frameInputs(goodWalk(), 7, FAMILY))
  assert.equal(c.phase, 'failed')
  assert.equal(c.failure!.reason, 'mount-mismatch')
  assert.deepEqual(c.hint, { code: 'mount-mismatch', expected: 'horizontal' })

  // A plaque lying on a table, seen from above and to the side.
  const flat = flatTag(20, { x: 0.3, y: 0.7, z: -3 })
  const w = walk({ tag: flat, range: 1.6, frames: 24, arcDeg: 36, centreDeg: 35, cornerNoise: 0.1, seed: 3, dtMs: 400, heightM: 1.1 })
  const session = new TagSession(config({ mount: 'horizontal', floor: () => ({ floorY: null, mountHeightM: 0.7 }) }))
  const state = play(session, frameInputs(w, 7, FAMILY))
  assert.equal(state.phase, 'done')
  assert.equal(state.result!.evidence.mount, 'horizontal')
  assert.ok(near(state.result!.frame.tagHeightM, 0.7, 1e-9))
})

test('the floor is read when the frame is built: a floor fitted while the session runs is used, and a mount height alone is flagged', () => {
  let floor: { floorY: number | null; mountHeightM: number | null } = { floorY: null, mountHeightM: null }
  const session = new TagSession(config({ floor: () => floor }))
  const inputs = frameInputs(goodWalk({ frames: 40 }), 7, FAMILY)
  const waiting = play(session, inputs.slice(0, 20))
  assert.equal(waiting.phase, 'collecting')
  assert.equal(waiting.result, null)
  assert.deepEqual(waiting.hint, { code: 'need-floor' })
  assert.equal((session.finish() as { reason: string }).reason, 'no-floor')
  // A floor fitted now, 0.1 m below the origin of the session.
  floor = { floorY: 0.1, mountHeightM: null }
  const states = inputs.slice(20).map((f) => session.offer(f))
  const done = states.find((s) => s.phase === 'done')!
  assert.ok(done, 'the frame is built from the next attempt')
  assert.equal(done.result!.frame.floorSource, 'datum')
  assert.deepEqual(done.result!.flags, [])
  assert.ok(near(done.result!.frame.tagHeightM, WALL.position.y - 0.1, 0.01), `${done.result!.frame.tagHeightM}`)
  // A floor above the tag, or far below it, is not a floor for this tag: the read ends.
  const bad = new TagSession(config({ floor: () => ({ floorY: 5, mountHeightM: null }) }))
  const b = play(bad, inputs)
  assert.equal(b.phase, 'failed')
  assert.equal(b.failure!.reason, 'bad-height')
  assert.deepEqual(b.hint, { code: 'bad-height' })
  // No way to know the floor at all: the session never ends in a frame it cannot place.
  const nowhere = new TagSession({ ...config(), floor: undefined })
  assert.equal(play(nowhere, inputs).result, null)
})

test('readings that still disagree are named with the spread that is over its gate, and only that one, and the read goes on', () => {
  const noisy = new TagSession(config())
  // 0.7 px of corner noise: every frame fits its corners (the 0.8 px per-frame gate is not what refuses them), and the frames disagree by about 1.7 cm and 2.3 degrees, which the spread gates refuse.
  const state = play(noisy, frameInputs(goodWalk({ cornerNoise: 0.7, frames: 40, seed: 9 }), 7, FAMILY))
  assert.notEqual(state.phase, 'done')
  assert.equal(state.result, null)
  assert.ok(state.progress <= 0.99, 'a read that is refused is not finished, whatever share of the gates the frames meet')
  assert.equal(state.hint?.code, 'spread')
  const h = state.hint as Extract<NonNullable<TagSessionState['hint']>, { code: 'spread' }>
  const g = DEFAULT_FIDUCIAL_GATES
  const named = [h.poseSpreadM, h.headingSpreadDeg, h.rotationSpreadDeg].filter((x) => x !== null)
  assert.ok(named.length >= 1, `${JSON.stringify(h)}`)
  if (h.poseSpreadM !== null) assert.ok(h.poseSpreadM > g.maxPoseSpreadM)
  if (h.headingSpreadDeg !== null) assert.ok(h.headingSpreadDeg > g.maxHeadingSpreadDeg)
  if (h.rotationSpreadDeg !== null) assert.ok(h.rotationSpreadDeg > g.maxRotationSpreadDeg)
})

test('the spread gate judges the HEADING, the one angle the frame takes from the tag; the whole orientation has its own, wider limit: a flat tag whose tilt scatters over a degree and whose heading scatters under it is read', () => {
  // A flat tag on a table, the camera 0.9 m above it and 1.5 m out, 0.6 px of corner noise: the frames' tilt disagrees by about 1.4 degrees, their heading by about 0.6.
  const w = walk({ tag: flatTag(30), range: 1.5, frames: 16, arcDeg: 30, cornerNoise: 0.6, seed: 2, dtMs: 250, heightM: 0.9 })
  const session = new TagSession(config({ mount: 'horizontal' }))
  const state = play(session, frameInputs(w, 7, FAMILY))
  assert.equal(state.phase, 'done', `${state.phase} ${JSON.stringify(state.hint)}`)
  const e = state.result!.evidence
  assert.equal(e.mount, 'horizontal')
  assert.ok(e.rotationSpreadDeg > 1 && e.rotationSpreadDeg <= DEFAULT_FIDUCIAL_GATES.maxRotationSpreadDeg, `whole orientation ${e.rotationSpreadDeg} degrees: over the 1 degree the heading gate is, inside its own`)
  assert.ok(e.headingSpreadDeg < 1, `heading ${e.headingSpreadDeg} degrees`)
  assert.ok(e.headingSpreadDeg < e.rotationSpreadDeg / 1.5, 'a flat tag fixes its heading far better than its tilt')
  assert.deepEqual(state.result!.verdict.reasons, ['first-calibration'])
  // The same frames judged by a gate of 1 degree on the whole orientation are refused, and the text names that figure and not the heading, which is fine.
  const strict = new TagSession(config({ mount: 'horizontal' }), { ...DEFAULT_FIDUCIAL_GATES, maxRotationSpreadDeg: 1 })
  const refused = play(strict, frameInputs(w, 7, FAMILY))
  assert.equal(refused.phase, 'collecting')
  const h = refused.hint as Extract<NonNullable<TagSessionState['hint']>, { code: 'spread' }>
  assert.equal(h.code, 'spread')
  assert.equal(h.poseSpreadM, null)
  assert.equal(h.headingSpreadDeg, null)
  assert.ok(h.rotationSpreadDeg !== null && h.rotationSpreadDeg > 1)
})

test('a wall tag whose frames disagree about the heading by more than a degree is refused on the heading, and the hint says that figure and no other', () => {
  // 0.5 px of corner noise at 1.5 m and 35 degrees: the whole orientation scatters 1.9 degrees (inside its limit), the position 0.7 cm, and the heading 1.6.
  const session = new TagSession(config())
  const state = play(session, frameInputs(goodWalk({ range: 1.5, cornerNoise: 0.5, seed: 1 }), 7, FAMILY))
  assert.equal(state.phase, 'collecting')
  assert.ok(state.progress <= 0.99)
  const h = state.hint as Extract<NonNullable<TagSessionState['hint']>, { code: 'spread' }>
  assert.equal(h.code, 'spread')
  assert.equal(h.poseSpreadM, null)
  assert.equal(h.rotationSpreadDeg, null)
  assert.ok(h.headingSpreadDeg !== null && h.headingSpreadDeg > 1 && h.headingSpreadDeg < 3, `${h.headingSpreadDeg}`)
  // With the heading gate lifted the same frames are read, so it is that gate and no other that refused them.
  const lifted = new TagSession(config(), { ...DEFAULT_FIDUCIAL_GATES, maxHeadingSpreadDeg: 3 })
  const read = play(lifted, frameInputs(goodWalk({ range: 1.5, cornerNoise: 0.5, seed: 1 }), 7, FAMILY))
  assert.equal(read.phase, 'done')
  assert.deepEqual(read.result!.verdict.reasons, ['first-calibration'])
  assert.ok(read.result!.evidence.headingSpreadDeg > 1)
  // Judged again against the default gates, the stored evidence names the heading.
  assert.deepEqual(fiducialVerdict(read.result!.evidence).reasons, ['first-calibration', 'heading-spread'])
})

type Hint = NonNullable<TagSessionState['hint']>

test('a frame the fusion would drop is not counted as read, and the hint says why (a tag seen at a steep angle was "12 frames, 24, 36 of 12" and then wall-tag advice)', () => {
  // A 300 mm sheet flat on a table, a phone 1.9 m out and 0.55 m above it: the tag is seen 74 degrees off its face, over the 70 the fusion uses.
  const steep = walk({ tag: flatTag(30), sizeM: 0.3, range: 1.9, heightM: 0.55, frames: 40, arcDeg: 20, dtMs: 250, cornerNoise: 0.1, seed: 4 })
  const session = new TagSession(config({ printedSizeMm: 300 }))
  const state = play(session, frameInputs(steep, 7, FAMILY))
  assert.equal(state.phase, 'collecting')
  assert.equal(state.counts.accepted, 0, 'nothing is counted that the fusion drops')
  assert.ok(state.counts.viewAngle >= 30, `${state.counts.viewAngle} frames refused for the view angle`)
  const h = state.hint as Extract<Hint, { code: 'steep-view' }>
  assert.equal(h.code, 'steep-view')
  assert.ok(h.viewAngleDeg > 70 && h.viewAngleDeg < 80, `${h.viewAngleDeg}`)
  assert.equal(h.limitDeg, DEFAULT_FIDUCIAL_GATES.maxViewAngleDeg)

  // The size entered a tenth of what was printed: the tag reads 0.2 m away, nearer than the 0.3 m the fusion reads.
  const near = new TagSession(config({ printedSizeMm: 20 }))
  const n = play(near, frameInputs(goodWalk(), 7, FAMILY))
  assert.equal(n.counts.accepted, 0)
  assert.ok(n.counts.range >= 20)
  const hn = n.hint as Extract<Hint, { code: 'range' }>
  assert.equal(hn.code, 'range')
  assert.ok(near_(hn.rangeM, 0.2, 0.02), `${hn.rangeM} m`)
  assert.equal(hn.minM, DEFAULT_FIDUCIAL_GATES.minRangeM)
  // ...and ten times too large: it reads 20 m away.
  const far = new TagSession(config({ printedSizeMm: 2000 }))
  const f = play(far, frameInputs(goodWalk(), 7, FAMILY))
  assert.equal(f.counts.accepted, 0)
  const hf = f.hint as Extract<Hint, { code: 'range' }>
  assert.equal(hf.code, 'range')
  assert.ok(hf.rangeM > hf.maxM, `${hf.rangeM} m`)

  // Corners that do not fit a square to 0.8 px (3 px of noise): the fusion drops each such frame, so the session does not count it, and says the fit is poor.
  const loose = new TagSession(config())
  const seen: Hint[] = []
  for (const f of frameInputs(goodWalk({ cornerNoise: 3, frames: 40 }), 7, FAMILY)) {
    const st = loose.offer(f)
    if (st.hint) seen.push(st.hint)
  }
  const l = loose.state()
  assert.ok(l.counts.reprojection >= 20, `${l.counts.reprojection}`)
  assert.ok(l.counts.accepted < DEFAULT_FIDUCIAL_GATES.minFrames, `${l.counts.accepted} counted of 40`)
  assert.equal(l.result, null)
  const poor = seen.filter((h): h is Extract<Hint, { code: 'poor-fit' }> => h.code === 'poor-fit')
  assert.ok(poor.length >= 20)
  assert.ok(poor.every((h) => h.rmsPx > h.limitPx && h.limitPx === DEFAULT_FIDUCIAL_GATES.maxReprojectionRmsPx))

  // Corners fitted to 1.5 px scatter (the fit is not an edge), though marked refined: the fusion refuses them (cornersUsable), so the session does not count them.
  const smeared = new TagSession(config())
  const sm = play(smeared, frameInputs(goodWalk(), 7, FAMILY, () => ({ detection: { edgeRmsPx: 1.5 } })))
  assert.equal(sm.counts.accepted, 0)
  assert.equal(sm.counts.cornerFit, 24)
  assert.equal(sm.hint?.code, 'keep-uncovered')
  const faint = new TagSession(config())
  assert.equal(play(faint, frameInputs(goodWalk(), 7, FAMILY, () => ({ detection: { edgeInlierFraction: 0.5 } }))).counts.accepted, 0)
})

function near_(a: number, b: number, eps: number): boolean {
  return Math.abs(a - b) <= eps
}

test('frames the session counts are the frames the fusion keeps, so the count is never past what is needed while the read waits: it says "12 of 12", not "36 of 12"', () => {
  // The registered tag read in every other frame: the identity window (5 of the last 8) is never met, so nothing is fused, and frames pile up.
  const session = new TagSession(config({ expected: { family: FAMILY, tagId: 7 } }))
  const w = goodWalk({ frames: 60, arcDeg: 36 })
  const hints: Hint[] = []
  for (const f of frameInputs(w, 7, FAMILY, (i) => (i % 2 === 1 ? { detection: null } : {}))) {
    const st = session.offer(f)
    if (st.hint) hints.push(st.hint)
  }
  const reading = hints.filter((h): h is Extract<Hint, { code: 'reading' }> => h.code === 'reading')
  assert.ok(reading.length > 20)
  assert.ok(reading.every((h) => h.accepted <= h.needed), 'never more frames than are needed')
  assert.ok(reading.some((h) => h.accepted === h.needed), 'and it reaches the number needed')
})

test('a flat marker is not given the advice a wall marker needs: a sweep from 40 degrees to one side is for the wall', () => {
  const still = new TagSession(config({ mount: 'horizontal' }))
  const s = play(still, frameInputs(goodWalk({ arcDeg: 4, frames: 40 }), 7, FAMILY))
  assert.deepEqual(s.hint, { code: 'sweep', mount: 'horizontal' })
  const wall = new TagSession(config({ mount: 'wall' }))
  assert.deepEqual(play(wall, frameInputs(goodWalk({ arcDeg: 4, frames: 40 }), 7, FAMILY)).hint, { code: 'sweep', mount: 'wall' })
  // Before any attempt has failed (a registered marker read in every other frame is never confirmed, so nothing is fused) the same advice comes from the plain state of the read.
  const waiting = new TagSession(config({ mount: 'horizontal', expected: { family: FAMILY, tagId: 7 } }))
  const w = play(waiting, frameInputs(goodWalk({ arcDeg: 4, frames: 39 }), 7, FAMILY, (i) => (i % 2 === 1 ? { detection: null } : {})))
  assert.deepEqual(w.hint, { code: 'sweep', mount: 'horizontal' })
})

test('the limits a hint quotes are the session\'s own gates: a session given other limits says those', () => {
  const gates: FiducialGates = { ...DEFAULT_FIDUCIAL_GATES, maxViewAngleDeg: 60, minRangeM: 0.5, maxRangeM: 8, maxReprojectionRmsPx: 0.4, minPoseSidePx: 30 }
  const steep = walk({ tag: flatTag(30), sizeM: 0.3, range: 1.9, heightM: 0.55, frames: 12, arcDeg: 20, dtMs: 250, cornerNoise: 0.1, seed: 4 })
  const s = new TagSession(config({ printedSizeMm: 300 }), gates)
  assert.deepEqual({ ...(play(s, frameInputs(steep, 7, FAMILY)).hint as Extract<Hint, { code: 'steep-view' }>), viewAngleDeg: 0 }, { code: 'steep-view', viewAngleDeg: 0, limitDeg: 60 })
  const far = new TagSession(config({ printedSizeMm: 2000 }), gates)
  const hf = play(far, frameInputs(goodWalk(), 7, FAMILY)).hint as Extract<Hint, { code: 'range' }>
  assert.equal(hf.code, 'range')
  assert.deepEqual([hf.minM, hf.maxM], [0.5, 8])
  const loose = new TagSession(config(), gates)
  const seen: Hint[] = []
  for (const f of frameInputs(goodWalk({ cornerNoise: 3, frames: 40 }), 7, FAMILY)) {
    const st = loose.offer(f)
    if (st.hint) seen.push(st.hint)
  }
  const poor = seen.find((h): h is Extract<Hint, { code: 'poor-fit' }> => h.code === 'poor-fit')
  assert.ok(poor)
  assert.equal(poor.limitPx, 0.4)
  // The size a frame must be to count is the session's: a frame about 35 px across counts under a gate of 30, and is too small under the default 40.
  const small = frameInputs(goodWalk({ range: 2.8 }), 7, FAMILY)[3]!
  assert.equal(new TagSession(config(), gates).offer(small).counts.tooSmall, 0)
  assert.equal(new TagSession(config()).offer(small).counts.tooSmall, 1)
})

test('progress is 1 only with the result: a read waiting on the identity window, refused, or held for the scale check is under it', () => {
  const identity = new TagSession(config({ expected: { family: FAMILY, tagId: 7 } }))
  for (const f of frameInputs(goodWalk({ frames: 60 }), 7, FAMILY, (i) => (i % 2 === 1 ? { detection: null } : {}))) assert.ok(identity.offer(f).progress <= 0.99)
  assert.equal(identity.state().result, null)
  const held = new TagSession(config({ expected: { family: FAMILY, tagId: 7 } }))
  for (const f of frameInputs(goodWalk({ arcDeg: 8, frames: 40 }), 7, FAMILY)) assert.ok(held.offer(f).progress <= 0.99)
})

test('finish() says why a read cannot be made yet and changes nothing: too few frames, then none', () => {
  const session = new TagSession(config())
  const none = session.finish()
  assert.equal(none.status, 'failed')
  assert.equal((none as { reason: string }).reason, 'no-observations')
  const inputs = frameInputs(goodWalk(), 7, FAMILY)
  play(session, inputs.slice(0, 6))
  const before = JSON.stringify(session.state())
  const few = session.finish()
  assert.equal(few.status, 'failed')
  assert.equal((few as { reason: string }).reason, 'too-few-frames')
  assert.equal(JSON.stringify(session.state()), before)
  assert.equal(session.finish().status, 'failed')
  // Once the gates on the frames are met it gives the same result the session reaches on its own.
  const later = new TagSession(config())
  play(later, inputs.slice(0, 13))
  assert.equal(later.state().phase, 'done')
  assert.equal(later.finish().status, 'ok')
})

test('a session is refused a configuration that cannot mean anything', () => {
  assert.throws(() => new TagSession(config({ printedSizeMm: 0 })), /printed size 0 mm/)
  assert.throws(() => new TagSession(config({ printedSizeMm: Number.NaN })), /printed size/)
  assert.throws(() => new TagSession(config({ quadFraction: 1.2 })), /quad fraction 1.2/)
  assert.throws(() => new TagSession(config({ quadFraction: 0 })), /quad fraction 0/)
  assert.throws(() => new TagSession(config({ expected: { family: 'cscan-5x5-v1', tagId: 3 } })), /registered marker is in family cscan-5x5-v1/)
})
