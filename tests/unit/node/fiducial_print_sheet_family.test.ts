/**
 * The print sheet by family, and with two markers on it (WP-14b): the 6x6 family is the default, a sheet states which family it is in and what its
 * size means, carries the DENSO WAVE notice, asks to be printed at actual size, and the two-marker sheet puts its markers exactly the stated distance apart.
 *
 * A sheet is only worth printing if a ruler laid on the paper agrees with the file, so the sheet is read back as geometry
 * (`tests/support/fiducial-sheet.ts`) and measured in millimetres: the page, each black square, the cells, the white margins, the distance between the
 * two centres, the crop marks, the scale bar. The printed ink (not the dictionary's idea of it) is then drawn into synthetic camera frames and read by the
 * detector, which is the check that finds a sheet that is mirrored, turned, or has its two markers the wrong way round.
 *
 * The QR code is a stub here (see `fiducial_print_sheet.test.ts`): the byte-for-byte snapshots and the command line, with the real renderer, are in
 * `fiducial_print_sheet_qr.test.ts`, which needs `--experimental-transform-types`. This file runs under the repo's standard `node --experimental-strip-types`.
 *
 * Run: node --experimental-strip-types --no-warnings --test tests/unit/node/fiducial_print_sheet_family.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildSheet, buildTwoTagSheet, DENSO_WAVE_NOTICE, MAX_SPACING_MM, MIN_SPACING_MM, PAGES, pageByName, pairLayout, sheetLayout } from '../../../scripts/print-fiducial.mjs'
import { CSCAN5_V1, CSCAN6_V1 } from '../../../src/ar/fiducial/dictionary.ts'
import { FiducialDetector } from '../../../src/ar/fiducial/detector.ts'
import { DEFAULT_TAG_FAMILY, DEFAULT_TAG_FAMILY_NAME, TAG_FAMILIES, tagFamilyByName } from '../../../src/ar/fiducial/families.ts'
import type { TagFamily } from '../../../src/ar/fiducial/families.ts'
import { parseTagPayload, serializeTagPayload } from '../../../src/ar/fiducial/payload.ts'
import type { CameraIntrinsics, Dictionary, FiducialDetection } from '../../../src/ar/fiducial/types.ts'
import { INTRINSICS_1280, INTRINSICS_640, mat3Apply, renderFrame, tagPose } from '../../support/fiducial-render.ts'
import type { RigidPose } from '../../support/fiducial-render.ts'
import { assertBalancedSvg, pairArtwork, parsePairSheet, parseSheet, sheetArtwork, stubQrSvg, textLines, unescapeXml } from '../../support/fiducial-sheet.ts'
import type { Rect } from '../../support/fiducial-sheet.ts'

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..')

/** One marker, in the default family unless told otherwise. */
function single(args: Partial<Parameters<typeof buildSheet>[0]> = {}) {
  return buildSheet({ tagId: 7, sizeMm: 140, placeId: 'place-kitchen-1', roomId: 'room-a', page: 'a4', qrSvg: stubQrSvg, ...args })
}

/** Two markers on one sheet, in the default family unless told otherwise. */
function pair(args: Partial<Parameters<typeof buildTwoTagSheet>[0]> = {}) {
  return buildTwoTagSheet({ tagIds: [3, 4], spacingMm: 500, sizeMm: 150, placeId: 'place-hall-9', roomId: null, page: 'a1', qrSvg: stubQrSvg, ...args })
}

/** What the sheet puts outside a trim square for its crop marks: a 1.5 mm gap, then a 5 mm mark. Stated here, not read from the generator. */
const CROP_GAP_MM = 1.5
const CROP_REACH_MM = 6.5

// ---------------------------------------------------------------------------------------------
// What a ruler finds
// ---------------------------------------------------------------------------------------------

function boxOf(rects: Rect[]): Rect {
  return { x0: Math.min(...rects.map((r) => r.x0)), y0: Math.min(...rects.map((r) => r.y0)), x1: Math.max(...rects.map((r) => r.x1)), y1: Math.max(...rects.map((r) => r.y1)) }
}

/**
 * One printed tag, measured: the black square is `sizeMm` across (to a tenth of a micrometre), made of `cells` cells of `sizeMm / cells`, every run of ink on that
 * grid, and one cell of white all round it inside the quiet zone. Returns the black square.
 */
function assertRuler(rects: Rect[], quiet: Rect, sizeMm: number, cells: number, label: string): Rect {
  const box = boxOf(rects)
  const cell = sizeMm / cells
  assert.ok(Math.abs(box.x1 - box.x0 - sizeMm) < 1e-3, `${label}: the black square is ${box.x1 - box.x0} mm wide, not ${sizeMm}`)
  assert.ok(Math.abs(box.y1 - box.y0 - sizeMm) < 1e-3, `${label}: the black square is ${box.y1 - box.y0} mm tall, not ${sizeMm}`)
  for (const r of rects) {
    assert.ok(Math.abs(r.y1 - r.y0 - cell) < 1e-3, `${label}: a run of ink ${r.y1 - r.y0} mm tall, not one cell (${cell})`)
    for (const n of [(r.x1 - r.x0) / cell, (r.x0 - box.x0) / cell, (r.y0 - box.y0) / cell]) assert.ok(Math.abs(n - Math.round(n)) < 1e-3, `${label}: ink is off the ${cell} mm grid`)
  }
  const margins = [box.x0 - quiet.x0, quiet.x1 - box.x1, box.y0 - quiet.y0, quiet.y1 - box.y1]
  for (const m of margins) assert.ok(Math.abs(m - cell) < 1e-3, `${label}: the white margin is ${m} mm, not one cell (${cell})`)
  return box
}

/** The printed cells of a black square, read back from its ink: `cells * cells` values, row-major, 1 = black. */
function cellsOf(rects: Rect[], box: Rect, cells: number): number[] {
  const cell = (box.x1 - box.x0) / cells
  const grid = new Array<number>(cells * cells).fill(0)
  for (const r of rects) {
    const row = Math.round((r.y0 - box.y0) / cell)
    for (let c = Math.round((r.x0 - box.x0) / cell); c < Math.round((r.x1 - box.x0) / cell); c++) grid[row * cells + c] = 1
  }
  return grid
}

/** The ink is the family's pattern for `id`: a black ring and the `bits * bits` data cells, as `dictionary.pattern` says. */
function assertPrints(rects: Rect[], box: Rect, dictionary: Dictionary, id: number, label: string): void {
  const cells = dictionary.bits + 2
  const grid = cellsOf(rects, box, cells)
  const pattern = dictionary.pattern(id)
  for (let r = 0; r < cells; r++) {
    for (let c = 0; c < cells; c++) {
      const border = r === 0 || c === 0 || r === cells - 1 || c === cells - 1
      assert.equal(grid[r * cells + c], border ? 1 : pattern[(r - 1) * dictionary.bits + (c - 1)], `${label}: id ${id}, cell (${r}, ${c})`)
    }
  }
}

/** The text elements of a sheet with where they start, how big they are and what they say. */
function textItems(svg: string): Array<{ x: number; y: number; fontMm: number; mono: boolean; text: string; id: string | null }> {
  return [...svg.matchAll(/<text\b([^>]*)>([^<]*)<\/text>/g)].map((m) => {
    const attrs = m[1]!
    const get = (name: string) => new RegExp(`(?:^|\\s)${name}="([^"]*)"`).exec(attrs)?.[1]
    return { x: Number(get('x')), y: Number(get('y')), fontMm: Number(get('font-size')), mono: (get('font-family') ?? '').includes('Courier'), text: unescapeXml(m[2]!), id: get('id') ?? null }
  })
}

/** The width of a line of text, millimetres, estimated: Helvetica's average advance is half an em, Courier's 0.6. No font is measured here. */
function estimatedWidthMm(item: { fontMm: number; mono: boolean; text: string }): number {
  return item.text.length * item.fontMm * (item.mono ? 0.6 : 0.53)
}

/** No line of text, as estimated, runs into the QR code, and none starts or ends off the page. */
function assertTextClearOfQr(svg: string, page: { widthMm: number; heightMm: number }, qr: { xMm: number; yMm: number }, label: string): void {
  const QR = 36
  for (const item of textItems(svg)) {
    if (item.text === '') continue
    assert.ok(item.x >= 0 && item.y <= page.heightMm, `${label}: "${item.text.slice(0, 30)}" starts off the page`)
    const centred = svg.includes(`<text x="${item.x}" y="${item.y}" text-anchor="middle"`)
    if (centred) continue
    const right = item.x + estimatedWidthMm(item)
    assert.ok(right <= page.widthMm, `${label}: "${item.text.slice(0, 30)}" runs off the page (to ${right.toFixed(1)} mm of ${page.widthMm})`)
    const inQrRows = item.y >= qr.yMm - 1 && item.y <= qr.yMm + QR + 1
    assert.ok(!(inQrRows && right > qr.xMm && item.x < qr.xMm + QR), `${label}: "${item.text.slice(0, 40)}" runs into the QR code (to ${right.toFixed(1)} mm, the code starts at ${qr.xMm})`)
  }
}

// ---------------------------------------------------------------------------------------------
// The family
// ---------------------------------------------------------------------------------------------

test('a sheet states its family, what its size means and the quad the detector sees; the default is the family families.ts names', () => {
  assert.equal(single().payload.family, DEFAULT_TAG_FAMILY_NAME)
  assert.equal(parseSheet(single().svg).data['data-family'], DEFAULT_TAG_FAMILY.dictionary.name)
  assert.equal(pair().payload.family, DEFAULT_TAG_FAMILY_NAME)
  assert.equal(parsePairSheet(pair().svg).data['data-family'], DEFAULT_TAG_FAMILY_NAME)
  for (const f of TAG_FAMILIES) {
    const built = single({ dictionary: f.dictionary, tagId: 5, sizeMm: 100 })
    const p = parseSheet(built.svg)
    const name = f.dictionary.name
    assert.equal(p.data['data-family'], name)
    assert.equal(p.data['data-bits'], String(f.dictionary.bits))
    assert.equal(p.data['data-cells'], String(f.cells))
    assert.equal(p.data['data-quad-fraction'], String(f.quadFraction))
    assert.equal(Number(p.data['data-quad-mm']), 100 * f.quadFraction)
    assert.ok(Math.abs(Number(p.data['data-cell-mm']) - 100 / f.cells) < 1e-3)
    assert.equal(built.geometry.quadMm, 100 * f.quadFraction)
    assert.equal(built.payload.family, name)
    const lines = textLines(built.svg)
    assert.ok(lines.includes(`Family ${name}: ${f.dictionary.bits}x${f.dictionary.bits} code, ${f.cells}x${f.cells} cells in all.`), `${name}: the family line`)
    assert.ok(lines.includes('Size is the outer edge of the black ring: 100 mm.'), `${name}: the size line`)
    assert.ok(lines.includes(`Tag 5 · ${name} · black square 100 mm`), `${name}: the header line`)
  }
  // A family nobody registered has no stated quad fraction: no sheet is printed for it.
  assert.throws(() => single({ dictionary: { ...CSCAN6_V1, name: 'cscan-9x9-v9' } }), /not registered/)
  // The ids are the family's: 32 for the 5x5 family, 128 for the 6x6.
  assert.throws(() => single({ tagId: 32, dictionary: CSCAN5_V1 }), /0 to 31/)
  assert.doesNotThrow(() => single({ tagId: 127 }))
  assert.throws(() => single({ tagId: 128 }), /0 to 127/)
})

test('a family whose detection quad is not the black ring says so on its sheet, and the printed size stays the black ring\'s', () => {
  const odd: TagFamily = { dictionary: { ...CSCAN5_V1, name: 'test-quad-family' }, cells: 7, quadFraction: 0.8 }
  const registry = TAG_FAMILIES as TagFamily[]
  registry.push(odd)
  try {
    const built = single({ dictionary: odd.dictionary, tagId: 5, sizeMm: 100 })
    const p = parseSheet(built.svg)
    assert.equal(p.data['data-quad-fraction'], '0.8')
    assert.equal(p.data['data-quad-mm'], '80')
    assert.equal(built.geometry.quadMm, 80)
    assert.equal(p.tag.sizeMm, 100)
    assert.equal(built.payload.printedSizeMm, 100)
    const two = parsePairSheet(pair({ dictionary: odd.dictionary, tagIds: [1, 2], sizeMm: 100, page: 'a1' }).svg)
    assert.equal(two.data['data-quad-fraction'], '0.8')
    assert.equal(two.data['data-quad-mm'], '80')
  } finally {
    registry.splice(registry.indexOf(odd), 1)
  }
  assert.equal(tagFamilyByName('test-quad-family'), null)
})

test('the default family is decided in one place: no module but the family files names a family in code, and the generator reads the default from families.ts', () => {
  const allowed = new Set(['src/ar/fiducial/dictionary.ts', 'src/ar/fiducial/dictionary-search.ts', 'src/ar/fiducial/families.ts'])
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : /\.(ts|mjs|js)$/.test(e.name) ? [join(dir, e.name)] : []))
  const strip = (code: string) => code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1')
  const naming: string[] = []
  for (const file of [...walk(join(ROOT, 'src')), ...walk(join(ROOT, 'scripts'))]) {
    if (/['"`]cscan-\d+x\d+-v\d+['"`]/.test(strip(readFileSync(file, 'utf8')))) naming.push(relative(ROOT, file))
  }
  assert.deepEqual(naming.filter((f) => !allowed.has(f)), [], 'a module names a family in code: read it from families.ts')
  // The default is one constant, in one file.
  const families = strip(readFileSync(join(ROOT, 'src/ar/fiducial/families.ts'), 'utf8'))
  assert.equal(families.match(/DEFAULT_TAG_FAMILY_NAME\s*=\s*'/g)?.length, 1)
  // The generator takes the default from there (it has no family of its own), and still lets a caller pass one.
  assert.equal(single().payload.family, DEFAULT_TAG_FAMILY.dictionary.name)
  assert.equal(single({ dictionary: CSCAN5_V1 }).payload.family, 'cscan-5x5-v1')
})

// ---------------------------------------------------------------------------------------------
// One marker, 6x6
// ---------------------------------------------------------------------------------------------

test('physical size of one marker, default family, by parsing the file: the page, the black square, the cells, the margin and the scale bar are the sizes they claim', () => {
  for (const [tagId, sizeMm, page] of [[7, 140, 'a4'], [127, 200, 'a3'], [0, 60, 'a4'], [64, 300, 'a2'], [31, 440, 'a0'], [100, 600, 'a0'], [5, 100, 'letter']] as const) {
    const built = single({ tagId, sizeMm, page })
    const p = parseSheet(built.svg)
    const label = `id ${tagId}, ${sizeMm} mm, ${page}`
    assert.deepEqual([p.widthMm, p.heightMm], [PAGES[page].widthMm, PAGES[page].heightMm], label)
    assert.deepEqual(p.viewBox, [0, 0, p.widthMm, p.heightMm], label)
    const box = assertRuler(p.inkRects, p.quietZone, sizeMm, 8, label)
    assert.equal(p.tag.sizeMm, sizeMm)
    assert.ok(Math.abs(p.tag.xMm - box.x0) < 1e-3 && Math.abs(p.tag.yMm - box.y0) < 1e-3, `${label}: the tag group is not where the ink is`)
    assert.ok(Math.abs(Number(p.data['data-cell-mm']) - sizeMm / 8) < 1e-3, label)
    assert.ok(Math.abs(Number(p.data['data-quiet-mm']) - sizeMm / 8) < 1e-3, label)

    // The scale bar is 100 mm, as drawn, and everything is on the page.
    const bar = /M(-?[0-9.]+) (-?[0-9.]+)H(-?[0-9.]+)/.exec(p.scaleBar.path)!
    assert.equal(p.scaleBar.lengthMm, 100)
    assert.ok(Math.abs(Number(bar[3]) - Number(bar[1]) - 100) < 1e-3, `${label}: the bar is ${Number(bar[3]) - Number(bar[1])} mm`)
    for (const [name, a, b, c, d] of [
      ['tag', p.quietZone.x0, p.quietZone.y0, p.quietZone.x1, p.quietZone.y1],
      ['bar', Number(bar[1]), Number(bar[2]), Number(bar[3]), Number(bar[2])],
      ['qr', p.qr.xMm, p.qr.yMm, p.qr.xMm + built.geometry.qrSizeMm, p.qr.yMm + built.geometry.qrSizeMm],
    ] as const) {
      assert.ok(a >= 0 && b >= 0 && c <= p.widthMm && d <= p.heightMm, `${label}: ${name} is off the page`)
    }
    assertTextClearOfQr(built.svg, p, p.qr, label)
  }
})

test('the printed cells are the family\'s pattern for every id of the default family, on one-marker sheets and on both markers of two-marker sheets', () => {
  for (let id = 0; id < CSCAN6_V1.size; id++) {
    const p = parseSheet(single({ tagId: id, sizeMm: 100 }).svg)
    assertPrints(p.inkRects, boxOf(p.inkRects), CSCAN6_V1, id, 'single')
  }
  // Every id appears once as the left marker and once as the right.
  for (let i = 0; i < CSCAN6_V1.size; i++) {
    const other = (i + 64) % CSCAN6_V1.size
    const p = parsePairSheet(pair({ tagIds: [i, other], sizeMm: 100, spacingMm: 600, page: 'a1' }).svg)
    assert.deepEqual([p.tags[0].id, p.tags[1].id], [i, other])
    assertPrints(p.tags[0].inkRects, boxOf(p.tags[0].inkRects), CSCAN6_V1, i, 'pair, left')
    assertPrints(p.tags[1].inkRects, boxOf(p.tags[1].inkRects), CSCAN6_V1, other, 'pair, right')
  }
})

/**
 * The marker reads of a frame with a marker that was reported twice at the same place counted once. The detector's grouping can split one marker's candidates
 * in two when a dark halo round its white margin (a bright quiet zone on a mid-grey wall) falls at the edge of the size ratio it groups by, and then
 * reports the marker twice, a hundredth of a pixel apart (the merged WP-14a detector does the same; see the WP-14b report). The sheet tests ask what the
 * sheet printed, not how the detector groups, and the session picks one detection per frame.
 */
function distinctReads(found: readonly FiducialDetection[]): FiducialDetection[] {
  const centre = (d: FiducialDetection) => ({ x: d.corners.reduce((s, k) => s + k.x, 0) / 4, y: d.corners.reduce((s, k) => s + k.y, 0) / 4 })
  const out: FiducialDetection[] = []
  for (const d of found) {
    const c = centre(d)
    if (!out.some((o) => o.id === d.id && Math.hypot(centre(o).x - c.x, centre(o).y - c.y) < 0.3 * d.sidePx)) out.push(d)
  }
  return out
}

test('the PRINTED 6x6 marker, drawn into camera frames at all four turns, is read as the right id with the corners in printed order', () => {
  const det = new FiducialDetector(CSCAN6_V1)
  let read = 0
  for (const id of [0, 1, 31, 64, 100, 127]) {
    const p = parseSheet(single({ tagId: id, sizeMm: 200, page: 'a3' }).svg)
    const art = sheetArtwork(p)
    for (const spin of [0, 90, 180, 270]) {
      const pose = tagPose({ x: 0.04, y: -0.03, z: 1.5 }, spin + ((id * 7) % 20), ((id * 11) % 40) - 20, ((id * 5) % 20) - 10)
      const img = renderFrame({ width: 640, height: 480, intrinsics: INTRINSICS_640, items: [{ artwork: art, pose }], noiseSigma: 2, blurSigma: 0.6, seed: id * 4 + spin / 90 + 1, supersample: 3 })
      const found = distinctReads(det.detect(img))
      assert.equal(found.length, 1, `id ${id}, spin ${spin}: ${found.length} detections`)
      assert.equal(found[0]!.id, id, `id ${id}, spin ${spin} read as ${found[0]!.id}`)
      const truth = [[-0.1, 0.1], [0.1, 0.1], [0.1, -0.1], [-0.1, -0.1]].map(([x, y]) => project(pose, INTRINSICS_640, x!, y!))
      for (let c = 0; c < 4; c++) assert.ok(Math.hypot(found[0]!.corners[c]!.x - truth[c]!.x, found[0]!.corners[c]!.y - truth[c]!.y) < 0.5, `id ${id}, spin ${spin}, corner ${c}`)
      read++
    }
  }
  assert.equal(read, 24)
})

/** Where a point of the sheet's plane (metres, x right, y up, the sheet's origin) lands in the image. */
function project(pose: RigidPose, K: CameraIntrinsics, x: number, y: number): { x: number; y: number } {
  const q = mat3Apply(pose.rotation, { x, y, z: 0 })
  return { x: (K.fx * (q.x + pose.translation.x)) / (q.z + pose.translation.z) + K.cx, y: (K.fy * (q.y + pose.translation.y)) / (q.z + pose.translation.z) + K.cy }
}

// ---------------------------------------------------------------------------------------------
// The text every sheet carries
// ---------------------------------------------------------------------------------------------

test('every sheet carries the DENSO WAVE notice once, on the page and below the QR code\'s text, and asks to be printed at actual size', () => {
  assert.equal(DENSO_WAVE_NOTICE, 'QR Code is a registered trademark of DENSO WAVE INCORPORATED.')
  const sheets = [
    { label: 'default family', built: single() },
    { label: '5x5 family', built: single({ dictionary: CSCAN5_V1, sizeMm: 120 }) },
    { label: 'small tag', built: single({ sizeMm: 50 }) },
    { label: 'with a mount', built: single({ mount: 'wall', mountHeightMm: 1200 }) },
    { label: 'pair', built: pair() },
    { label: 'small pair on A2', built: pair({ sizeMm: 50, page: 'auto' }) },
  ]
  for (const { label, built } of sheets) {
    const lines = textLines(built.svg)
    assert.equal(lines.filter((l) => l === DENSO_WAVE_NOTICE).length, 1, `${label}: the notice is on the sheet once`)
    // It is its own element, below the payload text, and on the page.
    const items = textItems(built.svg)
    const notice = items.find((i) => i.id === 'denso-wave')!
    assert.ok(notice, `${label}: no element with id denso-wave`)
    assert.equal(notice.text, DENSO_WAVE_NOTICE)
    const payloadRows = items.filter((i) => i.mono).map((i) => i.y)
    assert.ok(payloadRows.length >= 1 && payloadRows.every((y) => y < notice.y), `${label}: the notice is not below the payload text`)
    assert.ok(notice.y <= built.page.heightMm - 8, `${label}: the notice is in the page margin (${notice.y} mm of ${built.page.heightMm})`)
    // The sheet says what the printer must not do, and what the bar is for.
    assert.ok(lines.includes('Print at 100% (actual size), not fit to page.'), `${label}: print at actual size`)
    assert.ok(lines.includes('The bar below is 100 mm. If it measures less or more,'), label)
    assert.ok(lines.includes(`the black square is ${built.geometry.sizeMm} mm x measured / 100 mm.`), label)
    assert.ok(lines.includes('Mount it flat on a hard surface: a curled sheet moves the corners.'), label)
  }
})

test('the sheet says how it is to be mounted when asked, and refuses a mount it cannot state', () => {
  assert.ok(!textLines(single().svg).some((l) => l.startsWith('Mount:')), 'no mount line unless one was asked for')
  assert.ok(textLines(single({ mount: 'wall' }).svg).includes('Mount: wall.'))
  assert.ok(textLines(single({ mount: 'wall', mountHeightMm: 1200 }).svg).includes('Mount: wall, centre of the black square 1200 mm above the floor.'))
  assert.ok(textLines(pair({ mount: 'horizontal', mountHeightMm: 900 }).svg).includes('Mount: horizontal, centre of the black square 900 mm above the floor.'))
  assert.throws(() => single({ mount: 'diagonal' as never }), /mount must be wall or horizontal/)
  assert.throws(() => single({ mountHeightMm: 1200 }), /needs a mount/)
  assert.throws(() => single({ mount: 'wall', mountHeightMm: -1 }), /from 0 to 4000 mm/)
  assert.throws(() => single({ mount: 'wall', mountHeightMm: 4001 }), /from 0 to 4000 mm/)
  assert.throws(() => single({ mount: 'wall', mountHeightMm: Number.NaN }), /from 0 to 4000 mm/)
  assert.throws(() => pair({ mountHeightMm: 1200 }), /needs a mount/)
  assert.doesNotThrow(() => single({ mount: 'horizontal', mountHeightMm: 0 }))
  assert.doesNotThrow(() => single({ mount: 'wall', mountHeightMm: 4000 }))
})

test('no line of text runs into the QR code, at any size and family the generator prints on the page it picks, and a page too narrow for that is refused', () => {
  for (const dictionary of [CSCAN6_V1, CSCAN5_V1]) {
    for (const sizeMm of [40, 50, 64, 70, 100, 140]) {
      for (const mount of [null, 'wall'] as const) {
        const built = single({ dictionary, sizeMm, page: 'auto', mount, mountHeightMm: mount ? 1200 : null, roomId: 'room-with-a-longer-name-a' })
        assertTextClearOfQr(built.svg, built.page, { xMm: built.geometry.qrXMm, yMm: built.geometry.qrYMm }, `${dictionary.name} ${sizeMm} mm ${mount ?? 'no mount'} on ${built.page.name}`)
      }
    }
  }
  for (const [sizeMm, spacingMm] of [[50, 500], [100, 500], [150, 800], [100, 1000]] as const) {
    const built = pair({ sizeMm, spacingMm, page: 'auto', mount: 'wall', mountHeightMm: 1200 })
    assertTextClearOfQr(built.svg, built.page, { xMm: built.geometry.qrXMm, yMm: built.geometry.qrYMm }, `pair ${sizeMm} mm ${spacingMm} mm on ${built.page.name}`)
  }
  // A small tag on a page too narrow for the text beside the QR code is not printed with the text over it.
  assert.throws(() => single({ sizeMm: 40, page: '150x300', mount: 'wall', mountHeightMm: 1200 }), /too narrow for the sheet text/)
  assert.doesNotThrow(() => single({ sizeMm: 40, page: '240x300', mount: 'wall', mountHeightMm: 1200 }))
})

test('ids the scanner could not read back are refused, and the longest ids a page takes still leave every line above the bottom margin', () => {
  // The QR code carries the ids; one the scanner would refuse (empty, or over its limit of 200 characters) is not printed.
  assert.throws(() => single({ roomId: '' }), /would not be readable by the scanner/)
  assert.throws(() => single({ page: 'a0', placeId: 'p'.repeat(201) }), /would not be readable by the scanner/)
  assert.throws(() => pair({ placeId: 'p'.repeat(201) }), /would not be readable by the scanner/)
  assert.throws(() => pair({ roomId: '' }), /would not be readable by the scanner/)
  assert.doesNotThrow(() => single({ page: 'a0', placeId: 'p'.repeat(200), roomId: 'r'.repeat(200) }))
  // A line of text that would reach the QR code on the page asked for is refused, with what to do.
  assert.throws(() => single({ placeId: 'p'.repeat(120) }), /too narrow for the sheet text beside the QR code: use a wider page, or shorter place and room ids/)

  // The longest ids (the same length for place and room) each configuration takes, found by bisection: the footer still ends above the bottom margin.
  const longest = (build: (len: number) => { footerUsedMm: number; page: { heightMm: number }; geometry: { qrYMm: number } }) => {
    let lo = 1
    let hi = 200
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2)
      try {
        build(mid)
        lo = mid
      } catch (e) {
        if (!(e instanceof RangeError) || !/too narrow/.test(e.message)) throw e
        hi = mid - 1
      }
    }
    return { len: lo, built: build(lo) }
  }
  let swept = 0
  for (const dictionary of [CSCAN6_V1, CSCAN5_V1]) {
    for (const [sizeMm, page] of [[40, 'auto'], [100, 'auto'], [140, 'a4'], [40, '170x300'], [60, '250x400'], [100, '400x300'], [200, 'a3']] as const) {
      const { len, built } = longest((n) => single({ dictionary, sizeMm, page, placeId: 'p'.repeat(n), roomId: 'r'.repeat(n), mount: 'wall', mountHeightMm: 1200 }))
      assert.ok(built.geometry.qrYMm + built.footerUsedMm <= built.page.heightMm - 8 + 1e-9, `${dictionary.name} ${sizeMm} mm on ${page}, ids of ${len} characters: the footer ends ${built.geometry.qrYMm + built.footerUsedMm} mm down a ${built.page.heightMm} mm page`)
      swept++
    }
  }
  for (const [sizeMm, spacingMm, page] of [[50, 500, 'auto'], [100, 500, 'auto'], [150, 800, 'auto'], [100, 1200, '1500x400'], [150, 500, 'a1']] as const) {
    const { len, built } = longest((n) => pair({ sizeMm, spacingMm, page, placeId: 'p'.repeat(n), roomId: 'r'.repeat(n), mount: 'wall', mountHeightMm: 1200 }))
    assert.ok(built.geometry.qrYMm + built.footerUsedMm <= built.page.heightMm - 8 + 1e-9, `pair ${sizeMm} mm, ${spacingMm} mm apart on ${page}, ids of ${len} characters: the footer ends ${built.geometry.qrYMm + built.footerUsedMm} mm down a ${built.page.heightMm} mm page`)
    swept++
  }
  assert.equal(swept, 19)
})

// ---------------------------------------------------------------------------------------------
// The payload
// ---------------------------------------------------------------------------------------------

test('the payload carries the mount, its height and the partner in a fixed order, reads them back strictly, and a payload without them is byte-for-byte what it was', () => {
  const base = { v: 1 as const, family: 'cscan-5x5-v1', tagId: 7, placeId: 'place-kitchen-1', roomId: 'room-a', printedSizeMm: 120 }
  assert.equal(serializeTagPayload(base), '{"v":1,"family":"cscan-5x5-v1","tagId":7,"placeId":"place-kitchen-1","roomId":"room-a","printedSizeMm":120}')
  assert.deepEqual(parseTagPayload(serializeTagPayload(base)), base, 'a payload from before parses to what it did, with no new members')

  const full = { ...base, mount: 'wall' as const, mountHeightMm: 1200, partner: { tagId: 9, dxMm: 800, dyMm: 0 } }
  const text = serializeTagPayload(full)
  assert.equal(text, '{"v":1,"family":"cscan-5x5-v1","tagId":7,"placeId":"place-kitchen-1","roomId":"room-a","printedSizeMm":120,"mount":"wall","mountHeightMm":1200,"partner":{"tagId":9,"dxMm":800,"dyMm":0}}')
  assert.deepEqual(parseTagPayload(text), full)
  assert.deepEqual(parseTagPayload(JSON.stringify({ ...full, future: 'field' })), full, 'an unknown member is ignored')
  assert.deepEqual(parseTagPayload(serializeTagPayload({ ...base, mount: 'horizontal' })), { ...base, mount: 'horizontal' })
  for (const ok of [{ mount: 'wall', mountHeightMm: 0 }, { mount: 'wall', mountHeightMm: 4000 }, { partner: { tagId: 9, dxMm: -800, dyMm: 0 } }, { partner: { tagId: 9, dxMm: 0, dyMm: 500 } }, { partner: { tagId: 9, dxMm: -5000, dyMm: 5000 } }]) {
    assert.deepEqual(parseTagPayload(JSON.stringify({ ...base, ...ok })), { ...base, ...ok }, JSON.stringify(ok))
  }
  for (const bad of [
    { mount: 'ceiling' }, { mount: 7 }, { mount: null },
    { mountHeightMm: 1200 }, { mount: 'wall', mountHeightMm: -1 }, { mount: 'wall', mountHeightMm: 4001 }, { mount: 'wall', mountHeightMm: '1200' }, { mount: 'wall', mountHeightMm: null },
    { partner: null }, { partner: [] }, { partner: 5 }, { partner: { tagId: 7, dxMm: 500, dyMm: 0 } }, { partner: { tagId: -1, dxMm: 500, dyMm: 0 } }, { partner: { tagId: 1.5, dxMm: 500, dyMm: 0 } },
    { partner: { tagId: 9, dxMm: '500', dyMm: 0 } }, { partner: { tagId: 9, dxMm: 500 } }, { partner: { tagId: 9, dxMm: 0, dyMm: 0 } }, { partner: { tagId: 9, dxMm: 5001, dyMm: 0 } }, { partner: { tagId: 9, dxMm: 0, dyMm: -5001 } },
  ]) {
    assert.equal(parseTagPayload(JSON.stringify({ ...base, ...bad })), null, JSON.stringify(bad))
  }
})

test('the sheets\' payload line, QR input and description are the payload they were built from, with the mount and the partner when there are some', () => {
  const one = single({ mount: 'wall', mountHeightMm: 1200 })
  const oneText = serializeTagPayload(one.payload)
  assert.deepEqual(parseTagPayload(oneText), { v: 1, family: DEFAULT_TAG_FAMILY_NAME, tagId: 7, placeId: 'place-kitchen-1', roomId: 'room-a', printedSizeMm: 140, mount: 'wall', mountHeightMm: 1200 })
  assert.ok(one.svg.includes(`data-payload-length="${oneText.length}"`), 'the QR renderer was not given the payload line')
  assert.ok(one.svg.includes('<desc>' + oneText.replace(/"/g, '&quot;') + '</desc>'))

  const two = pair({ mount: 'wall', mountHeightMm: 1200, roomId: 'room-b' })
  const twoText = serializeTagPayload(two.payload)
  assert.deepEqual(parseTagPayload(twoText), {
    v: 1, family: DEFAULT_TAG_FAMILY_NAME, tagId: 3, placeId: 'place-hall-9', roomId: 'room-b', printedSizeMm: 150, mount: 'wall', mountHeightMm: 1200, partner: { tagId: 4, dxMm: 500, dyMm: 0 },
  })
  assert.ok(two.svg.includes(`data-payload-length="${twoText.length}"`))
  assert.ok(two.svg.includes('<desc>' + twoText.replace(/"/g, '&quot;') + '</desc>'))
  // A sheet without a mount says nothing about one.
  assert.equal(parseTagPayload(serializeTagPayload(single().payload))!.mount, undefined)
  assert.equal(parseTagPayload(serializeTagPayload(pair().payload))!.mount, undefined)
})

// ---------------------------------------------------------------------------------------------
// Two markers on one sheet
// ---------------------------------------------------------------------------------------------

/** Every crop-mark segment as [x0, y0, x1, y1], the first eight for the first tag and the next eight for the second. */
function cropSegments(path: string): Array<[number, number, number, number]> {
  const segs: Array<[number, number, number, number]> = []
  for (const m of path.matchAll(/M(-?[0-9.]+) (-?[0-9.]+)([HV])(-?[0-9.]+)/g)) {
    const [x, y, v] = [Number(m[1]), Number(m[2]), Number(m[4])]
    segs.push(m[3] === 'H' ? [x, y, v, y] : [x, y, x, v])
  }
  return segs
}

test('physical size of a two-marker sheet by parsing the file: the page, each black square, the cells, the margins, the distance between the centres and the crop marks are the sizes they claim', () => {
  const cases = [
    { sizeMm: 150, spacingMm: 500, page: 'a1', name: 'a1', width: 841, height: 594, ids: [3, 4] },
    { sizeMm: 100, spacingMm: 650, page: 'auto', name: 'a1', width: 841, height: 594, ids: [0, 127] },
    { sizeMm: 50, spacingMm: 500, page: 'auto', name: 'a2', width: 594, height: 420, ids: [64, 65] },
    { sizeMm: 150, spacingMm: 800, page: 'auto', name: 'a0', width: 1189, height: 841, ids: [31, 5] },
    { sizeMm: 100, spacingMm: 1200, page: '1500x400', name: '1500x400', width: 1500, height: 400, ids: [8, 9] },
    { sizeMm: 120, spacingMm: 612.5, page: '1000x500', name: '1000x500', width: 1000, height: 500, ids: [1, 2] },
  ] as const
  for (const c of cases) {
    const built = pair({ sizeMm: c.sizeMm, spacingMm: c.spacingMm, page: c.page, tagIds: [c.ids[0], c.ids[1]] })
    const p = parsePairSheet(built.svg)
    const label = `${c.sizeMm} mm tags, ${c.spacingMm} mm apart, ${c.page}`
    assert.equal(built.page.name, c.name, label)
    assert.deepEqual([p.widthMm, p.heightMm], [c.width, c.height], label)
    assert.ok(p.widthMm > p.heightMm, `${label}: a pair is landscape`)
    assert.deepEqual(p.viewBox, [0, 0, p.widthMm, p.heightMm], label)
    assert.deepEqual([p.tags[0].id, p.tags[1].id], [...c.ids], label)
    assert.equal(p.data['data-spacing-mm'], String(c.spacingMm))

    // Each black square, measured.
    const boxes = p.tags.map((t, i) => assertRuler(t.inkRects, t.quietZone, c.sizeMm, 8, `${label}, tag ${i + 1}`))
    for (const [i, t] of p.tags.entries()) {
      assert.equal(t.sizeMm, c.sizeMm)
      assert.ok(Math.abs(t.xMm - boxes[i]!.x0) < 1e-3 && Math.abs(t.yMm - boxes[i]!.y0) < 1e-3, `${label}: tag ${i + 1}'s group is not where its ink is`)
      assert.ok(Math.abs(t.centreXMm - (boxes[i]!.x0 + boxes[i]!.x1) / 2) < 1e-3 && Math.abs(t.centreYMm - (boxes[i]!.y0 + boxes[i]!.y1) / 2) < 1e-3, `${label}: tag ${i + 1}'s centre is not its ink's`)
    }
    assert.ok(Math.abs(Number(p.data['data-cell-mm']) - c.sizeMm / 8) < 1e-3, label)

    // The centres are exactly `spacingMm` apart, level, the first on the left; the pair is symmetric about the page's middle.
    const centres = boxes.map((b) => ({ x: (b.x0 + b.x1) / 2, y: (b.y0 + b.y1) / 2 }))
    assert.ok(Math.abs(centres[1]!.x - centres[0]!.x - c.spacingMm) < 1e-3, `${label}: the centres are ${centres[1]!.x - centres[0]!.x} mm apart`)
    assert.ok(Math.abs(centres[1]!.y - centres[0]!.y) < 1e-3, `${label}: the two tags are not level`)
    assert.ok(Math.abs((centres[0]!.x + centres[1]!.x) / 2 - p.widthMm / 2) < 1e-3, `${label}: the pair is not centred on the page`)
    assert.ok(Math.abs(built.geometry.spacingMm - c.spacingMm) < 1e-12 && Math.abs(built.payload.partner!.dxMm - c.spacingMm) < 1e-12 && built.payload.partner!.dyMm === 0, label)

    // The crop marks: eight per tag, each 1.5 mm off its own trim square and 6.5 mm at the far end; the two sets do not meet.
    const segs = cropSegments(p.cropMarkPath)
    assert.equal(segs.length, 16, `${label}: crop mark segments`)
    const reach = [Infinity, -Infinity, Infinity, -Infinity]
    for (const [i, t] of p.tags.entries()) {
      for (const [x0, y0, x1, y1] of segs.slice(i * 8, i * 8 + 8)) {
        const horizontal = y0 === y1
        const [lo, hi, edgeLo, edgeHi, line, lineLo, lineHi] = horizontal ? [Math.min(x0, x1), Math.max(x0, x1), t.quietZone.x0, t.quietZone.x1, y0, t.quietZone.y0, t.quietZone.y1] : [Math.min(y0, y1), Math.max(y0, y1), t.quietZone.y0, t.quietZone.y1, x0, t.quietZone.x0, t.quietZone.x1]
        assert.ok(Math.abs(line - lineLo) < 1e-3 || Math.abs(line - lineHi) < 1e-3, `${label}: tag ${i + 1}: a mark on a line that is not a trim edge`)
        const outside = hi <= edgeLo + 1e-3 ? [edgeLo - hi, edgeLo - lo] : [lo - edgeHi, hi - edgeHi]
        assert.ok(Math.abs(outside[0]! - CROP_GAP_MM) < 1e-3 && Math.abs(outside[1]! - CROP_REACH_MM) < 1e-3, `${label}: tag ${i + 1}: a mark from ${outside[0]} to ${outside[1]} mm off its trim square`)
        if (horizontal) {
          reach[i * 2] = Math.min(reach[i * 2]!, lo)
          reach[i * 2 + 1] = Math.max(reach[i * 2 + 1]!, hi)
        }
      }
    }
    assert.ok(reach[1]! <= reach[2]! + 1e-9, `${label}: the first tag's crop marks (to ${reach[1]}) meet the second's (from ${reach[2]})`)

    // The scale bar is 100 mm, and the QR code, the bar and every line of text are on the page and clear of each other.
    const bar = /M(-?[0-9.]+) (-?[0-9.]+)H(-?[0-9.]+)/.exec(p.scaleBar.path)!
    assert.equal(p.scaleBar.lengthMm, 100)
    assert.ok(Math.abs(Number(bar[3]) - Number(bar[1]) - 100) < 1e-3, `${label}: the bar is ${Number(bar[3]) - Number(bar[1])} mm`)
    for (const [name, a, b, d, e] of [
      ['tag 1', p.tags[0].quietZone.x0, p.tags[0].quietZone.y0, p.tags[0].quietZone.x1, p.tags[0].quietZone.y1],
      ['tag 2', p.tags[1].quietZone.x0, p.tags[1].quietZone.y0, p.tags[1].quietZone.x1, p.tags[1].quietZone.y1],
      ['bar', Number(bar[1]), Number(bar[2]), Number(bar[3]), Number(bar[2])],
      ['qr', p.qr.xMm, p.qr.yMm, p.qr.xMm + built.geometry.qrSizeMm, p.qr.yMm + built.geometry.qrSizeMm],
    ] as const) {
      assert.ok(a >= 0 && b >= 0 && d <= p.widthMm && e <= p.heightMm, `${label}: ${name} is off the page`)
    }
    assertTextClearOfQr(built.svg, p, p.qr, label)
    assertBalancedSvg(built.svg)
  }
})

test('the two markers\' crop marks are kept apart, down to the spacing where they would touch', () => {
  // A 400 mm tag has a 500 mm trim square; the marks reach 6.5 mm each side, so 13 mm between the squares is the least.
  assert.equal(pair({ sizeMm: 400, spacingMm: 513, page: 'a0' }).page.name, 'a0')
  assert.throws(() => pair({ sizeMm: 400, spacingMm: 512.9, page: 'a0' }), /do not fit 512\.9 mm apart/)
  assert.throws(() => pair({ sizeMm: 400, spacingMm: 500, page: 'a0' }), /two 400 mm tags with their margins and crop marks do not fit 500 mm apart/)
  const l = pairLayout({ widthMm: 1189, heightMm: 841 }, 400, 50, 513)
  assert.equal(l.separated, true)
  assert.equal(pairLayout({ widthMm: 1189, heightMm: 841 }, 400, 50, 512.9).separated, false)
})

test('the PRINTED pair, drawn into camera frames at four turns, is read as both ids, each where the sheet puts it', () => {
  const cases: Array<{ label: string; dictionary: Dictionary; ids: [number, number]; sizeMm: number; spacingMm: number; page: string; K: CameraIntrinsics; z: number; size: [number, number]; supersample: number }> = [
    { label: '6x6, 150 mm tags 500 mm apart at 1.6 m', dictionary: CSCAN6_V1, ids: [3, 4], sizeMm: 150, spacingMm: 500, page: 'a1', K: INTRINSICS_640, z: 1.6, size: [640, 480], supersample: 3 },
    { label: '5x5, 200 mm tags 800 mm apart at 2.4 m', dictionary: CSCAN5_V1, ids: [30, 1], sizeMm: 200, spacingMm: 800, page: 'a0', K: INTRINSICS_640, z: 2.4, size: [640, 480], supersample: 3 },
    { label: '6x6, 100 mm tags 1200 mm apart at 3 m, 1280 x 960', dictionary: CSCAN6_V1, ids: [127, 0], sizeMm: 100, spacingMm: 1200, page: '1500x400', K: INTRINSICS_1280, z: 3, size: [1280, 960], supersample: 2 },
  ]
  for (const c of cases) {
    const built = pair({ dictionary: c.dictionary, tagIds: c.ids, sizeMm: c.sizeMm, spacingMm: c.spacingMm, page: c.page })
    const art = pairArtwork(parsePairSheet(built.svg))
    const det = new FiducialDetector(c.dictionary)
    for (const [turn, spin] of [0, 90, 180, 270].entries()) {
      const pose = tagPose({ x: 0.02, y: -0.01, z: c.z }, spin + 6, [20, -15, 10, -25][turn]!, [8, -10, 12, 5][turn]!)
      const img = renderFrame({ width: c.size[0], height: c.size[1], intrinsics: c.K, items: [{ artwork: art, pose }], noiseSigma: 2, blurSigma: 0.6, seed: 11 + turn, supersample: c.supersample })
      const found = distinctReads(det.detect(img))
      const label = `${c.label}, spin ${spin}`
      assert.equal(found.length, 2, `${label}: ${found.length} detections`)
      for (const [i, id] of c.ids.entries()) {
        const d = found.find((f) => f.id === id)
        assert.ok(d, `${label}: id ${id} was not read (read ${found.map((f) => f.id)})`)
        // The tag's centre is where the sheet's own geometry puts it: half the spacing left or right of the pair's middle, level with it.
        const truth = project(pose, c.K, ((i === 0 ? -1 : 1) * c.spacingMm) / 2000, 0)
        const mid = { x: d.corners.reduce((s, k) => s + k.x, 0) / 4, y: d.corners.reduce((s, k) => s + k.y, 0) / 4 }
        assert.ok(Math.hypot(mid.x - truth.x, mid.y - truth.y) < 0.6, `${label}: id ${id} is ${Math.hypot(mid.x - truth.x, mid.y - truth.y).toFixed(2)} px from where the sheet puts it`)
        // The corners are in printed order: each within a tenth of the tag's side of the black square's corner it should be (a turned order is a whole side off).
        const h = c.sizeMm / 2000
        const cx = ((i === 0 ? -1 : 1) * c.spacingMm) / 2000
        const corners = [[-h, h], [h, h], [h, -h], [-h, -h]].map(([x, y]) => project(pose, c.K, cx + x!, y!))
        for (let k = 0; k < 4; k++) assert.ok(Math.hypot(d.corners[k]!.x - corners[k]!.x, d.corners[k]!.y - corners[k]!.y) < 0.1 * d.sidePx, `${label}: id ${id}, corner ${k}`)
      }
    }
  }
})

test('the pair artwork is the two quiet zones with their ink, and nothing between them', () => {
  const p = parsePairSheet(pair().svg)
  const art = pairArtwork(p)
  const mid = { x: (p.tags[0].centreXMm + p.tags[1].centreXMm) / 2, y: p.tags[0].centreYMm }
  const at = (xMm: number, yMm: number) => art.shade((xMm - mid.x) / 1000, (mid.y - yMm) / 1000)
  assert.equal(at(mid.x, mid.y), -1, 'between the two tags there is no sheet')
  for (const t of p.tags) {
    assert.equal(at(t.xMm + 1, t.yMm + 1), 25, 'the corner of the black ring is ink')
    assert.equal(at(t.xMm - 1, t.yMm - 1), 225, 'just outside the ring is white margin')
    assert.equal(at(t.quietZone.x0 - 1, t.centreYMm), -1, 'outside the margin is off the sheet')
  }
  assert.ok(art.halfExtent >= (p.tags[1].quietZone.x1 - p.tags[0].quietZone.x0) / 2000 - 1e-9, 'the artwork reaches the outer edges of both margins')
})

// ---------------------------------------------------------------------------------------------
// Refusals, pages and arithmetic
// ---------------------------------------------------------------------------------------------

test('a pair is refused unless it can be printed and read: the ids, the spacing, the size and the margin', () => {
  assert.throws(() => pair({ tagIds: [3, 3] }), /must be different ids/)
  assert.throws(() => pair({ tagIds: [3] as never }), /exactly two tag ids/)
  assert.throws(() => pair({ tagIds: [3, 4, 5] as never }), /exactly two tag ids/)
  assert.throws(() => pair({ tagIds: undefined as never }), /exactly two tag ids/)
  assert.throws(() => pair({ tagIds: [3, 128] }), /whole number from 0 to 127/)
  assert.throws(() => pair({ tagIds: [-1, 2] }), /whole number from 0 to 127/)
  assert.throws(() => pair({ tagIds: [3, 1.5] }), /whole number/)
  assert.throws(() => pair({ tagIds: [3, 32], dictionary: CSCAN5_V1 }), /whole number from 0 to 31/)
  for (const spacingMm of [499.9, 1200.1, 0, -500, Number.NaN, Number.POSITIVE_INFINITY]) assert.throws(() => pair({ spacingMm }), /spacing must be from 500 to 1200 mm/, String(spacingMm))
  assert.equal(MIN_SPACING_MM, 500)
  assert.equal(MAX_SPACING_MM, 1200)
  assert.doesNotThrow(() => pair({ spacingMm: 500 }))
  assert.doesNotThrow(() => pair({ spacingMm: 1200, sizeMm: 100, page: '1500x400' }))
  assert.throws(() => pair({ sizeMm: 39 }), /size must be from 40 to 600 mm/)
  assert.throws(() => pair({ sizeMm: 601 }), /size must be from 40 to 600 mm/)
  assert.throws(() => pair({ placeId: '' }), /place id is required/)
  assert.throws(() => pair({ quietCells: 0.5 }), /at least 1 cell/)
})

test('page choice for a pair: the smallest landscape page that holds it, a custom size by name, and an error that says what would', () => {
  // Auto picks the smallest of A4..A0 as it lies: landscape.
  assert.equal(pair({ sizeMm: 50, spacingMm: 500, page: 'auto' }).page.name, 'a2')
  assert.equal(pair({ sizeMm: 100, spacingMm: 500, page: 'auto' }).page.name, 'a1')
  assert.equal(pair({ sizeMm: 150, spacingMm: 800, page: 'auto' }).page.name, 'a0')
  const a1 = pair({ page: 'a1' }).page
  assert.deepEqual([a1.widthMm, a1.heightMm], [PAGES.a1.heightMm, PAGES.a1.widthMm], 'a named page is turned to lie')
  // Nothing a person can print holds a pair at the far end: the error says what size it needs and how to name one.
  assert.throws(() => pair({ sizeMm: 150, spacingMm: 1200, page: 'auto' }), /needs a page at least 1416\.5 x 302\.5 mm/)
  assert.throws(() => pair({ sizeMm: 150, spacingMm: 1200, page: 'auto' }), /the largest page tried is 1189 x 841 mm/)
  assert.throws(() => pair({ sizeMm: 150, spacingMm: 1200, page: 'auto' }), /--page <W>x<H>/)
  assert.throws(() => pair({ sizeMm: 150, spacingMm: 1200, page: 'a1' }), /"a1" is 841 x 594 mm/)
  assert.throws(() => pair({ page: 'tabloid' }), /needs a page at least/)
  // A custom page is as given, wider than tall or not, and must hold the pair as it lies.
  const wide = pair({ sizeMm: 100, spacingMm: 1200, page: '1500x400' }).page
  assert.deepEqual([wide.name, wide.widthMm, wide.heightMm], ['1500x400', 1500, 400])
  assert.throws(() => pair({ sizeMm: 100, spacingMm: 1200, page: '1000x400' }), /"1000x400" is 1000 x 400 mm/)
  assert.throws(() => pair({ sizeMm: 100, spacingMm: 1200, page: '400x1500' }), /"400x1500" is 400 x 1500 mm/)
  assert.throws(() => pair({ sizeMm: 150, spacingMm: 500, page: '900x200' }), /needs a page at least 716\.5 x 302\.5 mm/)
  assert.throws(() => pair({ page: '40x400' }), /a custom page must be from 50 to 3000 mm on each side/)
  assert.throws(() => pair({ page: '3001x400' }), /a custom page must be from 50 to 3000 mm on each side/)
  assert.throws(() => pair({ page: 'a5' as never }), /unknown page "a5"/)
  // The same names work for one marker, as given.
  const one = single({ sizeMm: 100, page: '300x300' }).page
  assert.deepEqual([one.name, one.widthMm, one.heightMm], ['300x300', 300, 300])
})

test('pageByName reads a named page or a size in millimetres and nothing else, and sheetLayout and pairLayout are the arithmetic the sheets follow', () => {
  assert.deepEqual(pageByName('a4'), PAGES.a4)
  assert.deepEqual(pageByName('1500x400'), { widthMm: 1500, heightMm: 400 })
  assert.deepEqual(pageByName('1500.5x400'), { widthMm: 1500.5, heightMm: 400 })
  for (const name of ['a5', '', 'constructor', '__proto__', 'toString', '1500', '1500x', 'x400', '1500X400', '1500 x 400', '-5x400']) assert.equal(pageByName(name), null, name)
  assert.throws(() => pageByName('49x400'), /from 50 to 3000/)
  assert.throws(() => pageByName('400x3001'), /from 50 to 3000/)

  // One marker: A4 takes a 6x6 tag up to 144 mm and a 5x5 one up to 140 mm; A3 takes a 160 mm one (the size DX8 prints).
  const fits = (page: { widthMm: number; heightMm: number }, size: number, cells: number) => sheetLayout(page, size, size / cells).fits
  assert.equal(fits(PAGES.a4, 144, 8), true)
  assert.equal(fits(PAGES.a4, 145, 8), false)
  assert.equal(fits(PAGES.a4, 140, 7), true)
  assert.equal(fits(PAGES.a4, 141, 7), false)
  assert.equal(fits(PAGES.a3, 160, 8), true)
  assert.equal(fits(PAGES.a3, 214, 8), true)
  assert.equal(fits(PAGES.a3, 215, 8), false)

  // Two markers: the squares sit symmetrically about the page's middle, the second `spacing` to the right of the first.
  const l = pairLayout({ widthMm: 841, heightMm: 594 }, 150, 18.75, 500)
  assert.equal(l.trim, 187.5)
  assert.deepEqual(l.trims, [76.75, 576.75])
  assert.deepEqual(l.tagXs, [95.5, 595.5])
  assert.equal(l.trims[1]! - l.trims[0]!, 500)
  assert.equal((l.trims[0]! + l.trims[1]! + l.trim) / 2, 841 / 2)
  assert.equal(l.fits, true)
  assert.equal(l.neededWidth, 500 + 187.5 + 2 * 6.5 + 16)
  // A page one millimetre too narrow does not fit.
  assert.equal(pairLayout({ widthMm: 715.5, heightMm: 594 }, 150, 18.75, 500).fits, false)
  assert.equal(pairLayout({ widthMm: 716.5, heightMm: 594 }, 150, 18.75, 500).fits, true)
})

test('a two-marker sheet is deterministic, every input reaches it, and it is a well-formed document', () => {
  assert.equal(pair().svg, pair().svg)
  const base = pair().svg
  for (const change of [
    { tagIds: [4, 3] as [number, number] }, { tagIds: [3, 5] as [number, number] }, { spacingMm: 501 }, { sizeMm: 151 }, { placeId: 'place-hall-10' }, { roomId: 'room-a' }, { page: 'a0' as const }, { quietCells: 1.5 },
    { dictionary: CSCAN5_V1 }, { mount: 'wall' as const }, { mount: 'horizontal' as const },
  ]) {
    assert.notEqual(pair(change).svg, base, `changing ${JSON.stringify(change)} changed nothing`)
  }
  assert.notEqual(pair({ mount: 'wall', mountHeightMm: 1200 }).svg, pair({ mount: 'wall', mountHeightMm: 1300 }).svg)
  assertBalancedSvg(base)
  assertBalancedSvg(pair({ placeId: 'p"<script>&</script>', roomId: 'r<&>' }).svg)
  assert.ok(!pair({ placeId: 'p"<script>&</script>' }).svg.includes('<script>'), 'text from the Place is escaped')
})
