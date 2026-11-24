/**
 * The amendments to the place-register matcher (WP-15a, from R2's synthetic study): the global ambiguity probe, the evidence the
 * starting acceptance values are judged on, those values as named constants, the numbers of every pair recorded, and the search for
 * the size between two scans whose sessions ran in different units.
 *
 * tests/unit/deno/scan_match.test.ts is the matcher's own behaviour and is unchanged. This file is what the amendment adds, and it
 * checks the measurements against an INDEPENDENT implementation written here from the definition (a brute-force nearest-neighbour
 * field, not the matcher's grid): a score or an observability that was computed from the wrong cells, or by the wrong formula, would
 * pass any test that only checks it is a number between 0 and 1.
 *
 * Every room is synthetic and seeded (tests/fixtures/place-register). What passes here is not evidence about real scans: every
 * threshold is adopted, not measured (ADR 0005 rule 5), and DX9 is the run that tunes them.
 */
import { assert, assertAlmostEquals, assertEquals, assertNotEquals } from 'jsr:@std/assert@^1.0.0'

import {
  extractWallCells,
  FIELD_SIGMA_M,
  GLOBAL_EXCLUSION_M,
  GLOBAL_EXCLUSION_YAW_DEG,
  GLOBAL_PROBE_WINDOW_M,
  GLOBAL_PROBE_WINDOW_YAW_DEG,
  judgeStartingValues,
  matchParams,
  matchScans,
  matchScansYielding,
  MAX_ACCEPT_RMS_M,
  MIN_FIELD_SCORE,
  MIN_GLOBAL_PEAK_RATIO,
  MIN_OBSERVABILITY,
  MIN_QUERY_INLIER_SHARE,
  MIN_REFERENCE_COVERAGE,
  OBSERVABILITY_DIRECTIONS,
  OBSERVABILITY_STEP_M,
  SCALE_SEARCH_MAX,
  SCALE_SEARCH_MIN,
  SCALE_SEARCH_STEPS,
  scaleLadder,
  SYMMETRIC_PEAK_RATIO,
  transformPositions,
} from '../../../server/register/scan_match.ts'
import type { RegistrationDetails } from '../../../src/world/register-proposal.ts'
import { concatClouds, makePolygonRoom, makeRoom, misplace, type Misplacement } from '../../fixtures/place-register/synthetic-room.ts'

const ROOM = { width: 6, depth: 4, centre: { x: 3, z: 2 } } as const
/** Pieces of furniture no half turn maps onto each other. */
const ASYMMETRIC = [{ x: 1.9, z: 2.2, w: 0.8, d: 0.6, h: 0.9 }, { x: 4.5, z: 3.0, w: 1.2, d: 0.5, h: 0.5 }, { x: 5.0, z: 1.0, w: 0.7, d: 0.4, h: 1.2 }]
/** The two pieces the job's old fixtures had: they swap places under a half turn about the room's middle, to within 30 cm. */
const NEARLY_SYMMETRIC = [{ x: 1.2, z: 1, w: 0.8, d: 0.6, h: 0.9 }, { x: 4.5, z: 3, w: 1.2, d: 0.5, h: 0.5 }]
const ERROR: Misplacement = { yawDeg: 3, dx: 0.3, dz: -0.2 }

const room = (seed: number, extra: Record<string, unknown> = {}) =>
  makeRoom({ ...ROOM, noiseM: 0.02, boxes: ASYMMETRIC, seed, ...extra })

function pair(reference: Float32Array, moving: Float32Array, error: Misplacement = ERROR, options = {}) {
  return matchScans({ positions: reference }, { positions: misplace(moving, error) }, options)
}

// ─── The constants ───────────────────────────────────────────────────────────

Deno.test('the starting values are R2\'s, named, and recorded in the params of every run', () => {
  assertEquals(MIN_FIELD_SCORE, 0.8)
  assertEquals(MIN_GLOBAL_PEAK_RATIO, 1.1)
  assertEquals(MIN_OBSERVABILITY, 0.12)
  assertEquals(MIN_QUERY_INLIER_SHARE, 0.85)
  assertEquals(MIN_REFERENCE_COVERAGE, 0.45)
  assertEquals(MAX_ACCEPT_RMS_M, 0.045)
  assertEquals(SYMMETRIC_PEAK_RATIO, 0.9)
  assertEquals([GLOBAL_PROBE_WINDOW_M, GLOBAL_PROBE_WINDOW_YAW_DEG, GLOBAL_EXCLUSION_M, GLOBAL_EXCLUSION_YAW_DEG], [3, 180, 1, 25])
  assertEquals([SCALE_SEARCH_MIN, SCALE_SEARCH_MAX, SCALE_SEARCH_STEPS], [0.8, 1.25, 11])
  const params = matchParams()
  for (const [key, value] of Object.entries({
    minFieldScore: MIN_FIELD_SCORE,
    minGlobalPeakRatio: MIN_GLOBAL_PEAK_RATIO,
    symmetricPeakRatio: SYMMETRIC_PEAK_RATIO,
    minObservability: MIN_OBSERVABILITY,
    minQueryInlierShare: MIN_QUERY_INLIER_SHARE,
    minReferenceCoverage: MIN_REFERENCE_COVERAGE,
    maxAcceptRmsM: MAX_ACCEPT_RMS_M,
    globalExclusionM: GLOBAL_EXCLUSION_M,
    globalExclusionYawDeg: GLOBAL_EXCLUSION_YAW_DEG,
    scaleSearchSteps: SCALE_SEARCH_STEPS,
  })) assertEquals(params[key], value, key)
})

Deno.test('the starting values are tighter than the matcher\'s own gates where they overlap, which is what "the tightest case" means', () => {
  assert(MAX_ACCEPT_RMS_M < 0.08, 'the gap: 4.5 cm against the matcher\'s 8 cm')
  assert(MIN_QUERY_INLIER_SHARE > 0.6, 'the share that lines up: 85% against the matcher\'s 60% overlap')
})

// ─── The global ambiguity probe ──────────────────────────────────────────────

Deno.test('the probe flags rooms that look the same turned round, and does not flag a room whose furniture settles the turn', () => {
  const flagged = new Map<string, boolean>()
  const ratios = new Map<string, number>()
  const record = (label: string, result: ReturnType<typeof pair>) => {
    assertEquals(result.status, 'proposed', `${label}: the bounded match is fine in every one of these (${result.reason})`)
    const probe = result.details.globalProbe
    assert(probe, `${label}: probed`)
    flagged.set(label, probe.symmetric)
    ratios.set(label, probe.secondPeakRatio)
  }
  record('furnished asymmetrically', pair(room(1), room(2)))
  record('empty rectangle', pair(room(1, { boxes: [] }), room(2, { boxes: [] })))
  record('rectangle with a door gap', pair(
    room(1, { boxes: [], gaps: [{ wall: 'north', from: 1, to: 1.9 }] }),
    room(2, { boxes: [], gaps: [{ wall: 'north', from: 1, to: 1.9 }] }),
  ))
  record('nearly symmetric furniture', pair(room(1, { boxes: NEARLY_SYMMETRIC }), room(2, { boxes: NEARLY_SYMMETRIC })))
  const square = (seed: number, extra = {}) => makeRoom({ width: 4.2, depth: 4.2, centre: { x: 2.1, z: 2.1 }, noiseM: 0.02, seed, ...extra })
  record('perfect square', pair(square(1), square(2)))
  record('square with a door gap', pair(square(1, { gaps: [{ wall: 'north', from: 1.6, to: 2.5 }] }), square(2, { gaps: [{ wall: 'north', from: 1.6, to: 2.5 }] })))
  const corridor = (seed: number) => makeRoom({ width: 9, depth: 1.3, centre: { x: 4.5, z: 0.65 }, noiseM: 0.02, seed })
  record('corridor', pair(corridor(1), corridor(2), { yawDeg: 2, dx: 0.1, dz: 0.1 }))

  assertEquals(flagged.get('furnished asymmetrically'), false, `ratio ${ratios.get('furnished asymmetrically')}`)
  for (const label of ['empty rectangle', 'rectangle with a door gap', 'nearly symmetric furniture', 'perfect square', 'square with a door gap', 'corridor']) {
    assertEquals(flagged.get(label), true, `${label}: ratio ${ratios.get(label)}`)
    assert(ratios.get(label)! >= SYMMETRIC_PEAK_RATIO, label)
  }
  assert(ratios.get('furnished asymmetrically')! < 0.8, `a room with one right place leaves little elsewhere: ${ratios.get('furnished asymmetrically')}`)
  assert(ratios.get('perfect square')! > 0.97, 'a perfect square fits itself at every quarter turn')
})

Deno.test('the probe sees what the bounded window cannot: a square with one door gap has no second place inside the bound and one outside it', () => {
  const square = (seed: number) => makeRoom({ width: 4.2, depth: 4.2, centre: { x: 2.1, z: 2.1 }, noiseM: 0.02, seed, gaps: [{ wall: 'north', from: 1.6, to: 2.5 }] })
  const result = pair(square(1), square(2))
  assertEquals(result.status, 'proposed')
  assert(result.details.peakRatio < 0.5, `inside the bound nothing competes: ${result.details.peakRatio}`)
  assert(result.details.globalProbe!.secondPeakRatio >= SYMMETRIC_PEAK_RATIO, `outside it a quarter turn fits as well: ${result.details.globalProbe!.secondPeakRatio}`)
})

Deno.test('the probe records how far it looked and how big a zone round the best position it did not count', () => {
  const probe = pair(room(1), room(2)).details.globalProbe!
  assertEquals([probe.windowM, probe.windowYawDeg, probe.exclusionM, probe.exclusionYawDeg], [3, 180, 1, 25])
  assertEquals(probe.symmetric, probe.secondPeakRatio >= SYMMETRIC_PEAK_RATIO)
  assert(probe.secondPeakRatio >= 0 && probe.secondPeakRatio <= 1)
})

Deno.test('a pair turned away before any search was not probed, and a pair that got no peak has no ratio to be misread', () => {
  // No furniture: a box is placed in room coordinates, not relative to the room's centre, and would stand in the reference's footprint.
  const far = makeRoom({ ...ROOM, centre: { x: 300, z: 2 }, noiseM: 0.02, boxes: [], seed: 3 })
  const turnedAway = matchScans({ positions: room(1) }, { positions: far })
  assertEquals(turnedAway.reason, 'low-overlap')
  assertEquals(turnedAway.details.searchedTranslationM, 0)
  assertEquals(turnedAway.details.globalProbe, undefined)
  assertEquals(turnedAway.details.evidence, undefined)
  assertEquals(turnedAway.details.startingValues, undefined)
})

// ─── The evidence, against an independent implementation ─────────────────────

type Cells = ReturnType<typeof extractWallCells>

/** The field of R2's definition, written out: a Gaussian of the distance to the nearest reference cell, zero beyond three sigma. */
function fieldValue(reference: Cells, x: number, z: number): number {
  let nearest2 = Infinity
  for (let i = 0; i < reference.n; i++) {
    const d2 = (reference.x[i]! - x) ** 2 + (reference.z[i]! - z) ** 2
    if (d2 < nearest2) nearest2 = d2
  }
  const radius = 3 * FIELD_SIGMA_M
  return nearest2 > radius * radius ? 0 : Math.exp(-nearest2 / (2 * FIELD_SIGMA_M ** 2))
}

function meanField(reference: Cells, query: Cells, dx = 0, dz = 0): number {
  let sum = 0
  for (let i = 0; i < query.n; i++) sum += fieldValue(reference, query.x[i]! + dx, query.z[i]! + dz)
  return sum / query.n
}

function observabilityOf(reference: Cells, query: Cells): number {
  const here = meanField(reference, query)
  let smallest = Infinity
  for (let k = 0; k < OBSERVABILITY_DIRECTIONS; k++) {
    const a = (2 * Math.PI * k) / OBSERVABILITY_DIRECTIONS
    smallest = Math.min(smallest, (here - meanField(reference, query, OBSERVABILITY_STEP_M * Math.cos(a), OBSERVABILITY_STEP_M * Math.sin(a))) / here)
  }
  return smallest
}

Deno.test('the field score and the observability are what R2 defined, read at the best position, checked against a brute-force implementation', () => {
  // The new scan sees the room from a corner: two walls and the furniture, so it reaches less far and is the one the search turns.
  const referenceCloud = room(1)
  const movingCloud = misplace(room(2, { unscanned: ['north', 'east'] }), ERROR)
  const result = matchScans({ positions: referenceCloud }, { positions: movingCloud })
  assertEquals(result.status, 'proposed', `${result.reason}`)
  const evidence = result.details.evidence!
  assert(evidence.fieldScore !== null && evidence.observability !== null)

  // The same two clouds, laid by the correction the matcher found, and read the way R2 reads them.
  const moved = extractWallCells(transformPositions(movingCloud, result.transform!), 0)
  const reference = extractWallCells(referenceCloud, 0)
  assertAlmostEquals(evidence.fieldScore, meanField(reference, moved), 0.03, 'the mean of the field under the query')
  assertAlmostEquals(evidence.observability, observabilityOf(reference, moved), 0.05, 'the smallest fall for a 25 cm slide')
  assert(evidence.fieldScore > MIN_FIELD_SCORE && evidence.observability > MIN_OBSERVABILITY)
})

Deno.test('the score falls and the observability reads low in the cases R2 found them to: a gap that is a hand\'s width, and a corridor', () => {
  const corridor = (seed: number) => makeRoom({ width: 9, depth: 1.3, centre: { x: 4.5, z: 0.65 }, noiseM: 0.02, seed })
  const along = pair(corridor(1), corridor(2), { yawDeg: 2, dx: 0.1, dz: 0.1 })
  assert(along.details.evidence!.observability! < MIN_OBSERVABILITY, `a corridor is not pinned along itself: ${along.details.evidence!.observability}`)
  const rooms = pair(room(1), room(2))
  assert(rooms.details.evidence!.observability! > 2 * along.details.evidence!.observability!, 'a furnished room is far better pinned')
  // The same room with every wall 7.5 cm further out: a difference in size no move can take away, so a looser fit and a lower score.
  const larger = pair(room(1), room(2, { width: ROOM.width + 0.15, depth: ROOM.depth + 0.15 }))
  assert(larger.details.evidence!.fieldScore! < rooms.details.evidence!.fieldScore!, `${larger.details.evidence!.fieldScore} against ${rooms.details.evidence!.fieldScore}`)
  assert(larger.details.evidence!.inlierRmsM! > rooms.details.evidence!.inlierRmsM!)
})

Deno.test('the query is the scan the search turned: a walk through three rooms against one of them is judged by the room, whichever scan is new', () => {
  const walk = (seed: number) => concatClouds(
    room(seed),
    makeRoom({ width: 5, depth: 5, centre: { x: 15, z: 3 }, noiseM: 0.02, seed: seed + 100, boxes: [{ x: 14, z: 2, w: 0.9, d: 0.7, h: 1.1 }] }),
    makeRoom({ width: 4, depth: 6, centre: { x: 25, z: -3 }, noiseM: 0.02, seed: seed + 200 }),
  )
  const asNew = matchScans({ positions: room(9) }, { positions: misplace(walk(2), ERROR) })
  const asEarlier = matchScans({ positions: walk(2) }, { positions: misplace(room(9), ERROR) })
  for (const [label, result] of [['walk is new', asNew], ['walk is earlier', asEarlier]] as const) {
    const evidence = result.details.evidence!
    assert(evidence.queryInlierShare > 0.95, `${label}: the room's cells all line up with the walk's: ${evidence.queryInlierShare}`)
    assert(evidence.referenceCoverage > 0.9, `${label}: of the walk inside the room's footprint, nearly all is explained: ${evidence.referenceCoverage}`)
  }
  // Whole-of-the-other-scan, as R2 defined coverage, would be about a third here, and the matcher's own number says so.
  assert(asNew.details.movingMatchedFraction < 0.5, 'the walk\'s share that lines up is small')
  assert(asNew.details.evidence!.referenceCoverage > 2 * asNew.details.movingMatchedFraction, 'which is why coverage is read inside the footprint')
  assertAlmostEquals(asNew.details.evidence!.queryInlierShare, asEarlier.details.evidence!.queryInlierShare, 0.03)
  assertAlmostEquals(asNew.details.evidence!.referenceCoverage, asEarlier.details.evidence!.referenceCoverage, 0.05)
})

Deno.test('a room whose furniture was rearranged lines up less, and the share that lines up says so', () => {
  const same = pair(room(1), room(2))
  const rearranged = pair(room(1), room(2, { boxes: [{ x: 4.4, z: 0.8, w: 0.9, d: 0.6, h: 1.0 }, { x: 1.0, z: 3.2, w: 0.5, d: 1.1, h: 0.6 }] }))
  assert(rearranged.details.evidence!.queryInlierShare < same.details.evidence!.queryInlierShare, 'fewer of its cells have a partner')
  assert(rearranged.details.evidence!.queryInlierShare < MIN_QUERY_INLIER_SHARE, `${rearranged.details.evidence!.queryInlierShare}`)
  assert(judgeStartingValues(rearranged.details).failed.includes('query-inliers'))
})

Deno.test('every pair that was searched carries its numbers and its verdict, whether it was proposed or refused', () => {
  const proposed = pair(room(1), room(2))
  assertEquals(proposed.status, 'proposed')
  assertEquals(proposed.details.startingValues, { passed: true, failed: [] })
  // Refused by the matcher's own gate after a search: every wall 7.5 cm further out is a loose fit, and its numbers are kept.
  // (As scan_match.test.ts builds it: the same bare room, 15 cm bigger.)
  const bare = makeRoom({ ...ROOM, noiseM: 0.01, seed: 1 })
  const larger = makeRoom({ width: ROOM.width + 0.15, depth: ROOM.depth + 0.15, centre: ROOM.centre, noiseM: 0.01, seed: 2 })
  const loose = matchScans({ positions: bare }, { positions: misplace(larger, { yawDeg: 1, dx: 0.2, dz: 0.1 }) })
  assertEquals(loose.reason, 'loose-fit')
  assertNotEquals(loose.status, 'proposed')
  assert(loose.details.evidence, 'the numbers of a refused pair are kept')
  assert(loose.details.startingValues && !loose.details.startingValues.passed)
  assert(loose.details.startingValues.failed.includes('inlier-rms'))
  // Refused for size alone: its good match and its numbers are both kept.
  const big = matchScans({ positions: room(1) }, { positions: misplace(room(2), { yawDeg: 0, dx: 3, dz: 0 }) })
  assertEquals(big.reason, 'correction-too-large')
  assert(big.details.evidence && big.details.globalProbe)
})

// ─── Judging a pair against the starting values ──────────────────────────────

function good(): Pick<RegistrationDetails, 'evidence' | 'globalProbe'> {
  return {
    evidence: { fieldScore: 0.92, observability: 0.25, queryInlierShare: 0.97, referenceCoverage: 0.8, inlierRmsM: 0.025 },
    globalProbe: { windowM: 3, windowYawDeg: 180, exclusionM: 1, exclusionYawDeg: 25, secondPeakRatio: 0.5, symmetric: false },
  }
}

Deno.test('judgeStartingValues: a pair that meets all six passes, and each one it misses is named, in the order the job reports them', () => {
  assertEquals(judgeStartingValues(good()), { passed: true, failed: [] })
  const miss = (change: (d: ReturnType<typeof good>) => void) => {
    const details = good()
    change(details)
    return judgeStartingValues(details).failed
  }
  assertEquals(miss((d) => { d.evidence!.fieldScore = 0.79 }), ['field-score'])
  assertEquals(miss((d) => { d.evidence!.observability = 0.11 }), ['observability'])
  assertEquals(miss((d) => { d.evidence!.queryInlierShare = 0.84 }), ['query-inliers'])
  assertEquals(miss((d) => { d.evidence!.referenceCoverage = 0.44 }), ['reference-coverage'])
  assertEquals(miss((d) => { d.evidence!.inlierRmsM = 0.046 }), ['inlier-rms'])
  assertEquals(miss((d) => { d.globalProbe!.secondPeakRatio = 0.95; d.globalProbe!.symmetric = true }), ['global-peak-ratio'])
  // All of them: ambiguity first, then how much lines up, then how closely, then the score.
  assertEquals(
    miss((d) => {
      d.evidence = { fieldScore: 0.1, observability: 0.01, queryInlierShare: 0.1, referenceCoverage: 0.1, inlierRmsM: 0.2 }
      d.globalProbe!.symmetric = true
    }),
    ['global-peak-ratio', 'observability', 'query-inliers', 'reference-coverage', 'inlier-rms', 'field-score'],
  )
})

Deno.test('judgeStartingValues: each value is met at its own number and missed just past it', () => {
  const at = (change: (d: ReturnType<typeof good>) => void) => {
    const details = good()
    change(details)
    return judgeStartingValues(details).passed
  }
  assertEquals(at((d) => { d.evidence!.fieldScore = MIN_FIELD_SCORE }), true)
  assertEquals(at((d) => { d.evidence!.observability = MIN_OBSERVABILITY }), true)
  assertEquals(at((d) => { d.evidence!.queryInlierShare = MIN_QUERY_INLIER_SHARE }), true)
  assertEquals(at((d) => { d.evidence!.referenceCoverage = MIN_REFERENCE_COVERAGE }), true)
  assertEquals(at((d) => { d.evidence!.inlierRmsM = MAX_ACCEPT_RMS_M }), true)
  // The best over the second place, 1.1, is a second place at 0.909 of the best: just under passes, just over does not, whatever the flag says.
  assertEquals(at((d) => { d.globalProbe!.secondPeakRatio = 1 / MIN_GLOBAL_PEAK_RATIO - 0.001 }), true)
  assertEquals(at((d) => { d.globalProbe!.secondPeakRatio = 1 / MIN_GLOBAL_PEAK_RATIO + 0.001 }), false)
  assertEquals(at((d) => { d.globalProbe!.secondPeakRatio = 0 }), true, 'nothing elsewhere at all')
})

Deno.test('judgeStartingValues: what could not be measured is not met', () => {
  assertEquals(judgeStartingValues({}).failed.length, 6, 'no evidence and no probe: nothing is met')
  const noProbe = judgeStartingValues({ evidence: good().evidence })
  assertEquals(noProbe.failed, ['global-peak-ratio'])
  const noField = good()
  noField.evidence!.fieldScore = null
  noField.evidence!.observability = null
  noField.evidence!.inlierRmsM = null
  assertEquals(judgeStartingValues(noField).failed, ['observability', 'inlier-rms', 'field-score'])
})

// ─── The size between two scans ──────────────────────────────────────────────

Deno.test('the sizes tried are eleven, from 0.80 to 1.25, evenly spaced on a log scale, with the middle exactly 1', () => {
  const ladder = scaleLadder()
  assertEquals(ladder.length, 11)
  assertEquals(ladder[0], 0.8)
  assertAlmostEquals(ladder[10]!, 1.25, 1e-12)
  assertEquals(ladder[5], 1)
  const ratios = ladder.slice(1).map((size, i) => size / ladder[i]!)
  for (const ratio of ratios) assertAlmostEquals(ratio, ratios[0]!, 1e-12)
  assertAlmostEquals(ratios[0]!, 1.0456, 0.0005, 'about 4.6% a step')
  // The ladder is its own inverse: a scan too small by a size and a scan too big by it are as easy to find.
  ladder.forEach((size, i) => assertAlmostEquals(size * ladder[10 - i]!, 1, 1e-12))
})

/** The room as a runtime counting in units `size` times as big would record it: every coordinate scaled about the session's origin. */
function scaledAboutOrigin(points: Float32Array, size: number): Float32Array {
  const out = new Float32Array(points.length)
  for (let i = 0; i < points.length; i++) out[i] = points[i]! * size
  return out
}

/** How far the correction leaves the room's floor corners from where they were, once it has been laid on the scaled and misplaced scan. */
function cornerError(transform: readonly number[], size: number, error: Misplacement): number {
  const corners: Array<[number, number, number]> = [[0, 0, 0], [6, 0, 0], [6, 0, 4], [0, 0, 4]]
  let worst = 0
  for (const [x, y, z] of corners) {
    const [sx, sy, sz] = [x * size, y * size, z * size]
    const yaw = (error.yawDeg * Math.PI) / 180
    const mx = Math.cos(yaw) * sx + Math.sin(yaw) * sz + error.dx
    const mz = -Math.sin(yaw) * sx + Math.cos(yaw) * sz + error.dz
    const my = sy
    const tx = transform[0]! * mx + transform[4]! * my + transform[8]! * mz + transform[12]!
    const tz = transform[2]! * mx + transform[6]! * my + transform[10]! * mz + transform[14]!
    worst = Math.max(worst, Math.hypot(tx - x, tz - z))
  }
  return worst
}

Deno.test('with the size search a scan in units that differ by 10% is recovered, with the factor reported, and without it the pair is not matched', () => {
  const error: Misplacement = { yawDeg: 2, dx: 0.1, dz: -0.1 }
  for (const size of [1.1, 0.9]) {
    const moving = misplace(scaledAboutOrigin(room(2), size), error)
    const searched = matchScans({ positions: room(1) }, { positions: moving }, { scaleSearch: true })
    assertEquals(searched.status, 'proposed', `size ${size}: ${searched.reason}`)
    const scale = searched.details.scale!
    assertEquals([scale.searched, scale.steps, scale.minRatio, scale.maxRatio], [true, 11, 0.8, 1.25])
    // The factor the new scan has to be made, to within 2%: a rung is 4.6% wide, and the refinement goes between them.
    assertAlmostEquals(scale.recovered, 1 / size, 0.02)
    assert(cornerError(searched.transform!, size, error) < 0.08, `size ${size}: corners ${cornerError(searched.transform!, size, error)} m out`)
    const size_ = Math.hypot(searched.transform![0]!, searched.transform![2]!)
    assertAlmostEquals(size_, scale.recovered, 1e-9, 'the transform carries the factor the details report')
    assert(searched.inlierResidualM! < MAX_ACCEPT_RMS_M, `rms ${searched.inlierResidualM}`)
    // Without it the same pair is refused or wrong, which is R2's 36%.
    const plain = matchScans({ positions: room(1) }, { positions: moving })
    assert(plain.status !== 'proposed' || cornerError(plain.transform!, size, error) > 0.2, `size ${size}: matched at the wrong size`)
    assertEquals(plain.details.scale, undefined, 'nothing is reported for a search that was not made')
  }
})

Deno.test('the size search gives the thread back between the sizes, and the answer is the one matchScans gives', async () => {
  // One search is a good part of a second on a large room, and eleven of them in a row held a server's one thread for seconds.
  const error: Misplacement = { yawDeg: 2, dx: 0.1, dz: -0.1 }
  const moving = misplace(scaledAboutOrigin(room(2), 1.1), error)
  const options = { scaleSearch: true }
  let yields = 0
  const yielded = await matchScansYielding({ positions: room(1) }, { positions: moving }, options, async () => {
    yields++
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
  // Once after each of the eleven sizes, the last of them before the search that is kept.
  assertEquals(yields, SCALE_SEARCH_STEPS)
  assertEquals(yielded, matchScans({ positions: room(1) }, { positions: moving }, options), 'the same proposal, to the last digit')
  assertEquals(yielded.status, 'proposed')

  // Without a size search there is nothing to give the thread back between, and it is matchScans.
  let plainYields = 0
  const plain = await matchScansYielding({ positions: room(1) }, { positions: misplace(room(2), ERROR) }, {}, async () => { plainYields++ })
  assertEquals(plainYields, 0)
  assertEquals(plain, matchScans({ positions: room(1) }, { positions: misplace(room(2), ERROR) }))

  // A pair turned away before any search yields nothing either, and never throws.
  let emptyYields = 0
  const empty = await matchScansYielding({ positions: new Float32Array(0) }, { positions: room(1) }, options, async () => { emptyYields++ })
  assertEquals([empty.status, emptyYields], ['refused', 0])
})

Deno.test('sizes between two rungs are recovered to a couple of percent, and a room that needs no size change comes back at exactly 1', () => {
  const error: Misplacement = { yawDeg: 1, dx: 0.05, dz: 0.05 }
  for (const size of [1.06, 1.15, 0.84]) {
    const result = matchScans({ positions: room(1) }, { positions: misplace(scaledAboutOrigin(room(2), size), error) }, { scaleSearch: true })
    assertEquals(result.status, 'proposed', `size ${size}: ${result.reason}`)
    assertAlmostEquals(result.details.scale!.recovered, 1 / size, 0.025, `size ${size}`)
  }
  const unchanged = matchScans({ positions: room(1) }, { positions: misplace(room(2), ERROR) }, { scaleSearch: true })
  assertEquals(unchanged.status, 'proposed')
  assertAlmostEquals(unchanged.details.scale!.recovered, 1, 0.01)
  // When the search keeps the size it started with, the move is the one a search of one size gives.
  const plain = matchScans({ positions: room(1) }, { positions: misplace(room(2), ERROR) })
  for (let i = 0; i < 16; i++) assertAlmostEquals(unchanged.transform![i]!, plain.transform![i]!, 0.03, `entry ${i}`)
})

Deno.test('the size search works whichever scan is new: a walk through three rooms in bigger units against one room is laid on it', () => {
  const walk = (seed: number) => concatClouds(
    room(seed),
    makeRoom({ width: 5, depth: 5, centre: { x: 15, z: 3 }, noiseM: 0.02, seed: seed + 100, boxes: [{ x: 14, z: 2, w: 0.9, d: 0.7, h: 1.1 }] }),
    makeRoom({ width: 4, depth: 6, centre: { x: 25, z: -3 }, noiseM: 0.02, seed: seed + 200 }),
  )
  const error: Misplacement = { yawDeg: 2, dx: 0.1, dz: -0.1 }
  const size = 1.1
  // The walk is the new scan, and its units are 10% bigger.
  const result = matchScans({ positions: room(9) }, { positions: misplace(scaledAboutOrigin(walk(2), size), error) }, { scaleSearch: true })
  assertEquals(result.status, 'proposed', `${result.reason}`)
  assertAlmostEquals(result.details.scale!.recovered, 1 / size, 0.025)
  assert(cornerError(result.transform!, size, error) < 0.1, `${cornerError(result.transform!, size, error)} m`)
  // The walk is the earlier scan, and the one room is new in bigger units: the inverse search, the inverse size.
  const turned = matchScans({ positions: walk(2) }, { positions: misplace(scaledAboutOrigin(room(9), size), error) }, { scaleSearch: true })
  assertEquals(turned.status, 'proposed', `${turned.reason}`)
  assertAlmostEquals(turned.details.scale!.recovered, 1 / size, 0.025)
  assert(cornerError(turned.transform!, size, error) < 0.1, `${cornerError(turned.transform!, size, error)} m`)
})

Deno.test('a size search that finds nothing to match reports no size and never throws, and a polygon room is searched like any other', () => {
  const nothing = matchScans({ positions: new Float32Array(0) }, { positions: room(1) }, { scaleSearch: true })
  assertEquals(nothing.status, 'refused')
  assertEquals(nothing.details.scale, undefined)
  const star = (seed: number) => makePolygonRoom({ points: 12, radius: 3, innerRadius: 2, centre: { x: 0, z: 0 }, noiseM: 0.02, seed })
  const searched = matchScans({ positions: star(1) }, { positions: misplace(scaledAboutOrigin(star(2), 1.1), { yawDeg: 1, dx: 0.05, dz: 0.05 }) }, { scaleSearch: true })
  assert(searched.details.scale?.searched === true || searched.status === 'refused')
})
