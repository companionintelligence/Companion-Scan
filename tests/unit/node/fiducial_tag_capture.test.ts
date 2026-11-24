/**
 * Marker reading end to end (`src/ar/fiducial/tag-capture.ts`): a camera feed in, the worker's detections and a `TagSession` out, and the whole
 * chain from drawn pixels to a pose in the Place frame.
 *
 * The chain test is the WP-14b acceptance test of the infrastructure on synthetic frames: a tag at a known pose, drawn noise-free by the harness
 * at 1, 2 and 3 m and seen 40 degrees or more off its normal, goes through the feed's `CameraFrame`, the worker (a faithful fake: structured
 * clones with transfer, the real handler), the real detector, the session, and comes out within 1 cm and half a degree of where it was drawn, with a
 * frame that puts a probe 5 m away within centimetres of the true one. What it cannot say is what a phone's pixels do: a systematic plumbing error
 * (pixels one frame older than their pose, a cropped frame, flipped axes) looks fine on synthetic frames and does not average out, which is what
 * device experiment DX8 is for; the lag is tested here as a mechanism (the pose paired is the one asked for), not as a fact about any engine.
 *
 * Run: node --experimental-strip-types --no-warnings --test tests/unit/node/fiducial_tag_capture.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CSCAN6_V1 } from '../../../src/ar/fiducial/dictionary.ts'
import { unsupportedCameraFeed, type CameraFrame, type CameraFrameOptions, type CameraFrameSubscription } from '../../../src/ar/camera-frame-feed.ts'
import { createTagWorkerHandler } from '../../../src/ar/fiducial/tag-worker-core.ts'
import type { WorkerLike } from '../../../src/ar/fiducial/tag-worker-client.ts'
import { intrinsicsOfFrame, startTagCapture, DEFAULT_TAG_MAX_HZ, type TagCaptureUpdate } from '../../../src/ar/fiducial/tag-capture.ts'
import { TagSession, detectorOptionsForSession, type TagSessionConfig } from '../../../src/ar/fiducial/tag-session.ts'
import { tagFrameTransform } from '../../../src/ar/fiducial/tag-frame.ts'
import { intrinsicsFromProjection, intrinsicsProblem, quatToMatrix, rotationAngleBetweenDeg } from '../../../src/ar/fiducial/tag-pose.ts'
import { transformPoint } from '../../../src/world/geo.ts'
import type { CameraIntrinsics } from '../../../src/ar/fiducial/types.ts'
import { mat3Apply, mat3Mul, mat3Transpose, matrixFromQuat, renderTag, type SessionPoseLike } from '../../support/fiducial-render.ts'
import { fixedTag, walk } from '../../support/fiducial-scene.ts'

const FAMILY = 'cscan-6x6-v1'
const K960: CameraIntrinsics = { fx: 800, fy: 800, cx: 480, cy: 360, width: 960, height: 720 }
const FLIP_YZ = [1, 0, 0, 0, -1, 0, 0, 0, -1]

/** A projection matrix for the camera, built from first principles (column-major, the layout the engine publishes). */
function projectionFor(k: CameraIntrinsics): number[] {
  const p = new Array<number>(16).fill(0)
  p[0] = (2 * k.fx) / k.width
  p[5] = (2 * k.fy) / k.height
  p[8] = 1 - (2 * k.cx) / k.width
  p[9] = (2 * k.cy) / k.height - 1
  p[10] = -1.002
  p[11] = -1
  p[14] = -0.2002
  return p
}

/** The tag's pose in the OpenCV camera frame, from a tag fixed in the session and a three.js camera: written out here, not through the module's conversion. */
function cvPoseOf(tag: SessionPoseLike, cam: SessionPoseLike) {
  const rt = matrixFromQuat(tag.rotation)
  const rcT = mat3Transpose(matrixFromQuat(cam.rotation))
  const d = { x: tag.position.x - cam.position.x, y: tag.position.y - cam.position.y, z: tag.position.z - cam.position.z }
  return { rotation: mat3Mul(FLIP_YZ, mat3Mul(rcT, rt)), translation: mat3Apply(mat3Mul(FLIP_YZ, rcT), d) }
}

/** A worker whose messages really are structured clones with a transfer list, answered by the real handler. */
function fakeWorker(): WorkerLike {
  const w: WorkerLike & { handle: (m: never) => void } = {
    onmessage: null,
    onerror: null,
    handle: createTagWorkerHandler((m) => queueMicrotask(() => w.onmessage?.({ data: structuredClone(m) }))) as (m: never) => void,
    postMessage(message: unknown, transfer?: Transferable[]) {
      const clone = structuredClone(message, transfer ? { transfer } : undefined)
      queueMicrotask(() => w.handle(clone as never))
    },
    terminate() {},
  }
  return w
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

function fakeFeed(mode: 'ok' | 'webxr' | 'none' = 'ok') {
  let deliver: ((f: CameraFrame) => void) | null = null
  const state = { subscribed: [] as CameraFrameOptions[], unsubscribed: 0 }
  const provider = mode === 'none'
    ? {}
    : {
        onCameraFrame(cb: (f: CameraFrame) => void, options: CameraFrameOptions): CameraFrameSubscription {
          state.subscribed.push(options)
          if (mode === 'webxr') return unsupportedCameraFeed('webxr-no-camera-access')
          deliver = cb
          return { status: 'active', reason: null, unsubscribe: () => void state.unsubscribed++ }
        },
      }
  return { provider, state, emit: (f: CameraFrame) => deliver?.(f) }
}

function config(over: Partial<TagSessionConfig> = {}): TagSessionConfig {
  return { family: FAMILY, printedSizeMm: 200, sizeSource: 'qr', expected: null, scaleKind: 'metric', floor: () => ({ floorY: null, mountHeightM: 1.2 }), ...over }
}

interface Rendered {
  frames: CameraFrame[]
  tag: SessionPoseLike
}

/** Frames of a wall tag drawn noise-free, from cameras walking an arc centred 48 degrees off its normal (it is 0.3 m of travel or more at every range the tests use). */
function render(range: number, over: { printScale?: number; frames?: number; id?: number; epoch?: (i: number) => number; arcDeg?: number; centreDeg?: number } = {}): Rendered {
  const tag = fixedTag(0, 0, { x: 0.3, y: 1.3, z: -3 })
  const n = over.frames ?? 16
  const w = walk({ tag, range, frames: n, arcDeg: over.arcDeg ?? 18, centreDeg: over.centreDeg ?? 48, intrinsics: K960, seed: 1, dtMs: 250 })
  const frames = w.cameras.map((cam, i): CameraFrame => {
    const image = renderTag({ dictionary: CSCAN6_V1, id: over.id ?? 6, sizeM: 0.2 * (over.printScale ?? 1), pose: cvPoseOf(tag, cam), intrinsics: K960, supersample: 3, channels: 4 })
    return {
      pixels: image.data as Uint8Array,
      width: 960,
      height: 720,
      rowBytes: 960 * 4,
      channels: 4,
      timestampMs: w.timesMs[i]!,
      pose: cam,
      poseTimestampMs: w.timesMs[i]!,
      lagFrames: 0,
      projection: projectionFor(K960),
      frameIndex: i,
      epoch: over.epoch?.(i) ?? 0,
      trackingStatus: 'NORMAL',
      angularSpeedDegPerS: w.speeds[i]!,
      display: { canvasWidth: 960, canvasHeight: 720, fit: 'contain' },
    }
  })
  return { frames, tag }
}

/** Run frames through a capture one at a time (the worker takes one at a time), returning every update. */
async function drive(session: TagSession | null, frames: readonly CameraFrame[], over: Partial<Parameters<typeof startTagCapture>[0]> = {}) {
  const feed = fakeFeed()
  const updates: TagCaptureUpdate[] = []
  const capture = startTagCapture({
    provider: feed.provider,
    session,
    family: FAMILY,
    detector: session ? detectorOptionsForSession({ expected: null }) : {},
    worker: { createWorker: fakeWorker },
    onUpdate: (u) => updates.push(u),
    ...over,
  })
  for (const f of frames) {
    feed.emit(f)
    await settle()
  }
  return { capture, updates, feed }
}

// ===============================================================================================
// What it needs of a provider
// ===============================================================================================

test('a provider with no frame feed, or whose feed is unsupported, makes the capture unavailable with the reason, and starts nothing', () => {
  for (const [mode, reason] of [['none', 'no-frame-feed'], ['webxr', 'webxr-no-camera-access']] as const) {
    const feed = fakeFeed(mode)
    const told: string[] = []
    const frames: unknown[] = []
    const capture = startTagCapture({ provider: feed.provider, session: null, family: FAMILY, onUnavailable: (r, f) => (told.push(r), frames.push(f)) })
    assert.equal(capture.status, 'unavailable', mode)
    assert.equal(capture.unavailable, reason)
    assert.equal(capture.client, null, 'no worker was started')
    assert.deepEqual(told, [reason], 'told before startTagCapture returned')
    assert.deepEqual(frames, [undefined], 'there was no frame to show: a feed that never delivers has none')
    assert.doesNotThrow(() => capture.stop())
    assert.equal(capture.status, 'unavailable', 'stopping an unavailable capture does not make it something else')
  }
})

test('it subscribes at the default rate with the lag and the pose count asked for, and a view the engine cropped ends it', async () => {
  assert.equal(DEFAULT_TAG_MAX_HZ, 8)
  const feed = fakeFeed()
  const told: string[] = []
  const toldFrames: Array<{ fit: string | undefined; width: number } | undefined> = []
  const capture = startTagCapture({ provider: feed.provider, session: null, family: FAMILY, lagFrames: 2, recentPoses: 3, worker: { createWorker: fakeWorker }, onUnavailable: (r, f) => (told.push(r), toldFrames.push(f && { fit: f.display?.fit, width: f.width })) })
  assert.deepEqual(feed.state.subscribed, [{ maxHz: 8, lagFrames: 2, recentPoses: 3 }])
  const plain = fakeFeed()
  startTagCapture({ provider: plain.provider, session: null, family: FAMILY, maxHz: 5, worker: { createWorker: fakeWorker } })
  assert.deepEqual(plain.state.subscribed, [{ maxHz: 5 }], 'options left out are not sent')
  assert.equal(capture.status, 'running')
  assert.ok(capture.client)
  // A frame the engine made under the cover fit: the projection is the cropped canvas's, so nothing read from it can be trusted.
  const { frames } = render(2, { frames: 2 })
  feed.emit({ ...frames[0]!, display: { canvasWidth: 960, canvasHeight: 720, fit: 'cover' } })
  assert.equal(capture.status, 'unavailable')
  assert.equal(capture.unavailable, 'cover-fit')
  assert.deepEqual(told, ['cover-fit'])
  assert.deepEqual(toldFrames, [{ fit: 'cover', width: frames[0]!.width }], 'the frame that showed the crop is handed over, so that whoever reports it can say which view it was')
  assert.equal(feed.state.unsubscribed, 1)
  feed.emit(frames[1]!)
  await settle()
  assert.equal(capture.client!.stats.submitted, 0, 'nothing after it is read')
})

test('stopping unsubscribes once, closes the worker, and ignores what is still in flight', async () => {
  const { frames } = render(2, { frames: 3 })
  const feed = fakeFeed()
  const updates: TagCaptureUpdate[] = []
  const capture = startTagCapture({ provider: feed.provider, session: null, family: FAMILY, worker: { createWorker: fakeWorker }, onUpdate: (u) => updates.push(u) })
  feed.emit(frames[0]!)
  capture.stop()
  capture.stop()
  assert.equal(capture.status, 'stopped')
  assert.equal(feed.state.unsubscribed, 1)
  await settle()
  await settle()
  assert.equal(updates.length, 0, 'the answer to a frame sent before the stop is not delivered')
  feed.emit(frames[1]!)
  await settle()
  assert.equal(updates.length, 0)
})

// ===============================================================================================
// What it hands the session
// ===============================================================================================

test('the intrinsics of a frame are its projection with the size of its pixel array; one that is not a projection gives intrinsics the session refuses', () => {
  const { frames } = render(2, { frames: 1 })
  const k = intrinsicsOfFrame(frames[0]!)
  const direct = intrinsicsFromProjection(projectionFor(K960), { width: 960, height: 720 })
  assert.deepEqual(k, direct)
  assert.ok(Math.abs(k.fx - 800) < 1e-9 && Math.abs(k.cx - 480) < 1e-9 && Math.abs(k.cy - 360) < 1e-9)
  assert.equal(intrinsicsProblem(k), null)
  const broken = intrinsicsOfFrame({ ...frames[0]!, projection: new Array(16).fill(0) })
  assert.equal(intrinsicsProblem(broken), 'not-finite')
  // A projection for a frame of another shape than the pixels: the aspect gives it away.
  const mismatched = intrinsicsOfFrame({ ...frames[0]!, width: 720, height: 960 })
  assert.equal(intrinsicsProblem(mismatched), 'aspect-mismatch')
})

test('each frame reaches the session with the pose, speed, epoch and time of the frame, and the capture says how long the session took', async () => {
  const { frames } = render(2, { frames: 3, epoch: (i) => 5 + i })
  const session = new TagSession(config())
  const { updates } = await drive(session, frames)
  assert.equal(updates.length, 3)
  updates.forEach((u, i) => {
    assert.equal(u.input!.timestampMs, frames[i]!.timestampMs)
    assert.deepEqual(u.input!.cameraPose, frames[i]!.pose)
    assert.equal(u.input!.angularSpeedDegPerS, frames[i]!.angularSpeedDegPerS)
    assert.equal(u.input!.epoch, 5 + i)
    assert.equal(u.input!.detections, u.result.detections)
    assert.deepEqual(u.intrinsics, intrinsicsFromProjection(frames[i]!.projection, { width: 960, height: 720 }))
    assert.equal(u.state!.counts.framesOffered, i + 1)
    assert.ok(u.sessionMs !== null && u.sessionMs >= 0)
    assert.equal(u.result.detections[0]!.id, 6)
    assert.equal(u.result.mode, 'worker')
  })
  assert.equal(updates[2]!.state!.counts.frameShifts, 2, 'a new epoch every frame is a shift every frame')
})

test('a capture with no session still reads and reports: the update has the detections and no state', async () => {
  const { frames } = render(2, { frames: 2 })
  const { updates } = await drive(null, frames)
  assert.equal(updates.length, 2)
  for (const u of updates) {
    assert.equal(u.state, null)
    assert.equal(u.input, null)
    assert.equal(u.sessionMs, null)
    assert.equal(u.result.detections.length, 1)
  }
})

test('a projection that disagrees with the size of the pixels is told to the person, not used', async () => {
  const { frames } = render(2, { frames: 4 })
  const wrong = frames.map((f) => ({ ...f, projection: projectionFor({ ...K960, width: 720, height: 960, fy: 800, fx: 800 }) }))
  const session = new TagSession(config())
  const { updates } = await drive(session, wrong)
  assert.equal(updates[updates.length - 1]!.state!.counts.intrinsics, 4)
  assert.deepEqual(updates[updates.length - 1]!.state!.hint, { code: 'bad-intrinsics' })
  assert.equal(updates[updates.length - 1]!.state!.counts.accepted, 0)
})

// ===============================================================================================
// The chain
// ===============================================================================================

function rotationError(fused: { rotation: { x: number; y: number; z: number; w: number } }, tag: SessionPoseLike): number {
  return rotationAngleBetweenDeg(quatToMatrix(fused.rotation), matrixFromQuat(tag.rotation))
}

test('drawn frames at 1, 2 and 3 m, seen 40 degrees or more off the normal, come out within 1 cm and half a degree, with a frame that puts a probe 5 m away within 2 cm', async (t) => {
  const lines: string[] = []
  for (const range of [1, 2, 3]) {
    // 0.3 m of camera travel is what the print-scale check needs: an arc of 26 degrees at 1 m, 18 at 2 m and 3 m.
    const { frames, tag } = render(range, { arcDeg: range === 1 ? 26 : 18 })
    const session = new TagSession(config())
    const { updates } = await drive(session, frames)
    const last = updates[updates.length - 1]!
    assert.equal(last.state!.phase, 'done', `${range} m: ${JSON.stringify(last.state!.hint)} after ${updates.length} frames`)
    const r = last.state!.result!
    const fused = r.fused.pose!
    const posErr = Math.hypot(fused.position.x - tag.position.x, fused.position.y - tag.position.y, fused.position.z - tag.position.z)
    const rotErr = rotationError(fused, tag)
    lines.push(`${range} m: ${(posErr * 100).toFixed(2)} cm, ${rotErr.toFixed(2)} deg, side ${r.evidence.sidePx.toFixed(0)} px, view ${r.evidence.viewAngleDeg.toFixed(0)} deg, spread ${(r.evidence.poseSpreadM * 100).toFixed(2)} cm`)
    assert.ok(posErr < 0.01, `${range} m: position ${posErr} m`)
    assert.ok(rotErr < 0.5, `${range} m: rotation ${rotErr} deg`)
    assert.ok(r.evidence.viewAngleDeg >= 40, `the tag was seen ${r.evidence.viewAngleDeg} degrees off its normal`)
    assert.ok(Math.abs(r.evidence.rangeM - range) < 0.02 * range + 0.01, `range ${r.evidence.rangeM}`)
    assert.equal(r.evidence.tagId, 6)
    assert.equal(r.verdict.status, 'provisional')
    assert.deepEqual(r.verdict.reasons, ['first-calibration'])
    assert.equal(r.verdict.quality, 'good')
    // The frame, against the one the TRUE tag pose defines: a probe on the floor 5 m from the tag, 2 m off to one side.
    const truth = tagFrameTransform({ status: 'ok', pose: tag }, { floorY: tag.position.y - 1.2, mountHeightM: null, sessionUnitsPerMetre: 1 })
    assert.equal(truth.status, 'ok')
    if (truth.status !== 'ok') return
    const probe = { x: tag.position.x + 2, y: tag.position.y - 1.2, z: tag.position.z + 4.6 }
    const there = transformPoint(r.frame.sessionToProject, probe)
    const want = transformPoint(truth.sessionToProject, probe)
    const gap = Math.hypot(there.x - want.x, there.y - want.y, there.z - want.z)
    assert.ok(gap < 0.02, `${range} m: the probe is ${(gap * 100).toFixed(2)} cm from where the true frame puts it`)
  }
  t.diagnostic(lines.join(' | '))
})

test('through the whole chain a print 5 % small is flagged on a metric runtime, and the corners fit as well as a correct one\'s', async () => {
  const good = await drive(new TagSession(config()), render(2).frames)
  const small = await drive(new TagSession(config()), render(2, { printScale: 0.95 }).frames)
  const g = good.updates[good.updates.length - 1]!.state!.result!
  const s = small.updates[small.updates.length - 1]!.state!.result!
  assert.deepEqual(g.verdict.reasons, ['first-calibration'])
  assert.deepEqual(s.verdict.reasons, ['first-calibration', 'scale-mismatch'])
  assert.ok(s.evidence.scaleOffFraction! < -0.035 && s.evidence.scaleOffFraction! > -0.065, `${s.evidence.scaleOffFraction}`)
  assert.ok(Math.abs(s.evidence.reprojectionRmsPx - g.evidence.reprojectionRmsPx) < 0.05, 'nothing in the detection shows a uniform scale error')
})

test('the same frames read as a registered marker are verified, and read as another Place\'s marker are not', async () => {
  // Frames are single-use: sending one moves its pixels into the worker, so each run is drawn fresh.
  const mine = await drive(new TagSession(config({ expected: { family: FAMILY, tagId: 6 } })), render(2).frames, { detector: detectorOptionsForSession({ expected: { family: FAMILY, tagId: 6 } }) })
  const r = mine.updates[mine.updates.length - 1]!.state!.result!
  assert.deepEqual(r.verdict, { status: 'verified', reasons: [], quality: 'good' })
  // Another marker's registered: the detector is told to read only that one, and so reads nothing.
  const other = await drive(new TagSession(config({ expected: { family: FAMILY, tagId: 9 } })), render(2).frames, { detector: detectorOptionsForSession({ expected: { family: FAMILY, tagId: 9 } }) })
  const last = other.updates[other.updates.length - 1]!.state!
  assert.equal(last.phase, 'searching')
  assert.equal(last.result, null)
  assert.equal(other.updates[0]!.result.stats.rejected.ids, 1, 'tag 6 was seen and turned away by the id restriction')
})
