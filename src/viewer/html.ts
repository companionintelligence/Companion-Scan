/**
 * The editor's one HTML escape (FN-086: the Places panel, the map popup and viewer.ts each had a copy).
 *
 * For text and attribute values written into markup with innerHTML. A record that did not come from this build
 * is data, not markup, so everything the server returns goes through this before it is written.
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}
