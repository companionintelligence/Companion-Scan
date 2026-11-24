/**
 * Shared CV test palette — one saturated, well-separated colour per furniture
 * label.  Used by:
 *   - scripts/generate-cv-images.mjs   (draws synthetic room images)
 *   - server/inference.ts mock engine   (detects these colours as objects)
 *   - public/test-fixtures/xr8-mock.js  (paints the fake camera feed — keep
 *     its inline copy in sync when editing; tests/unit/deno/sync.test.ts
 *     fails when the two drift)
 *   - labelDisplayRgb() below, the one table a detection's colour on screen
 *     and in the GLB comes from
 *
 * Runtime-agnostic: imported by Deno (server), Node (scripts), and Vite.
 */

export interface PaletteEntry {
  label: string
  /** sRGB 0-255 */
  rgb: [number, number, number]
  /**
   * Plain-English name for `rgb`. The mock engine reports the colour it actually
   * matched as part of the detection description, so the description reads as a
   * description rather than as engine debug output. See inference.ts
   * `describeMockBlob`.
   */
  colorName: string
}

export const CV_PALETTE: PaletteEntry[] = [
  { label: 'chair', rgb: [41, 98, 255], colorName: 'blue' },
  { label: 'sofa', rgb: [255, 109, 0], colorName: 'orange' },
  { label: 'bed', rgb: [170, 0, 255], colorName: 'purple' },
  { label: 'table', rgb: [109, 76, 65], colorName: 'walnut' },
  { label: 'lamp', rgb: [255, 214, 0], colorName: 'yellow' },
  { label: 'plant', rgb: [0, 200, 83], colorName: 'green' },
  { label: 'tv', rgb: [0, 184, 212], colorName: 'teal' },
  { label: 'shelf', rgb: [197, 17, 98], colorName: 'crimson' },
]

/** Per-channel tolerance used by the mock detector (JPEG compression noise) */
export const PALETTE_TOLERANCE = 28

export function paletteColorFor(label: string): [number, number, number] {
  return CV_PALETTE.find((p) => p.label === label)?.rgb ?? [176, 190, 197]
}

/** Plain-English colour name for a palette label; '' when the label is unknown. */
export function paletteColorNameFor(label: string): string {
  return CV_PALETTE.find((p) => p.label === label)?.colorName ?? ''
}

// ── Display colours ──────────────────────────────────────────────────────────

/** The colour a label with no entry below is drawn in: the grey `paletteColorFor` falls back to. */
export const LABEL_DISPLAY_DEFAULT_RGB: readonly [number, number, number] = [176, 190, 197]

function paletteRgb(label: string): readonly [number, number, number] {
  const entry = CV_PALETTE.find((p) => p.label === label)
  if (!entry) throw new Error(`cv-palette: no CV_PALETTE entry for ${label}`)
  return entry.rgb
}

/**
 * The one table a detection's colour on screen comes from (F-44): the GLB's boxes (src/export/gltf.ts), and any
 * list, dot or pin that colours a label. A label is matched by the first key it contains, lowercased and in this
 * order, so "office chair" is a chair and "table lamp" a table, as the GLB has always matched them.
 *
 * - A CV_PALETTE label takes its palette colour, which is also the colour the synthetic rooms paint it and the mock
 *   detector matches, so a blue chair in a test image is a blue chair in the export.
 * - An alias takes its palette label's colour: couch is sofa, monitor is tv, bookcase is shelf.
 * - A label the palette has no entry for keeps the colour the GLB gave it before this table existed.
 *
 * Separate from CV_PALETTE on purpose. That list is the mock detector's match table (`classifyPixel`), mirrored in
 * public/test-fixtures/xr8-mock.js, and a display-only label added to it would become something the mock detects.
 */
const LABEL_DISPLAY_ORDER: ReadonlyArray<readonly [string, readonly [number, number, number]]> = [
  ['chair', paletteRgb('chair')],
  ['table', paletteRgb('table')],
  ['sofa', paletteRgb('sofa')],
  ['couch', paletteRgb('sofa')],
  ['bed', paletteRgb('bed')],
  ['desk', [165, 214, 167]],
  ['monitor', paletteRgb('tv')],
  ['tv', paletteRgb('tv')],
  ['door', [255, 204, 128]],
  ['window', [128, 222, 234]],
  ['shelf', paletteRgb('shelf')],
  ['bookcase', paletteRgb('shelf')],
  ['lamp', paletteRgb('lamp')],
  ['plant', paletteRgb('plant')],
  ['wall', [120, 144, 156]],
  ['floor', [84, 110, 122]],
  ['ceiling', [144, 164, 174]],
]

/** The sRGB 0-255 colour a detection labelled `label` is drawn in. A fresh array: changing it changes nothing here. */
export function labelDisplayRgb(label: string): [number, number, number] {
  const lower = String(label ?? '').toLowerCase()
  const hit = LABEL_DISPLAY_ORDER.find(([key]) => lower.includes(key))
  const [r, g, b] = hit ? hit[1] : LABEL_DISPLAY_DEFAULT_RGB
  return [r, g, b]
}

/** {@link labelDisplayRgb} as a 0xRRGGBB number, the form three.js colours take. */
export function labelDisplayHex(label: string): number {
  const [r, g, b] = labelDisplayRgb(label)
  return (r << 16) | (g << 8) | b
}

/** {@link labelDisplayRgb} as a CSS `#rrggbb` string, the form the DOM takes. */
export function labelDisplayCss(label: string): string {
  return `#${labelDisplayHex(label).toString(16).padStart(6, '0')}`
}

/** Classify an sRGB pixel against the palette; null when it matches nothing */
export function classifyPixel(r: number, g: number, b: number): string | null {
  for (const entry of CV_PALETTE) {
    if (
      Math.abs(r - entry.rgb[0]) <= PALETTE_TOLERANCE &&
      Math.abs(g - entry.rgb[1]) <= PALETTE_TOLERANCE &&
      Math.abs(b - entry.rgb[2]) <= PALETTE_TOLERANCE
    ) {
      return entry.label
    }
  }
  return null
}
