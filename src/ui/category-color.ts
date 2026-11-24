/**
 * The colour a detection label is drawn in across the scanner UI: the AR pins (./overlay.ts), the side
 * panel's list (./panel.ts) and the history drawer (./history.ts).
 *
 * There used to be three tables here, and they disagreed. The pin and panel tables matched a label by
 * substring. The history table matched it exactly, used other colours, and gave a door a different yellow.
 * None of them matched the palette that the mock detector, the synthetic test images and the fake camera
 * feed use, `CV_PALETTE` in src/shared/cv-palette.ts (F-44). The colours now come from that palette,
 * read-only. A label with no palette colour gets the palette's default grey.
 *
 * A label is matched as the old tables and the GLB export matched it: lowercased, the first key it contains
 * wins, in MATCH_ORDER. couch, monitor and bookcase share sofa's, tv's and shelf's colour.
 *
 * capture-core (wave 14, ticket 0004) adds the one display table for every label, `labelDisplayRgb` and
 * `labelDisplayCss` in src/shared/cv-palette.ts, matched by this same rule, and src/export/gltf.ts uses it.
 * This branch is cut from a base that does not have those functions yet. Once both are merged, this module
 * returns `labelDisplayCss(label)` and mixes `labelDisplayRgb(label)` for text, and MATCH_ORDER,
 * PALETTE_ALIASES and paletteLabelOf() go. Until then the only difference is that desk, door, window, wall,
 * floor and ceiling are the default grey here, where that table gives them the old GLB colours.
 *
 * Pure, and imports only the palette, so plain node can test it.
 */
import { CV_PALETTE, paletteColorFor } from '../shared/cv-palette.ts'

/** The keys a label is matched against, first match wins: the old tables' order, which the GLB export keeps. */
export const MATCH_ORDER: readonly string[] = [
  'chair', 'table', 'sofa', 'couch', 'bed', 'desk', 'monitor', 'tv', 'door', 'window',
  'shelf', 'bookcase', 'lamp', 'plant', 'wall', 'floor', 'ceiling',
]

/** Keys drawn in another key's palette colour. Every target is a `CV_PALETTE` label. */
export const PALETTE_ALIASES: Readonly<Record<string, string>> = {
  couch: 'sofa',
  monitor: 'tv',
  bookcase: 'shelf',
}

/** The palette label a detection label is drawn as, or null when its first matching key has no palette colour. */
export function paletteLabelOf(label: string): string | null {
  const lower = label.toLowerCase()
  const key = MATCH_ORDER.find((candidate) => lower.includes(candidate))
  if (!key) return null
  const target = PALETTE_ALIASES[key] ?? key
  return CV_PALETTE.some((entry) => entry.label === target) ? target : null
}

/** The CSS colour, `#rrggbb`, a detection label is drawn in. The palette's default grey when it has none. */
export function categoryColor(label: string): string {
  return toHex(paletteColorFor(paletteLabelOf(label) ?? ''))
}

/**
 * The same colour, mixed halfway to white, for text. Some palette colours are dark (the table's walnut
 * is rgb(109, 76, 65)), and an 11 px figure in them on the scanner's near-black panels cannot be read.
 * Dots, rings and borders keep the palette colour itself.
 */
export function categoryTextColor(label: string): string {
  const [r, g, b] = paletteColorFor(paletteLabelOf(label) ?? '')
  return toHex([mixToWhite(r), mixToWhite(g), mixToWhite(b)])
}

function mixToWhite(channel: number): number {
  return Math.round(channel + (255 - channel) / 2)
}

function toHex(rgb: readonly number[]): string {
  return `#${rgb.map((channel) => Math.max(0, Math.min(255, Math.round(channel))).toString(16).padStart(2, '0')).join('')}`
}
