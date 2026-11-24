/**
 * Reading one JSON artifact from the Scan server, with the four answers the editor has to tell apart (F-22).
 *
 * The reconstruction-quality line and the Placed objects panel used to read any failure as "the step has not run".
 * A server that has no route for the file, or a request that failed, then looked exactly like a scan that was never
 * processed, and a person was told to run a step that had run. The answers:
 *
 *  - `found`: a 200 with a JSON body.
 *  - `not-run`: a 404 with a JSON body. The artifact routes answer a missing file that way
 *    (`{ "error": "Artifact not found" }`): the route is there and the file is not, so the step has not run.
 *  - `not-served`: no route for this file here. A 404 that is not JSON (the framework's own, or a static host's
 *    page), a 400 or 405 (a route that turns this name away, as the generic `/scans/:filename` does for anything that
 *    is not a .glb), or a 200 whose body is not JSON (a static host's index page).
 *  - `error`: any other status (401 and 403 are a sign-in or access matter, 5xx the server's), or a request that
 *    failed before an answer arrived.
 *
 * Pure apart from the `fetcher` it is handed, so a test drives it with canned responses.
 */

export type ArtifactRead<T> =
  | { state: 'found'; value: T }
  | { state: 'not-run' }
  | { state: 'not-served'; status: number }
  | { state: 'error'; status: number | null; message: string }

function isJson(response: Response): boolean {
  return (response.headers.get('content-type') ?? '').toLowerCase().includes('json')
}

/** Read the JSON artifact at `path` and say which of the four answers it is. */
export async function readArtifact<T>(
  path: string,
  fetcher: (url: string) => Promise<Response>,
): Promise<ArtifactRead<T>> {
  let response: Response
  try {
    response = await fetcher(path)
  } catch (error) {
    return { state: 'error', status: null, message: error instanceof Error ? error.message : String(error) }
  }
  if (response.status === 404) return isJson(response) ? { state: 'not-run' } : { state: 'not-served', status: 404 }
  if (response.status === 400 || response.status === 405) return { state: 'not-served', status: response.status }
  if (!response.ok) return { state: 'error', status: response.status, message: `the server answered ${response.status}` }
  if (!isJson(response)) return { state: 'not-served', status: response.status }
  try {
    return { state: 'found', value: await response.json() as T }
  } catch {
    // Labelled JSON and not parseable: a file cut short, not a missing route.
    return { state: 'error', status: response.status, message: 'the file could not be read' }
  }
}

/**
 * The sentence for an answer that is not `found`, about `what` (e.g. "the camera-position report"). Null for
 * `not-run`, which each panel words itself: it is the ordinary state of a scan that has not been through that step.
 */
export function artifactProblemText(read: ArtifactRead<unknown>, what: string): string | null {
  switch (read.state) {
    case 'not-served':
      return `This Scan server does not serve ${what}, so the editor cannot say whether that step ran.`
    case 'error':
      return read.status === 401 || read.status === 403
        ? `The editor is not allowed to read ${what} (the server answered ${read.status}). Sign in, or open the editor with a link that can.`
        : `Could not read ${what}: ${read.message}.`
    default:
      return null
  }
}
