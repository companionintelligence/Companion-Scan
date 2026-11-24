/**
 * The Navigate menu's scanner entry in the desktop app (FN-019).
 *
 * The desktop app opens the editor (desktop/src-tauri/tauri.conf.json), and the menu's "Scan a Place" link goes to the
 * scanner, which on a computer cannot walk a room: live capture needs a phone's camera and motion sensors. What it can
 * do there is take a walkthrough video or photos. So inside the desktop app the entry says that, and keeps its link: the
 * upload is on the same start screen. Every other build keeps "Scan a Place".
 */

/** The entry's words, in the browser and on a phone. */
export const SCAN_A_PLACE = { title: 'Scan a Place', detail: 'Start a camera scan or upload media.' } as const

/** The entry's words in the desktop app. */
export const DESKTOP_SCAN_ENTRY = {
  title: 'Add media to a Place',
  detail: 'Upload a walkthrough video or photos. Live capture needs a phone.',
} as const

/** The parts of a document this reads: enough for a test to pass a stand-in. */
export interface NavDocument {
  getElementById(id: string): { querySelector(selector: string): { textContent: string | null } | null } | null
}

/** Rewrite the scanner entry's words for the desktop app. Does nothing when the page has no such entry. */
export function relabelScanEntryForDesktop(doc: NavDocument): void {
  const link = doc.getElementById('scan-place-link')
  if (!link) return
  const title = link.querySelector('span')
  const detail = link.querySelector('small')
  if (title) title.textContent = DESKTOP_SCAN_ENTRY.title
  if (detail) detail.textContent = DESKTOP_SCAN_ENTRY.detail
}
