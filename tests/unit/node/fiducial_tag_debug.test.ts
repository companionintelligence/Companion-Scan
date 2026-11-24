/**
 * The DX8 kit (`src/ar/fiducial/tag-debug.ts`): `?debug=tag` and `?debug=tagneg`.
 *
 * The kit is tested the way a phone would run it, minus the phone: the real frame feed, fed ticks of a tag that is drawn by the harness from a camera path;
 * the real worker handler behind a fake worker (structured clones, transfer); the real detector, session and lag fit. The lag fit is tested against
 * a world in which the pixels trail the pose by a number of frames the test chooses, and the fit has to find it: that is what DX8 will ask of a real
 * engine, and a fit that cannot find a lag the test put there would be no instrument.
 *
 * `?debug=tagneg` is held to its claim that no image leaves the phone and nothing is stored: every line it writes is read back and may carry only
 * counts, and the source of the kit and of every module a frame passes through is scanned for storage and network APIs.
 *
 * Run: node --experimental-strip-types --no-warnings --test tests/unit/node/fiducial_tag_debug.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import v8 from 'node:v8'
import vm from 'node:vm'
import { CSCAN6_V1 } from '../../../src/ar/fiducial/dictionary.ts'
import { FiducialDetector, type DetectorStats } from '../../../src/ar/fiducial/detector.ts'
import { CameraFrameFeed, type EngineTick } from '../../../src/ar/camera-frame-feed.ts'
import { createTagWorkerHandler } from '../../../src/ar/fiducial/tag-worker-core.ts'
import type { WorkerLike } from '../../../src/ar/fiducial/tag-worker-client.ts'
import {
  LAG_FIT_LAGS,
  LAG_FIT_MIN_FRAMES,
  TAGCAM_BOUNDS,
  TAGCAM_CHANGE_MIN_MS,
  TAGCAM_KEYS,
  TAGCAM_LINE_PERIOD_MS,
  TAGCAM_LINE_PREFIX,
  TAGNEG_BOUNDS,
  TAGNEG_KEYS,
  TAGNEG_LINE_PERIOD_MS,
  TAGNEG_LINE_PREFIX,
  TAG_BOUNDS,
  TAG_KEYS,
  TAG_LINE_PERIOD_MS,
  TAG_LINE_PREFIX,
  TAG_WORD_MAX,
  TagNegativeCounter,
  fitPixelLag,
  formatTagCamLine,
  formatTagLine,
  formatTagNegLine,
  installTagDebug,
  tagDebugModes,
  tagDebugParams,
  type LagFitSample,
  type TagCamRecord,
  type TagNegRecord,
  type TagRecord,
} from '../../../src/ar/fiducial/tag-debug.ts'
import { DEFAULT_PIXEL_LAG_FRAMES } from '../../../src/ar/fiducial/pose-history.ts'
import { DEFAULT_TAG_MAX_HZ } from '../../../src/ar/fiducial/tag-capture.ts'
import { hasDebugFlag, parseDebugFlags } from '../../../src/shared/debug-flags.ts'
import type { Quad } from '../../../src/ar/fiducial/types.ts'
import type { Pose } from '../../../src/ar/provider.ts'
import { INTRINSICS_640, lookAtPose, mat3Apply, mat3Mul, mat3Transpose, matrixFromQuat, noiseOnlyFrame, projectSessionTag, renderTag, tagPose, textureFrame, type SessionPoseLike } from '../../support/fiducial-render.ts'
import { fixedTag } from '../../support/fiducial-scene.ts'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const K = INTRINSICS_640
const FRAME_MS = 1000 / 30
const FLIP_YZ = [1, 0, 0, 0, -1, 0, 0, 0, -1]
const PROJECTION = (() => {
  const p = new Array<number>(16).fill(0)
  p[0] = (2 * K.fx) / K.width
  p[5] = (2 * K.fy) / K.height
  p[8] = 1 - (2 * K.cx) / K.width
  p[9] = (2 * K.cy) / K.height - 1
  p[10] = -1.002
  p[11] = -1
  p[14] = -0.2002
  return p
})()

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

function cvPoseOf(tag: SessionPoseLike, cam: SessionPoseLike) {
  const rt = matrixFromQuat(tag.rotation)
  const rcT = mat3Transpose(matrixFromQuat(cam.rotation))
  const d = { x: tag.position.x - cam.position.x, y: tag.position.y - cam.position.y, z: tag.position.z - cam.position.z }
  return { rotation: mat3Mul(FLIP_YZ, mat3Mul(rcT, rt)), translation: mat3Apply(mat3Mul(FLIP_YZ, rcT), d) }
}

function fakeWorker(): WorkerLike {
  const w: WorkerLike & { handle: (m: never) => void; seen: unknown[] } = {
    onmessage: null,
    onerror: null,
    seen: [],
    handle: createTagWorkerHandler((m) => queueMicrotask(() => w.onmessage?.({ data: structuredClone(m) }))) as (m: never) => void,
    postMessage(message: unknown, transfer?: Transferable[]) {
      const clone = structuredClone(message, transfer ? { transfer } : undefined)
      w.seen.push(clone)
      queueMicrotask(() => w.handle(clone as never))
    },
    terminate() {},
  }
  return w
}

// ===============================================================================================
// Arming and parameters
// ===============================================================================================

test('the kit is armed by two tokens of the debug list and nothing else: tag, tagneg, either order, either case, not a prefix', () => {
  assert.deepEqual(tagDebugModes('?debug=tag'), { tag: true, tagneg: false })
  assert.deepEqual(tagDebugModes('?debug=tagneg'), { tag: false, tagneg: true })
  assert.deepEqual(tagDebugModes('?debug=remote,probe,TagNeg,tag'), { tag: true, tagneg: true })
  assert.deepEqual(tagDebugModes('?debug= tag , remote'), { tag: true, tagneg: false })
  for (const search of ['', '?debug=', '?debug=tags', '?debug=tagging', '?debug=remote', '?world=x&tag=1', '?debug=probe']) assert.deepEqual(tagDebugModes(search), { tag: false, tagneg: false }, search)
  // The shared flag list knows both, for the hook in main.ts.
  assert.equal(hasDebugFlag('tag', '?debug=remote,tag'), true)
  assert.equal(hasDebugFlag('tagneg', '?debug=tagneg'), true)
  assert.equal(hasDebugFlag('tag', '?debug=tagneg'), false, 'one does not arm the other')
  assert.equal(hasDebugFlag('tagneg', '?debug=tag'), false)
  assert.deepEqual(parseDebugFlags('?debug=tag,tagneg'), ['tag', 'tagneg'])
})

test('the page parameters have defaults, are checked, and a value that is present and wrong is an error, never a default', () => {
  assert.deepEqual(tagDebugParams(''), { printedSizeMm: 200, family: 'cscan-6x6-v1', lagFrames: DEFAULT_PIXEL_LAG_FRAMES, maxHz: DEFAULT_TAG_MAX_HZ, expectedTagId: null, mountHeightM: null })
  assert.deepEqual(tagDebugParams('?tagsize=160&tagfamily=cscan-5x5-v1&taglag=2&tagrate=10&tagid=7&tagheight=1.2'), { printedSizeMm: 160, family: 'cscan-5x5-v1', lagFrames: 2, maxHz: 10, expectedTagId: 7, mountHeightM: 1.2 })
  assert.deepEqual(tagDebugParams('?tagheight=0&taglag=0&tagrate=1'), { printedSizeMm: 200, family: 'cscan-6x6-v1', lagFrames: 0, maxHz: 1, expectedTagId: null, mountHeightM: 0 })
  assert.equal((tagDebugParams('?tagrate=30') as { maxHz: number }).maxHz, 30)
  for (const [search, error] of [
    ['?tagsize=39', /tagsize/], ['?tagsize=601', /tagsize/], ['?tagsize=abc', /tagsize/],
    ['?tagfamily=tag36h11', /not a registered family/],
    ['?taglag=-1', /taglag/], ['?taglag=9', /taglag/], ['?taglag=1.5', /taglag/], ['?taglag=x', /taglag/],
    ['?tagrate=0.9', /tagrate/], ['?tagrate=31', /tagrate/], ['?tagrate=fast', /tagrate/],
    ['?tagid=-1', /tagid/], ['?tagid=1.5', /tagid/], ['?tagid=128', /not an id of cscan-6x6-v1/], ['?tagfamily=cscan-5x5-v1&tagid=32', /not an id of cscan-5x5-v1/],
    ['?tagheight=-0.1', /tagheight/], ['?tagheight=4.1', /tagheight/], ['?tagheight=x', /tagheight/],
  ] as const) {
    const r = tagDebugParams(search)
    assert.ok('error' in r, search)
    assert.match((r as { error: string }).error, error, search)
  }
})

test('the page reaches the kit through one dynamic import behind the two flags and nowhere else: nothing of it is loaded, and none of it runs, unless the page asks', () => {
  const lines = readFileSync(join(ROOT, 'src/main.ts'), 'utf8').split('\n')
  const at = lines.map((l, i) => [l, i] as const).filter(([l]) => l.includes('tag-debug') && !l.trim().startsWith('//'))
  assert.equal(at.length, 1, 'one line of code names the kit')
  const [line, i] = at[0]!
  assert.match(line, /import\('\.\/ar\/fiducial\/tag-debug'\)/, 'a dynamic import, which Vite splits into a chunk of its own')
  // The runtime is named the way the probe line names it, so a native session (and a hand-over from one) is not called `webxr`.
  assert.match(line, /installTagDebug\(\{ provider, runtime: probeRuntimeLabel\(provider, use8thWall\) \}\)/)
  const guard = lines[i! - 1]!
  assert.match(guard, /^\s*if \(hasDebugFlag\('tag'\) \|\| hasDebugFlag\('tagneg'\)\) \{$/)
  // Nothing else in the app imports it statically (that would put it in the main bundle).
  const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : /\.ts$/.test(e.name) ? [join(dir, e.name)] : []))
  const importers = walk(join(ROOT, 'src')).filter((f) => /^\s*import\b[^\n]*from\s+'[^']*tag-debug(\.ts)?'/m.test(readFileSync(f, 'utf8')))
  assert.deepEqual(importers, [], 'a static import of the kit')
})

test('not armed: nothing is added to the page, and the provider is not even asked for frames', () => {
  let asked = 0
  const provider = { onCameraFrame: () => (asked++, { status: 'active' as const, reason: null, unsubscribe() {} }) }
  assert.equal(installTagDebug({ provider, runtime: '8thwall', emit: () => assert.fail('wrote a line') }, '?debug=remote,probe'), null)
  assert.equal(asked, 0)
  // A parameter that cannot be used says so in a line and arms nothing.
  const lines: string[] = []
  assert.equal(installTagDebug({ provider, runtime: '8thwall', emit: (l) => lines.push(l) }, '?debug=tag&tagsize=5'), null)
  assert.equal(asked, 0)
  assert.equal(lines.length, 1)
  assert.match(lines[0]!, /^\[tag\] \{"v":1,"error":"tagsize must be from 40 to 600/)
})

test('the rate asked of the feed is the page\'s tagrate, the default without one, and the lag and the recent poses the lag fit needs are asked for too', () => {
  const asked: Array<{ maxHz?: number; lagFrames?: number; recentPoses?: number }> = []
  const provider = { onCameraFrame: (_cb: unknown, o: { maxHz?: number; lagFrames?: number; recentPoses?: number }) => (asked.push(o), { status: 'active' as const, reason: null, unsubscribe() {} }) }
  const worker = { createWorker: () => fakeWorker() }
  const stops = [
    installTagDebug({ provider: provider as never, runtime: '8thwall', emit: () => {}, worker }, '?debug=tag'),
    installTagDebug({ provider: provider as never, runtime: '8thwall', emit: () => {}, worker }, '?debug=tag&tagrate=10&taglag=2'),
  ]
  assert.deepEqual(asked, [
    { maxHz: DEFAULT_TAG_MAX_HZ, lagFrames: DEFAULT_PIXEL_LAG_FRAMES, recentPoses: LAG_FIT_LAGS.length },
    { maxHz: 10, lagFrames: 2, recentPoses: LAG_FIT_LAGS.length },
  ])
  for (const stop of stops) stop?.()
})

// ===============================================================================================
// The lag fit
// ===============================================================================================

/** The swing of the camera: 40 degrees off the tag's normal, 12 degrees either side, a period of 2 seconds (38 degrees a second at its fastest), 1.8 m (session units: times `k`) from the tag. */
const SWING_AMPLITUDE_DEG = 12
const SWING_PERIOD_S = 2
function swing(tag: SessionPoseLike, t: number, amplitudeDeg: number, k = 1): SessionPoseLike {
  const a = ((40 + amplitudeDeg * Math.sin((2 * Math.PI * t) / SWING_PERIOD_S)) * Math.PI) / 180
  return lookAtPose({ x: tag.position.x + Math.sin(a) * 1.8 * k, y: tag.position.y - 0.1 * k, z: tag.position.z + Math.cos(a) * 1.8 * k }, tag.position)
}

/** A tag fixed in the session and a camera swinging past it and back; sample i's corners are drawn from the camera `trueLag` ticks before its newest pose. */
function lagSamples(trueLag: number, over: { frames?: number; scale?: number; still?: boolean } = {}): { samples: LagFitSample[]; tagSizeM: number } {
  const k = over.scale ?? 1
  const tag = fixedTag(0, 0, { x: 0.3 * k, y: 1.3 * k, z: -3 * k })
  const sizeM = 0.2
  const n = over.frames ?? 90
  // The camera swings past the tag and back (a sweep at a steady speed would be unobservable: a lag only shifts such a path in time).
  const camAt = (t: number): SessionPoseLike => swing(tag, t, over.still ? 0 : SWING_AMPLITUDE_DEG, k)
  const samples: LagFitSample[] = []
  for (let i = 3; i < n + 3; i++) {
    const poses = [0, 1, 2].map((l) => camAt((i - l) * (FRAME_MS / 1000)) as Pose)
    const drawnFrom = camAt((i - trueLag) * (FRAME_MS / 1000))
    samples.push({ corners: projectSessionTag(tag, drawnFrom, K, sizeM * k) as unknown as Quad, intrinsics: K, poses })
  }
  return { samples, tagSizeM: sizeM }
}

test('the lag fit finds the lag the world was built with: 0, 1 and 2 frames, each by the smallest reprojection error, and the wrong lags are visibly worse', () => {
  for (const trueLag of [0, 1, 2]) {
    const { samples, tagSizeM } = lagSamples(trueLag)
    const fit = fitPixelLag(samples, tagSizeM, { sessionUnitsPerMetre: 1 })
    assert.equal(fit.best, trueLag, `built with lag ${trueLag}`)
    assert.ok(fit.turnDeg > 15, `the camera turned ${fit.turnDeg} degrees`)
    const errors = fit.entries.map((e) => e.reprojectionRmsPx!)
    assert.ok(errors[trueLag]! < 0.01, `error at the true lag ${errors[trueLag]}`)
    for (const l of [0, 1, 2]) if (l !== trueLag) assert.ok(errors[l]! > 20 * Math.max(errors[trueLag]!, 0.01), `lag ${l} is not worse enough: ${errors.join(', ')}`)
    // The lag is invisible at constant speed: a sweep along a steady arc is the same path shifted in time, and every lag explains it alike.
    // (Shown here so that the instruction to swing the phone past the tag and back is a fact and not a habit.)
    // The tag's orientation is steadier at the right lag too. (Its position is not a witness here: the camera orbits the tag, so a lag only turns the
    // camera about the tag, which moves the tag's estimated orientation and leaves its position where it is.)
    const spreads = fit.entries.map((e) => e.rotationSpreadDeg!)
    for (const l of [0, 1, 2]) if (l !== trueLag) assert.ok(spreads[l]! > spreads[trueLag]!, `orientation spread at lag ${l}: ${spreads.join(', ')}`)
    assert.deepEqual(fit.entries.map((e) => e.lag), [0, 1, 2])
    assert.ok(fit.entries.every((e) => e.frames === 90))
  }
})

test('the fit works in a session whose unit is not the metre, and says when it cannot tell: a camera that does not turn fits every lag alike', () => {
  const scaled = lagSamples(1, { scale: 1.7 })
  assert.equal(fitPixelLag(scaled.samples, scaled.tagSizeM, { sessionUnitsPerMetre: 1.7 }).best, 1)
  // Left to work the unit out from the frames itself, it gets there too.
  assert.equal(fitPixelLag(scaled.samples, scaled.tagSizeM).best, 1)
  const still = lagSamples(1, { still: true })
  const fit = fitPixelLag(still.samples, still.tagSizeM, { sessionUnitsPerMetre: 1 })
  assert.ok(fit.turnDeg < 0.01, `${fit.turnDeg}`)
  const e = fit.entries.map((x) => x.reprojectionRmsPx!)
  assert.ok(Math.max(...e) - Math.min(...e) < 1e-6, `a camera that does not move cannot tell the lags apart: ${e.join(', ')}`)
  // Samples with fewer poses than a lag needs are not used for it; with none left the entry is empty, never invented.
  const short = lagSamples(0).samples.map((s) => ({ ...s, poses: s.poses.slice(0, 1) }))
  const f2 = fitPixelLag(short, 0.2, { sessionUnitsPerMetre: 1 })
  assert.equal(f2.entries[0]!.frames, 90)
  assert.equal(f2.entries[1]!.frames, 0)
  assert.equal(f2.entries[1]!.reprojectionRmsPx, null)
  assert.equal(f2.best, 0)
  assert.equal(fitPixelLag([], 0.2).best, null)
  assert.deepEqual(LAG_FIT_LAGS, [0, 1, 2])
})

// ===============================================================================================
// The negative-corpus counter
// ===============================================================================================

function stats(over: Omit<Partial<DetectorStats>, 'rejected'> & { rejected?: Partial<DetectorStats['rejected']> } = {}): DetectorStats {
  return { candidates: 0, groups: 0, prechecked: 0, decodeAttempts: 0, capped: false, detections: 0, ...over, rejected: { offFrame: 0, contrast: 0, border: 0, quiet: 0, match: 0, ids: 0, ...(over.rejected ?? {}) } }
}

test('the counter adds up what each frame\'s detector said, the quads that reached the dictionary are the attempts less those refused earlier, and it keeps no frame', () => {
  const c = new TagNegativeCounter()
  assert.deepEqual(c.snapshot(), { frames: 0, candidates: 0, groups: 0, decodeAttempts: 0, reachedMatcher: 0, detections: 0, cappedFrames: 0, maxCandidates: 0, rejected: { offFrame: 0, contrast: 0, border: 0, quiet: 0, match: 0, ids: 0 } })
  c.add(stats({ candidates: 10, groups: 8, decodeAttempts: 8, rejected: { offFrame: 1, contrast: 2, border: 3, quiet: 1, match: 1 } }))
  c.add(stats({ candidates: 40, groups: 30, decodeAttempts: 16, capped: true, detections: 1, rejected: { contrast: 4, border: 4, quiet: 2, match: 5, ids: 1 } }))
  c.add(stats())
  const s = c.snapshot()
  assert.equal(s.frames, 3)
  assert.equal(s.candidates, 50)
  assert.equal(s.groups, 38)
  assert.equal(s.decodeAttempts, 24)
  assert.equal(s.reachedMatcher, (8 - 1 - 2 - 3 - 1) + (16 - 0 - 4 - 4 - 2), 'attempts less offFrame, contrast, border and quiet')
  assert.equal(s.detections, 1)
  assert.equal(s.cappedFrames, 1)
  assert.equal(s.maxCandidates, 40)
  assert.deepEqual(s.rejected, { offFrame: 1, contrast: 6, border: 7, quiet: 3, match: 6, ids: 1 })
  // A snapshot is a copy; reset starts over; a stats object with more refusals than attempts cannot make the count negative.
  s.rejected.match = 999
  assert.equal(c.snapshot().rejected.match, 6)
  c.add(stats({ decodeAttempts: 1, rejected: { contrast: 5 } }))
  assert.equal(c.snapshot().reachedMatcher, s.reachedMatcher)
  c.reset()
  assert.equal(c.snapshot().frames, 0)
})

// ===============================================================================================
// The kit, running
// ===============================================================================================

interface Sim {
  lines: string[]
  tagLines: TagRecord[]
  negLines: TagNegRecord[]
  camLines: TagCamRecord[]
  stop: () => void
  workers: Array<{ seen: unknown[] }>
}

/** The kit on the real feed, driven by ticks whose pixels trail the pose by `trueLag` ticks (drawn from the camera that many ticks back). */
async function runTag(search: string, trueLag: number, over: { ticks?: number; startMs?: number; scale?: number; still?: boolean; printedM?: number; amplitudeDeg?: number } = {}): Promise<Sim> {
  const lines: string[] = []
  const workers: Array<{ seen: unknown[] }> = []
  const feed = new CameraFrameFeed()
  // `scale` session units to the metre: the whole world (the tag's place and the camera's path) is drawn in them, and the runtime, which does not say it is metric, is asked about it.
  const k = over.scale ?? 1
  const provider = { onCameraFrame: (cb: Parameters<CameraFrameFeed['subscribe']>[0], o: Parameters<CameraFrameFeed['subscribe']>[1]) => feed.subscribe(cb, o), scaleKind: () => (k === 1 ? 'metric' : 'arbitrary') as 'metric' | 'arbitrary', cameraFeedStats: () => feed.stats }
  const stop = installTagDebug({ provider, runtime: '8thwall', emit: (l) => lines.push(l), worker: { createWorker: () => { const w = fakeWorker() as WorkerLike & { seen: unknown[] }; workers.push(w); return w } } }, search)!
  assert.ok(stop, 'armed')
  const tag = fixedTag(0, 0, { x: 0.3 * k, y: 1.3 * k, z: -3 * k })
  const ticks = over.ticks ?? 100
  const camAt = (i: number): SessionPoseLike => swing(tag, (Math.max(0, i) * FRAME_MS) / 1000, over.still ? 0 : (over.amplitudeDeg ?? SWING_AMPLITUDE_DEG), k)
  for (let i = 0; i < ticks; i++) {
    const rel = cvPoseOf(tag, camAt(i - trueLag))
    const pose = { rotation: rel.rotation, translation: { x: rel.translation.x / k, y: rel.translation.y / k, z: rel.translation.z / k } }
    const image = renderTag({ dictionary: CSCAN6_V1, id: 6, sizeM: over.printedM ?? 0.2, pose, intrinsics: K, noiseSigma: 1, blurSigma: 0.4, seed: i + 1, supersample: 2, channels: 4 })
    const t: EngineTick = {
      timestampMs: (over.startMs ?? 0) + i * FRAME_MS,
      repeatFrame: false,
      pose: camAt(i) as Pose,
      poseCurrent: true,
      epoch: 0,
      trackingStatus: 'NORMAL',
      projection: PROJECTION,
      pixelArray: { pixels: image.data, rows: 480, cols: 640, rowBytes: 2560 },
      display: { canvasWidth: 640, canvasHeight: 480, fit: 'contain' },
    }
    feed.offer(t)
    await settle()
  }
  const parsed = lines.filter((l) => l.startsWith(TAG_LINE_PREFIX)).map((l) => JSON.parse(l.slice(TAG_LINE_PREFIX.length)) as TagRecord)
  const neg = lines.filter((l) => l.startsWith(TAGNEG_LINE_PREFIX)).map((l) => JSON.parse(l.slice(TAGNEG_LINE_PREFIX.length)) as TagNegRecord)
  const cam = lines.filter((l) => l.startsWith(TAGCAM_LINE_PREFIX)).map((l) => JSON.parse(l.slice(TAGCAM_LINE_PREFIX.length)) as TagCamRecord)
  return { lines, tagLines: parsed, negLines: neg, camLines: cam, stop, workers }
}

test('?debug=tag writes one line a second with exactly the documented keys, and finds the lag the world was built with, 0, 1 or 2', async () => {
  for (const trueLag of [0, 1, 2]) {
    const sim = await runTag('?debug=tag', trueLag, { ticks: 130 })
    assert.ok(sim.tagLines.length >= 3, `${sim.tagLines.length} lines`)
    for (const l of sim.tagLines) assert.deepEqual(Object.keys(l), [...TAG_KEYS], 'every key, in the order the document lists them')
    sim.tagLines.forEach((l, i) => assert.equal(l.n, i + 1, 'lines are numbered, so a missing one is a gap'))
    const last = sim.tagLines[sim.tagLines.length - 1]!
    assert.equal(last.lagBest, trueLag, `built with lag ${trueLag}: ${last.lagRms0} ${last.lagRms1} ${last.lagRms2}`)
    assert.ok(last.lagTurn! > 10, `turn ${last.lagTurn}`)
    const rms = [last.lagRms0!, last.lagRms1!, last.lagRms2!]
    assert.ok(rms[trueLag]! < 0.6, `error at the true lag ${rms[trueLag]}`)
    for (const l of [0, 1, 2]) if (l !== trueLag) assert.ok(rms[l]! > rms[trueLag]! + 0.05, `lag ${l} not worse: ${rms.join(', ')}`)
    sim.stop()
  }
})

test('the lines carry what DX8 asked for: stage times, the tag\'s size and ambiguity, residuals, the fused spread, and in [tagcam] the projection entries, the pixel array, the canvas and the fit', async () => {
  const sim = await runTag('?debug=tag&tagsize=200', 1, { ticks: 100 })
  const l = sim.tagLines[sim.tagLines.length - 1]!
  assert.equal(l.v, 1)
  assert.equal(l.rt, '8thwall')
  assert.equal(l.mode, 'worker')
  assert.equal(l.fb, null)
  assert.equal(l.un, null)
  assert.ok(l.fr > 0 && l.hit > 0 && l.hit <= l.fr)
  assert.equal(l.id, 6)
  assert.ok(l.side! > 40 && l.side! < 120, `side ${l.side}`)
  assert.ok(l.amb! > 0 && l.vang! > 10 && l.rng! > 1 && l.rng! < 3, `${l.amb} ${l.vang} ${l.rng}`)
  assert.ok(l.rms! >= 0 && l.rms! < 1)
  assert.ok(l.spd! > 10 && l.spd! < 40, `speed ${l.spd}`)
  assert.ok(l.roi !== null && l.roi >= 0 && l.roi <= 1)
  for (const key of ['tCopy', 'tRound', 'tDet', 'tWorker', 'tPose', 'tLuma', 'tPyr', 'tQuad', 'tRefine', 'tDecode'] as const) assert.ok(l[key] !== null && l[key]! >= 0, `${key}: ${l[key]}`)
  assert.ok(l.tDet! > 0)
  assert.ok(l.fuseN! >= 3 && l.fuseSpreadM! >= 0 && l.fuseRotDeg! >= 0 && l.fuseHeadDeg! >= 0 && l.fuseRms! >= 0)
  // The heading is one angle of the orientation and is its own column: a number of the same order as the whole's, and not the same number (in one dimension the robust scale is 1.4826 times the
  // median deviation, and in three it is 1.126, so a heading that carried all the scatter would read a third higher).
  assert.ok(l.fuseHeadDeg! > 0.5 * l.fuseRotDeg! && l.fuseHeadDeg! < 2 * l.fuseRotDeg!, `${l.fuseHeadDeg} against ${l.fuseRotDeg}`)
  assert.ok(Math.abs(l.fuseHeadDeg! - l.fuseRotDeg!) > 0.02, `two columns that say the same thing: ${l.fuseHeadDeg} and ${l.fuseRotDeg}`)
  assert.equal(l.lagBest, 1)
  // The projection entries and the sizes, as the feed handed them over, in the camera line: written when the first frame was read, and not again until something changes or half a minute passes.
  assert.equal(sim.camLines.length, 1, 'one camera line for a run of a few seconds')
  const c = sim.camLines[0]!
  assert.deepEqual(Object.keys(c), [...TAGCAM_KEYS])
  assert.equal(c.v, 1)
  assert.equal(c.n, 1)
  assert.equal(c.rt, '8thwall')
  assert.equal(c.un, null)
  assert.equal(c.p0, Math.round(PROJECTION[0]! * 1e5) / 1e5)
  assert.equal(c.p5, Math.round(PROJECTION[5]! * 1e5) / 1e5)
  assert.equal(c.p8, 0)
  assert.equal(c.p9, 0)
  assert.equal(c.cols, 640)
  assert.equal(c.rows, 480)
  assert.equal(c.cw, 640)
  assert.equal(c.ch, 480)
  assert.equal(c.fit, 'contain')
  assert.ok(['searching', 'collecting', 'done'].includes(l.ph!), `${l.ph}`)
  assert.ok(l.pr !== null && l.pr >= 0 && l.pr <= 1)
  sim.stop()
})

test('upm is the number of session units to the metre that the printed size implies, in a session whose unit is a metre and in one whose unit is not, and null while the camera has not travelled enough', async () => {
  const metric = await runTag('?debug=tag&tagsize=200', 1, { ticks: 100 })
  const m = metric.tagLines[metric.tagLines.length - 1]!
  assert.ok(Math.abs(m.upm! - 1) < 0.03, `a metric session: ${m.upm} units to the metre`)
  assert.ok(m.upmBase! >= 0.3 && m.upmBase! < 1, `the camera travel the unit rests on: ${m.upmBase} m`)
  metric.stop()
  for (const k of [0.5, 1.7]) {
    const sim = await runTag('?debug=tag&tagsize=200', 1, { ticks: 100, scale: k })
    const l = sim.tagLines[sim.tagLines.length - 1]!
    assert.ok(Math.abs(l.upm! - k) < 0.03 * k, `a session of ${k} units to the metre: ${l.upm}`)
    assert.ok(l.upmBase! >= 0.3, `${l.upmBase}`)
    assert.equal(l.lagBest, 1, 'the lag fit is the same in a session of another unit')
    sim.stop()
  }
  // The printed size is what makes it a measurement. A 200 mm tag the kit is told is 190 reads as a nearer, smaller thing: units 5 % more to the metre. A print that shrank to
  // 190 mm and is told 200 reads as farther: the line gives 5 % fewer, so the ratio of its `upm` to an exact print's is the print's own scale (what Procedure 8, Part F, reads).
  const mis = await runTag('?debug=tag&tagsize=190', 1, { ticks: 100 })
  const w = mis.tagLines[mis.tagLines.length - 1]!
  assert.ok(Math.abs(w.upm! - 1 / 0.95) < 0.04, `a 200 mm tag read as 190 mm: ${w.upm}`)
  mis.stop()
  for (const [printed, expected] of [[0.19, 0.95], [0.21, 1.05]] as const) {
    const small = await runTag('?debug=tag&tagsize=200', 1, { ticks: 100, printedM: printed })
    const v = small.tagLines[small.tagLines.length - 1]!
    assert.ok(Math.abs(v.upm! / m.upm! - expected) < 0.02, `a ${printed * 1000} mm print read as 200 mm: upm ${v.upm} against ${m.upm} for the exact one`)
    small.stop()
  }
  // A camera that stays where it is cannot say: a near small thing and a far big one look alike.
  const still = await runTag('?debug=tag&tagsize=200', 1, { ticks: 100, still: true })
  const s = still.tagLines[still.tagLines.length - 1]!
  assert.equal(s.upm, null)
  assert.equal(s.upmBase, null)
  assert.ok(s.hit > 0, 'the tag was read all the same')
  still.stop()
})

// ===============================================================================================
// A line crosses the relay whole, or not at all
// ===============================================================================================

/** The relay's own cut, read from its source as the probe line's test does: a message longer than this is cut, and a cut line is invalid JSON. */
const RELAY_CAP = Number(readFileSync(join(ROOT, 'src/debug/remote-log.ts'), 'utf8').match(/const MAX_MSG_CHARS = (\d+)/)![1])

type Bound = { decimals: number; max: number; signed?: boolean }

/** The number of the column's range that prints longest: all nines at the column's decimals, negative where the column may be. */
function longestNumber(b: Bound): number {
  const step = 10 ** -b.decimals
  const candidates = [b.max, b.max - step, ...(b.signed ? [-b.max, -(b.max - step)] : [])].map((v) => Number((Math.round(v / step) * step).toFixed(b.decimals)))
  return candidates.sort((x, y) => JSON.stringify(y).length - JSON.stringify(x).length)[0]!
}

/** A record with every column at the longest value its bound allows. */
function longestRecord(keys: readonly string[], bounds: Readonly<Record<string, Bound>>): Record<string, unknown> {
  const record: Record<string, unknown> = {}
  for (const key of keys) {
    if (bounds[key]) record[key] = longestNumber(bounds[key]!)
    // `un` says no frame is read at all, and then every other column is empty: it is never beside a full line.
    else if (key === 'un') record[key] = null
    else if (TAG_WORD_MAX[key] !== undefined) record[key] = 'x'.repeat(TAG_WORD_MAX[key]!)
    else record[key] = null
  }
  return record
}

test('every line is bounded by construction, so the relay never cuts one: the longest line the bounds allow, and lines built from absurd numbers and words, are measured against the relay\'s own cap', () => {
  assert.ok(RELAY_CAP >= 500 && RELAY_CAP <= 1000, `the relay's cap, read from its source: ${RELAY_CAP}`)
  const worst = formatTagLine(longestRecord(TAG_KEYS, TAG_BOUNDS) as unknown as TagRecord)
  const margin = RELAY_CAP - worst.length
  assert.ok(margin >= 20, `the longest [tag] line the bounds allow is ${worst.length} characters of the relay's ${RELAY_CAP}: ${margin} to spare`)
  // The candidates are inside their bounds: nothing was nulled to make the line fit, so this is the longest line, not a shorter one in its place.
  const body = JSON.parse(worst.slice(TAG_LINE_PREFIX.length)) as Record<string, unknown>
  for (const key of TAG_KEYS) if (key !== 'un') assert.ok(body[key] !== null, `${key} survived its own bound`)
  // The bounds are the ones the comment on them gives: a round trip or a detector over ten seconds is not a measurement, nor is a frame side over 999 px, nor a count over 99 999 (a longer run
  // than that is not on one page load). A wider bound is a longer line, and the test above is what says how much room there is.
  for (const key of ['tRound', 'tDet', 'tWorker']) assert.equal(TAG_BOUNDS[key]!.max, 9999.9, key)
  assert.equal(TAG_BOUNDS['side']!.max, 999.9)
  assert.equal(TAG_BOUNDS['n']!.max, 99_999)
  const camWorst = formatTagCamLine(longestRecord(TAGCAM_KEYS, TAGCAM_BOUNDS) as unknown as TagCamRecord)
  const negWorst = formatTagNegLine(longestRecord(TAGNEG_KEYS, TAGNEG_BOUNDS) as unknown as TagNegRecord)
  assert.ok(camWorst.length <= RELAY_CAP - 20 && negWorst.length <= RELAY_CAP - 20, `[tagcam] ${camWorst.length}, [tagneg] ${negWorst.length}`)
  for (const [line, prefix] of [[worst, TAG_LINE_PREFIX], [camWorst, TAGCAM_LINE_PREFIX], [negWorst, TAGNEG_LINE_PREFIX]] as const) JSON.parse(line.slice(prefix.length))
  // A line that says no frame is read is short.
  const blank = formatTagLine({ ...(Object.fromEntries(TAG_KEYS.map((k) => [k, null])) as unknown as TagRecord), v: 1, n: 99_999, rt: '8thwall', fr: 0, hit: 0, drop: 0, un: 'webxr-no-camera-access' })
  assert.ok(blank.length < worst.length, `${blank.length}`)
  assert.ok(JSON.parse(blank.slice(TAG_LINE_PREFIX.length)).un === 'webxr-no-camera-access')
  // Absurd runtime numbers and words: a number beyond its column is null, never clipped to look like a measurement, and a word is cut at its column's length.
  const absurd = Object.fromEntries(TAG_KEYS.map((k) => [k, TAG_BOUNDS[k] ? (k === 'v' ? 1 : 1e12) : TAG_WORD_MAX[k] !== undefined ? 'w'.repeat(500) : null]))
  const cut = formatTagLine(absurd as unknown as TagRecord)
  assert.ok(cut.length <= worst.length, `${cut.length} against ${worst.length}`)
  const parsed = JSON.parse(cut.slice(TAG_LINE_PREFIX.length)) as Record<string, unknown>
  for (const key of TAG_KEYS) {
    if (key === 'v') assert.equal(parsed[key], 1)
    else if (TAG_BOUNDS[key]) assert.equal(parsed[key], null, `${key}: 1e12 is not a measurement`)
    else if (TAG_WORD_MAX[key] !== undefined) assert.equal((parsed[key] as string).length, TAG_WORD_MAX[key], `${key} is cut`)
  }
  for (const bad of [NaN, Infinity, -Infinity, -5]) {
    const line = JSON.parse(formatTagLine({ ...(absurd as unknown as TagRecord), side: bad, rng: bad, tRound: bad }).slice(TAG_LINE_PREFIX.length)) as Record<string, unknown>
    assert.equal(line['side'], null, `${bad} in a size`)
    assert.equal(line['tRound'], null, `${bad} in a time`)
  }
  // A signed column keeps its sign (an offset of the principal point is either side of zero), and a column's own decimals are kept and no more.
  const cam = JSON.parse(formatTagCamLine({ v: 1, n: 1, rt: '8thwall', un: null, p0: 1.757812345, p5: 2.34375, p8: -0.0123456, p9: 0.000004, cols: 640, rows: 480, cw: 640, ch: 480, fit: 'contain', held: 2, unp: 3 }).slice(TAGCAM_LINE_PREFIX.length)) as TagCamRecord
  assert.deepEqual([cam.p0, cam.p8, cam.p9], [1.75781, -0.01235, 0])
  assert.equal(JSON.parse(formatTagLine({ ...(absurd as unknown as TagRecord), side: 61.34999, rng: 2.4106, hit: 8 }).slice(TAG_LINE_PREFIX.length)).side, 61.3)
})

test('every word a column can hold fits its column: nothing the kit writes is ever cut', () => {
  const sessionSource = readFileSync(join(ROOT, 'src/ar/fiducial/tag-session.ts'), 'utf8')
  const hints = [...sessionSource.match(/export type TagHint =[\s\S]*?\n\n/)![0].matchAll(/code: '([a-z-]+)'/g)].map((m) => m[1]!)
  const union = (file: string, name: string): string[] => {
    const text = readFileSync(join(ROOT, file), 'utf8')
    const at = text.indexOf(`type ${name} =`)
    const lines = text.slice(at).split('\n')
    const body = [lines[0]!]
    for (const line of lines.slice(1)) {
      if (!/^\s*(\||\/\*\*|\*)/.test(line)) break
      body.push(line)
    }
    return [...body.join('\n').matchAll(/'([a-z][a-z0-9-]*)'/g)].map((m) => m[1]!)
  }
  const vocabulary: Record<string, string[]> = {
    hint: hints,
    ph: union('src/ar/fiducial/tag-session.ts', 'TagSessionPhase'),
    fb: union('src/ar/fiducial/tag-worker-client.ts', 'TagFallbackReason'),
    un: [...union('src/ar/camera-frame-feed.ts', 'CameraFrameUnsupportedReason'), 'cover-fit'],
    mode: ['worker', 'main-thread'],
    fit: ['contain', 'cover'],
    ver: ['verified', 'provisional'],
    q: ['good', 'fair', 'poor'],
    rt: ['8thwall', 'webxr', 'native'],
  }
  for (const [column, words] of Object.entries(vocabulary)) {
    assert.ok(words.length >= 2, column)
    for (const word of words) assert.ok(word.length <= TAG_WORD_MAX[column]!, `${column} \`${word}\` is ${word.length} characters; the column holds ${TAG_WORD_MAX[column]}`)
    assert.ok(Math.max(...words.map((w) => w.length)) === TAG_WORD_MAX[column], `${column}: the column is as long as its longest word (${TAG_WORD_MAX[column]}), not longer than it needs to be`)
  }
  assert.deepEqual(Object.keys(TAG_WORD_MAX).sort(), Object.keys(vocabulary).sort())
})

// ===============================================================================================
// What the kit says about the view: the camera line, and a view that is refused
// ===============================================================================================

/** Noise frames through a feed at 1 s apart, with the display the test gives: the cheapest frames that make the kit write its lines. */
async function runBlank(
  search: string,
  ticks: number,
  display: (i: number) => { canvasWidth: number; canvasHeight: number; fit: 'contain' | 'cover' },
  stepMs = 1000,
  /** The runtime's frame clock for tick i, and what happens to the feed before it: a restarted provider resets the feed and its clock begins again. */
  clock: (i: number) => number = (i) => i * stepMs,
  beforeTick: (i: number, feed: CameraFrameFeed) => void = () => {},
) {
  const lines: string[] = []
  const feed = new CameraFrameFeed()
  const provider = { onCameraFrame: (cb: Parameters<CameraFrameFeed['subscribe']>[0], o: Parameters<CameraFrameFeed['subscribe']>[1]) => feed.subscribe(cb, o), scaleKind: () => 'metric' as const, cameraFeedStats: () => feed.stats }
  const stop = installTagDebug({ provider, runtime: '8thwall', emit: (l) => lines.push(l), worker: { createWorker: fakeWorker } }, search)!
  const image = noiseOnlyFrame(320, 240, 120, 5, 7)
  for (let i = 0; i < ticks; i++) {
    beforeTick(i, feed)
    feed.offer({ timestampMs: clock(i), repeatFrame: false, pose: { position: { x: i * 0.001, y: 1.4, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 } }, poseCurrent: true, epoch: 0, trackingStatus: 'NORMAL', projection: PROJECTION, pixelArray: { pixels: image.data, rows: 240, cols: 320, rowBytes: 320 }, display: display(i) })
    await settle()
  }
  stop()
  const cam = lines.filter((l) => l.startsWith(TAGCAM_LINE_PREFIX)).map((l) => JSON.parse(l.slice(TAGCAM_LINE_PREFIX.length)) as TagCamRecord)
  return { lines, cam, feed }
}

test('a page loaded with ?camerafit=cover is said once, in every line the run asked for, with the view that was refused (it was silent: no line, no reason)', async () => {
  const sim = await runBlank('?debug=remote,tag,tagneg&camerafit=cover', 12, () => ({ canvasWidth: 390, canvasHeight: 844, fit: 'cover' }))
  const tag = sim.lines.filter((l) => l.startsWith(TAG_LINE_PREFIX)).map((l) => JSON.parse(l.slice(TAG_LINE_PREFIX.length)) as TagRecord)
  const neg = sim.lines.filter((l) => l.startsWith(TAGNEG_LINE_PREFIX)).map((l) => JSON.parse(l.slice(TAGNEG_LINE_PREFIX.length)) as TagNegRecord)
  assert.equal(tag.length, 1, 'one [tag] line, not one a second of nothing')
  assert.equal(sim.cam.length, 1)
  assert.equal(neg.length, 1)
  assert.equal(tag[0]!.un, 'cover-fit')
  assert.equal(neg[0]!.un, 'cover-fit')
  assert.deepEqual(Object.keys(tag[0]!), [...TAG_KEYS])
  assert.deepEqual(Object.keys(neg[0]!), [...TAGNEG_KEYS])
  assert.equal(tag[0]!.fr, 0)
  // The camera line says which view it was: the projection and sizes of the frame that was refused, and the fit.
  const c = sim.cam[0]!
  assert.equal(c.un, 'cover-fit')
  assert.equal(c.fit, 'cover')
  assert.equal(c.cw, 390)
  assert.equal(c.ch, 844)
  assert.equal(c.cols, 320)
  assert.equal(c.rows, 240)
  assert.equal(c.p0, Math.round(PROJECTION[0]! * 1e5) / 1e5)
  assert.equal(sim.feed.active, false, 'the feed was let go')
  // Nothing else is written afterwards: the run is over, and says so once.
  assert.equal(sim.lines.length, 3)
  // The same page loaded with only one kit armed says it in that kit's lines only.
  const only = await runBlank('?debug=remote,tagneg&camerafit=cover', 4, () => ({ canvasWidth: 390, canvasHeight: 844, fit: 'cover' }))
  assert.deepEqual(only.lines.map((l) => l.split(' ')[0]), ['[tagneg]'])
  assert.equal(JSON.parse(only.lines[0]!.slice(TAGNEG_LINE_PREFIX.length)).un, 'cover-fit')
})

test('the camera line is written with the first frame, repeated every 30 s, and when the pixel array, the canvas or the fit change (not oftener than a second apart); never for a number that only jitters', async () => {
  const shown = (i: number) => ({ canvasWidth: i < 40 ? 320 : 400, canvasHeight: 240, fit: 'contain' as const })
  const sim = await runBlank('?debug=tag', 100, shown)
  // First frame (0 s); 30 s; the canvas changes at 40 s; and then thirty seconds after that (70 s), and again at 100 s: but the run ends at 99 s.
  const times = sim.cam.map((c) => c.n)
  assert.deepEqual(times, [1, 2, 3, 4], 'four lines')
  assert.equal(TAGCAM_LINE_PERIOD_MS, 30_000)
  assert.equal(TAGCAM_CHANGE_MIN_MS, 1000)
  assert.deepEqual(sim.cam.map((c) => c.cw), [320, 320, 400, 400], 'the third is the change, at 40 s')
  // A canvas that changes every frame is written once a second at most.
  const jumpy = await runBlank('?debug=tag', 20, (i) => ({ canvasWidth: 300 + i, canvasHeight: 240, fit: 'contain' }), 400)
  assert.ok(jumpy.cam.length <= 9 && jumpy.cam.length >= 6, `${jumpy.cam.length} camera lines in 8 s of a view that changed every frame`)
  // The fit changing is a change like any other.
  const refit = await runBlank('?debug=tag', 12, (i) => ({ canvasWidth: 320, canvasHeight: 240, fit: i < 6 ? 'contain' : 'cover' }))
  assert.equal(refit.cam.length, 2, 'the camera line at the start, and the refusal (cover) at 6 s')
  assert.deepEqual(refit.cam.map((c) => c.fit), ['contain', 'cover'])
  assert.equal(refit.cam[1]!.un, 'cover-fit')
  // `?debug=tagneg` alone has no camera line: its own lines carry the pixel array.
  const neg = await runBlank('?debug=tagneg', 5, () => ({ canvasWidth: 320, canvasHeight: 240, fit: 'contain' }))
  assert.equal(neg.cam.length, 0)
})

test('a provider that restarts (the feed is reset and the runtime\'s clock begins again) does not silence the kit until the new clock catches up with the old one', async () => {
  // Thirty-five seconds of frames, a restart, five more: the lines go on, one a frame, instead of stopping for the half minute the clock needs to get back to where the last line was
  // written, and the camera line (last written at 31 s) is written for the new run at once, not at 61 s.
  const sim = await runBlank('?debug=remote,tag,tagneg', 42, () => ({ canvasWidth: 320, canvasHeight: 240, fit: 'contain' }), 1000, (i) => (i < 36 ? i : i - 36) * 1000, (i, feed) => {
    if (i === 36) feed.reset()
  })
  const tag = sim.lines.filter((l) => l.startsWith(TAG_LINE_PREFIX)).map((l) => JSON.parse(l.slice(TAG_LINE_PREFIX.length)) as TagRecord)
  const neg = sim.lines.filter((l) => l.startsWith(TAGNEG_LINE_PREFIX)).map((l) => JSON.parse(l.slice(TAGNEG_LINE_PREFIX.length)) as TagNegRecord)
  // 35 frames are read before the restart (the first has no pose a frame back) and 5 after it (the same, since the history began again).
  assert.equal(tag.length, 40, `${tag.length} lines`)
  assert.deepEqual(tag.map((l) => l.n), Array.from({ length: 40 }, (_, i) => i + 1))
  assert.deepEqual(sim.cam.map((c) => c.n), [1, 2, 3], 'the first frame, the half minute, and the restart')
  // The negative-corpus counts go on too: a line at the first frame, one at 31 s, one at the restart (the clock went back), and one when the kit is stopped.
  assert.equal(neg.length, 4)
  assert.ok(neg[2]!.frames >= 36 && neg[3]!.frames >= neg[2]!.frames)
})

test('the camera line carries the feed\'s own counters of what it could not deliver: ticks whose pose was held over, and due ticks with no history to pair with', async () => {
  // Frames at 1 s; before ticks 5 and 6 the runtime holds its pose over one more tick (the feed forgets the poses before it); the fit changes at tick 12, which earns a camera line that reads the counters.
  const sim = await runBlank('?debug=tag', 16, (i) => ({ canvasWidth: 320, canvasHeight: 240, fit: i < 12 ? 'contain' : 'cover' }), 1000, (i) => i * 1000, (i, feed) => {
    if (i === 5 || i === 6) feed.offer({ timestampMs: i * 1000, repeatFrame: false, pose: { position: { x: 0, y: 1.4, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 } }, poseCurrent: false, epoch: 0, trackingStatus: 'LIMITED', projection: PROJECTION, pixelArray: null, display: { canvasWidth: 320, canvasHeight: 240, fit: 'contain' } })
  })
  assert.equal(sim.cam[0]!.held, 0)
  assert.equal(sim.cam[0]!.unp, 1, 'the first tick has no pose a frame back')
  const last = sim.cam[sim.cam.length - 1]!
  assert.equal(last.fit, 'cover')
  assert.equal(last.held, 2, 'the two held ticks')
  assert.equal(last.unp, 3, 'the first tick, and the two ticks that followed a held one (each began the history again)')
})

// ===============================================================================================
// One run follows another
// ===============================================================================================

test('the kit follows the tag after its session has ended: a phone held at one mark, then another on the same page load, reads the second mark (it read the first for ever)', async () => {
  const lines: string[] = []
  const feed = new CameraFrameFeed()
  const provider = { onCameraFrame: (cb: Parameters<CameraFrameFeed['subscribe']>[0], o: Parameters<CameraFrameFeed['subscribe']>[1]) => feed.subscribe(cb, o), scaleKind: () => 'metric' as const, cameraFeedStats: () => feed.stats }
  const stop = installTagDebug({ provider, runtime: '8thwall', emit: (l) => lines.push(l), worker: { createWorker: fakeWorker } }, '?debug=tag&tagsize=200')!
  // A phone that does not move, a tag 3 m ahead, then 2 m, then 1.5 m, a frame every 2 s. The first tick has no pose a frame back to go with it, so frames are read from the second. The session gives up
  // 30 s of frame time after its first frame, at the tick at 32 s (which is at 2 m still), and the tag is at 1.5 m for the three ticks after that.
  const zAt = (tick: number): number => (tick < 8 ? 3 : tick < 17 ? 2 : 1.5)
  for (let i = 0; i < 20; i++) {
    const z = zAt(i)
    const image = renderTag({ dictionary: CSCAN6_V1, id: 6, sizeM: 0.2, pose: tagPose({ x: 0, y: 0, z }, 0, 25, 0), intrinsics: K, noiseSigma: 1, blurSigma: 0.4, seed: i + 1, supersample: 2, channels: 4 })
    feed.offer({ timestampMs: i * 2000, repeatFrame: false, pose: { position: { x: 0, y: 1.3, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 } }, poseCurrent: true, epoch: 0, trackingStatus: 'NORMAL', projection: PROJECTION, pixelArray: { pixels: image.data, rows: 480, cols: 640, rowBytes: 2560 }, display: { canvasWidth: 640, canvasHeight: 480, fit: 'contain' } })
    await settle()
  }
  stop()
  const tag = lines.filter((l) => l.startsWith(TAG_LINE_PREFIX)).map((l) => JSON.parse(l.slice(TAG_LINE_PREFIX.length)) as TagRecord)
  assert.equal(tag.length, 19, 'a line a frame read: they are two seconds apart')
  // The columns follow the tag at every mark, before and after the session ended.
  tag.forEach((l, i) => {
    const z = zAt(i + 1)
    assert.ok(l.rng !== null && Math.abs(l.rng - z) < 0.06, `line ${i}: the tag is ${z} m away and the line says ${l.rng}`)
  })
  // The session's end is said once, in the line written for the frame that ended it (the tick at 32 s: a frame a line, two seconds apart), and then the next run begins.
  const ended = tag.map((l, i) => [l.ph, i] as const).filter(([ph]) => ph === 'timed-out')
  assert.deepEqual(ended.map(([, i]) => i), [15])
  assert.ok(tag.slice(16).every((l) => l.ph === 'collecting' || l.ph === 'searching'), `${tag.slice(16).map((l) => l.ph).join(', ')}`)
  assert.ok(tag[18]!.hint !== null, 'a live hint for the run in progress')
})

test('a session that finished is reported with its verdict and its quality in the next line written, and the kit begins another: the lines after are about the frames since', async () => {
  // A slow sweep (the swing is a lag-fit instrument and too fast for a read): 5.5 degrees either side of 40 at a 2 s period is 0.35 m of travel and under 18 degrees a second.
  const sim = await runTag('?debug=tag&tagheight=1.2', 1, { ticks: 240, amplitudeDeg: 5.5 })
  const phases = sim.tagLines.map((l) => l.ph)
  const done = sim.tagLines.map((l, i) => [l, i] as const).filter(([l]) => l.ph === 'done')
  assert.ok(done.length >= 1, `a read finishes: ${phases.join(', ')}`)
  const [first, at] = done[0]!
  assert.equal(first.ver, 'provisional', 'a first marker has nothing to match')
  assert.ok(first.q === 'good' || first.q === 'fair' || first.q === 'poor')
  assert.equal(first.pr, 1)
  // The next line is the next run's: it is reading afresh, with no verdict yet.
  const next = sim.tagLines[at + 1]
  assert.ok(next, 'a line follows')
  assert.ok(next.ph === 'collecting' || next.ph === 'searching', `${next.ph}`)
  assert.equal(next.ver, null)
  assert.equal(next.q, null)
  // A session that ended is not asked for another verdict on the frames it ignored: a verdict appears once, in the line that reports its end.
  assert.equal(sim.tagLines.filter((l) => l.ver !== null).length, done.length)
  sim.stop()
})

// ===============================================================================================
// Nothing is kept
// ===============================================================================================

/** Collect garbage on demand, without a flag on the command line: Node can be told to expose it at run time. */
function collectGarbage(): () => void {
  v8.setFlagsFromString('--expose-gc')
  return vm.runInNewContext('gc') as () => void
}

test('?debug=tagneg keeps no frame: after a long walk the poses of the frames it read are garbage, in either mode (it kept every one: the walk was an unbounded list)', async () => {
  const gc = collectGarbage()
  for (const search of ['?debug=remote,tagneg', '?debug=remote,tag', '?debug=remote,tag,tagneg']) {
    const feed = new CameraFrameFeed()
    const refs: WeakRef<object>[] = []
    const provider = {
      onCameraFrame: (cb: Parameters<CameraFrameFeed['subscribe']>[0], o: Parameters<CameraFrameFeed['subscribe']>[1]) => feed.subscribe((f) => { refs.push(new WeakRef(f.pose)); cb(f) }, o),
      scaleKind: () => 'metric' as const,
      cameraFeedStats: () => feed.stats,
    }
    const stop = installTagDebug({ provider, runtime: '8thwall', emit: () => {}, worker: { createWorker: fakeWorker } }, search)!
    const image = noiseOnlyFrame(160, 120, 120, 5, 7)
    for (let i = 0; i < 200; i++) {
      feed.offer({ timestampMs: i * 125, repeatFrame: false, pose: { position: { x: i * 0.0005, y: 1.4, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 } }, poseCurrent: true, epoch: 0, trackingStatus: 'NORMAL', projection: PROJECTION, pixelArray: { pixels: image.data, rows: 120, cols: 160, rowBytes: 160 }, display: { canvasWidth: 160, canvasHeight: 120, fit: 'contain' } })
      await settle()
    }
    await settle()
    gc()
    await settle()
    gc()
    const alive = refs.filter((r) => r.deref() !== undefined).length
    // The feed's own history holds the newest poses and the window of the last second the rest: a dozen, not two hundred.
    assert.ok(refs.length >= 150, `${search}: ${refs.length} frames delivered`)
    assert.ok(alive <= 30, `${search}: ${alive} of ${refs.length} delivered frames are still reachable after a collection`)
    stop()
  }
})


test('the fused orientation spread and residual at the configured lag are smaller when the lag is right: taglag=1 against taglag=0 in a world built with lag 1', async () => {
  const right = await runTag('?debug=tag&taglag=1', 1, { ticks: 100 })
  const wrong = await runTag('?debug=tag&taglag=0', 1, { ticks: 100 })
  const a = right.tagLines[right.tagLines.length - 1]!
  const b = wrong.tagLines[wrong.tagLines.length - 1]!
  assert.ok(a.fuseRotDeg! < b.fuseRotDeg!, `${a.fuseRotDeg} degrees at the right lag, ${b.fuseRotDeg} at the wrong one`)
  assert.ok(a.fuseHeadDeg! < b.fuseHeadDeg!, `${a.fuseHeadDeg} degrees of heading at the right lag, ${b.fuseHeadDeg} at the wrong one`)
  assert.ok(a.fuseRms! < b.fuseRms!, `${a.fuseRms} px at the right lag, ${b.fuseRms} at the wrong one`)
  assert.equal(b.lagBest, 1, 'the fit does not depend on the lag the session is configured with')
  right.stop()
  wrong.stop()
})

test('a registered tag is asked for by id and read exactly: the worker is told, and another tag in view is turned away', async () => {
  const sim = await runTag('?debug=tag&tagid=3', 1, { ticks: 40 })
  const init = sim.workers[0]!.seen[0] as { type: string; family: string; detector: Record<string, unknown>; roi: boolean }
  assert.equal(init.type, 'init')
  assert.equal(init.family, 'cscan-6x6-v1')
  assert.deepEqual(init.detector, { ids: [3], maxHamming: 0, minSidePx: 24, profile: true })
  // The tag drawn is id 6, so nothing is read, and the line says so.
  const last = sim.tagLines[sim.tagLines.length - 1]!
  assert.equal(last.hit, 0)
  assert.equal(last.id, null)
  sim.stop()
})

test('lines come at a second\'s cadence of frame time, and stopping writes what is pending', async () => {
  const sim = await runTag('?debug=tag', 1, { ticks: 66 })
  // 66 ticks at 30 Hz is 2.17 s: a line at the first frame, then each time a second has passed.
  assert.ok(sim.tagLines.length >= 2 && sim.tagLines.length <= 4, `${sim.tagLines.length} lines`)
  const before = sim.tagLines.length
  sim.stop()
  const after = sim.lines.filter((l) => l.startsWith(TAG_LINE_PREFIX)).length
  assert.ok(after >= before && after <= before + 1, 'a flush at most one line')
  assert.equal(TAG_LINE_PERIOD_MS, 1000)
  assert.equal(TAGNEG_LINE_PERIOD_MS, 30_000)
  assert.equal(LAG_FIT_MIN_FRAMES, 8)
})

test('a provider that cannot supply frames is said once, in the shape of every other line, with the reason', () => {
  const lines: string[] = []
  const provider = { onCameraFrame: () => ({ status: 'unsupported' as const, reason: 'webxr-no-camera-access' as const, unsubscribe() {} }) }
  const stop = installTagDebug({ provider, runtime: 'webxr', emit: (l) => lines.push(l) }, '?debug=tag,tagneg')
  assert.ok(stop)
  assert.equal(lines.length, 3, 'a [tag] line, a [tagcam] line (with no view to show) and a [tagneg] line')
  const tag = JSON.parse(lines[0]!.slice(TAG_LINE_PREFIX.length)) as TagRecord
  assert.deepEqual(Object.keys(tag), [...TAG_KEYS])
  assert.equal(tag.un, 'webxr-no-camera-access')
  assert.equal(tag.rt, 'webxr')
  assert.equal(tag.fr, 0)
  const cam = JSON.parse(lines[1]!.slice(TAGCAM_LINE_PREFIX.length)) as TagCamRecord
  assert.deepEqual(Object.keys(cam), [...TAGCAM_KEYS])
  assert.equal(cam.un, 'webxr-no-camera-access')
  assert.equal(cam.p0, null)
  assert.equal(cam.cols, null)
  assert.equal(cam.fit, null)
  assert.equal(cam.held, null, 'a provider with no feed counters has none to report')
  assert.equal(cam.unp, null)
  const neg = JSON.parse(lines[2]!.slice(TAGNEG_LINE_PREFIX.length)) as TagNegRecord
  assert.deepEqual(Object.keys(neg), [...TAGNEG_KEYS])
  assert.equal(neg.un, 'webxr-no-camera-access')
  assert.equal(neg.frames, 0)
  stop!()
})

// ===============================================================================================
// ?debug=tagneg
// ===============================================================================================

test('?debug=tagneg counts what the detector saw on frames with no tag, equal to the sum of its own counters on the same frames, in lines of counts only', async () => {
  const lines: string[] = []
  const feed = new CameraFrameFeed()
  const provider = { onCameraFrame: (cb: Parameters<CameraFrameFeed['subscribe']>[0], o: Parameters<CameraFrameFeed['subscribe']>[1]) => feed.subscribe(cb, o), scaleKind: () => 'metric' as const }
  const stop = installTagDebug({ provider, runtime: '8thwall', emit: (l) => lines.push(l), worker: { createWorker: fakeWorker } }, '?debug=remote,tagneg')!
  // Frames of rooms and of noise, with nothing in them that is a tag; a tick every ten seconds so the 30 s cadence is crossed.
  const kinds = ['fractal', 'furniture', 'text', 'tiles', 'decoys', 'random-decoys'] as const
  const reference = new FiducialDetector(CSCAN6_V1, { minSidePx: 24 })
  const want = new TagNegativeCounter()
  const pose: Pose = { position: { x: 0, y: 1.4, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 } }
  let sent = 0
  for (let i = 0; i < 14; i++) {
    const image = i % 4 === 3 ? noiseOnlyFrame(640, 480, 120, 5, 100 + i) : textureFrame(kinds[i % kinds.length]!, 640, 480, 50 + i, CSCAN6_V1)
    // The first tick has no pose a frame back (the default lag), so it is not delivered and is not counted.
    if (i > 0) {
      reference.detect(image)
      want.add(reference.stats)
    }
    feed.offer({ timestampMs: i * 10_000, repeatFrame: false, pose: { ...pose, position: { x: i * 0.001, y: 1.4, z: 0 } }, poseCurrent: true, epoch: 0, trackingStatus: 'NORMAL', projection: PROJECTION, pixelArray: { pixels: image.data, rows: 480, cols: 640, rowBytes: 640 } })
    if (i > 0) sent++
    await settle()
  }
  stop()
  const neg = lines.filter((l) => l.startsWith(TAGNEG_LINE_PREFIX)).map((l) => JSON.parse(l.slice(TAGNEG_LINE_PREFIX.length)) as TagNegRecord)
  assert.ok(neg.length >= 4, `${neg.length} lines over 130 s: one at the start, one every 30 s, one at the stop`)
  neg.forEach((l) => assert.deepEqual(Object.keys(l), [...TAGNEG_KEYS]))
  neg.forEach((l, i) => assert.equal(l.n, i + 1))
  // Cumulative: counts never fall.
  for (let i = 1; i < neg.length; i++) for (const key of ['frames', 'cand', 'groups', 'attempts', 'reach', 'det', 'capped', 'maxCand', 's'] as const) assert.ok(neg[i]![key] >= neg[i - 1]![key], `${key} fell`)
  const last = neg[neg.length - 1]!
  const w = want.snapshot()
  assert.equal(last.frames, sent)
  assert.equal(last.frames, w.frames)
  assert.equal(last.cand, w.candidates)
  assert.equal(last.groups, w.groups)
  assert.equal(last.attempts, w.decodeAttempts)
  assert.equal(last.reach, w.reachedMatcher)
  assert.equal(last.det, w.detections)
  assert.equal(last.det, 0, 'no tag in view, so every detection would be a false accept')
  assert.equal(last.capped, w.cappedFrames)
  assert.equal(last.maxCand, w.maxCandidates)
  assert.deepEqual([last.rejOff, last.rejContrast, last.rejBorder, last.rejQuiet, last.rejMatch, last.rejIds], [w.rejected.offFrame, w.rejected.contrast, w.rejected.border, w.rejected.quiet, w.rejected.match, w.rejected.ids])
  assert.ok(last.cand > 0 && last.attempts > 0, 'the frames did exercise the decoder')
  assert.equal(last.cols, 640)
  assert.equal(last.rows, 480)
  assert.equal(last.mode, 'worker')
  assert.equal(last.fb, null)
  assert.equal(last.un, null)
  // The first line is at the first frame, then not before thirty seconds of frame time have passed.
  assert.equal(neg[0]!.frames, 1)
  assert.ok(neg[1]!.s >= TAGNEG_LINE_PERIOD_MS / 1000 && neg[1]!.s < 2 * TAGNEG_LINE_PERIOD_MS / 1000, `second line at ${neg[1]!.s} s`)
})

test('?debug=tagneg counts a frame that has a tag in it like any other: a detection is the false accept the run exists to find, and is never left out of it', async () => {
  const lines: string[] = []
  const feed = new CameraFrameFeed()
  const provider = { onCameraFrame: (cb: Parameters<CameraFrameFeed['subscribe']>[0], o: Parameters<CameraFrameFeed['subscribe']>[1]) => feed.subscribe(cb, o), scaleKind: () => 'metric' as const }
  const stop = installTagDebug({ provider, runtime: '8thwall', emit: (l) => lines.push(l), worker: { createWorker: fakeWorker } }, '?debug=remote,tagneg')!
  const reference = new FiducialDetector(CSCAN6_V1, { minSidePx: 24 })
  const want = new TagNegativeCounter()
  const tag = fixedTag(0, 0, { x: 0.3, y: 1.3, z: -3 })
  const pose: Pose = { position: { x: 0, y: 1.4, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 } }
  let tagFrames = 0
  let sent = 0
  for (let i = 0; i < 8; i++) {
    // Every other frame is a room with nothing in it; the rest show a tag, as a phone swept past a marker someone forgot to take down would.
    const withTag = i % 2 === 1
    const image = withTag
      ? renderTag({ dictionary: CSCAN6_V1, id: 6, sizeM: 0.2, pose: cvPoseOf(tag, swing(tag, i * 0.1, SWING_AMPLITUDE_DEG)), intrinsics: K, noiseSigma: 1, supersample: 2, channels: 1 })
      : textureFrame('furniture', 640, 480, 50 + i, CSCAN6_V1)
    if (i > 0) {
      reference.detect(image)
      want.add(reference.stats)
      if (withTag) tagFrames++
      sent++
    }
    feed.offer({ timestampMs: i * 1000, repeatFrame: false, pose: { ...pose, position: { x: i * 0.001, y: 1.4, z: 0 } }, poseCurrent: true, epoch: 0, trackingStatus: 'NORMAL', projection: PROJECTION, pixelArray: { pixels: image.data, rows: 480, cols: 640, rowBytes: 640 } })
    await settle()
  }
  stop()
  const neg = lines.filter((l) => l.startsWith(TAGNEG_LINE_PREFIX)).map((l) => JSON.parse(l.slice(TAGNEG_LINE_PREFIX.length)) as TagNegRecord)
  const last = neg[neg.length - 1]!
  const w = want.snapshot()
  assert.ok(tagFrames >= 3 && w.detections >= 3, `${tagFrames} frames had a tag in them and the detector reported ${w.detections}`)
  assert.equal(last.frames, sent, 'the frames with a tag are counted as frames')
  assert.equal(last.det, w.detections, 'and their detections as detections')
  assert.equal(last.cand, w.candidates)
  assert.equal(last.attempts, w.decodeAttempts)
})

test('nothing leaves the phone and nothing is stored: every line is counts and short words, and the modules a frame passes through use no storage and no network', async () => {
  const sim = await runTag('?debug=tag,tagneg', 1, { ticks: 70 })
  assert.ok(sim.lines.length >= 3)
  for (const line of sim.lines) {
    assert.ok(line.length < 1400, `a line of ${line.length} characters`)
    const body = JSON.parse(line.slice(line.indexOf('{'))) as Record<string, unknown>
    for (const [key, value] of Object.entries(body)) {
      assert.ok(value === null || typeof value === 'number' || (typeof value === 'string' && /^[a-z0-9-]{1,40}$/.test(value)), `${key} is ${typeof value}: ${JSON.stringify(value).slice(0, 80)}`)
    }
  }
  sim.stop()
  // The source: no browser storage, no network, no way to encode an image, in the kit or in anything a frame passes through.
  const forbidden = /\b(localStorage|sessionStorage|indexedDB|caches|fetch|XMLHttpRequest|sendBeacon|WebSocket|EventSource|toDataURL|toBlob|createImageBitmap|FileReader|FormData|BroadcastChannel|navigator\.share)\b/
  for (const file of ['tag-debug.ts', 'tag-capture.ts', 'tag-worker-client.ts', 'tag-worker-core.ts', 'tag-worker.ts', 'tag-runner.ts']) {
    const text = readFileSync(join(ROOT, 'src/ar/fiducial', file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    const hit = forbidden.exec(text)
    assert.equal(hit, null, `${file} uses ${hit?.[0]}`)
  }
  const feedText = readFileSync(join(ROOT, 'src/ar/camera-frame-feed.ts'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  assert.equal(forbidden.exec(feedText), null, 'camera-frame-feed.ts uses a storage or network API')
})

test('lines are written with their prefixes, as JSON, and a line that cannot be written is a gap in n, not a crash', async () => {
  const record = (n: number): TagRecord => ({ ...(Object.fromEntries(TAG_KEYS.map((k) => [k, null])) as unknown as TagRecord), v: 1, n, rt: 'webxr', fr: 0, hit: 0, drop: 0 })
  assert.match(formatTagLine(record(2)), /^\[tag\] \{"v":1,"n":2,"rt":"webxr"/)
  assert.match(formatTagNegLine({ v: 1, n: 1, rt: 'webxr', mode: null, fb: null, un: null, s: 0, frames: 0, cand: 0, groups: 0, attempts: 0, reach: 0, det: 0, capped: 0, maxCand: 0, rejOff: 0, rejContrast: 0, rejBorder: 0, rejQuiet: 0, rejMatch: 0, rejIds: 0, drop: 0, cols: null, rows: null }), /^\[tagneg\] \{"v":1,"n":1/)
  const lines: string[] = []
  let failures = 0
  const feed = new CameraFrameFeed()
  const provider = { onCameraFrame: (cb: Parameters<CameraFrameFeed['subscribe']>[0], o: Parameters<CameraFrameFeed['subscribe']>[1]) => feed.subscribe(cb, o), scaleKind: () => 'metric' as const }
  const stop = installTagDebug({
    provider,
    runtime: '8thwall',
    emit: (l) => {
      if (l.startsWith(TAG_LINE_PREFIX) && failures++ === 0) throw new Error('the relay is down')
      lines.push(l)
    },
    worker: { createWorker: fakeWorker },
  }, '?debug=tag')!
  const image = noiseOnlyFrame(640, 480, 120, 4, 1)
  for (let i = 0; i < 12; i++) {
    feed.offer({ timestampMs: i * 400, repeatFrame: false, pose: { position: { x: i * 0.01, y: 1, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 } }, poseCurrent: true, epoch: 0, trackingStatus: 'NORMAL', projection: PROJECTION, pixelArray: { pixels: image.data, rows: 480, cols: 640, rowBytes: 640 } })
    await settle()
  }
  stop()
  const parsed = lines.filter((l) => l.startsWith(TAG_LINE_PREFIX)).map((l) => JSON.parse(l.slice(TAG_LINE_PREFIX.length)) as TagRecord)
  assert.ok(parsed.length >= 1)
  assert.equal(parsed[0]!.n, 2, 'the line that failed to be written left a gap in the numbering')
  assert.ok(lines.some((l) => l.startsWith(TAGCAM_LINE_PREFIX)), 'the camera line went out: one line failing does not stop the others')
})
