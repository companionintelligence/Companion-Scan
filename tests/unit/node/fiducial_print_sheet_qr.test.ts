/**
 * The print sheet with the repo's REAL QR renderer: the byte-for-byte snapshots, the modules of the code
 * against the vendored encoder's, and the command line.
 *
 * `src/ui/qr-code.ts` sits on the vendored Nayuki encoder, which uses a TypeScript namespace that Node's type
 * stripping cannot load, so both are compiled first (scripts/lib/qr-code-compiled.mjs). The geometry, the page
 * choice, the printed cells and the detector round trip are in `fiducial_print_sheet.test.ts`, with a stub QR.
 *
 * Snapshots live in `tests/unit/node/fiducial-sheet/`. To rewrite them after an intended change:
 * `UPDATE_FIDUCIAL_SNAPSHOT=1 node --test tests/unit/node/fiducial_print_sheet_qr.test.ts`
 * and read the diff: a snapshot that changes for no reason is a sheet that changed for no reason.
 *
 * Run: node --test tests/unit/node/fiducial_print_sheet_qr.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildSheet, buildTwoTagSheet } from '../../../scripts/print-fiducial.mjs'
import { CSCAN5_V1 } from '../../../src/ar/fiducial/dictionary.ts'
import { loadCompiledQrCode } from '../../../scripts/lib/qr-code-compiled.mjs'
import { serializeTagPayload } from '../../../src/ar/fiducial/payload.ts'
import { assertBalancedSvg, parseSheet } from '../../support/fiducial-sheet.ts'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const ROOT = join(HERE, '..', '..', '..')
const SNAPSHOTS = join(HERE, 'fiducial-sheet')
const SCRIPT = join(ROOT, 'scripts', 'print-fiducial.mjs')

/** The repo's renderer and the vendored encoder, compiled as the bundle compiles them (scripts/lib/qr-code-compiled.mjs). */
const { qrCodeSvg, qrcodegen } = await loadCompiledQrCode()

/** The 5x5 family, as the first two snapshots were made; the generator's default is the 6x6 family now (see `sheet6` and `pair`). */
function sheet(args: Partial<Parameters<typeof buildSheet>[0]> = {}) {
  return buildSheet({ tagId: 7, sizeMm: 120, placeId: 'place-kitchen-1', roomId: 'room-a', page: 'a4', dictionary: CSCAN5_V1, qrSvg: qrCodeSvg, ...args })
}

function sheet6(args: Partial<Parameters<typeof buildSheet>[0]> = {}) {
  return buildSheet({ tagId: 7, sizeMm: 140, placeId: 'place-kitchen-1', roomId: 'room-a', page: 'a4', qrSvg: qrCodeSvg, ...args })
}

function pair(args: Partial<Parameters<typeof buildTwoTagSheet>[0]> = {}) {
  return buildTwoTagSheet({ tagIds: [3, 4], spacingMm: 500, sizeMm: 150, placeId: 'place-hall-9', roomId: null, page: 'a1', mount: 'wall', mountHeightMm: 1200, qrSvg: qrCodeSvg, ...args })
}

function snapshotMatches(name: string, svg: string) {
  const file = join(SNAPSHOTS, name)
  if (process.env['UPDATE_FIDUCIAL_SNAPSHOT'] === '1') {
    writeFileSync(file, svg)
    return
  }
  assert.ok(existsSync(file), `${file} is missing: run once with UPDATE_FIDUCIAL_SNAPSHOT=1 and read it`)
  const expected = readFileSync(file, 'utf8')
  assert.equal(svg === expected, true, `${name} differs from its snapshot (first difference at byte ${[...svg].findIndex((c, i) => c !== expected[i])})`)
}

test('snapshot: a 120 mm tag on A4 and a 200 mm tag on A3 (5x5 family), a 140 mm tag of the 6x6 family on A4, and a pair of 150 mm tags 500 mm apart on A1, are byte-for-byte what was reviewed', () => {
  snapshotMatches('id7-120mm-a4.svg', sheet().svg)
  snapshotMatches('id23-200mm-a3.svg', sheet({ tagId: 23, sizeMm: 200, page: 'a3', placeId: 'place-hall-9', roomId: null }).svg)
  snapshotMatches('cscan6-id7-140mm-a4.svg', sheet6().svg)
  snapshotMatches('cscan6-pair-ids3-4-150mm-500mm-a1.svg', pair().svg)
})

test('the QR code encodes exactly the payload line', () => {
  const built = sheet()
  const p = parseSheet(built.svg)
  const text = serializeTagPayload(built.payload)
  // The drawn modules are the encoder's modules for that text (the encoder is called here directly, not through the sheet).
  const qr = qrcodegen.QrCode.encodeText(text, qrcodegen.QrCode.Ecc.MEDIUM)
  const drawn = new Set<string>()
  for (const m of p.qr.svg.matchAll(/M(\d+) (\d+)h1v1h-1z/g)) drawn.add(`${Number(m[1]) - 4},${Number(m[2]) - 4}`)
  const expected = new Set<string>()
  for (let y = 0; y < qr.size; y++) for (let x = 0; x < qr.size; x++) if (qr.getModule(x, y)) expected.add(`${x},${y}`)
  assert.equal(drawn.size, expected.size)
  for (const m of expected) assert.ok(drawn.has(m), `module ${m} was not drawn`)
  // And it is printed at its stated size.
  assert.match(p.qr.svg, /width="36" height="36"/)
})

test('every sheet in the snapshots is a well-formed document', () => {
  for (const name of ['id7-120mm-a4.svg', 'id23-200mm-a3.svg', 'cscan6-id7-140mm-a4.svg', 'cscan6-pair-ids3-4-150mm-500mm-a1.svg']) assertBalancedSvg(readFileSync(join(SNAPSHOTS, name), 'utf8'))
})

test('the command line writes the same bytes as the builder, run by plain node with no flag', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fiducial-sheet-'))
  try {
    const out = join(dir, 'm.svg')
    const args = ['--id', '7', '--size-mm', '120', '--place-id', 'place-kitchen-1', '--room-id', 'room-a', '--page', 'a4', '--family', 'cscan-5x5-v1', '--out', out]
    execFileSync(process.execPath, [SCRIPT, ...args], { stdio: 'pipe' })
    assert.equal(readFileSync(out, 'utf8'), sheet().svg)

    const piped = execFileSync(process.execPath, [SCRIPT, '--id', '7', '--place-id', 'place-kitchen-1', '--room-id', 'room-a', '--size-mm', '120', '--page', 'a4', '--family', 'cscan-5x5-v1'], { stdio: 'pipe' }).toString()
    assert.equal(piped, sheet().svg, 'standard output is the same sheet')

    // With no --family the sheet is the default family's: the 6x6 one.
    const dflt = execFileSync(process.execPath, [SCRIPT, '--id', '7', '--place-id', 'place-kitchen-1', '--room-id', 'room-a', '--size-mm', '140', '--page', 'a4'], { stdio: 'pipe' }).toString()
    assert.equal(dflt, sheet6().svg)
    assert.ok(dflt.includes('data-family="cscan-6x6-v1"'))

    // A pair, with a mount and its height, from the command line.
    const pairOut = join(dir, 'pair.svg')
    execFileSync(process.execPath, [SCRIPT, '--ids', '3,4', '--spacing-mm', '500', '--size-mm', '150', '--place-id', 'place-hall-9', '--page', 'a1', '--mount', 'wall', '--mount-height-mm', '1200', '--out', pairOut], { stdio: 'pipe' })
    assert.equal(readFileSync(pairOut, 'utf8'), pair().svg)

    // No flag: the script compiles the renderer itself (scripts/lib/qr-code-compiled.mjs), so plain node runs it.
    const noFlag = spawnSync(process.execPath, [SCRIPT, ...args.filter((a) => a !== '--out' && a !== out)], { encoding: 'utf8' })
    assert.equal(noFlag.status, 0, noFlag.stderr)
    assert.equal(noFlag.stdout, sheet().svg)

    const missing = spawnSync(process.execPath, [SCRIPT, '--id', '7'], { encoding: 'utf8' })
    assert.equal(missing.status, 2)
    assert.match(missing.stderr, /--place-id and exactly one of --id and --ids are required/)
    const both = spawnSync(process.execPath, [SCRIPT, '--id', '7', '--ids', '1,2', '--place-id', 'p'], { encoding: 'utf8' })
    assert.equal(both.status, 2)
    const unknownFamily = spawnSync(process.execPath, [SCRIPT, '--id', '7', '--place-id', 'p', '--family', 'tag36h11'], { encoding: 'utf8' })
    assert.equal(unknownFamily.status, 2)
    assert.match(unknownFamily.stderr, /unknown family "tag36h11"/)

    const tooBig = spawnSync(process.execPath, [SCRIPT, '--id', '7', '--place-id', 'p', '--size-mm', '400', '--page', 'a3'], { encoding: 'utf8' })
    assert.equal(tooBig.status, 2)
    assert.match(tooBig.stderr, /needs a page at least/)

    const help = spawnSync(process.execPath, [SCRIPT, '--help'], { encoding: 'utf8' })
    assert.equal(help.status, 0)
    assert.match(help.stdout, /usage: npm run print:fiducial/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the command line refuses a size no page holds, and prints the usage with both ways to run it', () => {
  const tooBig = spawnSync(process.execPath, [SCRIPT, '--id', '7', '--place-id', 'p', '--size-mm', '700'], { encoding: 'utf8' })
  assert.equal(tooBig.status, 2)
  assert.match(tooBig.stderr, /size must be from 40 to 600 mm/)
  const help = spawnSync(process.execPath, [SCRIPT, '--help'], { encoding: 'utf8' })
  assert.match(help.stdout, /npm run print:fiducial/)
  assert.match(help.stdout, /node scripts\/print-fiducial\.mjs/)
})
