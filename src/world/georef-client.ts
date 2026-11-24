/**
 * Getting a Place's georeference to the server, and reading what its scans suggest: the client the Place location panel
 * and, later, the map registration editor share.
 *
 * `PUT /projects/:id/georeference` is a compare-and-swap on the version the writer last read, the twin of
 * `PUT /projects/:id/spatial-frame` (server/world/georef_write.ts, docs/adr/0015-scene-convention-and-georeference.md). This module is
 * `sendSpatialFrame` in src/project/frame-sync.ts for the other record, with one difference that matters: a frame is kept by the
 * phone until the server holds it, and a location is a deliberate act in the editor, so **a save that cannot reach the server fails,
 * loudly, and is never queued**. The request carries the no-queue header (`noQueueHeaders`, the one place that decides whether
 * a service worker could queue it), so offline it fails at once instead of answering 202 and replaying later: a replay of a stale
 * version would lose to whatever was saved meanwhile, and the person would have been told it had worked. A 202 from a worker
 * that does not know the header is read as not delivered, and says the same thing: "Saving a location needs a connection".
 *
 * Nothing here throws, and nothing here writes a record the validator would refuse: the server's reasons come back as `invalid`.
 */
import type { FrameSyncEnv } from '../project/frame-sync.ts'
import { browserFrameSyncEnv, FRAME_REQUEST_TIMEOUT_MS } from '../project/frame-sync.ts'
import { isQueuedOffline } from '../shared/offline-queue.ts'
import { placeGeorefVersion } from './georef.ts'
import type { Project, ProjectGeoreference } from './types.ts'

/** What the panel says when the save could not reach the server. */
export const GEOREFERENCE_NEEDS_CONNECTION = 'Saving a location needs a connection'

/** What the panel says when another editor saved a location first. */
export const GEOREFERENCE_CONFLICT_TEXT = 'Someone else saved a location for this Place first. Their location is shown. Check it and save again.'

/** What happened to one save. */
export type GeoreferenceSaveOutcome =
  | { status: 'saved'; georefVersion: number; georeference: ProjectGeoreference; unchanged: boolean }
  | { status: 'conflict'; current: { georeference: ProjectGeoreference | null; georefVersion: number } }
  | { status: 'invalid'; reasons: string[] }
  | { status: 'failed'; reason: string; offline: boolean }

/** The browser's environment, as the frame sync's: its fetch, its server address, its no-queue header. */
export type GeoreferenceClientEnv = Pick<FrameSyncEnv, 'fetchFn' | 'url' | 'noQueue' | 'requestTimeoutMs'>

export function browserGeoreferenceEnv(): GeoreferenceClientEnv {
  return browserFrameSyncEnv()
}

async function readJson(response: Response): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await response.json()
    return typeof body === 'object' && body !== null && !Array.isArray(body) ? body as Record<string, unknown> : null
  } catch {
    return null
  }
}

/** One request, given up on after the environment's limit. Rejects as `fetch` does, and on the timeout. */
async function fetchWithin(env: GeoreferenceClientEnv, url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), env.requestTimeoutMs ?? FRAME_REQUEST_TIMEOUT_MS)
  try {
    return await env.fetchFn(url, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

const offline = (): GeoreferenceSaveOutcome => ({ status: 'failed', reason: GEOREFERENCE_NEEDS_CONNECTION, offline: true })

/**
 * Saves a georeference, naming the version the writer last read (`Project.georefVersion` of the copy it holds: 0 for a Place with
 * none). Never throws, and never queues.
 */
export async function saveGeoreference(
  projectId: string,
  georeference: ProjectGeoreference,
  expectedVersion: number,
  env: GeoreferenceClientEnv = browserGeoreferenceEnv(),
): Promise<GeoreferenceSaveOutcome> {
  let response: Response
  try {
    response = await fetchWithin(env, env.url(`/projects/${encodeURIComponent(projectId)}/georeference`), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...env.noQueue?.() },
      body: JSON.stringify({ georeference, expectedVersion }),
    })
  } catch {
    return offline()
  }
  // A worker that does not know the no-queue header may have taken the request: a 202 is not delivered.
  if (isQueuedOffline(response)) return offline()

  const body = await readJson(response)
  if (response.status === 200 && typeof body?.['georefVersion'] === 'number' && body['georeference'] && typeof body['georeference'] === 'object') {
    return {
      status: 'saved',
      georefVersion: body['georefVersion'],
      georeference: body['georeference'] as ProjectGeoreference,
      unchanged: body['unchanged'] === true,
    }
  }
  if (response.status === 409) {
    const current = body?.['current'] as { georeference?: unknown; georefVersion?: unknown } | undefined
    if (current && typeof current.georefVersion === 'number') {
      return {
        status: 'conflict',
        current: {
          georeference: typeof current.georeference === 'object' && current.georeference !== null ? current.georeference as ProjectGeoreference : null,
          georefVersion: current.georefVersion,
        },
      }
    }
  }
  if (response.status === 400) {
    const errors = body?.['errors']
    const reasons = Array.isArray(errors) ? errors.filter((e): e is string => typeof e === 'string') : []
    if (reasons.length === 0 && typeof body?.['error'] === 'string') reasons.push(body['error'])
    return { status: 'invalid', reasons: reasons.length > 0 ? reasons : ['The server did not accept this location.'] }
  }
  const reason = response.status === 404 ? 'This Place was not found. It may have been deleted.' : typeof body?.['error'] === 'string' ? body['error'] : `HTTP ${response.status}`
  return { status: 'failed', reason, offline: false }
}

/** Gives a Place copy what the server said: after a save, the record and the version it was saved at; after a conflict, what the server holds. */
export function adoptGeoreferenceOutcome(project: Project, outcome: GeoreferenceSaveOutcome): void {
  if (outcome.status === 'saved') {
    project.georeference = outcome.georeference
    project.georefVersion = outcome.georefVersion
  } else if (outcome.status === 'conflict') {
    if (outcome.current.georeference) project.georeference = outcome.current.georeference
    else delete project.georeference
    project.georefVersion = outcome.current.georefVersion
  }
}

/** The Place as the server holds it now: its record and its version are what a save names. Null when it could not be read. */
export async function fetchPlaceRecord(projectId: string, env: GeoreferenceClientEnv = browserGeoreferenceEnv()): Promise<Project | null> {
  try {
    const response = await fetchWithin(env, env.url(`/projects/${encodeURIComponent(projectId)}`), {})
    if (!response.ok || isQueuedOffline(response)) return null
    const body = await readJson(response)
    return body && typeof body['projectId'] === 'string' ? body as unknown as Project : null
  } catch {
    return null
  }
}

/** What the server's compass estimate says: see `GET /projects/:id/georeference-seed` (server/world/georef_seed.ts). */
export interface GeoreferenceSeedReply {
  bearing: { deg: number; spreadDeg: number; sigmaDeg: number; scans: number; lowConfidence: boolean } | null
  origin: { lat: number; lng: number; accuracyM: number } | null
  declination: { deg: number; model: 'WMM2025'; year: number } | null
  considered: number
  used: number
}

/** The compass estimate for a Place, or null when the server could not give one (no connection, or a server from before it). */
export async function fetchGeoreferenceSeed(projectId: string, env: GeoreferenceClientEnv = browserGeoreferenceEnv()): Promise<GeoreferenceSeedReply | null> {
  try {
    const response = await fetchWithin(env, env.url(`/projects/${encodeURIComponent(projectId)}/georeference-seed`), {})
    if (!response.ok || isQueuedOffline(response)) return null
    const body = await readJson(response)
    if (!body || typeof body['used'] !== 'number' || typeof body['considered'] !== 'number') return null
    return body as unknown as GeoreferenceSeedReply
  } catch {
    return null
  }
}

/** The version a Place copy holds, which a save names. */
export function savedVersionOf(project: Pick<Project, 'georefVersion'> | null | undefined): number {
  return placeGeorefVersion(project)
}
