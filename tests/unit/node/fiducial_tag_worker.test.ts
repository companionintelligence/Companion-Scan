/**
 * Reading a tag off the page's thread: the runner that searches around where the tag was (`tag-runner.ts`), the worker's message handler
 * (`tag-worker-core.ts`) and the client that drives it and falls back to the main thread (`tag-worker-client.ts`).
 *
 * The Worker is a fake, but a faithful one: `postMessage` goes through `structuredClone` with the transfer list, so a buffer that was
 * transferred really is detached in the sender, a message that cannot be cloned really throws, and the worker's side runs the real handler
 * on the clone. The detector is the real one, on frames drawn by the harness. Time is injected where a test needs to move it.
 *
 * Run: node --experimental-strip-types --no-warnings --test tests/unit/node/fiducial_tag_worker.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CSCAN5_V1, CSCAN6_V1 } from '../../../src/ar/fiducial/dictionary.ts'
import { FiducialDetector } from '../../../src/ar/fiducial/detector.ts'
import {
  ROI_MAX_AREA_FRACTION,
  ROI_MAX_MISSES,
  ROI_MIN_PAD_PX,
  ROI_PAD_FRACTION,
  TagRunner,
  cropImage,
  roiAround,
  type TagDetector,
} from '../../../src/ar/fiducial/tag-runner.ts'
import { createTagWorkerHandler } from '../../../src/ar/fiducial/tag-worker-core.ts'
import { MAIN_THREAD_MIN_INTERVAL_MS, TagWorkerClient, WORKER_STALL_MS, type TagFrameResult, type TagFallbackReason, type WorkerLike } from '../../../src/ar/fiducial/tag-worker-client.ts'
import type { TagWorkerRequest, TagWorkerResponse } from '../../../src/ar/fiducial/tag-worker-protocol.ts'
import type { CameraFrame } from '../../../src/ar/camera-frame-feed.ts'
import type { FiducialDetection, FiducialImage, Quad } from '../../../src/ar/fiducial/types.ts'
import { INTRINSICS_640, renderFrame, renderTag, tagPose, type RigidPose } from '../../support/fiducial-render.ts'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const K = INTRINSICS_640
const DICT = CSCAN6_V1
const SIZE_M = 0.2

function frameWithTag(id: number, pose: RigidPose, seed = 1, dictionary = DICT): FiducialImage {
  return renderTag({ dictionary, id, sizeM: SIZE_M, pose, intrinsics: K, noiseSigma: 2, blurSigma: 0.6, seed, supersample: 3, channels: 4 })
}

function blankFrame(seed = 1): FiducialImage {
  return renderFrame({ width: 640, height: 480, intrinsics: K, items: [], background: 130, noiseSigma: 2, seed, channels: 4 })
}

/** Where the corners of a tag at `pose` truly are, printed order. Written out here. */
function trueCorners(pose: RigidPose): Quad {
  const h = SIZE_M / 2
  return [[-h, h], [h, h], [h, -h], [-h, -h]].map(([x, y]) => {
    const R = pose.rotation
    const px = R[0]! * x! + R[1]! * y! + pose.translation.x
    const py = R[3]! * x! + R[4]! * y! + pose.translation.y
    const pz = R[6]! * x! + R[7]! * y! + pose.translation.z
    return { x: (K.fx * px) / pz + K.cx, y: (K.fy * py) / pz + K.cy }
  }) as unknown as Quad
}

const worst = (a: Quad, b: Quad): number => Math.max(...a.map((c, i) => Math.hypot(c.x - b[i]!.x, c.y - b[i]!.y)))

/** A detector that counts what it is given, in front of the real one. */
function counting(dictionary = DICT) {
  const real = new FiducialDetector(dictionary)
  const seen: Array<{ width: number; height: number }> = []
  const detector: TagDetector = {
    detect(image) {
      seen.push({ width: image.width, height: image.height })
      return real.detect(image)
    },
    get stats() {
      return real.stats
    },
  }
  return { detector, seen }
}

// ===============================================================================================
// The runner
// ===============================================================================================

test('a crop is a view of the same bytes with the same row stride, and a pixel in it is the pixel of the frame it was cut from', () => {
  const image = frameWithTag(3, tagPose({ x: 0, y: 0, z: 2 }, 0, 20, 0))
  const rect = { x: 100, y: 60, width: 200, height: 150 }
  const crop = cropImage(image, rect)
  assert.equal(crop.data.buffer, image.data.buffer, 'no copy')
  assert.equal(crop.rowBytes, image.width * 4)
  assert.equal(crop.width, 200)
  assert.equal(crop.height, 150)
  for (const [x, y] of [[0, 0], [199, 0], [0, 149], [57, 33]] as const) {
    for (let c = 0; c < 4; c++) assert.equal(crop.data[y * crop.rowBytes! + x * 4 + c], image.data[(rect.y + y) * image.width * 4 + (rect.x + x) * 4 + c], `pixel ${x},${y} channel ${c}`)
  }
  // A padded frame keeps its padding stride; a luma frame crops the same way.
  const padded: FiducialImage = { data: new Uint8Array(40 * 10), width: 30, height: 10, channels: 1, rowBytes: 40 }
  padded.data[3 * 40 + 7] = 200
  const c2 = cropImage(padded, { x: 5, y: 2, width: 10, height: 6 })
  assert.equal(c2.rowBytes, 40)
  assert.equal(c2.data[1 * 40 + 2], 200)
})

test('the search window: the box round every corner, grown by a margin of the biggest side (never under 48 px), clamped to the frame, and refused when it is too small or too big to be worth having', () => {
  assert.equal(ROI_PAD_FRACTION, 1)
  assert.equal(ROI_MIN_PAD_PX, 48)
  const det = (cx: number, cy: number, side: number): FiducialDetection => ({
    id: 1, family: 'x', hamming: 0, quality: 1, sidePx: side, contrast: 100, edgeRmsPx: 0.1, edgeInlierFraction: 1, refined: true, level: 0,
    corners: [{ x: cx - side / 2, y: cy - side / 2 }, { x: cx + side / 2, y: cy - side / 2 }, { x: cx + side / 2, y: cy + side / 2 }, { x: cx - side / 2, y: cy + side / 2 }],
  })
  const frame = { width: 640, height: 480 }
  // Side 80: margin 80, so 80 + 160 = 240 wide.
  assert.deepEqual(roiAround([det(320, 240, 80)], frame), { x: 200, y: 120, width: 240, height: 240 })
  // Side 20: the margin is the floor, 48, so 20 + 96 = 116.
  assert.deepEqual(roiAround([det(320, 240, 20)], frame), { x: 262, y: 182, width: 116, height: 116 })
  // Clamped at the frame edge.
  assert.deepEqual(roiAround([det(40, 40, 60)], frame), { x: 0, y: 0, width: 130, height: 130 })
  // Two tags: one box round both.
  const both = roiAround([det(150, 200, 60), det(400, 260, 60)], frame)!
  assert.equal(both.x, 60)
  assert.equal(both.y, 110)
  assert.equal(both.width, 400 + 30 + 60 - 60)
  // Too big: a tag that fills the frame gets no window; the limit is a share of the frame's area.
  assert.equal(ROI_MAX_AREA_FRACTION, 0.6)
  assert.equal(roiAround([det(320, 240, 300)], frame), null)
  // Too small: a tag in the corner of a small frame leaves no 64 px window.
  assert.equal(roiAround([det(10, 10, 6)], { width: 100, height: 100 }), null)
  assert.equal(roiAround([], frame), null)
})

test('after a hit the next frame is searched in a window, which holds fewer pixels, finds the same tag, and reports its corners in full-frame pixels', () => {
  const { detector, seen } = counting()
  const runner = new TagRunner(detector)
  const first = tagPose({ x: 0.1, y: -0.05, z: 1.6 }, 10, 20, 5)
  const r1 = runner.run(frameWithTag(5, first, 1))
  assert.equal(r1.roi, null, 'the first frame is searched whole')
  assert.equal(r1.passes, 1)
  assert.equal(r1.detections.length, 1)
  assert.ok(runner.roi, 'a window was made round the tag')
  // The tag moves 30 px between frames.
  const second = tagPose({ x: 0.1 + 0.06, y: -0.05, z: 1.6 }, 10, 20, 5)
  const img2 = frameWithTag(5, second, 2)
  const r2 = runner.run(img2)
  assert.ok(r2.roi, 'the second frame is searched in the window')
  assert.equal(r2.passes, 1)
  assert.equal(r2.roiMissed, false)
  assert.equal(r2.detections.length, 1)
  assert.equal(r2.detections[0]!.id, 5)
  const full = seen[0]!
  const windowed = seen[1]!
  assert.ok(windowed.width * windowed.height < 0.4 * full.width * full.height, `${windowed.width}x${windowed.height} against ${full.width}x${full.height}`)
  assert.ok(windowed.width * windowed.height >= 116 * 116)
  // Corners in the frame's own coordinates, as good as a whole-frame search of the same frame gives.
  const direct = new FiducialDetector(DICT).detect(img2)[0]!
  assert.ok(worst(r2.detections[0]!.corners, trueCorners(second)) < 0.5, `${worst(r2.detections[0]!.corners, trueCorners(second))} px from the truth`)
  assert.ok(worst(r2.detections[0]!.corners, direct.corners) < 0.3, `${worst(r2.detections[0]!.corners, direct.corners)} px from the whole-frame search`)
  assert.equal(r2.detections[0]!.refined, true)
  assert.equal(r2.width, 640)
  assert.equal(r2.height, 480)
  assert.ok(r2.detectMs >= 0)
  assert.equal(r2.stats.detections, 1, 'the counters are the pass that found it')
})

test('a window that finds nothing is followed by a whole-frame search in the same call; after three misses the window is dropped', () => {
  const { detector, seen } = counting()
  const runner = new TagRunner(detector)
  runner.run(frameWithTag(5, tagPose({ x: -0.3, y: 0, z: 1.8 }, 0, 20, 0), 1))
  assert.ok(runner.roi)
  // The tag jumps across the frame: outside the window, so the window misses and the whole frame finds it.
  const jumped = tagPose({ x: 0.45, y: 0.1, z: 1.8 }, 0, 20, 0)
  const found = runner.run(frameWithTag(5, jumped, 2))
  assert.equal(found.roiMissed, true)
  assert.equal(found.passes, 2)
  assert.equal(found.roi, null, 'the pass that found it was the whole frame')
  assert.equal(found.detections.length, 1)
  assert.ok(worst(found.detections[0]!.corners, trueCorners(jumped)) < 0.5)
  assert.equal(seen.length, 3, 'the first whole frame, then the window that missed, then the whole frame that found it')
  // The window is now round the new place, and holds.
  const near = runner.run(frameWithTag(5, tagPose({ x: 0.47, y: 0.1, z: 1.8 }, 0, 20, 0), 3))
  assert.ok(near.roi)
  assert.equal(near.passes, 1)
  // The tag goes: each blank frame costs a window search and a whole-frame search, until the window is dropped after ROI_MAX_MISSES + 1 misses.
  assert.equal(ROI_MAX_MISSES, 2)
  const passes: number[] = []
  const windows: Array<boolean> = []
  for (let i = 0; i < 5; i++) {
    const r = runner.run(blankFrame(10 + i))
    passes.push(r.passes)
    windows.push(runner.roi !== null)
    assert.equal(r.detections.length, 0)
  }
  assert.deepEqual(passes, [2, 2, 2, 1, 1], 'three windows searched and missed, then whole frames only')
  assert.deepEqual(windows, [true, true, false, false, false])
  // And it finds the tag again, whole, and makes a window again.
  const back = runner.run(frameWithTag(5, tagPose({ x: 0, y: 0, z: 1.8 }, 0, 20, 0), 20))
  assert.equal(back.passes, 1)
  assert.equal(back.detections.length, 1)
  assert.ok(runner.roi)
})

test('reset forgets the window, and a runner made without one searches whole frames only', () => {
  const runner = new TagRunner(new FiducialDetector(DICT))
  runner.run(frameWithTag(5, tagPose({ x: 0, y: 0, z: 1.8 }, 0, 20, 0), 1))
  assert.ok(runner.roi)
  runner.reset()
  assert.equal(runner.roi, null)
  assert.equal(runner.run(frameWithTag(5, tagPose({ x: 0, y: 0, z: 1.8 }, 0, 20, 0), 2)).roi, null)
  const { detector, seen } = counting()
  const plain = new TagRunner(detector, { roi: false })
  for (let i = 0; i < 3; i++) plain.run(frameWithTag(5, tagPose({ x: 0, y: 0, z: 1.8 }, 0, 20, 0), i + 1))
  assert.equal(plain.roi, null)
  assert.ok(seen.every((s) => s.width === 640 && s.height === 480))
})

test('the runner is behind a seam: any object with detect() and stats will do, and its clock is injectable', () => {
  const scripted: TagDetector = {
    detect: () => [],
    stats: { candidates: 7, groups: 1, prechecked: 0, decodeAttempts: 2, capped: false, detections: 0, rejected: { offFrame: 0, contrast: 1, border: 1, quiet: 0, match: 0, ids: 0 } },
  }
  let t = 0
  const runner = new TagRunner(scripted, { now: () => (t += 5) })
  const r = runner.run(blankFrame())
  assert.equal(r.detectMs, 5)
  assert.equal(r.stats.candidates, 7)
  assert.deepEqual(r.detections, [])
})

// ===============================================================================================
// The worker's handler
// ===============================================================================================

function handler() {
  const out: TagWorkerResponse[] = []
  let t = 0
  const handle = createTagWorkerHandler((m) => out.push(m), () => (t += 3))
  return { handle, out }
}

function frameMessage(image: FiducialImage, seq: number): TagWorkerRequest {
  return { type: 'frame', seq, buffer: image.data.slice().buffer as ArrayBuffer, width: image.width, height: image.height, rowBytes: image.rowBytes ?? image.width * image.channels, channels: image.channels }
}

test('init makes a detector for the named family, a frame gets its detections and counters back, and a reset forgets the window', () => {
  const { handle, out } = handler()
  handle({ type: 'init', family: 'cscan-6x6-v1', detector: {}, roi: true })
  assert.deepEqual(out, [{ type: 'ready' }])
  const pose = tagPose({ x: 0.05, y: 0, z: 1.7 }, 0, 25, 0)
  handle(frameMessage(frameWithTag(11, pose, 1), 41))
  const r = out[1]!
  assert.equal(r.type, 'result')
  if (r.type !== 'result') return
  assert.equal(r.seq, 41)
  assert.equal(r.detections.length, 1)
  assert.equal(r.detections[0]!.id, 11)
  assert.equal(r.detections[0]!.family, 'cscan-6x6-v1')
  assert.ok(worst(r.detections[0]!.corners, trueCorners(pose)) < 0.5)
  assert.equal(r.roi, null)
  assert.equal(r.roiMissed, false)
  assert.equal(r.passes, 1)
  assert.ok(r.workerMs >= r.detectMs && r.detectMs > 0, `${r.workerMs} ${r.detectMs}`)
  assert.equal(r.stats.detections, 1)
  assert.equal(r.stats.stageMs, undefined, 'stage timing is off unless the caller asked for it')
  // The next frame is read in the window; after a reset it is read whole.
  handle(frameMessage(frameWithTag(11, pose, 2), 42))
  assert.ok((out[2] as { roi: unknown }).roi)
  handle({ type: 'reset' })
  assert.equal(out.length, 3, 'a reset has no answer')
  handle(frameMessage(frameWithTag(11, pose, 3), 43))
  assert.equal((out[3] as { roi: unknown }).roi, null)
})

test('init can turn the search window off: every frame is then read whole, however sure the last one was', () => {
  const { handle, out } = handler()
  handle({ type: 'init', family: 'cscan-6x6-v1', detector: {}, roi: false })
  const pose = tagPose({ x: 0.05, y: 0, z: 1.7 }, 0, 25, 0)
  for (let seq = 1; seq <= 3; seq++) handle(frameMessage(frameWithTag(11, pose, seq), seq))
  const results = out.filter((m): m is Extract<TagWorkerResponse, { type: 'result' }> => m.type === 'result')
  assert.equal(results.length, 3)
  for (const r of results) {
    assert.equal(r.detections.length, 1)
    assert.equal(r.roi, null, 'no window was used')
    assert.equal(r.passes, 1)
  }
})

test('the detector options reach the detector: a registered tag only, and a wrong family or an unusable option is an error message, not a throw', () => {
  const { handle, out } = handler()
  handle({ type: 'init', family: 'cscan-6x6-v1', detector: { ids: [3], maxHamming: 0, minSidePx: 24 }, roi: false })
  const pose = tagPose({ x: 0, y: 0, z: 1.7 }, 0, 25, 0)
  handle(frameMessage(frameWithTag(9, pose, 1), 1))
  const r = out[1] as Extract<TagWorkerResponse, { type: 'result' }>
  assert.equal(r.detections.length, 0, 'tag 9 is not the tag asked for')
  assert.equal(r.stats.rejected.ids, 1)
  handle(frameMessage(frameWithTag(3, pose, 2), 2))
  assert.equal((out[2] as Extract<TagWorkerResponse, { type: 'result' }>).detections[0]!.id, 3)

  const other = handler()
  other.handle({ type: 'init', family: 'tag36h11', detector: {}, roi: true })
  assert.deepEqual(other.out, [{ type: 'error', seq: null, message: 'unknown tag family "tag36h11"' }])
  other.handle(frameMessage(blankFrame(), 7))
  assert.deepEqual(other.out[1], { type: 'error', seq: 7, message: 'a frame arrived before init' })
  const bad = handler()
  assert.doesNotThrow(() => bad.handle({ type: 'init', family: 'cscan-6x6-v1', detector: { maxHamming: Number.NaN }, roi: true }))
  assert.equal(bad.out[0]!.type, 'error')
  assert.match((bad.out[0] as { message: string }).message, /maxHamming/)
  // A frame whose size disagrees with its bytes cannot be read, and says so rather than throwing out of the worker.
  const { handle: h2, out: o2 } = handler()
  h2({ type: 'init', family: 'cscan-5x5-v1', detector: {}, roi: true })
  assert.doesNotThrow(() => h2({ type: 'frame', seq: 5, buffer: new ArrayBuffer(10), width: 640, height: 480, rowBytes: 2560, channels: 4 }))
  const last = o2[o2.length - 1]!
  assert.ok(last.type === 'error' || last.type === 'result', 'an answer, whatever it is')
})

test('stage timing, when the caller asks for it, comes back from the worker with the stages adding up to the call', () => {
  const { handle, out } = handler()
  handle({ type: 'init', family: 'cscan-6x6-v1', detector: { profile: true }, roi: false })
  handle(frameMessage(frameWithTag(11, tagPose({ x: 0.05, y: 0, z: 1.7 }, 0, 25, 0), 1), 1))
  const r = out[1] as Extract<TagWorkerResponse, { type: 'result' }>
  const stages = r.stats.stageMs!
  assert.ok(stages, 'the stage times were measured in the worker')
  assert.deepEqual(Object.keys(stages).sort(), ['decode', 'luma', 'precheck', 'pyramid', 'quads', 'refine'])
  for (const v of Object.values(stages)) assert.ok(Number.isFinite(v) && v >= 0)
  assert.ok(stages.luma + stages.pyramid + stages.quads + stages.refine + stages.decode > 0)
  assert.equal(stages.precheck, 0, 'a frame this quiet has no quads over the budget')
})

// ===============================================================================================
// The client, with a faithful fake worker
// ===============================================================================================

/** A worker whose messages really are structured clones with a transfer list, answered on a later microtask by the real handler. */
class FakeWorker implements WorkerLike {
  onmessage: ((event: { data: unknown }) => void) | null = null
  onerror: ((event: unknown) => void) | null = null
  terminated = 0
  posted: Array<{ message: TagWorkerRequest; transferred: number }> = []
  private readonly handle = createTagWorkerHandler((m) => queueMicrotask(() => this.onmessage?.({ data: structuredClone(m) })))
  /** Throw on a frame, as a browser that cannot transfer does. */
  failFrames = false
  /** Answer nothing at all to frames. */
  silent = false
  /** Answer init with an error. */
  failInit = false
  /** Add this to the `seq` of every answer. */
  seqOffset = 0

  postMessage(message: unknown, transfer?: Transferable[]): void {
    const m = message as TagWorkerRequest
    if (m.type === 'frame' && this.failFrames) throw new DOMException('transfer is not supported', 'DataCloneError')
    const clone = structuredClone(message, transfer ? { transfer } : undefined) as TagWorkerRequest
    this.posted.push({ message: clone, transferred: transfer?.length ?? 0 })
    if (m.type === 'init' && this.failInit) {
      queueMicrotask(() => this.onmessage?.({ data: { type: 'error', seq: null, message: 'cannot start' } }))
      return
    }
    if (m.type === 'frame' && this.silent) return
    if (this.seqOffset !== 0 && clone.type === 'frame') clone.seq += this.seqOffset
    queueMicrotask(() => this.handle(clone))
  }

  terminate(): void {
    this.terminated++
  }
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

let seqCounter = 0
function cameraFrame(image: FiducialImage, over: Partial<CameraFrame> = {}): CameraFrame {
  const i = seqCounter++
  return {
    pixels: new Uint8Array(image.data),
    width: image.width,
    height: image.height,
    rowBytes: image.rowBytes ?? image.width * image.channels,
    channels: image.channels,
    timestampMs: i * 100,
    pose: { position: { x: i, y: 1, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 } },
    poseTimestampMs: i * 100 - 33,
    lagFrames: 1,
    projection: [1.6, 0, 0, 0, 0, 2.1333, 0, 0, 0, 0, -1, -1, 0, 0, -0.2, 0],
    frameIndex: i,
    epoch: 0,
    trackingStatus: 'NORMAL',
    angularSpeedDegPerS: 3,
    ...over,
  }
}

function collect(client: TagWorkerClient): TagFrameResult[] {
  const results: TagFrameResult[] = []
  client.onResult((r) => results.push(r))
  return results
}

const POSE = tagPose({ x: 0.05, y: 0, z: 1.7 }, 0, 25, 0)

test('worker mode: init first, then a frame sent by transfer (detached here), and the answer comes back with the frame\'s metadata and where it was read', async () => {
  const worker = new FakeWorker()
  let now = 1000
  const client = new TagWorkerClient({ family: 'cscan-6x6-v1', detector: { minSidePx: 24 }, createWorker: () => worker, now: () => now })
  assert.equal(client.mode, 'worker')
  const results = collect(client)
  assert.equal(worker.posted.length, 1)
  assert.deepEqual(worker.posted[0]!.message, { type: 'init', family: 'cscan-6x6-v1', detector: { minSidePx: 24 }, roi: true })
  const frame = cameraFrame(frameWithTag(6, POSE, 1))
  const bytes = frame.pixels.byteLength
  assert.equal(client.submit(frame), 'sent')
  assert.equal(frame.pixels.byteLength, 0, 'the buffer was transferred: nothing is left here to read')
  assert.equal(worker.posted[1]!.transferred, 1)
  assert.equal((worker.posted[1]!.message as { buffer: ArrayBuffer }).buffer.byteLength, bytes)
  assert.equal(client.busy, true)
  now = 1042
  await settle()
  assert.equal(results.length, 1)
  const r = results[0]!
  assert.equal(r.mode, 'worker')
  assert.equal(r.roundTripMs, 42, 'from the frame being handed over to the answer, on the client\'s clock')
  assert.equal(r.detections.length, 1)
  assert.equal(r.detections[0]!.id, 6)
  assert.ok(worst(r.detections[0]!.corners, trueCorners(POSE)) < 0.5)
  assert.equal(r.frame.width, 640)
  assert.equal(r.frame.epoch, 0)
  assert.equal('pixels' in r.frame, false, 'the metadata carries no pixels')
  assert.equal(r.frame.angularSpeedDegPerS, 3)
  assert.ok(r.workerMs > 0)
  assert.equal(client.busy, false)
  assert.deepEqual({ ...client.stats }, { submitted: 1, completed: 1, droppedBusy: 0, droppedRate: 0, lost: 0, errors: 0, fallbackReason: null })
})

test('a frame that arrives while the last is still being read is dropped, not queued, and keeps its pixels; the next one after the answer is sent', async () => {
  const worker = new FakeWorker()
  const client = new TagWorkerClient({ family: 'cscan-6x6-v1', createWorker: () => worker })
  const results = collect(client)
  const a = cameraFrame(frameWithTag(6, POSE, 1))
  const b = cameraFrame(frameWithTag(6, POSE, 2))
  assert.equal(client.submit(a), 'sent')
  assert.equal(client.submit(b), 'dropped-busy')
  assert.ok(b.pixels.byteLength > 0, 'a dropped frame was never sent: its pixels are still the caller\'s')
  assert.equal(client.stats.droppedBusy, 1)
  await settle()
  assert.equal(results.length, 1)
  const c = cameraFrame(frameWithTag(6, POSE, 3))
  assert.equal(client.submit(c), 'sent')
  await settle()
  assert.equal(results.length, 2)
  assert.deepEqual(results.map((r) => r.seq), [1, 2])
})

test('with no Worker at all, frames are read on the main thread, at no more than five a second, one at a time, and the detector is loaded on demand', async () => {
  let now = 1000
  const reasons: TagFallbackReason[] = []
  const client = new TagWorkerClient({ family: 'cscan-6x6-v1', createWorker: () => null, now: () => now, onFallback: (r) => reasons.push(r) })
  assert.equal(client.mode, 'main-thread')
  assert.equal(client.stats.fallbackReason, 'no-worker')
  assert.deepEqual(reasons, ['no-worker'])
  const results = collect(client)
  const first = cameraFrame(frameWithTag(6, POSE, 1))
  assert.equal(client.submit(first), 'sent')
  assert.ok(first.pixels.byteLength > 0, 'read where it is: nothing is transferred')
  assert.equal(client.busy, true)
  assert.equal(client.submit(cameraFrame(frameWithTag(6, POSE, 2))), 'dropped-busy')
  await settle()
  await settle()
  assert.equal(results.length, 1)
  assert.equal(results[0]!.mode, 'main-thread')
  assert.equal(results[0]!.detections[0]!.id, 6)
  assert.ok(worst(results[0]!.detections[0]!.corners, trueCorners(POSE)) < 0.5)
  // Too soon after the last read.
  now += MAIN_THREAD_MIN_INTERVAL_MS - 1
  assert.equal(client.submit(cameraFrame(frameWithTag(6, POSE, 3))), 'dropped-rate')
  assert.equal(client.stats.droppedRate, 1)
  now += 1
  assert.equal(client.submit(cameraFrame(frameWithTag(6, POSE, 4))), 'sent')
  await settle()
  await settle()
  assert.equal(results.length, 2)
  assert.deepEqual({ ...client.stats }, { submitted: 2, completed: 2, droppedBusy: 1, droppedRate: 1, lost: 0, errors: 0, fallbackReason: 'no-worker' })
})

test('a browser that cannot transfer: the frame is read on the main thread instead, once, and every frame after it', async () => {
  const worker = new FakeWorker()
  worker.failFrames = true
  const reasons: TagFallbackReason[] = []
  const client = new TagWorkerClient({ family: 'cscan-6x6-v1', createWorker: () => worker, onFallback: (r) => reasons.push(r) })
  const results = collect(client)
  const frame = cameraFrame(frameWithTag(6, POSE, 1))
  assert.equal(client.submit(frame), 'sent')
  assert.ok(frame.pixels.byteLength > 0, 'a transfer that failed left the buffer where it was')
  assert.equal(client.mode, 'main-thread')
  assert.deepEqual(reasons, ['transfer-failed'])
  assert.equal(worker.terminated, 1)
  await settle()
  await settle()
  assert.equal(results.length, 1)
  assert.equal(results[0]!.mode, 'main-thread')
  assert.equal(results[0]!.detections[0]!.id, 6)
})

test('a worker that errors, or cannot start, hands over to the main thread; the frame that was in it is counted lost', async () => {
  const crashing = new FakeWorker()
  crashing.silent = true
  const reasons: TagFallbackReason[] = []
  const client = new TagWorkerClient({ family: 'cscan-6x6-v1', createWorker: () => crashing, onFallback: (r) => reasons.push(r) })
  const results = collect(client)
  assert.equal(client.submit(cameraFrame(frameWithTag(6, POSE, 1))), 'sent')
  crashing.onerror?.(new Error('script failed'))
  assert.equal(client.mode, 'main-thread')
  assert.equal(client.stats.fallbackReason, 'worker-error')
  assert.equal(client.stats.lost, 1)
  assert.equal(client.stats.errors, 1)
  assert.equal(crashing.terminated, 1)
  // Another error from the worker that was given up on is counted, and does not hand over a second time: one fallback, one report, and the first reason stands.
  crashing.onerror?.(new Error('a late one'))
  assert.deepEqual(reasons, ['worker-error'])
  assert.equal(client.stats.fallbackReason, 'worker-error')
  assert.equal(client.stats.errors, 2)
  assert.equal(client.submit(cameraFrame(frameWithTag(6, POSE, 2))), 'sent')
  await settle()
  await settle()
  assert.equal(results.length, 1)
  assert.equal(results[0]!.mode, 'main-thread')

  const cannot = new FakeWorker()
  cannot.failInit = true
  const c2 = new TagWorkerClient({ family: 'cscan-6x6-v1', createWorker: () => cannot })
  await settle()
  assert.equal(c2.mode, 'main-thread')
  assert.equal(c2.stats.fallbackReason, 'init-failed')
  assert.equal(cannot.terminated, 1)

  const throwing = new TagWorkerClient({ family: 'cscan-6x6-v1', createWorker: () => { throw new Error('no module workers here') } })
  assert.equal(throwing.stats.fallbackReason, 'no-worker')
})

test('a worker that never answers is given up on at the next frame after five seconds: the frame in it is lost, and the new one is read here', async () => {
  const silent = new FakeWorker()
  silent.silent = true
  let now = 0
  const client = new TagWorkerClient({ family: 'cscan-6x6-v1', createWorker: () => silent, now: () => now })
  const results = collect(client)
  assert.equal(client.submit(cameraFrame(frameWithTag(6, POSE, 1))), 'sent')
  now = WORKER_STALL_MS
  assert.equal(client.submit(cameraFrame(frameWithTag(6, POSE, 2))), 'dropped-busy', 'at exactly the limit it is still being waited for')
  now = WORKER_STALL_MS + 1
  assert.equal(client.submit(cameraFrame(frameWithTag(6, POSE, 3))), 'sent')
  assert.equal(client.stats.lost, 1)
  assert.equal(client.stats.fallbackReason, 'stalled')
  assert.equal(client.mode, 'main-thread')
  await settle()
  await settle()
  assert.equal(results.length, 1)
  assert.equal(results[0]!.mode, 'main-thread')
})

test('answers for a frame that is not the one being waited for are ignored; a listener that throws does not stop the others; a listener can be removed', async () => {
  const stale = new FakeWorker()
  stale.seqOffset = 100
  const a = new TagWorkerClient({ family: 'cscan-6x6-v1', createWorker: () => stale })
  const got = collect(a)
  a.submit(cameraFrame(frameWithTag(6, POSE, 1)))
  await settle()
  assert.equal(got.length, 0)
  assert.equal(a.busy, true, 'still waiting for the right answer')

  const worker = new FakeWorker()
  const client = new TagWorkerClient({ family: 'cscan-6x6-v1', createWorker: () => worker })
  const warn = console.warn
  console.warn = () => {}
  try {
    const seen: number[] = []
    client.onResult(() => {
      throw new Error('a listener that fails')
    })
    const stop = client.onResult((r) => seen.push(r.seq))
    client.submit(cameraFrame(frameWithTag(6, POSE, 1)))
    await settle()
    assert.deepEqual(seen, [1])
    stop()
    client.submit(cameraFrame(frameWithTag(6, POSE, 2)))
    await settle()
    assert.deepEqual(seen, [1], 'a removed listener hears nothing more')
  } finally {
    console.warn = warn
  }
})

test('close stops the worker once, refuses frames, and ignores what arrives after; reset tells the worker (or the main-thread runner) to forget the window', async () => {
  const worker = new FakeWorker()
  const client = new TagWorkerClient({ family: 'cscan-6x6-v1', createWorker: () => worker })
  const results = collect(client)
  client.submit(cameraFrame(frameWithTag(6, POSE, 1)))
  await settle()
  client.submit(cameraFrame(frameWithTag(6, POSE, 2)))
  await settle()
  assert.ok(results[1]!.roi, 'the second frame was read in a window')
  client.reset()
  assert.equal(worker.posted[worker.posted.length - 1]!.message.type, 'reset')
  client.submit(cameraFrame(frameWithTag(6, POSE, 3)))
  await settle()
  assert.equal(results[2]!.roi, null, 'after a reset the frame is read whole')
  client.submit(cameraFrame(frameWithTag(6, POSE, 4)))
  client.close()
  client.close()
  assert.equal(worker.terminated, 1)
  assert.equal(client.mode, 'closed')
  assert.equal(client.submit(cameraFrame(frameWithTag(6, POSE, 5))), 'closed')
  await settle()
  assert.equal(results.length, 3, 'an answer that arrives after close is ignored')
})

test('without any Worker option the client works in plain Node: no Worker exists, so the main thread reads, with the real detector loaded on demand', async () => {
  const client = new TagWorkerClient({ family: 'cscan-5x5-v1' })
  assert.equal(typeof (globalThis as { Worker?: unknown }).Worker, 'undefined')
  assert.equal(client.mode, 'main-thread')
  assert.equal(client.stats.fallbackReason, 'no-worker')
  const results = collect(client)
  client.submit(cameraFrame(frameWithTag(4, POSE, 1, CSCAN5_V1)))
  await new Promise((resolve) => setTimeout(resolve, 200))
  assert.equal(results.length, 1)
  assert.equal(results[0]!.detections[0]!.id, 4)
  assert.equal(results[0]!.detections[0]!.family, 'cscan-5x5-v1')
  // An unknown family cannot be read at all, and the error is counted, not thrown.
  const unknown = new TagWorkerClient({ family: 'nope', createWorker: () => null })
  unknown.submit(cameraFrame(blankFrame()))
  await new Promise((resolve) => setTimeout(resolve, 100))
  assert.equal(unknown.stats.errors, 1)
  assert.equal(unknown.stats.completed, 0)
})

test('the worker is started in the form Vite bundles, like the repo\'s one other worker, and the main-thread detector is imported on demand', () => {
  const client = readFileSync(join(ROOT, 'src/ar/fiducial/tag-worker-client.ts'), 'utf8')
  const router = readFileSync(join(ROOT, 'src/inference/router.ts'), 'utf8')
  const vite = readFileSync(join(ROOT, 'vite.config.ts'), 'utf8')
  const form = "new Worker(new URL('./%s', import.meta.url), { type: 'module' })"
  assert.ok(router.includes(form.replace('%s', 'webgpu.worker.ts')), 'the existing worker is started in this form')
  assert.ok(client.includes(form.replace('%s', 'tag-worker.ts')), 'and so is this one')
  assert.match(vite, /worker:\s*\{\s*\n\s*format:\s*'es'/)
  // The detector reaches the main thread only through an import() that runs when a fallback needs it.
  assert.match(client, /import\('\.\/detector\.ts'\)/)
  assert.ok(!/^import .*from '\.\/detector\.ts'/m.test(client.replace(/^import type .*$/gm, '')), 'no static import of the detector on the page')
  // The worker file itself is only wiring: the work is in the core, which the tests above run.
  const entry = readFileSync(join(ROOT, 'src/ar/fiducial/tag-worker.ts'), 'utf8')
  assert.match(entry, /createTagWorkerHandler/)
  assert.ok(entry.split('\n').filter((l) => l.trim() && !l.trim().startsWith('*') && !l.trim().startsWith('/*')).length < 20, 'the worker entry stays a few lines')
  // And it names no DOM global: a worker has none.
  assert.ok(!/\b(document|window|localStorage)\b/.test(entry.replace(/\/\*[\s\S]*?\*\//g, '')))
})
