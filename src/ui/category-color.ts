/**
 * The colour a detection label is drawn in across the scanner UI: the AR pins (./overlay.ts), the side
 * panel's list (./panel.ts) and the history drawer (./history.ts).
 *
 * There used to be three tables here, and they disagreed. The pin and panel tables matched a label by
 * substring. The history table matched it exactly, used other colours, and gave a door a different yellow.
 * None of them matched the GLB export, or the palette the mock detector and the test images use (F-44).
 *
 * The one table is the display table in src/shared/cv-palette.ts (`labelDisplayRgb`, `labelDisplayCss`,
 * wave 14 ticket 0004). The GLB's boxes take their colour from it too (src/export/gltf.ts), so a label is
 * one colour on every screen and in the export. A palette label takes its CV_PALETTE colour; couch, monitor
 * and bookcase take sofa's, tv's and shelf's; the other labels the GLB always coloured keep their colour; and
 * anything else is the default grey. This module adds only the lighter mix for text.
 *
 * Pure, and imports only the palette, so plain node can test it.
 */
import { labelDisplayCss, labelDisplayRgb } from '../shared/cv-palette.ts'

/** The CSS colour, `#rrggbb`, a detection label is drawn in: the display table's colour for it. */
export function categoryColor(label: string): string {
  return labelDisplayCss(label)
}

/**
 * The same colour, mixed halfway to white, for text. Some table colours are dark (the table's walnut is
 * rgb(109, 76, 65)), and an 11 px figure in them on the scanner's near-black panels cannot be read. Dots,
 * rings and borders keep the colour itself.
 */
export function categoryTextColor(label: string): string {
  const [r, g, b] = labelDisplayRgb(label)
  return toHex([mixToWhite(r), mixToWhite(g), mixToWhite(b)])
}

function mixToWhite(channel: number): number {
  return Math.round(channel + (255 - channel) / 2)
}

function toHex(rgb: readonly number[]): string {
  return `#${rgb.map((channel) => Math.max(0, Math.min(255, Math.round(channel))).toString(16).padStart(2, '0')).join('')}`
}
