/**
 * The hooks for an oracle parity run (WP-14a amendment): the same rendered scenes, handed to any detector, and a report that compares
 * what it found with where the tags truly are.
 *
 * WP-14b keeps an AprilTag build as a dev-only oracle and a contingency, to be built once the owner approves the toolchain (it is not
 * built here and nothing in this file needs it). When it exists, it is a function from a frame to detections, `ParityDetector`, and
 * `runParity(oracle, parityScenes(...))` says how recall, corner error and false positives compare with `inHouseParityDetector`'s on
 * identical frames, family by family (render the scenes with each family's dictionary). Until then the in-house detector is the only one
 * run through it, which is what `fiducial_harness.test.ts` checks: that the hook works, and what the in-house detector does with each
 * condition on THIS harness's frames.
 *
 * The scenes cover the conditions the harness models (clean, sensor noise and blur, a hard cast shadow across half the tag, low light
 * with noise, a patch of glare, rolling-shutter skew) at a few ranges and tilts, and frames with no tag in them. The truth corners are
 * computed here from the pose and the lens with this file's own arithmetic, with no code from `src/`, so a flaw in the module under
 * test cannot make the answer it is checked against wrong in the same way.
 *
 * Deterministic: a scene is a function of its name and the seed.
 */
import { FiducialDetector, type DetectorOptions } from '../../src/ar/fiducial/detector.ts'
import { mulberry32 } from '../../src/shared/test-homes.ts'
import type { CameraIntrinsics, Dictionary, FiducialImage, Quad } from '../../src/ar/fiducial/types.ts'
import {
  INTRINSICS_640,
  LOW_LIGHT,
  castShadowAcrossHalf,
  glarePatch,
  mat3Apply,
  noiseOnlyFrame,
  renderTag,
  rollingShutterSkew,
  tagPose,
  textureFrame,
  type RigidPose,
} from './fiducial-render.ts'

export type ParityCondition = 'clean' | 'noise-blur' | 'cast-shadow' | 'low-light' | 'glare' | 'rolling-shutter' | 'negative'

export interface ParityScene {
  name: string
  condition: ParityCondition
  /** The family drawn (`Dictionary.name`), or null for a frame with no tag. */
  family: string | null
  /** The id drawn, or null for a frame with no tag. */
  tagId: number | null
  sizeM: number
  pose: RigidPose | null
  intrinsics: CameraIntrinsics
  image: FiducialImage
  /** Where the four corners truly are, printed top-left, top-right, bottom-right, bottom-left, in image pixels. Null for a frame with no tag. */
  truthCorners: Quad | null
}

/** What a detector says it found in one frame. */
export interface ParityDetection {
  id: number
  corners: Quad
}

/** Any detector, in-house or an oracle: a frame in, the tags found out. */
export type ParityDetector = (image: FiducialImage) => ParityDetection[]

export interface ParityConditionReport {
  scenes: number
  read: number
  /** Median over the scenes read of the worst corner's distance from the truth, pixels. Null when none was read. */
  medianWorstCornerPx: number | null
}

export interface ParityReport {
  scenes: number
  tagScenes: number
  negativeScenes: number
  /** Tag scenes in which the right id was found, over tag scenes. */
  recall: number
  /** Detections with an id that was not the one drawn, in tag scenes. */
  wrongIds: number
  /** Detections in frames with no tag. */
  falsePositives: number
  /** Over every tag read: the worst corner's distance from the truth. Null when none was read. */
  worstCornerPx: { median: number; p95: number; max: number } | null
  byCondition: Record<string, ParityConditionReport>
}

/** The in-house detector as a `ParityDetector`: the self-run, and the shape an oracle's wrapper takes. */
export function inHouseParityDetector(dictionary: Dictionary, options: DetectorOptions = {}): ParityDetector {
  const detector = new FiducialDetector(dictionary, options)
  return (image) => detector.detect(image).map((d) => ({ id: d.id, corners: d.corners }))
}

/** The corners of a tag drawn at `pose` (tag to camera, OpenCV axes) under `k`, printed order. Written out here on purpose. */
function trueCorners(pose: RigidPose, k: CameraIntrinsics, sizeM: number): Quad {
  const h = sizeM / 2
  const at = (x: number, y: number) => {
    const p = mat3Apply(pose.rotation, { x, y, z: 0 })
    const X = p.x + pose.translation.x
    const Y = p.y + pose.translation.y
    const Z = p.z + pose.translation.z
    return { x: (k.fx * X) / Z + k.cx, y: (k.fy * Y) / Z + k.cy }
  }
  return [at(-h, h), at(h, h), at(h, -h), at(-h, -h)]
}

export interface ParitySuiteOptions {
  /** The family the tags are drawn in. */
  dictionary: Dictionary
  /** Printed edge of the black square, metres. Default 0.2. */
  sizeM?: number
  /** Ranges to render at, metres. Default 1.2, 2, 3. */
  ranges?: readonly number[]
  /** Tilts (yaw, degrees) to render at. Default 20 and 40. */
  yaws?: readonly number[]
  /** Negative frames. Default 6. */
  negatives?: number
  seed?: number
}

/** The skew the rolling-shutter scenes use, pixels of shift per row: 0.012 shears a 72 px tag by about 0.9 px from its top edge to its bottom. */
export const PARITY_SKEW_PX_PER_ROW = 0.012

/** The deterministic suite: every condition at every range and tilt, plus frames with no tag. */
export function parityScenes(options: ParitySuiteOptions): ParityScene[] {
  const { dictionary } = options
  const sizeM = options.sizeM ?? 0.2
  const ranges = options.ranges ?? [1.2, 2, 3]
  const yaws = options.yaws ?? [20, 40]
  const seed = options.seed ?? 1
  const k = INTRINSICS_640
  const rand = mulberry32(seed * 7919 + 3)
  const scenes: ParityScene[] = []
  let n = 0
  for (const condition of ['clean', 'noise-blur', 'cast-shadow', 'low-light', 'glare', 'rolling-shutter'] as const) {
    for (const range of ranges) {
      for (const yaw of yaws) {
        n++
        const id = Math.floor(rand() * dictionary.size)
        const pose = tagPose({ x: (rand() - 0.5) * 0.2, y: (rand() - 0.5) * 0.15, z: range }, rand() * 360, yaw * (rand() < 0.5 ? -1 : 1), (rand() - 0.5) * 20)
        const corners = trueCorners(pose, k, sizeM)
        const centre = { x: (corners[0].x + corners[2].x) / 2, y: (corners[0].y + corners[2].y) / 2 }
        const side = Math.hypot(corners[1].x - corners[0].x, corners[1].y - corners[0].y)
        const base = { dictionary, id, sizeM, pose, intrinsics: k, seed: seed * 1000 + n, supersample: 3 }
        let image: FiducialImage
        let truth = corners
        switch (condition) {
          case 'clean':
            image = renderTag(base)
            break
          case 'noise-blur':
            image = renderTag({ ...base, noiseSigma: 3, blurSigma: 0.8 })
            break
          case 'cast-shadow':
            // 2:1 across the middle of the tag with an edge a fifth of its width: a shadow with a hard side, at a ratio the 14a detector reads.
            image = renderTag({ ...base, noiseSigma: 2, blurSigma: 0.6, light: castShadowAcrossHalf(centre, 2, rand() * 2 * Math.PI, 0.2 * side) })
            break
          case 'low-light':
            image = renderTag({ ...base, blurSigma: 0.7, ...LOW_LIGHT })
            break
          case 'glare':
            // A patch a quarter of the tag wide, over a corner's neighbourhood but not its corner: it hides code cells, not the border.
            image = renderTag({ ...base, noiseSigma: 2, blurSigma: 0.6, light: glarePatch({ x: centre.x + 0.12 * side, y: centre.y - 0.1 * side }, 0.12 * side) })
            break
          case 'rolling-shutter': {
            image = rollingShutterSkew(renderTag({ ...base, noiseSigma: 2, blurSigma: 0.6 }), PARITY_SKEW_PX_PER_ROW)
            const ref = k.height / 2
            truth = corners.map((c) => ({ x: c.x + PARITY_SKEW_PX_PER_ROW * (c.y - ref), y: c.y })) as unknown as Quad
            break
          }
        }
        scenes.push({ name: `${condition}-r${range}-y${yaw}`, condition, family: dictionary.name, tagId: id, sizeM, pose, intrinsics: k, image, truthCorners: truth })
      }
    }
  }
  const negatives = options.negatives ?? 6
  const kinds = ['fractal', 'furniture', 'text', 'tiles', 'decoys', 'random-decoys'] as const
  for (let i = 0; i < negatives; i++) {
    const image = i % 3 === 2 ? noiseOnlyFrame(640, 480, 120, 4, seed * 31 + i) : textureFrame(kinds[i % kinds.length]!, 640, 480, seed * 13 + i, dictionary)
    scenes.push({ name: `negative-${i}`, condition: 'negative', family: null, tagId: null, sizeM, pose: null, intrinsics: k, image, truthCorners: null })
  }
  return scenes
}

function percentile(values: readonly number[], p: number): number {
  const a = Array.from(values).sort((x, y) => x - y)
  return a[Math.min(a.length - 1, Math.floor(p * a.length))]!
}

/** Run a detector over scenes and compare what it found with the truth. */
export function runParity(detector: ParityDetector, scenes: readonly ParityScene[]): ParityReport {
  const byCondition: Record<string, { scenes: number; read: number; worst: number[] }> = {}
  let tagScenes = 0
  let negativeScenes = 0
  let read = 0
  let wrongIds = 0
  let falsePositives = 0
  const worstAll: number[] = []
  for (const scene of scenes) {
    const found = detector(scene.image)
    const bucket = (byCondition[scene.condition] ??= { scenes: 0, read: 0, worst: [] })
    bucket.scenes++
    if (scene.tagId === null || !scene.truthCorners) {
      negativeScenes++
      falsePositives += found.length
      continue
    }
    tagScenes++
    wrongIds += found.filter((d) => d.id !== scene.tagId).length
    const hit = found.find((d) => d.id === scene.tagId)
    if (!hit) continue
    read++
    bucket.read++
    const worst = Math.max(...hit.corners.map((c, i) => Math.hypot(c.x - scene.truthCorners![i]!.x, c.y - scene.truthCorners![i]!.y)))
    bucket.worst.push(worst)
    worstAll.push(worst)
  }
  const median = (v: readonly number[]): number | null => (v.length === 0 ? null : percentile(v, 0.5))
  return {
    scenes: scenes.length,
    tagScenes,
    negativeScenes,
    recall: tagScenes === 0 ? 0 : read / tagScenes,
    wrongIds,
    falsePositives,
    worstCornerPx: worstAll.length === 0 ? null : { median: percentile(worstAll, 0.5), p95: percentile(worstAll, 0.95), max: Math.max(...worstAll) },
    byCondition: Object.fromEntries(Object.entries(byCondition).map(([name, b]) => [name, { scenes: b.scenes, read: b.read, medianWorstCornerPx: median(b.worst) }])),
  }
}
