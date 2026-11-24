/**
 * The app's own URL rules for main.ts's static handler (production, the Hub install). vite.config.ts's dev middleware
 * keeps a copy of `rewriteEditorPath` (the Docker image builds the bundle in a stage without server/), and
 * tests/unit/server/server_core_editor_route.test.ts holds the two bodies equal, so `/editor` cannot work on one server and
 * not the other: `/editor/?world=…` used to reach the scanner start screen on `vite dev` (FN-070).
 */

/**
 * `/editor` is the Spatial Editor's canonical URL (README.md, docs/product/UX_FLOW.md), and the page is viewer.html.
 * Takes a path with an optional query, as Vite's `req.url` and a URL's pathname are, and returns the path to serve
 * with the same query, or null when the path is not the editor's.
 */
export function rewriteEditorPath(pathWithQuery: string): string | null {
  const query = pathWithQuery.indexOf('?')
  const pathname = query === -1 ? pathWithQuery : pathWithQuery.slice(0, query)
  if (pathname !== '/editor' && pathname !== '/editor/') return null
  return `/viewer.html${query === -1 ? '' : pathWithQuery.slice(query)}`
}
