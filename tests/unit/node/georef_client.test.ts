/**
 * The georeference client (src/world/georef-client.ts): what the Place location panel and the map editor send, and what each answer of
 * `PUT /projects/:id/georeference` becomes. `fetch` is scripted; tests/unit/deno/georef_route.test.ts runs the same route for real.
 *
 * What is pinned:
 *  - the request: PUT to the Place's georeference route, the record and the version the writer last read in the body, the no-queue
 *    header when the environment supplies one (it does in a page a service worker controls: `noQueueHeaders`), a Place id that
 *    cannot climb out of the path;
 *  - every answer: 200 saved (and a replay that changed nothing), 409 a conflict with what the server holds, 400 the reasons,
 *    404, and anything else with the server's own words;
 *  - a save that cannot reach the server FAILS, loudly, in the words "Saving a location needs a connection", and is never queued: a
 *    thrown fetch, a request that never answers (the timeout), and a 202 from a service worker that took it offline;
 *  - the Place copy takes what the server said, and the seed and Place reads never throw.
 *
 * Run: node --experimental-strip-types --no-warnings --test tests/unit/node/georef_client.test.ts
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  adoptGeoreferenceOutcome,
  fetchGeoreferenceSeed,
  fetchPlaceRecord,
  GEOREFERENCE_CONFLICT_TEXT,
  GEOREFERENCE_NEEDS_CONNECTION,
  type GeoreferenceClientEnv,
  saveGeoreference,
  savedVersionOf,
} from '../../../src/world/georef-client.ts'
import { NO_QUEUE_HEADER, QUEUED_OFFLINE_HEADER } from '../../../src/shared/offline-queue.ts'
import type { Project, ProjectGeoreference } from '../../../src/world/types.ts'

const RECORD: ProjectGeoreference = {
  origin: { lat: 51.5007, lng: -0.1246, altitudeM: null, accuracyM: 3.5 },
  heightDatum: 'unknown',
  bearingDeg: 30,
  bearingAccuracyDeg: 1,
  convention: 2,
  datum: 'WGS84',
  source: 'map-click',
  registeredAt: '2026-11-17T10:00:00.000Z',
  confirmedAt: '2026-11-17T10:00:00.000Z',
  anchorRef: null,
}
const OTHER: ProjectGeoreference = { ...RECORD, bearingDeg: 75, registeredAt: '2026-11-17T11:00:00.000Z' }

interface Seen {
  url: string
  init: RequestInit
}

/** An environment whose fetch answers with `respond`, recording what it was asked. */
function scripted(respond: (seen: Seen) => Response | Promise<Response>, extra: Partial<GeoreferenceClientEnv> = {}): { env: GeoreferenceClientEnv; seen: Seen[] } {
  const seen: Seen[] = []
  return {
    seen,
    env: {
      fetchFn: async (input, init) => {
        const entry = { url: String(input), init: init ?? {} }
        seen.push(entry)
        return respond(entry)
      },
      url: (path) => `https://scan.test${path}`,
      noQueue: () => ({ [NO_QUEUE_HEADER]: '1' }),
      ...extra,
    },
  }
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } })

test('the request: a PUT to the Place\'s georeference route with the record and the version read, and the no-queue header', async () => {
  const { env, seen } = scripted(() => json({ georefVersion: 1, georeference: RECORD }))
  const outcome = await saveGeoreference('proj-1700000000000', RECORD, 0, env)
  assert.equal(seen.length, 1)
  assert.equal(seen[0]!.url, 'https://scan.test/projects/proj-1700000000000/georeference')
  assert.equal(seen[0]!.init.method, 'PUT')
  const headers = seen[0]!.init.headers as Record<string, string>
  assert.equal(headers[NO_QUEUE_HEADER], '1', 'a service worker is asked not to queue a save')
  assert.equal(headers['Content-Type'], 'application/json')
  assert.deepEqual(JSON.parse(String(seen[0]!.init.body)), { georeference: RECORD, expectedVersion: 0 })
  assert.deepEqual(outcome, { status: 'saved', georefVersion: 1, georeference: RECORD, unchanged: false })
  // A Place id with a slash in it cannot climb out of the path.
  const traversal = scripted(() => json({ georefVersion: 1, georeference: RECORD }))
  await saveGeoreference('../other/place', RECORD, 0, traversal.env)
  assert.equal(traversal.seen[0]!.url, 'https://scan.test/projects/..%2Fother%2Fplace/georeference')
  // Without a worker in the page there is no header to send.
  const plain = scripted(() => json({ georefVersion: 1, georeference: RECORD }), { noQueue: undefined })
  await saveGeoreference('proj-1', RECORD, 0, plain.env)
  assert.equal((plain.seen[0]!.init.headers as Record<string, string>)[NO_QUEUE_HEADER], undefined)
})

test('a replay the server already applied is saved, and says nothing changed', async () => {
  const { env } = scripted(() => json({ georefVersion: 3, georeference: RECORD, unchanged: true }))
  assert.deepEqual(await saveGeoreference('proj-1', RECORD, 2, env), { status: 'saved', georefVersion: 3, georeference: RECORD, unchanged: true })
})

test('a 409 is a conflict with what the server holds, and a Place with no record yet is null', async () => {
  const held = scripted(() => json({ error: 'The location of this Place changed since it was read', current: { georeference: OTHER, georefVersion: 4 } }, 409))
  assert.deepEqual(await saveGeoreference('proj-1', RECORD, 3, held.env), { status: 'conflict', current: { georeference: OTHER, georefVersion: 4 } })
  const none = scripted(() => json({ error: 'x', current: { georeference: null, georefVersion: 0 } }, 409))
  assert.deepEqual(await saveGeoreference('proj-1', RECORD, 5, none.env), { status: 'conflict', current: { georeference: null, georefVersion: 0 } })
  // A 409 that does not say what the server holds is not one this client can use: it is a failure with the server's words.
  const vague = scripted(() => json({ error: 'busy' }, 409))
  assert.deepEqual(await saveGeoreference('proj-1', RECORD, 5, vague.env), { status: 'failed', reason: 'busy', offline: false })
  assert.ok(GEOREFERENCE_CONFLICT_TEXT.length > 0 && !GEOREFERENCE_CONFLICT_TEXT.includes('!'))
})

test('a 400 gives the validator\'s reasons, all of them when there are several', async () => {
  const many = scripted(() => json({ error: 'origin.lat must be a number', errors: ['origin.lat must be a number', 'georeference.convention must be 2'] }, 400))
  assert.deepEqual(await saveGeoreference('proj-1', RECORD, 0, many.env), { status: 'invalid', reasons: ['origin.lat must be a number', 'georeference.convention must be 2'] })
  const one = scripted(() => json({ error: 'Body must be a JSON object' }, 400))
  assert.deepEqual(await saveGeoreference('proj-1', RECORD, 0, one.env), { status: 'invalid', reasons: ['Body must be a JSON object'] })
  const bare = scripted(() => new Response('', { status: 400 }))
  const outcome = await saveGeoreference('proj-1', RECORD, 0, bare.env)
  assert.equal(outcome.status, 'invalid')
})

test('a Place the server does not have, and any other refusal, fail with a reason that is not a number', async () => {
  const missing = scripted(() => json({ error: 'Not found' }, 404))
  const gone = await saveGeoreference('proj-1', RECORD, 0, missing.env)
  assert.equal(gone.status, 'failed')
  assert.match((gone as { reason: string }).reason, /not found/i)
  assert.equal((gone as { offline: boolean }).offline, false)
  const big = scripted(() => json({ error: 'Place is too large' }, 413))
  assert.deepEqual(await saveGeoreference('proj-1', RECORD, 0, big.env), { status: 'failed', reason: 'Place is too large', offline: false })
  const broken = scripted(() => new Response('<html>', { status: 502 }))
  assert.deepEqual(await saveGeoreference('proj-1', RECORD, 0, broken.env), { status: 'failed', reason: 'HTTP 502', offline: false })
})

test('a save that cannot reach the server fails loudly in the same words, and is never queued: a thrown fetch, a 202 from a worker, a request that never answers', async () => {
  assert.equal(GEOREFERENCE_NEEDS_CONNECTION, 'Saving a location needs a connection')
  const thrown = scripted(() => { throw new TypeError('Failed to fetch') })
  assert.deepEqual(await saveGeoreference('proj-1', RECORD, 0, thrown.env), { status: 'failed', reason: GEOREFERENCE_NEEDS_CONNECTION, offline: true })

  // A worker that does not know the no-queue header stores the request and answers 202 with its own header: that is not delivered.
  const queued = scripted(() => json({ ok: false, queuedOffline: true, queueId: 'q1' }, 202, { [QUEUED_OFFLINE_HEADER]: '1' }))
  assert.deepEqual(await saveGeoreference('proj-1', RECORD, 0, queued.env), { status: 'failed', reason: GEOREFERENCE_NEEDS_CONNECTION, offline: true })

  // A request that accepts the connection and never answers is given up on, and says the same.
  const never = scripted((seen) => new Promise<Response>((_, reject) => {
    ;(seen.init.signal as AbortSignal).addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
  }), { requestTimeoutMs: 20 })
  assert.deepEqual(await saveGeoreference('proj-1', RECORD, 0, never.env), { status: 'failed', reason: GEOREFERENCE_NEEDS_CONNECTION, offline: true })
})

test('adoptGeoreferenceOutcome: the Place copy takes what the server said, and a failure changes nothing', () => {
  const place = { projectId: 'proj-1', name: 'x', createdAt: 1, updatedAt: 1, floors: [] } as Project
  adoptGeoreferenceOutcome(place, { status: 'saved', georefVersion: 2, georeference: RECORD, unchanged: false })
  assert.deepEqual([place.georeference, place.georefVersion], [RECORD, 2])
  adoptGeoreferenceOutcome(place, { status: 'conflict', current: { georeference: OTHER, georefVersion: 5 } })
  assert.deepEqual([place.georeference, place.georefVersion], [OTHER, 5])
  adoptGeoreferenceOutcome(place, { status: 'invalid', reasons: ['x'] })
  adoptGeoreferenceOutcome(place, { status: 'failed', reason: 'x', offline: true })
  assert.deepEqual([place.georeference, place.georefVersion], [OTHER, 5])
  adoptGeoreferenceOutcome(place, { status: 'conflict', current: { georeference: null, georefVersion: 0 } })
  assert.equal(place.georeference, undefined)
  assert.equal(place.georefVersion, 0)
  assert.equal(savedVersionOf(place), 0)
  assert.equal(savedVersionOf({ georefVersion: 7 }), 7)
  assert.equal(savedVersionOf(null), 0)
  assert.equal(savedVersionOf({ georefVersion: -2 }), 0)
})

test('reading the Place and the compass estimate never throws, and tells a failure from an answer', async () => {
  const place = scripted(() => json({ projectId: 'proj-1', name: 'Kitchen', georeference: RECORD, georefVersion: 2, floors: [] }))
  const read = await fetchPlaceRecord('proj-1', place.env)
  assert.equal(read?.georefVersion, 2)
  assert.equal(place.seen[0]!.url, 'https://scan.test/projects/proj-1')
  assert.equal(await fetchPlaceRecord('proj-1', scripted(() => json({ error: 'Not found' }, 404)).env), null)
  assert.equal(await fetchPlaceRecord('proj-1', scripted(() => json({ nonsense: true })).env), null)
  assert.equal(await fetchPlaceRecord('proj-1', scripted(() => { throw new TypeError('offline') }).env), null)
  assert.equal(await fetchPlaceRecord('proj-1', scripted(() => json({}, 202, { [QUEUED_OFFLINE_HEADER]: '1' })).env), null)

  const seedBody = { bearing: { deg: 31.5, spreadDeg: 4, sigmaDeg: 15, scans: 3, lowConfidence: false }, origin: null, declination: null, considered: 5, used: 3 }
  const seed = scripted(() => json(seedBody))
  assert.deepEqual(await fetchGeoreferenceSeed('proj-1', seed.env), seedBody)
  assert.equal(seed.seen[0]!.url, 'https://scan.test/projects/proj-1/georeference-seed')
  assert.equal(await fetchGeoreferenceSeed('proj-1', scripted(() => json({ error: 'Not found' }, 404)).env), null)
  assert.equal(await fetchGeoreferenceSeed('proj-1', scripted(() => json({ bearing: null })).env), null, 'a body that is not a seed')
  assert.equal(await fetchGeoreferenceSeed('proj-1', scripted(() => { throw new TypeError('offline') }).env), null)
})
