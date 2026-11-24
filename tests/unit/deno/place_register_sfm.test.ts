/**
 * The photo method of `place-register` (server/register/place_register_sfm.ts) from end to end, with COLMAP stood in for.
 *
 * Nothing here runs COLMAP. `fakeColmap` (sfm_fixtures.ts) answers each command with the model files a real run would write, built
 * from a known truth: where every camera really was in the Place frame, and a solver frame that is that frame turned, moved and
 * resized. What is tested is therefore what this repo owns: the commands the method gives COLMAP (CPU only, one camera per session,
 * the reference's cameras held fixed, every photograph read where its session keeps it), the reference model that is made once and kept, the algebra that
 * carries the new session into the Place frame, the proposal that comes out of it (gravity kept, a size carried, a bound held), and
 * every reason it has to refuse. The real binary is exercised by place_register_sfm_toy.test.ts behind COLMAP_E2E=1.
 *
 * Every refusal has a test that provokes it and a check that nothing was left on disk afterwards: the work directory is gone however
 * the run ended.
 */
import { assert, assertAlmostEquals, assertEquals, assertNotEquals } from 'jsr:@std/assert@^1.0.0'

import {
  type ColmapSpawn,
} from '../../../server/colmap/colmap_reference.ts'
import {
  gravityConstrained,
  runSfmRegistration,
  type SfmHost,
  type SfmRequest,
  SFM_MAX_FRAMES_PER_SESSION,
  SFM_MAX_NEW_SESSIONS,
  SFM_MIN_REGISTERED_IMAGES,
  skippedResult,
} from '../../../server/register/place_register_sfm.ts'
import { applySim3, describeCorrection, sim3FromColumnMajor } from '../../../server/register/sim3_chain.ts'
import { referenceCacheDir, WORK_ROOT_DIR } from '../../../server/register/sfm_workspace.ts'
import { checkPlacementMatrix } from '../../../src/world/scan-placement.ts'
import { multiplyMat4 } from '../../../src/world/register-proposal.ts'
import type { ScanManifest } from '../../../src/world/types.ts'
import {
  fakeColmap,
  type FakeColmapOptions,
  MIDDLE,
  ringSpec,
  ringViews,
  scanManifest,
  sessionTruth,
  type SolverFrame,
  storedMatrix,
  type ToySessionSpec,
  turnAbout,
  type V3,
  worldOf,
  writeFakeSession,
} from './sfm_fixtures.ts'
import { gaussian, mulberry32, mulVec } from './toy_sfm_scene.ts'
import { SOLVER } from './sfm_fixtures.ts'

const FRAME = 'frame-aaa'
const PROJECT = 'proj-sfm'

/** The new session's true frame: another heading and origin than the reference's, and the calibration error this exists to find. */
const NEW_ERROR = { yawDeg: 4, shift: [0.35, 0, -0.25] as V3 }
const NO_ERROR = { yawDeg: 0, shift: [0, 0, 0] as V3 }

function newSpec(overrides: Partial<ToySessionSpec> = {}, views = 14): ToySessionSpec {
  return ringSpec('sess-sfm-new', {
    yawDeg: 25,
    origin: [1.2, 0, -0.7],
    views: ringViews(MIDDLE, [1.0, 1.2], views, 10, 1.35, 12),
    seed: 102,
    ...overrides,
  }, views)
}

interface Scenario {
  root: string
  sessionsDir: string
  workRoot: string
  refSpec: ToySessionSpec
  newSpec: ToySessionSpec
  ref: ScanManifest
  moving: ScanManifest
  request: SfmRequest
  host: SfmHost
  fake: ReturnType<typeof fakeColmap>
  /** Every spawn the host made, with the work directory's state at the time: what the run left lying about while COLMAP was working. */
  cleanup(): Promise<void>
  workDirs(): Promise<string[]>
}

async function listDir(path: string): Promise<string[]> {
  const names: string[] = []
  try {
    for await (const entry of Deno.readDir(path)) names.push(entry.name)
  } catch { /* not there */ }
  return names.sort()
}

async function scenario(options: {
  colmap?: Partial<FakeColmapOptions>
  newError?: typeof NEW_ERROR
  newOverrides?: Partial<ToySessionSpec>
  views?: number
  extraNewSpecs?: ToySessionSpec[]
  host?: Partial<SfmHost>
  movingOverrides?: Partial<ScanManifest>
  referenceOverrides?: Partial<ScanManifest>
  writeNew?: boolean
  writeRef?: boolean
  /** The Place frame as the solver sees it; the default tilts, shifts and shrinks it. */
  solver?: SolverFrame
  /** Changes to the earlier scan's session: its recorded positions noisier, say. */
  refSpecOverrides?: Partial<ToySessionSpec>
} = {}): Promise<Scenario> {
  const root = await Deno.makeTempDir({ prefix: 'sfm-method-' })
  const sessionsDir = `${root}/scans/sessions`
  const workRoot = `${root}/scans/projects/${PROJECT}/${WORK_ROOT_DIR}`
  const views = options.views ?? 14
  const refSpec = ringSpec('sess-sfm-ref', options.refSpecOverrides ?? {}, views)
  const nSpec = newSpec(options.newOverrides, views)
  const extra = options.extraNewSpecs ?? []
  if (options.writeRef !== false) await writeFakeSession(sessionsDir, refSpec, { glbFilename: 'scan-ref.glb' })
  if (options.writeNew !== false) await writeFakeSession(sessionsDir, nSpec, { glbFilename: 'scan-new.glb' })
  for (const spec of extra) await writeFakeSession(sessionsDir, spec, { glbFilename: 'scan-new.glb' })

  const ref = scanManifest('scan-ref', refSpec.sessionId, storedMatrix(refSpec, NO_ERROR), { calibrationFrameId: FRAME, ...options.referenceOverrides })
  const moving = scanManifest('scan-new', nSpec.sessionId, storedMatrix(nSpec, options.newError ?? NEW_ERROR), {
    calibrationFrameId: FRAME,
    capturedAt: '2026-11-12T09:00:00.000Z',
    ...options.movingOverrides,
  })
  const fake = fakeColmap({ world: worldOf([refSpec, nSpec, ...extra], options.solver), ...options.colmap })
  const host: SfmHost = {
    enabled: true,
    sessionsDir,
    workRoot: (projectId) => `${root}/scans/projects/${projectId}/${WORK_ROOT_DIR}`,
    readScanMeta: async () => ({ frameEpochs: { calibrationEpoch: 0 } }),
    jobId: 'job-sfm-1',
    colmapBin: Deno.execPath(),
    _spawn: fake.spawn,
    ...options.host,
  }
  return {
    root,
    sessionsDir,
    workRoot,
    refSpec,
    newSpec: nSpec,
    ref,
    moving,
    request: { place: { projectId: PROJECT, frameId: FRAME }, moving, references: [ref] },
    host,
    fake,
    cleanup: () => Deno.remove(root, { recursive: true }),
    workDirs: () => listDir(workRoot),
  }
}

/** Where the new scan's recorded cameras end up, in the Place frame, when its placement is `matrix`, against where they really were. RMS, metres. */
function placementError(s: Scenario, matrix: number[], truthSpec: ToySessionSpec = s.newSpec, truthOf: (place: V3) => V3 = (place) => place): number {
  const placement = sim3FromColumnMajor(matrix)!
  const truth = truthSpec.views
  const recorded = recordedCentres(truthSpec)
  let sum = 0
  recorded.forEach((c, k) => {
    const here = applySim3(placement, c)
    const there = truthOf(truth[k]!.position)
    sum += (here[0] - there[0]) ** 2 + (here[1] - there[1]) ** 2 + (here[2] - there[2]) ** 2
  })
  return Math.sqrt(sum / recorded.length)
}

/** The positions the session recorded, noise included, read from the file the way the method reads it. */
function recordedCentres(spec: ToySessionSpec): V3[] {
  const text = Deno.readTextFileSync(`${currentSessionsDir}/${spec.sessionId}/keyframes.jsonl`)
  return text.trim().split('\n').map((line) => {
    const p = JSON.parse(line).pose.position as { x: number; y: number; z: number }
    return [p.x, p.y, p.z] as V3
  })
}
let currentSessionsDir = ''

async function withScenario(options: Parameters<typeof scenario>[0], body: (s: Scenario) => Promise<void>): Promise<void> {
  const s = await scenario(options)
  currentSessionsDir = s.sessionsDir
  try {
    await body(s)
  } finally {
    await s.cleanup()
  }
}

function assertNoLeftovers(s: Scenario): Promise<void> {
  return s.workDirs().then((dirs) => assertEquals(dirs, [], 'the work directory is gone'))
}

// ─── The proposal ────────────────────────────────────────────────────────────

Deno.test('sfm: a new session is registered against the reference and the move that undoes the injected calibration error is proposed', async () => {
  await withScenario({}, async (s) => {
    const { result, pivot } = await runSfmRegistration(s.host, s.request)
    assertEquals(result.status, 'proposed', `${result.reason}: ${result.detail}`)
    assertEquals(result.reason, null)
    assertEquals(result.referenceModel, 'built')
    assertEquals(result.reference?.scanId, 'scan-ref')
    assertEquals([result.registeredImages, result.offeredImages, result.registeredFraction], [14, 14, 1])
    assertEquals(result.inliers, 14)
    assertEquals(result.frameId, FRAME)
    assert(pivot !== null && pivot.every(Number.isFinite))

    // The placement the proposal gives the scan is where its cameras really were, to the noise on the recorded positions.
    assert(isMatrix(result.transform), 'a proposal carries its transform')
    const corrected = multiplyMat4(result.transform!, s.moving.localToWorld)
    const before = placementError(s, s.moving.localToWorld)
    const after = placementError(s, corrected)
    assert(before > 0.3, `the calibration was ${before} m out to start with`)
    assert(after < 0.04, `the cameras are ${after} m from where they were, after the move`)

    // The numbers a person reads are the measurement: the move the calibration error implies, and the fit's own gap.
    const stored = s.moving.localToWorld
    const centres = recordedCentres(s.newSpec)
    const truth = sessionTruth(s.newSpec)
    const expected = describeCorrection({ rotation: truth.rotation, translation: truth.translation, scale: truth.unit }, stored, centres)!
    assertAlmostEquals(result.boundedCorrection!.yawDeg, expected.bounded.yawDeg, 1)
    assertAlmostEquals(result.boundedCorrection!.translationM, expected.bounded.translationM, 0.05)
    assertEquals(result.boundedCorrection!.withinBound, true)
    assert(result.residualM! < 0.05, `rms ${result.residualM}`)
    // Both runtimes are metric here, and the fits' scales agree to well under the 2% that would be carried.
    assertAlmostEquals(result.scaleRatio!, 1, 0.02)
    assert(result.tiltDeg! < 1.5, `up axes ${result.tiltDeg} degrees apart`)
    assertEquals(result.sessions.length, 1)
    assertEquals(result.sessions[0]!.status, 'proposed')
    await assertNoLeftovers(s)
  })
})

function isMatrix(m: unknown): m is number[] {
  return Array.isArray(m) && m.length === 16 && m.every(Number.isFinite)
}

Deno.test('sfm: the proposal is gravity-constrained: a turn about up, a shift and a size, with the tilt left out and reported', async () => {
  await withScenario({}, async (s) => {
    const { result } = await runSfmRegistration(s.host, s.request)
    const m = result.transform!
    // Column 1 of a correction that only turns about +Y and resizes is (0, size, 0), and the x and z columns have no vertical part.
    assertAlmostEquals(m[4]!, 0, 1e-9)
    assertAlmostEquals(m[6]!, 0, 1e-9)
    assertAlmostEquals(m[1]!, 0, 1e-9)
    assertAlmostEquals(m[9]!, 0, 1e-9)
    assertAlmostEquals(m[5]!, 1, 1e-9)
    assert(result.tiltDeg !== null, 'the tilt that was dropped is on the record')
    // What the server would be asked to store is a placement it accepts.
    assertEquals(checkPlacementMatrix(multiplyMat4(m, s.moving.localToWorld)).ok, true)
  })
})

Deno.test('sfm: the unit mismatch between two runtimes is recorded and carried into the proposal as a size', async () => {
  await withScenario({ newOverrides: { unit: 1.12 } }, async (s) => {
    const { result } = await runSfmRegistration(s.host, s.request)
    assertEquals(result.status, 'proposed', `${result.reason}: ${result.detail}`)
    // Place metres per unit of the new session: the unit mismatch, measured to a third of a percent on this room.
    assertAlmostEquals(result.scaleRatio!, 1.12, 0.02)
    assertAlmostEquals(result.sessions[0]!.scaleRatio!, 1.12, 0.02)
    // The calibration is rigid, so the correction is the size and the move together.
    const size = Math.hypot(result.transform![0]!, result.transform![2]!)
    assertAlmostEquals(size, 1.12, 0.02)
    const corrected = multiplyMat4(result.transform!, s.moving.localToWorld)
    assert(placementError(s, corrected) < 0.06, `${placementError(s, corrected)} m`)
  })
})

Deno.test('sfm: a unit difference inside the noise of the two fits is recorded and not carried', async () => {
  await withScenario({ newOverrides: { unit: 1.006 } }, async (s) => {
    const { result } = await runSfmRegistration(s.host, s.request)
    assertEquals(result.status, 'proposed', `${result.reason}: ${result.detail}`)
    assertAlmostEquals(result.scaleRatio!, 1.006, 0.01)
    assertAlmostEquals(Math.hypot(result.transform![0]!, result.transform![2]!), 1, 1e-9, 'the scan is not resized by the scatter of the fits')
  })
})

// ─── What COLMAP is told ─────────────────────────────────────────────────────

Deno.test('sfm: every command is CPU only, each session has a camera of its own, and the reference is registered against with its cameras held fixed', async () => {
  await withScenario({}, async (s) => {
    await runSfmRegistration(s.host, s.request)
    assertEquals(s.fake.steps(), [
      'feature_extractor', 'matches_importer', 'mapper', 'mapper', // the reference, solved once
      'feature_extractor', 'matches_importer', 'mapper(register)', // the new session, against it
    ])
    for (const call of s.fake.calls) {
      const flags = call.join(' ')
      assert(!/use_gpu 1/.test(flags), `a command asked for the GPU: ${call[0]}`)
      if (call[0] === 'feature_extractor') {
        assert(flags.includes('--FeatureExtraction.use_gpu 0'), 'features on the CPU')
        assert(flags.includes('--ImageReader.single_camera_per_folder 1'), 'one camera per session')
        assert(!flags.includes('--ImageReader.single_camera 1 '), 'not one camera for everything')
      }
      if (call[0] === 'matches_importer') {
        assert(flags.includes('--match_type pairs') && flags.includes('--FeatureMatching.use_gpu 0'), 'the pairs, on the CPU')
      }
    }
    const registerCall = s.fake.calls.find((call) => call.includes('--Mapper.fix_existing_frames'))!
    assertEquals(registerCall[registerCall.indexOf('--Mapper.fix_existing_frames') + 1], '1')
    assert(registerCall.includes('--input_path'), 'registered into the reference model')
    // The first extraction is the reference's frames alone, the second the new session's alone.
    const lists = s.fake.calls.filter((call) => call[0] === 'feature_extractor').map((call) => call[call.indexOf('--image_list_path') + 1]!)
    assert(lists[0]!.endsWith('sess-sfm-ref.txt') && lists[1]!.endsWith('sess-sfm-new.txt'), lists.join(' '))
  })
})

/** Every path under `dir` with what it is, without following a link. */
async function walkWithKinds(dir: string): Promise<Array<{ path: string; kind: 'file' | 'dir' | 'link' }>> {
  const found: Array<{ path: string; kind: 'file' | 'dir' | 'link' }> = []
  const visit = async (path: string): Promise<void> => {
    for await (const entry of Deno.readDir(path)) {
      const here = `${path}/${entry.name}`
      const stat = await Deno.lstat(here)
      found.push({ path: here, kind: stat.isSymlink ? 'link' : stat.isDirectory ? 'dir' : 'file' })
      if (stat.isDirectory) await visit(here)
    }
  }
  try {
    await visit(dir)
  } catch { /* not there */ }
  return found
}

Deno.test('sfm: COLMAP reads each photograph where its session keeps it: no frame is linked or copied, and the new session\'s matches are all pairs that involve it', async () => {
  const seen = { lists: [] as string[][], roots: new Set<string>(), inWorkDir: [] as string[], pairs: [] as string[][], walks: 0 }
  await withScenario({
    colmap: {
      onCall: async (args) => {
        if (args.includes('--image_path')) seen.roots.add(args[args.indexOf('--image_path') + 1]!)
        if (args[0] === 'feature_extractor') {
          const list = (await Deno.readTextFile(args[args.indexOf('--image_list_path') + 1]!)).trim().split('\n')
          seen.lists.push(list)
        }
        if (args[0] === 'matches_importer') {
          seen.pairs.push((await Deno.readTextFile(args[args.indexOf('--match_list_path') + 1]!)).trim().split('\n'))
        }
        // While COLMAP is "running": whatever the run has put in its work directory.
        const database = args[args.indexOf('--database_path') + 1]
        if (database) {
          // The run's directory is `run-<job>-<unique>`: the part of the database's path up to the end of that folder.
          const at = database.indexOf('/run-job-sfm-1-')
          const kinds = await walkWithKinds(database.slice(0, database.indexOf('/', at + 1)))
          seen.walks += at >= 0 ? 1 : 0
          for (const entry of kinds) if (entry.kind === 'link' || /\.(jpe?g|png)$/i.test(entry.path)) seen.inWorkDir.push(entry.path)
        }
      },
    },
  }, async (s) => {
    await runSfmRegistration(s.host, s.request)
    // One image root for every command, and it is the sessions folder itself.
    assertEquals([...seen.roots], [await Deno.realPath(s.sessionsDir)])
    // Each extraction lists only the frames of its own session, by the name every other step uses.
    assertEquals(seen.lists.length, 2)
    const names = (session: string) => Array.from({ length: 14 }, (_, i) => `${session}/kf-${String(i).padStart(5, '0')}.jpg`)
    assertEquals(seen.lists[0], names('sess-sfm-ref'))
    assertEquals(seen.lists[1], names('sess-sfm-new'))
    // No photograph, link to one, or picture of any kind is in the work directory at any point, and the directory was looked at.
    assertEquals(seen.inWorkDir, [])
    assert(seen.walks >= 7, `the work directory was looked at while COLMAP ran: ${seen.walks} times`)
    // The reference's own pairs were matched when it was made; the registration matches only pairs with a new photograph in them.
    const registration = seen.pairs[1]!
    assert(registration.length > 0, 'the registration matched pairs')
    assert(registration.every((line) => line.includes('sess-sfm-new/')), 'no pair of the reference with itself is matched again')
    assert(registration.some((line) => line.includes('sess-sfm-ref/')), 'the new session is matched against the reference')
  })
})

// ─── The reference model is made once ────────────────────────────────────────

Deno.test('sfm: the reference model is kept inside the earlier scan\'s session and reused by the next run, which solves only the new photographs', async () => {
  await withScenario({}, async (s) => {
    const first = await runSfmRegistration(s.host, s.request)
    assertEquals(first.result.referenceModel, 'built')
    const cache = referenceCacheDir(`${s.sessionsDir}/sess-sfm-ref`)
    assertEquals((await listDir(cache)), ['db.db', 'reference.json', 'sparse'])
    const manifest = JSON.parse(await Deno.readTextFile(`${cache}/reference.json`))
    assertEquals([manifest.projectId, manifest.frameId, manifest.scanId, manifest.sessionId], [PROJECT, FRAME, 'scan-ref', 'sess-sfm-ref'])

    const again = fakeColmap({ world: worldOf([s.refSpec, s.newSpec]) })
    const second = await runSfmRegistration({ ...s.host, _spawn: again.spawn, jobId: 'job-sfm-2' }, s.request)
    assertEquals(second.result.status, 'proposed')
    assertEquals(second.result.referenceModel, 'reused')
    assertEquals(again.steps(), ['feature_extractor', 'matches_importer', 'mapper(register)'])
    // Same photographs, same answer.
    assertEquals(second.result.transform, first.result.transform)
    // Nothing in the new session's directory, and the reference's cache is untouched by the registration (it was only read and copied).
    assertEquals(await listDir(`${s.sessionsDir}/sess-sfm-new`), ['keyframes.jsonl', 'kf-00000.jpg', 'kf-00001.jpg', 'kf-00002.jpg', 'kf-00003.jpg', 'kf-00004.jpg', 'kf-00005.jpg', 'kf-00006.jpg', 'kf-00007.jpg', 'kf-00008.jpg', 'kf-00009.jpg', 'kf-00010.jpg', 'kf-00011.jpg', 'kf-00012.jpg', 'kf-00013.jpg', 'session.json'])
    await assertNoLeftovers(s)
  })
})

Deno.test('sfm: a cache made for another frame generation, other photographs, another scan or another epoch is removed and made again', async () => {
  for (const [label, change] of [
    // The Place's reference was replaced, and both scans were calibrated against the new one.
    ['frame generation', (s: Scenario) => ({
      place: { ...s.request.place, frameId: 'frame-bbb' },
      moving: { ...s.moving, calibrationFrameId: 'frame-bbb' },
      references: [{ ...s.ref, calibrationFrameId: 'frame-bbb' }],
    })],
    ['scan', (s: Scenario) => ({ ...s.request, references: [{ ...s.ref, scanId: 'scan-other' }] })],
    ['place', (s: Scenario) => ({ ...s.request, place: { ...s.request.place, projectId: 'proj-other' } })],
  ] as const) {
    await withScenario({}, async (s) => {
      await runSfmRegistration(s.host, s.request)
      const manifestPath = `${referenceCacheDir(`${s.sessionsDir}/sess-sfm-ref`)}/reference.json`
      const before = await Deno.readTextFile(manifestPath)
      const fake = fakeColmap({ world: worldOf([s.refSpec, s.newSpec]) })
      const request = change(s)
      const second = await runSfmRegistration({ ...s.host, _spawn: fake.spawn, jobId: 'job-2' }, request as SfmRequest)
      assertEquals(second.result.referenceModel, 'built', `${label}: a cache for something else is not reused`)
      assertEquals(fake.steps().slice(0, 4), ['feature_extractor', 'matches_importer', 'mapper', 'mapper'], label)
      assertNotEquals(await Deno.readTextFile(manifestPath), before, `${label}: the cache was replaced`)
    })
  }
})

Deno.test('sfm: when the Place\'s reference is replaced, the model made for the old one is removed even though no run will use that scan again', async () => {
  await withScenario({}, async (s) => {
    await runSfmRegistration(s.host, s.request)
    const cache = referenceCacheDir(`${s.sessionsDir}/sess-sfm-ref`)
    assertEquals(await listDir(cache), ['db.db', 'reference.json', 'sparse'])
    // The Place has a new frame; the earlier scan was calibrated against the old one and is left out of the comparison.
    const fake = fakeColmap({ world: worldOf([s.refSpec, s.newSpec]) })
    const { result } = await runSfmRegistration(
      { ...s.host, _spawn: fake.spawn, jobId: 'job-2' },
      { place: { projectId: PROJECT, frameId: 'frame-bbb' }, moving: { ...s.moving, calibrationFrameId: 'frame-bbb' }, references: [s.ref] },
    )
    assertEquals([result.status, result.reason], ['skipped', 'frame-mismatch'])
    assertEquals(fake.calls.length, 0)
    assertEquals(await listDir(cache), [], 'the stale model is gone')
    // A model for the Place's current frame is left alone by the same sweep.
    const again = await runSfmRegistration({ ...s.host, jobId: 'job-3', _spawn: fakeColmap({ world: worldOf([s.refSpec, s.newSpec]) }).spawn }, s.request)
    assertEquals(again.result.referenceModel, 'built')
    await runSfmRegistration({ ...s.host, jobId: 'job-4', _spawn: fakeColmap({ world: worldOf([s.refSpec, s.newSpec]) }).spawn }, s.request)
    assertEquals(await listDir(cache), ['db.db', 'reference.json', 'sparse'])
  })
})

Deno.test('sfm: a cache whose photographs have changed, or whose manifest is damaged or half made, is not used and is removed', async () => {
  await withScenario({}, async (s) => {
    await runSfmRegistration(s.host, s.request)
    const cache = referenceCacheDir(`${s.sessionsDir}/sess-sfm-ref`)
    // A photograph replaced by another of the same size: the fingerprint is of the bytes.
    await Deno.writeFile(`${s.sessionsDir}/sess-sfm-ref/kf-00003.jpg`, new Uint8Array([0xff, 0xd8, 0xff, 0xc0, 0, 0x11, 8, 1, 224, 2, 128, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1, 0xff, 0xd9, 99]))
    const fake = fakeColmap({ world: worldOf([s.refSpec, s.newSpec]) })
    const second = await runSfmRegistration({ ...s.host, _spawn: fake.spawn, jobId: 'job-2' }, s.request)
    assertEquals(second.result.referenceModel, 'built')

    // A manifest that is not JSON, and a cache with no manifest at all (cut short while it was being made).
    await Deno.writeTextFile(`${cache}/reference.json`, '{not json')
    const third = fakeColmap({ world: worldOf([s.refSpec, s.newSpec]) })
    assertEquals((await runSfmRegistration({ ...s.host, _spawn: third.spawn, jobId: 'job-3' }, s.request)).result.referenceModel, 'built')
    await Deno.remove(`${cache}/reference.json`)
    const fourth = fakeColmap({ world: worldOf([s.refSpec, s.newSpec]) })
    assertEquals((await runSfmRegistration({ ...s.host, _spawn: fourth.spawn, jobId: 'job-4' }, s.request)).result.referenceModel, 'built')
  })
})

Deno.test('sfm: a reference session deleted while its model is being made is not given a cache, and no directory is recreated for it', async () => {
  await withScenario({
    colmap: {
      onCall: async (args) => {
        if (args[0] === 'mapper' && !args.includes('--input_path')) await Deno.remove(`${currentSessionsDir}/sess-sfm-ref`, { recursive: true })
      },
    },
  }, async (s) => {
    const { result } = await runSfmRegistration(s.host, s.request)
    assertEquals(result.status, 'skipped')
    assertEquals(result.reason, 'no-reference')
    assertEquals(await listDir(`${s.sessionsDir}/sess-sfm-ref`), [], 'no folder of camera data was made for a session that no longer exists')
    await assertNoLeftovers(s)
  })
})

// ─── What it does not run ────────────────────────────────────────────────────

Deno.test('sfm: it is a skip, with a reason and no COLMAP command, when the switch is off, the Place cannot hold files, or the scan has no photographs', async () => {
  await withScenario({ host: { enabled: false } }, async (s) => {
    const { result } = await runSfmRegistration(s.host, s.request)
    assertEquals([result.status, result.reason], ['skipped', 'off'])
    assertEquals(s.fake.calls.length, 0)
    assertEquals(await listDir(s.workRoot), [], 'nothing was made')
  })
  await withScenario({ host: { workRoot: () => null } }, async (s) => {
    assertEquals((await runSfmRegistration(s.host, s.request)).result.reason, 'no-place')
  })
  await withScenario({ writeNew: false }, async (s) => {
    assertEquals((await runSfmRegistration(s.host, s.request)).result.reason, 'no-keyframes')
  })
  await withScenario({ writeRef: false }, async (s) => {
    assertEquals((await runSfmRegistration(s.host, s.request)).result.reason, 'no-reference')
    assertEquals(s.fake.calls.length, 0)
  })
  // Photographs that carry no AR pose cannot be chained to the Place frame, so they are not offered.
  const unposed = await scenario({})
  try {
    await writeFakeSession(unposed.sessionsDir, unposed.newSpec, { glbFilename: 'scan-new.glb', unposed: true })
    assertEquals((await runSfmRegistration(unposed.host, unposed.request)).result.reason, 'no-keyframes')
  } finally {
    await unposed.cleanup()
  }
})

Deno.test('sfm: COLMAP missing is a skip with the install hint, like every optional tool, and the hint names no folder of the operator\'s', async () => {
  // The result is stored in the world, which every member of it can read: the hint says what to install and what to set, and where COLMAP
  // was looked for is a path under somebody's home folder, with a space in it on a desktop.
  const missing = '/home/someone/Jane Doe/tools/colmap'
  await withScenario({ host: { colmapBin: missing, _spawn: undefined } }, async (s) => {
    const { result } = await runSfmRegistration(s.host, s.request)
    assertEquals([result.status, result.reason], ['skipped', 'colmap-missing'])
    assert(/COLMAP/.test(result.detail) && /COLMAP_BIN|Install/i.test(result.detail), result.detail)
    for (const part of ['/home/', 'someone', 'Jane', 'Doe', 'tools']) assert(!result.detail.includes(part), `${part} is in ${JSON.stringify(result.detail)}`)
    assert(!JSON.stringify(result).includes('Jane'), 'nor is it anywhere else in the result')
    assertEquals(await listDir(s.workRoot), [])
  })
  // A bare command name that is not found is the same hint, with the folders COLMAP is looked for in taken out.
  await withScenario({ host: { colmapBin: '/nonexistent/place-register/colmap', _spawn: undefined } }, async (s) => {
    const { result } = await runSfmRegistration(s.host, s.request)
    assertEquals(result.reason, 'colmap-missing')
    assert(!result.detail.includes('/nonexistent'), result.detail)
    assert(result.detail.includes('Install COLMAP'), 'the words that tell the operator what to do stay')
  })
})

Deno.test('sfm: scans calibrated against different generations of the Place reference are not compared, and an unrecorded generation is neutral', async () => {
  await withScenario({ movingOverrides: { calibrationFrameId: 'frame-old' } }, async (s) => {
    assertEquals((await runSfmRegistration(s.host, s.request)).result.reason, 'frame-mismatch')
    assertEquals(s.fake.calls.length, 0)
  })
  await withScenario({ referenceOverrides: { calibrationFrameId: 'frame-old' } }, async (s) => {
    assertEquals((await runSfmRegistration(s.host, s.request)).result.reason, 'frame-mismatch')
  })
  // Both scans agree with each other and not with the Place, whose reference has been replaced since: they share a frame that is gone.
  await withScenario({ movingOverrides: { calibrationFrameId: 'frame-old' }, referenceOverrides: { calibrationFrameId: 'frame-old' } }, async (s) => {
    assertEquals((await runSfmRegistration(s.host, s.request)).result.reason, 'frame-mismatch')
    assertEquals(s.fake.calls.length, 0)
  })
  // Neither scan records a generation, and nor does the Place: nothing says they differ.
  await withScenario({ movingOverrides: { calibrationFrameId: undefined }, referenceOverrides: { calibrationFrameId: undefined } }, async (s) => {
    const { result } = await runSfmRegistration(s.host, { ...s.request, place: { projectId: PROJECT, frameId: null } })
    assertEquals(result.status, 'proposed', `${result.reason}`)
    assertEquals(result.frameId, null)
  })
})

Deno.test('sfm: photographs that by their poses look at nothing the reference does are not solved when there are too many to match every pair', async () => {
  // 60 + 60 images is past the 100 that exhaustive matching is allowed, and 50 m apart no pose gate ties them.
  await withScenario({ views: 60, newError: { yawDeg: 0, shift: [50, 0, 0] } }, async (s) => {
    const { result } = await runSfmRegistration(s.host, s.request)
    assertEquals([result.status, result.reason], ['skipped', 'no-overlap'])
    assert(result.detail.length > 0, 'it says why')
    assertEquals(s.fake.calls.length, 0, 'no reference model was made for a session nothing can be tied to')
  })
  // The same far apart with few images: every pair is matched instead, and what COLMAP says is what counts.
  await withScenario({ newError: { yawDeg: 0, shift: [50, 0, 0] } }, async (s) => {
    const { result } = await runSfmRegistration(s.host, s.request)
    assert(s.fake.calls.some((call) => call[0] === 'matches_importer'), 'matched anyway')
    assertNotEquals(result.reason, 'no-overlap')
  })
})

Deno.test('sfm: the earlier scan whose photographs overlap the new scan\'s is the one registered against', async () => {
  await withScenario({}, async (s) => {
    // A second earlier scan, newer, whose photographs are 40 m away by their poses.
    const farSpec = ringSpec('sess-sfm-far', { views: ringViews([42.5, 0, 2], [1.3, 1.0], 14, 0, 1.45, 13), seed: 103 })
    await writeFakeSession(s.sessionsDir, farSpec, { glbFilename: 'scan-far.glb' })
    const far = scanManifest('scan-far', farSpec.sessionId, storedMatrix(farSpec, NO_ERROR), { calibrationFrameId: FRAME })
    const fake = fakeColmap({ world: worldOf([s.refSpec, s.newSpec, farSpec]) })
    const { result } = await runSfmRegistration({ ...s.host, _spawn: fake.spawn }, { ...s.request, references: [far, s.ref] })
    assertEquals(result.status, 'proposed', `${result.reason}`)
    assertEquals(result.reference?.scanId, 'scan-ref')
    assert(fake.calls.every((call) => !call.join(' ').includes('sess-sfm-far')), 'the far scan was never given to COLMAP')
  })
})

// ─── Every reason to refuse ──────────────────────────────────────────────────

Deno.test('sfm: a COLMAP step that fails is a refusal with COLMAP\'s words and no path in them, and the work directory is gone', async () => {
  const stderr = 'E1 feature_extractor failed reading /home/someone/scans/projects/proj-sfm/register-work/job-sfm-1/images/sess-sfm-new/kf-00003.jpg: bad file'
  await withScenario({ colmap: { failOn: { step: 'mapper(register)', stderr } } }, async (s) => {
    const { result } = await runSfmRegistration(s.host, s.request)
    assertEquals([result.status, result.reason], ['refused', 'colmap-failed'])
    assert(result.detail.includes('bad file'), result.detail)
    assert(!result.detail.includes('/home/') && !result.detail.includes('kf-00003') && !result.detail.includes('job-sfm-1'), `a path leaked: ${result.detail}`)
    assert(!JSON.stringify(result).includes('/home/someone'))
    assertEquals(result.sessions[0]!.reason, 'colmap-failed')
    await assertNoLeftovers(s)
  })
})

Deno.test('sfm: COLMAP\'s own words are stored without the folders the run was given, a space in a name included', async () => {
  // A desktop's folders can have a space in the last name (`/Users/Jane Doe`): no pattern can tell where such a path ends, so the run
  // removes the folders it knows, whole, before it stores what COLMAP said.
  await withScenario({}, async (s) => {
    const spacedRoot = `${s.root}/Jane Doe`
    const sayWhere: ColmapSpawn = (bin, args) => {
      if (args[0] === 'mapper' && args.includes('--Mapper.fix_existing_frames')) {
        return Promise.resolve({ code: 1, stderr: `E mapper could not create ${spacedRoot}: permission denied\nE and could not read ${s.sessionsDir}/sess-sfm-new/kf-00003.jpg` })
      }
      return s.fake.spawn(bin, args)
    }
    const { result } = await runSfmRegistration({ ...s.host, workRoot: () => spacedRoot, _spawn: sayWhere }, s.request)
    assertEquals([result.status, result.reason], ['refused', 'colmap-failed'])
    assert(result.detail.includes('permission denied'), 'the words stay')
    for (const part of ['Jane', 'Doe', s.root, 'kf-00003', 'sess-sfm']) assert(!result.detail.includes(part), `${part} is in ${JSON.stringify(result.detail)}`)
    assert(!JSON.stringify(result).includes('Doe'))
  })
})

Deno.test('sfm: a run that passes its wall-clock limit is stopped, refused as timed out, and cleaned up', async () => {
  await withScenario({ colmap: { hangOn: 'matches_importer' }, host: { wallClockMs: 250 } }, async (s) => {
    const started = performance.now()
    const { result } = await runSfmRegistration(s.host, s.request)
    const took = performance.now() - started
    assertEquals([result.status, result.reason], ['refused', 'timed-out'])
    assert(took < 5_000, `it ran for ${Math.round(took)} ms past a 250 ms limit`)
    assert(result.elapsedMs >= 200, `elapsed ${result.elapsedMs}`)
    await assertNoLeftovers(s)
  })
  // A clock that has already run out starts no command at all.
  await withScenario({ host: { wallClockMs: 100, now: (() => { let t = 0; return () => (t += 1000) })() } }, async (s) => {
    const { result } = await runSfmRegistration(s.host, s.request)
    assertEquals(result.reason, 'timed-out')
    assertEquals(s.fake.calls.length, 0, 'no command was started after the limit')
    await assertNoLeftovers(s)
  })
})

Deno.test('sfm: photographs of the earlier scan that do not join into one model leave nothing to register against', async () => {
  await withScenario({ colmap: { drop: (name) => name.startsWith('sess-sfm-ref/') } }, async (s) => {
    const { result } = await runSfmRegistration(s.host, s.request)
    assertEquals([result.status, result.reason], ['refused', 'reference-weak'])
    assertEquals(await listDir(referenceCacheDir(`${s.sessionsDir}/sess-sfm-ref`)), [], 'a model that is not a reference is not kept')
    await assertNoLeftovers(s)
  })
})

Deno.test('sfm: too few of the new photographs finding their place is a refusal, and the count is what was measured', async () => {
  await withScenario({ colmap: { drop: (name) => name.startsWith('sess-sfm-new/') && Number(name.slice(-9, -4)) >= 4 } }, async (s) => {
    const { result } = await runSfmRegistration(s.host, s.request)
    assertEquals([result.status, result.reason], ['refused', 'too-few-registered'])
    assertEquals([result.registeredImages, result.offeredImages], [4, 14])
    assert(4 < SFM_MIN_REGISTERED_IMAGES)
    assertEquals(result.transform, null)
  })
  // Enough in count and not in share: 7 of 14 is under COLMAP's own registration ratio.
  await withScenario({ colmap: { drop: (name) => name.startsWith('sess-sfm-new/') && Number(name.slice(-9, -4)) >= 7 } }, async (s) => {
    const { result } = await runSfmRegistration(s.host, s.request)
    assertEquals([result.reason, result.registeredImages], ['too-few-registered', 7])
  })
})

Deno.test('sfm: new photographs that COLMAP puts in a model of their own are a sub-model split, not a registration', async () => {
  await withScenario({ colmap: { splitNewIntoOtherModel: true } }, async (s) => {
    const { result } = await runSfmRegistration(s.host, s.request)
    assertEquals([result.status, result.reason], ['refused', 'sub-model-split'])
    assertEquals(result.sessions[0]!.inOtherModels, 14)
    assertEquals(result.sessions[0]!.registeredImages, 0)
  })
})

Deno.test('sfm: a reference whose cameras moved while the new photographs were added is refused, because its fit no longer describes the model', async () => {
  await withScenario({ colmap: { moveReferenceBy: [0.4, 0, 0] } }, async (s) => {
    const { result } = await runSfmRegistration(s.host, s.request)
    assertEquals([result.status, result.reason], ['refused', 'reference-moved'])
  })
})

Deno.test('sfm: camera positions on a straight line cannot fix the turn about it, so the registration is refused as collinear', async () => {
  const line = Array.from({ length: 14 }, (_, k): ToySessionSpec['views'][number] => {
    const base = ringViews(MIDDLE, [1.0, 1.2], 14, 10, 1.35, 12)[k]!
    return { ...base, position: [1.0 + 0.3 * k, 1.4, 2.0] }
  })
  await withScenario({ newOverrides: { views: line } }, async (s) => {
    const { result } = await runSfmRegistration(s.host, s.request)
    assertEquals([result.status, result.reason], ['refused', 'collinear'])
    assertEquals(result.transform, null)
  })
})

Deno.test('sfm: a solved camera path that does not agree with the recorded one is refused for its residual', async () => {
  const wrong = (name: string, c: V3): V3 => {
    const k = Number(name.slice(-9, -4))
    return [c[0] + ((k * 7919) % 13 - 6) * 0.9, c[1] + ((k * 104729) % 11 - 5) * 0.9, c[2] + ((k * 31) % 9 - 4) * 0.9]
  }
  await withScenario({ colmap: { distort: wrong } }, async (s) => {
    const { result } = await runSfmRegistration(s.host, s.request)
    assertEquals([result.status, result.reason], ['refused', 'high-residual'])
    assertEquals(result.transform, null)
  })
})

Deno.test('sfm: a session the solve tips against the reference is refused, because both AR frames are gravity-aligned', async () => {
  // The new session's solved cameras are turned 20 degrees about a horizontal axis through their own centre: a rigid tilt that the
  // fit takes up perfectly, so only the up-axis check can see it.
  const tilted = (): ((name: string, c: V3) => V3) => {
    let centre: V3 | null = null
    const spec = newSpec()
    const worldCentre = (): V3 => {
      const places = spec.views.map((view) => view.position)
      const mean = places.reduce<V3>((m, p) => [m[0] + p[0] / places.length, m[1] + p[1] / places.length, m[2] + p[2] / places.length], [0, 0, 0])
      return mean
    }
    return (_name, c) => {
      centre ??= tiltedCentre(worldCentre())
      const a = (20 * Math.PI) / 180
      const d: V3 = [c[0] - centre[0], c[1] - centre[1], c[2] - centre[2]]
      return [centre[0] + d[0], centre[1] + Math.cos(a) * d[1] - Math.sin(a) * d[2], centre[2] + Math.sin(a) * d[1] + Math.cos(a) * d[2]]
    }
  }
  await withScenario({ colmap: { distort: tilted() } }, async (s) => {
    const { result } = await runSfmRegistration(s.host, s.request)
    assertEquals([result.status, result.reason], ['refused', 'up-axis-disagrees'])
    assert(result.sessions[0]!.tiltDeg! > 5)
  })
})

/** Where the new session's cameras are in the solver's frame, on average: the point the tilt above is taken about. */
function tiltedCentre(place: V3): V3 {
  const solver = worldOf([newSpec()]).solver!
  const r = solver.rotation
  const q: V3 = [
    solver.scale * (r[0]![0]! * place[0] + r[0]![1]! * place[1] + r[0]![2]! * place[2]) + solver.translation[0],
    solver.scale * (r[1]![0]! * place[0] + r[1]![1]! * place[1] + r[1]![2]! * place[2]) + solver.translation[1],
    solver.scale * (r[2]![0]! * place[0] + r[2]![1]! * place[1] + r[2]![2]! * place[2]) + solver.translation[2],
  ]
  return q
}

Deno.test('sfm: solved cameras that are all in one place are refused as that, and not described as a line', async () => {
  await withScenario({ colmap: { distort: (name, c) => (name.startsWith('sess-sfm-new/') ? [1, 2, 3] as V3 : c) } }, async (s) => {
    const { result } = await runSfmRegistration(s.host, s.request)
    assertEquals([result.status, result.reason], ['refused', 'collinear'])
    assertEquals(result.transform, null)
    assert(result.detail.includes('one place') && !result.detail.includes('line'), result.detail)
    await assertNoLeftovers(s)
  })
})

Deno.test('sfm: an earlier scan whose recorded cameras do not agree with its own solve leaves nothing to register against', async () => {
  // Its recorded positions are 1.5 m out on every axis, far past what a fit can take up: its model is of no use as the reference.
  await withScenario({ refSpecOverrides: { positionNoise: 1.5 } }, async (s) => {
    const { result } = await runSfmRegistration(s.host, s.request)
    assertEquals([result.status, result.reason], ['refused', 'reference-unusable'])
    assertEquals(result.transform, null)
    assertEquals(result.sessions.map((row) => row.reason), ['reference-unusable'])
    await assertNoLeftovers(s)
  })
})

Deno.test('sfm: a new scan whose placement is not a similarity cannot be corrected, and the registration says so', async () => {
  // One axis of its calibration is 30% longer than the others: not a rotation, a shift and one size, so there is no move to describe.
  const sheared = [...storedMatrix(newSpec(), NEW_ERROR)]
  for (const i of [0, 1, 2]) sheared[i] = sheared[i]! * 1.3
  await withScenario({ movingOverrides: { localToWorld: sheared } }, async (s) => {
    const { result } = await runSfmRegistration(s.host, s.request)
    assertEquals([result.status, result.reason], ['refused', 'reference-unusable'])
    assertEquals(result.transform, null)
    await assertNoLeftovers(s)
  })
})

Deno.test('sfm: a size between the two scans that a placement cannot hold is refused, whatever else fits', async () => {
  await withScenario({ newOverrides: { unit: 3 } }, async (s) => {
    const { result } = await runSfmRegistration(s.host, s.request)
    assertEquals([result.status, result.reason], ['refused', 'scale-out-of-range'])
    assertAlmostEquals(result.scaleRatio!, 3, 0.1)
    assertEquals(result.transform, null)
  })
})

Deno.test('sfm: a move beyond the bound the wall match is held to is refused and its size reported', async () => {
  await withScenario({ newError: { yawDeg: 3, shift: [2.4, 0, 0.5] } }, async (s) => {
    const { result } = await runSfmRegistration(s.host, s.request)
    assertEquals([result.status, result.reason], ['refused', 'correction-too-large'])
    assertEquals(result.transform, null)
    assertEquals(result.boundedCorrection!.withinBound, false)
    assert(result.boundedCorrection!.translationM > 1, `${result.boundedCorrection!.translationM} m`)
    assert(result.detail.includes('cm'), result.detail)
  })
})

Deno.test('sfm: sessions of one scan share a frame, so two that put it in different places are refused', async () => {
  const second = ringSpec('sess-sfm-new2', {
    yawDeg: 25,
    origin: [1.2, 0, -0.7],
    views: ringViews(MIDDLE, [1.1, 1.1], 12, 40, 1.4, 14),
    seed: 105,
  }, 12)
  // The second session's solved cameras are 0.6 m from where they were: a rigid offset the fit takes up, so it registers cleanly and answers differently.
  const offset = (name: string, c: V3): V3 => (name.startsWith('sess-sfm-new2/') ? [c[0] + 0.6, c[1], c[2]] : c)
  await withScenario({ extraNewSpecs: [second], colmap: { distort: offset } }, async (s) => {
    const { result } = await runSfmRegistration(s.host, s.request)
    assertEquals(result.sessions.length, 2)
    assertEquals([result.status, result.reason], ['refused', 'sessions-disagree'])
  })
})

Deno.test('sfm: sessions of one scan that agree are all registered, and the one with the most fitted photographs speaks for the scan', async () => {
  const second = ringSpec('sess-sfm-new2', {
    yawDeg: 25,
    origin: [1.2, 0, -0.7],
    views: ringViews(MIDDLE, [1.1, 1.1], 10, 40, 1.4, 14),
    seed: 105,
  }, 10)
  await withScenario({ extraNewSpecs: [second] }, async (s) => {
    const { result } = await runSfmRegistration(s.host, s.request)
    assertEquals(result.status, 'proposed', `${result.reason}: ${result.detail}`)
    assertEquals(result.sessions.map((row) => [row.sessionId, row.status, row.offeredImages]), [['sess-sfm-new', 'proposed', 14], ['sess-sfm-new2', 'proposed', 10]])
    assertEquals(result.offeredImages, 14, 'the proposal is the better session\'s own numbers')
    assertEquals(s.fake.steps().filter((step) => step === 'mapper(register)').length, 2, 'each session is registered to the reference on its own, never to the other')
  })
})

Deno.test('sfm: a skip a caller records for a run it did not make carries its reason, and nothing from a photograph', () => {
  const skipped = skippedResult('not-needed')
  assertEquals([skipped.status, skipped.reason, skipped.transform, skipped.sessions.length], ['skipped', 'not-needed', null, 0])
  assertEquals(skippedResult('colmap-missing', 'Install COLMAP.').detail, 'Install COLMAP.')
})

Deno.test('sfm: an unexpected error is a refusal that names nothing, so the wall match\'s answer is not lost with it', async () => {
  const bad: ColmapSpawn = () => {
    throw new Error('boom reading /home/someone/private/kf-00001.jpg')
  }
  await withScenario({ host: { _spawn: bad } }, async (s) => {
    const { result } = await runSfmRegistration(s.host, s.request)
    assertEquals([result.status, result.reason], ['refused', 'colmap-failed'])
    assert(!JSON.stringify(result).includes('/home/someone'), 'the error\'s message is not stored')
    await assertNoLeftovers(s)
  })
})

Deno.test('sfm: a rotation chain is not mirrored: the registration of a session whose recorded frame is turned a quarter round still lands', async () => {
  // The unit-circle check on the algebra the method rests on: every heading of the new session's AR frame is recovered, not just the toy's 25 degrees.
  for (const yaw of [-170, -90, 0, 90, 170]) {
    await withScenario({ newOverrides: { yawDeg: yaw } }, async (s) => {
      const { result } = await runSfmRegistration(s.host, s.request)
      assertEquals(result.status, 'proposed', `heading ${yaw}: ${result.reason}`)
      const corrected = multiplyMat4(result.transform!, s.moving.localToWorld)
      assert(placementError(s, corrected) < 0.04, `heading ${yaw}: ${placementError(s, corrected)} m`)
    })
  }
})

Deno.test('sfm: a session with more photographs than the cap is thinned evenly across the walk, and the cap is what is offered', async () => {
  const lists: string[][] = []
  await withScenario({
    newOverrides: { views: ringViews(MIDDLE, [1.0, 1.2], SFM_MAX_FRAMES_PER_SESSION + 10, 10, 1.35, 12) },
    colmap: {
      onCall: async (args) => {
        if (args[0] === 'feature_extractor') lists.push((await Deno.readTextFile(args[args.indexOf('--image_list_path') + 1]!)).trim().split('\n'))
      },
    },
  }, async (s) => {
    const { result } = await runSfmRegistration(s.host, s.request)
    assertEquals(result.status, 'proposed', `${result.reason}: ${result.detail}`)
    assertEquals(result.offeredImages, SFM_MAX_FRAMES_PER_SESSION)
    const offered = lists[1]!
    assertEquals(offered.length, SFM_MAX_FRAMES_PER_SESSION)
    // Both ends of the walk are in it, and the gaps between the photographs are even to a frame.
    assertEquals([offered[0], offered.at(-1)], ['sess-sfm-new/kf-00000.jpg', `sess-sfm-new/kf-${String(SFM_MAX_FRAMES_PER_SESSION + 9).padStart(5, '0')}.jpg`])
    const index = offered.map((name) => Number(/kf-(\d+)\.jpg/.exec(name)![1]))
    const gaps = index.slice(1).map((n, i) => n - index[i]!)
    assert(Math.max(...gaps) - Math.min(...gaps) <= 1, `gaps ${Math.min(...gaps)} to ${Math.max(...gaps)}`)
  })
})

Deno.test('sfm: at most the cap of one scan\'s sessions are registered, the ones with the most photographs first', async () => {
  const sizes = [12, 10, 8]
  const extras = sizes.map((count, k) =>
    ringSpec(`sess-sfm-new${k + 2}`, { yawDeg: 25, origin: [1.2, 0, -0.7], views: ringViews(MIDDLE, [1.1, 1.1], count, 40 + 7 * k, 1.4, 14 + k), seed: 105 + k }, count)
  )
  await withScenario({ extraNewSpecs: extras }, async (s) => {
    const { result } = await runSfmRegistration(s.host, s.request)
    assertEquals(SFM_MAX_NEW_SESSIONS, 3)
    assertEquals(result.status, 'proposed', `${result.reason}: ${result.detail}`)
    // Four sessions of 14, 12, 10 and 8 photographs: the three largest.
    assertEquals(result.sessions.map((row) => [row.sessionId, row.offeredImages]), [['sess-sfm-new', 14], ['sess-sfm-new2', 12], ['sess-sfm-new3', 10]])
    assertEquals(s.fake.steps().filter((step) => step === 'mapper(register)').length, 3)
  })
})

Deno.test('sfm: the inliers are the photographs whose solved camera lands within 15 cm of where the scan recorded it, in Place metres whatever the solver\'s unit', async () => {
  // One photograph is solved 0.5 m from where it was. With the solver's unit at 0.2 of a metre that gap is 0.1 in its own units, under the
  // 15 cm gate, so counting in the solver's units would call it an inlier. The fit gives way to it by a few centimetres, no more.
  const solver = { scale: 0.2, rotation: turnAbout([0.3, 1, 0.2], 41), translation: [5, -2, 3] as V3 }
  const nudged = (name: string, c: V3): V3 => (name === 'sess-sfm-new/kf-00003.jpg' ? [c[0] + 0.5 * solver.scale, c[1], c[2]] : c)
  await withScenario({ solver, colmap: { distort: nudged } }, async (s) => {
    const { result } = await runSfmRegistration(s.host, s.request)
    assertEquals(result.status, 'proposed', `${result.reason}: ${result.detail}`)
    assertEquals([result.registeredImages, result.offeredImages], [14, 14])
    assertEquals(result.inliers, 13)
    assertEquals(result.sessions[0]!.inliers, 13)
    assertEquals(result.sessions[0]!.fittedFrames, 14)
  })
})

Deno.test('sfm: on random known frames, solver frames and units, the proposal puts the new session\'s cameras where they really were', async () => {
  // Seeded, so a failure is a case to reproduce. Each trial draws the new session's heading and origin, its unit, the calibration error to
  // find, the solver's frame (any turn about any axis, any size, any shift) and the earlier scan's own heading, origin and unit: the chain
  // T_ref x Sim_ref^-1 x Sim_new has to give the true frame whatever they are, which a transposed or mirrored matrix, or one that left
  // the earlier scan's own placement out, would not. The truth is worked out here from the coordinates (placeFrameOfReference), not by the chain.
  const next = mulberry32(20260217)
  const between = (low: number, high: number): number => low + (high - low) * next()
  const trials: string[] = []
  for (let trial = 0; trial < 8; trial++) {
    const unit = [0.86, 1, 1.15, 1.22][trial % 4]!
    const refUnit = [1, 1.05, 0.93, 1][(trial + 1) % 4]!
    const solver: SolverFrame = {
      scale: between(0.05, 3),
      rotation: turnAbout([between(-1, 1), between(0.2, 1), between(-1, 1)], between(-180, 180)),
      translation: [between(-20, 20), between(-20, 20), between(-20, 20)],
    }
    const error = { yawDeg: between(-4, 4), shift: [between(-0.3, 0.3), 0, between(-0.3, 0.3)] as V3 }
    const options = {
      solver,
      newError: error,
      newOverrides: { yawDeg: between(-180, 180), origin: [between(-2, 2), 0, between(-2, 2)] as V3, unit, seed: 200 + trial },
      refSpecOverrides: { yawDeg: between(-180, 180), origin: [between(-3, 3), 0, between(-3, 3)] as V3, unit: refUnit },
    }
    await withScenario(options, async (s) => {
      const { result } = await runSfmRegistration(s.host, s.request)
      assertEquals(result.status, 'proposed', `trial ${trial}: ${result.reason}: ${result.detail}`)
      const corrected = multiplyMat4(result.transform!, s.moving.localToWorld)
      const after = placementError(s, corrected, s.newSpec, placeFrameOfReference(s.refSpec))
      assert(after < 0.08, `trial ${trial}: unit ${unit} against ${refUnit}, solver scale ${solver.scale.toFixed(2)}: ${after} m from the truth`)
      assertAlmostEquals(result.scaleRatio!, unit / refUnit, 0.02, `trial ${trial}: the unit mismatch`)
      trials.push(`${trial}: ${after.toFixed(3)}`)
    })
  }
  assertEquals(trials.length, 8)
})

// ─── The earlier scan can be anywhere in the Place ───────────────────────────
//
// Every scenario above places the earlier scan at the Place's origin and heading, where its calibration is the identity and a chain
// that left it out would give the same answer. These put it at a heading and an origin of its own, and the truth they are held to is
// worked out here from the coordinates alone, never through the chain's own algebra.

/**
 * Where a camera that is at `place` is when the Place frame is the one the earlier scan's calibration defines. That calibration is rigid
 * (a rotation and a shift, scale 1), so a scan on a runtime whose unit is `unit` is not carried to its true place by it: the Place frame
 * is the true one resized by `1 / unit` about the scan's origin. With `unit` 1 it is the true frame.
 */
function placeFrameOfReference(refSpec: ToySessionSpec): (place: V3) => V3 {
  const o = refSpec.origin
  return (p) => [o[0] + (p[0] - o[0]) / refSpec.unit, o[1] + (p[1] - o[1]) / refSpec.unit, o[2] + (p[2] - o[2]) / refSpec.unit]
}

Deno.test('sfm: the earlier scan\'s own placement is carried through: at a heading and an origin of its own it still gives the new scan\'s true frame', async () => {
  for (const [yawDeg, origin] of [[70, [3, 0, -2]], [-115, [-4.5, 0, 6]], [180, [0.5, 0, 0.5]]] as const) {
    await withScenario({ refSpecOverrides: { yawDeg, origin: [...origin] as V3 } }, async (s) => {
      // The earlier scan is not at the identity, so a chain that dropped its placement would be wrong by all of this.
      const placement = sim3FromColumnMajor(s.ref.localToWorld)!
      assert(Math.abs(placement.translation[0]) + Math.abs(placement.translation[2]) > 0.4, 'the earlier scan\'s placement moves things')
      const { result } = await runSfmRegistration(s.host, s.request)
      assertEquals(result.status, 'proposed', `heading ${yawDeg}: ${result.reason}: ${result.detail}`)
      const corrected = multiplyMat4(result.transform!, s.moving.localToWorld)
      assert(placementError(s, corrected) < 0.04, `heading ${yawDeg}, origin ${origin}: ${placementError(s, corrected)} m from where the cameras were`)
      assert(placementError(s, s.moving.localToWorld) > 0.3, 'and the calibration it replaces was well out')
    })
  }
})

Deno.test('sfm: an earlier scan on a runtime with another unit defines a Place frame of its own size, and the new scan is carried into that one', async () => {
  for (const unit of [1.05, 0.93]) {
    await withScenario({ refSpecOverrides: { yawDeg: 70, origin: [3, 0, -2], unit } }, async (s) => {
      const { result } = await runSfmRegistration(s.host, s.request)
      assertEquals(result.status, 'proposed', `unit ${unit}: ${result.reason}: ${result.detail}`)
      // The Place frame is the true one resized about the earlier scan's origin (placeFrameOfReference), and the new scan, which is metric,
      // is one `unit` units of that frame per metre.
      assertAlmostEquals(result.scaleRatio!, 1 / unit, 0.02, `unit ${unit}: the unit mismatch the fits measure`)
      const corrected = multiplyMat4(result.transform!, s.moving.localToWorld)
      const error = placementError(s, corrected, s.newSpec, placeFrameOfReference(s.refSpec))
      assert(error < 0.05, `unit ${unit}: ${error} m from where the cameras are in that frame`)
    })
  }
})

// ─── The size that is left out does not move the scan ────────────────────────

/** Cameras round `centre` far from the Place origin, where a size taken off a correction in the wrong way would show. */
function farViews(centre: V3, radii: [number, number], count: number, startDeg: number, seed: number) {
  return ringViews(centre, radii, count, startDeg, 1.4, seed)
}

Deno.test('gravityConstrained: leaving the size out keeps the pivot where the whole correction puts it, which is what a size inside the noise is for', () => {
  const pivot: V3 = [4, 1.4, 3]
  const identity = [[1, 0, 0], [0, 1, 0], [0, 0, 1]]
  // The correction a registration gives when the middle of the scan is exactly where it should be and the two units differ by 1.5%:
  // it resizes about the pivot, so it leaves the pivot where it is.
  const full = { rotation: identity, scale: 1.015, translation: [pivot[0] * (1 - 1.015), pivot[1] * (1 - 1.015), pivot[2] * (1 - 1.015)] as V3 }
  const left = sim3FromColumnMajor(gravityConstrained(full, pivot, 1))!
  assertEquals(left.scale, 1)
  const landed = applySim3(left, pivot)
  for (let i = 0; i < 3; i++) assertAlmostEquals(landed[i]!, pivot[i]!, 1e-12, `axis ${i}: the pivot did not move`)
  // Carried, it is the correction itself: the pivot stays, and a point 3 m from it goes 1.5% of that farther.
  const carried = sim3FromColumnMajor(gravityConstrained(full, pivot))!
  assertAlmostEquals(carried.scale, 1.015, 1e-12)
  const far = applySim3(carried, [pivot[0] + 3, pivot[1], pivot[2]])
  assertAlmostEquals(far[0], pivot[0] + 3 * 1.015, 1e-12)
  // With a turn about up, a tilt and a shift in the correction, only the turn is kept, and the pivot goes where the whole correction put it.
  const a = (6 * Math.PI) / 180
  const tilt = (2 * Math.PI) / 180
  const turn = [[Math.cos(a), 0, Math.sin(a)], [0, 1, 0], [-Math.sin(a), 0, Math.cos(a)]]
  const tip = [[1, 0, 0], [0, Math.cos(tilt), -Math.sin(tilt)], [0, Math.sin(tilt), Math.cos(tilt)]]
  const rotation = turn.map((row) => [0, 1, 2].map((j) => row[0]! * tip[0]![j]! + row[1]! * tip[1]![j]! + row[2]! * tip[2]![j]!))
  const whole = { rotation, scale: 1.01, translation: [0.2, 0.03, -0.1] as V3 }
  const wholeAt = applySim3(whole, pivot)
  const flat = sim3FromColumnMajor(gravityConstrained(whole, pivot, 1))!
  const flatAt = applySim3(flat, pivot)
  for (let i = 0; i < 3; i++) assertAlmostEquals(flatAt[i]!, wholeAt[i]!, 1e-12, `axis ${i}`)
  assertEquals([flat.rotation[0]![1], flat.rotation[1]![1], flat.rotation[2]![1]].map((v) => Math.abs(v!) < 1e-12 || v === 1), [true, true, true])
  assertAlmostEquals(Math.atan2(flat.rotation[0]![2]! - flat.rotation[2]![0]!, flat.rotation[0]![0]! + flat.rotation[2]![2]!), a, 5e-3, 'the turn about up is the correction\'s')
})

Deno.test('sfm: a unit difference inside the noise is not carried and does not move the middle of the scan, far from the Place origin or near it', async () => {
  // Both scans are in a room 39 m from the Place origin. The new scan's calibration is exact at the middle of its cameras, so the right
  // proposal moves that middle by nothing; a size taken out of a correction that is then still shifted as if it were there moves the
  // middle by the size's share of that distance: 1.5% of 39 m is 58 cm.
  const far: V3 = [30, 0, 25]
  for (const unit of [1, 1.015]) {
    await withScenario({
      views: 14,
      refSpecOverrides: { views: farViews(far, [1.3, 1.0], 14, 0, 11) },
      newOverrides: { unit, views: farViews(far, [1.0, 1.2], 14, 10, 12) },
    }, async (s) => {
      const recorded = recordedCentres(s.newSpec)
      const stored = sim3FromColumnMajor(storedMatrix(s.newSpec, NO_ERROR))!
      const placedMean = [0, 1, 2].map((i) => recorded.reduce((sum, c) => sum + applySim3(stored, c)[i]!, 0) / recorded.length)
      const trueMean = [0, 1, 2].map((i) => s.newSpec.views.reduce((sum, view) => sum + view.position[i]!, 0) / recorded.length)
      const shift = [0, 1, 2].map((i) => trueMean[i]! - placedMean[i]!) as V3
      const exactAtMiddle = storedMatrix(s.newSpec, { yawDeg: 0, shift })
      const request = { ...s.request, moving: { ...s.moving, localToWorld: exactAtMiddle } }
      const { result, pivot } = await runSfmRegistration(s.host, request)
      assertEquals(result.status, 'proposed', `unit ${unit}: ${result.reason}: ${result.detail}`)
      assert(Math.hypot(pivot![0], pivot![1]) > 30, `the middle of the scan is ${Math.hypot(pivot![0], pivot![1])} m from the Place origin`)
      assertAlmostEquals(Math.hypot(result.transform![0]!, result.transform![2]!), 1, 1e-9, 'not carried: 1.5% is under the 2% floor')
      assert(result.boundedCorrection!.translationM < 0.03, `unit ${unit}: the middle of the scan moves ${result.boundedCorrection!.translationM * 100} cm for a calibration that was exact there`)
    })
  }
})

Deno.test('sfm: two sessions of one scan whose sizes fall either side of the line a size is carried at agree, because they are compared as measured', async () => {
  // Their solved cameras are resized by 1.015 and 1.025 about their own middle: the first is not carried and the second is, and they
  // differ by 1% in the size each measured. The room is far from the Place origin, so a pivot that moved with the size would show too.
  const far: V3 = [30, 0, 25]
  const second = ringSpec('sess-sfm-new2', { yawDeg: 25, origin: [1.2, 0, -0.7], views: farViews(far, [1.1, 1.1], 12, 40, 14), seed: 105 }, 12)
  const resizeAbout = (spec: ToySessionSpec, factor: number) => {
    const middle = spec.views.reduce<V3>((m, v) => [m[0] + v.position[0] / spec.views.length, m[1] + v.position[1] / spec.views.length, m[2] + v.position[2] / spec.views.length], [0, 0, 0])
    const at = mulVec(SOLVER.rotation as unknown as Parameters<typeof mulVec>[0], middle)
    const centre: V3 = [SOLVER.scale * at[0] + SOLVER.translation[0], SOLVER.scale * at[1] + SOLVER.translation[1], SOLVER.scale * at[2] + SOLVER.translation[2]]
    return (c: V3): V3 => [centre[0] + factor * (c[0] - centre[0]), centre[1] + factor * (c[1] - centre[1]), centre[2] + factor * (c[2] - centre[2])]
  }
  const first = newSpec({ views: farViews(far, [1.0, 1.2], 14, 10, 12) }, 14)
  const grow1 = resizeAbout(first, 1.015)
  const grow2 = resizeAbout(second, 1.025)
  await withScenario({
    refSpecOverrides: { views: farViews(far, [1.3, 1.0], 14, 0, 11) },
    newOverrides: { views: first.views },
    // The calibration error is a turn about the session's own origin, which is 38 m from this room: kept small so the move stays inside the bound.
    newError: { yawDeg: 0.4, shift: [0.2, 0, -0.1] },
    extraNewSpecs: [second],
    colmap: { distort: (name, c) => (name.startsWith('sess-sfm-new2/') ? grow2(c) : name.startsWith('sess-sfm-new/') ? grow1(c) : c) },
  }, async (s) => {
    const { result } = await runSfmRegistration(s.host, s.request)
    assertEquals(result.status, 'proposed', `${result.reason}: ${result.detail}`)
    const [a, b] = result.sessions
    assert(a!.scaleRatio! < 1.02 && b!.scaleRatio! >= 1.02, `either side of the 2% line: ${a!.scaleRatio} and ${b!.scaleRatio}`)
    assert(Math.abs(a!.scaleRatio! - 1.015) < 0.008 && Math.abs(b!.scaleRatio! - 1.025) < 0.012, 'and what each measured is what was done to it')
    assertEquals(a!.status, 'proposed')
    assertEquals(b!.status, 'proposed')
  })
})

// ─── What the photographs can and cannot fix ─────────────────────────────────

/** Solver noise as the AR positions have it: `sigmaM` per axis in Place metres, drawn once for each photograph. */
function solverNoise(sigmaM: number, seed: number): (name: string, c: V3) => V3 {
  const next = mulberry32(seed)
  const drawn = new Map<string, V3>()
  return (name, c) => {
    let d = drawn.get(name)
    if (!d) {
      d = [gaussian(next) * sigmaM * SOLVER.scale, gaussian(next) * sigmaM * SOLVER.scale, gaussian(next) * sigmaM * SOLVER.scale]
      drawn.set(name, d)
    }
    return [c[0] + d[0], c[1] + d[1], c[2] + d[2]]
  }
}

function smallLoop(radius: number, count: number, seed: number): ToySessionSpec['views'] {
  return ringViews(MIDDLE, [radius, radius], count, 5, 1.4, seed)
}

Deno.test('sfm: a camera path too small and too noisy to fix the turn is refused for that, with the uncertainty on the record, and offered when the switch is off', async () => {
  const options = { views: 24, newOverrides: { views: smallLoop(0.25, 24, 31), positionNoise: 0.02, seed: 41 }, colmap: { distort: solverNoise(0.02, 7) } }
  await withScenario(options, async (s) => {
    const { result } = await runSfmRegistration(s.host, s.request)
    assertEquals([result.status, result.reason], ['refused', 'turn-uncertain'])
    assertEquals(result.transform, null)
    // The number is what the refusal is about, and it is there to read: one standard error of the turn, past the 1 degree limit.
    assert(result.turnUncertaintyDeg! > 1 && result.turnUncertaintyDeg! < 6, `${result.turnUncertaintyDeg}`)
    assertEquals(result.sessions[0]!.reason, 'turn-uncertain')
    assert(result.detail.includes('1 degree'), result.detail)
    assert(result.params['maxTurnUncertaintyDeg'] === 1 && result.params['enforceTurnUncertainty'] === 1)
  })
  // Off: the same photographs give a proposal, and it says how little it can fix the turn.
  await withScenario({ ...options, host: { enforceTurnUncertainty: false } }, async (s) => {
    const { result } = await runSfmRegistration(s.host, s.request)
    assertEquals(result.status, 'proposed', `${result.reason}: ${result.detail}`)
    assert(result.turnUncertaintyDeg! > 1, `${result.turnUncertaintyDeg}`)
    assert(result.sizeUncertainty! > 0.02, `size uncertainty ${result.sizeUncertainty}`)
    assertEquals(result.sessions[0]!.turnUncertaintyDeg, result.turnUncertaintyDeg)
  })
})

Deno.test('sfm: a good walk registered against a reference whose own path is small is refused for the turn, and the detail says whose path it was', async () => {
  // The earlier scan was a stand-and-pan 0.3 m across with 2 cm of noise on both sides; the new scan is a walk 1.3 m round. The turn of a
  // registration is fixed by both, and the earlier scan's fit alone is uncertain by more than a degree.
  await withScenario({
    views: 24,
    refSpecOverrides: { views: smallLoop(0.3, 24, 38), positionNoise: 0.02, seed: 48 },
    newOverrides: { views: smallLoop(1.3, 24, 39), positionNoise: 0.01, seed: 49 },
    colmap: { distortReference: solverNoise(0.02, 12) },
  }, async (s) => {
    const { result } = await runSfmRegistration(s.host, s.request)
    assertEquals([result.status, result.reason], ['refused', 'turn-uncertain'], `${result.detail}`)
    assert(result.turnUncertaintyDeg! > 1, `${result.turnUncertaintyDeg}`)
    // The detail names both: this scan's path is the good one and the earlier scan's is not.
    const [mine, earlier] = /this scan's camera path fixes it to ([\d.]+) degrees and the earlier scan's to ([\d.]+) degrees/.exec(result.detail)!.slice(1).map(Number)
    assert(mine! < 0.5 && earlier! > 1, result.detail)
    assertEquals(result.transform, null)
  })
})

Deno.test('sfm: a walk round a room fixes the turn and the size well, and says by how much', async () => {
  await withScenario({ views: 24, newOverrides: { views: smallLoop(1.2, 24, 32), positionNoise: 0.03, seed: 42 }, colmap: { distort: solverNoise(0.03, 8) } }, async (s) => {
    const { result } = await runSfmRegistration(s.host, s.request)
    assertEquals(result.status, 'proposed', `${result.reason}: ${result.detail}`)
    assert(result.turnUncertaintyDeg! < 1, `turn ${result.turnUncertaintyDeg} degrees`)
    assert(result.sizeUncertainty! < 0.02, `size ${result.sizeUncertainty}`)
    assert(result.turnUncertaintyDeg! > 0.1 && result.sizeUncertainty! > 0.001, 'real noise, so a real uncertainty')
  })
})

Deno.test('sfm: the uncertainty on a proposal is the noise\'s and not the gate\'s: with 5 cm of noise on one side, which cuts a share of its photographs, it is what the closed form gives for that noise', async () => {
  // 36 photographs on a ring 1.2 m across, 5 cm of noise per axis on the recorded and on the solved positions of ONE of the two scans
  // (the other is clean), so 15 to 20% of that scan's photographs are left out of its fit by the 15 cm gate and the RMS of the rest reads
  // low. The closed form for the noisy fit, from the noise itself, is rho / (Rh sqrt(3n - 7)) with rho the RMS of a three-dimensional gap
  // of two 5 cm sources and the fitted frames about 30. Averaged over six seeds, because one fit's own estimate scatters.
  const sigma = 0.05
  const rho = Math.sqrt(3) * Math.sqrt(2 * sigma ** 2) * Math.sqrt(1 - 7 / 108)
  const expected = ((rho / (1.2 * Math.sqrt(3 * 30 - 7))) * 180) / Math.PI
  for (const noisy of ['new', 'reference'] as const) {
    const turns: number[] = []
    const left: number[] = []
    for (let seed = 0; seed < 6; seed++) {
      const ring36 = smallLoop(1.2, 36, 90 + seed)
      const noise = solverNoise(sigma, 100 + seed)
      await withScenario({
        views: 36,
        newOverrides: noisy === 'new' ? { views: ring36, positionNoise: sigma, seed: 110 + seed } : { views: ring36, positionNoise: 0.001, seed: 110 + seed },
        refSpecOverrides: noisy === 'reference' ? { views: smallLoop(1.2, 36, 120 + seed), positionNoise: sigma, seed: 130 + seed } : { views: smallLoop(1.2, 36, 120 + seed), positionNoise: 0.001, seed: 130 + seed },
        host: { enforceTurnUncertainty: false },
        colmap: noisy === 'new' ? { distort: noise } : { distortReference: noise },
      }, async (s) => {
        const { result } = await runSfmRegistration(s.host, s.request)
        assertEquals(result.status, 'proposed', `${noisy} seed ${seed}: ${result.reason}: ${result.detail}`)
        turns.push(result.turnUncertaintyDeg!)
        if (noisy === 'new') left.push(result.fitTrimmedFrames!)
      })
    }
    const mean = turns.reduce((a, b) => a + b, 0) / turns.length
    assertAlmostEquals(mean / expected, 1, 0.12, `${noisy} is noisy: mean turn uncertainty ${mean} against ${expected} from the noise`)
    if (noisy === 'new') assert(left.reduce((a, b) => a + b, 0) / left.length > 3, `the gate cut a share of the noisy scan's photographs: ${left}`)
  }
})

Deno.test('sfm: a size the solve measures is carried when it clears three of its own standard errors, so a loosely fixed path does not resize a scan by its scatter', async () => {
  // The new session's solved cameras are resized by 3% about their middle: the fit reads that as a unit mismatch of 3%. On a path 0.6 m
  // across with 3 cm of noise on both the recorded and the solved positions the size is fixed to about 1.3%, so what the fit measures
  // is 3% give or take that, and a size is carried only when what it measures clears 3 x 1.3%: a line of 2% would carry most of them.
  const trials: Array<{ measured: number; error: number; carried: number }> = []
  for (let seed = 0; seed < 8; seed++) {
    const loose = smallLoop(0.6, 24, 60 + seed)
    const grow = resized(1.03)(newSpec({ views: loose }, 24))
    const noisy = solverNoise(0.03, 70 + seed)
    await withScenario({
      views: 24,
      newOverrides: { views: loose, positionNoise: 0.03, seed: 80 + seed },
      host: { enforceTurnUncertainty: false },
      colmap: { distort: (name, c) => (name.startsWith('sess-sfm-new/') ? noisy(name, grow(c)) : c) },
    }, async (s) => {
      const { result } = await runSfmRegistration(s.host, s.request)
      assertEquals(result.status, 'proposed', `seed ${seed}: ${result.reason}: ${result.detail}`)
      trials.push({
        measured: result.scaleRatio!,
        error: result.sizeUncertainty!,
        carried: Math.hypot(result.transform![0]!, result.transform![2]!),
      })
    })
  }
  for (const [seed, t] of trials.entries()) {
    const clears = Math.abs(t.measured - 1) >= Math.max(0.02, 3 * t.measured * t.error)
    assertEquals(t.carried !== 1 && Math.abs(t.carried - 1) > 1e-9, clears, `seed ${seed}: measured ${t.measured}, error ${t.error}, carried ${t.carried}`)
    if (clears) assertAlmostEquals(t.carried, t.measured, 1e-9, `seed ${seed}: what is carried is what was measured`)
  }
  assert(trials.every((t) => t.error > 0.01 && t.error < 0.02), `the size is fixed to 1% to 2% on this path: ${trials.map((t) => t.error.toFixed(4))}`)
  const left = trials.filter((t) => Math.abs(t.carried - 1) < 1e-9).length
  assert(left >= 5, `${left} of 8 sizes were left out; a 2% line alone would have left out ${trials.filter((t) => Math.abs(t.measured - 1) < 0.02).length}`)

  // The same 3% on a path fixed to a fifth of a percent is carried.
  const tight = smallLoop(1.3, 24, 34)
  const growTight = resized(1.03)(newSpec({ views: tight }, 24))
  await withScenario({
    views: 24,
    newOverrides: { views: tight, positionNoise: 0.01, seed: 44 },
    colmap: { distort: (name, c) => (name.startsWith('sess-sfm-new/') ? growTight(c) : c) },
  }, async (s) => {
    const { result } = await runSfmRegistration(s.host, s.request)
    assertEquals(result.status, 'proposed', `${result.reason}: ${result.detail}`)
    assert(result.sizeUncertainty! < 0.005, `the size is fixed to ${result.sizeUncertainty}`)
    assertAlmostEquals(Math.hypot(result.transform![0]!, result.transform![2]!), 1.03, 0.01, 'a 3% size that is well measured is carried')
  })
})

// ─── Photographs COLMAP placed wrongly ───────────────────────────────────────

Deno.test('sfm: photographs COLMAP placed wrongly are left out of the fit, so a few of them do not turn or resize the scan', async () => {
  // Two of 24 solved half a metre from where their camera was: under the 0.25 residual gate, so a fit that followed them would be accepted
  // and carry their pull into the proposal.
  const wrongBy = (name: string, c: V3): V3 => {
    const k = Number(name.slice(-9, -4))
    return k === 3 ? [c[0] + 0.5 * SOLVER.scale, c[1], c[2]] : k === 15 ? [c[0] - 0.3 * SOLVER.scale, c[1], c[2] - 0.4 * SOLVER.scale] : c
  }
  await withScenario({ views: 24, newOverrides: { views: smallLoop(1.2, 24, 35), seed: 45 }, colmap: { distort: wrongBy } }, async (s) => {
    const { result } = await runSfmRegistration(s.host, s.request)
    assertEquals(result.status, 'proposed', `${result.reason}: ${result.detail}`)
    const row = result.sessions[0]!
    assertEquals([row.fittedFrames, row.fitTrimmedFrames, row.inliers], [24, 2, 22])
    assertEquals(result.fitTrimmedFrames, 2)
    assertEquals([result.registeredImages, result.offeredImages], [24, 24], 'both were registered by COLMAP: they are left out of the fit, not out of the count')
    const corrected = multiplyMat4(result.transform!, s.moving.localToWorld)
    assert(placementError(s, corrected) < 0.03, `${placementError(s, corrected)} m from where the cameras were`)
    assertAlmostEquals(result.scaleRatio!, 1, 0.01)
    assert(result.residualM! < 0.03, `the fit that is kept agrees: ${result.residualM} m`)
  })
})

Deno.test('sfm: the earlier scan\'s own fit is made without its wrongly placed photographs too', async () => {
  const wrongBy = (name: string, c: V3): V3 => {
    const k = Number(name.slice(-9, -4))
    return k === 2 ? [c[0] + 0.5 * SOLVER.scale, c[1], c[2]] : k === 9 ? [c[0], c[1], c[2] - 0.45 * SOLVER.scale] : c
  }
  await withScenario({ views: 24, newOverrides: { views: smallLoop(1.2, 24, 36), seed: 46 }, refSpecOverrides: { views: smallLoop(1.3, 24, 37) }, colmap: { distortReference: wrongBy } }, async (s) => {
    const { result } = await runSfmRegistration(s.host, s.request)
    assertEquals(result.status, 'proposed', `${result.reason}: ${result.detail}`)
    const corrected = multiplyMat4(result.transform!, s.moving.localToWorld)
    assert(placementError(s, corrected) < 0.03, `${placementError(s, corrected)} m from where the cameras were`)
    assertAlmostEquals(result.scaleRatio!, 1, 0.01)
  })
})

Deno.test('sfm: when too few of the photographs agree there is nothing to trim to, and it is refused as a residual too high', async () => {
  const wrongBy = (name: string, c: V3): V3 => {
    const k = Number(name.slice(-9, -4))
    return k % 2 === 0 ? [c[0] + Math.cos(k) * 1.3 * SOLVER.scale, c[1], c[2] + Math.sin(k * 1.7) * 1.3 * SOLVER.scale] : c
  }
  await withScenario({ views: 24, colmap: { distort: wrongBy } }, async (s) => {
    const { result } = await runSfmRegistration(s.host, s.request)
    assertEquals([result.status, result.reason], ['refused', 'high-residual'])
    assert(/agree with the fit/.test(result.detail), result.detail)
    assertEquals(result.transform, null)
  })
})

// ─── The edges of the numbers ────────────────────────────────────────────────
//
// Each constant is pinned at its literal value and a step either side, so that a change to one is a failing test and not a different
// product. The runs use almost no noise, so the uncertainty term does not move the lines being looked at.

Deno.test('sfm: a size is carried from 2% and not before', async () => {
  for (const [unit, carried] of [[1.019, false], [1.021, true], [0.981, false], [0.979, true]] as const) {
    // A millimetre of noise: the two fits' sizes then scatter by 0.03%, so the lines at 2% are what is being looked at.
    await withScenario({ newOverrides: { unit, positionNoise: 0.001 }, refSpecOverrides: { positionNoise: 0.001 } }, async (s) => {
      const { result } = await runSfmRegistration(s.host, s.request)
      assertEquals(result.status, 'proposed', `unit ${unit}: ${result.reason}: ${result.detail}`)
      const size = Math.hypot(result.transform![0]!, result.transform![2]!)
      if (carried) assertAlmostEquals(size, unit, 0.004, `unit ${unit} is carried`)
      else assertAlmostEquals(size, 1, 1e-9, `unit ${unit} is not`)
      assertAlmostEquals(result.scaleRatio!, unit, 0.01, 'and either way the unit mismatch is recorded')
    })
  }
})

Deno.test('sfm: six of the new photographs registered is enough and five is not, and 60% of them is enough and a photograph fewer is not', async () => {
  assertEquals(SFM_MIN_REGISTERED_IMAGES, 6)
  const dropFrom = (first: number) => ({ drop: (name: string) => name.startsWith('sess-sfm-new/') && Number(name.slice(-9, -4)) >= first })
  // 6 of 6 photographs offered: the minimum count, all registered.
  await withScenario({ views: 6, newOverrides: { views: ringViews(MIDDLE, [1.0, 1.2], 6, 10, 1.35, 12) } }, async (s) => {
    assertEquals((await runSfmRegistration(s.host, s.request)).result.status, 'proposed')
  })
  // 6 of 10: exactly 60%.
  await withScenario({ views: 10, colmap: dropFrom(6) }, async (s) => {
    const { result } = await runSfmRegistration(s.host, s.request)
    assertEquals([result.status, result.registeredImages, result.offeredImages], ['proposed', 6, 10])
  })
  // 5 of 10: under both.
  await withScenario({ views: 10, colmap: dropFrom(5) }, async (s) => {
    const { result } = await runSfmRegistration(s.host, s.request)
    assertEquals([result.reason, result.registeredImages], ['too-few-registered', 5])
  })
  // 6 of 11 is 54.5%: the count is met and the share is not.
  await withScenario({ views: 11, colmap: dropFrom(6) }, async (s) => {
    const { result } = await runSfmRegistration(s.host, s.request)
    assertEquals([result.reason, result.registeredImages, result.offeredImages], ['too-few-registered', 6, 11])
  })
})

Deno.test('sfm: the earlier scan\'s cameras may move 0.1% of how far they are spread and no more', async () => {
  // The spread is the diagonal of the box the reference's solved cameras lie in, in the solver's own units.
  const places = ringSpec('sess-sfm-ref', {}, 14).views.map((view) => view.position)
  const solved = places.map((p) => {
    const r = mulVec(SOLVER.rotation as unknown as Parameters<typeof mulVec>[0], p)
    return [SOLVER.scale * r[0] + SOLVER.translation[0], SOLVER.scale * r[1] + SOLVER.translation[1], SOLVER.scale * r[2] + SOLVER.translation[2]]
  })
  const box = [0, 1, 2].map((i) => Math.max(...solved.map((p) => p[i]!)) - Math.min(...solved.map((p) => p[i]!)))
  const spread = Math.hypot(box[0]!, box[1]!, box[2]!)
  for (const [fraction, reason] of [[0.0009, null], [0.0011, 'reference-moved']] as const) {
    await withScenario({ colmap: { moveReferenceBy: [fraction * spread, 0, 0] } }, async (s) => {
      const { result } = await runSfmRegistration(s.host, s.request)
      if (reason) assertEquals([result.status, result.reason], ['refused', reason], `${fraction} of the spread`)
      else assertEquals(result.status, 'proposed', `${fraction} of the spread: ${result.reason}`)
    })
  }
})

/** The second session of a scan, whose solved cameras the test moves, turns or resizes as a whole (a registration that is clean and answers differently). */
async function twoSessions(move: (spec: ToySessionSpec) => (c: V3) => V3): Promise<{ status: string; reason: string | null; detail: string }> {
  const second = ringSpec('sess-sfm-new2', { yawDeg: 25, origin: [1.2, 0, -0.7], views: ringViews(MIDDLE, [1.1, 1.1], 12, 40, 1.4, 14), seed: 105 }, 12)
  const apply = move(second)
  let outcome = { status: '', reason: null as string | null, detail: '' }
  await withScenario({ extraNewSpecs: [second], colmap: { distort: (name, c) => (name.startsWith('sess-sfm-new2/') ? apply(c) : c) } }, async (s) => {
    const { result } = await runSfmRegistration(s.host, s.request)
    outcome = { status: result.status, reason: result.reason, detail: result.detail }
  })
  return outcome
}

/** Rigidly moves a session's solved cameras by `metres` along the Place frame's x axis. */
const slid = (metres: number) => (_spec: ToySessionSpec) => (c: V3): V3 => {
  const along = mulVec(SOLVER.rotation as unknown as Parameters<typeof mulVec>[0], [metres, 0, 0])
  return [c[0] + SOLVER.scale * along[0], c[1] + SOLVER.scale * along[1], c[2] + SOLVER.scale * along[2]]
}

/** A turn of `deg` about the Place frame's up axis, seen from the solver, about the middle of the session's cameras. */
const turned = (deg: number) => (spec: ToySessionSpec) => {
  const middle = spec.views.reduce<V3>((m, v) => [m[0] + v.position[0] / spec.views.length, m[1] + v.position[1] / spec.views.length, m[2] + v.position[2] / spec.views.length], [0, 0, 0])
  const up = mulVec(SOLVER.rotation as unknown as Parameters<typeof mulVec>[0], [0, 1, 0])
  const at = mulVec(SOLVER.rotation as unknown as Parameters<typeof mulVec>[0], middle)
  const centre: V3 = [SOLVER.scale * at[0] + SOLVER.translation[0], SOLVER.scale * at[1] + SOLVER.translation[1], SOLVER.scale * at[2] + SOLVER.translation[2]]
  const a = (deg * Math.PI) / 180
  return (c: V3): V3 => {
    const d: V3 = [c[0] - centre[0], c[1] - centre[1], c[2] - centre[2]]
    const cross: V3 = [up[1]! * d[2] - up[2]! * d[1], up[2]! * d[0] - up[0]! * d[2], up[0]! * d[1] - up[1]! * d[0]]
    const dot = up[0]! * d[0] + up[1]! * d[1] + up[2]! * d[2]
    return [0, 1, 2].map((i) => centre[i]! + d[i]! * Math.cos(a) + cross[i]! * Math.sin(a) + up[i]! * dot * (1 - Math.cos(a))) as V3
  }
}

/** A size change of `factor` about the middle of the session's cameras, in the solver. */
const resized = (factor: number) => (spec: ToySessionSpec) => {
  const middle = spec.views.reduce<V3>((m, v) => [m[0] + v.position[0] / spec.views.length, m[1] + v.position[1] / spec.views.length, m[2] + v.position[2] / spec.views.length], [0, 0, 0])
  const at = mulVec(SOLVER.rotation as unknown as Parameters<typeof mulVec>[0], middle)
  const centre: V3 = [SOLVER.scale * at[0] + SOLVER.translation[0], SOLVER.scale * at[1] + SOLVER.translation[1], SOLVER.scale * at[2] + SOLVER.translation[2]]
  return (c: V3): V3 => [centre[0] + factor * (c[0] - centre[0]), centre[1] + factor * (c[1] - centre[1]), centre[2] + factor * (c[2] - centre[2])]
}

Deno.test('sfm: two sessions of one scan may put it 15 cm, 2 degrees and 5% apart and no more', async () => {
  // Inside each bound, and well clear of it the other way: the second session answers differently by that much and nothing else.
  assertEquals((await twoSessions(slid(0.12))).status, 'proposed', '12 cm apart')
  assertEquals((await twoSessions(slid(0.19))).reason, 'sessions-disagree', '19 cm apart')
  assertEquals((await twoSessions(turned(1.2))).status, 'proposed', '1.2 degrees apart')
  assertEquals((await twoSessions(turned(3))).reason, 'sessions-disagree', '3 degrees apart')
  assertEquals((await twoSessions(resized(1.03))).status, 'proposed', '3% apart in size')
  const bigger = await twoSessions(resized(1.08))
  assertEquals(bigger.reason, 'sessions-disagree', '8% apart in size')
  assert(/in size/.test(bigger.detail), `the refusal says it is the size: ${bigger.detail}`)
})

Deno.test('sfm: a session COLMAP wrote as a model of its own that is larger than the earlier scan\'s is not read as the registration', async () => {
  // 14 photographs in the earlier scan, 24 in the new one: the new ones' model is the larger. Reading the larger model as the answer
  // would find the earlier scan's cameras missing and call it "moved".
  await withScenario({
    views: 24,
    refSpecOverrides: { views: ringViews(MIDDLE, [1.3, 1.0], 14, 0, 1.45, 11) },
    colmap: { splitNewIntoOtherModel: true },
  }, async (s) => {
    const { result } = await runSfmRegistration(s.host, s.request)
    assertEquals([result.status, result.reason], ['refused', 'sub-model-split'])
    assertEquals([result.sessions[0]!.registeredImages, result.sessions[0]!.inOtherModels, result.sessions[0]!.offeredImages], [0, 24, 24])
  })
})

Deno.test('sfm: when two models hold some of the earlier scan\'s cameras the registration is the one that holds the most of them, not the larger', async () => {
  // The new photographs came out as a model of their own that holds two of the earlier scan's cameras and is the larger (26 images against
  // 14). The earlier scan's own model is the one it was registered into, and none of the new photographs are in it.
  await withScenario({
    views: 24,
    refSpecOverrides: { views: ringViews(MIDDLE, [1.3, 1.0], 14, 0, 1.45, 11) },
    colmap: { splitNewWithReferenceCameras: true },
  }, async (s) => {
    const { result } = await runSfmRegistration(s.host, s.request)
    assertEquals([result.status, result.reason], ['refused', 'sub-model-split'])
    assertEquals([result.sessions[0]!.registeredImages, result.sessions[0]!.inOtherModels], [0, 24])
  })
})

Deno.test('sfm: a model that holds none of the earlier scan\'s cameras is not the registration, wherever COLMAP wrote it', async () => {
  // Only the new photographs came out, as a model of their own: nothing of the earlier scan is in it, so none of them was registered to it.
  await withScenario({ colmap: { newOnlyInOutput: true } }, async (s) => {
    const { result } = await runSfmRegistration(s.host, s.request)
    assertEquals([result.status, result.reason], ['refused', 'sub-model-split'])
    assertEquals([result.sessions[0]!.registeredImages, result.sessions[0]!.inOtherModels], [0, 14])
  })
})

Deno.test('sfm: a registration that placed none of the new photographs, as COLMAP 3.13 does when a room is not the earlier one, is too few registered and not a split', async () => {
  // Measured with the real binary on a rendered room that was not the earlier scan's: one model at the output root holding only the
  // earlier scan's images, so every new photograph is unregistered and none is in a model of its own.
  await withScenario({ colmap: { drop: (name) => name.startsWith('sess-sfm-new/') } }, async (s) => {
    const { result } = await runSfmRegistration(s.host, s.request)
    assertEquals([result.status, result.reason], ['refused', 'too-few-registered'])
    assertEquals([result.sessions[0]!.registeredImages, result.sessions[0]!.inOtherModels], [0, 0])
  })
})

// ─── Where the work goes ─────────────────────────────────────────────────────

Deno.test('sfm: a Place folder that is, or links into, a session directory is never worked in', async () => {
  // A mis-set media directory: the Place's working folder would be inside a session, and its removal at the end of a run would take
  // the session's files (or its own files would be left among photographs).
  await withScenario({}, async (s) => {
    const inside = `${s.sessionsDir}/sess-sfm-ref/${WORK_ROOT_DIR}`
    const { result } = await runSfmRegistration({ ...s.host, workRoot: () => inside }, s.request)
    assertEquals([result.status, result.reason], ['skipped', 'no-place'])
    assertEquals(s.fake.calls.length, 0)
    assertEquals(await listDir(`${s.sessionsDir}/sess-sfm-ref`), ['keyframes.jsonl', ...Array.from({ length: 14 }, (_, i) => `kf-${String(i).padStart(5, '0')}.jpg`), 'session.json'])
  })
  await withScenario({}, async (s) => {
    const link = `${s.root}/scans/projects/${PROJECT}-link`
    await Deno.mkdir(`${s.root}/scans/projects`, { recursive: true })
    await Deno.symlink(await Deno.realPath(`${s.sessionsDir}/sess-sfm-new`), link)
    const { result } = await runSfmRegistration({ ...s.host, workRoot: () => link }, s.request)
    assertEquals([result.status, result.reason], ['skipped', 'no-place'])
    assertEquals(s.fake.calls.length, 0)
    assertEquals((await listDir(`${s.sessionsDir}/sess-sfm-new`)).filter((name) => !/^kf-\d+\.jpg$|^(keyframes\.jsonl|session\.json)$/.test(name)), [])
  })
  // The sessions folder itself.
  await withScenario({}, async (s) => {
    const { result } = await runSfmRegistration({ ...s.host, workRoot: () => s.sessionsDir }, s.request)
    assertEquals([result.status, result.reason], ['skipped', 'no-place'])
  })
})
