/**
 * `PUT /projects/:id/georeference`: how a Place's georeference is replaced, and the only way it is.
 *
 * Node-API-free (ADR 0004: server/main.ts cannot be imported by a test, so what can be tested on its own lives in a file of
 * its own), and the same shape as `applySpatialFrameWrite` in server/wp-a-projects.ts, which it copies on purpose
 * (ADR 0001): a counter the Place holds, a write that names the counter it last read, and an answer that carries what the
 * Place holds when the two disagree. The record is `Project.georeference`, the counter is `Project.georefVersion`; both are
 * server-owned (a whole-record `PUT /projects/:id` carries them over and ignores the body's, `placeFromBody`).
 *
 * ## The answers
 *
 *     200 { georefVersion, georeference }            the record is stored, and the version went up by one
 *     200 { georefVersion, georeference, unchanged } the Place already holds exactly this record: nothing changed
 *     400 { error, errors }                          the body is not a write, or the record is one the validator will not store
 *     404 { error: 'Not found' }                     there is no such Place
 *     409 { error, current: { georeference, georefVersion } }   the Place holds another version: nothing changed, here it is
 *
 * Writing the record a Place already holds is not a conflict, whatever version the writer names: a retry after a reply that
 * never arrived, or a replay, is the same write. `registeredAt` is part of a record, so two registrations are never equal by
 * accident. Call it inside `mutateProjects` (server/main.ts): that queue makes the read and the write one step, and
 * `saveRegistry` makes the write whole.
 */
import { isGeorefVersion, placeGeorefVersion, sameGeoreference, validateGeoreference } from '../../src/world/georef.ts'
import type { Project, ProjectGeoreference } from '../../src/world/types.ts'

/** What `PUT /projects/:id/georeference` answers. */
export type GeoreferenceWriteReply =
  | { status: 200; body: { georefVersion: number; georeference: ProjectGeoreference; unchanged?: true } }
  | { status: 400; body: { error: string; errors?: string[] } }
  | { status: 404; body: { error: string } }
  | { status: 409; body: { error: string; current: { georeference: ProjectGeoreference | null; georefVersion: number } } }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Whether a Place already holds a georeference. A stored `null` is none. */
function holdsGeoreference(place: Project): boolean {
  return place.georeference !== undefined && place.georeference !== null
}

/**
 * Applies one `{ georeference, expectedVersion }` write to the registry's Places, in place. `save` says whether to persist.
 *
 * The record is checked before the Place is looked for (a body that is not a write is a 400 whatever the Place, as the frame
 * route's is), and the Place's frame is consulted once: a record that names a frame generation (`anchorRef`) other than the one
 * the Place holds now is refused, because it was made for a frame the Place has replaced, and storing it would bind a
 * registration to a reference nothing places by. A record with no `anchorRef`, and a Place whose frame has no id, say nothing about
 * each other and pass.
 */
export function applyGeoreferenceWrite(
  projects: Project[],
  projectId: string,
  body: unknown,
  now: number,
): { result: GeoreferenceWriteReply; save: boolean } {
  const refuse = (status: 400 | 404, error: string, errors?: string[]) => ({
    result: { status, body: errors ? { error, errors } : { error } } as GeoreferenceWriteReply,
    save: false,
  })
  if (!isRecord(body)) return refuse(400, 'Body must be a JSON object')
  if (!isGeorefVersion(body['expectedVersion'])) return refuse(400, 'expectedVersion must be a whole number, 0 or more')
  const check = validateGeoreference(body['georeference'], { now })
  if (!check.ok) return refuse(400, check.error, check.errors)

  const place = projects.find((candidate) => candidate.projectId === projectId)
  if (!place) return refuse(404, 'Not found')

  const version = placeGeorefVersion(place)
  if (holdsGeoreference(place) && sameGeoreference(place.georeference, check.georeference)) {
    return {
      result: { status: 200, body: { georefVersion: version, georeference: place.georeference as ProjectGeoreference, unchanged: true } },
      save: false,
    }
  }
  if (body['expectedVersion'] !== version) {
    return {
      result: {
        status: 409,
        body: {
          error: 'The location of this Place changed since it was read',
          current: { georeference: holdsGeoreference(place) ? place.georeference as ProjectGeoreference : null, georefVersion: version },
        },
      },
      save: false,
    }
  }

  const frameId = (place.spatialFrame as { frameId?: unknown } | undefined)?.frameId
  const ref = check.georeference.anchorRef
  if (typeof frameId === 'string' && ref !== null && ref !== frameId) {
    return refuse(400, 'This location was made for another alignment of this Place', [
      `georeference.anchorRef names frame ${ref}, and the Place holds frame ${frameId}`,
    ])
  }

  place.georeference = check.georeference
  place.georefVersion = version + 1
  place.updatedAt = now
  return { result: { status: 200, body: { georefVersion: version + 1, georeference: check.georeference } }, save: true }
}
