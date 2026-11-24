/**
 * The place-register job with the photo method behind it: what runs when, what the artifact says, and what a person may apply.
 *
 * The method itself is place_register_sfm.test.ts and the matcher is scan_match.test.ts. This file is the seam between them in
 * `runPlaceRegisterJob`: the wall match goes first because it is cheap; the photo method follows when the wall match proposed nothing
 * or when the run was asked for it, and never when it is off, which the artifact says; both answers land in one artifact with how
 * far apart they are; a patch from either is held to what its method proposed, and one job is applied once.
 *
 * The scans are one synthetic room seen twice, the second time through a placement error injected on purpose. The wall match reads
 * the clouds. The photo method reads keyframe sessions whose cameras really stood in the room, and a stand-in COLMAP (sfm_fixtures.ts)
 * that answers from where they stood. Both have the same truth, so when they are right they agree, and a test that wants them to
 * disagree moves one of them.
 */
import { assert, assertAlmostEquals, assertEquals, assertMatch, assertNotEquals } from 'jsr:@std/assert@^1.0.0'

import {
  applyStartingValues,
  asksForSfm,
  guardRegistrationPatch,
  PLACE_REGISTER_ENFORCE_STARTING_VALUES,
  type PlaceRegisterHost,
  type PlaceRegisterSfmHost,
  runPlaceRegisterJob,
  unitsDiffer,
} from '../../../server/register/place_register.ts'
import { WORK_ROOT_DIR } from '../../../server/register/sfm_workspace.ts'
import { WorldJobPump } from '../../../server/world/world_job_pump.ts'
import {
  buildRegisterPatch,
  describeAgreement,
  PLACE_REGISTER_PROPOSAL_ARTIFACT,
  PLACE_REGISTER_SKIP_ARTIFACT,
  type PlaceRegisterResult,
  readPlaceRegisterResult,
  type RegistrationProposal,
  type StartingValue,
} from '../../../src/world/register-proposal.ts'
import type { EditPatch, ScanManifest, WorldJob, WorldProject } from '../../../src/world/types.ts'
import { pointCloudGlb } from '../../fixtures/place-register/point-cloud-glb.ts'
import { makeRoom } from '../../fixtures/place-register/synthetic-room.ts'
import {
  fakeColmap,
  type FakeColmap,
  MIDDLE,
  ringSpec,
  ringViews,
  scanManifest,
  sessionTruth,
  storedMatrix,
  type ToySessionSpec,
  type V3,
  worldOf,
  writeFakeSession,
} from './sfm_fixtures.ts'
import { mulVec, transpose } from './toy_sfm_scene.ts'

const SLUG = 'project-proj-sfm'
const PROJECT = 'proj-sfm'
const FRAME = 'frame-aaa'
const ERROR = { yawDeg: 4, shift: [0.35, 0, -0.25] as V3 }

/** The room the two scans are of, asymmetric, so that the wall match accepts it. 5 x 4 m round MIDDLE, where the cameras walk. */
const FURNITURE = [{ x: 1.4, z: 2.4, w: 0.8, d: 0.6, h: 0.9 }, { x: 4.0, z: 3.2, w: 1.0, d: 0.5, h: 0.5 }, { x: 4.4, z: 1.0, w: 0.6, d: 0.4, h: 1.2 }]
const room = (seed: number, boxes = FURNITURE) =>
  makeRoom({ width: 5, depth: 4, centre: { x: 2.5, z: 2 }, noiseM: 0.02, boxes, seed })

/** A cloud as a session recorded it: the Place-frame points through the inverse of the session's true frame. */
function inSessionFrame(points: Float32Array, spec: ToySessionSpec): Float32Array {
  const truth = sessionTruth(spec)
  const toSession = transpose(truth.rotation)
  const out = new Float32Array(points.length)
  for (let i = 0; i < points.length; i += 3) {
    const local = mulVec(toSession, [points[i]! - truth.translation[0], points[i + 1]! - truth.translation[1], points[i + 2]! - truth.translation[2]])
    out[i] = local[0] / truth.unit
    out[i + 1] = local[1] / truth.unit
    out[i + 2] = local[2] / truth.unit
  }
  return out
}

interface Fixture {
  root: string
  sessionsDir: string
  current: WorldProject
  glbs: Map<string, Uint8Array | null>
  fake: FakeColmap
  sfm: PlaceRegisterSfmHost
  log: { commits: number; fails: string[] }
  host: PlaceRegisterHost
  ref: ScanManifest
  moving: ScanManifest
  cleanup(): Promise<void>
}

function job(payload?: Record<string, unknown>, jobId = 'job-new'): WorldJob {
  return {
    jobId,
    worldId: 'world-sfm',
    type: 'place-register',
    status: 'processing',
    scanId: 'scan-new',
    capabilities: [],
    ...(payload ? { payload } : {}),
    progress: 0.35,
    createdAt: '2026-11-16T10:00:00.000Z',
    updatedAt: '2026-11-16T10:00:00.000Z',
  }
}

async function fixture(options: {
  boxes?: typeof FURNITURE
  /** A newer scan in the Place whose photographs are the earlier scan's exactly and whose walls are 8 m from everything. */
  decoy?: boolean
  /** How many photographs the decoy has: more than the earlier scan's, and the photo method prefers it. */
  decoyViews?: number
  sfmOn?: boolean
  noHost?: boolean
  noGlb?: boolean
  payload?: Record<string, unknown>
  movingOverrides?: Partial<ScanManifest>
  referenceOverrides?: Partial<ScanManifest>
  newOffset?: V3
  colmap?: Parameters<typeof fakeColmap>[0] extends infer T ? Partial<T> : never
} = {}): Promise<Fixture> {
  const root = await Deno.makeTempDir({ prefix: 'sfm-job-' })
  const sessionsDir = `${root}/scans/sessions`
  const refSpec = ringSpec('sess-sfm-ref')
  const newSpec = ringSpec('sess-sfm-new', {
    yawDeg: 25,
    origin: [1.2, 0, -0.7],
    views: ringViews(MIDDLE, [1.0, 1.2], 14, 10, 1.35, 12),
    seed: 102,
  })
  const decoySpec = ringSpec('sess-sfm-decoy', {}, options.decoyViews ?? 14)
  await writeFakeSession(sessionsDir, refSpec, { glbFilename: 'scan-ref.glb' })
  await writeFakeSession(sessionsDir, newSpec, { glbFilename: 'scan-new.glb' })
  if (options.decoy) await writeFakeSession(sessionsDir, decoySpec, { glbFilename: 'scan-decoy.glb' })

  const boxes = options.boxes ?? FURNITURE
  const ref = scanManifest('scan-ref', refSpec.sessionId, storedMatrix(refSpec, { yawDeg: 0, shift: [0, 0, 0] }), { calibrationFrameId: FRAME, projectId: PROJECT, capturedAt: '2026-11-10T09:00:00.000Z' })
  const moving = scanManifest('scan-new', newSpec.sessionId, storedMatrix(newSpec, ERROR), {
    calibrationFrameId: FRAME,
    projectId: PROJECT,
    capturedAt: '2026-11-12T09:00:00.000Z',
    ...options.movingOverrides,
  })
  Object.assign(ref, options.referenceOverrides)
  const decoy = options.decoy
    ? scanManifest('scan-decoy', decoySpec.sessionId, storedMatrix(decoySpec, { yawDeg: 0, shift: [0, 0, 0] }), { calibrationFrameId: FRAME, projectId: PROJECT, capturedAt: '2026-11-11T09:00:00.000Z' })
    : null
  const offset = options.newOffset ?? [0, 0, 0]
  const newCloud = inSessionFrame(room(2, boxes), newSpec)
  // A cloud that disagrees with the photographs: the same room as the new session would have it if it stood elsewhere.
  if (offset.some((v) => v !== 0)) for (let i = 0; i < newCloud.length; i += 3) { newCloud[i]! += offset[0]; newCloud[i + 2]! += offset[2] }
  const glbs = new Map<string, Uint8Array | null>(
    options.noGlb
      ? [[ref.filename, null], [moving.filename, null]]
      : [[ref.filename, await pointCloudGlb(inSessionFrame(room(1, boxes), refSpec))], [moving.filename, await pointCloudGlb(newCloud)]],
  )
  if (decoy) {
    const faraway = inSessionFrame(room(3, boxes), decoySpec)
    for (let i = 0; i < faraway.length; i += 3) faraway[i]! += 8
    glbs.set(decoy.filename, await pointCloudGlb(faraway))
  }
  const current: WorldProject = {
    worldId: 'world-sfm',
    name: 'Test place',
    shareSlug: SLUG,
    projectId: PROJECT,
    originGeoPose: { lat: null, lng: null, altitudeM: null, bearing: null, accuracyM: null },
    localFrame: { type: 'ENU_Y_UP', origin: { lat: null, lng: null, altitudeM: null, bearing: null, accuracyM: null }, units: 'meters', axes: { x: 'east', y: 'up', z: 'north' } },
    scans: decoy ? [ref, decoy, moving] : [ref, moving],
    things: [],
    thingObservations: [],
    members: [],
    jobs: [job(options.payload)],
    editPatches: [],
    createdAt: '2026-11-10T09:00:00.000Z',
    updatedAt: '2026-11-10T09:00:00.000Z',
  }
  const fake = fakeColmap({ world: worldOf(decoy ? [refSpec, newSpec, decoySpec] : [refSpec, newSpec]), ...options.colmap })
  const sfm: PlaceRegisterSfmHost = {
    enabled: options.sfmOn ?? true,
    sessionsDir,
    workRoot: (projectId) => `${root}/scans/projects/${projectId}/${WORK_ROOT_DIR}`,
    readScanMeta: async () => ({ frameEpochs: { calibrationEpoch: 0 } }),
    colmapBin: Deno.execPath(),
    _spawn: fake.spawn,
    placeFrameId: async () => FRAME,
  }
  const log = { commits: 0, fails: [] as string[] }
  const host: PlaceRegisterHost = {
    claim: async (_slug, jobId) => {
      const found = current.jobs.find((candidate) => candidate.jobId === jobId)
      const owner = found && current.scans.find((candidate) => candidate.scanId === found.scanId)
      return found && owner ? { scan: owner, payload: found.payload } : null
    },
    loadWorld: async () => structuredClone(current),
    readScanGlbBytes: async (filename) => glbs.get(filename) ?? null,
    commit: async (_slug, jobId, mutate) => {
      const found = current.jobs.find((candidate) => candidate.jobId === jobId)
      if (!found) return null
      log.commits++
      return mutate(found, current)
    },
    fail: async (_slug, jobId, reason) => {
      log.fails.push(reason)
      const found = current.jobs.find((candidate) => candidate.jobId === jobId)
      if (found) {
        found.status = 'failed'
        found.error = reason
      }
    },
    now: () => '2026-11-16T10:00:01.000Z',
    ...(options.noHost ? {} : { sfm }),
  }
  return { root, sessionsDir, current, glbs, fake, sfm, log, host, ref, moving, cleanup: () => Deno.remove(root, { recursive: true }), }
}

async function withFixture(options: Parameters<typeof fixture>[0], body: (f: Fixture) => Promise<void>): Promise<void> {
  const f = await fixture(options)
  try {
    await body(f)
  } finally {
    await f.cleanup()
  }
}

function resultOf(f: Fixture): PlaceRegisterResult {
  const result = readPlaceRegisterResult(f.current.jobs[0]!)
  assert(result, `the job left no proposal artifact: ${f.current.jobs[0]!.status} ${f.current.jobs[0]!.result}`)
  return result
}

// ─── When the photo method runs ──────────────────────────────────────────────

Deno.test('place-register with photos: the wall match goes first, and a move it proposed is not followed by a photo solve nobody asked for', async () => {
  await withFixture({}, async (f) => {
    await runPlaceRegisterJob(f.host, SLUG, 'job-new')
    const result = resultOf(f)
    assertEquals(result.proposal.status, 'proposed', `${result.proposal.reason}`)
    assertEquals(result.sfm?.status, 'skipped')
    assertEquals(result.sfm?.reason, 'not-needed')
    assertEquals(f.fake.calls.length, 0, 'COLMAP was not run')
    assertEquals(result.agreement, undefined)
    assertEquals(f.current.jobs[0]!.status, 'completed')
  })
})

Deno.test('place-register with photos: a run that asks for it gets both methods, side by side, with how far apart they are', async () => {
  await withFixture({ payload: { method: 'sfm' } }, async (f) => {
    await runPlaceRegisterJob(f.host, SLUG, 'job-new')
    const result = resultOf(f)
    assertEquals(result.proposal.status, 'proposed', `${result.proposal.reason}`)
    assertEquals(result.sfm?.status, 'proposed', `${result.sfm?.reason}: ${result.sfm?.detail}`)
    assertEquals(result.sfm?.reference?.scanId, 'scan-ref')
    // Both are corrections of one scan in one frame, built from the same truth, so they agree.
    assert(result.agreement, 'the two proposals are compared')
    assert(result.agreement!.translationM < 0.1, `${result.agreement!.translationM} m apart`)
    assert(Math.abs(result.agreement!.yawDeg) < 1.5, `${result.agreement!.yawDeg} degrees apart`)
    assertEquals(result.agreement!.withinBound, true)
    assertEquals(result.agreement!.pivot.length, 2)
    // Neither moved anything.
    assertEquals(f.current.scans.find((scan) => scan.scanId === 'scan-new')!.localToWorld, f.moving.localToWorld)
    assert(f.current.jobs[0]!.result?.includes('photos'), f.current.jobs[0]!.result)
    assert(!/aligned|verified/i.test(f.current.jobs[0]!.result ?? ''))
    // Nothing is left of the run.
    assertEquals(await listDir(`${f.root}/scans/projects/${PROJECT}/${WORK_ROOT_DIR}`), [])
  })
})

Deno.test('place-register with photos: two methods that disagree by more than the bound are recorded as disagreeing, and neither is the job\'s answer', async () => {
  // The cloud of the new scan stands 0.6 m from where its photographs say it does.
  await withFixture({ payload: { method: 'sfm' }, newOffset: [0.6, 0, 0.0] }, async (f) => {
    await runPlaceRegisterJob(f.host, SLUG, 'job-new')
    const result = resultOf(f)
    assertEquals(result.sfm?.status, 'proposed')
    if (result.proposal.status === 'proposed') {
      assert(result.agreement, 'both proposed, so they are compared')
      assertEquals(result.agreement!.withinBound, false)
      assert(result.agreement!.translationM > 0.15, `${result.agreement!.translationM}`)
    }
  })
})

Deno.test('place-register with photos: a wall match that proposed nothing is followed by the photo method without being asked', async () => {
  // An empty rectangle looks the same turned round, so the walls cannot settle one position. The photographs can.
  await withFixture({ boxes: [] }, async (f) => {
    await runPlaceRegisterJob(f.host, SLUG, 'job-new')
    const result = resultOf(f)
    assertEquals(result.proposal.status, 'refused')
    assertEquals(result.proposal.reason, 'ambiguous')
    assertEquals(result.sfm?.status, 'proposed', `${result.sfm?.reason}`)
    assertEquals(result.agreement, undefined, 'one method proposed, so there is nothing to compare')
    assert(f.fake.calls.length > 0)
    // The wall match's refusal carries every number it measured, for DX9, and the verdict that refused it.
    const row = result.comparisons[0]!
    assertEquals(row.status, 'refused')
    assertEquals(row.symmetric, true)
    assert(row.globalPeakRatio! >= 0.9)
    assert(row.startingValuesFailed?.includes('global-peak-ratio'))
    assert(row.queryInlierShare! > 0.9 && row.referenceCoverage! > 0.9, 'the other numbers are there too')
    assert(row.observability! > 0.12 && row.fieldScore! > 0.8)
  })
})

Deno.test('place-register with photos: the photo method tries the wall match\'s best reference first, and keeps it unless another earlier scan\'s photographs overlap the new scan\'s more', async () => {
  // The newer scan has exactly the earlier scan's photographs, so the two tie on everything the photo method ranks by, and its walls are 8 m
  // away, so the wall match turns it away and proposes against the earlier one. Left to its own order the photo method would take the newer.
  await withFixture({ decoy: true, payload: { method: 'sfm' } }, async (f) => {
    await runPlaceRegisterJob(f.host, SLUG, 'job-new')
    const result = resultOf(f)
    assertEquals(result.proposal.status, 'proposed', `${result.proposal.reason}`)
    assertEquals(result.reference.scanId, 'scan-ref')
    assertEquals(result.sfm?.status, 'proposed', `${result.sfm?.reason}: ${result.sfm?.detail}`)
    assertEquals(result.sfm?.reference?.scanId, 'scan-ref')
    assertEquals(result.comparisons.map((row) => [row.referenceScanId, row.status]).sort(), [['scan-decoy', 'refused'], ['scan-ref', 'proposed']])
  })
})

Deno.test('place-register with photos: when another earlier scan\'s photographs overlap more, the photo method answers for that one, and the card says the two were compared with different scans', async () => {
  // The decoy has 24 photographs to the earlier scan's 14 and the same poses, so the photo method takes it; its walls are 8 m away, so the
  // wall match proposes against the earlier scan. Each method measures against the scan it chose and the record says which.
  await withFixture({ decoy: true, decoyViews: 24, payload: { method: 'sfm' } }, async (f) => {
    await runPlaceRegisterJob(f.host, SLUG, 'job-new')
    const result = resultOf(f)
    assertEquals(result.proposal.status, 'proposed', `${result.proposal.reason}`)
    assertEquals(result.reference.scanId, 'scan-ref')
    assertEquals(result.sfm?.status, 'proposed', `${result.sfm?.reason}: ${result.sfm?.detail}`)
    assertEquals(result.sfm?.reference?.scanId, 'scan-decoy')
    assert(result.agreement, 'both proposed, so they are compared')
    assert(describeAgreement(result)!.text.includes('They were compared with different earlier scans.'), describeAgreement(result)!.text)
    // And with the same earlier scan for both, it does not say so.
    await withFixture({ payload: { method: 'sfm' } }, async (g) => {
      await runPlaceRegisterJob(g.host, SLUG, 'job-new')
      assertEquals(describeAgreement(resultOf(g))!.text.includes('different earlier scans'), false)
    })
  })
})

Deno.test('place-register with photos: the job\'s own words lead with what the walls did when only the photos proposed, and end as every proposal\'s do', async () => {
  // An empty rectangle looks the same turned round, so the walls refuse and the photographs propose.
  await withFixture({ boxes: [] }, async (f) => {
    await runPlaceRegisterJob(f.host, SLUG, 'job-new')
    const text = f.current.jobs[0]!.result!
    assertMatch(text, /^The walls of "Scan scan-new" did not settle a move: The walls do not settle one position\. Compared with "Scan scan-ref"\./)
    assertMatch(text, / The photos of "Scan scan-new" propose \d+ cm and a \d\.\d° turn\. Nothing moves until you apply it in the editor\.$/)
    assertEquals(/No move proposed/.test(text), false, 'it does not say no move was proposed while saying the photos propose one')
    assertEquals(/\b(aligned|verified)\b/i.test(text), false)
  })
  // Nothing proposed by either keeps its words, and a wall match that proposed ends as it did.
  await withFixture({ boxes: [], colmap: { drop: (name) => name.startsWith('sess-sfm-new/') } }, async (f) => {
    await runPlaceRegisterJob(f.host, SLUG, 'job-new')
    const text = f.current.jobs[0]!.result!
    assertMatch(text, /^No move proposed for "Scan scan-new": The walls do not settle one position\. Compared with "Scan scan-ref"\. Photo matching: Too few of this scan's photos found their place\.$/)
  })
  await withFixture({}, async (f) => {
    await runPlaceRegisterJob(f.host, SLUG, 'job-new')
    assertMatch(f.current.jobs[0]!.result!, /^Proposed a move for "Scan scan-new": .* Nothing moves until you apply it in the editor\.$/)
  })
})

Deno.test('place-register with photos: it says so when the photo method is off, asked for or not, and the wall match is as it always was', async () => {
  for (const payload of [{ method: 'sfm' }, undefined]) {
    await withFixture({ sfmOn: false, payload }, async (f) => {
      await runPlaceRegisterJob(f.host, SLUG, 'job-new')
      const result = resultOf(f)
      assertEquals(result.proposal.status, 'proposed')
      // "Off" is the reason even when the wall match proposed a move and nobody asked: it is what the card says about the switch.
      assertEquals([result.sfm?.status, result.sfm?.reason], ['skipped', 'off'], JSON.stringify(payload))
      assertEquals(f.fake.calls.length, 0)
    })
  }
})

Deno.test('place-register with photos: a server with no photo host at all writes the artifact it always wrote', async () => {
  await withFixture({ noHost: true }, async (f) => {
    await runPlaceRegisterJob(f.host, SLUG, 'job-new')
    const result = resultOf(f)
    assertEquals(result.proposal.status, 'proposed')
    assertEquals('sfm' in result, false)
    assertEquals('agreement' in result, false)
  })
})

Deno.test('place-register with photos: with no readable cloud the photo method answers alone, and the card is told the walls were not compared', async () => {
  await withFixture({ noGlb: true, payload: { method: 'sfm' } }, async (f) => {
    await runPlaceRegisterJob(f.host, SLUG, 'job-new')
    const job_ = f.current.jobs[0]!
    assertEquals(job_.artifacts![0]!.type, PLACE_REGISTER_PROPOSAL_ARTIFACT)
    const result = resultOf(f)
    assertEquals(result.comparisons.length, 0, 'no wall comparison was made')
    assertEquals(result.proposal.status, 'refused')
    assertEquals(result.proposal.reason, 'too-few-points', 'the card reads this as walls that could not be compared')
    assertEquals(result.proposal.transform, null)
    assertEquals(result.sfm?.status, 'proposed')
    assertEquals(result.reference.scanId, 'scan-ref')
    assert(job_.result!.includes('could not be compared'), job_.result)
  })
})

Deno.test('place-register with photos: with nothing to read from either method the job is the skip it always was', async () => {
  await withFixture({ noGlb: true, sfmOn: false }, async (f) => {
    await runPlaceRegisterJob(f.host, SLUG, 'job-new')
    assertEquals(f.current.jobs[0]!.artifacts![0]!.type, PLACE_REGISTER_SKIP_ARTIFACT)
    assertEquals(f.current.jobs[0]!.status, 'completed')
  })
  // The photo method ran and had no photographs: the walls could not be read either, so there is nothing to show.
  await withFixture({ noGlb: true, payload: { method: 'sfm' }, movingOverrides: { sessionId: null } }, async (f) => {
    await rm(`${f.sessionsDir}/sess-sfm-new`)
    await runPlaceRegisterJob(f.host, SLUG, 'job-new')
    assertEquals(f.current.jobs[0]!.artifacts![0]!.type, PLACE_REGISTER_SKIP_ARTIFACT)
  })
})

async function rm(path: string): Promise<void> {
  await Deno.remove(path, { recursive: true })
}

async function listDir(path: string): Promise<string[]> {
  const names: string[] = []
  try {
    for await (const entry of Deno.readDir(path)) names.push(entry.name)
  } catch { /* none */ }
  return names.sort()
}

Deno.test('place-register with photos: a photo method that throws does not take the wall match down with it', async () => {
  await withFixture({ payload: { method: 'sfm' }, colmap: {} }, async (f) => {
    f.sfm._spawn = () => {
      throw new Error('boom')
    }
    await runPlaceRegisterJob(f.host, SLUG, 'job-new')
    const result = resultOf(f)
    assertEquals(result.proposal.status, 'proposed')
    assertEquals([result.sfm?.status, result.sfm?.reason], ['refused', 'colmap-failed'])
    assertEquals(f.log.fails, [])
  })
})

Deno.test('asksForSfm: only a payload that says method sfm is a request', () => {
  assertEquals(asksForSfm({ method: 'sfm' }), true)
  for (const payload of [undefined, {}, { method: 'SFM' }, { method: 'scan-match' }, { method: true }, { sfm: true }, { source: 'joined-place' }]) {
    assertEquals(asksForSfm(payload as never), false, JSON.stringify(payload))
  }
})

// ─── One job at a time ───────────────────────────────────────────────────────

Deno.test('place-register with photos: the photo method runs inside the one job pump, one job at a time, and a stuck pump is not a second COLMAP', async () => {
  await withFixture({ payload: { method: 'sfm' } }, async (f) => {
    // Two requests for the same scan, as a double press and a second tab would make. COLMAP counts how many commands are in flight.
    f.current.jobs.push(job({ method: 'sfm' }, 'job-new-2'))
    let active = 0
    let most = 0
    const inner = f.fake.spawn
    f.sfm._spawn = async (bin, args) => {
      active++
      most = Math.max(most, active)
      try {
        await new Promise((resolve) => setTimeout(resolve, 3))
        return await inner(bin, args)
      } finally {
        active--
      }
    }
    const order: string[] = []
    const pump = new WorldJobPump(async (slug, jobId) => {
      order.push(`start ${jobId}`)
      await runPlaceRegisterJob(f.host, slug, jobId)
      order.push(`end ${jobId}`)
    })
    pump.enqueue(SLUG, 'job-new')
    pump.enqueue(SLUG, 'job-new-2')
    while (pump.isWorking || pump.pendingCount > 0) await new Promise((resolve) => setTimeout(resolve, 10))
    assertEquals(order, ['start job-new', 'end job-new', 'start job-new-2', 'end job-new-2'])
    assertEquals(most, 1, 'no two COLMAP commands ran at once')
    assertEquals(f.current.jobs.map((j) => j.status), ['completed', 'completed'])
    assertEquals(await listDir(`${f.root}/scans/projects/${PROJECT}/${WORK_ROOT_DIR}`), [])
  })
})

// ─── The starting acceptance values ──────────────────────────────────────────

function proposal(failed: StartingValue[] | null): RegistrationProposal {
  return {
    status: 'proposed',
    transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0.1, 0, 0, 1],
    overlapFraction: 0.9,
    inlierResidualM: 0.03,
    score: 0.9,
    boundedCorrection: null,
    reason: null,
    details: {
      movingCells: 1, referenceCells: 1, movingMatchedFraction: 1, referenceMatchedFraction: 1, distinctiveness: 1, fit: 1, peakRatio: 0,
      nearBestReachM: 0.4, verticalChecked: true, searchedTranslationM: 2, searchedYawDeg: 30,
      ...(failed ? { startingValues: { passed: failed.length === 0, failed } } : {}),
    },
  }
}

Deno.test('applyStartingValues: a proposal that misses a starting value becomes the matcher\'s own refusal for the first one it missed, with no transform', () => {
  const reasons: Record<StartingValue, string> = {
    'global-peak-ratio': 'ambiguous',
    'observability': 'ambiguous',
    'query-inliers': 'low-overlap',
    'reference-coverage': 'low-overlap',
    'inlier-rms': 'loose-fit',
    'field-score': 'low-score',
  }
  assertEquals(PLACE_REGISTER_ENFORCE_STARTING_VALUES, true, 'the brief\'s recommendation is the default')
  for (const [value, reason] of Object.entries(reasons)) {
    const refused = applyStartingValues(proposal([value as StartingValue, 'field-score']))
    assertEquals([refused.status, refused.reason, refused.transform], ['refused', reason, null], value)
    assertEquals(refused.score, 0.9, 'the numbers it measured are kept')
  }
  assertEquals(applyStartingValues(proposal([])).status, 'proposed')
  assertEquals(applyStartingValues(proposal(null)).status, 'proposed', 'a record with no verdict is left as it is')
  const already = { ...proposal(['field-score']), status: 'refused' as const, transform: null, reason: 'ambiguous' as const }
  assertEquals(applyStartingValues(already), already)
})

Deno.test('unitsDiffer: only two recorded units that are not the same differ; an unrecorded unit says nothing', () => {
  assertEquals(unitsDiffer({ scaleMode: 'absolute-ready' }, { scaleMode: 'responsive-unconfigured' }), true)
  assertEquals(unitsDiffer({ scaleMode: 'responsive-originY:1.4' }, { scaleMode: 'webxr-metric' }), true)
  assertEquals(unitsDiffer({ scaleMode: 'absolute-ready' }, { scaleMode: 'absolute-ready' }), false)
  assertEquals(unitsDiffer({}, { scaleMode: 'absolute-ready' }), false)
  assertEquals(unitsDiffer({}, {}), false)
  // The metre by contract is the metre, whatever the runtime is called.
  assertEquals(unitsDiffer({ scaleMode: 'webxr-metric' }, { scaleMode: 'native-metric' }), false)
})

// ─── Applying what either method proposed ────────────────────────────────────

async function proposedBoth(): Promise<{ f: Fixture; result: PlaceRegisterResult }> {
  const f = await fixture({ payload: { method: 'sfm' } })
  await runPlaceRegisterJob(f.host, SLUG, 'job-new')
  return { f, result: resultOf(f) }
}

function patchOf(f: Fixture, body: NonNullable<ReturnType<typeof buildRegisterPatch>>): EditPatch {
  return {
    patchId: 'patch-1',
    worldId: f.current.worldId,
    scanId: body.scanId,
    targetId: body.targetId,
    scope: 'scan',
    transform: body.transform,
    provenance: body.provenance,
    createdAt: '2026-11-16T10:05:00.000Z',
  }
}

Deno.test('guardRegistrationPatch: a photo-method patch is held to what the photo method proposed, and writes its method into the provenance', async () => {
  const { f, result } = await proposedBoth()
  try {
    const body = buildRegisterPatch(result, 'job-new', 'sfm')!
    assertEquals(body.provenance.method, 'sfm')
    assertEquals(body.provenance.score, result.sfm!.registeredFraction)
    assertEquals(body.provenance.residualM, result.sfm!.residualM)
    const guard = guardRegistrationPatch(f.current, body)
    assertEquals(guard.kind, 'ok')
    assert(guard.kind === 'ok')
    assertEquals(guard.provenance, { source: 'place-register', jobId: 'job-new', score: result.sfm!.registeredFraction as number, residualM: result.sfm!.residualM as number, method: 'sfm' })

    // The wall match's patch is the wall match's: its provenance has no method, and its matrix is the wall match's.
    const walls = buildRegisterPatch(result, 'job-new')!
    assertEquals('method' in walls.provenance, false)
    const wallsGuard = guardRegistrationPatch(f.current, walls)
    assertEquals(wallsGuard.kind, 'ok')
    assertNotEquals(body.transform.matrix, walls.transform.matrix, 'two methods, two answers (close, not identical)')

    // A matrix that is the other method's with this method's name on it is refused, and so are numbers that are not this method's.
    assertEquals(guardRegistrationPatch(f.current, { ...body, transform: walls.transform }).kind, 'refused')
    assertEquals(guardRegistrationPatch(f.current, { ...body, provenance: { ...body.provenance, score: result.sfm!.registeredFraction! - 0.2 } }).kind, 'refused')
    assertEquals(guardRegistrationPatch(f.current, { ...body, provenance: { ...body.provenance, residualM: 0.001 } }).kind, 'refused')
    // A method this server has not heard of.
    assertEquals(guardRegistrationPatch(f.current, { ...body, provenance: { ...body.provenance, method: 'magic' } as never }).kind, 'refused')
  } finally {
    await f.cleanup()
  }
})

Deno.test('guardRegistrationPatch: one job is applied once, by whichever method was pressed first, and the other method\'s patch then gets the first back', async () => {
  const { f, result } = await proposedBoth()
  try {
    const photo = buildRegisterPatch(result, 'job-new', 'sfm')!
    f.current.editPatches.push(patchOf(f, photo))
    f.current.scans.find((scan) => scan.scanId === 'scan-new')!.localToWorld = photo.transform.matrix
    const walls = buildRegisterPatch(result, 'job-new')!
    const again = guardRegistrationPatch(f.current, walls)
    assertEquals(again.kind, 'duplicate')
    const same = guardRegistrationPatch(f.current, photo)
    assertEquals(same.kind, 'duplicate')
  } finally {
    await f.cleanup()
  }
})

Deno.test('guardRegistrationPatch: a photo patch is stale when the scan it was measured against has moved, and for a job whose photo method proposed nothing it is refused', async () => {
  const { f, result } = await proposedBoth()
  try {
    const photo = buildRegisterPatch(result, 'job-new', 'sfm')!
    f.current.scans.find((scan) => scan.scanId === 'scan-ref')!.localToWorld = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0.5, 0, 0, 1]
    const stale = guardRegistrationPatch(f.current, photo)
    assert(stale.kind === 'refused' && stale.status === 409, JSON.stringify(stale))
  } finally {
    await f.cleanup()
  }
  // A job whose photo method was skipped has no photo proposal to apply.
  const g = await fixture({})
  try {
    await runPlaceRegisterJob(g.host, SLUG, 'job-new')
    const skipped = resultOf(g)
    assertEquals(buildRegisterPatch(skipped, 'job-new', 'sfm'), null)
    const forged = { ...buildRegisterPatch(skipped, 'job-new')!, provenance: { source: 'place-register' as const, jobId: 'job-new', score: 1, residualM: 0.01, method: 'sfm' as const } }
    const guard = guardRegistrationPatch(g.current, forged)
    assert(guard.kind === 'refused' && guard.status === 400, JSON.stringify(guard))
  } finally {
    await g.cleanup()
  }
})

// ─── The size between two scans ──────────────────────────────────────────────

Deno.test('place-register: scans whose sessions ran in different units are matched for size too, and the factor recovered is on the proposal and the row', async () => {
  // The new scan's session counts in units 12% bigger than metres. Its cloud is the room in those units.
  await withFixture({ movingOverrides: { scaleMode: 'responsive-unconfigured' }, referenceOverrides: { scaleMode: 'webxr-metric' } }, async (f) => {
    const spec = ringSpec('sess-sfm-new', { yawDeg: 25, origin: [1.2, 0, -0.7], unit: 1.12, views: ringViews(MIDDLE, [1.0, 1.2], 14, 10, 1.35, 12), seed: 102 })
    f.glbs.set(f.moving.filename, await pointCloudGlb(inSessionFrame(room(2), spec)))
    await runPlaceRegisterJob(f.host, SLUG, 'job-new')
    const result = resultOf(f)
    const scale = result.proposal.details.scale
    assert(scale && scale.searched, 'the size was searched')
    // The scan is carried to the Place at the size its stored placement gives it (1), so it must be made 1.12 times as big.
    assertAlmostEquals(scale!.recovered, 1.12, 0.03)
    assertAlmostEquals(result.comparisons[0]!.scaleRecovered!, 1.12, 0.03)
    assertEquals(result.proposal.status, 'proposed', `${result.proposal.reason}`)
    assertAlmostEquals(Math.hypot(result.proposal.transform![0]!, result.proposal.transform![2]!), 1.12, 0.03)
  })
})

Deno.test('place-register: scans in the same unit are not searched for size, which costs about five times as much', async () => {
  await withFixture({ movingOverrides: { scaleMode: 'responsive-unconfigured' }, referenceOverrides: { scaleMode: 'responsive-unconfigured' } }, async (f) => {
    await runPlaceRegisterJob(f.host, SLUG, 'job-new')
    assertEquals(resultOf(f).proposal.details.scale, undefined)
  })
})
