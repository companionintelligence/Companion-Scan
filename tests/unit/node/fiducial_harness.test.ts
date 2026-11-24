/**
 * The test harness's models of what a phone meets (a hard cast shadow, low light with noise, a patch of glare, a rolling shutter) and its hooks for an oracle
 * parity run, built for the marker detector (WP-14a amendment, WP-14b).
 *
 * A harness that is wrong makes every test that uses it wrong in a way nothing else notices, so each model is checked against the numbers it documents
 * (the light a shadow leaves on each side, the level a glare patch lifts ink to, what low light does to ink and paper, where a skewed column lands in each
 * row), on frames rendered with the harness's own renderer. The parity hooks are checked with detectors whose answers are known: one that returns the
 * truth, one that is wrong in each way the report counts, and the in-house detector, whose self-run on this harness's frames is the measurement the
 * numbers below come from (synthetic frames only: no oracle detector is built here and nothing here says how any detector does on a real camera).
 *
 * Run: node --experimental-strip-types --no-warnings --test tests/unit/node/fiducial_harness.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { CSCAN5_V1, CSCAN6_V1 } from '../../../src/ar/fiducial/dictionary.ts'
import { FiducialDetector } from '../../../src/ar/fiducial/detector.ts'
import type { Dictionary, FiducialImage, Quad } from '../../../src/ar/fiducial/types.ts'
import { INTRINSICS_640, LOW_LIGHT, castShadowAcrossHalf, glarePatch, lightProduct, mat3Apply, renderFrame, renderTag, rollingShutterSkew, tagPose } from '../../support/fiducial-render.ts'
import { PARITY_SKEW_PX_PER_ROW, inHouseParityDetector, parityScenes, runParity } from '../../support/fiducial-parity.ts'
import type { ParityDetection, ParityDetector, ParityScene } from '../../support/fiducial-parity.ts'

/** A flat field, as the harness renders it: `level` everywhere, lit by `light`, through `options`. */
function lit(width: number, height: number, level: number, light: (x: number, y: number) => number, extra: { channels?: 1 | 4 } = {}): FiducialImage {
  return renderFrame({ width, height, intrinsics: { fx: 500, fy: 500, cx: width / 2, cy: height / 2, width, height }, items: [], background: level, light, ...extra })
}

function at(image: FiducialImage, x: number, y: number): number {
  const stride = image.rowBytes ?? image.width * image.channels
  return image.data[y * stride + x * image.channels]!
}

function meanOf(image: FiducialImage, x0: number, y0: number, x1: number, y1: number): number {
  let sum = 0
  let n = 0
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++, n++) sum += at(image, x, y)
  return sum / n
}

function sdOf(image: FiducialImage, x0: number, y0: number, x1: number, y1: number): number {
  const m = meanOf(image, x0, y0, x1, y1)
  let sum = 0
  let n = 0
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++, n++) sum += (at(image, x, y) - m) ** 2
  return Math.sqrt(sum / n)
}

// ---------------------------------------------------------------------------------------------
// A hard cast shadow
// ---------------------------------------------------------------------------------------------

test('castShadowAcrossHalf: full light on one side of a line through the centre, 1 / ratio on the other, the step spread over the edge, along the angle', () => {
  const centre = { x: 100, y: 50 }
  // Angle 0: the line is vertical, the shadow is to the right.
  const right = castShadowAcrossHalf(centre, 4, 0, 2)
  assert.equal(right(90, 50), 1)
  assert.equal(right(110, 50), 0.25)
  assert.ok(Math.abs(right(100, 50) - 0.625) < 1e-12, 'the middle of the edge is halfway')
  assert.ok(Math.abs(right(99.5, 50) - (1 - 0.75 * 0.25)) < 1e-12, 'a quarter of the way into a 2 px edge')
  assert.ok(Math.abs(right(100.5, 50) - (1 - 0.75 * 0.75)) < 1e-12, 'three quarters of the way')
  assert.equal(right(100, 0), right(100, 200), 'a vertical edge does not depend on y')
  let last = 2
  for (let x = 80; x <= 120; x += 0.5) {
    const v = right(x, 50)
    assert.ok(v <= last + 1e-12, `the light never rises across the edge (x ${x})`)
    last = v
  }
  // Angle 90 degrees: the line is horizontal, the shadow is below it.
  const below = castShadowAcrossHalf(centre, 2, Math.PI / 2, 1)
  assert.equal(below(100, 40), 1)
  assert.equal(below(100, 60), 0.5)
  assert.equal(below(0, 60), below(300, 60), 'a horizontal edge does not depend on x')
  // Angle 45 degrees: points along the line itself are at the middle of the edge.
  const diagonal = castShadowAcrossHalf(centre, 3, Math.PI / 4, 2)
  for (const d of [-30, -5, 0, 12, 40]) assert.ok(Math.abs(diagonal(100 + d, 50 - d) - (1 + 1 / 3) / 2) < 1e-12, `on the line at offset ${d}`)
  assert.ok(Math.abs(diagonal(100 + 20, 50 + 20) - 1 / 3) < 1e-12)
  assert.equal(diagonal(100 - 20, 50 - 20), 1)
})

test('rendered, a cast shadow leaves the level on the lit side and divides it by the ratio on the other, with an edge as wide as asked', () => {
  const light = castShadowAcrossHalf({ x: 100, y: 50 }, 2, 0, 10)
  const img = lit(200, 100, 200, light)
  assert.equal(at(img, 10, 50), 200)
  assert.equal(at(img, 190, 50), 100)
  assert.equal(at(img, 100, 10), at(img, 100, 90), 'the edge is vertical')
  // The edge: the level steps down across 10 pixels (95 to 105) and nowhere else.
  assert.equal(at(img, 94, 50), 200)
  assert.equal(at(img, 106, 50), 100)
  let steps = 0
  for (let x = 1; x < 200; x++) if (at(img, x, 50) !== at(img, x - 1, 50)) steps++
  assert.ok(steps >= 9 && steps <= 11, `${steps} pixels differ from their neighbour across the edge`)
  // On a tag in the frame, the dark half is darker by the ratio on paper and on ink alike.
  const pose = tagPose({ x: 0, y: 0, z: 1.2 })
  const base = { dictionary: CSCAN5_V1, id: 7, sizeM: 0.2, pose, intrinsics: INTRINSICS_640, supersample: 2 }
  const plain = renderTag(base)
  const shadowed = renderTag({ ...base, light: castShadowAcrossHalf({ x: 320, y: 240 }, 3, 0, 3) })
  assert.equal(at(shadowed, 100, 240), at(plain, 100, 240), 'left of the tag, the light is full')
  assert.ok(Math.abs(at(shadowed, 540, 240) - at(plain, 540, 240) / 3) <= 1, 'right of the tag, a third')
})

// ---------------------------------------------------------------------------------------------
// Glare
// ---------------------------------------------------------------------------------------------

test('glarePatch: 1 + strength at its centre, a Gaussian of the radius round it, 1 far off; at the default strength black ink at 25 levels reaches 250 and paper saturates', () => {
  const g = glarePatch({ x: 50, y: 40 }, 10)
  assert.equal(g(50, 40), 10)
  assert.ok(Math.abs(g(60, 40) - (1 + 9 * Math.exp(-0.5))) < 1e-12, 'one radius out')
  assert.ok(Math.abs(g(50, 60) - (1 + 9 * Math.exp(-2))) < 1e-12, 'two radii out')
  assert.ok(Math.abs(g(50 + 7, 40 + 7) - g(50 - 7, 40 - 7)) < 1e-12 && Math.abs(g(57, 40) - g(50, 47)) < 1e-12, 'round')
  assert.ok(Math.abs(g(500, 400) - 1) < 1e-12)
  assert.equal(glarePatch({ x: 0, y: 0 }, 5, 3)(0, 0), 4, 'strength 3 lifts the light fourfold')

  // Rendered: the ink level 25 rises to 250 under the middle of the patch, the paper 225 to the top of the range, and far from it nothing changes.
  const ink = lit(100, 80, 25, glarePatch({ x: 50.5, y: 40.5 }, 10))
  assert.equal(at(ink, 50, 40), 250)
  assert.equal(at(ink, 70, 40), Math.round(25 * (1 + 9 * Math.exp(-2))))
  assert.equal(at(ink, 0, 0), 25)
  const paper = lit(100, 80, 225, glarePatch({ x: 50.5, y: 40.5 }, 10))
  assert.equal(at(paper, 50, 40), 255)
  assert.equal(at(paper, 0, 0), 225)
})

test('lightProduct multiplies the lights it is given, and no lights is full light', () => {
  assert.equal(lightProduct()(3, 4), 1)
  const shadow = castShadowAcrossHalf({ x: 50, y: 40 }, 2, 0, 4)
  const glare = glarePatch({ x: 60, y: 40 }, 8, 4)
  const both = lightProduct(shadow, glare)
  for (const [x, y] of [[10, 10], [50, 40], [60, 40], [70, 35], [90, 70]] as const) assert.ok(Math.abs(both(x, y) - shadow(x, y) * glare(x, y)) < 1e-12, `(${x}, ${y})`)
  assert.equal(lightProduct(shadow)(80, 40), shadow(80, 40))
})

// ---------------------------------------------------------------------------------------------
// Low light
// ---------------------------------------------------------------------------------------------

test('LOW_LIGHT takes ink to about 9 and paper to about 59 with 7 levels of noise, and the in-house detector still reads a tag in it', () => {
  assert.deepEqual(LOW_LIGHT, { exposure: { gain: 0.25, offset: 3 }, noiseSigma: 7 })
  const pose = tagPose({ x: 0, y: 0, z: 1.2 })
  const base = { dictionary: CSCAN5_V1, id: 7, sizeM: 0.2, pose, intrinsics: INTRINSICS_640, supersample: 2 }
  const good = renderTag(base)
  const dim = renderTag({ ...base, seed: 5, ...LOW_LIGHT })
  // The tag is 83 px across (7 cells of about 11.9 px), centred in the frame: its top ring row of black cells is rows 198 to 210, the white margin above it 186 to 198.
  const black = (img: FiducialImage) => meanOf(img, 290, 201, 350, 207)
  const white = (img: FiducialImage) => meanOf(img, 290, 189, 350, 195)
  assert.ok(Math.abs(black(good) - 25) < 0.5 && Math.abs(white(good) - 225) < 0.5, `good light: ink ${black(good)}, paper ${white(good)}`)
  assert.ok(black(dim) > 8 && black(dim) < 11.5, `low light ink is ${black(dim)} levels, not about 9`)
  assert.ok(white(dim) > 57.5 && white(dim) < 61, `low light paper is ${white(dim)} levels, not about 59`)
  // The wall (120 in good light) is 33; the noise round it is the sensor's 7 levels, not scaled by the light.
  assert.ok(Math.abs(meanOf(dim, 0, 0, 40, 40) - 33) < 1, `wall ${meanOf(dim, 0, 0, 40, 40)}`)
  assert.ok(Math.abs(sdOf(dim, 0, 0, 40, 40) - 7) < 0.7, `noise ${sdOf(dim, 0, 0, 40, 40)}`)
  assert.equal(sdOf(good, 0, 0, 40, 40), 0, 'no noise in good light unless asked for')
  // The contrast a tag has is about 50 levels against 200: the noise is 14 % of it.
  assert.ok(Math.abs((white(dim) - black(dim)) - 50) < 3)

  for (const [dictionary, id] of [[CSCAN5_V1, 7], [CSCAN6_V1, 100]] as const) {
    const det = new FiducialDetector(dictionary)
    for (const [range, seed] of [[1.2, 1], [2, 2]] as const) {
      const img = renderTag({ dictionary, id, sizeM: 0.2, pose: tagPose({ x: 0.03, y: -0.02, z: range }, 20, 25, 5), intrinsics: INTRINSICS_640, seed, blurSigma: 0.7, supersample: 3, ...LOW_LIGHT })
      const found = det.detect(img)
      assert.equal(found.length, 1, `${dictionary.name} at ${range} m in low light: ${found.length} detections`)
      assert.equal(found[0]!.id, id)
    }
  }
})

// ---------------------------------------------------------------------------------------------
// A rolling shutter
// ---------------------------------------------------------------------------------------------

/** Where the bright column is in row `y`: the centroid of what is brighter than the background, pixel-centre coordinates. */
function columnCentroid(image: FiducialImage, y: number, background: number): number {
  let sum = 0
  let weight = 0
  for (let x = 0; x < image.width; x++) {
    const w = Math.max(0, at(image, x, y) - background)
    sum += w * (x + 0.5)
    weight += w
  }
  return sum / weight
}

test('rollingShutterSkew shears the frame about the reference row: a column lands skew * (row - reference) pixels along in each row', () => {
  const W = 640
  const H = 480
  const frame = (channels: 1 | 4) => {
    const data = new Uint8Array(W * H * channels)
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const v = x === 320 ? 200 : 20
        for (let c = 0; c < channels; c++) data[(y * W + x) * channels + c] = c === 3 ? 255 : v
      }
    }
    return { data, width: W, height: H, channels } satisfies FiducialImage
  }
  const skew = 0.05
  const skewed = rollingShutterSkew(frame(1), skew)
  assert.deepEqual([skewed.width, skewed.height, skewed.channels], [W, H, 1])
  for (const y of [0, 1, 100, 239, 240, 300, 478, 479]) {
    const expected = 320.5 + skew * (y + 0.5 - 240)
    assert.ok(Math.abs(columnCentroid(skewed, y, 20) - expected) < 0.02, `row ${y}: the column is at ${columnCentroid(skewed, y, 20)}, not ${expected}`)
  }
  // The other way, and about another row.
  const back = rollingShutterSkew(frame(1), -skew, 100)
  for (const y of [0, 100, 400]) assert.ok(Math.abs(columnCentroid(back, y, 20) - (320.5 - skew * (y + 0.5 - 100))) < 0.02, `row ${y}, reference 100`)
  // No skew changes nothing, and the edge pixel is repeated where the shear pulls in from beyond the frame.
  assert.deepEqual(rollingShutterSkew(frame(1), 0).data, frame(1).data)
  assert.equal(at(skewed, 639, 0), 20)
  assert.equal(at(skewed, 0, 479), 20)
  // Four channels: grey in all three colours, alpha untouched.
  const four = rollingShutterSkew(frame(4), skew)
  for (const y of [0, 240, 479]) {
    for (let x = 0; x < W; x += 37) {
      const o = (y * W + x) * 4
      assert.equal(four.data[o], four.data[o + 1])
      assert.equal(four.data[o], four.data[o + 2])
      assert.equal(four.data[o + 3], 255)
      assert.equal(four.data[o], skewed.data[y * W + x])
    }
  }
})

test('rollingShutterSkew reads a view with a row stride and never the padding between its rows', () => {
  const W = 12
  const H = 6
  const stride = 20
  const padded = new Uint8Array(stride * H).fill(251)
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) padded[y * stride + x] = 10 + x
  const out = rollingShutterSkew({ data: padded, width: W, height: H, channels: 1, rowBytes: stride }, 0)
  assert.equal(out.data.length, W * H)
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) assert.equal(out.data[y * W + x], 10 + x, `(${x}, ${y})`)
  const sheared = rollingShutterSkew({ data: padded, width: W, height: H, channels: 1, rowBytes: stride }, 0.5)
  assert.ok(sheared.data.every((v) => v >= 10 && v <= 21), 'a padding byte (251) reached the output')
})

// ---------------------------------------------------------------------------------------------
// The parity hooks
// ---------------------------------------------------------------------------------------------

function hashOf(image: FiducialImage): string {
  return createHash('sha256').update(image.data).digest('hex')
}

test('parityScenes is a function of its options: the same scenes every time, a different set for another seed, every condition at every range and tilt, then frames with no tag', () => {
  const a = parityScenes({ dictionary: CSCAN5_V1 })
  const b = parityScenes({ dictionary: CSCAN5_V1 })
  assert.equal(a.length, 6 * 3 * 2 + 6)
  assert.deepEqual(a.map((s) => s.name), b.map((s) => s.name))
  assert.deepEqual(a.map((s) => hashOf(s.image)), b.map((s) => hashOf(s.image)))
  assert.deepEqual(a.map((s) => s.tagId), b.map((s) => s.tagId))
  const other = parityScenes({ dictionary: CSCAN5_V1, seed: 2 })
  assert.notDeepEqual(other.map((s) => hashOf(s.image)), a.map((s) => hashOf(s.image)))
  const names = a.map((s) => s.name)
  assert.equal(new Set(names).size, names.length, 'scene names are unique')
  for (const condition of ['clean', 'noise-blur', 'cast-shadow', 'low-light', 'glare', 'rolling-shutter']) {
    for (const range of [1.2, 2, 3]) for (const yaw of [20, 40]) assert.ok(names.includes(`${condition}-r${range}-y${yaw}`), `${condition}-r${range}-y${yaw}`)
  }
  assert.deepEqual(a.filter((s) => s.condition === 'negative').map((s) => s.name), [0, 1, 2, 3, 4, 5].map((i) => `negative-${i}`))
  for (const s of a) {
    assert.equal(s.image.width, 640)
    assert.equal(s.image.height, 480)
    if (s.condition === 'negative') assert.deepEqual([s.family, s.tagId, s.pose, s.truthCorners], [null, null, null, null])
    else {
      assert.equal(s.family, CSCAN5_V1.name)
      assert.ok(s.tagId !== null && s.tagId >= 0 && s.tagId < CSCAN5_V1.size)
      assert.ok(s.truthCorners !== null)
    }
  }
  // Options are honoured.
  const small = parityScenes({ dictionary: CSCAN6_V1, ranges: [1.5], yaws: [30], negatives: 2, sizeM: 0.15 })
  assert.equal(small.length, 6 + 2)
  assert.ok(small.every((s) => s.sizeM === 0.15))
})

test('the truth corners are where the tag is: an independent projection of the pose, in printed order, with the shutter\'s shear added for the rolling-shutter scenes', () => {
  const scenes = parityScenes({ dictionary: CSCAN5_V1, ranges: [1.2], yaws: [20] })
  for (const s of scenes) {
    if (!s.pose || !s.truthCorners) continue
    const h = s.sizeM / 2
    const projected = [[-h, h], [h, h], [h, -h], [-h, -h]].map(([x, y]) => {
      const p = mat3Apply(s.pose!.rotation, { x: x!, y: y!, z: 0 })
      return { x: (500 * (p.x + s.pose!.translation.x)) / (p.z + s.pose!.translation.z) + 320, y: (500 * (p.y + s.pose!.translation.y)) / (p.z + s.pose!.translation.z) + 240 }
    })
    for (let c = 0; c < 4; c++) {
      const want = s.condition === 'rolling-shutter' ? { x: projected[c]!.x + PARITY_SKEW_PX_PER_ROW * (projected[c]!.y - 240), y: projected[c]!.y } : projected[c]!
      assert.ok(Math.hypot(s.truthCorners[c]!.x - want.x, s.truthCorners[c]!.y - want.y) < 1e-9, `${s.name}, corner ${c}`)
    }
  }
})

/** A detector that finds exactly what is in the scene (it is handed the scenes it will be asked about, keyed by their frame). */
function truthDetector(scenes: readonly ParityScene[]): ParityDetector {
  const byImage = new Map<FiducialImage, ParityScene>(scenes.map((s) => [s.image, s]))
  return (image) => {
    const s = byImage.get(image)
    return s && s.tagId !== null && s.truthCorners ? [{ id: s.tagId, corners: s.truthCorners }] : []
  }
}

test('runParity counts what a detector got right and each way it can be wrong: reads, corner error, wrong ids, detections in frames with no tag', () => {
  const scenes = parityScenes({ dictionary: CSCAN5_V1, ranges: [1.2, 2], yaws: [20] })
  const tagScenes = scenes.filter((s) => s.condition !== 'negative')

  const perfect = runParity(truthDetector(scenes), scenes)
  assert.equal(perfect.scenes, scenes.length)
  assert.equal(perfect.tagScenes, tagScenes.length)
  assert.equal(perfect.negativeScenes, 6)
  assert.equal(perfect.recall, 1)
  assert.equal(perfect.wrongIds, 0)
  assert.equal(perfect.falsePositives, 0)
  assert.deepEqual(perfect.worstCornerPx, { median: 0, p95: 0, max: 0 })
  for (const c of ['clean', 'noise-blur', 'cast-shadow', 'low-light', 'glare', 'rolling-shutter']) assert.deepEqual(perfect.byCondition[c], { scenes: 2, read: 2, medianWorstCornerPx: 0 }, c)
  assert.deepEqual(perfect.byCondition['negative'], { scenes: 6, read: 0, medianWorstCornerPx: null })

  // Nothing found: recall 0, no corner statistics.
  const silent = runParity(() => [], scenes)
  assert.equal(silent.recall, 0)
  assert.equal(silent.worstCornerPx, null)
  assert.equal(silent.wrongIds, 0)
  assert.equal(silent.falsePositives, 0)

  // The right tag a known distance off: the corner error is that distance, in the median, the 95th percentile and the worst.
  const byImage = new Map<FiducialImage, ParityScene>(scenes.map((s) => [s.image, s]))
  const shifted: ParityDetector = (image) => {
    const s = byImage.get(image)
    if (!s || s.tagId === null || !s.truthCorners) return []
    const moved = s.truthCorners.map((c, i) => (i === 2 ? { x: c.x + 3, y: c.y + 4 } : c)) as unknown as Quad
    return [{ id: s.tagId, corners: moved }]
  }
  const off = runParity(shifted, scenes)
  assert.equal(off.recall, 1)
  assert.ok(off.worstCornerPx !== null && Math.abs(off.worstCornerPx.median - 5) < 1e-9 && Math.abs(off.worstCornerPx.max - 5) < 1e-9)

  // A wrong id is not a read, and is counted; an extra detection in a frame with no tag is a false positive, in the frame it was made.
  const wrong: ParityDetector = (image) => {
    const s = byImage.get(image)
    if (!s) return [{ id: 1, corners: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }] }]
    if (s.tagId === null || !s.truthCorners) return []
    return [{ id: (s.tagId + 1) % CSCAN5_V1.size, corners: s.truthCorners }]
  }
  const confused = runParity(wrong, scenes)
  assert.equal(confused.recall, 0)
  assert.equal(confused.wrongIds, tagScenes.length)
  assert.equal(confused.falsePositives, 0)
  const spurious: ParityDetector = (image) => {
    const s = byImage.get(image)
    const extra: ParityDetection = { id: 3, corners: [{ x: 10, y: 10 }, { x: 60, y: 10 }, { x: 60, y: 60 }, { x: 10, y: 60 }] }
    return s && s.tagId !== null && s.truthCorners ? [{ id: s.tagId, corners: s.truthCorners }] : [extra, extra]
  }
  const noisy = runParity(spurious, scenes)
  assert.equal(noisy.recall, 1)
  assert.equal(noisy.falsePositives, 12, 'two in each of the six frames with no tag')
  assert.equal(noisy.wrongIds, 0)
})

test('the in-house detector run through the parity hooks, in both families, on the harness\'s own frames: what it reads in each condition, and nothing it should not', () => {
  const families: Array<[Dictionary, Record<string, number>]> = [
    // Measured by this run (synthetic frames, 36 tag scenes and 6 without a tag per family): recall 0.92 (5x5) and 0.89 (6x6), every scene read except some under glare, which
    // hides cells of the code by design (3 of 6 and 2 of 6); no wrong id, nothing in the frames without a tag; the worst corner of a read tag 0.08 px at the median, 0.5 at the 95th
    // percentile, 0.6 at most.
    [CSCAN5_V1, { clean: 6, 'noise-blur': 6, 'cast-shadow': 6, 'low-light': 6, 'rolling-shutter': 6 }],
    [CSCAN6_V1, { clean: 6, 'noise-blur': 6, 'cast-shadow': 6, 'low-light': 6, 'rolling-shutter': 6 }],
  ]
  for (const [dictionary, mustRead] of families) {
    const report = runParity(inHouseParityDetector(dictionary), parityScenes({ dictionary }))
    const label = dictionary.name
    assert.equal(report.tagScenes, 36, label)
    assert.equal(report.negativeScenes, 6, label)
    assert.equal(report.wrongIds, 0, `${label}: a wrong id was read`)
    assert.equal(report.falsePositives, 0, `${label}: a tag was read in a frame with none`)
    for (const [condition, read] of Object.entries(mustRead)) assert.equal(report.byCondition[condition]!.read, read, `${label}: ${condition} read ${report.byCondition[condition]!.read} of 6`)
    // Glare erases code cells on purpose: some scenes are read, and it is the only condition that is not read in full.
    const glare = report.byCondition['glare']!
    assert.ok(glare.read >= 1 && glare.read <= 5, `${label}: glare read ${glare.read} of 6`)
    assert.ok(report.recall >= 0.85 && report.recall < 1, `${label}: recall ${report.recall}`)
    // The corners that were read are where the truth says, with the shear included for the rolling shutter.
    assert.ok(report.worstCornerPx !== null && report.worstCornerPx.median < 0.2 && report.worstCornerPx.p95 < 0.8 && report.worstCornerPx.max < 1, `${label}: ${JSON.stringify(report.worstCornerPx)}`)
    for (const condition of ['clean', 'noise-blur', 'cast-shadow', 'rolling-shutter']) assert.ok(report.byCondition[condition]!.medianWorstCornerPx! < 0.3, `${label}: ${condition} corners ${report.byCondition[condition]!.medianWorstCornerPx}`)
  }
})

test('a rolling-shutter scene is the clean one sheared: its tag is read, and its corners are the sheared truth, not the unsheared one', () => {
  const scenes = parityScenes({ dictionary: CSCAN5_V1, ranges: [1.2], yaws: [20] })
  const skewed = scenes.find((s) => s.condition === 'rolling-shutter')!
  const detect = new FiducialDetector(CSCAN5_V1)
  const found = detect.detect(skewed.image).find((d) => d.id === skewed.tagId)
  assert.ok(found, 'the skewed tag is read')
  const truth = skewed.truthCorners!
  // The unsheared corners (undo the shear on the truth) are a measurable distance away from where the detector says the corners are, which is the shear's whole effect.
  const unsheared = truth.map((c) => ({ x: c.x - PARITY_SKEW_PX_PER_ROW * (c.y - 240), y: c.y }))
  const toTruth = Math.max(...found.corners.map((c, i) => Math.hypot(c.x - truth[i]!.x, c.y - truth[i]!.y)))
  const toUnsheared = Math.max(...found.corners.map((c, i) => Math.hypot(c.x - unsheared[i]!.x, c.y - unsheared[i]!.y)))
  assert.ok(toTruth < 1.5, `the corners are ${toTruth} px from the sheared truth`)
  assert.ok(toUnsheared > toTruth + 0.5, `the unsheared corners (${toUnsheared} px) are not clearly worse than the sheared ones (${toTruth} px)`)
})
