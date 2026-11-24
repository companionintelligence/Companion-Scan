#!/usr/bin/env node
/**
 * Regenerates, or checks, the frozen word table of the wide tag family `cscan-6x6-v1` (src/ar/fiducial/dictionary.ts).
 *
 *   node --experimental-strip-types --no-warnings scripts/gen-fiducial-family.mjs [--out <file>]
 *   node --experimental-strip-types --no-warnings scripts/gen-fiducial-family.mjs --check
 *
 * The table is the output of a seeded random search (`searchWideFamily(CSCAN6_V1_PARAMS)`, src/ar/fiducial/dictionary-search.ts):
 * the seed, the count, the minimum Hamming distance between any two (code, rotation) pairs, the mirror distance and the
 * complexity gate are all in `CSCAN6_V1_PARAMS`, and the same parameters give the same words on every machine and every
 * run. No clock, no randomness beyond the seeded generator, nothing downloaded.
 *
 * Without --check it writes the TypeScript text of the table (to standard output, or to --out) and a report on standard
 * error: how many words, how many draws it took, and the distances MEASURED on the result by comparing every pair (the
 * report never repeats a parameter as though it were a result). Paste the table into dictionary.ts as
 * `CSCAN6_V1_WORDS`.
 *
 * With --check it runs the search again and compares the words with the ones the repository holds (as the dictionary's own
 * `pattern()` gives them). Exit status: 0 the table is what the search produces; 1 it is not (the first difference is
 * named); 2 the command could not run (a bad option).
 *
 * Needs --experimental-strip-types: it imports TypeScript, with no namespace or enum in it (the QR encoder that
 * print-fiducial.mjs needs is not involved here).
 */
import { writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import process from 'node:process'
import { CSCAN6_V1, wideFamilyMinDistance, wideFamilyMinMirrorDistance } from '../src/ar/fiducial/dictionary.ts'
import { CSCAN6_V1_PARAMS, searchWideFamily } from '../src/ar/fiducial/dictionary-search.ts'

/** Words per line of the printed table: four 9-digit hexadecimal words and their separators fit a line of 90 columns. */
const WORDS_PER_LINE = 4

/**
 * The text of the table, as it is written into dictionary.ts: one `0x…n` literal per word, 36 bits being nine
 * hexadecimal digits, `WORDS_PER_LINE` to a line. Pure: the same words give the same bytes.
 *
 * @param {readonly bigint[]} words
 * @param {number} bits data cells per side
 */
export function renderWordsTable(words, bits) {
  const digits = Math.ceil((bits * bits) / 4)
  const lines = []
  for (let i = 0; i < words.length; i += WORDS_PER_LINE) {
    lines.push('  ' + words.slice(i, i + WORDS_PER_LINE).map((w) => `0x${w.toString(16).padStart(digits, '0')}n,`).join(' '))
  }
  return lines.join('\n') + '\n'
}

/** The words of a dictionary, read back from its patterns (bit i of a word is cell i, as dictionary.ts documents). */
export function wordsOf(dictionary) {
  const out = []
  for (let id = 0; id < dictionary.size; id++) {
    let w = 0n
    const pattern = dictionary.pattern(id)
    for (let i = 0; i < pattern.length; i++) if (pattern[i]) w |= 1n << BigInt(i)
    out.push(w)
  }
  return out
}

/**
 * Run the search and compare it with the repository's table.
 * @returns {{ same: boolean, firstDifference: string | null, words: bigint[], draws: number, minDistance: number, minMirrorDistance: number }}
 */
export function checkFamily() {
  const { words, draws } = searchWideFamily(CSCAN6_V1_PARAMS)
  const held = wordsOf(CSCAN6_V1)
  let firstDifference = null
  if (held.length !== words.length) firstDifference = `the repository holds ${held.length} words, the search gives ${words.length}`
  else {
    for (let i = 0; i < words.length; i++) {
      if (held[i] !== words[i]) {
        firstDifference = `id ${i}: the repository holds 0x${held[i].toString(16)}, the search gives 0x${words[i].toString(16)}`
        break
      }
    }
  }
  return {
    same: firstDifference === null,
    firstDifference,
    words,
    draws,
    minDistance: wideFamilyMinDistance(words, CSCAN6_V1_PARAMS.bits),
    minMirrorDistance: wideFamilyMinMirrorDistance(words, CSCAN6_V1_PARAMS.bits),
  }
}

function usage() {
  return [
    'usage: node --experimental-strip-types --no-warnings scripts/gen-fiducial-family.mjs [--check] [--out <file>]',
    '',
    '  (no option)  write the TypeScript table for cscan-6x6-v1 to standard output and a report to standard error',
    '  --out        write the table to this file instead of standard output',
    '  --check      search again and compare with the table in src/ar/fiducial/dictionary.ts; exit 1 if they differ',
  ].join('\n')
}

async function main() {
  const argv = process.argv.slice(2)
  let check = false
  let out = null
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--check') check = true
    else if (a === '--out') {
      out = argv[++i]
      if (out === undefined) {
        console.error(`--out needs a file\n\n${usage()}`)
        process.exit(2)
      }
    } else if (a === '--help' || a === '-h') {
      console.log(usage())
      return
    } else {
      console.error(`unknown argument ${a}\n\n${usage()}`)
      process.exit(2)
    }
  }
  const result = checkFamily()
  const report =
    `${CSCAN6_V1_PARAMS.name}: ${result.words.length} words in ${result.draws} draws (seed 0x${CSCAN6_V1_PARAMS.seed.toString(16)}); ` +
    `measured minimum distance ${result.minDistance}, mirror distance ${result.minMirrorDistance}`
  if (check) {
    if (result.same) {
      console.log(`${report}\nthe table in src/ar/fiducial/dictionary.ts is what the search produces`)
      return
    }
    console.error(`${report}\nthe table in src/ar/fiducial/dictionary.ts differs from the search: ${result.firstDifference}`)
    process.exit(1)
  }
  const text = renderWordsTable(result.words, CSCAN6_V1_PARAMS.bits)
  if (out) writeFileSync(out, text)
  else process.stdout.write(text)
  console.error(report)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main()
}
