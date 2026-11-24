#!/usr/bin/env node
/**
 * print-fiducial.mjs — an exact-size, print-ready SVG sheet for one Companion Scan marker, or for a pair of them on one sheet.
 *
 *   npm run print:fiducial -- --id 7 --size-mm 200 --place-id <place> [--room-id <room>] \
 *       [--family cscan-6x6-v1] [--page auto|a4|a3|a2|a1|a0|letter|tabloid|<W>x<H>] \
 *       [--mount wall|horizontal --mount-height-mm 1200] [--out marker-7.svg]
 *
 *   npm run print:fiducial -- --ids 7,8 --spacing-mm 800 --size-mm 150 --place-id <place> [...the same]
 *
 * (`npm run print:fiducial` is `node scripts/print-fiducial.mjs`; run that directly where the npm script
 * is not wired.)
 *
 * The sheet carries, at physical size (1 SVG user unit = 1 mm, `width`/`height` in mm):
 *   - the tag: a black square of exactly `--size-mm` edge length, `bits + 2` cells across, in the
 *     orientation the detector expects (see `src/ar/fiducial/dictionary.ts`), inside a white quiet
 *     zone of `--quiet-cells` cells (default and minimum 1: the detector samples half a cell outside
 *     the border and expects white there);
 *   - crop marks at the corners of the tag plus its quiet zone, so it can be trimmed and mounted;
 *   - the tag id, family, printed size and cell size as text;
 *   - a QR code and a text line carrying `{ v, family, tagId, placeId, roomId, printedSizeMm }`
 *     (`src/ar/fiducial/payload.ts`), and, when asked for, the mount and its height, and a partner tag;
 *   - a 100 mm scale bar. Printers set to "fit to page" shrink a sheet by a few percent and nothing
 *     in the file can see that; the bar lets a person measure it, and the measured tag size is the
 *     number the Place should be told;
 *   - a line asking for the sheet to be mounted flat: the detector locates the four edges as straight
 *     lines, so a bowed or curled edge moves the corners by about its sag (a 1 % bow of a side is a
 *     0.65 px corner shift on a 72 px tag, measured on synthetic frames);
 *   - the DENSO WAVE trademark notice the WP-14b spec asks for beside the QR code (`DENSO_WAVE_NOTICE`).
 *
 * ## The size a sheet states
 *
 * `--size-mm` (`printedSizeMm`) is the edge of the black square: the OUTER edge of the black ring. It is what a ruler measures on
 * the print, and the sheet says so. It is not always the quad the detector measures (AprilTag's tag36h11 states its size between its
 * black borders, 8 of its 10 cells; tagStandard41h12's detection quad is 5/9 of its printed width), so the sheet also carries the
 * family's `quadFraction` (`src/ar/fiducial/families.ts`) as `data-quad-fraction` and the quad's edge as `data-quad-mm`. For the two
 * families that can be printed here the fraction is 1.
 *
 * ## One sheet with two markers
 *
 * `--ids a,b --spacing-mm s` prints two tags on ONE sheet, landscape, with their centres exactly `s` millimetres apart (500 to 1200:
 * the spacing is the sheet's, so it cannot be mis-measured on the wall, and cutting the sheet apart loses it). It exists
 * because a single wall tag seen nearly face-on has two poses that fit about equally well (a 22 % flip rate at 3 m in R1's Monte Carlo
 * against none for two tags 0.8 m apart), and the one print removes most of it. A pair this wide needs a poster-size page: the sheet is the
 * spacing, plus a tag's black square and margins, plus 29 mm for the crop marks and the page margins, and A2 landscape is 594 mm wide, A1 841 mm
 * and A0 1189 mm; `--page <W>x<H>` names a print-shop size for the rest. Reading the pair as
 * one 8-corner pose is a later slice; today each tag is read on its own, and the payload names the partner and the offset.
 *
 * Deterministic: the same arguments give the same bytes, so a sheet can be diffed and the QR code
 * does not change when nothing else did. No clock, no randomness.
 *
 * The QR renderer it reuses, `src/ui/qr-code.ts`, sits on the vendored Nayuki encoder, which uses a
 * TypeScript namespace that Node's type stripping cannot load, so it is compiled first
 * (scripts/lib/qr-code-compiled.mjs). It is the repo's one SVG QR path; `npm run qr`
 * (qrcode-terminal) only draws to a terminal.
 */
import { writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import process from 'node:process'
import { DEFAULT_TAG_FAMILY, DEFAULT_TAG_FAMILY_NAME, TAG_FAMILIES, tagFamilyByName } from '../src/ar/fiducial/families.ts'
import { parseTagPayload, serializeTagPayload } from '../src/ar/fiducial/payload.ts'
import { loadCompiledQrCode } from './lib/qr-code-compiled.mjs'

/** Portrait page sizes, millimetres. */
export const PAGES = {
  a4: { widthMm: 210, heightMm: 297 },
  a3: { widthMm: 297, heightMm: 420 },
  a2: { widthMm: 420, heightMm: 594 },
  a1: { widthMm: 594, heightMm: 841 },
  a0: { widthMm: 841, heightMm: 1189 },
  letter: { widthMm: 215.9, heightMm: 279.4 },
  tabloid: { widthMm: 279.4, heightMm: 431.8 },
}

/** What `--page auto` tries, smallest first. Letter and tabloid are chosen by name only: a metric default for a metric repo. */
const AUTO_PAGES = ['a4', 'a3', 'a2', 'a1', 'a0']

/**
 * Smallest and largest tag the generator will make, millimetres. Adopted, not measured: below 40 mm no
 * phone reads it at a useful range; the largest is what an A0 sheet holds with its margin and footer (631 mm),
 * rounded down, so every size the generator accepts has a page it fits on.
 */
export const MIN_SIZE_MM = 40
export const MAX_SIZE_MM = 600

/**
 * Nearest and farthest the two tags of a pair may be, centre to centre, millimetres. The WP-14b spec's 0.5 to 1.2 m: closer and the
 * pair is one small target (the flip gain is gone), farther and the sheet is a banner nobody can hang flat. Adopted, not measured.
 */
export const MIN_SPACING_MM = 500
export const MAX_SPACING_MM = 1200

/** The largest custom page, millimetres a side: a print shop's banner roll. Adopted, not measured. */
export const MAX_CUSTOM_PAGE_MM = 3000

/**
 * Layout dimensions, millimetres: where the margins, text, marks and QR code sit. A design choice, not a
 * measurement (ADR 0005 rule 5 governs tolerances on the world, and none of these is one): the black
 * square and its cell grid are exact, and these only place the rest around them. The 100 mm scale bar is
 * a round length a person can lay a ruler on.
 */
const MARGIN_MM = 8
const HEADER_MM = 16
const GAP_MM = 2
const CROP_GAP_MM = 1.5
const CROP_LEN_MM = 5
const FOOTER_GAP_MM = 4
/**
 * The footer holds the most lines it can carry (place, room, mount, family, size, the pair note, cell, print, mounting, the scale bar's
 * two), the payload on up to three lines and the trademark. The payload cannot wrap to more: ids are held to what the scanner reads back
 * (the payload check in the builders), and a line of text that would not fit beside the QR code is refused first (`footerSvg`). The tests
 * measure the lowest line against the bottom margin for the longest ids each page takes.
 */
const FOOTER_MM = 64
const QR_MM = 36
const SCALE_BAR_MM = 100
const LINE_MM = 4
/**
 * What one character of the 3.2 mm text takes, millimetres: a little over Helvetica's average of half an em, so that a line is judged longer than it is,
 * never shorter. An estimate of a font this script does not measure; adopted, not measured (ADR 0005 rule 5). It only decides how far left the text may start.
 */
const TEXT_CHAR_MM = 1.7
/** Clear space between the text and the QR code, millimetres. */
const QR_GAP_MM = 3
/** What the "100 mm" label after the scale bar takes, millimetres. */
const BAR_LABEL_MM = 14
const INK = '#000000'
const PAPER = '#ffffff'
const FONT = 'Helvetica, Arial, sans-serif'
const MONO = 'Courier New, Courier, monospace'

/**
 * The trademark notice printed beside the QR code, in the wording the WP-14b spec gives (its section on notices). DENSO WAVE's own page asks for a
 * notice where the words "QR Code" are used in a publication and says none is needed where only the image is used
 * (https://www.qrcode.com/en/faq.html, "QR Code's intellectual property right"), so this line is more than that page asks for; the page words it
 * without the "a" before "registered". Which text is printed is the owner's decision (listed among the new strings in the WP-14b report).
 */
export const DENSO_WAVE_NOTICE = 'QR Code is a registered trademark of DENSO WAVE INCORPORATED.'

/** A number as it is written into the SVG: at most four decimals (0.1 micrometre), no trailing zeros, no exponent. */
export function mm(n) {
  const r = Math.round(n * 1e4) / 1e4
  return Object.is(r, -0) ? '0' : String(r)
}

function escapeXml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/** Break `text` into lines of at most `width` characters, deterministically. */
function wrap(text, width) {
  const lines = []
  for (let i = 0; i < text.length; i += width) lines.push(text.slice(i, i + width))
  return lines
}

/**
 * The repo's QR renderer, compiled and loaded on demand, so that building a sheet with an injected
 * renderer (a test, or a caller that has its own) does not compile it.
 *
 * @returns {Promise<(text: string, options: { size: number, level: 'L'|'M'|'Q'|'H', label: string }) => string>}
 */
export async function loadQrSvg() {
  try {
    return (await loadCompiledQrCode()).qrCodeSvg
  } catch (e) {
    throw new Error(`could not load src/ui/qr-code.ts (${e instanceof Error ? e.message.split('\n')[0] : e}).`)
  }
}

/**
 * A page by name (portrait), or by `<W>x<H>` in millimetres (the sizes as given: a banner is wider than it is tall).
 * @param {string} name
 * @returns {{ widthMm: number, heightMm: number } | null}
 */
export function pageByName(name) {
  if (Object.hasOwn(PAGES, name)) return PAGES[name]
  const m = /^(\d+(?:\.\d+)?)x(\d+(?:\.\d+)?)$/.exec(name)
  if (!m) return null
  const widthMm = Number(m[1])
  const heightMm = Number(m[2])
  if (!(widthMm >= 50 && heightMm >= 50 && widthMm <= MAX_CUSTOM_PAGE_MM && heightMm <= MAX_CUSTOM_PAGE_MM)) {
    throw new RangeError(`a custom page must be from 50 to ${MAX_CUSTOM_PAGE_MM} mm on each side`)
  }
  return { widthMm, heightMm }
}

/**
 * Where everything goes, in millimetres, for a tag of `sizeMm` on a page of `page`. Pure arithmetic;
 * `buildSheet` and the tests both read it.
 *
 * @param {{ widthMm: number, heightMm: number }} page
 * @param {number} sizeMm
 * @param {number} quietMm
 */
export function sheetLayout(page, sizeMm, quietMm) {
  const trim = sizeMm + 2 * quietMm
  const reach = CROP_GAP_MM + CROP_LEN_MM
  const neededWidth = trim + 2 * reach + 2 * MARGIN_MM
  const neededHeight = MARGIN_MM + HEADER_MM + GAP_MM + reach + trim + reach + FOOTER_GAP_MM + FOOTER_MM + MARGIN_MM
  const trimX = (page.widthMm - trim) / 2
  const trimY = MARGIN_MM + HEADER_MM + GAP_MM + reach
  return {
    fits: neededWidth <= page.widthMm + 1e-9 && neededHeight <= page.heightMm + 1e-9,
    neededWidth,
    neededHeight,
    trim,
    trimX,
    trimY,
    tagX: trimX + quietMm,
    tagY: trimY + quietMm,
    footerY: trimY + trim + reach + FOOTER_GAP_MM,
  }
}

/**
 * The layout of a sheet with two tags side by side, their centres `spacingMm` apart (landscape: `page` is the page as it lies). The two
 * tags are placed symmetrically about the page's middle; the second is `spacingMm` to the right of the first, at the same height.
 *
 * @param {{ widthMm: number, heightMm: number }} page
 * @param {number} sizeMm
 * @param {number} quietMm
 * @param {number} spacingMm
 */
export function pairLayout(page, sizeMm, quietMm, spacingMm) {
  const one = sheetLayout({ widthMm: page.widthMm, heightMm: page.heightMm }, sizeMm, quietMm)
  const reach = CROP_GAP_MM + CROP_LEN_MM
  const neededWidth = spacingMm + one.trim + 2 * reach + 2 * MARGIN_MM
  const mid = page.widthMm / 2
  const trimX1 = mid - spacingMm / 2 - one.trim / 2
  const trimX2 = mid + spacingMm / 2 - one.trim / 2
  return {
    fits: neededWidth <= page.widthMm + 1e-9 && one.neededHeight <= page.heightMm + 1e-9,
    neededWidth,
    neededHeight: one.neededHeight,
    trim: one.trim,
    trimY: one.trimY,
    tagY: one.tagY,
    footerY: one.footerY,
    trims: [trimX1, trimX2],
    tagXs: [trimX1 + quietMm, trimX2 + quietMm],
    /** The two crop-mark sets must not run into each other. */
    separated: spacingMm - one.trim >= 2 * reach - 1e-9,
  }
}

/** Ink: one rectangle per horizontal run of black cells, absolute coordinates so that shared edges are the same string. */
function tagInk(dictionary, tagId, tagX, tagY, cellMm) {
  const bits = dictionary.bits
  const cells = bits + 2
  const pattern = dictionary.pattern(tagId)
  const isBlack = (r, c) => r === 0 || c === 0 || r === cells - 1 || c === cells - 1 || pattern[(r - 1) * bits + (c - 1)] === 1
  let ink = ''
  for (let r = 0; r < cells; r++) {
    let c = 0
    while (c < cells) {
      if (!isBlack(r, c)) {
        c++
        continue
      }
      const start = c
      while (c < cells && isBlack(r, c)) c++
      const x0 = tagX + start * cellMm
      const x1 = tagX + c * cellMm
      const y0 = tagY + r * cellMm
      const y1 = tagY + (r + 1) * cellMm
      ink += `M${mm(x0)} ${mm(y0)}H${mm(x1)}V${mm(y1)}H${mm(x0)}Z`
    }
  }
  return ink
}

/** Crop marks: the extension of each trim edge, outside the trim square at (`trimX`, `trimY`) of side `trim`. */
function cropMarks(trimX, trimY, trim) {
  const tx0 = trimX
  const ty0 = trimY
  const tx1 = trimX + trim
  const ty1 = trimY + trim
  const g = CROP_GAP_MM
  const L = CROP_LEN_MM
  let crop = ''
  for (const [x, y, sx, sy] of [[tx0, ty0, -1, -1], [tx1, ty0, 1, -1], [tx1, ty1, 1, 1], [tx0, ty1, -1, 1]]) {
    crop += `M${mm(x + sx * g)} ${mm(y)}H${mm(x + sx * (g + L))}M${mm(x)} ${mm(y + sy * g)}V${mm(y + sy * (g + L))}`
  }
  return crop
}

function checkCommon(args, dictionary) {
  const { sizeMm, placeId } = args
  const quietCells = args.quietCells ?? 1
  if (!Number.isFinite(sizeMm) || sizeMm < MIN_SIZE_MM || sizeMm > MAX_SIZE_MM) throw new RangeError(`size must be from ${MIN_SIZE_MM} to ${MAX_SIZE_MM} mm`)
  if (typeof placeId !== 'string' || placeId.length === 0) throw new RangeError('a place id is required')
  if (!(quietCells >= 1)) throw new RangeError('the white margin must be at least 1 cell: the detector reads half a cell outside the border')
  const family = tagFamilyByName(dictionary.name)
  if (!family) throw new RangeError(`family ${dictionary.name} is not registered in src/ar/fiducial/families.ts (it has no stated quad fraction)`)
  const mount = args.mount ?? null
  const mountHeightMm = args.mountHeightMm ?? null
  if (mount !== null && mount !== 'wall' && mount !== 'horizontal') throw new RangeError('mount must be wall or horizontal')
  if (mountHeightMm !== null && !(Number.isFinite(mountHeightMm) && mountHeightMm >= 0 && mountHeightMm <= 4000)) throw new RangeError('the mount height must be from 0 to 4000 mm')
  if (mountHeightMm !== null && mount === null) throw new RangeError('a mount height needs a mount (wall or horizontal)')
  return { family, quietCells, mount, mountHeightMm }
}

function checkTagId(tagId, dictionary) {
  if (!Number.isInteger(tagId) || tagId < 0 || tagId >= dictionary.size) throw new RangeError(`tag id must be a whole number from 0 to ${dictionary.size - 1}`)
}

/**
 * The payload line the QR code carries, checked the way the scanner will read it: a sheet whose code the scanner would refuse (an empty
 * room id, a place id longer than it accepts) is not printed.
 */
function checkedPayloadText(payload) {
  const text = serializeTagPayload(payload)
  if (parseTagPayload(text) === null) throw new RangeError('the QR code on this sheet would not be readable by the scanner: check the place and room ids (empty, or too long)')
  return text
}

/** Pick the page for `layoutOf`, trying `candidates` in order (names), or a custom `<W>x<H>`; throw what would fit when none does. */
function choosePage(wanted, candidates, landscape, layoutOf, describe) {
  const orient = (p) => (landscape ? { widthMm: p.heightMm, heightMm: p.widthMm } : p)
  for (const name of candidates) {
    const size = pageByName(name)
    if (!size) throw new RangeError(`unknown page "${name}" (use ${Object.keys(PAGES).join(', ')}, <W>x<H> in mm, or auto)`)
    const placed = Object.hasOwn(PAGES, name) ? orient(size) : size
    const l = layoutOf(placed)
    if (l.fits) return { page: { name, ...placed }, layout: l }
  }
  const last = pageByName(candidates[candidates.length - 1])
  const placed = Object.hasOwn(PAGES, candidates[candidates.length - 1]) ? orient(last) : last
  const need = layoutOf(placed)
  throw new RangeError(
    `${describe} with its margin needs a page at least ${mm(need.neededWidth)} x ${mm(need.neededHeight)} mm; ` +
      `${wanted === 'auto' ? 'the largest page tried' : `"${wanted}"`} is ${mm(placed.widthMm)} x ${mm(placed.heightMm)} mm. ` +
      `Choose a smaller tag${landscape ? ' or closer spacing' : ''}, a larger page, or name a size with --page <W>x<H> (mm).`,
  )
}

/** The text lines that are the same on every sheet, then those that depend on the family and the mount. */
function footerLines(args, family, cellMm, quietMm, extra) {
  const lines = [`Place: ${args.placeId}`, `Room: ${args.roomId ?? 'none (the whole Place)'}`]
  if (args.mount) {
    lines.push(
      args.mountHeightMm === null
        ? `Mount: ${args.mount}.`
        : `Mount: ${args.mount}, centre of the black square ${mm(args.mountHeightMm)} mm above the floor.`,
    )
  }
  lines.push(
    `Family ${family.dictionary.name}: ${family.dictionary.bits}x${family.dictionary.bits} code, ${family.cells}x${family.cells} cells in all.`,
    `Size is the outer edge of the black ring: ${mm(args.sizeMm)} mm.`,
    ...extra,
    `Cell ${mm(cellMm)} mm. White margin ${mm(quietMm)} mm: keep it clear.`,
    'Print at 100% (actual size), not fit to page.',
    'Mount it flat on a hard surface: a curled sheet moves the corners.',
    `The bar below is ${SCALE_BAR_MM} mm. If it measures less or more,`,
    `the black square is ${mm(args.sizeMm)} mm x measured / ${SCALE_BAR_MM} mm.`,
  )
  return lines
}

/**
 * Footer SVG: text, scale bar, payload text, the QR and the trademark line. `left` is where the text starts when it can (under the tag's
 * margin), `fy` the footer's top. The text starts further left, down to the page margin, when its longest line would otherwise reach the QR code
 * (a small tag on a narrow page); a page too narrow for that is refused.
 */
function footerSvg({ page, left, fy, lines, payloadText, qrSvg, qrLabel }) {
  const qrX = Math.max(left, page.widthMm - MARGIN_MM - QR_MM)
  const longestMm = Math.max(...lines.map((line) => line.length)) * TEXT_CHAR_MM
  const textLeft = Math.max(MARGIN_MM, Math.min(left, qrX - QR_GAP_MM - longestMm))
  if (textLeft + longestMm + QR_GAP_MM > qrX + 1e-9 || textLeft + SCALE_BAR_MM + BAR_LABEL_MM > page.widthMm - MARGIN_MM + 1e-9) {
    throw new RangeError('the page is too narrow for the sheet text beside the QR code: use a wider page, or shorter place and room ids')
  }
  const textWidth = Math.floor((qrX - textLeft - 3) / 1.55)
  const payloadLines = wrap(payloadText, Math.max(20, textWidth))
  let text = ''
  let ty = fy + 3.4
  for (const line of lines) {
    text += `<text x="${mm(textLeft)}" y="${mm(ty)}" font-family="${FONT}" font-size="3.2" fill="${INK}">${escapeXml(line)}</text>`
    ty += LINE_MM
  }
  const barY = ty + 1.5
  const bar =
    `<g id="scale-bar" data-length-mm="${SCALE_BAR_MM}"><path d="M${mm(textLeft)} ${mm(barY)}H${mm(textLeft + SCALE_BAR_MM)}M${mm(textLeft)} ${mm(barY - 1.5)}V${mm(barY + 1.5)}M${mm(textLeft + SCALE_BAR_MM)} ${mm(barY - 1.5)}V${mm(barY + 1.5)}" stroke="${INK}" stroke-width="0.25" fill="none"/>` +
    `<text x="${mm(textLeft + SCALE_BAR_MM + 2)}" y="${mm(barY + 1)}" font-family="${FONT}" font-size="3.2" fill="${INK}">${SCALE_BAR_MM} mm</text></g>`
  let payloadSvg = ''
  let py = barY + 5.5
  for (const line of payloadLines) {
    payloadSvg += `<text x="${mm(textLeft)}" y="${mm(py)}" font-family="${MONO}" font-size="2.4" fill="${INK}" xml:space="preserve">${escapeXml(line)}</text>`
    py += 3
  }
  const notice = `<text id="denso-wave" x="${mm(textLeft)}" y="${mm(py + 0.5)}" font-family="${FONT}" font-size="2.4" fill="${INK}">${escapeXml(DENSO_WAVE_NOTICE)}</text>`
  const qr = qrSvg(payloadText, { size: QR_MM, level: 'M', label: qrLabel })
  return {
    svg: `<g id="footer">${text}${bar}${payloadSvg}${notice}<g id="qr" transform="translate(${mm(qrX)} ${mm(fy)})">${qr}</g></g>`,
    qrX,
    /** Bottom of the lowest thing in the footer, millimetres from the footer's top: what FOOTER_MM must hold. */
    usedMm: py + 0.5 + 0.6 - fy,
  }
}

/**
 * Build one sheet.
 *
 * @param {object} args
 * @param {number} args.tagId
 * @param {number} args.sizeMm              edge of the black square (its outer edge)
 * @param {string} args.placeId
 * @param {string | null} [args.roomId]
 * @param {string} [args.page]              'auto', a name in PAGES, or '<W>x<H>' millimetres
 * @param {number} [args.quietCells]        white margin around the black square, in cells (>= 1)
 * @param {import('../src/ar/fiducial/types.ts').Dictionary} [args.dictionary]   default: the default family's
 * @param {'wall' | 'horizontal' | null} [args.mount]   how the sheet is to be mounted, printed on it and carried in the payload
 * @param {number | null} [args.mountHeightMm]          the black square's centre above the floor, millimetres (needs a mount)
 * @param {(text: string, options: { size: number, level: 'L'|'M'|'Q'|'H', label: string }) => string} args.qrSvg
 */
export function buildSheet(args) {
  const dictionary = args.dictionary ?? DEFAULT_TAG_FAMILY.dictionary
  const { tagId, sizeMm, placeId } = args
  const roomId = args.roomId ?? null
  checkTagId(tagId, dictionary)
  const { family, quietCells, mount, mountHeightMm } = checkCommon(args, dictionary)

  const bits = dictionary.bits
  const cells = bits + 2
  const cellMm = sizeMm / cells
  const quietMm = quietCells * cellMm

  const wanted = args.page ?? 'auto'
  const { page, layout } = choosePage(wanted, wanted === 'auto' ? AUTO_PAGES : [wanted], false, (p) => sheetLayout(p, sizeMm, quietMm), `a ${mm(sizeMm)} mm tag`)

  /** @type {import('../src/ar/fiducial/types.ts').TagPayload} */
  const payload = { v: 1, family: dictionary.name, tagId, placeId, roomId, printedSizeMm: sizeMm }
  if (mount) payload.mount = mount
  if (mountHeightMm !== null) payload.mountHeightMm = mountHeightMm
  const payloadText = checkedPayloadText(payload)

  const ink = tagInk(dictionary, tagId, layout.tagX, layout.tagY, cellMm)
  const crop = cropMarks(layout.trimX, layout.trimY, layout.trim)
  const cx = page.widthMm / 2
  const footer = footerSvg({
    page,
    left: layout.trimX,
    fy: layout.footerY,
    lines: footerLines({ sizeMm, placeId, roomId, mount, mountHeightMm }, family, cellMm, quietMm, []),
    payloadText,
    qrSvg: args.qrSvg,
    qrLabel: `Marker ${tagId}: ${placeId}`,
  })

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${mm(page.widthMm)}mm" height="${mm(page.heightMm)}mm" viewBox="0 0 ${mm(page.widthMm)} ${mm(page.heightMm)}" ` +
    `data-family="${escapeXml(dictionary.name)}" data-bits="${bits}" data-cells="${cells}" data-quad-fraction="${mm(family.quadFraction)}" data-quad-mm="${mm(sizeMm * family.quadFraction)}" ` +
    `data-tag-id="${tagId}" data-size-mm="${mm(sizeMm)}" data-cell-mm="${mm(cellMm)}" data-quiet-mm="${mm(quietMm)}" data-page="${page.name}">` +
    `<title>Companion Scan marker ${tagId}, ${mm(sizeMm)} mm</title>` +
    `<desc>${escapeXml(payloadText)}</desc>` +
    `<rect id="page" width="${mm(page.widthMm)}" height="${mm(page.heightMm)}" fill="${PAPER}"/>` +
    `<g id="header"><text x="${mm(cx)}" y="${mm(MARGIN_MM + 6)}" text-anchor="middle" font-family="${FONT}" font-size="6" font-weight="bold" fill="${INK}">Companion Scan marker</text>` +
    `<text x="${mm(cx)}" y="${mm(MARGIN_MM + 12)}" text-anchor="middle" font-family="${FONT}" font-size="3.8" fill="${INK}">Tag ${tagId} · ${escapeXml(dictionary.name)} · black square ${mm(sizeMm)} mm</text></g>` +
    `<path id="crop-marks" d="${crop}" stroke="${INK}" stroke-width="0.25" fill="none"/>` +
    `<g id="tag" data-tag-id="${tagId}" data-size-mm="${mm(sizeMm)}" data-x-mm="${mm(layout.tagX)}" data-y-mm="${mm(layout.tagY)}">` +
    `<rect id="quiet-zone" x="${mm(layout.trimX)}" y="${mm(layout.trimY)}" width="${mm(layout.trim)}" height="${mm(layout.trim)}" fill="${PAPER}"/>` +
    `<path id="tag-ink" d="${ink}" fill="${INK}"/></g>` +
    footer.svg +
    '</svg>\n'

  return {
    svg,
    page,
    payload,
    footerUsedMm: footer.usedMm,
    geometry: { tagXMm: layout.tagX, tagYMm: layout.tagY, sizeMm, cellMm, quietMm, trimMm: layout.trim, qrXMm: footer.qrX, qrYMm: layout.footerY, qrSizeMm: QR_MM, quadFraction: family.quadFraction, quadMm: sizeMm * family.quadFraction },
  }
}

/**
 * Build one sheet with two tags, their centres `spacingMm` apart (500 to 1200), landscape. The same arguments as {@link buildSheet}
 * with `tagIds` (two distinct ids of the family) and `spacingMm` in place of `tagId`. The first tag is on the left, and the QR code and
 * the payload name it, with the second as its `partner`: the second's id, and where its centre is from the first's, on the sheet, in mm
 * (x to the right, y up the sheet, so `dyMm` is 0).
 *
 * @param {object} args
 * @param {[number, number]} args.tagIds
 * @param {number} args.spacingMm            centre to centre, 500 to 1200
 * @param {number} args.sizeMm               edge of each black square (its outer edge)
 * @param {string} args.placeId
 * @param {string | null} [args.roomId]
 * @param {string} [args.page]               'auto' (the smallest of A4 to A0 that holds the pair, as it lies), a name in PAGES (turned to lie), or '<W>x<H>' millimetres as given
 * @param {number} [args.quietCells]         white margin round each black square, in cells (>= 1)
 * @param {import('../src/ar/fiducial/types.ts').Dictionary} [args.dictionary]   default: the default family's
 * @param {'wall' | 'horizontal' | null} [args.mount]
 * @param {number | null} [args.mountHeightMm]
 * @param {(text: string, options: { size: number, level: 'L'|'M'|'Q'|'H', label: string }) => string} args.qrSvg
 */
export function buildTwoTagSheet(args) {
  const dictionary = args.dictionary ?? DEFAULT_TAG_FAMILY.dictionary
  const { tagIds, sizeMm, placeId, spacingMm } = args
  const roomId = args.roomId ?? null
  if (!Array.isArray(tagIds) || tagIds.length !== 2) throw new RangeError('a pair sheet needs exactly two tag ids')
  for (const id of tagIds) checkTagId(id, dictionary)
  if (tagIds[0] === tagIds[1]) throw new RangeError('the two tags of a pair must be different ids: two copies of one id cannot be told apart')
  if (!Number.isFinite(spacingMm) || spacingMm < MIN_SPACING_MM || spacingMm > MAX_SPACING_MM) throw new RangeError(`spacing must be from ${MIN_SPACING_MM} to ${MAX_SPACING_MM} mm (centre to centre)`)
  const { family, quietCells, mount, mountHeightMm } = checkCommon(args, dictionary)

  const bits = dictionary.bits
  const cells = bits + 2
  const cellMm = sizeMm / cells
  const quietMm = quietCells * cellMm

  const wanted = args.page ?? 'auto'
  const { page, layout } = choosePage(wanted, wanted === 'auto' ? AUTO_PAGES : [wanted], true, (p) => pairLayout(p, sizeMm, quietMm, spacingMm), `a pair of ${mm(sizeMm)} mm tags ${mm(spacingMm)} mm apart`)
  if (!layout.separated) {
    throw new RangeError(`two ${mm(sizeMm)} mm tags with their margins and crop marks do not fit ${mm(spacingMm)} mm apart: use a smaller tag or a wider spacing`)
  }

  const [idA, idB] = tagIds
  /** @type {import('../src/ar/fiducial/types.ts').TagPayload} */
  const payload = { v: 1, family: dictionary.name, tagId: idA, placeId, roomId, printedSizeMm: sizeMm }
  if (mount) payload.mount = mount
  if (mountHeightMm !== null) payload.mountHeightMm = mountHeightMm
  payload.partner = { tagId: idB, dxMm: spacingMm, dyMm: 0 }
  const payloadText = checkedPayloadText(payload)

  const inks = [tagInk(dictionary, idA, layout.tagXs[0], layout.tagY, cellMm), tagInk(dictionary, idB, layout.tagXs[1], layout.tagY, cellMm)]
  const crop = cropMarks(layout.trims[0], layout.trimY, layout.trim) + cropMarks(layout.trims[1], layout.trimY, layout.trim)
  const cx = page.widthMm / 2
  const footer = footerSvg({
    page,
    left: layout.trims[0],
    fy: layout.footerY,
    lines: footerLines({ sizeMm, placeId, roomId, mount, mountHeightMm }, family, cellMm, quietMm, [`Markers ${idA} (left) and ${idB} (right): centres ${mm(spacingMm)} mm apart on this one sheet. Do not cut it apart.`]),
    payloadText,
    qrSvg: args.qrSvg,
    qrLabel: `Markers ${idA} and ${idB}: ${placeId}`,
  })

  const tagGroup = (n, id, ink) =>
    `<g id="tag-${n}" data-tag-id="${id}" data-size-mm="${mm(sizeMm)}" data-x-mm="${mm(layout.tagXs[n - 1])}" data-y-mm="${mm(layout.tagY)}" ` +
    `data-centre-x-mm="${mm(layout.tagXs[n - 1] + sizeMm / 2)}" data-centre-y-mm="${mm(layout.tagY + sizeMm / 2)}">` +
    `<rect id="quiet-zone-${n}" x="${mm(layout.trims[n - 1])}" y="${mm(layout.trimY)}" width="${mm(layout.trim)}" height="${mm(layout.trim)}" fill="${PAPER}"/>` +
    `<path id="tag-ink-${n}" d="${ink}" fill="${INK}"/></g>`

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${mm(page.widthMm)}mm" height="${mm(page.heightMm)}mm" viewBox="0 0 ${mm(page.widthMm)} ${mm(page.heightMm)}" ` +
    `data-layout="pair" data-family="${escapeXml(dictionary.name)}" data-bits="${bits}" data-cells="${cells}" data-quad-fraction="${mm(family.quadFraction)}" data-quad-mm="${mm(sizeMm * family.quadFraction)}" ` +
    `data-tag-ids="${idA},${idB}" data-size-mm="${mm(sizeMm)}" data-spacing-mm="${mm(spacingMm)}" data-cell-mm="${mm(cellMm)}" data-quiet-mm="${mm(quietMm)}" data-page="${page.name}">` +
    `<title>Companion Scan markers ${idA} and ${idB}, ${mm(sizeMm)} mm, ${mm(spacingMm)} mm apart</title>` +
    `<desc>${escapeXml(payloadText)}</desc>` +
    `<rect id="page" width="${mm(page.widthMm)}" height="${mm(page.heightMm)}" fill="${PAPER}"/>` +
    `<g id="header"><text x="${mm(cx)}" y="${mm(MARGIN_MM + 6)}" text-anchor="middle" font-family="${FONT}" font-size="6" font-weight="bold" fill="${INK}">Companion Scan markers</text>` +
    `<text x="${mm(cx)}" y="${mm(MARGIN_MM + 12)}" text-anchor="middle" font-family="${FONT}" font-size="3.8" fill="${INK}">Tags ${idA} and ${idB} · ${escapeXml(dictionary.name)} · black squares ${mm(sizeMm)} mm · centres ${mm(spacingMm)} mm apart</text></g>` +
    `<path id="crop-marks" d="${crop}" stroke="${INK}" stroke-width="0.25" fill="none"/>` +
    tagGroup(1, idA, inks[0]) +
    tagGroup(2, idB, inks[1]) +
    footer.svg +
    '</svg>\n'

  return {
    svg,
    page,
    payload,
    footerUsedMm: footer.usedMm,
    geometry: {
      tagXMm: layout.tagXs,
      tagYMm: layout.tagY,
      sizeMm,
      spacingMm,
      cellMm,
      quietMm,
      trimMm: layout.trim,
      qrXMm: footer.qrX,
      qrYMm: layout.footerY,
      qrSizeMm: QR_MM,
      quadFraction: family.quadFraction,
      quadMm: sizeMm * family.quadFraction,
    },
  }
}

function usage() {
  return [
    'usage: npm run print:fiducial -- --id <n> --size-mm <edge> --place-id <id> [--room-id <id>]',
    '       npm run print:fiducial -- --ids <a>,<b> --spacing-mm <500..1200> --size-mm <edge> --place-id <id> [--room-id <id>]',
    '           [--family <name>] [--page auto|a4|a3|a2|a1|a0|letter|tabloid|<W>x<H>] [--quiet-cells 1]',
    '           [--mount wall|horizontal [--mount-height-mm <n>]] [--out file.svg]',
    '       (or: node scripts/print-fiducial.mjs <the same arguments>)',
    '',
    `  --family       ${TAG_FAMILIES.map((f) => f.dictionary.name).join(' | ')} (default ${DEFAULT_TAG_FAMILY_NAME}); ids are 0 to size - 1 of the family`,
    `  --size-mm      edge of the black square (its outer edge), ${MIN_SIZE_MM} to ${MAX_SIZE_MM} (default 200)`,
    '  --page         default auto: the smallest of A4, A3, A2, A1, A0 that holds the tag and its margin (a pair: landscape)',
    '                 or a size in millimetres, <W>x<H>, for a print shop',
    '  --mount        how the sheet is to be mounted, printed on it and carried in the QR code; --mount-height-mm is the black square\'s centre above the floor',
    '  --out          write the SVG here instead of standard output',
  ].join('\n')
}

function parseArgs(argv) {
  const out = { id: null, ids: null, spacingMm: null, sizeMm: 200, placeId: null, roomId: null, page: 'auto', quietCells: 1, family: DEFAULT_TAG_FAMILY_NAME, mount: null, mountHeightMm: null, out: null, help: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const next = () => {
      const v = argv[++i]
      if (v === undefined) throw new RangeError(`${a} needs a value`)
      return v
    }
    if (a === '--id') out.id = Number(next())
    else if (a === '--ids') out.ids = next().split(',').map((s) => Number(s))
    else if (a === '--spacing-mm') out.spacingMm = Number(next())
    else if (a === '--size-mm') out.sizeMm = Number(next())
    else if (a === '--place-id') out.placeId = next()
    else if (a === '--room-id') out.roomId = next()
    else if (a === '--page') out.page = next()
    else if (a === '--quiet-cells') out.quietCells = Number(next())
    else if (a === '--family') out.family = next()
    else if (a === '--mount') out.mount = next()
    else if (a === '--mount-height-mm') out.mountHeightMm = Number(next())
    else if (a === '--out') out.out = next()
    else if (a === '--help' || a === '-h') out.help = true
    else throw new RangeError(`unknown argument ${a}`)
  }
  return out
}

async function main() {
  let args
  try {
    args = parseArgs(process.argv.slice(2))
  } catch (e) {
    console.error(`${e.message}\n\n${usage()}`)
    process.exit(2)
  }
  if (args.help) {
    console.log(usage())
    return
  }
  try {
    if ((args.id === null) === (args.ids === null) || args.placeId === null) throw new RangeError('--place-id and exactly one of --id and --ids are required')
    const family = tagFamilyByName(args.family)
    if (!family) throw new RangeError(`unknown family "${args.family}" (use ${TAG_FAMILIES.map((f) => f.dictionary.name).join(', ')})`)
    const qrSvg = await loadQrSvg()
    const common = { sizeMm: args.sizeMm, placeId: args.placeId, roomId: args.roomId, page: args.page, quietCells: args.quietCells, dictionary: family.dictionary, mount: args.mount, mountHeightMm: args.mountHeightMm, qrSvg }
    const { svg, page, geometry } =
      args.ids === null
        ? buildSheet({ ...common, tagId: args.id })
        : buildTwoTagSheet({ ...common, tagIds: args.ids, spacingMm: args.spacingMm })
    if (args.out) {
      writeFileSync(args.out, svg)
      console.error(`wrote ${args.out}: ${page.name.toUpperCase()} (${mm(page.widthMm)} x ${mm(page.heightMm)} mm), black square ${mm(geometry.sizeMm)} mm, cell ${mm(geometry.cellMm)} mm`)
    } else {
      process.stdout.write(svg)
    }
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e))
    process.exit(2)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main()
}
