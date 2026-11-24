/**
 * Read a print sheet back: the SVG `scripts/print-fiducial.mjs` writes is parsed as geometry so a
 * test can check what a ruler would, and so the printed tag itself (not the dictionary's idea of
 * it) can be drawn into a synthetic camera frame and handed to the detector.
 *
 * Only the constructs the generator emits are understood: a root `<svg>` with `width`/`height` in
 * millimetres and a matching viewBox, `<rect>` elements, and paths made of absolute `M`, `H`, `V`
 * and `Z` commands that trace axis-aligned rectangles. Anything else throws, so a generator change
 * that the parser cannot read fails loudly instead of passing quietly.
 *
 * `parseSheet` reads the one-tag sheet and `parsePairSheet` the two-tag sheet (`data-layout="pair"`); `sheetArtwork` and
 * `pairArtwork` turn the parsed ink into what a camera would see.
 */
import assert from 'node:assert/strict'
import type { PlanarArtwork } from './fiducial-render.ts'

export interface Rect {
  x0: number
  y0: number
  x1: number
  y1: number
}

export interface ParsedSheet {
  /** Page size from the root `width` / `height`, millimetres. */
  widthMm: number
  heightMm: number
  /** The viewBox numbers; equal to the page size when one user unit is one millimetre. */
  viewBox: [number, number, number, number]
  /** `data-*` attributes of the root element. */
  data: Record<string, string>
  /** The ink of the tag, as rectangles in millimetres on the page. */
  inkRects: Rect[]
  /** The quiet-zone rectangle (the white square the tag sits in). */
  quietZone: Rect
  /** The tag group's own `data-*`. */
  tag: { id: number; sizeMm: number; xMm: number; yMm: number }
  cropMarkPath: string
  /** Absolute path commands of the scale bar, and its declared length. */
  scaleBar: { lengthMm: number; path: string }
  qr: { xMm: number; yMm: number; svg: string }
}

function attr(tag: string, name: string): string | null {
  const m = new RegExp(`(?:^|\\s)${name}="([^"]*)"`).exec(tag)
  return m ? m[1]! : null
}

function mustAttr(tag: string, name: string): string {
  const v = attr(tag, name)
  if (v === null) throw new Error(`sheet: <${tag.slice(0, 40)}...> has no ${name}`)
  return v
}

function mmValue(text: string): number {
  const m = /^(-?[0-9.]+)mm$/.exec(text)
  if (!m) throw new Error(`sheet: "${text}" is not a size in millimetres`)
  return Number(m[1])
}

/** The rectangles of a path built from `M x y H x V y H x Z` groups. */
export function pathRects(d: string): Rect[] {
  const rects: Rect[] = []
  const re = /M(-?[0-9.]+) (-?[0-9.]+)H(-?[0-9.]+)V(-?[0-9.]+)H(-?[0-9.]+)Z/g
  let consumed = 0
  for (let m = re.exec(d); m; m = re.exec(d)) {
    if (m.index !== consumed) throw new Error(`sheet: path has a segment that is not a rectangle near ${consumed}`)
    consumed = m.index + m[0].length
    const x0 = Number(m[1])
    const y0 = Number(m[2])
    const x1 = Number(m[3])
    const y1 = Number(m[4])
    if (Number(m[5]) !== x0) throw new Error('sheet: rectangle does not close on its starting x')
    rects.push({ x0: Math.min(x0, x1), y0: Math.min(y0, y1), x1: Math.max(x0, x1), y1: Math.max(y0, y1) })
  }
  if (consumed !== d.length) throw new Error('sheet: path has trailing commands that are not rectangles')
  return rects
}

export function parseSheet(svg: string): ParsedSheet {
  const root = /^<svg\b([^>]*)>/.exec(svg)
  if (!root) throw new Error('sheet: not an <svg> document')
  const rootTag = root[1]!
  const widthMm = mmValue(mustAttr(rootTag, 'width'))
  const heightMm = mmValue(mustAttr(rootTag, 'height'))
  const vb = mustAttr(rootTag, 'viewBox').split(' ').map(Number)
  if (vb.length !== 4 || vb.some((n) => !Number.isFinite(n))) throw new Error('sheet: bad viewBox')
  const data: Record<string, string> = {}
  for (const m of rootTag.matchAll(/(data-[a-z-]+)="([^"]*)"/g)) data[m[1]!] = m[2]!

  const inkPath = /<path id="tag-ink" d="([^"]*)"/.exec(svg)
  if (!inkPath) throw new Error('sheet: no tag-ink path')
  const quiet = /<rect id="quiet-zone" x="([^"]*)" y="([^"]*)" width="([^"]*)" height="([^"]*)"/.exec(svg)
  if (!quiet) throw new Error('sheet: no quiet-zone rect')
  const tagGroup = /<g id="tag" ([^>]*)>/.exec(svg)
  if (!tagGroup) throw new Error('sheet: no tag group')
  const crop = /<path id="crop-marks" d="([^"]*)"/.exec(svg)
  if (!crop) throw new Error('sheet: no crop marks')
  const bar = /<g id="scale-bar" data-length-mm="([^"]*)"><path d="([^"]*)"/.exec(svg)
  if (!bar) throw new Error('sheet: no scale bar')
  const qr = /<g id="qr" transform="translate\(([^ ]*) ([^)]*)\)">(<svg [\s\S]*?<\/svg>)<\/g>/.exec(svg)
  if (!qr) throw new Error('sheet: no qr block')

  const qx = Number(quiet[1])
  const qy = Number(quiet[2])
  return {
    widthMm,
    heightMm,
    viewBox: [vb[0]!, vb[1]!, vb[2]!, vb[3]!],
    data,
    inkRects: pathRects(inkPath[1]!),
    quietZone: { x0: qx, y0: qy, x1: qx + Number(quiet[3]), y1: qy + Number(quiet[4]) },
    tag: {
      id: Number(mustAttr(tagGroup[1]!, 'data-tag-id')),
      sizeMm: Number(mustAttr(tagGroup[1]!, 'data-size-mm')),
      xMm: Number(mustAttr(tagGroup[1]!, 'data-x-mm')),
      yMm: Number(mustAttr(tagGroup[1]!, 'data-y-mm')),
    },
    cropMarkPath: crop[1]!,
    scaleBar: { lengthMm: Number(bar[1]), path: bar[2]! },
    qr: { xMm: Number(qr[1]), yMm: Number(qr[2]), svg: qr[3]! },
  }
}

/**
 * The printed tag as a camera would see it: reflectance 25 where the sheet has ink, 225 on the
 * white quiet zone, off the sheet beyond it. Plane coordinates are metres from the tag centre with
 * +x right and +y up, the frame `fiducial-render.ts` uses; the sheet's millimetres and downward y
 * are converted here, so a mirrored or flipped print would be drawn mirrored or flipped.
 */
export function sheetArtwork(sheet: ParsedSheet): PlanarArtwork {
  const cx = sheet.tag.xMm + sheet.tag.sizeMm / 2
  const cy = sheet.tag.yMm + sheet.tag.sizeMm / 2
  const quiet = sheet.quietZone
  const half = (quiet.x1 - quiet.x0) / 2 / 1000
  return {
    halfExtent: half,
    shade(x, y) {
      const px = cx + x * 1000
      const py = cy - y * 1000
      if (px < quiet.x0 || px > quiet.x1 || py < quiet.y0 || py > quiet.y1) return -1
      for (const r of sheet.inkRects) if (px >= r.x0 && px < r.x1 && py >= r.y0 && py < r.y1) return 25
      return 225
    },
  }
}

// ---------------------------------------------------------------------------------------------
// A sheet with two tags (WP-14b): `buildTwoTagSheet` in scripts/print-fiducial.mjs
// ---------------------------------------------------------------------------------------------

export interface ParsedPairTag {
  id: number
  sizeMm: number
  /** Top-left of the black square on the page, millimetres. */
  xMm: number
  yMm: number
  /** Centre of the black square on the page, millimetres. */
  centreXMm: number
  centreYMm: number
  inkRects: Rect[]
  quietZone: Rect
}

export interface ParsedPairSheet {
  widthMm: number
  heightMm: number
  viewBox: [number, number, number, number]
  data: Record<string, string>
  tags: [ParsedPairTag, ParsedPairTag]
  cropMarkPath: string
  scaleBar: { lengthMm: number; path: string }
  qr: { xMm: number; yMm: number; svg: string }
}

export function parsePairSheet(svg: string): ParsedPairSheet {
  const root = /^<svg\b([^>]*)>/.exec(svg)
  if (!root) throw new Error('sheet: not an <svg> document')
  const rootTag = root[1]!
  const widthMm = mmValue(mustAttr(rootTag, 'width'))
  const heightMm = mmValue(mustAttr(rootTag, 'height'))
  const vb = mustAttr(rootTag, 'viewBox').split(' ').map(Number)
  if (vb.length !== 4 || vb.some((n) => !Number.isFinite(n))) throw new Error('sheet: bad viewBox')
  const data: Record<string, string> = {}
  for (const m of rootTag.matchAll(/(data-[a-z-]+)="([^"]*)"/g)) data[m[1]!] = m[2]!
  if (data['data-layout'] !== 'pair') throw new Error('sheet: not a pair layout')
  const tag = (n: 1 | 2): ParsedPairTag => {
    const group = new RegExp(`<g id="tag-${n}" ([^>]*)>`).exec(svg)
    if (!group) throw new Error(`sheet: no tag-${n} group`)
    const quiet = new RegExp(`<rect id="quiet-zone-${n}" x="([^"]*)" y="([^"]*)" width="([^"]*)" height="([^"]*)"`).exec(svg)
    if (!quiet) throw new Error(`sheet: no quiet-zone-${n} rect`)
    const ink = new RegExp(`<path id="tag-ink-${n}" d="([^"]*)"`).exec(svg)
    if (!ink) throw new Error(`sheet: no tag-ink-${n} path`)
    const qx = Number(quiet[1])
    const qy = Number(quiet[2])
    return {
      id: Number(mustAttr(group[1]!, 'data-tag-id')),
      sizeMm: Number(mustAttr(group[1]!, 'data-size-mm')),
      xMm: Number(mustAttr(group[1]!, 'data-x-mm')),
      yMm: Number(mustAttr(group[1]!, 'data-y-mm')),
      centreXMm: Number(mustAttr(group[1]!, 'data-centre-x-mm')),
      centreYMm: Number(mustAttr(group[1]!, 'data-centre-y-mm')),
      inkRects: pathRects(ink[1]!),
      quietZone: { x0: qx, y0: qy, x1: qx + Number(quiet[3]), y1: qy + Number(quiet[4]) },
    }
  }
  const crop = /<path id="crop-marks" d="([^"]*)"/.exec(svg)
  if (!crop) throw new Error('sheet: no crop marks')
  const bar = /<g id="scale-bar" data-length-mm="([^"]*)"><path d="([^"]*)"/.exec(svg)
  if (!bar) throw new Error('sheet: no scale bar')
  const qr = /<g id="qr" transform="translate\(([^ ]*) ([^)]*)\)">(<svg [\s\S]*?<\/svg>)<\/g>/.exec(svg)
  if (!qr) throw new Error('sheet: no qr block')
  return {
    widthMm,
    heightMm,
    viewBox: [vb[0]!, vb[1]!, vb[2]!, vb[3]!],
    data,
    tags: [tag(1), tag(2)],
    cropMarkPath: crop[1]!,
    scaleBar: { lengthMm: Number(bar[1]), path: bar[2]! },
    qr: { xMm: Number(qr[1]), yMm: Number(qr[2]), svg: qr[3]! },
  }
}

/**
 * The printed pair as one artwork a camera would see: both tags' ink on both quiet zones, in the plane's own metres, x to the right and y up, origin at the
 * midpoint between the two black squares' centres, so that a pose placing this artwork puts the pair's middle there. Off the quiet zones is off the sheet.
 */
export function pairArtwork(sheet: ParsedPairSheet): PlanarArtwork {
  const [a, b] = sheet.tags
  const cx = (a.centreXMm + b.centreXMm) / 2
  const cy = (a.centreYMm + b.centreYMm) / 2
  const half = Math.max(Math.abs(a.quietZone.x0 - cx), Math.abs(b.quietZone.x1 - cx), Math.abs(a.quietZone.y0 - cy), Math.abs(a.quietZone.y1 - cy)) / 1000
  return {
    halfExtent: half,
    shade(x, y) {
      const px = cx + x * 1000
      const py = cy - y * 1000
      for (const t of sheet.tags) {
        const q = t.quietZone
        if (px < q.x0 || px > q.x1 || py < q.y0 || py > q.y1) continue
        for (const r of t.inkRects) if (px >= r.x0 && px < r.x1 && py >= r.y0 && py < r.y1) return 25
        return 225
      }
      return -1
    },
  }
}

/** Text as the generator escaped it, as it was written: the four escapes it makes undone (`&amp;` last, so that `&amp;lt;` is `&lt;`). */
export function unescapeXml(text: string): string {
  return text.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
}

/** The text of every `<text>` element, in document order, as written. */
export function textLines(svg: string): string[] {
  return [...svg.matchAll(/<text\b[^>]*>([^<]*)<\/text>/g)].map((m) => unescapeXml(m[1]!))
}

/** Every start tag has its end tag, in order, and no stray angle bracket is left in text or attributes. */
export function assertBalancedSvg(svg: string): void {
  const stack: string[] = []
  let last = 0
  for (const m of svg.matchAll(/<(\/?)([A-Za-z][\w:-]*)([^<>]*?)(\/?)>/g)) {
    const between = svg.slice(last, m.index)
    assert.ok(!between.includes('<') && !between.includes('>'), `a raw angle bracket in text near byte ${m.index}`)
    last = m.index + m[0].length
    if (m[1]) {
      assert.equal(stack.pop(), m[2], `</${m[2]}> closes the wrong element`)
    } else if (!m[4]) {
      stack.push(m[2]!)
    }
  }
  assert.deepEqual(stack, [], 'unclosed elements')
  assert.ok(svg.startsWith('<svg ') && svg.endsWith('</svg>\n'))
}

/** A QR renderer that draws nothing a decoder could read but has the shape the sheet embeds: a standalone `<svg>` of the asked size. */
export function stubQrSvg(text: string, options: { size: number; level: 'L' | 'M' | 'Q' | 'H'; label: string }): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${options.size}" height="${options.size}" viewBox="0 0 ${options.size} ${options.size}" role="img" aria-label="${options.label.replace(/[<>&"]/g, '')}"><path d="M0 0h${options.size}v${options.size}h-${options.size}z" fill="#111111" data-payload-length="${text.length}"/></svg>`
}
