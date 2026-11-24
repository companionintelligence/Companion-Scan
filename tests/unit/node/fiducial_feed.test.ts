/**
 * The camera-frame feed (`src/ar/camera-frame-feed.ts`) and its two provider seams: what it delivers, what it costs, and what it never does.
 *
 * "Zero cost without a subscriber" is tested as a count: the runtime's pixel array here is an object whose every property is a trap that
 * counts its reads, so a feed that so much as looks at the pixels of a tick nobody wanted would be caught, and the bytes it copies are counted
 * to the byte. The 8th Wall provider is driven through the real `ci-scan-capture` pipeline module with a scripted engine (the harness of
 * `frame_epoch_eighthwall.test.ts`: the process-cpu hook is handed the pixels, the update hook is handed the reality); the WebXR provider
 * answers without a session. A fake provider (an object with `onCameraFrame`) drives the feed directly.
 *
 * Run: node --experimental-strip-types --no-warnings --test tests/unit/node/fiducial_feed.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CameraFrameFeed, unsupportedCameraFeed, type CameraFrame, type EngineTick } from '../../../src/ar/camera-frame-feed.ts'
import { DEFAULT_PIXEL_LAG_FRAMES } from '../../../src/ar/fiducial/pose-history.ts'
import { EighthWallProvider } from '../../../src/ar/eighthwall.ts'
import { WebXRProvider } from '../../../src/ar/webxr.ts'
import type { Pose } from '../../../src/ar/provider.ts'

// ─── Browser globals the 8th Wall provider reads ───────────────────────────

const doc = {
  visibilityState: 'visible' as 'visible' | 'hidden',
  querySelector: () => null,
  addEventListener(): void {},
  removeEventListener(): void {},
}
;(globalThis as { document?: unknown }).document = doc
;(globalThis as { window?: unknown }).window = {
  location: { search: '' },
  innerWidth: 360,
  innerHeight: 640,
  devicePixelRatio: 1,
  addEventListener(): void {},
  removeEventListener(): void {},
}

interface Module {
  name: string
  onUpdate?: (args: unknown) => void
  onProcessCpu?: (args: unknown) => void
}
let modules: Module[] = []
;(globalThis as { XR8?: unknown }).XR8 = {
  loadChunk: async () => {},
  addCameraPipelineModules(mods: Module[]): void {
    modules = mods
  },
  GlTextureRenderer: { pipelineModule: () => ({ name: 'gl' }) },
  Threejs: { pipelineModule: () => ({ name: 'three' }), xrScene: () => ({ scene: {}, camera: {}, renderer: {} }) },
  XrController: { pipelineModule: () => ({ name: 'xr' }), hitTest: () => [] },
  CameraPixelArray: { pipelineModule: () => ({ name: 'pixels' }) },
  XrConfig: { device: () => ({ ANY: 'any' }) },
  stop(): void {},
  run(): void {},
}

// ─── Ticks and traps ───────────────────────────────────────────────────────

const FRAME_MS = 1000 / 30
const PROJECTION = [1.6, 0, 0, 0, 0, 2.1333, 0, 0, 0, 0, -1.002, -1, 0, 0, -0.2002, 0]

function poseAt(i: number): Pose {
  const half = (i * 0.5 * Math.PI) / 360
  return { position: { x: i * 0.01, y: 1.4, z: -i * 0.002 }, rotation: { x: 0, y: Math.sin(half), z: 0, w: Math.cos(half) } }
}

/** A pixel array that counts every look at it. `frame` fills the bytes so a copy can be told from its source. */
function trapped(rows = 4, cols = 8, frame = 0) {
  const reads = { pixels: 0, shape: 0 }
  const bytes = new Uint8Array(rows * cols * 4)
  for (let i = 0; i < bytes.length; i++) bytes[i] = (i + frame) & 255
  const array = {
    get pixels() {
      reads.pixels++
      return bytes
    },
    get rows() {
      reads.shape++
      return rows
    },
    get cols() {
      reads.shape++
      return cols
    },
    get rowBytes() {
      reads.shape++
      return cols * 4
    },
  }
  return { array, reads, bytes }
}

function tick(i: number, over: Partial<EngineTick> = {}): EngineTick {
  return {
    timestampMs: i * FRAME_MS,
    repeatFrame: false,
    pose: poseAt(i),
    poseCurrent: true,
    epoch: 0,
    trackingStatus: 'NORMAL',
    projection: PROJECTION,
    pixelArray: trapped(4, 8, i).array,
    ...over,
  }
}

// ===============================================================================================
// The feed
// ===============================================================================================

test('with nobody subscribed a tick costs nothing: the pixels are never looked at, nothing is counted, nothing is copied', () => {
  const feed = new CameraFrameFeed()
  assert.equal(feed.active, false)
  const t = trapped()
  for (let i = 0; i < 200; i++) feed.offer(tick(i, { pixelArray: t.array }))
  assert.deepEqual(t.reads, { pixels: 0, shape: 0 })
  assert.equal(feed.stats.ticks, 0)
  assert.equal(feed.stats.copiedBytes, 0)
  assert.equal(feed.stats.delivered, 0)
  // And again after a subscriber has come and gone: the feed returns to doing nothing, and forgets the poses it was keeping.
  const sub = feed.subscribe(() => {}, { maxHz: 30 })
  assert.equal(feed.active, true)
  for (let i = 0; i < 5; i++) feed.offer(tick(i))
  sub.unsubscribe()
  assert.equal(feed.active, false)
  const ticksThen = feed.stats.ticks
  const t2 = trapped()
  for (let i = 5; i < 100; i++) feed.offer(tick(i, { pixelArray: t2.array }))
  assert.deepEqual(t2.reads, { pixels: 0, shape: 0 })
  assert.equal(feed.stats.ticks, ticksThen)
})

test('a subscriber at 10 Hz on a 30 Hz runtime gets every third tick, one copy each, and the pixels are looked at on those ticks only', () => {
  const feed = new CameraFrameFeed()
  const frames: CameraFrame[] = []
  feed.subscribe((f) => frames.push(f), { maxHz: 10, lagFrames: 0 })
  const reads: Array<ReturnType<typeof trapped>> = []
  for (let i = 0; i < 30; i++) {
    const t = trapped(4, 8, i)
    reads.push(t)
    feed.offer(tick(i, { pixelArray: t.array }))
  }
  assert.equal(frames.length, 10, 'ten frames in a second')
  assert.deepEqual(frames.map((f) => Math.round(f.timestampMs / FRAME_MS)), [0, 3, 6, 9, 12, 15, 18, 21, 24, 27])
  // Looked at exactly on the delivered ticks, and nowhere else.
  const looked = reads.map((r, i) => (r.reads.pixels > 0 ? i : -1)).filter((i) => i >= 0)
  assert.deepEqual(looked, [0, 3, 6, 9, 12, 15, 18, 21, 24, 27])
  for (const i of looked) assert.equal(reads[i]!.reads.pixels, 1, `tick ${i}: the pixels are read once`)
  assert.equal(feed.stats.delivered, 10)
  assert.equal(feed.stats.copiedBytes, 10 * 4 * 8 * 4)
  assert.equal(feed.stats.ticks, 30)
  assert.equal(frames[0]!.frameIndex, 0)
  assert.equal(frames[9]!.frameIndex, 9)
  // 5 Hz is every sixth tick.
  const slow = new CameraFrameFeed()
  const slowFrames: CameraFrame[] = []
  slow.subscribe((f) => slowFrames.push(f), { maxHz: 5, lagFrames: 0 })
  for (let i = 0; i < 30; i++) slow.offer(tick(i))
  assert.equal(slowFrames.length, 5)
})

test('the frame carries what was asked for: size, row bytes, format, time, projection, epoch, status, turning speed; and its pixels are a copy', () => {
  const feed = new CameraFrameFeed()
  const frames: CameraFrame[] = []
  feed.subscribe((f) => frames.push(f), { maxHz: 30, lagFrames: 0 })
  const sources = [trapped(4, 8, 0), trapped(4, 8, 1)]
  feed.offer(tick(0, { pixelArray: sources[0]!.array, epoch: 3 }))
  const projection = PROJECTION.slice()
  feed.offer(tick(1, { pixelArray: sources[1]!.array, projection, epoch: 3, trackingStatus: 'LIMITED', display: { canvasWidth: 720, canvasHeight: 540, fit: 'contain' } }))
  assert.equal(frames.length, 2)
  const f = frames[1]!
  assert.equal(f.width, 8)
  assert.equal(f.height, 4)
  assert.equal(f.rowBytes, 32)
  assert.equal(f.channels, 4)
  assert.equal(f.pixels.byteLength, 128)
  assert.deepEqual(Array.from(f.pixels), Array.from(sources[1]!.bytes))
  assert.notEqual(f.pixels.buffer, sources[1]!.bytes.buffer)
  assert.equal(f.timestampMs, FRAME_MS)
  assert.deepEqual(f.pose, poseAt(1))
  assert.equal(f.poseTimestampMs, FRAME_MS)
  assert.equal(f.lagFrames, 0)
  assert.deepEqual(f.projection, PROJECTION)
  assert.equal(f.epoch, 3)
  assert.equal(f.trackingStatus, 'LIMITED')
  assert.deepEqual(f.display, { canvasWidth: 720, canvasHeight: 540, fit: 'contain' })
  // One degree of yaw in one frame: 0.5 degrees per frame in this scene, at 30 Hz is 15 degrees a second.
  assert.ok(Math.abs(f.angularSpeedDegPerS! - 15) < 1e-6, `${f.angularSpeedDegPerS}`)
  assert.equal(frames[0]!.angularSpeedDegPerS, null, 'the first tick has no speed')
  // The copy and the source are independent either way round, and so is the projection.
  sources[1]!.bytes[0] = 99
  assert.notEqual(f.pixels[0], 99)
  f.pixels[1] = 77
  assert.notEqual(sources[1]!.bytes[1], 77)
  projection[0] = 123
  assert.equal(f.projection[0], PROJECTION[0])
  f.projection[1] = 5
  assert.equal(PROJECTION[1], 0)
})

test('the pose is the one lagFrames ticks back, none is delivered until the history is that deep, and recentPoses lists them newest first', () => {
  assert.equal(DEFAULT_PIXEL_LAG_FRAMES, 1)
  for (const lag of [0, 1, 2, 4]) {
    const feed = new CameraFrameFeed()
    const frames: CameraFrame[] = []
    feed.subscribe((f) => frames.push(f), { maxHz: 30, lagFrames: lag, recentPoses: 3 })
    for (let i = 0; i < 10; i++) feed.offer(tick(i))
    // Frame k of the run is tick lag + k: the first `lag` ticks had no pose that far back and are counted, not delivered.
    assert.equal(frames.length, 10 - lag, `lag ${lag}`)
    assert.equal(feed.stats.unpaired, lag)
    frames.forEach((f, k) => {
      const tickIndex = lag + k
      assert.deepEqual(f.pose, poseAt(tickIndex - lag), `lag ${lag}, tick ${tickIndex}`)
      assert.ok(Math.abs(f.poseTimestampMs - (tickIndex - lag) * FRAME_MS) < 1e-9)
      assert.equal(f.lagFrames, lag)
      assert.equal(f.timestampMs, tickIndex * FRAME_MS)
      assert.deepEqual(f.recentPoses, [poseAt(tickIndex), poseAt(tickIndex - 1), poseAt(tickIndex - 2)].slice(0, Math.min(3, tickIndex + 1)))
    })
  }
  // The default is the documented starting guess.
  const feed = new CameraFrameFeed()
  const frames: CameraFrame[] = []
  feed.subscribe((f) => frames.push(f), { maxHz: 30 })
  for (let i = 0; i < 5; i++) feed.offer(tick(i))
  assert.equal(frames[0]!.lagFrames, DEFAULT_PIXEL_LAG_FRAMES)
  assert.deepEqual(frames[0]!.pose, poseAt(0))
  assert.deepEqual(frames[1]!.pose, poseAt(1))
})

test('a tick the camera did not refresh, a pose the runtime is holding over, and a change of epoch are not paired across', () => {
  const feed = new CameraFrameFeed()
  const frames: CameraFrame[] = []
  feed.subscribe((f) => frames.push(f), { maxHz: 30, lagFrames: 1 })
  feed.offer(tick(0))
  feed.offer(tick(1))
  assert.equal(frames.length, 1)
  // A repeated frame: nothing is delivered, no pose is added (so the next tick pairs with the one before it, not with a repeat), and it is counted.
  const t = trapped()
  feed.offer(tick(2, { repeatFrame: true, pixelArray: t.array }))
  assert.deepEqual(t.reads, { pixels: 0, shape: 0 })
  assert.equal(feed.stats.repeatFrames, 1)
  feed.offer(tick(2))
  assert.deepEqual(frames[1]!.pose, poseAt(1), 'the repeat was not a sample')
  // A pose that is being held over: not delivered, not recorded, and the poses either side of the gap are not neighbours, so the history starts again.
  const held = trapped()
  feed.offer(tick(3, { poseCurrent: false, pixelArray: held.array }))
  assert.deepEqual(held.reads, { pixels: 0, shape: 0 })
  assert.equal(feed.stats.heldPose, 1)
  feed.offer(tick(3, { pose: null }))
  assert.equal(feed.stats.heldPose, 2)
  const unpairedBefore = feed.stats.unpaired
  feed.offer(tick(3))
  assert.equal(frames.length, 2, 'the first tick after the gap has no pose a frame before it to pair with, and is not given the one from before the gap')
  assert.equal(feed.stats.unpaired, unpairedBefore + 1)
  feed.offer(tick(4))
  assert.equal(frames.length, 3)
  assert.deepEqual(frames[2]!.pose, poseAt(3), 'and then it pairs inside the new run of poses')
  // A new epoch: poses from before it are not in its frame of reference, so the first tick after it has nothing to pair with at lag 1.
  const n = frames.length
  feed.offer(tick(5, { epoch: 1 }))
  assert.equal(frames.length, n, 'no frame on the first tick of a new epoch')
  assert.equal(feed.stats.unpaired, unpairedBefore + 2, 'the first tick after the gap and this one')
  feed.offer(tick(6, { epoch: 1 }))
  assert.equal(frames.length, n + 1)
  assert.deepEqual(frames[n]!.pose, poseAt(5), 'and then it pairs inside the new epoch')
  assert.equal(frames[n]!.epoch, 1)
})

test('a pose the runtime held over a second is never paired with the pixels of a frame after it: at any lag, no frame has a pose older than the lag asks for', () => {
  // A camera walking at 0.5 m/s, a tick every 33 ms; tracking goes (the provider holds the old pose) for 1.2 s, and comes back. A pose from before the gap paired with a
  // frame after it is a camera 60 cm out: the tag would land there.
  for (const lag of [0, 1, 2]) {
    const feed = new CameraFrameFeed()
    const frames: CameraFrame[] = []
    feed.subscribe((f) => frames.push(f), { maxHz: 30, lagFrames: lag })
    const walking = (i: number, over: Partial<EngineTick> = {}): EngineTick => tick(i, { pose: { position: { x: i * 0.0167, y: 1.4, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 } }, ...over })
    for (let i = 0; i < 5; i++) feed.offer(walking(i))
    const before = frames.length
    for (let i = 5; i < 41; i++) feed.offer(walking(i, { poseCurrent: false }))
    assert.equal(frames.length, before, `lag ${lag}: nothing is delivered while the pose is held`)
    for (let i = 41; i < 48; i++) feed.offer(walking(i))
    const after = frames.slice(before)
    assert.ok(after.length >= 4, `lag ${lag}: frames come again (${after.length})`)
    for (const f of after) {
      const age = (f.timestampMs - f.poseTimestampMs) / FRAME_MS
      assert.ok(Math.abs(age - lag) < 1e-6, `lag ${lag}: frame at ${f.timestampMs.toFixed(0)} ms has a pose ${age.toFixed(1)} frames older, not ${lag}`)
    }
    // The ticks that had no neighbours to pair with were counted, not delivered with the wrong pose.
    assert.equal(after.length, 48 - 41 - lag, `lag ${lag}`)
  }
})

test('what cannot be delivered is counted and never copied: no pixel array, a malformed one, no projection', () => {
  const feed = new CameraFrameFeed()
  const frames: CameraFrame[] = []
  feed.subscribe((f) => frames.push(f), { maxHz: 30, lagFrames: 0 })
  feed.offer(tick(0, { pixelArray: null }))
  feed.offer(tick(1, { pixelArray: { pixels: new Uint8Array(10), rows: 4, cols: 8 } }))
  feed.offer(tick(2, { pixelArray: { pixels: new Uint8Array(128), rows: 4.5, cols: 8 } }))
  feed.offer(tick(3, { pixelArray: { pixels: [1, 2, 3], rows: 1, cols: 1 } }))
  feed.offer(tick(4, { pixelArray: { pixels: new Uint8Array(128), rows: 4, cols: 8, rowBytes: 7 } }))
  assert.equal(feed.stats.noPixels, 5)
  feed.offer(tick(5, { projection: null }))
  feed.offer(tick(6, { projection: [1, 2, 3] }))
  feed.offer(tick(7, { projection: PROJECTION.map((v, i) => (i === 5 ? Number.NaN : v)) }))
  assert.equal(feed.stats.noProjection, 3)
  assert.equal(frames.length, 0)
  assert.equal(feed.stats.copiedBytes, 0)
  assert.equal(feed.stats.delivered, 0)
  // The same feed delivers as soon as a tick is whole.
  feed.offer(tick(8))
  assert.equal(frames.length, 1)
})

test('the formats a runtime hands over: RGBA, a padded RGBA row, a luma plane, a clamped array, and a missing row width worked out from the length', () => {
  const feed = new CameraFrameFeed()
  const frames: CameraFrame[] = []
  feed.subscribe((f) => frames.push(f), { maxHz: 30, lagFrames: 0 })
  // Padded rows: 5 columns of RGBA in 24-byte rows. The whole padded buffer is the frame, so a reader can use the stride.
  const padded = new Uint8Array(24 * 3).map((_, i) => i)
  feed.offer(tick(0, { pixelArray: { pixels: padded, rows: 3, cols: 5, rowBytes: 24 } }))
  assert.equal(frames[0]!.rowBytes, 24)
  assert.equal(frames[0]!.channels, 4)
  assert.equal(frames[0]!.pixels.byteLength, 72)
  assert.deepEqual(Array.from(frames[0]!.pixels), Array.from(padded))
  // A luma plane, rows no wider than the width.
  feed.offer(tick(1, { pixelArray: { pixels: new Uint8Array(40), rows: 5, cols: 8, rowBytes: 8 } }))
  assert.equal(frames[1]!.channels, 1)
  assert.equal(frames[1]!.pixels.byteLength, 40)
  // A clamped array is read and comes back as plain bytes.
  feed.offer(tick(2, { pixelArray: { pixels: new Uint8ClampedArray(32 * 4).fill(200), rows: 4, cols: 8 } }))
  assert.ok(frames[2]!.pixels instanceof Uint8Array && !(frames[2]!.pixels instanceof Uint8ClampedArray))
  assert.equal(frames[2]!.pixels[5], 200)
  // No `rowBytes`: RGBA if the array is long enough for it, else luma.
  feed.offer(tick(3, { pixelArray: { pixels: new Uint8Array(4 * 8 * 4), rows: 4, cols: 8 } }))
  assert.equal(frames[3]!.channels, 4)
  feed.offer(tick(4, { pixelArray: { pixels: new Uint8Array(4 * 8), rows: 4, cols: 8 } }))
  assert.equal(frames[4]!.channels, 1)
  // An array longer than the frame needs is cut to what the frame is.
  feed.offer(tick(5, { pixelArray: { pixels: new Uint8Array(1000), rows: 4, cols: 8, rowBytes: 32 } }))
  assert.equal(frames[5]!.pixels.byteLength, 128)
})

test('two subscribers each own their copy, run at their own rate, and one that throws is counted and does not stop the others or the runtime', () => {
  const feed = new CameraFrameFeed()
  const a: CameraFrame[] = []
  const b: CameraFrame[] = []
  let threw = 0
  feed.subscribe((f) => a.push(f), { maxHz: 30, lagFrames: 0 })
  feed.subscribe(() => {
    threw++
    throw new Error('a subscriber that fails')
  }, { maxHz: 10, lagFrames: 0 })
  feed.subscribe((f) => b.push(f), { maxHz: 15, lagFrames: 0 })
  const warn = console.warn
  const warned: unknown[][] = []
  console.warn = (...args: unknown[]) => void warned.push(args)
  try {
    for (let i = 0; i < 30; i++) feed.offer(tick(i))
  } finally {
    console.warn = warn
  }
  assert.equal(a.length, 30)
  assert.equal(b.length, 15)
  assert.equal(threw, 10)
  assert.equal(feed.stats.callbackErrors, 10)
  assert.equal(warned.length, 10)
  // Own copies: changing one subscriber's bytes does not change another's.
  assert.notEqual(a[0]!.pixels.buffer, b[0]!.pixels.buffer)
  a[0]!.pixels[0] = 250
  assert.notEqual(b[0]!.pixels[0], 250)
  // Three copies on ticks all three are due on (tick 0), one on the rest: the byte count is the sum.
  assert.equal(feed.stats.copiedBytes, (30 + 15 + 10) * 128)
})

test('unsubscribing stops delivery, is safe twice, and the last one out makes the feed idle again; reset keeps subscribers and restarts their count', () => {
  const feed = new CameraFrameFeed()
  const frames: CameraFrame[] = []
  const sub = feed.subscribe((f) => frames.push(f), { maxHz: 30, lagFrames: 0 })
  assert.equal(sub.status, 'active')
  assert.equal(sub.reason, null)
  for (let i = 0; i < 3; i++) feed.offer(tick(i))
  assert.equal(frames.length, 3)
  feed.reset()
  assert.equal(feed.active, true)
  feed.offer(tick(3))
  assert.equal(frames[3]!.frameIndex, 0, 'the count starts again')
  sub.unsubscribe()
  sub.unsubscribe()
  assert.equal(feed.active, false)
  feed.offer(tick(4))
  assert.equal(frames.length, 4)
})

test('subscriptions are refused numbers that cannot mean anything', () => {
  const feed = new CameraFrameFeed()
  for (const maxHz of [0, 0.5, 31, 100, Number.NaN, Number.POSITIVE_INFINITY]) assert.throws(() => feed.subscribe(() => {}, { maxHz }), /maxHz/, `maxHz ${maxHz}`)
  for (const lagFrames of [-1, 9, 1.5, Number.NaN]) assert.throws(() => feed.subscribe(() => {}, { maxHz: 10, lagFrames }), /lagFrames/, `lagFrames ${lagFrames}`)
  for (const recentPoses of [-1, 10, 1.5]) assert.throws(() => feed.subscribe(() => {}, { maxHz: 10, recentPoses }), /recentPoses/, `recentPoses ${recentPoses}`)
  assert.equal(feed.active, false, 'a refused subscription leaves nothing behind')
  assert.doesNotThrow(() => feed.subscribe(() => {}, { maxHz: 1 }))
  assert.doesNotThrow(() => feed.subscribe(() => {}, { maxHz: 30, lagFrames: 8, recentPoses: 9 }))
})

test('a feed that will never deliver says so, and what it says is stable', () => {
  const s = unsupportedCameraFeed('webxr-no-camera-access')
  assert.equal(s.status, 'unsupported')
  assert.equal(s.reason, 'webxr-no-camera-access')
  assert.doesNotThrow(() => {
    s.unsubscribe()
    s.unsubscribe()
  })
  assert.equal(unsupportedCameraFeed('no-frame-feed').reason, 'no-frame-feed')
})

// ===============================================================================================
// The 8th Wall provider's seam, through its real pipeline module
// ===============================================================================================

function canvas(): HTMLCanvasElement {
  return { width: 360, height: 640, style: { removeProperty(): void {} } } as unknown as HTMLCanvasElement
}

interface Engine {
  provider: EighthWallProvider
  /** One engine tick: the process-cpu hook is handed the pixels, then the update hook the reality. */
  play(i: number, over?: { repeatFrame?: boolean; status?: string; pixels?: ReturnType<typeof trapped>; projection?: unknown; gpuInUpdate?: boolean; noReality?: boolean }): void
  /** The pixel arrays handed out, by tick. */
  arrays: Array<ReturnType<typeof trapped>>
}

async function engine(t: { mock: { method: (o: object, m: string, i: () => void) => unknown } }): Promise<Engine> {
  t.mock.method(console, 'log', () => {})
  t.mock.method(console, 'warn', () => {})
  modules = []
  const provider = new EighthWallProvider()
  await provider.start(canvas())
  const module = modules.find((m) => m.name === 'ci-scan-capture')!
  assert.ok(module.onUpdate && module.onProcessCpu)
  const arrays: Array<ReturnType<typeof trapped>> = []
  return {
    provider,
    arrays,
    play(i, over = {}) {
      const p = poseAt(i)
      const pixels = over.pixels ?? trapped(4, 8, i)
      arrays[i] = pixels
      const frameStartResult = { frameTime: (i * FRAME_MS) / 1000, ...(over.repeatFrame ? { repeatFrame: true } : {}) }
      module.onProcessCpu!({ processGpuResult: { camerapixelarray: pixels.array }, frameStartResult })
      const reality = over.noReality
        ? undefined
        : { position: p.position, rotation: p.rotation, trackingStatus: over.status ?? 'NORMAL', intrinsics: over.projection === undefined ? PROJECTION : over.projection }
      module.onUpdate!({ processCpuResult: reality ? { reality } : {}, ...(over.gpuInUpdate ? { processGpuResult: { camerapixelarray: pixels.array } } : {}), frameStartResult })
    },
  }
}

test('8th Wall: without a subscriber the provider never touches the pixel array of a tick, holds no reference to it, offers the feed nothing, and a capture still copies it', async (t) => {
  const e = await engine(t)
  // The feed is never even handed a tick, and nothing is held between the hooks of one tick: the cost of a feature nobody asked for is the one test of a flag.
  const inside = e.provider as unknown as { _cameraFeed: { offer: (tick: unknown) => void }; _tickPixelArray: unknown }
  inside._cameraFeed.offer = () => assert.fail('a tick was offered to the feed with nobody subscribed')
  for (let i = 0; i < 60; i++) {
    e.play(i)
    assert.equal(inside._tickPixelArray, null, `tick ${i}: the provider is holding a pixel array for a feed nobody is reading`)
  }
  for (const a of e.arrays) assert.deepEqual(a.reads, { pixels: 0, shape: 0 })
  // The capture path is the one that copies, exactly as it did: one frame, on the tick it is waiting for.
  const waiting = e.provider.captureFrame(1000)
  e.play(60)
  const raw = await waiting
  assert.equal(raw.width, 8)
  assert.equal(raw.height, 4)
  assert.equal(raw.pixels.length, 128)
  assert.ok(e.arrays[60]!.reads.pixels >= 1, 'the capture reads the array it copies')
  assert.deepEqual(e.provider.cameraFeedStats(), { ticks: 0, repeatFrames: 0, heldPose: 0, noPixels: 0, noProjection: 0, unpaired: 0, delivered: 0, copiedBytes: 0, copyMs: 0, callbackErrors: 0 })
})

test('8th Wall: a subscriber gets frames from the camera pixel array the provider already has, with the previous tick\'s pose by default, and the capture path is unchanged', async (t) => {
  // How many times the capture path looks at the array it copies, with nobody subscribed: the baseline the feed is measured against.
  const baseline = await engine(t)
  const baselineCapture = baseline.provider.captureFrame(1000)
  baseline.play(0)
  await baselineCapture
  const captureReads = baseline.arrays[0]!.reads.pixels
  assert.ok(captureReads >= 1)
  const e = await engine(t)
  const frames: CameraFrame[] = []
  const sub = e.provider.onCameraFrame!((f) => frames.push(f), { maxHz: 30 })
  assert.equal(sub.status, 'active')
  for (let i = 0; i < 6; i++) e.play(i)
  // Tick 0 has no pose a frame back; from tick 1 on every tick is delivered, paired with the tick before.
  assert.equal(frames.length, 5)
  frames.forEach((f, k) => {
    const i = k + 1
    assert.deepEqual(f.pose, poseAt(i - 1), `tick ${i}`)
    assert.ok(Math.abs(f.timestampMs - i * FRAME_MS) < 1e-6, `${f.timestampMs}`)
    assert.ok(Math.abs(f.poseTimestampMs - (i - 1) * FRAME_MS) < 1e-6)
    assert.equal(f.lagFrames, 1)
    assert.equal(f.width, 8)
    assert.equal(f.height, 4)
    assert.equal(f.channels, 4)
    assert.deepEqual(Array.from(f.pixels), Array.from(e.arrays[i]!.bytes), 'the pixels of the tick, copied')
    assert.deepEqual(f.projection, PROJECTION)
    assert.equal(f.epoch, 0)
    assert.equal(f.trackingStatus, 'NORMAL')
    assert.deepEqual(f.display, { canvasWidth: 360, canvasHeight: 640, fit: 'contain' })
  })
  // The pixels of a tick were looked at once, by the feed, and a capture asked for meanwhile still gets its own copy.
  assert.equal(e.arrays[3]!.reads.pixels, 1)
  const waiting = e.provider.captureFrame(1000)
  e.play(6)
  const raw = await waiting
  assert.equal(raw.pixels.length, 128)
  assert.equal(e.arrays[6]!.reads.pixels, captureReads + 1, 'the capture\'s own reads, and the feed\'s one')
  assert.equal(frames.length, 6)
  // The copy the feed made is independent of the capture's and of the engine's buffer.
  e.arrays[5]!.bytes[0] = 1
  assert.notEqual(frames[4]!.pixels[0], 1)
  sub.unsubscribe()
  const before = e.arrays[7]
  e.play(7)
  assert.deepEqual(e.arrays[7]!.reads, { pixels: 0, shape: 0 })
  assert.equal(before, undefined)
})

test('8th Wall: the lag is the subscriber\'s to set, and a pixel array that arrives with the update hook is taken from there', async (t) => {
  const e = await engine(t)
  const frames: CameraFrame[] = []
  e.provider.onCameraFrame!((f) => frames.push(f), { maxHz: 30, lagFrames: 0, recentPoses: 2 })
  for (let i = 0; i < 4; i++) e.play(i, { gpuInUpdate: i % 2 === 1 })
  assert.equal(frames.length, 4)
  frames.forEach((f, i) => {
    assert.deepEqual(f.pose, poseAt(i), 'lag 0 is the tick\'s own pose')
    assert.deepEqual(f.recentPoses, [poseAt(i), poseAt(i - 1)].slice(0, Math.min(2, i + 1)))
  })
  // On the ticks where the update hook was handed the array it was read from there (and on the others from the process-cpu hook), once.
  for (let i = 0; i < 4; i++) assert.equal(e.arrays[i]!.reads.pixels, 1, `tick ${i}`)
})

test('8th Wall: repeated frames, a held pose, a missing projection, and a tick whose reality was not read deliver nothing, and say so', async (t) => {
  const e = await engine(t)
  const frames: CameraFrame[] = []
  e.provider.onCameraFrame!((f) => frames.push(f), { maxHz: 30, lagFrames: 0 })
  e.play(0)
  e.play(1)
  assert.equal(frames.length, 2)
  // The camera had no new image: the pose is the last one's again.
  e.play(2, { repeatFrame: true })
  assert.deepEqual(e.arrays[2]!.reads, { pixels: 0, shape: 0 })
  assert.equal(frames.length, 2)
  assert.equal(e.provider.cameraFeedStats().repeatFrames, 1)
  // The update hook arrived with no reality: the pose is the one from the tick before, and is not offered again as a new one.
  e.play(3, { noReality: true })
  assert.equal(frames.length, 2)
  assert.equal(e.provider.cameraFeedStats().heldPose, 1)
  // NOT_AVAILABLE: the provider holds the old pose; it is not paired with this tick's pixels.
  e.play(4, { status: 'NOT_AVAILABLE' })
  assert.equal(frames.length, 2)
  assert.equal(e.provider.cameraFeedStats().heldPose, 2)
  // No projection in the reality, and one that is too short to be a matrix.
  e.play(5, { projection: null })
  e.play(6, { projection: [1, 2, 3] })
  assert.equal(frames.length, 2, 'a reality with no projection cannot give the pixels a camera')
  assert.equal(e.provider.cameraFeedStats().noProjection, 2)
  e.play(7)
  assert.equal(frames.length, 3)
})

test('8th Wall: stopping the provider clears what the feed kept, and a new session starts its pairing again', async (t) => {
  const e = await engine(t)
  const frames: CameraFrame[] = []
  e.provider.onCameraFrame!((f) => frames.push(f), { maxHz: 30, lagFrames: 1 })
  for (let i = 0; i < 4; i++) e.play(i)
  assert.equal(frames.length, 3)
  assert.equal(frames[2]!.frameIndex, 2)
  e.provider.stop()
  e.play(4)
  assert.equal(frames.length, 3, 'the first tick of a new session has no pose a frame back')
  e.play(5)
  assert.equal(frames.length, 4)
  assert.deepEqual(frames[3]!.pose, poseAt(4))
  assert.equal(frames[3]!.frameIndex, 0, 'a new session counts its frames from the start again')
})

test('8th Wall: a subscription is refused numbers that cannot mean anything, and leaves the provider idle', async (t) => {
  const e = await engine(t)
  assert.throws(() => e.provider.onCameraFrame!(() => {}, { maxHz: 0 }), /maxHz/)
  for (let i = 0; i < 5; i++) e.play(i)
  for (const a of e.arrays) assert.deepEqual(a.reads, { pixels: 0, shape: 0 })
})

// ===============================================================================================
// The WebXR provider's seam
// ===============================================================================================

test('WebXR: no camera frames, and it says why: the session never asks for camera access, and the companion stream is another image', () => {
  const provider = new WebXRProvider()
  let calls = 0
  const sub = provider.onCameraFrame!(() => {
    calls++
  }, { maxHz: 10 })
  assert.equal(sub.status, 'unsupported')
  assert.equal(sub.reason, 'webxr-no-camera-access')
  assert.doesNotThrow(() => sub.unsubscribe())
  assert.equal(calls, 0)
})
