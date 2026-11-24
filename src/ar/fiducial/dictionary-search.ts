/**
 * The seeded search that produced the tag family in `./dictionary.ts`.
 *
 * Not imported by the scanner: it exists so the family is reproducible rather than a table
 * nobody can account for. `tests/unit/node/fiducial_dictionary.test.ts` runs it and compares its
 * output to the frozen table.
 *
 * The search is greedy and random, not optimal: draw a word, keep it if it is far enough from
 * everything kept so far, and from the mirror images of everything kept so far and of itself. For
 * 25-bit words and a 4-way rotation, a minimum distance of 9 yields 35 to 38 ids in 6 million draws
 * with the mirror distance at 5 (measured with four seeds; 36 to 39 without the mirror constraint, so
 * it costs about one id), 10 yields about 22, 8 yields over 100. 32 ids at distance 9 is the largest
 * round family this search reaches comfortably, and a distance of 9 leaves room to correct up to
 * four bit errors while the detector accepts far fewer (see `DEFAULT_MAX_HAMMING` in
 * `./detector.ts`).
 */
import { mulberry32 } from '../../shared/test-homes.ts'
import { flipWord, isingEnergy, MAX_WIDE_CELLS, popcount32, wordRotations } from './dictionary.ts'

export interface FamilyParams {
  name: string
  /** Data cells per side. */
  bits: number
  /** Words to find. The search throws if it cannot find this many within `maxDraws`. */
  count: number
  /** Required Hamming distance between any two (word, rotation) pairs, and between a word and its own rotations. */
  minDistance: number
  /** Required Hamming distance between the mirror image of a word (in any turn) and every word, itself included. */
  minMirrorDistance: number
  /** Fewest and most BLACK cells a word may have. Keeps a code from being nearly all one colour. */
  minOnes: number
  maxOnes: number
  /**
   * The complexity gate: fewest and most pairs of edge-sharing cells that differ (`isingEnergy` in ./dictionary.ts). A
   * code with little of it is a few solid blocks, which merge into the border; one with the most is a checkerboard, the
   * pattern a tiled wall makes. Absent for a family searched before the gate existed (the 5x5 one), so its frozen
   * table, which the gate was never applied to, is still the search's output.
   */
  minEnergy?: number
  maxEnergy?: number
  /** Refuse a word with a row or a column of one colour right across the grid. Absent means allowed. */
  noUniformLine?: boolean
  seed: number
  maxDraws: number
}

/**
 * The parameters behind `CSCAN5_V1`.
 *
 * `minDistance`, `minMirrorDistance`, `minOnes` and `maxOnes` are design choices, not measurements: 9 is
 * the largest distance at which this search reaches 32 ids; 5 keeps a mirrored tag more than the
 * correctable 4 bits from every code; 7..18 black cells of 25 keeps every code visually balanced so no
 * tag is a nearly solid black or white block. `seed` is arbitrary.
 */
export const CSCAN5_V1_PARAMS: FamilyParams = {
  name: 'cscan-5x5-v1',
  bits: 5,
  count: 32,
  minDistance: 9,
  minMirrorDistance: 5,
  minOnes: 7,
  maxOnes: 18,
  seed: 0xc5ca4,
  maxDraws: 6_000_000,
}

export function searchFamily(params: FamilyParams): number[] {
  const { bits, count, minDistance, minMirrorDistance, minOnes, maxOnes, seed, maxDraws } = params
  const cells = bits * bits
  if (cells > 31) throw new Error('searchFamily draws 31-bit words at most')
  const rand = mulberry32(seed)
  const words: number[] = []
  const rotated: Array<[number, number, number, number]> = []

  for (let draw = 0; draw < maxDraws && words.length < count; draw++) {
    const word = Math.floor(rand() * 2 ** cells) >>> 0
    const ones = popcount32(word)
    if (ones < minOnes || ones > maxOnes) continue

    const mine = wordRotations(word, bits)
    const mirrored = wordRotations(flipWord(word, bits), bits)
    let ok = true
    for (let k = 1; k < 4 && ok; k++) if (popcount32(word ^ mine[k]!) < minDistance) ok = false
    // Its own mirror image, in any turn, must not be mistakable for it.
    for (let k = 0; k < 4 && ok; k++) if (popcount32(word ^ mirrored[k]!) < minMirrorDistance) ok = false
    for (let i = 0; i < words.length && ok; i++) {
      const other = rotated[i]!
      for (let k = 0; k < 4; k++) {
        if (popcount32(word ^ other[k]!) < minDistance || popcount32(mirrored[k]! ^ words[i]!) < minMirrorDistance) {
          ok = false
          break
        }
      }
    }
    if (!ok) continue
    words.push(word)
    rotated.push(mine)
  }
  if (words.length < count) {
    throw new Error(`${params.name}: found ${words.length} of ${count} words in ${maxDraws} draws`)
  }
  return words
}

/**
 * The parameters behind `CSCAN6_V1` (./dictionary.ts): the 6x6 family, 36 bits a word.
 *
 * `minDistance` 12 is R1's choice (WP-14b research notes): the false-accept chance of a random grid read one bit
 * loosely is then 2.8e-7 per quad that reached the matcher for these 128 words (128 words x 4 turns x 37 grids within one bit,
 * over 2^36; R1's 3.1e-7 was for its 146), against the 1e-6 gate, where the 5x5 family's 9 gives 9.9e-5. `minMirrorDistance` 6 is one more
 * than the 5 bit errors the family corrects, so a mirrored tag is refused at every ceiling up to the correctable limit, as the 5x5
 * family's 5 does for its 4. The balance bounds (12 to 24 black cells of 36, a third to two thirds), the energy bounds (22 to 38 of
 * the 60 neighbouring pairs, where a random word has 30 and a spread of about four) and the rule against a row or column of
 * one colour keep a code from being mostly one colour, a few solid blocks, a checkerboard or a bar across it: together they
 * discard about one random word in three (the balance and energy bounds alone about one in eighteen, counted on two million words)
 * and cost the search very little. `count` is what the search reaches comfortably:
 * R1 found 146 at distance 12 without the mirror and energy gates, in 12 seconds of random drawing in Python.
 * All of these are design choices, not measurements; `seed` is arbitrary. The family is not final: DX8 decides it
 * (`DEFAULT_TAG_FAMILY` in ./families.ts), before any sheet is issued.
 */
export const CSCAN6_V1_PARAMS: FamilyParams = {
  name: 'cscan-6x6-v1',
  bits: 6,
  count: 128,
  minDistance: 12,
  minMirrorDistance: 6,
  minOnes: 12,
  maxOnes: 24,
  minEnergy: 22,
  maxEnergy: 38,
  noUniformLine: true,
  seed: 0xc5ca6,
  maxDraws: 8_000_000,
}

/** What a wide search found, and how many draws it took. */
export interface WideSearchResult {
  words: bigint[]
  draws: number
}

/**
 * The same greedy random search for a grid of 33 to 64 cells, which a 32-bit word cannot hold. Each word is two 32-bit
 * halves while it is searched (the candidate's rotations and mirror images are made by moving cells, and every
 * distance is two `popcount32`s), and the words come back as `bigint`s, which is what `createWideDictionary` takes.
 *
 * Deterministic: a draw is two uniform numbers from `mulberry32(seed)` (32 bits for the low half, the rest for the high
 * half), so the same parameters give the same words on every machine. Throws if `count` words are not found within
 * `maxDraws`.
 */
export function searchWideFamily(params: FamilyParams): WideSearchResult {
  const { bits, count, minDistance, minMirrorDistance, minOnes, maxOnes, seed, maxDraws } = params
  const cells = bits * bits
  if (!Number.isInteger(bits) || cells <= 32 || cells > MAX_WIDE_CELLS) throw new Error('searchWideFamily searches 33 to 64 cells; use searchFamily for fewer')
  const rand = mulberry32(seed)
  const hiBits = cells - 32
  const hiSpan = 2 ** hiBits

  // Where a cell goes under one quarter turn clockwise, and under a mirror: the same moves as rotateWordClockwise and flipWord.
  const turnTo = new Int32Array(cells)
  const mirrorTo = new Int32Array(cells)
  for (let r = 0; r < bits; r++) {
    for (let c = 0; c < bits; c++) {
      turnTo[r * bits + c] = c * bits + (bits - 1 - r)
      mirrorTo[r * bits + c] = r * bits + (bits - 1 - c)
    }
  }
  const cellOf = (lo: number, hi: number, i: number): number => (i < 32 ? (lo >>> i) & 1 : (hi >>> (i - 32)) & 1)
  const move = (lo: number, hi: number, to: Int32Array): [number, number] => {
    let nlo = 0
    let nhi = 0
    for (let i = 0; i < cells; i++) {
      if (!cellOf(lo, hi, i)) continue
      const d = to[i]!
      if (d < 32) nlo |= 1 << d
      else nhi |= 1 << (d - 32)
    }
    return [nlo >>> 0, nhi >>> 0]
  }

  const keptLo = new Uint32Array(count * 4)
  const keptHi = new Uint32Array(count * 4)
  const pattern = new Uint8Array(cells)
  let kept = 0
  let draw = 0
  for (; draw < maxDraws && kept < count; draw++) {
    const lo = Math.floor(rand() * 4294967296) >>> 0
    const hi = Math.floor(rand() * hiSpan) >>> 0
    const ones = popcount32(lo) + popcount32(hi)
    if (ones < minOnes || ones > maxOnes) continue
    for (let i = 0; i < cells; i++) pattern[i] = cellOf(lo, hi, i)
    if (params.minEnergy !== undefined || params.maxEnergy !== undefined) {
      const e = isingEnergy(pattern, bits)
      if (e < (params.minEnergy ?? 0) || e > (params.maxEnergy ?? Infinity)) continue
    }
    if (params.noUniformLine) {
      let uniform = false
      for (let a = 0; a < bits && !uniform; a++) {
        let rowOnes = 0
        let colOnes = 0
        for (let b = 0; b < bits; b++) {
          rowOnes += pattern[a * bits + b]!
          colOnes += pattern[b * bits + a]!
        }
        uniform = rowOnes === 0 || rowOnes === bits || colOnes === 0 || colOnes === bits
      }
      if (uniform) continue
    }

    // The word's own four turns, and the four turns of its mirror image.
    const myLo = [lo, 0, 0, 0]
    const myHi = [hi, 0, 0, 0]
    for (let k = 1; k < 4; k++) [myLo[k], myHi[k]] = move(myLo[k - 1]!, myHi[k - 1]!, turnTo) as [number, number]
    const [mlo0, mhi0] = move(lo, hi, mirrorTo)
    const mirLo = [mlo0, 0, 0, 0]
    const mirHi = [mhi0, 0, 0, 0]
    for (let k = 1; k < 4; k++) [mirLo[k], mirHi[k]] = move(mirLo[k - 1]!, mirHi[k - 1]!, turnTo) as [number, number]

    let ok = true
    for (let k = 1; k < 4 && ok; k++) if (popcount32(lo ^ myLo[k]!) + popcount32(hi ^ myHi[k]!) < minDistance) ok = false
    for (let k = 0; k < 4 && ok; k++) if (popcount32(lo ^ mirLo[k]!) + popcount32(hi ^ mirHi[k]!) < minMirrorDistance) ok = false
    for (let i = 0; i < kept && ok; i++) {
      for (let k = 0; k < 4; k++) {
        const klo = keptLo[i * 4 + k]!
        const khi = keptHi[i * 4 + k]!
        if (popcount32(lo ^ klo) + popcount32(hi ^ khi) < minDistance || popcount32(mirLo[k]! ^ keptLo[i * 4]!) + popcount32(mirHi[k]! ^ keptHi[i * 4]!) < minMirrorDistance) {
          ok = false
          break
        }
      }
    }
    if (!ok) continue
    for (let k = 0; k < 4; k++) {
      keptLo[kept * 4 + k] = myLo[k]!
      keptHi[kept * 4 + k] = myHi[k]!
    }
    kept++
  }
  if (kept < count) throw new Error(`${params.name}: found ${kept} of ${count} words in ${maxDraws} draws`)
  const words: bigint[] = []
  for (let i = 0; i < kept; i++) words.push((BigInt(keptHi[i * 4]!) << 32n) | BigInt(keptLo[i * 4]!))
  return { words, draws: draw }
}
