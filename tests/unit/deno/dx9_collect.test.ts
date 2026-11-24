/**
 * scripts/dx9-collect.ts: the table DX9 is read from. It reads what the job recorded and measures nothing, so these tests pin what it
 * reads from a proposal artifact (the numbers of every pair, the photo method's block, an older record that has neither), what it counts
 * as a pair (distinct, newest run, labelled), what it will and will not open (a session id is a path), and that the script itself runs
 * with read permission alone.
 */
import { assert, assertAlmostEquals, assertEquals } from 'jsr:@std/assert@^1.0.0'
import {
  DX9_CROSS_ROOM_PAIRS,
  DX9_SAME_ROOM_PAIRS,
  formatSummary,
  formatTable,
  keyframeStats,
  latestPerPair,
  type PairRow,
  pairRows,
  placeRegisterResults,
  readWorlds,
  sameRoomOf,
  scanKeyframes,
  summarise,
} from '../../../scripts/dx9-collect.ts'
import {
  PLACE_REGISTER_PROPOSAL_ARTIFACT,
  PLACE_REGISTER_SKIP_ARTIFACT,
  type PlaceRegisterResult,
  type RegistrationProposal,
  type SfmResult,
} from '../../../src/world/register-proposal.ts'
import type { ScanManifest, WorldJob } from '../../../src/world/types.ts'

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]

function ref(scanId: string, name = scanId) {
  return { scanId, filename: `${scanId}.glb`, name, localToWorld: IDENTITY }
}

function bound(translationM: number, maxShiftM: number) {
  return {
    translationM,
    yawDeg: 1,
    dyM: 0,
    maxShiftM,
    withinBound: true,
    bound: { translationM: 1, yawDeg: 10, dyM: 0.3 },
  }
}

function comparison(referenceScanId: string, extra: Record<string, unknown> = {}) {
  return {
    referenceScanId,
    referenceName: `Name of ${referenceScanId}`,
    status: 'proposed',
    reason: null,
    score: 0.9,
    overlapFraction: 0.7,
    inlierResidualM: 0.03,
    elapsedMs: 1200,
    queryInlierShare: 0.95,
    referenceCoverage: 0.6,
    observability: 0.3,
    fieldScore: 0.88,
    globalPeakRatio: 0.5,
    symmetric: false,
    ...extra,
  }
}

function sfmBlock(extra: Partial<SfmResult> & Record<string, unknown> = {}): SfmResult {
  return {
    status: 'proposed',
    reason: null,
    detail: '',
    reference: ref('ref-a', 'Reference A'),
    transform: IDENTITY,
    boundedCorrection: bound(0.2, 0.3),
    residualM: 0.02,
    registeredFraction: 0.8,
    registeredImages: 40,
    offeredImages: 50,
    inliers: 36,
    scaleRatio: 1.02,
    tiltDeg: 0.4,
    sessions: [],
    referenceModel: 'built',
    frameId: 'frame-1',
    params: {},
    elapsedMs: 600000,
    ...extra,
  }
}

function resultOf(options: {
  moving?: string
  reference?: string
  comparisons?: unknown[]
  sfm?: SfmResult
  agreement?: unknown
  comparedAt?: string
  maxShiftM?: number
}): PlaceRegisterResult {
  const referenceId = options.reference ?? 'ref-a'
  const proposal = {
    status: 'proposed',
    transform: IDENTITY,
    inlierResidualM: 0.03,
    overlapFraction: 0.7,
    score: 0.9,
    boundedCorrection: bound(0.2, options.maxShiftM ?? 0.45),
    reason: null,
    details: {},
  } as unknown as RegistrationProposal
  return {
    proposal,
    moving: ref(options.moving ?? 'new-1', 'New scan'),
    reference: ref(referenceId, 'Reference A'),
    comparisons: (options.comparisons ?? [comparison(referenceId)]) as PlaceRegisterResult['comparisons'],
    params: {},
    comparedAt: options.comparedAt ?? '2026-11-01T10:00:00.000Z',
    elapsedMs: 5000,
    ...(options.sfm ? { sfm: options.sfm } : {}),
    ...(options.agreement ? { agreement: options.agreement as PlaceRegisterResult['agreement'] } : {}),
  }
}

function jobOf(result: PlaceRegisterResult | Record<string, unknown>, jobId: string, status: WorldJob['status'] = 'completed'): WorldJob {
  return {
    jobId,
    worldId: 'w1',
    type: 'place-register',
    status,
    capabilities: [],
    artifacts: [{ type: PLACE_REGISTER_PROPOSAL_ARTIFACT, label: 'Proposal', metadata: result as unknown as Record<string, unknown> }],
    createdAt: '2026-11-01T10:00:00.000Z',
    updatedAt: '2026-11-01T10:00:00.000Z',
  }
}

function scan(scanId: string, extra: Partial<ScanManifest> = {}): ScanManifest {
  return { scanId, sessionId: null, filename: `${scanId}.glb`, name: scanId, ...extra } as unknown as ScanManifest
}

// ─── What one artifact gives ─────────────────────────────────────────────────

Deno.test('every compared pair gets a row with the numbers the matcher recorded', () => {
  const result = resultOf({
    comparisons: [
      comparison('ref-a'),
      comparison('ref-b', {
        status: 'refused',
        reason: 'low-score',
        score: 0.41,
        overlapFraction: 0.2,
        inlierResidualM: null,
        symmetric: true,
        globalPeakRatio: 0.97,
        startingValuesFailed: ['score', 'peak'],
        scaleRecovered: 1.08,
      }),
    ],
  })
  const rows = pairRows('slug', { jobs: [jobOf(result, 'job-1')], scans: [scan('new-1')] })
  assertEquals(rows.length, 2)
  const [accepted, refused] = rows
  assertEquals([accepted!.method, accepted!.status, accepted!.best, accepted!.referenceScanId], ['scan-match', 'proposed', true, 'ref-a'])
  assertEquals(
    [accepted!.overlap, accepted!.residualM, accepted!.score, accepted!.queryInlierShare, accepted!.referenceCoverage],
    [0.7, 0.03, 0.9, 0.95, 0.6],
  )
  assertEquals([accepted!.observability, accepted!.fieldScore, accepted!.globalPeakRatio, accepted!.elapsedMs], [0.3, 0.88, 0.5, 1200])
  assertEquals([refused!.status, refused!.reason, refused!.best, refused!.symmetric, refused!.scaleRecovered], ['refused', 'low-score', false, true, 1.08])
  assertEquals(refused!.startingValuesFailed, ['score', 'peak'])
  assertEquals(refused!.residualM, null)
  // Every rejected pair is there: that is what DX9 reads the thresholds from.
  assertEquals(rows.filter((row) => row.status === 'refused').length, 1)
})

Deno.test('the correction is recorded on the best pair only', () => {
  const result = resultOf({ comparisons: [comparison('ref-a'), comparison('ref-b')], maxShiftM: 0.45 })
  const [best, other] = pairRows('slug', { jobs: [jobOf(result, 'job-1')], scans: [scan('new-1')] })
  assertEquals([best!.correctionM, best!.maxShiftM], [0.2, 0.45])
  assertEquals([other!.correctionM, other!.maxShiftM, other!.disagreementWithFitM], [null, null, null])
})

Deno.test('the disagreement with the constellation fit is the gap between how far the walls move and how far the fit said it was off', () => {
  const result = resultOf({ maxShiftM: 0.45 })
  const withFit = scan('new-1', { calibrationFitRmsM: 0.03, calibrationFitMaxM: 0.12 })
  const [row] = pairRows('slug', { jobs: [jobOf(result, 'job-1')], scans: [withFit] })
  assertEquals([row!.fitRmsM, row!.fitMaxM], [0.03, 0.12])
  assertAlmostEquals(row!.disagreementWithFitM!, 0.33, 1e-9)
  // The other way round, so the sign does not matter.
  const [smaller] = pairRows('slug', { jobs: [jobOf(resultOf({ maxShiftM: 0.05 }), 'job-1')], scans: [withFit] })
  assertAlmostEquals(smaller!.disagreementWithFitM!, 0.07, 1e-9)
})

Deno.test('a scan with no constellation fit has no disagreement, and the fit columns are null', () => {
  const [row] = pairRows('slug', { jobs: [jobOf(resultOf({}), 'job-1')], scans: [scan('new-1')] })
  assertEquals([row!.fitRmsM, row!.fitMaxM, row!.disagreementWithFitM], [null, null, null])
  const [noScans] = pairRows('slug', { jobs: [jobOf(resultOf({}), 'job-1')], scans: [] })
  assertEquals(noScans!.fitMaxM, null)
})

Deno.test('a record an earlier build wrote, without the evidence fields, reads with nulls', () => {
  const older = {
    referenceScanId: 'ref-a',
    referenceName: 'A',
    status: 'proposed',
    reason: null,
    score: 0.9,
    overlapFraction: 0.7,
    inlierResidualM: 0.03,
    elapsedMs: 900,
  }
  const [row] = pairRows('slug', { jobs: [jobOf(resultOf({ comparisons: [older] }), 'job-1')], scans: [scan('new-1')] })
  assertEquals(
    [row!.queryInlierShare, row!.referenceCoverage, row!.observability, row!.fieldScore, row!.globalPeakRatio, row!.symmetric, row!.scaleRecovered],
    [null, null, null, null, null, null, null],
  )
  assertEquals(row!.startingValuesFailed, [])
  assertEquals(row!.overlap, 0.7)
})

Deno.test('the photo method gets one row: photographs, inliers, rms, unit mismatch, tilt, time and whether the reference model was reused', () => {
  const result = resultOf({ sfm: sfmBlock({ referenceModel: 'reused' }) })
  const rows = pairRows('slug', { jobs: [jobOf(result, 'job-1')], scans: [scan('new-1', { calibrationFitMaxM: 0.1 })] })
  const photo = rows.find((row) => row.method === 'sfm')!
  assertEquals(rows.length, 2)
  assertEquals([photo.status, photo.best, photo.referenceScanId, photo.referenceModel], ['proposed', true, 'ref-a', 'reused'])
  assertEquals([photo.registeredImages, photo.offeredImages, photo.inliers, photo.residualM, photo.score], [40, 50, 36, 0.02, 0.8])
  assertEquals([photo.scaleRatio, photo.tiltDeg, photo.elapsedMs, photo.correctionM, photo.maxShiftM], [1.02, 0.4, 600000, 0.2, 0.3])
  assertAlmostEquals(photo.disagreementWithFitM!, 0.2, 1e-9)
})

Deno.test('how well the photographs fixed the turn and the size, and how many were left out of the fit, are on the photo row, and an older record has none', () => {
  const measured = resultOf({
    sfm: sfmBlock({ turnUncertaintyDeg: 0.43, sizeUncertainty: 0.0031, fitTrimmedFrames: 2 }),
    agreement: { translationM: 0.07, yawDeg: -0.8, scaleRatio: 1.031, withinBound: true, pivot: [1, 2] },
  })
  const rows = pairRows('slug', { jobs: [jobOf(measured, 'job-1')], scans: [] })
  const photo = rows.find((row) => row.method === 'sfm')!
  assertEquals([photo.turnUncertaintyDeg, photo.sizeUncertainty, photo.fitTrimmedFrames], [0.43, 0.0031, 2])
  for (const row of rows) assertEquals(row.agreementScaleRatio, 1.031, 'the size of the two methods\' agreement is on every row of the job')
  assertEquals(rows.find((row) => row.method === 'scan-match')!.turnUncertaintyDeg, null, 'a wall match has no such number')
  // A refusal for a turn that could not be fixed keeps the number it was refused for.
  const refused = resultOf({ sfm: sfmBlock({ status: 'refused', reason: 'turn-uncertain', transform: null, boundedCorrection: null, residualM: null, turnUncertaintyDeg: 1.4, sizeUncertainty: 0.03 }) })
  const refusedRow = pairRows('slug', { jobs: [jobOf(refused, 'job-2')], scans: [] }).find((row) => row.method === 'sfm')!
  assertEquals([refusedRow.reason, refusedRow.turnUncertaintyDeg, refusedRow.sizeUncertainty], ['turn-uncertain', 1.4, 0.03])
  // A record written before they were measured reads with nulls, and a number that is not one is not believed.
  const older = pairRows('slug', { jobs: [jobOf(resultOf({ sfm: sfmBlock() }), 'job-3')], scans: [] }).find((row) => row.method === 'sfm')!
  assertEquals([older.turnUncertaintyDeg, older.sizeUncertainty, older.fitTrimmedFrames, older.agreementScaleRatio], [null, null, null, null])
  const damaged = pairRows('slug', { jobs: [jobOf(resultOf({ sfm: sfmBlock({ turnUncertaintyDeg: 'wide' as never, sizeUncertainty: Infinity }) }), 'job-4')], scans: [] }).find((row) => row.method === 'sfm')!
  assertEquals([damaged.turnUncertaintyDeg, damaged.sizeUncertainty], [null, null])
  // They are columns of the table.
  const table = formatTable(rows)
  for (const name of ['size +-', 'turn +- deg', 'trimmed']) assert(table.split('\n')[0]!.includes(name), `${name} is not a column`)
})

Deno.test('a photo method that was skipped is a row with its reason and no photograph counts; "not needed" is no row at all', () => {
  const off = resultOf({
    sfm: sfmBlock({ status: 'skipped', reason: 'off', transform: null, boundedCorrection: null, reference: null, residualM: null, registeredFraction: null, registeredImages: 0, offeredImages: 0 }),
  })
  const skipped = pairRows('slug', { jobs: [jobOf(off, 'job-1')], scans: [] }).filter((row) => row.method === 'sfm')
  assertEquals(skipped.length, 1)
  assertEquals([skipped[0]!.status, skipped[0]!.reason, skipped[0]!.registeredImages, skipped[0]!.referenceScanId], ['skipped', 'off', null, ''])

  const notNeeded = resultOf({ sfm: sfmBlock({ status: 'skipped', reason: 'not-needed', transform: null, boundedCorrection: null, reference: null, residualM: null, registeredFraction: null }) })
  assertEquals(pairRows('slug', { jobs: [jobOf(notNeeded, 'job-2')], scans: [] }).filter((row) => row.method === 'sfm').length, 0)
})

Deno.test('a refused photo method keeps its numbers and reason', () => {
  const refused = resultOf({
    sfm: sfmBlock({ status: 'refused', reason: 'too-few-registered', transform: null, boundedCorrection: null, residualM: null, registeredFraction: 0.1, registeredImages: 4, offeredImages: 40, inliers: 0 }),
  })
  const photo = pairRows('slug', { jobs: [jobOf(refused, 'job-1')], scans: [] }).find((row) => row.method === 'sfm')!
  assertEquals([photo.status, photo.reason, photo.best, photo.registeredImages, photo.offeredImages], ['refused', 'too-few-registered', false, 4, 40])
})

Deno.test('the two methods\' agreement is on every row of the job', () => {
  const result = resultOf({ sfm: sfmBlock(), agreement: { translationM: 0.07, yawDeg: -0.8, withinBound: true, pivot: [1, 2] } })
  const rows = pairRows('slug', { jobs: [jobOf(result, 'job-1')], scans: [] })
  for (const row of rows) assertEquals([row.agreementTranslationM, row.agreementYawDeg, row.agreementWithinBound], [0.07, -0.8, true])
})

Deno.test('only completed place-register jobs with a proposal artifact give rows', () => {
  const skipArtifact: WorldJob = {
    ...jobOf(resultOf({}), 'job-skip'),
    artifacts: [{ type: PLACE_REGISTER_SKIP_ARTIFACT, label: 'Skipped', metadata: { reason: 'colmap-missing' } }],
  }
  const other: WorldJob = { ...jobOf(resultOf({}), 'job-other'), type: 'optimize-scan' }
  const failed = jobOf(resultOf({}), 'job-failed', 'failed')
  const damaged = jobOf({ proposal: { status: 'proposed' } }, 'job-damaged')
  const good = jobOf(resultOf({}), 'job-good')
  const found = placeRegisterResults({ jobs: [skipArtifact, other, failed, damaged, good] })
  assertEquals(found.map(({ job }) => job.jobId), ['job-good'])
})

// ─── Which rows count ────────────────────────────────────────────────────────

function row(extra: Partial<PairRow>): PairRow {
  return {
    world: 'slug', jobId: 'j', comparedAt: '2026-11-01T10:00:00.000Z', scanId: 's1', scanName: 'S1', referenceScanId: 's2', referenceName: 'S2',
    method: 'scan-match', best: true, status: 'proposed', reason: null, overlap: 0.7, residualM: 0.03, score: 0.9, queryInlierShare: null,
    referenceCoverage: null, observability: null, fieldScore: null, globalPeakRatio: null, symmetric: null, startingValuesFailed: [],
    scaleRecovered: null, registeredImages: null, offeredImages: null, inliers: null, scaleRatio: null, turnUncertaintyDeg: null,
    sizeUncertainty: null, fitTrimmedFrames: null, tiltDeg: null, referenceModel: null,
    elapsedMs: 1000, agreementTranslationM: null, agreementYawDeg: null, agreementScaleRatio: null, agreementWithinBound: null, correctionM: null, maxShiftM: null,
    fitRmsM: null, fitMaxM: null, disagreementWithFitM: null, keyframes: null, keyframeBytes: null, sameRoom: null,
    ...extra,
  }
}

Deno.test('a pair that was run again is answered by its newest run, per method', () => {
  const rows = [
    row({ jobId: 'old', comparedAt: '2026-11-01T10:00:00.000Z', status: 'refused', reason: 'low-score' }),
    row({ jobId: 'new', comparedAt: '2026-11-02T10:00:00.000Z', status: 'proposed' }),
    row({ jobId: 'photo', comparedAt: '2026-11-01T10:00:00.000Z', method: 'sfm' }),
    row({ jobId: 'other-ref', referenceScanId: 's3' }),
  ]
  assertEquals(latestPerPair(rows).map((r) => r.jobId), ['new', 'photo', 'other-ref'])
  // The same instant: the one that came later in the world's order wins.
  const tie = [row({ jobId: 'first', status: 'refused' }), row({ jobId: 'second' })]
  assertEquals(latestPerPair(tie).map((r) => r.jobId), ['second'])
  // The same pair in two worlds is two pairs.
  assertEquals(latestPerPair([row({ world: 'a' }), row({ world: 'b' })]).length, 2)
})

Deno.test('the summary tallies each method, the reasons, the starting values missed and the timings', () => {
  const rows = [
    row({ status: 'proposed', elapsedMs: 1000 }),
    row({ referenceScanId: 's3', status: 'refused', reason: 'ambiguous', startingValuesFailed: ['peak', 'score'], symmetric: true, elapsedMs: 3000, best: false }),
    row({ referenceScanId: 's4', status: 'refused', reason: 'low-score', startingValuesFailed: ['score'], elapsedMs: 2000, best: false }),
    row({ referenceScanId: 's5', status: 'skipped', reason: 'no-geometry', best: false, elapsedMs: null }),
    row({ method: 'sfm', status: 'refused', reason: 'too-few-registered', elapsedMs: 600000 }),
    row({ method: 'sfm', referenceScanId: 's3', status: 'proposed', elapsedMs: 900000 }),
  ]
  const summary = summarise(rows)
  assertEquals(summary.byMethod['scan-match'], { pairs: 4, proposed: 1, refused: 2, skipped: 1 })
  assertEquals(summary.byMethod.sfm, { pairs: 2, proposed: 1, refused: 1, skipped: 0 })
  assertAlmostEquals(summary.proposedShare['scan-match']!, 1 / 3, 1e-9)
  assertEquals(summary.proposedShare.sfm, 0.5)
  assertEquals(summary.reasons, { ambiguous: 1, 'low-score': 1, 'no-geometry': 1, 'too-few-registered': 1 })
  assertEquals(summary.startingValuesMissed, { peak: 1, score: 2 })
  assertEquals(summary.symmetricPairs, 1)
  assertEquals(summary.runtimeMs, { median: 2000, p95: 3000, max: 3000 })
  assertEquals(summary.photoRuntimeMs.max, 900000)
  // Without labels nothing says which pairs are the same room.
  assertEquals([summary.sameRoom, summary.crossRoom, summary.sample.sufficient], [null, null, null])
  assertEquals(summary.unlabelled, rows.length)
})

Deno.test('an empty table summarises to nothing and divides by nothing', () => {
  const summary = summarise([])
  assertEquals(summary.rows, 0)
  assertEquals([summary.proposedShare['scan-match'], summary.proposedShare.sfm, summary.runtimeMs.median], [null, null, null])
  assertEquals([summary.keyframes.frames, summary.keyframes.meanBytes], [0, null])
  assert(formatSummary(summary).includes('n/a'))
  assertEquals(formatTable([]).split('\n').length, 1)
})

Deno.test('the two methods\' agreement and the fit disagreement are counted over the best pairs only', () => {
  const rows = [
    row({ agreementTranslationM: 0.05, agreementYawDeg: -1, agreementWithinBound: true, disagreementWithFitM: 0.1 }),
    row({ jobId: 'b', scanId: 's9', agreementTranslationM: 0.4, agreementYawDeg: 3, agreementWithinBound: false, disagreementWithFitM: 0.3 }),
    row({ jobId: 'c', scanId: 's8', best: false, agreementTranslationM: 0.9, agreementYawDeg: 9, agreementWithinBound: false, disagreementWithFitM: 5 }),
  ]
  const summary = summarise(rows)
  assertEquals(summary.agreement.pairs, 2)
  assertEquals(summary.agreement.withinBound, 1)
  assertAlmostEquals(summary.agreement.medianTranslationM!, 0.4, 1e-9)
  assertEquals(summary.agreement.medianYawDeg, 3)
  assertEquals(summary.disagreementWithFit.pairs, 2)
  assertAlmostEquals(summary.disagreementWithFit.maxM!, 0.3, 1e-9)
})

// ─── Rooms ───────────────────────────────────────────────────────────────────

Deno.test('same room and cross room come from the labels, and from nothing else', () => {
  const labels = { a: 'kitchen', b: 'kitchen', c: 'hall' }
  assertEquals(sameRoomOf(labels, 'a', 'b'), true)
  assertEquals(sameRoomOf(labels, 'a', 'c'), false)
  assertEquals(sameRoomOf(labels, 'a', 'unlabelled'), null)
  assertEquals(sameRoomOf(null, 'a', 'b'), null)
})

Deno.test('DX9 needs 24 same-room and 252 cross-room pairs', () => {
  assertEquals(DX9_SAME_ROOM_PAIRS, 24)
  assertEquals(DX9_CROSS_ROOM_PAIRS, 252)
})

/** Every pair of 8 rooms of 3 sessions, as the matcher would have answered it: same-room proposed, cross-room refused. */
function everyPair(rooms: number, sessions: number, skip: (a: string, b: string) => boolean = () => false): { rows: PairRow[]; labels: Record<string, string> } {
  const labels: Record<string, string> = {}
  const ids: string[] = []
  for (let r = 0; r < rooms; r++) {
    for (let s = 0; s < sessions; s++) {
      const id = `r${r}s${s}`
      labels[id] = `room-${r}`
      ids.push(id)
    }
  }
  const rows: PairRow[] = []
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      if (skip(ids[i]!, ids[j]!)) continue
      const same = labels[ids[i]!] === labels[ids[j]!]
      rows.push(row({
        scanId: ids[j]!,
        referenceScanId: ids[i]!,
        status: same ? 'proposed' : 'refused',
        reason: same ? null : 'low-score',
        sameRoom: sameRoomOf(labels, ids[i]!, ids[j]!),
      }))
    }
  }
  return { rows, labels }
}

Deno.test('eight rooms of three sessions, every pair searched, is the sample DX9 asks for', () => {
  const { rows } = everyPair(8, 3)
  const summary = summarise(rows, { labelled: true })
  assertEquals([summary.sample.sameRoomPairs, summary.sample.crossRoomPairs, summary.sample.sufficient], [24, 252, true])
  assertEquals(summary.sample.scans, 24)
  assertEquals(summary.sameRoom!['scan-match'], { pairs: 24, proposed: 24, refused: 0, skipped: 0 })
  assertEquals(summary.crossRoom!['scan-match'], { pairs: 252, proposed: 0, refused: 252, skipped: 0 })
  assert(formatSummary(summary).includes('That many pairs were searched'))
})

Deno.test('one pair short of 252 is a smoke test, and so are seven rooms', () => {
  const dropOneCross = everyPair(8, 3, (a, b) => a === 'r0s0' && b === 'r1s0')
  const short = summarise(dropOneCross.rows, { labelled: true })
  assertEquals([short.sample.sameRoomPairs, short.sample.crossRoomPairs, short.sample.sufficient], [24, 251, false])
  assert(formatSummary(short).includes('smoke test'))
  const sevenRooms = summarise(everyPair(7, 3).rows, { labelled: true })
  assertEquals(sevenRooms.sample.sufficient, false)
})

Deno.test('one scan pair is one pair, however many jobs and methods compared it and whichever scan was new', () => {
  const rows = [
    row({ scanId: 'b', referenceScanId: 'a', sameRoom: true }),
    row({ jobId: 'again', scanId: 'b', referenceScanId: 'a', sameRoom: true }),
    row({ jobId: 'photo', scanId: 'b', referenceScanId: 'a', sameRoom: true, method: 'sfm' }),
    row({ jobId: 'reverse', scanId: 'a', referenceScanId: 'b', sameRoom: true }),
    row({ jobId: 'not-run', scanId: 'c', referenceScanId: 'a', sameRoom: true, status: 'skipped' }),
  ]
  const summary = summarise(rows, { labelled: true })
  assertEquals(summary.sample.sameRoomPairs, 1)
  assertEquals(summary.sample.crossRoomPairs, 0)
  assertEquals(summary.sample.sufficient, false)
})

Deno.test('labelled rows split by method, and a pair with an unlabelled scan is neither', () => {
  const rows = [
    row({ sameRoom: true, status: 'proposed' }),
    row({ scanId: 'x', sameRoom: false, status: 'proposed' }),
    row({ scanId: 'y', sameRoom: false, status: 'refused', reason: 'low-score' }),
    row({ scanId: 'z', sameRoom: false, status: 'proposed', method: 'sfm' }),
    row({ scanId: 'w', sameRoom: null }),
  ]
  const summary = summarise(rows, { labelled: true })
  assertEquals(summary.sameRoom!['scan-match'].proposed, 1)
  assertEquals([summary.crossRoom!['scan-match'].proposed, summary.crossRoom!['scan-match'].refused], [1, 1])
  assertEquals(summary.crossRoom!.sfm.proposed, 1)
  assertEquals(summary.unlabelled, 1)
})

// ─── Reading files ───────────────────────────────────────────────────────────

async function tempDir(): Promise<string> {
  return await Deno.makeTempDir({ prefix: 'dx9-collect-' })
}

Deno.test('keyframe bytes and counts come from keyframes.jsonl, and a torn last line is not a frame', async () => {
  const dir = await tempDir()
  try {
    await Deno.writeTextFile(
      `${dir}/keyframes.jsonl`,
      [{ file: 'kf-00000.jpg', bytes: 1000 }, { file: 'kf-00001.jpg', bytes: 3000 }, { file: 'kf-00002.jpg' }].map((r) => JSON.stringify(r)).join('\n') +
        '\n{"file":"kf-00003.jpg","by',
    )
    const stats = await keyframeStats(dir)
    assertEquals([stats.sessions, stats.frames, stats.bytes], [1, 3, 4000])
    assertAlmostEquals(stats.meanBytes!, 4000 / 3, 1e-9)
    assertEquals(await keyframeStats(`${dir}/nowhere`), { sessions: 0, frames: 0, bytes: 0, meanBytes: null })
  } finally {
    await Deno.remove(dir, { recursive: true })
  }
})

Deno.test('a scan\'s session id is a path: only a server session id is ever opened', async () => {
  const dir = await tempDir()
  try {
    await Deno.mkdir(`${dir}/sessions/sess-abc123`, { recursive: true })
    await Deno.writeTextFile(`${dir}/sessions/sess-abc123/keyframes.jsonl`, JSON.stringify({ bytes: 500 }) + '\n')
    // A file a traversal would reach, and a client-minted id that never named a directory.
    await Deno.writeTextFile(`${dir}/keyframes.jsonl`, JSON.stringify({ bytes: 999999 }) + '\n')
    const found = await scanKeyframes(`${dir}/sessions`, [
      { scanId: 'good', sessionId: 'sess-abc123' },
      { scanId: 'traversal', sessionId: '../' },
      { scanId: 'dotdot', sessionId: 'sess-../..' },
      { scanId: 'local', sessionId: 'local-1' },
      { scanId: 'none', sessionId: null },
      { scanId: 'missing', sessionId: 'sess-missing' },
    ])
    assertEquals([...found.keys()], ['good'])
    assertEquals(found.get('good')!.bytes, 500)
  } finally {
    await Deno.remove(dir, { recursive: true })
  }
})

Deno.test('worlds are the .json files that hold jobs and scans; a glb, another json and a torn file are skipped', async () => {
  const dir = await tempDir()
  try {
    await Deno.writeTextFile(`${dir}/b.json`, JSON.stringify({ jobs: [], scans: [] }))
    await Deno.writeTextFile(`${dir}/a.json`, JSON.stringify({ jobs: [], scans: [] }))
    await Deno.writeTextFile(`${dir}/c.json`, JSON.stringify({ somethingElse: true }))
    await Deno.writeTextFile(`${dir}/torn.json`, '{"jobs": [')
    await Deno.writeTextFile(`${dir}/a.world.glb`, 'binary')
    assertEquals((await readWorlds(dir)).map((w) => w.name), ['a', 'b'])
  } finally {
    await Deno.remove(dir, { recursive: true })
  }
})

// ─── The script ──────────────────────────────────────────────────────────────

Deno.test('the script runs with read permission alone, writes nothing, and prints the table and the summary', async () => {
  const dir = await tempDir()
  try {
    const worlds = `${dir}/worlds`
    const sessions = `${dir}/sessions`
    await Deno.mkdir(worlds)
    await Deno.mkdir(`${sessions}/sess-one`, { recursive: true })
    await Deno.writeTextFile(`${sessions}/sess-one/keyframes.jsonl`, JSON.stringify({ file: 'kf-00000.jpg', bytes: 2048 }) + '\n')
    const world = {
      jobs: [jobOf(resultOf({ comparisons: [comparison('ref-a'), comparison('ref-b', { status: 'refused', reason: 'ambiguous', symmetric: true })], sfm: sfmBlock() }), 'job-1')],
      scans: [scan('new-1', { sessionId: 'sess-one', calibrationFitMaxM: 0.1 })],
    }
    await Deno.writeTextFile(`${worlds}/home.json`, JSON.stringify(world))
    await Deno.writeTextFile(`${dir}/labels.json`, JSON.stringify({ 'new-1': 'kitchen', 'ref-a': 'kitchen', 'ref-b': 'hall' }))
    const before = [...Deno.readDirSync(dir)].map((e) => e.name).sort()

    const run = async (...args: string[]) => {
      const out = await new Deno.Command(Deno.execPath(), {
        args: ['run', '--allow-read', '--allow-env=WORLDS_DIR,SESSIONS_DIR,SCANS_DIR', 'scripts/dx9-collect.ts', '--worlds', worlds, '--sessions', sessions, ...args],
        stdout: 'piped',
        stderr: 'piped',
      }).output()
      return { code: out.code, stdout: new TextDecoder().decode(out.stdout), stderr: new TextDecoder().decode(out.stderr) }
    }

    const plain = await run('--labels', `${dir}/labels.json`)
    assertEquals(plain.code, 0, plain.stderr)
    assert(plain.stdout.includes('scan') && plain.stdout.includes('against'), 'the table header')
    assert(plain.stdout.includes('refused: ambiguous'))
    assert(plain.stdout.includes('2048'), 'the keyframe bytes')
    assert(plain.stdout.includes('Same room') && plain.stdout.includes('Cross room'))
    assert(plain.stdout.includes('smoke test'), 'one scan pair is a smoke test, and the summary says so')
    assert(!plain.stdout.includes(dir), 'no path to the files it read is printed')

    const asJson = await run('--json')
    assertEquals(asJson.code, 0, asJson.stderr)
    const parsed = JSON.parse(asJson.stdout) as { rows: PairRow[]; summary: { rows: number } }
    assertEquals(parsed.rows.length, 3)
    assertEquals(parsed.summary.rows, 3)

    const bad = await run('--nonsense')
    assertEquals(bad.code, 2)
    assertEquals([...Deno.readDirSync(dir)].map((e) => e.name).sort(), before)
    assertEquals([...Deno.readDirSync(worlds)].map((e) => e.name), ['home.json'])
  } finally {
    await Deno.remove(dir, { recursive: true })
  }
})
