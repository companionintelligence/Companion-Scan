/**
 * Wave 14, ticket 0004 (FN-041): the live resolver's point-cloud tier (src/spatial/resolver.ts, tier 3) and the panoptic
 * lift (`liftSegment`, src/shared/panoptic_lift.ts) both place a detection from a ray through the cloud. They are two
 * policies, not one with two copies, and this shows it on constructed clouds; the one thing they share, the 0.5-5.0 m
 * depth window, now has one home.
 *
 *  - A stray point close to the camera, right on the ray, in front of a real surface: the resolver's most collinear point
 *    is the stray; the lift's nearest supported cluster is the surface.
 *  - A sparse cloud of a few scattered points: the resolver still answers; the lift abstains.
 *
 * Run: node --experimental-strip-types --no-warnings --test tests/unit/node/wp-capture-core-resolver-lift.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as THREE from 'three'
import { resolveDetections } from '../../../src/spatial/resolver.ts'
import { MAX_DEPTH_M, MIN_DEPTH_M, liftSegment, type LiftSegmentInput } from '../../../src/shared/panoptic_lift.ts'
import type { ARProvider, Pose } from '../../../src/ar/provider.ts'
import type { RawDetection } from '../../../src/inference/prompt.ts'
import type { PointCloud } from '../../../src/scene/pointcloud.ts'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')

const POSE: Pose = { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 } }
const W = 640
const H = 480
const FOV_Y_DEG = 60
const FL = H / 2 / Math.tan((FOV_Y_DEG * Math.PI) / 360)

/** A provider whose hit tests find nothing, so the resolver falls to its point-cloud tier. */
function noHits(): ARProvider {
  return {
    start: () => Promise.resolve(),
    stop: () => {},
    captureFrame: () => Promise.reject(new Error('not used')),
    hitTest: () => null,
    featurePoints: () => [],
    getPose: () => POSE,
    isTracking: () => true,
    getCameraFovY: () => FOV_Y_DEG,
    getCameraAspect: () => W / H,
  }
}

function cloudOf(points: Array<[number, number, number]>): { cloud: PointCloud; flat: Float32Array } {
  const flat = new Float32Array(points.flat())
  return { cloud: { count: points.length, toFloat32Array: () => flat } as unknown as PointCloud, flat }
}

/** A box in the middle of the frame, a fifth of it each way: the detection both policies are asked about. */
const DETECTION: RawDetection = { label: 'chair', bbox: [0.4, 0.4, 0.6, 0.6], confidence: 0.9, description: 'a chair' }

function camera(): THREE.PerspectiveCamera {
  const cam = new THREE.PerspectiveCamera(FOV_Y_DEG, W / H, 0.01, 100)
  cam.updateMatrixWorld()
  return cam
}

async function resolverDepth(points: Array<[number, number, number]>): Promise<number> {
  const { cloud } = cloudOf(points)
  const [det] = await resolveDetections([DETECTION], 1000, { provider: noHits(), cameraPose: POSE, captureCamera: camera(), pointCloud: cloud })
  return -det!.worldPos.z
}

function lift(points: Array<[number, number, number]>) {
  const { flat } = cloudOf(points)
  const input: LiftSegmentInput = {
    // Row-major camera-to-world: the identity, a camera at the origin looking down -Z, as the resolver's camera is.
    camera: { cameraToWorld: [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]], flX: FL, flY: FL, cx: W / 2, cy: H / 2 },
    centroidPx: [W / 2, H / 2],
    areaPx: (0.2 * W) * (0.2 * H),
    segScore: 0.9,
  }
  return liftSegment(input, flat, points.length)
}

/** `n` points on a patch of surface at `depth` straight ahead, a few centimetres either side of the ray. */
function surface(depth: number, n: number): Array<[number, number, number]> {
  return Array.from({ length: n }, (_, i) => {
    const a = (i / n) * Math.PI * 2
    const r = 0.02 + (i % 5) * 0.01
    return [Math.cos(a) * r, Math.sin(a) * r, -(depth + (i % 3) * 0.01)] as [number, number, number]
  })
}

test('a stray point near the camera in front of a real surface: the resolver takes the stray, the lift takes the surface', async () => {
  const points: Array<[number, number, number]> = [[0.0005, 0, -0.8], ...surface(3, 40)]
  const byResolver = await resolverDepth(points)
  const byLift = lift(points)
  assert.ok(Math.abs(byResolver - 0.8) < 1e-6, `the most collinear point wins: ${byResolver}`)
  assert.ok(byLift.worldPos, `the lift placed it: ${JSON.stringify(byLift.reason)}`)
  assert.ok(Math.abs(-byLift.worldPos!.z - 3.01) < 0.05, `the nearest supported surface: ${-byLift.worldPos!.z}`)
  assert.ok(Math.abs(byResolver - -byLift.worldPos!.z) > 2, 'two policies, two answers')
})

test('a sparse cloud: the resolver answers, the lift abstains and says why', async () => {
  const points: Array<[number, number, number]> = [[0.05, 0.02, -1.5], [-0.04, 0.01, -2.7], [0.02, -0.03, -4.1]]
  const byResolver = await resolverDepth(points)
  const byLift = lift(points)
  assert.ok(byResolver > MIN_DEPTH_M && byResolver < MAX_DEPTH_M, `a confident position from three points: ${byResolver}`)
  assert.equal(byLift.worldPos, null)
  assert.equal(byLift.confidence, null)
  assert.equal(byLift.reason, 'unsupported')
})

test('the depth window is one pair of numbers, the lift\'s, and the resolver reads it from there', async () => {
  assert.equal(MIN_DEPTH_M, 0.5)
  assert.equal(MAX_DEPTH_M, 5)
  const src = readFileSync(resolve(ROOT, 'src/spatial/resolver.ts'), 'utf8')
  assert.match(src, /import \{ MAX_DEPTH_M, MIN_DEPTH_M \} from '\.\.\/shared\/panoptic_lift\.ts'/)
  assert.match(src, /const MAX_HIT_DISTANCE_M = MAX_DEPTH_M\b/)
  assert.match(src, /minDepth = MIN_DEPTH_M,\s*\n\s*maxDepth = MAX_DEPTH_M/)
  // Inside the window the resolver's tier answers; just outside it, it does not, and the 2 m fallback does.
  assert.ok(Math.abs((await resolverDepth([[0, 0, -4.9]])) - 4.9) < 1e-6)
  assert.ok(Math.abs((await resolverDepth([[0, 0, -5.2]])) - 2) < 1e-6, 'past the window: the camera-ray fallback at 2 m')
  assert.ok(Math.abs((await resolverDepth([[0, 0, -0.4]])) - 2) < 1e-6, 'nearer than the window: the fallback too')
})
