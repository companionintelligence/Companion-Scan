/**
 * COLMAP_E2E: the photo method of `place-register` against the real COLMAP binary, on a rendered room.
 *
 * Runs ONLY with COLMAP_E2E=1, and only when a `colmap` binary is found (COLMAP_BIN, then PATH, then the sudo-less install in
 * docs/operations/COLMAP_SETUP.md). With the flag set and no binary it says so and skips; it never fails for a missing tool, and it
 * installs nothing. place_register_sfm.test.ts runs the whole method with COLMAP stood in for, which cannot catch a changed command-line
 * option, a camera COLMAP does not give a session, or a reference model COLMAP will not extend with its cameras held fixed: this can.
 *
 * The data is synthetic and made here (tests/unit/deno/toy_sfm_scene.ts): a reference session and a new session of one rendered room,
 * each with its own lens, its own AR frame, the new one with a unit 12% bigger and a calibration that is a few decimetres and degrees off.
 * No real user data is ever given to COLMAP by any test. SIFT only, CPU only, as in production. About a minute on a 32-thread box;
 * the room is easy (no blur, no lighting change, no moved furniture), so a pass shows that the plumbing and the algebra are right, not
 * that a real room will register.
 *
 *   COLMAP_E2E=1 deno test --allow-read --allow-write --allow-env --allow-run --allow-ffi \
 *     --filter COLMAP_E2E tests/unit/deno/place_register_sfm_toy.test.ts
 *
 * What it checks:
 *   1. the method runs from the scan's photographs to a proposal: the reference model is made, the new photographs are registered
 *      against it with its cameras held fixed, and the proposal moves the new scan's recorded cameras to where they really were;
 *   2. the unit mismatch of the new session comes back as the scale ratio;
 *   3. the work directory is gone, and the reference model is kept inside the reference session's own folder (and nowhere else);
 *   4. a second run reuses that model and gives the same move;
 *   5. deleting the reference session's folder takes the kept model with it.
 */
import { assert, assertAlmostEquals, assertEquals } from 'jsr:@std/assert@^1.0.0'

import { locateColmapBin } from '../../../server/colmap/colmap_poses.ts'
import { runSfmRegistration, type SfmHost } from '../../../server/register/place_register_sfm.ts'
import { referenceCacheDir, WORK_ROOT_DIR } from '../../../server/register/sfm_workspace.ts'
import { applySim3, sim3FromColumnMajor } from '../../../server/register/sim3_chain.ts'
import { multiplyMat4 } from '../../../src/world/register-proposal.ts'
import { MIDDLE, scanManifest, storedMatrix } from './sfm_fixtures.ts'
import { lookAtGl, type ToySessionSpec, type ToyView, type V3, writeToySession } from './toy_sfm_scene.ts'

const wanted = Deno.env.get('COLMAP_E2E') === '1'
const located = wanted
  ? await locateColmapBin(Deno.env.get('COLMAP_BIN') ?? 'colmap')
  : { bin: null, pathProbe: 'not-tried' as const }
if (wanted && !located.bin) {
  console.warn('[colmap-e2e] COLMAP_E2E=1 but no colmap binary was found (COLMAP_BIN, PATH, ~/.local/micromamba/envs/colmap/bin); the photo-method toy test is skipped.')
}

const VIEWS = 36
const PROJECT = 'proj-toy'
const FRAME = 'frame-toy'

/**
 * A walk round `centre` on an ellipse, every camera looking `offsetDeg` ahead of the outward direction. A session that has to be solved
 * by ITSELF (the reference model is made from one session) needs more than a ring that looks straight out: the toy test's rings only
 * register because three of them are solved together, and one alone splits into models. Measured with COLMAP 3.13 on this room: a ring
 * of 14 outward views with random aim does not initialise; 36 views each aimed 35 degrees along the walk register 36 of 36 in one model;
 * 50 degrees splits them in two.
 */
function walkViews(centre: V3, radii: [number, number], count: number, startDeg: number, height: number, offsetDeg: number): ToyView[] {
  return Array.from({ length: count }, (_, i) => {
    const a = ((startDeg + (360 * i) / count) * Math.PI) / 180
    const position: V3 = [centre[0] + radii[0] * Math.cos(a), height + 0.05 * Math.sin(3 * a), centre[2] + radii[1] * Math.sin(a)]
    const look = a + (offsetDeg * Math.PI) / 180
    const target: V3 = [position[0] + 3 * Math.cos(look), position[1], position[2] + 3 * Math.sin(look)]
    return { position, rotation: lookAtGl(position, target) }
  })
}

const REFERENCE: ToySessionSpec = {
  sessionId: 'sess-toy-ref', width: 640, height: 480, focalPx: 520, unit: 1, yawDeg: 0, origin: [0, 0, 0],
  views: walkViews(MIDDLE, [1.3, 1.0], VIEWS, 0, 1.4, 35), positionNoise: 0.01, seed: 101,
}
const NEWER: ToySessionSpec = {
  sessionId: 'sess-toy-new', width: 640, height: 480, focalPx: 450, unit: 1.12, yawDeg: -40, origin: [-0.5, 0, 0.9],
  views: walkViews(MIDDLE, [1.1, 1.2], VIEWS, 5, 1.5, 30), positionNoise: 0.01, seed: 103,
}
/** What the app would hold for the new session: a few degrees and decimetres off the truth. The reference defines the Place frame. */
const ERROR = { yawDeg: -3, shift: [0.2, 0, 0.3] as V3 }

async function writeSession(sessionsDir: string, spec: ToySessionSpec, glbFilename: string) {
  const written = await writeToySession(sessionsDir, spec)
  await Deno.writeTextFile(
    `${written.sessionDir}/session.json`,
    JSON.stringify({ sessionId: spec.sessionId, startedAt: new Date().toISOString(), keyframeCount: VIEWS, glbFilename }, null, 2),
  )
  return written
}

/** RMS gap, metres, between where the recorded cameras land under `placement` and where they really were. */
function gap(placement: number[], spec: ToySessionSpec, recorded: ReadonlyArray<{ position: V3 }>): number {
  const sim = sim3FromColumnMajor(placement)!
  let sum = 0
  recorded.forEach((view, k) => {
    const here = applySim3(sim, view.position)
    const there = spec.views[k]!.position
    sum += (here[0] - there[0]) ** 2 + (here[1] - there[1]) ** 2 + (here[2] - there[2]) ** 2
  })
  return Math.sqrt(sum / recorded.length)
}

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path)
    return true
  } catch {
    return false
  }
}

Deno.test({
  name: 'COLMAP_E2E: the photo method registers a rendered session against a reference with the real COLMAP, keeps the model, and reuses it',
  ignore: !wanted || !located.bin,
  fn: async () => {
    const root = await Deno.makeTempDir({ prefix: 'sfm-toy-' })
    try {
      const sessionsDir = `${root}/scans/sessions`
      await writeSession(sessionsDir, REFERENCE, 'scan-ref.glb')
      const newer = await writeSession(sessionsDir, NEWER, 'scan-new.glb')

      const reference = scanManifest('scan-ref', REFERENCE.sessionId, storedMatrix(REFERENCE, { yawDeg: 0, shift: [0, 0, 0] }), { calibrationFrameId: FRAME })
      const moving = scanManifest('scan-new', NEWER.sessionId, storedMatrix(NEWER, ERROR), { calibrationFrameId: FRAME })
      const workRoot = `${root}/scans/projects/${PROJECT}/${WORK_ROOT_DIR}`
      const host: SfmHost = {
        enabled: true,
        sessionsDir,
        workRoot: (projectId) => `${root}/scans/projects/${projectId}/${WORK_ROOT_DIR}`,
        readScanMeta: async () => ({ frameEpochs: { calibrationEpoch: 0 } }),
        jobId: 'job-toy-1',
        colmapBin: located.bin!,
        wallClockMs: 20 * 60 * 1000,
      }
      const request = { place: { projectId: PROJECT, frameId: FRAME }, moving, references: [reference] }

      // 1 and 2. The first run makes the reference model and registers the new photographs against it.
      const first = await runSfmRegistration(host, request)
      const result = first.result
      assertEquals(result.status, 'proposed', `${result.reason}: ${result.detail}`)
      assertEquals(result.referenceModel, 'built')
      assert(result.registeredImages >= VIEWS - 4, `${result.registeredImages} of ${result.offeredImages} photographs found their place`)
      assert(result.inliers >= VIEWS - 4, `${result.inliers} inliers`)
      const before = gap(moving.localToWorld, NEWER, newer.recorded)
      const after = gap(multiplyMat4(result.transform!, moving.localToWorld), NEWER, newer.recorded)
      assert(before > 0.25, `the calibration was ${before} m out to start with`)
      assert(after < 0.12, `the cameras are ${after} m from where they were, after the move`)
      assertAlmostEquals(result.scaleRatio!, NEWER.unit, 0.04, 'the unit mismatch between the two runtimes')
      console.log(
        `[colmap-e2e] photo method: ${result.registeredImages}/${result.offeredImages} photographs registered, ${result.inliers} inliers, ` +
          `rms ${(result.residualM! * 100).toFixed(1)} cm, scale ${result.scaleRatio!.toFixed(3)} (truth ${NEWER.unit}), ` +
          `cameras ${(before * 100).toFixed(0)} cm out before, ${(after * 100).toFixed(1)} cm after, ${Math.round(result.elapsedMs / 1000)} s`,
      )

      // 3. Nothing is left in the work folder, and the reference model is inside the reference session's folder.
      assertEquals(await exists(`${workRoot}/${'job-toy-1'}`), false, 'the work directory is gone')
      const cache = referenceCacheDir(`${sessionsDir}/${REFERENCE.sessionId}`)
      assert(await exists(cache), 'the reference model is kept with the reference session')
      assertEquals(await exists(referenceCacheDir(`${sessionsDir}/${NEWER.sessionId}`)), false, 'and not with the new one')

      // 4. The second run solves only the new photographs and gives the same move.
      const second = await runSfmRegistration({ ...host, jobId: 'job-toy-2' }, request)
      assertEquals(second.result.status, 'proposed', `${second.result.reason}: ${second.result.detail}`)
      assertEquals(second.result.referenceModel, 'reused')
      const again = gap(multiplyMat4(second.result.transform!, moving.localToWorld), NEWER, newer.recorded)
      assert(again < 0.12, `${again} m on the second run`)
      assertEquals(await exists(`${workRoot}/${'job-toy-2'}`), false)

      // 5. The model goes with the session it was made from.
      await Deno.remove(`${sessionsDir}/${REFERENCE.sessionId}`, { recursive: true })
      assertEquals(await exists(cache), false)
    } finally {
      await Deno.remove(root, { recursive: true })
    }
  },
})
