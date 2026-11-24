/**
 * The 36-bit tag family `cscan-6x6-v1` (WP-14a amendment) and the support for words wider than 32 bits behind it.
 *
 * Nothing in here trusts the module it checks. The distance property is recomputed by building each code as a grid, turning and
 * mirroring the grid by moving cells, and counting the cells that differ, over every pair, with none of the dictionary's own rotation,
 * popcount or halves code. The complexity gate is recomputed from the grid. The false-accept arithmetic the family is chosen for is checked
 * against a count: 200 000 random grids, matched at a loose ceiling where the chance is large enough to measure, agree with
 * the formula that gives the 2.8e-7 at one bit.
 *
 * Run: node --experimental-strip-types --no-warnings --test tests/unit/node/fiducial_family36.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { CSCAN5_V1, CSCAN6_V1, createWideDictionary, isingEnergy, popcountWide, wideFamilyMinDistance, wideFamilyMinMirrorDistance, createDictionary } from '../../../src/ar/fiducial/dictionary.ts'
import { CSCAN6_V1_PARAMS, searchWideFamily } from '../../../src/ar/fiducial/dictionary-search.ts'
import { DEFAULT_TAG_FAMILY, DEFAULT_TAG_FAMILY_NAME, TAG_FAMILIES, detectionQuadM, tagFamilyByName } from '../../../src/ar/fiducial/families.ts'
import { FiducialDetector } from '../../../src/ar/fiducial/detector.ts'
import { mulberry32 } from '../../../src/shared/test-homes.ts'
import { INTRINSICS_640, renderTag, tagPose } from '../../support/fiducial-render.ts'
import { checkFamily, renderWordsTable, wordsOf } from '../../../scripts/gen-fiducial-family.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const BITS = 6

type Grid = number[][]

function toGrid(pattern: ArrayLike<number>): Grid {
  const g: Grid = []
  for (let r = 0; r < BITS; r++) g.push(Array.from({ length: BITS }, (_, c) => pattern[r * BITS + c]!))
  return g
}

/** A quarter turn clockwise: what was the left column, read bottom to top, becomes the top row. */
function turnClockwise(g: Grid): Grid {
  const out: Grid = []
  for (let r = 0; r < BITS; r++) out.push(Array.from({ length: BITS }, (_, c) => g[BITS - 1 - c]![r]!))
  return out
}

function mirrorGrid(g: Grid): Grid {
  return g.map((row) => row.slice().reverse())
}

function differing(a: Grid, b: Grid): number {
  let n = 0
  for (let r = 0; r < BITS; r++) for (let c = 0; c < BITS; c++) if (a[r]![c] !== b[r]![c]) n++
  return n
}

const GRIDS: Grid[] = Array.from({ length: CSCAN6_V1.size }, (_, id) => toGrid(CSCAN6_V1.pattern(id)))

test('the frozen table is exactly what the seeded search produces, and the search is deterministic', () => {
  const a = searchWideFamily(CSCAN6_V1_PARAMS)
  const b = searchWideFamily(CSCAN6_V1_PARAMS)
  assert.deepEqual(a.words, b.words)
  assert.equal(a.words.length, CSCAN6_V1.size)
  assert.equal(CSCAN6_V1.size, CSCAN6_V1_PARAMS.count)
  for (let id = 0; id < a.words.length; id++) {
    const fromWord = new Uint8Array(36)
    for (let i = 0; i < 36; i++) fromWord[i] = Number((a.words[id]! >> BigInt(i)) & 1n)
    assert.deepEqual(Array.from(CSCAN6_V1.pattern(id)), Array.from(fromWord), `id ${id} drifted from the search's output`)
  }
  // A different seed is a different family: the seed is what the table is a function of.
  assert.notDeepEqual(searchWideFamily({ ...CSCAN6_V1_PARAMS, seed: CSCAN6_V1_PARAMS.seed + 1 }).words, a.words)
})

test('the minimum distance is at least 12, measured from scratch by comparing every pair of (code, turn) cell by cell', () => {
  assert.ok(CSCAN6_V1.size >= 128, `${CSCAN6_V1.size} ids`)
  let min = Infinity
  for (let a = 0; a < GRIDS.length; a++) {
    const rotations: Grid[] = []
    let turned = GRIDS[a]!
    for (let k = 0; k < 4; k++) {
      rotations.push(turned)
      turned = turnClockwise(turned)
    }
    for (let b = a; b < GRIDS.length; b++) {
      for (let k = 0; k < 4; k++) {
        if (a === b && k === 0) continue
        min = Math.min(min, differing(GRIDS[b]!, rotations[k]!))
      }
    }
  }
  assert.ok(min >= 12, `minimum distance is ${min}`)
  assert.equal(CSCAN6_V1.minDistance, min, 'the dictionary reports a distance it does not have')
  assert.equal(CSCAN6_V1.maxCorrectableBits, Math.floor((min - 1) / 2))
  assert.equal(CSCAN6_V1.maxCorrectableBits, 5)
  // The module's own helpers over bigints agree with the scratch measurement.
  const words = wordsOf(CSCAN6_V1) as bigint[]
  assert.equal(wideFamilyMinDistance(words, BITS), min)
})

test('no code can be taken for a mirror image: the mirror of every code, turned any way, is at least 6 bits from every code, itself included', () => {
  let min = Infinity
  for (let a = 0; a < GRIDS.length; a++) {
    let mirrored = mirrorGrid(GRIDS[a]!)
    for (let k = 0; k < 4; k++) {
      for (let b = 0; b < GRIDS.length; b++) min = Math.min(min, differing(mirrored, GRIDS[b]!))
      mirrored = turnClockwise(mirrored)
    }
  }
  assert.ok(min >= 6, `the closest mirror is ${min} bits from a code`)
  assert.equal(CSCAN6_V1.minMirrorDistance, min, 'the dictionary reports a mirror distance it does not have')
  assert.ok(CSCAN6_V1.minMirrorDistance > CSCAN6_V1.maxCorrectableBits, 'a mirrored tag is refused at every ceiling up to the correctable limit')
  assert.equal(wideFamilyMinMirrorDistance(wordsOf(CSCAN6_V1) as bigint[], BITS), min)
  for (let id = 0; id < CSCAN6_V1.size; id++) {
    let g = mirrorGrid(GRIDS[id]!)
    for (let k = 0; k < 4; k++) {
      assert.equal(CSCAN6_V1.match(g.flat(), CSCAN6_V1.maxCorrectableBits), null, `the mirror of ${id} turned ${k} was matched`)
      g = turnClockwise(g)
    }
  }
})

test('the complexity gate holds for every code: balanced, neither blocky nor a checkerboard, no row or column of one colour', () => {
  const energyOf = (g: Grid): number => {
    let e = 0
    for (let r = 0; r < BITS; r++) {
      for (let c = 0; c < BITS; c++) {
        if (c + 1 < BITS && g[r]![c] !== g[r]![c + 1]) e++
        if (r + 1 < BITS && g[r]![c] !== g[r + 1]![c]) e++
      }
    }
    return e
  }
  for (let id = 0; id < GRIDS.length; id++) {
    const g = GRIDS[id]!
    const ones = g.flat().reduce((s, v) => s + v, 0)
    assert.ok(ones >= CSCAN6_V1_PARAMS.minOnes && ones <= CSCAN6_V1_PARAMS.maxOnes, `id ${id}: ${ones} black cells`)
    const e = energyOf(g)
    assert.ok(e >= CSCAN6_V1_PARAMS.minEnergy! && e <= CSCAN6_V1_PARAMS.maxEnergy!, `id ${id}: energy ${e}`)
    assert.equal(isingEnergy(CSCAN6_V1.pattern(id), BITS), e, `id ${id}: the module's energy is not the scratch one`)
    for (let a = 0; a < BITS; a++) {
      const row = g[a]!.reduce((s, v) => s + v, 0)
      const col = g.reduce((s, r) => s + r[a]!, 0)
      assert.ok(row > 0 && row < BITS && col > 0 && col < BITS, `id ${id}: row or column ${a} is one colour`)
    }
  }
  // The gate does something: a word that is a solid block, and one that is a checkerboard, are outside it.
  assert.ok(isingEnergy(new Uint8Array(36).fill(1), BITS) < CSCAN6_V1_PARAMS.minEnergy!)
  const checker = new Uint8Array(36).map((_, i) => ((Math.floor(i / 6) + (i % 6)) % 2) as 0 | 1)
  assert.ok(isingEnergy(checker, BITS) > CSCAN6_V1_PARAMS.maxEnergy!)
})

test('match names every code at every turn with up to 5 bit errors, and nothing else', () => {
  const rand = mulberry32(36)
  for (let id = 0; id < CSCAN6_V1.size; id += 3) {
    let g = GRIDS[id]!
    for (let k = 0; k < 4; k++) {
      // The observed grid is the printed one turned k times: the match must say k.
      const exact = CSCAN6_V1.match(g.flat(), 5)
      assert.deepEqual(exact, { id, rotation: k, hamming: 0 }, `id ${id} turned ${k}`)
      for (const flips of [1, 3, 5]) {
        const noisy = g.flat().slice()
        const idx = new Set<number>()
        while (idx.size < flips) idx.add(Math.floor(rand() * 36))
        for (const i of idx) noisy[i] = noisy[i]! ? 0 : 1
        assert.deepEqual(CSCAN6_V1.match(noisy, 5), { id, rotation: k, hamming: flips }, `id ${id} turned ${k}, ${flips} cells flipped`)
        assert.equal(CSCAN6_V1.match(noisy, flips - 1), null, 'a ceiling below the errors refuses it')
      }
      // Six flips are more than the family corrects: refused at its own ceiling (a grid 6 from one code is at least 6 from every other).
      const six = g.flat().slice()
      for (const i of [0, 7, 14, 21, 28, 35]) six[i] = six[i]! ? 0 : 1
      assert.equal(CSCAN6_V1.match(six, 5), null, 'six cells flipped')
      g = turnClockwise(g)
    }
  }
  // A grid of the wrong size is nothing.
  assert.equal(CSCAN6_V1.match(new Array(25).fill(0), 5), null)
})

test('the false-accept arithmetic the family was chosen for holds: random grids match at a loose ceiling as often as the counting says', () => {
  // The chance that a random 36-bit grid is within h bits of some (code, turn): codes x 4 x (sum of C(36, k) for k <= h) / 2^36. At h = 1 and 128
  // codes that is 2.8e-7 per grid: too rare to measure here. At h = 5 it is 3.3e-3, which 200 000 grids measure to a few per cent, and it is the same formula.
  let balls = 0
  let c = 1
  for (let k = 0; k <= 5; k++) {
    balls += c
    c = (c * (36 - k)) / (k + 1)
  }
  const expectedRate = (CSCAN6_V1.size * 4 * balls) / 2 ** 36
  const rand = mulberry32(2024)
  const grid = new Uint8Array(36)
  let matched = 0
  const N = 200_000
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < 36; j++) grid[j] = rand() < 0.5 ? 1 : 0
    if (CSCAN6_V1.match(grid, 5)) matched++
  }
  const expected = expectedRate * N
  assert.ok(Math.abs(matched - expected) < 4 * Math.sqrt(expected), `${matched} matches in ${N} random grids, expected ${expected.toFixed(0)} +- ${Math.sqrt(expected).toFixed(0)}`)
  // And the figure for the default tolerance, from the same formula.
  const atOneBit = (CSCAN6_V1.size * 4 * 37) / 2 ** 36
  assert.ok(Math.abs(atOneBit - 2.757e-7) < 1e-9, `${atOneBit} per grid at one bit: 128 words x 4 turns x 37 grids over 2^36 (R1's 3.1e-7 was for 146 words)`)
  assert.ok(atOneBit < 1e-6, 'under the WP-14b gate of 1e-6 per candidate quad')
  const registered = (CSCAN6_V1.size * 4 * 1) / 2 ** 36
  assert.ok(registered < 1e-8, `${registered} per grid with no bit errors accepted`)
  // The 5x5 family at its own default of one bit: about 1e-4, which is why the 36-bit family exists.
  const five = (CSCAN5_V1.size * 4 * 26) / 2 ** 25
  assert.ok(five > 9e-5 && five < 1.1e-4, `${five} for the 5x5 family at one bit`)
})

test('wide families refuse what is not one: grid sizes, duplicate or oversized words, a family of one', () => {
  const ok = [0xf7bb26166n, 0xa79912b61n]
  assert.doesNotThrow(() => createWideDictionary('x', 6, ok))
  assert.throws(() => createWideDictionary('x', 5, [1n, 2n]), /not a wide family/)
  assert.throws(() => createWideDictionary('x', 9, [1n, 2n]), /not a wide family/)
  assert.throws(() => createWideDictionary('x', 6, [1n, 1n]), /appears twice/)
  assert.throws(() => createWideDictionary('x', 6, [1n, 1n << 36n]), /not a 36-bit word/)
  assert.throws(() => createWideDictionary('x', 6, [-1n, 2n]), /not a 36-bit word/)
  assert.throws(() => createWideDictionary('x', 6, [1n]), /at least two/)
  // A code that is its own rotation is one pattern four times over: refused, as in the narrow case.
  const uniform = 0xfffffffffn
  assert.throws(() => createWideDictionary('x', 6, [uniform, 3n]), /same pattern once rotated/)
  // The narrow builder still refuses a wide grid and says where to go.
  assert.throws(() => createDictionary('x', 6, [1, 2]), /does not fit a 32-bit word/)
  assert.equal(popcountWide((1n << 35n) | 1n), 2)
  assert.equal(popcountWide(0xfffffffffn), 36)
  assert.throws(() => CSCAN6_V1.pattern(CSCAN6_V1.size), RangeError)
})

test('the registry names both families and one default, and converts a printed size to the quad the detector measures', () => {
  assert.equal(DEFAULT_TAG_FAMILY_NAME, 'cscan-6x6-v1')
  assert.equal(DEFAULT_TAG_FAMILY.dictionary, CSCAN6_V1)
  assert.equal(tagFamilyByName('cscan-5x5-v1')?.dictionary, CSCAN5_V1)
  assert.equal(tagFamilyByName('tag36h11'), null)
  assert.equal(tagFamilyByName('__proto__'), null)
  assert.deepEqual(TAG_FAMILIES.map((f) => f.dictionary.name), ['cscan-6x6-v1', 'cscan-5x5-v1'])
  assert.deepEqual(TAG_FAMILIES.map((f) => f.cells), [8, 7])
  // The printed size is the outer edge of the black ring, which is the quad, for both: the fraction is 1.
  for (const f of TAG_FAMILIES) assert.equal(f.quadFraction, 1)
  assert.equal(detectionQuadM(DEFAULT_TAG_FAMILY, 200), 0.2)
  assert.ok(Math.abs(detectionQuadM({ ...DEFAULT_TAG_FAMILY, quadFraction: 0.8 }, 200) - 0.16) < 1e-12, 'a family whose quad is 8 of 10 cells converts')
})

test('the detector reads the 36-bit family: every fifth id at all four turns and two ranges, the right id and corners in printed order, no wrong id', () => {
  const det = new FiducialDetector(CSCAN6_V1)
  let read = 0
  let total = 0
  let wrong = 0
  for (let id = 0; id < CSCAN6_V1.size; id += 5) {
    for (const spin of [0, 90, 180, 270]) {
      for (const z of [1.5, 2.5]) {
        const pose = tagPose({ x: 0.04, y: -0.03, z }, spin + ((id * 7) % 20), ((id * 11) % 40) - 20, ((id * 5) % 20) - 10)
        const found = det.detect(renderTag({ dictionary: CSCAN6_V1, id, sizeM: 0.2, pose, intrinsics: INTRINSICS_640, noiseSigma: 2, blurSigma: 0.6, seed: id * 4 + spin / 90 + 1, supersample: 3 }))
        total++
        if (found.some((d) => d.id !== id)) wrong++
        const hit = found.find((d) => d.id === id)
        if (!hit) continue
        read++
        // Corners in printed order: the first corner is the tag's printed top-left, wherever it turned to.
        const h = 0.1
        const truth = [[-h, h], [h, h], [h, -h], [-h, -h]].map(([x, y]) => {
          const R = pose.rotation
          const px = R[0]! * x! + R[1]! * y! + pose.translation.x
          const py = R[3]! * x! + R[4]! * y! + pose.translation.y
          const pz = R[6]! * x! + R[7]! * y! + pose.translation.z
          return { x: (500 * px) / pz + 320, y: (500 * py) / pz + 240 }
        })
        for (let c = 0; c < 4; c++) assert.ok(Math.hypot(hit.corners[c]!.x - truth[c]!.x, hit.corners[c]!.y - truth[c]!.y) < 0.6, `id ${id}, spin ${spin}, z ${z}, corner ${c}`)
        assert.equal(hit.family, 'cscan-6x6-v1')
      }
    }
  }
  assert.equal(wrong, 0)
  assert.ok(read >= total - 4, `${read} of ${total} read`)
})

test('the generator script reproduces the table: --check exits 0, its table text is the module\'s, and checkFamily says so', () => {
  const check = checkFamily()
  assert.equal(check.same, true, check.firstDifference ?? '')
  assert.ok(check.minDistance >= 12 && check.minMirrorDistance >= 6)
  assert.equal(renderWordsTable(check.words, BITS), renderWordsTable(wordsOf(CSCAN6_V1) as bigint[], BITS))
  const out = execFileSync(process.execPath, ['--experimental-strip-types', '--no-warnings', join(ROOT, 'scripts', 'gen-fiducial-family.mjs'), '--check'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  assert.match(out, /128 words in \d+ draws \(seed 0xc5ca6\); measured minimum distance 12, mirror distance 6/)
  assert.match(out, /is what the search produces/)
  // Without --check it prints the table: nine hexadecimal digits a word, four to a line, byte for byte what the module's words render to.
  const table = execFileSync(process.execPath, ['--experimental-strip-types', '--no-warnings', join(ROOT, 'scripts', 'gen-fiducial-family.mjs')], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  assert.equal(table, renderWordsTable(wordsOf(CSCAN6_V1) as bigint[], BITS))
  assert.equal(table.split('\n').filter(Boolean).length, 32)
  assert.match(table.split('\n')[0]!, /^ {2}0x[0-9a-f]{9}n, 0x[0-9a-f]{9}n, 0x[0-9a-f]{9}n, 0x[0-9a-f]{9}n,$/)
})
