/**
 * What the photo method's tests share: keyframe sessions written without rendering a picture, scans that name them, and a stand-in COLMAP
 * that answers with a canned model built from a known truth. Not a test file: Deno only runs `*.test.ts`.
 *
 * ## The truth these build
 *
 * Every camera has a true place in the Place frame (`ToyView.position`, from `ringViews`). Each session records its cameras in its own
 * AR frame, which is the Place frame turned, moved and (for a runtime with another unit) scaled (`ToySessionSpec`, as in the toy COLMAP
 * test). The stand-in COLMAP's world W is the Place frame through an arbitrary similarity `Q` (another size, a turn about a tilted axis,
 * a shift), so a solved camera is `Q(true place)`. With that, `T_ref x Sim_ref^-1 x Sim_new` is exactly the new session's true frame and
 * the method's answer can be compared with what was injected, to the noise put on the recorded positions.
 *
 * The cameras' orientations are not modelled: the method reads camera centres only, and the stand-in writes every image with the
 * identity rotation and the translation that puts its centre where the truth says.
 */
import { assertEquals } from 'jsr:@std/assert@^1.0.0/equals'
import { relative } from '@std/path'

import { parseImagesBin, rotationToQuat } from '../../../server/colmap/colmap_model.ts'
import type { ColmapSpawn } from '../../../server/colmap/colmap_reference.ts'
import { type Sim3, sim3ToColumnMajor } from '../../../server/register/sim3_chain.ts'
import type { ScanManifest } from '../../../src/world/types.ts'
import { encodeCamerasBin, encodeImagesBin, encodePoints3DBin, jpegHeader, type StubImage } from './colmap_model_fixtures.ts'
import {
  gaussian,
  matMul,
  mulberry32,
  mulVec,
  rotY,
  sessionTruth,
  ringViews,
  type ToySessionSpec,
  transpose,
  type V3,
} from './toy_sfm_scene.ts'

export { ringViews, rotY, sessionTruth, type ToySessionSpec, type V3 }

/** The middle of the toy room, which the rings are walked round. */
export const MIDDLE: V3 = [2.5, 0, 2.0]

/** A scan manifest with the fields the method and the job read. */
export function scanManifest(scanId: string, sessionId: string | null, localToWorld: number[], overrides: Partial<ScanManifest> = {}): ScanManifest {
  return {
    scanId,
    projectId: 'proj-sfm',
    sessionId,
    filename: `${scanId}.glb`,
    name: `Scan ${scanId}`,
    glbUrl: `/scans/${scanId}.glb`,
    geoPose: { lat: null, lng: null, altitudeM: null, bearing: null, accuracyM: null },
    localToWorld,
    accuracyM: null,
    geoDistanceM: null,
    calibrationMethod: 'two-point-ground',
    calibrationStatus: 'provisional',
    capturedAt: '2026-11-10T09:00:00.000Z',
    pointCount: 1000,
    detectionCount: 0,
    layerIndex: [],
    status: 'ready',
    ...overrides,
  }
}

/** What the app would hold for a session: its calibration, a turn and a shift about the truth. A rigid matrix has no unit in it. */
export function storedCalibration(spec: ToySessionSpec, error: { yawDeg: number; shift: V3 }): Sim3 {
  const truth = sessionTruth(spec)
  return {
    rotation: rotY(spec.yawDeg + error.yawDeg),
    translation: [truth.translation[0] + error.shift[0], truth.translation[1] + error.shift[1], truth.translation[2] + error.shift[2]],
    scale: 1,
  }
}

export function storedMatrix(spec: ToySessionSpec, error: { yawDeg: number; shift: V3 }): number[] {
  return sim3ToColumnMajor(storedCalibration(spec, error))
}

/** The three sessions' placements the tests use, keyed by what the toy COLMAP test calls them. */
export function ringSpec(sessionId: string, overrides: Partial<ToySessionSpec> = {}, views = 14): ToySessionSpec {
  return {
    sessionId,
    width: 640,
    height: 480,
    focalPx: 520,
    unit: 1,
    yawDeg: 0,
    origin: [0, 0, 0],
    views: ringViews(MIDDLE, [1.3, 1.0], views, 0, 1.45, 11),
    positionNoise: 0.01,
    seed: 101,
    ...overrides,
  }
}

export interface WrittenSession {
  sessionDir: string
  files: string[]
}

/**
 * Writes one keyframe session the way the server does: `session.json`, `keyframes.jsonl` (the AR pose in the session's own frame and
 * units with noise, the epoch and the intrinsics) and a `kf-NNNNN.jpg` per frame that is only a JPEG header carrying the size. Which
 * scan it belongs to is `glbFilename`, as a finalized session records it.
 */
export async function writeFakeSession(
  sessionsDir: string,
  spec: ToySessionSpec,
  options: { glbFilename?: string; epoch?: number; startedAt?: string; unposed?: boolean; frameSalt?: number } = {},
): Promise<WrittenSession> {
  const sessionDir = `${sessionsDir}/${spec.sessionId}`
  await Deno.mkdir(sessionDir, { recursive: true })
  const truth = sessionTruth(spec)
  const toSession = transpose(truth.rotation)
  const next = mulberry32(spec.seed)
  const fovYDeg = (2 * Math.atan(spec.height / (2 * spec.focalPx)) * 180) / Math.PI
  const lines: string[] = []
  const files: string[] = []
  for (let i = 0; i < spec.views.length; i++) {
    const view = spec.views[i]!
    const file = `kf-${String(i).padStart(5, '0')}.jpg`
    await Deno.writeFile(`${sessionDir}/${file}`, jpegHeader(spec.width, spec.height, (options.frameSalt ?? 0) + i))
    const local = mulVec(toSession, [view.position[0] - truth.translation[0], view.position[1] - truth.translation[1], view.position[2] - truth.translation[2]])
    const position: V3 = [
      local[0] / truth.unit + gaussian(next) * spec.positionNoise,
      local[1] / truth.unit + gaussian(next) * spec.positionNoise,
      local[2] / truth.unit + gaussian(next) * spec.positionNoise,
    ]
    const [w, x, y, z] = rotationToQuat(matMul(toSession, view.rotation))
    files.push(file)
    lines.push(JSON.stringify({
      index: i,
      file,
      timestamp: i * 1000,
      ...(options.unposed ? {} : { pose: { position: { x: position[0], y: position[1], z: position[2] }, rotation: { x, y, z, w } } }),
      epoch: options.epoch ?? 0,
      intrinsics: { fovYDeg, aspect: spec.width / spec.height, width: spec.width, height: spec.height, sourceWidth: spec.width, sourceHeight: spec.height },
    }))
  }
  await Deno.writeTextFile(`${sessionDir}/keyframes.jsonl`, lines.join('\n') + '\n')
  await Deno.writeTextFile(
    `${sessionDir}/session.json`,
    JSON.stringify({
      sessionId: spec.sessionId,
      startedAt: options.startedAt ?? new Date().toISOString(),
      keyframeCount: spec.views.length,
      ...(options.glbFilename ? { glbFilename: options.glbFilename } : {}),
    }, null, 2),
  )
  return { sessionDir, files }
}

// ─── The stand-in COLMAP ─────────────────────────────────────────────────────

/** `Q`: the Place frame as the solver sees it. Not gravity-aligned and not metres. */
export interface SolverFrame {
  scale: number
  /** Row-major 3x3 rotation. */
  rotation: number[][]
  translation: V3
}

/** A turn of `deg` degrees about the unit-ish `axis`, row-major (Rodrigues). */
export function turnAbout(axis: V3, deg: number): number[][] {
  const n = Math.hypot(...axis)
  const [x, y, z] = [axis[0] / n, axis[1] / n, axis[2] / n]
  const a = (deg * Math.PI) / 180
  const c = Math.cos(a)
  const s = Math.sin(a)
  const t = 1 - c
  return [
    [t * x * x + c, t * x * y - s * z, t * x * z + s * y],
    [t * x * y + s * z, t * y * y + c, t * y * z - s * x],
    [t * x * z - s * y, t * y * z + s * x, t * z * z + c],
  ]
}

export const SOLVER: SolverFrame = { scale: 0.37, rotation: turnAbout([0.3, 1, 0.2], 41), translation: [5, -2, 3] }

function toSolver(q: SolverFrame, place: V3): V3 {
  const r = mulVec(q.rotation as unknown as Parameters<typeof mulVec>[0], place)
  return [q.scale * r[0] + q.translation[0], q.scale * r[1] + q.translation[1], q.scale * r[2] + q.translation[2]]
}

/** What the stand-in is told about the world: where every image really is. The key is the image name, `<sessionId>/kf-NNNNN.jpg`. */
export interface FakeWorld {
  /** True camera centres in the Place frame, by image name. */
  places: Map<string, V3>
  solver?: SolverFrame
}

export function worldOf(specs: readonly ToySessionSpec[], solver: SolverFrame = SOLVER): FakeWorld {
  const places = new Map<string, V3>()
  for (const spec of specs) {
    spec.views.forEach((view, k) => places.set(`${spec.sessionId}/kf-${String(k).padStart(5, '0')}.jpg`, view.position))
  }
  return { places, solver }
}

export interface FakeColmapOptions {
  world: FakeWorld
  /** The step (its first argument, or `mapper(register)` for the registration pass) that exits with an error, with this stderr. */
  failOn?: { step: string; stderr?: string; code?: number }
  /** A step that never answers: the wall clock has to end it. */
  hangOn?: string
  /** Names the mapper does not place (a photograph that could not be registered). */
  drop?: (name: string) => boolean
  /** Adds this to every reference camera's position in the registration output (a reference that moved). */
  moveReferenceBy?: V3
  /** Replaces a registered image's solved centre (the stand-in's answer is wrong for it). */
  distort?: (name: string, centre: V3) => V3
  /** The same for the earlier scan's photographs when its own model is made: the reference's solve is not exact either. */
  distortReference?: (name: string, centre: V3) => V3
  /** Writes the registration's new images as a model of their own beside the reference's, as COLMAP does with a session it cannot tie in. */
  splitNewIntoOtherModel?: boolean
  /** Writes only the registration's new images, as a model with none of the reference's cameras in it. */
  newOnlyInOutput?: boolean
  /** Writes the registration's new images as a model of their own that also holds two of the reference's cameras, beside the reference's own model. */
  splitNewWithReferenceCameras?: boolean
  /** Called with each command, before it is answered, for a test that has to look at the disk while COLMAP is "running". */
  onCall?: (args: string[]) => Promise<void> | void
}

export interface FakeColmap {
  spawn: ColmapSpawn
  /** Every command line, as words. */
  calls: string[][]
  /** The names of the commands, in order, with the registration pass told apart (`mapper(register)`). */
  steps(): string[]
}

function argOf(args: readonly string[], name: string): string | undefined {
  const at = args.indexOf(name)
  return at >= 0 ? args[at + 1] : undefined
}

async function writeModel(dir: string, images: Array<{ name: string; centre: V3; camera: number }>, cameras: number[]): Promise<void> {
  await Deno.mkdir(dir, { recursive: true })
  const stub: StubImage[] = images.map((image, i) => ({
    id: i + 1,
    q: [1, 0, 0, 0],
    // World-to-camera with the identity rotation: the camera centre is minus the translation.
    t: [-image.centre[0], -image.centre[1], -image.centre[2]],
    cam: image.camera,
    name: image.name,
  }))
  await Deno.writeFile(`${dir}/images.bin`, encodeImagesBin(stub))
  await Deno.writeFile(`${dir}/cameras.bin`, encodeCamerasBin(cameras.map((id) => ({ id, w: 640, h: 480, params: [520, 320, 240, 0.0] }))))
  await Deno.writeFile(`${dir}/points3D.bin`, encodePoints3DBin(200))
}

/** A COLMAP that answers every command the photo method gives it, from the truth in `options.world`. */
export function fakeColmap(options: FakeColmapOptions): FakeColmap {
  const calls: string[][] = []
  const steps: string[] = []
  const solver = options.world.solver ?? SOLVER
  const solved = (name: string): V3 | null => {
    const place = options.world.places.get(name)
    return place ? toSolver(solver, place) : null
  }
  const spawn: ColmapSpawn = async (_bin, args) => {
    calls.push([...args])
    const command = args[0]!
    const registering = command === 'mapper' && args.includes('--Mapper.fix_existing_frames')
    const step = registering ? 'mapper(register)' : command
    steps.push(step)
    await options.onCall?.(args)
    if (options.hangOn === step) return await new Promise<never>(() => {})
    if (options.failOn?.step === step) return { code: options.failOn.code ?? 1, stderr: options.failOn.stderr ?? `${step} failed` }

    if (command === 'feature_extractor') {
      const db = argOf(args, '--database_path')!
      const root = await Deno.realPath(argOf(args, '--image_path')!)
      const listed = (await Deno.readTextFile(argOf(args, '--image_list_path')!)).split('\n').filter((line) => line !== '')
      // COLMAP stores an image under the path its file RESOLVES to, relative to the image root: for a symbolic link that is the
      // link's target (`../../sessions/sess-x/kf.jpg`), which is why no frame is linked. Measured with COLMAP 3.13.
      const stored: string[] = []
      for (const name of listed) {
        try {
          stored.push(relative(root, await Deno.realPath(`${root}/${name}`)))
        } catch { /* a file that is not there is not read, as COLMAP skips it */ }
      }
      // The database is a file COLMAP writes into: made if absent, kept and added to if it is a copy of the reference's.
      let held: string[] = []
      try {
        held = (await Deno.readTextFile(db)).split('\n').filter((line) => line !== '')
      } catch { /* a new database */ }
      const have = new Set(held)
      for (const name of stored) if (!have.has(`image ${name}`)) held.push(`image ${name}`)
      await Deno.writeTextFile(db, held.join('\n') + '\n')
    }
    if (command === 'matches_importer') {
      const db = argOf(args, '--database_path')!
      const held = (await Deno.readTextFile(db)).split('\n').filter((line) => line !== '')
      const images = new Set(held.filter((line) => line.startsWith('image ')).map((line) => line.slice('image '.length)))
      // A pair that names an image the database does not hold is skipped with an error and the step still succeeds, as COLMAP does.
      for (const line of (await Deno.readTextFile(argOf(args, '--match_list_path')!)).split('\n')) {
        const [a, b] = line.split(' ')
        if (a && b && images.has(a) && images.has(b)) held.push(`pair ${a} ${b}`)
      }
      await Deno.writeTextFile(db, held.join('\n') + '\n')
    }
    if (command === 'mapper') {
      const db = argOf(args, '--database_path')!
      const out = argOf(args, '--output_path')!
      const input = argOf(args, '--input_path')
      // The mapper reads the database, not the folder: only images with a match to another image can be placed.
      const matched = new Set<string>()
      for (const line of (await Deno.readTextFile(db)).split('\n')) {
        if (!line.startsWith('pair ')) continue
        const [, a, b] = line.split(' ')
        matched.add(a!)
        matched.add(b!)
      }
      if (matched.size === 0) return { code: 1, stderr: 'W incremental_pipeline.cc:288] No images with matches found in the database\nE sfm.cc:278] failed to create sparse model' }
      const present = [...matched].sort()
      if (!input) {
        const images = present.filter((name) => !options.drop?.(name)).flatMap((name) => {
          const centre = solved(name)
          return centre
            ? [{ name, centre: options.distortReference ? options.distortReference(name, centre) : centre, camera: 1 + Number(name.split('/')[0] !== present[0]!.split('/')[0]) }]
            : []
        })
        await writeModel(`${out}/0`, images, [1])
      } else {
        const inputImages = parseImagesBin(await Deno.readFile(`${input}/images.bin`))
        const known = new Set(inputImages.map((image) => image.name))
        const keep = inputImages.map((image) => {
          const was: V3 = [-image.tvec[0], -image.tvec[1], -image.tvec[2]]
          const centre: V3 = options.moveReferenceBy && registering
            ? [was[0] + options.moveReferenceBy[0], was[1] + options.moveReferenceBy[1], was[2] + options.moveReferenceBy[2]]
            : was
          return { name: image.name, centre, camera: image.cameraId }
        })
        const added = present.filter((name) => !known.has(name) && !options.drop?.(name)).flatMap((name) => {
          const centre = solved(name)
          if (!centre) return []
          return [{ name, centre: options.distort ? options.distort(name, centre) : centre, camera: 2 }]
        })
        if (options.splitNewIntoOtherModel && registering) {
          await writeModel(`${out}/0`, keep, [1])
          await writeModel(`${out}/1`, added, [2])
        } else if (options.splitNewWithReferenceCameras && registering) {
          await writeModel(`${out}/0`, keep, [1])
          await writeModel(`${out}/1`, [...added, ...keep.slice(0, 2)], [2])
        } else if (options.newOnlyInOutput && registering) {
          await writeModel(`${out}/0`, added, [2])
        } else {
          await writeModel(out, [...keep, ...added], [1, 2])
        }
      }
    }
    return { code: 0, stderr: '' }
  }
  return { spawn, calls, steps: () => steps }
}

/** The room's recorded positions of a session carried to the Place by the truth, for the tests that compare a correction with what was injected. */
export function recordedToPlace(spec: ToySessionSpec, written: readonly { position: V3 }[]): V3[] {
  const truth = sessionTruth(spec)
  return written.map(({ position }) => {
    const r = mulVec(truth.rotation, position)
    return [truth.unit * r[0] + truth.translation[0], truth.unit * r[1] + truth.translation[1], truth.unit * r[2] + truth.translation[2]]
  })
}

/** `assertEquals` for a list of steps with a message that names the list that was seen. */
export function assertSteps(fake: FakeColmap, expected: string[]): void {
  assertEquals(fake.steps(), expected)
}
