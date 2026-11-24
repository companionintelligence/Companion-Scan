/**
 * Scenes for the marker-session tests (WP-14b): a tag fixed in the session, a camera that walks round it, and the frames a detector
 * would hand over for it, with exact corners (plus noise if asked), so the module under test is the only thing that can be wrong.
 *
 * The camera model is written out from three.js's convention (a camera looks down -z, +y up) by `fiducial-render.ts`, not through the
 * pose module's own OpenCV-to-three.js conversion, so a flipped axis there shows up as an error here instead of cancelling out.
 */
import { mulberry32 } from '../../src/shared/test-homes.ts'
import type { CameraIntrinsics, FiducialDetection, Quad, TagObservation } from '../../src/ar/fiducial/types.ts'
import type { TagFrameInput } from '../../src/ar/fiducial/tag-session.ts'
import { INTRINSICS_640, lookAtPose, mat3Mul, matrixFromQuat, projectSessionTag, quatFromMatrix, rotX, rotY, type SessionPoseLike } from './fiducial-render.ts'

export function gaussian(rand: () => number): () => number {
  return () => {
    let u = 0
    while (u === 0) u = rand()
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand())
  }
}

/** A tag fixed in the session, turned `yawDeg` about the vertical and tipped `pitchDeg` about its own horizontal (0 pitch is a wall tag, whose normal is horizontal). */
export function fixedTag(yawDeg = 20, pitchDeg = 0, position = { x: 0.3, y: 1.3, z: -3 }): SessionPoseLike {
  return { position, rotation: quatFromMatrix(mat3Mul(rotY((yawDeg * Math.PI) / 180), rotX((pitchDeg * Math.PI) / 180))) }
}

/** A tag lying flat, face up, its printed up axis pointing along session -z turned by `spinDeg` about the vertical: the "plaque" mount. */
export function flatTag(spinDeg = 0, position = { x: 0.3, y: 0.7, z: -3 }): SessionPoseLike {
  // Tag +z (its normal) to session +y: a quarter turn about x; then spin about the vertical.
  const up = mat3Mul(rotY((spinDeg * Math.PI) / 180), rotX((-Math.PI) / 2))
  return { position, rotation: quatFromMatrix(up) }
}

export interface WalkOptions {
  tag?: SessionPoseLike
  /** Camera distance from the tag, metres (scaled by `scale` in session units). */
  range: number
  frames: number
  /** The arc the camera walks round the tag, degrees, centred on the tag's front. */
  arcDeg: number
  /** Where on the arc the walk is centred, degrees from straight in front of a tag that faces +z. Default 0. */
  centreDeg?: number
  intrinsics?: CameraIntrinsics
  /** Corner noise in pixels (added to exact projections). */
  cornerNoise?: number
  seed?: number
  /** Session units per metre: camera positions and the tag's printed size are expressed in session units. */
  scale?: number
  /** Printed edge of the black square, metres. Default 0.2. */
  sizeM?: number
  /** The size the tag is drawn at as a fraction of `sizeM`: 0.95 is a print that shrank by 5 %. Default 1. */
  printScale?: number
  /** Camera height relative to the tag centre, metres. Default -0.1. */
  heightM?: number
  /** Time between frames, milliseconds. Default 100. */
  dtMs?: number
  /** Time of the first frame. Default 0. */
  t0Ms?: number
  /** Focal length the corners were drawn with, relative to the one the observation claims: 1.02 draws through a lens 2 % longer than the intrinsics say. Default 1. */
  focalError?: number
}

export interface Walk {
  tag: SessionPoseLike
  observations: TagObservation[]
  cameras: SessionPoseLike[]
  /** Angular speed between consecutive cameras, degrees per second; null for the first frame. */
  speeds: Array<number | null>
  intrinsics: CameraIntrinsics
  sizeM: number
  timesMs: number[]
}

/** Observations of a fixed tag from a camera walking an arc round it. */
export function walk(o: WalkOptions): Walk {
  const tag = o.tag ?? fixedTag()
  const k = o.intrinsics ?? INTRINSICS_640
  const rand = mulberry32(o.seed ?? 1)
  const g = gaussian(rand)
  const scale = o.scale ?? 1
  const sizeM = o.sizeM ?? 0.2
  const dt = o.dtMs ?? 100
  const t0 = o.t0Ms ?? 0
  const drawn: CameraIntrinsics = { ...k, fx: k.fx * (o.focalError ?? 1), fy: k.fy * (o.focalError ?? 1) }
  const observations: TagObservation[] = []
  const cameras: SessionPoseLike[] = []
  const speeds: Array<number | null> = []
  const timesMs: number[] = []
  for (let i = 0; i < o.frames; i++) {
    const a = ((i / Math.max(1, o.frames - 1) - 0.5) * (o.arcDeg * Math.PI)) / 180 + ((o.centreDeg ?? 0) * Math.PI) / 180
    const radius = o.range * scale
    const position = { x: tag.position.x + Math.sin(a) * radius, y: tag.position.y + (o.heightM ?? -0.1) * scale, z: tag.position.z + Math.cos(a) * radius }
    const cam = lookAtPose(position, tag.position)
    const exact = projectSessionTag(tag, cam, drawn, sizeM * (o.printScale ?? 1) * scale)
    const corners = exact.map((c) => ({ x: c.x + (o.cornerNoise ?? 0) * g(), y: c.y + (o.cornerNoise ?? 0) * g() })) as unknown as Quad
    cameras.push(cam)
    const t = t0 + i * dt
    timesMs.push(t)
    observations.push({ corners, intrinsics: k, cameraPose: cam, timestampMs: t })
    if (i === 0) speeds.push(null)
    else {
      const prev = matrixFromQuat(cameras[i - 1]!.rotation)
      const cur = matrixFromQuat(cam.rotation)
      // Angle of the relative rotation.
      let tr = 0
      for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) tr += prev[c * 3 + r]! * cur[c * 3 + r]!
      const angle = (Math.acos(Math.max(-1, Math.min(1, (tr - 1) / 2))) * 180) / Math.PI
      speeds.push(angle / (dt / 1000))
    }
  }
  return { tag, observations, cameras, speeds, intrinsics: k, sizeM, timesMs }
}

/** A detection of `corners` as the detector would report it for a good, refined read of tag `id` in family `family`. */
export function detectionOf(corners: Quad, id: number, family: string, overrides: Partial<FiducialDetection> = {}): FiducialDetection {
  let side = 0
  for (let i = 0; i < 4; i++) {
    const a = corners[i]!
    const b = corners[(i + 1) % 4]!
    side += Math.hypot(b.x - a.x, b.y - a.y)
  }
  return {
    id,
    family,
    corners,
    hamming: 0,
    quality: 0.9,
    sidePx: side / 4,
    contrast: 150,
    edgeRmsPx: 0.1,
    edgeInlierFraction: 0.98,
    refined: true,
    level: 0,
    ...overrides,
  }
}

/** The frames a session would be offered for a walk: every frame read as tag `id` of `family`, with the camera's speed. */
export function frameInputs(w: Walk, id: number, family: string, overrides: (i: number) => Partial<TagFrameInput> & { detection?: Partial<FiducialDetection> | null } = () => ({})): TagFrameInput[] {
  return w.observations.map((o, i) => {
    const { detection, ...rest } = overrides(i)
    return {
      timestampMs: w.timesMs[i]!,
      detections: detection === null ? [] : [detectionOf(o.corners, id, family, detection ?? {})],
      intrinsics: o.intrinsics,
      cameraPose: o.cameraPose,
      angularSpeedDegPerS: w.speeds[i]!,
      epoch: 0,
      ...rest,
    }
  })
}
