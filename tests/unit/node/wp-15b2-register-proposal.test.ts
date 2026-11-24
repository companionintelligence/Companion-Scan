/**
 * What the editor and the server may do with a photo-method proposal (WP-15b slice 2): reading it back out of a job, the patch Apply
 * writes for each method, which method a job has been applied by, how far apart two methods' answers are, and what every sentence
 * may claim.
 *
 * src/world/register-proposal.ts holds all of it with no DOM and no THREE, so the rules run here for real. The card that draws them
 * is wp-15b2-register-card.test.ts. The wall match's own rules, which this file leaves alone, are wp-15a-register-proposal.test.ts.
 *
 * Run: node --experimental-strip-types --no-warnings --test tests/unit/node/wp-15b2-*.test.ts
 * `npm run verify` reaches it through `npm run test:wave`, which runs every wp-*.test.ts here: the name is what wires it in.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import type { EditPatch, ScanManifest, WorldJob } from '../../../src/world/types.ts'
import {
  agreementOf,
  applyRegistrationProposal,
  buildRegisterPatch,
  compareCorrections,
  describeAgreement,
  describeSfmResult,
  matrixYawDeg,
  METHOD_AGREEMENT_BOUND,
  matrixScale,
  methodProposal,
  multiplyMat4,
  NOT_CHECKED_SCOPE_TEXT,
  NOT_CHECKED_TEXT,
  notCheckedText,
  PLACE_REGISTER_PROPOSAL_ARTIFACT,
  type PlaceRegisterResult,
  proposedMethods,
  readPlaceRegisterResult,
  registerApplyState,
  requestsPhotoMethod,
  type RegistrationProposal,
  type SfmRefusal,
  type SfmResult,
  type SfmSkipReason,
  sfmReasonText,
} from '../../../src/world/register-proposal.ts'

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
const yawTranslation = (yaw: number, tx: number, ty: number, tz: number, size = 1): number[] => {
  const c = Math.cos(yaw) * size
  const s = Math.sin(yaw) * size
  return [c, 0, -s, 0, 0, size, 0, 0, s, 0, c, 0, tx, ty, tz, 1]
}

const MOVING_PLACEMENT = yawTranslation(0.4, 12, 0.02, -3)
const WALL_CORRECTION = yawTranslation(-0.02, 0.18, 0.01, -0.07)
const PHOTO_CORRECTION = yawTranslation(-0.025, 0.2, 0.01, -0.06)

function walls(overrides: Partial<RegistrationProposal> = {}): RegistrationProposal {
  return {
    status: 'proposed',
    transform: WALL_CORRECTION,
    overlapFraction: 0.91,
    inlierResidualM: 0.031,
    score: 0.86,
    boundedCorrection: { translationM: 0.19, yawDeg: -1.1, dyM: 0.004, maxShiftM: 0.34, withinBound: true, bound: { translationM: 1, yawDeg: 10, dyM: 0.3 } },
    reason: null,
    details: {
      movingCells: 800, referenceCells: 900, movingMatchedFraction: 0.91, referenceMatchedFraction: 0.8, distinctiveness: 0.95, fit: 0.9,
      peakRatio: 0.2, nearBestReachM: 0.4, verticalChecked: true, searchedTranslationM: 2, searchedYawDeg: 25,
    },
    ...overrides,
  }
}

function photos(overrides: Partial<SfmResult> = {}): SfmResult {
  return {
    status: 'proposed',
    reason: null,
    detail: '',
    reference: { scanId: 'scan-c', filename: '050_c.glb', name: 'Earlier visit', localToWorld: IDENTITY },
    transform: PHOTO_CORRECTION,
    boundedCorrection: { translationM: 0.21, yawDeg: -1.4, dyM: 0.01, maxShiftM: 0.4, withinBound: true, bound: { translationM: 1, yawDeg: 10, dyM: 0.3 } },
    residualM: 0.028,
    registeredFraction: 0.93,
    registeredImages: 13,
    offeredImages: 14,
    inliers: 12,
    scaleRatio: 1.003,
    tiltDeg: 0.7,
    sessions: [],
    referenceModel: 'built',
    frameId: 'frame-aaa',
    params: { wallClockMs: 2_700_000 },
    elapsedMs: 41_000,
    ...overrides,
  }
}

/** `sfm` is `null` for a record with no photo block: `undefined` would take the default and make one. */
function makeResult(proposal = walls(), sfm: SfmResult | null = photos(), pivot: [number, number] = [14, -2]): PlaceRegisterResult {
  const result: PlaceRegisterResult = {
    proposal,
    moving: { scanId: 'scan-b', filename: '200_b.glb', name: 'Second visit', localToWorld: MOVING_PLACEMENT },
    reference: { scanId: 'scan-a', filename: '100_a.glb', name: 'First visit', localToWorld: IDENTITY },
    comparisons: [],
    params: {},
    comparedAt: '2026-11-17T10:00:00.000Z',
    elapsedMs: 120,
  }
  if (sfm) result.sfm = sfm
  const agreement = sfm ? agreementOf(proposal.transform, sfm.transform, pivot) : null
  if (agreement) result.agreement = agreement
  return result
}

function jobFor(result: PlaceRegisterResult): WorldJob {
  return {
    jobId: 'job-1',
    worldId: 'world-1',
    type: 'place-register',
    status: 'completed',
    scanId: 'scan-b',
    capabilities: [],
    artifacts: [{ type: PLACE_REGISTER_PROPOSAL_ARTIFACT, label: 'check', metadata: JSON.parse(JSON.stringify(result)) }],
    createdAt: '2026-11-17T10:00:00.000Z',
    updatedAt: '2026-11-17T10:00:01.000Z',
  }
}

const scans = (moving = MOVING_PLACEMENT, wallReference = IDENTITY, photoReference = IDENTITY) =>
  [
    { scanId: 'scan-b', localToWorld: moving },
    { scanId: 'scan-a', localToWorld: wallReference },
    { scanId: 'scan-c', localToWorld: photoReference },
  ] as Array<Pick<ScanManifest, 'scanId' | 'localToWorld'>>

// ── Reading the artifact back ───────────────────────────────────────────────

test('a record from before the photo method reads as it did, with no photo block and nothing to compare', () => {
  const earlier = makeResult(walls(), null)
  const read = readPlaceRegisterResult(jobFor(earlier))!
  assert.equal('sfm' in read, false)
  assert.equal('agreement' in read, false)
  assert.deepEqual(proposedMethods(read), ['scan-match'])
  assert.equal(methodProposal(read, 'sfm'), null, 'no photo method, no photo proposal')
})

test('a photo block and the agreement it carries come back through JSON, and both methods are found', () => {
  const result = makeResult()
  const read = readPlaceRegisterResult(jobFor(result))!
  assert.equal(read.sfm?.status, 'proposed')
  assert.equal(read.sfm?.reference?.scanId, 'scan-c')
  assert.deepEqual(read.sfm?.transform, PHOTO_CORRECTION)
  assert.equal(read.sfm?.registeredFraction, 0.93)
  assert.ok(read.agreement)
  assert.deepEqual(proposedMethods(read), ['scan-match', 'sfm'])
  assert.equal(methodProposal(read, 'sfm')?.score, 0.93, 'the photo method\'s score is the share of photographs that found their place')
  assert.equal(methodProposal(read, 'scan-match')?.score, 0.86)
})

test('a photo block that is not what its status says is left out whole, and the wall match is still read', () => {
  const damaged: Array<[string, Partial<SfmResult>]> = [
    ['proposed with no transform', { transform: null }],
    ['proposed with a short transform', { transform: [1, 0, 0] }],
    ['proposed with no measured residual', { residualM: null }],
    ['proposed with no share of photographs', { registeredFraction: null }],
    ['proposed with no reference scan', { reference: null }],
    ['a refusal that carries a transform', { status: 'refused', reason: 'collinear' }],
    ['a skip that carries a transform', { status: 'skipped', reason: 'off' }],
    ['a status nobody writes', { status: 'maybe' as never }],
  ]
  for (const [label, change] of damaged) {
    const result = makeResult(walls(), photos(change), [0, 0])
    const read = readPlaceRegisterResult(jobFor(result))
    assert.ok(read, label)
    assert.equal(read!.sfm, undefined, `${label}: not offered`)
    assert.equal(read!.proposal.status, 'proposed', `${label}: the wall match is untouched`)
  }
  // A reference that is not a scan reference.
  const noReference = JSON.parse(JSON.stringify(makeResult()))
  noReference.sfm.reference = { scanId: '', filename: 'x', name: 'x', localToWorld: IDENTITY }
  const job = jobFor(makeResult())
  job.artifacts![0]!.metadata = noReference
  assert.equal(readPlaceRegisterResult(job)!.sfm, undefined)
})

test('an agreement is believed only when both methods proposed, and only in the shape it is written', () => {
  const both = makeResult()
  assert.ok(readPlaceRegisterResult(jobFor(both))!.agreement)
  // Written onto a record where the photo method did not propose: not believed.
  const onlyWalls = { ...makeResult(walls(), photos({ status: 'refused', reason: 'collinear', transform: null })), agreement: both.agreement }
  assert.equal(readPlaceRegisterResult(jobFor(onlyWalls))!.agreement, undefined)
  for (const bad of [{ translationM: 'x', yawDeg: 1, withinBound: true, pivot: [0, 0] }, { translationM: 1, yawDeg: 1, withinBound: 'yes', pivot: [0, 0] }, { translationM: 1, yawDeg: 1, withinBound: true, pivot: [0] }]) {
    const record = { ...makeResult(), agreement: bad as never }
    assert.equal(readPlaceRegisterResult(jobFor(record))!.agreement, undefined)
  }
})

test('with no wall comparison and a photo proposal the record still reads and offers only the photo method', () => {
  const result = makeResult(walls({ status: 'refused', transform: null, reason: 'too-few-points', inlierResidualM: null, score: 0, overlapFraction: 0 }), photos())
  const read = readPlaceRegisterResult(jobFor(result))!
  assert.deepEqual(proposedMethods(read), ['sfm'])
  assert.equal(read.agreement, undefined)
})

// ── The patch each method writes ────────────────────────────────────────────

test('the photo method\'s patch is its own correction on top of the scan\'s placement, and says which method wrote it', () => {
  const result = makeResult()
  const body = buildRegisterPatch(result, 'job-1', 'sfm')!
  assert.deepEqual(body.transform.matrix, multiplyMat4(PHOTO_CORRECTION, MOVING_PLACEMENT))
  assert.deepEqual(body.provenance, { source: 'place-register', jobId: 'job-1', score: 0.93, residualM: 0.028, method: 'sfm' })
  assert.equal(body.scanId, 'scan-b')
  assert.equal(body.targetId, '200_b.glb')
})

test('the wall match\'s patch is what it always was: no method in its provenance, its own matrix and its own numbers', () => {
  const result = makeResult()
  const body = buildRegisterPatch(result, 'job-1')!
  assert.deepEqual(body.transform.matrix, multiplyMat4(WALL_CORRECTION, MOVING_PLACEMENT))
  assert.deepEqual(body.provenance, { source: 'place-register', jobId: 'job-1', score: 0.86, residualM: 0.031 })
  assert.equal('method' in body.provenance, false)
  assert.deepEqual(buildRegisterPatch(result, 'job-1', 'scan-match'), body)
})

test('a method that proposed nothing writes no patch, whatever the other proposed', () => {
  assert.equal(buildRegisterPatch(makeResult(walls(), photos({ status: 'refused', reason: 'collinear', transform: null })), 'job-1', 'sfm'), null)
  assert.equal(buildRegisterPatch(makeResult(walls(), photos({ status: 'skipped', reason: 'off', transform: null })), 'job-1', 'sfm'), null)
  assert.equal(buildRegisterPatch(makeResult(walls(), null), 'job-1', 'sfm'), null)
  assert.equal(buildRegisterPatch(makeResult(walls({ status: 'refused', transform: null, reason: 'ambiguous' }), photos()), 'job-1'), null)
})

test('a photo correction that carries a size writes a placement with that size, which the Edit gizmo\'s own fields hold', () => {
  const sized = photos({ transform: yawTranslation(-0.02, 0.2, 0, -0.06, 1.12) })
  const body = buildRegisterPatch(makeResult(walls(), sized), 'job-1', 'sfm')!
  assert.ok(Math.abs(body.transform.scale.x - 1.12) < 1e-9 && Math.abs(body.transform.scale.y - 1.12) < 1e-9 && Math.abs(body.transform.scale.z - 1.12) < 1e-9)
})

// ── Where a proposal stands, per method ─────────────────────────────────────

test('each method is ready until its own reference scan, or the new scan, has moved', () => {
  const result = makeResult()
  assert.equal(registerApplyState(result, 'job-1', scans(), [], 'scan-match'), 'ready')
  assert.equal(registerApplyState(result, 'job-1', scans(), [], 'sfm'), 'ready')
  // The photo method was measured against scan-c; moving scan-c leaves the wall match (measured against scan-a) as it was.
  const movedPhotoReference = scans(MOVING_PLACEMENT, IDENTITY, yawTranslation(0, 1, 0, 0))
  assert.equal(registerApplyState(result, 'job-1', movedPhotoReference, [], 'sfm'), 'stale')
  assert.equal(registerApplyState(result, 'job-1', movedPhotoReference, [], 'scan-match'), 'ready')
  // The new scan moving makes both stale.
  const movedNew = scans(yawTranslation(0.4, 12.5, 0.02, -3))
  assert.equal(registerApplyState(result, 'job-1', movedNew, [], 'sfm'), 'stale')
  assert.equal(registerApplyState(result, 'job-1', movedNew, [], 'scan-match'), 'stale')
  // A method with no proposal is refused, not stale.
  assert.equal(registerApplyState(makeResult(walls(), null), 'job-1', scans(), [], 'sfm'), 'refused')
})

test('one job is applied once: after either method\'s patch the job is applied for both', () => {
  const result = makeResult()
  const body = buildRegisterPatch(result, 'job-1', 'sfm')!
  const patch: EditPatch = { patchId: 'p', worldId: 'w', scanId: 'scan-b', targetId: body.targetId, scope: 'scan', transform: body.transform, provenance: body.provenance, createdAt: '2026-11-17T10:05:00.000Z' }
  for (const method of ['scan-match', 'sfm'] as const) {
    assert.equal(registerApplyState(result, 'job-1', scans(), [patch], method), 'applied', method)
  }
})

test('Apply by the photo method posts one patch, the other method\'s Apply then does nothing, and a second press does nothing', async () => {
  const result = makeResult()
  const patches: EditPatch[] = []
  const posts: ReturnType<typeof buildRegisterPatch>[] = []
  const deps = {
    scans: () => scans(),
    patches: () => patches,
    post: async (body: NonNullable<ReturnType<typeof buildRegisterPatch>>) => {
      posts.push(body)
      patches.push({ patchId: 'p', worldId: 'w', scanId: body.scanId, targetId: body.targetId, scope: 'scan', transform: body.transform, provenance: body.provenance, createdAt: '2026-11-17T10:05:00.000Z' })
    },
  }
  assert.equal(await applyRegistrationProposal(result, 'job-1', deps, 'sfm'), 'applied')
  assert.equal(posts.length, 1)
  assert.equal(posts[0]!.provenance.method, 'sfm')
  assert.equal(await applyRegistrationProposal(result, 'job-1', deps, 'sfm'), 'already-applied')
  assert.equal(await applyRegistrationProposal(result, 'job-1', deps, 'scan-match'), 'already-applied')
  assert.equal(posts.length, 1, 'nothing more was written')
})

test('Apply by a method that proposed nothing writes nothing', async () => {
  const result = makeResult(walls(), photos({ status: 'refused', reason: 'collinear', transform: null }))
  const posts: unknown[] = []
  const outcome = await applyRegistrationProposal(result, 'job-9', { scans: () => scans(), patches: () => [], post: async (body) => void posts.push(body) }, 'sfm')
  assert.equal(outcome, 'refused')
  assert.equal(posts.length, 0)
})

// ── Comparing two corrections ───────────────────────────────────────────────

/** A deterministic generator, so the random cases are the same on every run. */
function lcg(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (Math.imul(a, 1664525) + 1013904223) >>> 0
    return a / 4294967296
  }
}

test('matrixYawDeg is the turn about up, whatever size the matrix has, and reads the layout composeYUpTransform writes', () => {
  for (const deg of [-170, -90, -12.5, 0, 0.3, 45, 90, 179]) {
    const yaw = (deg * Math.PI) / 180
    assert.ok(Math.abs(matrixYawDeg(yawTranslation(yaw, 3, 1, -2)) - deg) < 1e-9, `${deg}`)
    assert.ok(Math.abs(matrixYawDeg(yawTranslation(yaw, 3, 1, -2, 1.7)) - deg) < 1e-9, `${deg} at a size of 1.7`)
  }
})

test('two corrections that are the same differ by nothing, anywhere', () => {
  const m = yawTranslation(0.3, 1.5, 0.1, -2.5)
  for (const pivot of [[0, 0], [10, -4], [-300, 80]] as const) {
    const apart = compareCorrections(m, m, pivot)
    assert.ok(apart.translationM < 1e-12 && Math.abs(apart.yawDeg) < 1e-12)
  }
})

test('the distance two corrections put the middle of the scan apart is what carrying the point through each gives, with random corrections', () => {
  const next = lcg(7)
  for (let i = 0; i < 200; i++) {
    const a = yawTranslation((next() - 0.5) * 0.4, (next() - 0.5) * 2, (next() - 0.5) * 0.2, (next() - 0.5) * 2, 0.9 + next() * 0.3)
    const b = yawTranslation((next() - 0.5) * 0.4, (next() - 0.5) * 2, (next() - 0.5) * 0.2, (next() - 0.5) * 2, 0.9 + next() * 0.3)
    const pivot: [number, number] = [(next() - 0.5) * 30, (next() - 0.5) * 30]
    const through = (m: number[]) => [m[0]! * pivot[0] + m[8]! * pivot[1] + m[12]!, m[2]! * pivot[0] + m[10]! * pivot[1] + m[14]!]
    const [ax, az] = through(a)
    const [bx, bz] = through(b)
    const apart = compareCorrections(a, b, pivot)
    assert.ok(Math.abs(apart.translationM - Math.hypot(ax! - bx!, az! - bz!)) < 1e-9, `case ${i}`)
    assert.ok(Math.abs(apart.yawDeg - (matrixYawDeg(a) - matrixYawDeg(b))) < 1e-9, `case ${i}`)
  }
})

test('a difference of turns is the short way round, so 179 and -179 degrees are two degrees apart', () => {
  const apart = compareCorrections(yawTranslation((179 * Math.PI) / 180, 0, 0, 0), yawTranslation((-179 * Math.PI) / 180, 0, 0, 0), [0, 0])
  assert.ok(Math.abs(apart.yawDeg + 2) < 1e-9, `${apart.yawDeg}`)
})

test('two methods agree when they are inside the bound on both counts, and not when either is outside it', () => {
  const base = yawTranslation(0, 0, 0, 0)
  const at = (dx: number, yawDeg: number) => agreementOf(base, yawTranslation((yawDeg * Math.PI) / 180, dx, 0, 0), [0, 0])!
  assert.equal(at(0.14, 1.9).withinBound, true)
  assert.equal(at(0.16, 0).withinBound, false, 'a shift past the bound')
  assert.equal(at(0, 2.1).withinBound, false, 'a turn past the bound')
  assert.equal(at(0.15, 2).withinBound, true, 'the bound itself is inside it')
  assert.equal(METHOD_AGREEMENT_BOUND.translationM, 0.15)
  assert.equal(METHOD_AGREEMENT_BOUND.yawDeg, 2)
  // A method that proposed no move leaves nothing to compare, and a bad pivot is no answer.
  assert.equal(agreementOf(null, base, [0, 0]), null)
  assert.equal(agreementOf(base, null, [0, 0]), null)
  assert.equal(agreementOf(base, base, [Number.NaN, 0]), null)
  assert.equal(agreementOf([1, 2], base, [0, 0]), null)
})

// ── What the words may say ──────────────────────────────────────────────────

const SKIPS: SfmSkipReason[] = ['off', 'not-needed', 'colmap-missing', 'no-place', 'no-keyframes', 'no-reference', 'frame-mismatch', 'no-overlap']
const REFUSALS: SfmRefusal[] = [
  'colmap-failed', 'timed-out', 'reference-weak', 'too-few-registered', 'sub-model-split', 'reference-moved', 'reference-unusable',
  'too-few-correspondences', 'collinear', 'degenerate-scale', 'high-residual', 'up-axis-disagrees', 'turn-uncertain', 'scale-out-of-range',
  'correction-too-large', 'sessions-disagree',
]

test('every reason the photo method has for not running or not proposing has a sentence, and none says aligned or verified', () => {
  for (const reason of [...SKIPS, ...REFUSALS]) {
    const text = sfmReasonText(reason)
    assert.ok(text.length > 10 && text.endsWith('.'), `${reason}: ${text}`)
    assert.doesNotMatch(text, /\b(aligned|verified|undefined|null|NaN)\b/i, reason)
  }
  assert.equal(sfmReasonText(null), 'No move was proposed.')
  assert.equal(sfmReasonText('something-newer' as never), 'No move was proposed.', 'an unknown reason from a newer build still reads')
})

test('the photo method\'s lines say what was measured: photographs that found their place, how far apart the cameras are, the move, how far the farthest camera goes', () => {
  const described = describeSfmResult(makeResult())!
  assert.equal(described.headline, 'Proposed move: 21 cm and a 1.4° turn')
  assert.deepEqual(described.lines, [
    'Compared with Earlier visit.',
    '13 of 14 photos found their place, camera positions about 3 cm apart.',
    'Height changes by 1 cm.',
    'The farthest camera position moves 40 cm.',
    'Nothing moves until you apply it.',
  ])
})

test('the farthest camera is said to move only when it moves clearly more than the middle of the scan does', () => {
  const lineFor = (translationM: number, maxShiftM: number) =>
    describeSfmResult(makeResult(walls(), photos({ boundedCorrection: { translationM, yawDeg: -1.4, dyM: 0.01, maxShiftM, withinBound: true, bound: { translationM: 1, yawDeg: 10, dyM: 0.3 } } })))!.lines
      .find((line) => line.includes('farthest'))
  assert.equal(lineFor(0.25, 0.296875), undefined, 'under 5 cm more is the same move')
  assert.equal(lineFor(0.25, 0.3125), 'The farthest camera position moves 31 cm.')
  assert.equal(lineFor(0, 1.52), 'The farthest camera position moves 152 cm.', 'a size change that leaves the middle alone still moves the far end')
})

test('a size the move carries is said with what happens to the scan, and one it does not carry is said as measured and left alone', () => {
  // The move resizes the scan by 12%: the card says so, from the move itself.
  const carried = describeSfmResult(makeResult(walls(), photos({ scaleRatio: 1.12, transform: yawTranslation(-0.025, 0.2, 0.01, -0.06, 1.12) })))!
  assert.ok(carried.lines.includes('The two scans differ in size by 12%, and this move resizes the scan.'), carried.lines.join(' | '))
  assert.ok(!carried.lines.some((line) => line.includes('is not resized')))
  // Measured at 12% and not carried (a path that cannot tell it from its own scatter): the card says it was measured and the scan is not resized.
  const measured = describeSfmResult(makeResult(walls(), photos({ scaleRatio: 1.12 })))!
  assert.ok(measured.lines.includes('The photos measure a size difference of 12%, and the scan is not resized.'), measured.lines.join(' | '))
  assert.ok(!measured.lines.some((line) => line.includes('this move resizes')))
  // Inside 2% there is nothing to say, as before.
  const same = describeSfmResult(makeResult(walls(), photos({ scaleRatio: 1.01 })))!
  assert.ok(!same.lines.some((line) => /size/.test(line)), 'a one percent scatter is not a unit difference')
  // 0.5% of resizing in the move is under what is worth a line; 0.6% is not.
  assert.ok(!describeSfmResult(makeResult(walls(), photos({ transform: yawTranslation(-0.025, 0.2, 0.01, -0.06, 1.0049) })))!.lines.some((line) => /size/.test(line)))
  assert.ok(describeSfmResult(makeResult(walls(), photos({ transform: yawTranslation(-0.025, 0.2, 0.01, -0.06, 1.006) })))!.lines.some((line) => /differ in size by 1%/.test(line)))
})

test('how well the photographs fix the turn and the size is on the card when it was measured, and not when it was not', () => {
  const sure = describeSfmResult(makeResult(walls(), photos({ turnUncertaintyDeg: 0.43, sizeUncertainty: 0.0031 })))!
  assert.ok(sure.lines.includes('The photos fix the turn to about 0.4° and the size to about 0.3%.'), sure.lines.join(' | '))
  const unsure = describeSfmResult(makeResult(walls(), photos({ turnUncertaintyDeg: 0.96, sizeUncertainty: 0.0241 })))!
  assert.ok(unsure.lines.includes('The photos fix the turn to about 1.0° and the size to about 2.4%.'))
  // A record from a build that did not measure it says nothing about it.
  assert.ok(!describeSfmResult(makeResult())!.lines.some((line) => line.includes('fix the turn')))
  assert.ok(!describeSfmResult(makeResult(walls(), photos({ turnUncertaintyDeg: 0.4 })))!.lines.some((line) => line.includes('fix the turn')), 'both numbers or neither')
  // Photographs left out of the fit are said, with the gate they were left out at.
  const trimmed = describeSfmResult(makeResult(walls(), photos({ fitTrimmedFrames: 2, params: { inlierGateM: 0.15 } })))!
  assert.ok(trimmed.lines.includes('2 of them were left out of the fit, because their solved camera was more than 15 cm from the one this scan recorded.'), trimmed.lines.join(' | '))
  assert.ok(describeSfmResult(makeResult(walls(), photos({ fitTrimmedFrames: 1, params: {} })))!.lines.includes('1 of them was left out of the fit, because their solved camera was too far from the one this scan recorded.'))
  assert.ok(!describeSfmResult(makeResult(walls(), photos({ fitTrimmedFrames: 0 })))!.lines.some((line) => line.includes('left out')))
})

test('a refusal for a turn the photographs cannot fix says how uncertain it was', () => {
  const refused = describeSfmResult(makeResult(walls(), photos({ status: 'refused', reason: 'turn-uncertain', transform: null, turnUncertaintyDeg: 1.43, registeredImages: 24, offeredImages: 24 })))!
  assert.equal(refused.headline, 'No move proposed')
  assert.equal(refused.lines[0], 'The camera paths are too small for the photos to fix the turn.')
  assert.ok(refused.lines.includes('The photos fix the turn to only about 1.43°.'), refused.lines.join(' | '))
  assert.ok(describeSfmResult(makeResult(walls(), photos({ status: 'refused', reason: 'turn-uncertain', transform: null, turnUncertaintyDeg: 1.04 })))!.lines.includes('The photos fix the turn to only about 1.04°.'), 'a refusal just past the limit does not read as one at it')
  const unsaid = describeSfmResult(makeResult(walls(), photos({ status: 'refused', reason: 'turn-uncertain', transform: null })))!
  assert.ok(!unsaid.lines.some((line) => line.includes('only about')), 'no number, no line')
})

test('a refusal says why and how many photographs found their place, and a skip is one line', () => {
  const refused = describeSfmResult(makeResult(walls(), photos({ status: 'refused', reason: 'too-few-registered', transform: null, registeredImages: 4, offeredImages: 14 })))!
  assert.equal(refused.headline, 'No move proposed')
  assert.equal(refused.lines[0], 'Too few of this scan\'s photos found their place.')
  assert.ok(refused.lines.includes('4 of 14 photos found their place.'))
  const skipped = describeSfmResult(makeResult(walls(), photos({ status: 'skipped', reason: 'off', transform: null })))!
  assert.deepEqual(skipped, { headline: null, lines: ['Photo matching is turned off on this server.'] })
  assert.equal(describeSfmResult(makeResult(walls(), null)), null, 'no photo block, nothing to say')
})

test('no number that does not exist is printed: a missing residual or move leaves the figure out and never writes NaN', () => {
  const lines = describeSfmResult(makeResult(walls(), photos({ residualM: null, boundedCorrection: null, scaleRatio: null, registeredFraction: 0.5 }), [0, 0]))
  // A proposal with no residual is not a proposal when read back; described directly it still prints no NaN.
  assert.ok(lines)
  assert.doesNotMatch([lines!.headline, ...lines!.lines].join('\n'), /NaN|undefined|null/)
})

test('how the two methods compare is said in numbers, and beyond the bound it says that neither is preferred and prefers neither', () => {
  // The fixtures' two methods are measured against different earlier scans, and the card says so.
  const close = describeAgreement(makeResult())!
  assert.equal(close.withinBound, true)
  assert.equal(close.text, 'The two methods differ by 9 cm and 0.3°. They were compared with different earlier scans.')
  assert.equal(close.prefers, null)
  const far = describeAgreement(makeResult(walls(), photos({ transform: yawTranslation(-0.02, 0.9, 0.01, -0.07) })))!
  assert.equal(far.withinBound, false)
  assert.match(far.text, /That is more than 15 cm, 2° or 5% in size, so neither is preferred\.$/)
  assert.equal(far.prefers, null, 'no caller can read a preference out of it')
  assert.equal(describeAgreement(makeResult(walls(), null)), null, 'one method, nothing to compare')
})

test('two methods measured against the same earlier scan do not say they were compared with different ones, and two measured against different ones do', () => {
  const sameReference = photos({ reference: { scanId: 'scan-a', filename: '100_a.glb', name: 'First visit', localToWorld: IDENTITY } })
  assert.equal(describeAgreement(makeResult(walls(), sameReference))!.text, 'The two methods differ by 9 cm and 0.3°.')
  assert.match(describeAgreement(makeResult())!.text, /They were compared with different earlier scans\./)
})

test('the size of the two methods\' corrections is compared with their place and turn: the same place at the same turn is not agreement when one is 12% bigger', () => {
  const pivot: [number, number] = [14, -2]
  // `small` with its size times `ratio` and its shift changed so that it still carries the pivot to the same place at the same turn:
  // x' = m0 x + m8 z + m12 and z' = m2 x + m10 z + m14, so the shift is what the larger rotation block leaves of the same destination.
  const small = yawTranslation(-0.02, 0.18, 0.01, -0.07)
  const resizedKeepingPivot = (ratio: number): number[] => {
    const m = [...small]
    for (const i of [0, 1, 2, 4, 5, 6, 8, 9, 10]) m[i] = small[i]! * ratio
    m[12] = small[0]! * pivot[0] + small[8]! * pivot[1] + small[12]! - m[0]! * pivot[0] - m[8]! * pivot[1]
    m[14] = small[2]! * pivot[0] + small[10]! * pivot[1] + small[14]! - m[2]! * pivot[0] - m[10]! * pivot[1]
    return m
  }
  const wide = resizedKeepingPivot(1.12)
  const apart = agreementOf(small, wide, pivot)!
  assert.ok(apart.translationM < 1e-9 && Math.abs(apart.yawDeg) < 1e-9, 'the same place and the same turn')
  assert.ok(Math.abs(apart.scaleRatio! - 1.12) < 1e-12)
  assert.equal(apart.withinBound, false, 'and so not agreement')
  const sized = describeAgreement({ ...makeResult(walls(), photos({ reference: { scanId: 'scan-a', filename: '100_a.glb', name: 'First visit', localToWorld: IDENTITY } })), agreement: apart })!
  assert.equal(sized.text, 'The two methods differ by 0 cm, 0.0° and 12% in size. That is more than 15 cm, 2° or 5% in size, so neither is preferred.')
  // The bound is 5% in size: inside it is agreement, past it is not.
  const at = (ratio: number) => agreementOf(small, resizedKeepingPivot(ratio), pivot)!
  assert.equal(METHOD_AGREEMENT_BOUND.sizeRatio, 0.05)
  assert.equal(at(1.049).withinBound, true)
  assert.equal(at(1.051).withinBound, false)
  assert.equal(at(0.951).withinBound, true)
  assert.equal(at(0.949).withinBound, false)
  assert.ok(Math.abs(matrixScale(wide)! - 1.12 * matrixScale(small)!) < 1e-12, 'the size is the length of the x axis\' image')
})

test('a record that has no size in its agreement is read as it was written, with the two bounds it was measured by', () => {
  const written = makeResult()
  delete (written.agreement as { scaleRatio?: number }).scaleRatio
  const read = readPlaceRegisterResult(jobFor(written))!
  assert.equal('scaleRatio' in read.agreement!, false)
  const text = describeAgreement({ ...read, sfm: photos({ reference: read.reference }) })!
  assert.equal(text.text, 'The two methods differ by 9 cm and 0.3°.')
  const far = describeAgreement({ ...read, sfm: photos({ reference: read.reference }), agreement: { ...read.agreement!, translationM: 0.9, withinBound: false } })!
  assert.match(far.text, /That is more than 15 cm or 2°, so neither is preferred\.$/, 'no size in the sentence about a bound the record was not held to')
})

test('the size a similarity carries is the length of the image of its x axis, and anything else has none', () => {
  assert.equal(matrixScale(IDENTITY), 1)
  assert.ok(Math.abs(matrixScale(yawTranslation(0.7, 3, 0, 4, 1.25))! - 1.25) < 1e-12)
  assert.equal(matrixScale([1, 2, 3]), null)
  assert.equal(matrixScale(null), null)
  assert.equal(matrixScale(undefined), null)
})

test('the new measurements read back out of a stored artifact, and a stored artifact without them reads as before', () => {
  const stored = makeResult(walls(), photos({ turnUncertaintyDeg: 0.43, sizeUncertainty: 0.0031, fitTrimmedFrames: 2, sessions: [] }))
  const read = readPlaceRegisterResult(jobFor(stored))!
  assert.equal(read.sfm!.turnUncertaintyDeg, 0.43)
  assert.equal(read.sfm!.sizeUncertainty, 0.0031)
  assert.equal(read.sfm!.fitTrimmedFrames, 2)
  assert.equal(read.agreement!.scaleRatio, stored.agreement!.scaleRatio)
  const bare = readPlaceRegisterResult(jobFor(makeResult()))!
  for (const key of ['turnUncertaintyDeg', 'sizeUncertainty', 'fitTrimmedFrames']) assert.equal(key in bare.sfm!, false, `${key} is not invented`)
  // A damaged value is not believed: infinity and text come back out of JSON as null and a string.
  const damaged = JSON.parse(JSON.stringify(makeResult(walls(), photos())))
  damaged.sfm.turnUncertaintyDeg = null
  damaged.sfm.sizeUncertainty = 'big'
  damaged.agreement.scaleRatio = -3
  const job = jobFor(makeResult())
  job.artifacts![0]!.metadata = damaged
  const readDamaged = readPlaceRegisterResult(job)!
  assert.equal('turnUncertaintyDeg' in readDamaged.sfm!, false)
  assert.equal('sizeUncertainty' in readDamaged.sfm!, false)
  assert.equal('scaleRatio' in readDamaged.agreement!, false)
})

test('the note on every card says it is a proposal and what it did not check, and claims nothing else', () => {
  assert.match(NOT_CHECKED_TEXT, /^A proposal only\./)
  assert.match(NOT_CHECKED_TEXT, /does not check that these scans are of the same room/)
  assert.match(NOT_CHECKED_TEXT, /where the Place is on a map/)
  assert.match(NOT_CHECKED_TEXT, /Nothing moves until you apply it\.$/)
  assert.doesNotMatch(NOT_CHECKED_TEXT, /\b(aligned|verified|accurate|correct)\b/i)
  assert.doesNotMatch(NOT_CHECKED_SCOPE_TEXT, /\b(aligned|verified|accurate|correct|proposal)\b/i)
})

test('a card with a move to apply carries the whole note, and a card with none carries only what was not looked at', () => {
  assert.equal(notCheckedText(makeResult()), NOT_CHECKED_TEXT)
  assert.equal(notCheckedText(makeResult(walls(), null)), NOT_CHECKED_TEXT, 'a wall match alone, as every record before the photo method')
  assert.equal(notCheckedText(makeResult(walls({ status: 'refused', transform: null, reason: 'ambiguous' }), photos())), NOT_CHECKED_TEXT, 'the photos alone')
  const neither = makeResult(walls({ status: 'refused', transform: null, reason: 'ambiguous' }), photos({ status: 'refused', reason: 'collinear', transform: null }))
  assert.equal(notCheckedText(neither), NOT_CHECKED_SCOPE_TEXT)
  assert.ok(NOT_CHECKED_TEXT.includes(NOT_CHECKED_SCOPE_TEXT))
})

test('a job asks for the photo method by its payload and by nothing else', () => {
  assert.equal(requestsPhotoMethod({ method: 'sfm', source: 'viewer' }), true)
  for (const payload of [undefined, {}, { method: 'scan-match' }, { method: 'SFM' }, { method: ['sfm'] }, { source: 'joined-place' }, { sfm: true }]) {
    assert.equal(requestsPhotoMethod(payload as never), false, JSON.stringify(payload))
  }
})

test('none of the lines a photo proposal produces says aligned or verified', () => {
  const texts: string[] = []
  for (const result of [makeResult(), makeResult(walls(), photos({ status: 'refused', reason: 'collinear', transform: null })), makeResult(walls(), photos({ scaleRatio: 1.2 }))]) {
    const described = describeSfmResult(result)!
    texts.push(described.headline ?? '', ...described.lines)
    const agreement = describeAgreement(result)
    if (agreement) texts.push(agreement.text)
  }
  assert.doesNotMatch(texts.join('\n'), /\b(aligned|verified)\b/i)
})
