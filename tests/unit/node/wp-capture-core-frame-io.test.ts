/**
 * Wave 14, ticket 0004 (F-40: FN-032, FN-033): a camera frame's image and the frozen-video check, each in one home.
 *
 *  - src/capture/frame-image.ts: the downscaled JPEG both the capture button and the keyframe streamer encode, with the
 *    one difference kept as an option (only the capture button re-encodes smaller), and the one `blobToDataUrl`.
 *  - src/capture/video-liveness.ts: the `currentTime` look that WebXR's capture refusal and the tripod sweep both make,
 *    each judging the frozen time against its own limit (500 ms and 1500 ms).
 *
 * The browser's image APIs are stand-ins that record what they were asked.
 *
 * Run: node --experimental-strip-types --no-warnings --test tests/unit/node/wp-capture-core-frame-io.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const read = (path: string): string => readFileSync(resolve(ROOT, path), 'utf8')

// ── Browser stand-ins ────────────────────────────────────────────────────────

interface Encode {
  canvas: { width: number; height: number }
  drawn: number[]
  qualities: number[]
}
const encodes: Encode[] = []
/** The size, in bytes, a stand-in JPEG comes out at for a quality: big enough to test the capture button's second pass. */
let bytesAt = (quality: number): number => Math.round(quality * 1000)

class FakeImageData {
  data: Uint8ClampedArray
  width: number
  height: number
  constructor(data: Uint8ClampedArray, width: number, height: number) {
    this.data = data
    this.width = width
    this.height = height
  }
}
class FakeOffscreenCanvas {
  width: number
  height: number
  record: Encode
  constructor(width: number, height: number) {
    this.width = width
    this.height = height
    this.record = { canvas: { width, height }, drawn: [], qualities: [] }
    encodes.push(this.record)
  }
  getContext(): { drawImage(...args: unknown[]): void } {
    return { drawImage: (...args: unknown[]) => { this.record.drawn = args.slice(1).map(Number) } }
  }
  async convertToBlob(options: { type: string; quality: number }): Promise<Blob> {
    this.record.qualities.push(options.quality)
    return new Blob([new Uint8Array(bytesAt(options.quality))], { type: options.type })
  }
}
class FakeFileReader {
  result: string | null = null
  onload: (() => void) | null = null
  onerror: ((e: unknown) => void) | null = null
  readAsDataURL(blob: Blob): void {
    void blob.arrayBuffer().then(
      (buf) => {
        this.result = `data:${blob.type};base64,${Buffer.from(buf).toString('base64')}`
        this.onload?.()
      },
      (e) => this.onerror?.(e),
    )
  }
}
const g = globalThis as Record<string, unknown>
g.ImageData = FakeImageData
g.createImageBitmap = async (data: FakeImageData) => ({ width: data.width, height: data.height, close(): void {} })
g.OffscreenCanvas = FakeOffscreenCanvas
g.FileReader = FakeFileReader
g.document ??= { visibilityState: 'visible', addEventListener(): void {} }

const {
  FRAME_JPEG_MAX_LONG_EDGE_PX,
  FRAME_JPEG_QUALITY,
  blobToDataUrl,
  encodeFrameJpeg,
  fitLongEdge,
} = await import('../../../src/capture/frame-image.ts')
const { CaptureModule } = await import('../../../src/capture/capture.ts')
const { KeyframeStreamer } = await import('../../../src/capture/keyframes.ts')
const { VIDEO_UNSEEN, frozenForMs, lookAtVideo } = await import('../../../src/capture/video-liveness.ts')
const { SWEEP_STALL_MS, startCadence, tickCadence } = await import('../../../src/capture/sweep-cadence.ts')

function frameOf(width: number, height: number) {
  return {
    pixels: new Uint8ClampedArray(width * height * 4),
    width,
    height,
    pose: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 } },
    timestamp: 1,
  }
}

function providerWith(frame: ReturnType<typeof frameOf>) {
  return {
    captureFrame: async () => frame,
    getCameraFovY: () => 60,
    getCameraAspect: () => 0.75,
  } as unknown as ConstructorParameters<typeof CaptureModule>[0]
}

// ── The JPEG ─────────────────────────────────────────────────────────────────

test('both encoders default to a 1280 px long edge at quality 0.8, and a frame is never scaled up', () => {
  assert.equal(FRAME_JPEG_MAX_LONG_EDGE_PX, 1280)
  assert.equal(FRAME_JPEG_QUALITY, 0.8)
  assert.deepEqual(fitLongEdge(1920, 1080, 1280), { width: 1280, height: 720 })
  assert.deepEqual(fitLongEdge(1080, 1920, 1280), { width: 720, height: 1280 })
  assert.deepEqual(fitLongEdge(640, 480, 1280), { width: 640, height: 480 })
  assert.deepEqual(fitLongEdge(1001, 667, 500), { width: 500, height: 333 }, 'rounded, as both encoders rounded')
})

test('encodeFrameJpeg draws the frame at its fitted size, once, and copies the pixels it was given', async () => {
  encodes.length = 0
  const pixels = new Uint8ClampedArray(1920 * 1080 * 4).fill(7)
  const pending = encodeFrameJpeg(pixels, 1920, 1080)
  pixels.fill(0) // a runtime reusing its buffer after the call
  const blob = await pending
  assert.equal(blob.type, 'image/jpeg')
  assert.equal(encodes.length, 1)
  assert.deepEqual(encodes[0]!.canvas, { width: 1280, height: 720 })
  assert.deepEqual(encodes[0]!.drawn, [0, 0, 1280, 720])
  assert.deepEqual(encodes[0]!.qualities, [0.8])
})

test('the smaller second pass happens only where it is asked for, and only when the first is too big', async () => {
  encodes.length = 0
  bytesAt = () => 2_000_000
  await encodeFrameJpeg(new Uint8ClampedArray(16), 2, 2, { quality: 0.8 })
  assert.deepEqual(encodes[0]!.qualities, [0.8], 'no fallback asked: one pass, whatever its size')
  await encodeFrameJpeg(new Uint8ClampedArray(16), 2, 2, { quality: 0.8, fallback: { maxBytes: 1_500_000, quality: 0.65 } })
  assert.deepEqual(encodes[1]!.qualities, [0.8, 0.65])
  bytesAt = () => 1_500_000
  await encodeFrameJpeg(new Uint8ClampedArray(16), 2, 2, { quality: 0.8, fallback: { maxBytes: 1_500_000, quality: 0.65 } })
  assert.deepEqual(encodes[2]!.qualities, [0.8], 'exactly the cap is not over it')
  bytesAt = (quality) => Math.round(quality * 1000)
})

test('the capture button re-encodes at 0.65 over 1.5 MB, as it did', async () => {
  encodes.length = 0
  bytesAt = (quality) => (quality === 0.8 ? 1_600_000 : 900_000)
  const result = await new CaptureModule(providerWith(frameOf(1920, 1440))).capture()
  assert.deepEqual(encodes[0]!.qualities, [0.8, 0.65])
  assert.equal(result.blob.size, 900_000)
  assert.equal(result.frameWidth, 1920, 'the raw frame size, which bboxes are normalised against')
  assert.deepEqual(encodes[0]!.canvas, { width: 1280, height: 960 })
  bytesAt = (quality) => Math.round(quality * 1000)
})

test('a keyframe is encoded once, at its own options, and its intrinsics describe the size it was encoded at', async () => {
  encodes.length = 0
  bytesAt = () => 3_000_000 // far over the capture button's cap: a keyframe still is not re-encoded
  const streamer = new KeyframeStreamer(providerWith(frameOf(1600, 1200)), { maxLongEdgePx: 800, jpegQuality: 0.7 })
  const queued = await (streamer as unknown as { _captureKeyframe(id: string): Promise<{ meta: { intrinsics: Record<string, number> } }> })._captureKeyframe('sess-test')
  assert.deepEqual(encodes[0]!.qualities, [0.7])
  assert.deepEqual(encodes[0]!.canvas, { width: 800, height: 600 })
  assert.equal(queued.meta.intrinsics.width, 800)
  assert.equal(queued.meta.intrinsics.height, 600)
  assert.equal(queued.meta.intrinsics.sourceWidth, 1600)
  assert.equal(queued.meta.intrinsics.sourceHeight, 1200)
  bytesAt = (quality) => Math.round(quality * 1000)
})

test('blobToDataUrl gives the blob as a data URL, and is the one copy', async () => {
  const url = await blobToDataUrl(new Blob(['hi'], { type: 'text/plain' }))
  assert.equal(url, 'data:text/plain;base64,aGk=')
  for (const path of ['src/capture/capture.ts', 'src/inference/router.ts', 'src/capture/keyframes.ts']) {
    assert.doesNotMatch(read(path), /function blobToDataUrl/, path)
  }
  assert.doesNotMatch(read('src/capture/keyframes.ts'), /convertToBlob/, 'the keyframe encodes through frame-image.ts')
  // The capture button's frame does too. Its two thumbnails (256 px, 0.7, one of them a crop) are another image.
  const capture = read('src/capture/capture.ts')
  const captureMethod = capture.slice(capture.indexOf('async capture('), capture.indexOf('async captureThumbnail('))
  assert.doesNotMatch(captureMethod, /convertToBlob|OffscreenCanvas/)
  assert.match(read('src/inference/router.ts'), /import \{ blobToDataUrl \} from '\.\.\/capture\/frame-image\.ts'/)
  assert.doesNotMatch(read('src/capture/keyframes.ts'), /fallback:/, 'a keyframe asks for no second pass')
  assert.match(read('src/capture/capture.ts'), /fallback: \{ maxBytes: MAX_BLOB_BYTES, quality: FALLBACK_QUALITY \}/)
})

// ── Frozen video ─────────────────────────────────────────────────────────────

test('a look at currentTime: a new reading is live, a repeat starts the clock once, and the clock is the first repeat\'s', () => {
  let s = lookAtVideo(VIDEO_UNSEEN, 0.5, 1000)
  assert.equal(s.moved, true)
  assert.equal(frozenForMs(s, 1000), 0)
  s = lookAtVideo(s, 0.5, 1100)
  assert.equal(s.moved, false)
  assert.equal(s.stalledSinceMs, 1100)
  s = lookAtVideo(s, 0.5, 1700)
  assert.equal(s.stalledSinceMs, 1100, 'the clock is not restarted by a later repeat')
  assert.equal(frozenForMs(s, 1700), 600)
  s = lookAtVideo(s, 0.53, 1750)
  assert.equal(s.moved, true)
  assert.equal(s.stalledSinceMs, null)
  assert.equal(frozenForMs(s, 5000), 0)
  assert.equal(lookAtVideo(VIDEO_UNSEEN, -1, 0).moved, false, 'only the unseen marker equals -1')
})

test('the two limits stay apart: WebXR refuses a capture at 500 ms of frozen video, a sweep ends at 1500 ms', () => {
  const webxr = read('src/ar/webxr.ts')
  assert.match(webxr, /const VIDEO_STALL_THRESHOLD_MS = 500\b/)
  assert.match(webxr, /frozenForMs\(self\._videoLiveness, time\) >= VIDEO_STALL_THRESHOLD_MS/)
  assert.doesNotMatch(webxr, /_videoStalledSinceMs|_videoLastCurrentTime/)
  assert.equal(SWEEP_STALL_MS, 1500)

  // A sweep fed one frozen reading after it was seen live: it waits up to the limit, and ends at it.
  const tick = (nowMs: number, currentTime: number) => ({ nowMs, readyState: 4, videoWidth: 640, currentTime })
  let state = startCadence(0)
  state = tickCadence(state, tick(100, 0.1)).state
  state = tickCadence(state, tick(200, 0.2)).state
  assert.equal(state.seenLive, true)
  let step = tickCadence(state, tick(300, 0.2))
  assert.equal(step.state.stalledSinceMs, 300)
  assert.equal(step.action, 'wait')
  step = tickCadence(step.state, tick(300 + SWEEP_STALL_MS - 1, 0.2))
  assert.equal(step.action, 'wait')
  assert.equal(step.state.stalledSinceMs, 300)
  step = tickCadence(step.state, tick(300 + SWEEP_STALL_MS, 0.2))
  assert.equal(step.action, 'end')
  assert.equal(step.state.ended, 'stalled')
})
