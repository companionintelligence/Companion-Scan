/**
 * A Place's georeference over HTTP: `PUT /projects/:id/georeference` and what the whole-record PUT does with it
 * (server/world/georef_write.ts, hooked in server/main.ts), against the real server.
 *
 * server/main.ts starts Deno.serve at import and exports nothing, so a route cannot be called in-process: each test spawns it on
 * a free port with every directory it writes in a temp folder (./georef_server_support.ts). That is the route as wired: the
 * middleware, the guard, the handler, the serialised mutation queue and the temp-file-and-rename save, together. It copies
 * place_frame_route.test.ts, which pins the frame route this one is the twin of, and says the same things of the new record:
 *
 *  - the answers: 200 with the version, 409 with what the Place holds, 400 with every reason, 404, 413, and the same record
 *    again is not a conflict;
 *  - two writers at once: exactly one of them is accepted and the other is told what it lost to (0 lost in N, N printed);
 *  - the record is server-owned: a whole-record PUT neither writes nor erases it, from a stale tab or a replayed body;
 *  - the registry on disk is whole after a burst, and a restart still holds the record and its version;
 *  - a record made for another alignment of the Place is refused;
 *  - the guard: the route answers each credential exactly as the whole-record PUT does, in every mode, and so does the seed route.
 */
import { assert, assertEquals, assertNotEquals } from 'jsr:@std/assert@^1.0.0'
import { signSession } from '../../../server/portal_auth.ts'
import type { Project, ProjectGeoreference, ProjectSpatialFrame } from '../../../src/world/types.ts'
import { type Credential, type Reply, type RunningServer, startServer } from './georef_server_support.ts'

const SESSION_SECRET = 'georef-route-test-secret'
const OWNER_EMAIL = 'owner@example.com'
/** Sign-in on, with an issuer on a port Deno blocks, so discovery fails at once and nothing leaves the machine. */
const SIGN_IN_ON: Record<string, string> = {
  PORTAL_OIDC_ENABLED: '1',
  OIDC_ISSUER_URL: 'http://127.0.0.1:9',
  PORTAL_OIDC_ALLOWED_EMAILS: OWNER_EMAIL,
  SESSION_SECRET,
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

function record(bearingDeg: number, registeredAt = '2026-11-17T10:00:00.000Z', extra: Partial<ProjectGeoreference> = {}): ProjectGeoreference {
  return {
    origin: { lat: 51.5007, lng: -0.1246, altitudeM: null, accuracyM: 3.5 },
    heightDatum: 'unknown',
    bearingDeg,
    bearingAccuracyDeg: 1,
    convention: 2,
    datum: 'WGS84',
    source: 'map-click',
    registeredAt,
    confirmedAt: registeredAt,
    anchorRef: null,
    ...extra,
  }
}

const G0 = record(30, '2026-11-17T10:00:00.000Z')
const G1 = record(75, '2026-11-17T11:00:00.000Z')
const G2 = record(120, '2026-11-17T12:00:00.000Z')

const FRAME: ProjectSpatialFrame = {
  version: 1,
  createdAt: '2026-11-16T08:00:00.000Z',
  method: 'two-point-ground',
  landmark: { x: 0, y: 0, z: 0 },
  headingMarker: { x: 0, y: 0, z: 2 },
  separationM: 2,
  toleranceM: 0.15,
  anchorBearingDeg: null,
  frameId: 'frame-a',
}

const FLOORS = [{ floorId: 'floor-1', name: 'Ground Floor', level: 0, rooms: [{ roomId: 'room-1', name: 'Kitchen' }] }]

/** A Place as a build from before the georeference saved it: a whole record and neither of the two fields. */
function olderPlace(projectId: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    projectId,
    name: `Place ${projectId}`,
    placeType: 'room',
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_500,
    areas: [{ areaId: 'area-site', name: `Place ${projectId}`, kind: 'site', parentAreaId: null }],
    floors: FLOORS,
    ...extra,
  }
}

async function createPlace(server: RunningServer, who?: Credential): Promise<Project> {
  // Ids are `proj-<epoch ms>`, so two creates in one millisecond would be one Place.
  await new Promise((resolve) => setTimeout(resolve, 3))
  const made = await server.send('POST', '/projects', { name: 'Georeference test place', placeType: 'room' }, who)
  assertEquals(made.status, 201, `POST /projects: ${made.text}`)
  return made.json as Project
}

async function getPlace(server: RunningServer, projectId: string, who?: Credential): Promise<Project> {
  const res = await server.send('GET', `/projects/${projectId}`, undefined, who)
  assertEquals(res.status, 200, `GET /projects/${projectId}: ${res.text}`)
  return res.json as Project
}

const putGeoreference = (server: RunningServer, projectId: string, body: unknown, who?: Credential) =>
  server.send('PUT', `/projects/${projectId}/georeference`, body, who)
const putPlace = (server: RunningServer, projectId: string, body: unknown, who?: Credential) =>
  server.send('PUT', `/projects/${projectId}`, body, who)
const said = (reply: Reply) => (reply.json as { error?: string } | null)?.error

// ── The route ────────────────────────────────────────────────────────────────

Deno.test({
  name: 'PUT /projects/:id/georeference: 200 with the version, 409 with the record held, and the same record again is not a conflict',
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const server = await startServer({})
    try {
      const place = await createPlace(server)
      const id = place.projectId
      assertEquals(place.georefVersion, undefined, 'a new Place has counted nothing')
      assertEquals(place.georeference, undefined)

      const first = await putGeoreference(server, id, { georeference: G0, expectedVersion: 0 })
      assertEquals(first.status, 200, first.text)
      assertEquals(first.json, { georefVersion: 1, georeference: G0 })

      const second = await putGeoreference(server, id, { georeference: G1, expectedVersion: 1 })
      assertEquals(second.json, { georefVersion: 2, georeference: G1 })

      // Another editor that read the Place at version 1 and saved: it is told what it lost to.
      const stale = await putGeoreference(server, id, { georeference: G2, expectedVersion: 1 })
      assertEquals(stale.status, 409)
      assertEquals((stale.json as { current: unknown }).current, { georeference: G1, georefVersion: 2 })
      assert(typeof said(stale) === 'string' && said(stale)!.length > 0, 'and told in words')
      assertEquals((await getPlace(server, id)).georeference, G1, 'and the Place is as it was')

      // A replay of a write the server already applied (a retry after a lost reply).
      const replay = await putGeoreference(server, id, { georeference: G1, expectedVersion: 1 })
      assertEquals(replay.status, 200)
      assertEquals(replay.json, { georefVersion: 2, georeference: G1, unchanged: true })

      const list = (await server.send('GET', '/projects')).json as Project[]
      const listed = list.find((candidate) => candidate.projectId === id)
      assertEquals(listed?.georefVersion, 2, 'the list carries the version every client reads')
      assertEquals(listed?.georeference, G1)
      assertEquals(listed?.spatialFrameRevision, undefined, 'and the frame\'s counter is a different one')
      // The write moved the Place's modification time forward: it is a change to the Place.
      assert((listed?.updatedAt ?? 0) > place.updatedAt)
    } finally {
      await server.stop()
    }
  },
})

Deno.test({
  name: 'PUT /projects/:id/georeference refuses a body it could not safely store, saying every reason, and stores nothing',
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const server = await startServer({})
    try {
      const place = await createPlace(server)
      const id = place.projectId
      const withOrigin = (origin: Record<string, unknown>) => ({ ...G0, origin: { ...G0.origin, ...origin } })
      const refusals: Array<[string, Reply]> = [
        ['no body at all', await server.send('PUT', `/projects/${id}/georeference`)],
        ['text that is not JSON', await server.send('PUT', `/projects/${id}/georeference`, undefined, {}, '{nope')],
        ['JSON null', await server.send('PUT', `/projects/${id}/georeference`, undefined, {}, 'null')],
        ['an array', await putGeoreference(server, id, [G0])],
        ['no version', await putGeoreference(server, id, { georeference: G0 })],
        ['a version as text', await putGeoreference(server, id, { georeference: G0, expectedVersion: '0' })],
        ['a negative version', await putGeoreference(server, id, { georeference: G0, expectedVersion: -1 })],
        ['a fractional version', await putGeoreference(server, id, { georeference: G0, expectedVersion: 0.5 })],
        ['no record', await putGeoreference(server, id, { expectedVersion: 0 })],
        ['a record that is text', await putGeoreference(server, id, { georeference: 'banana', expectedVersion: 0 })],
        ['a record that is an array', await putGeoreference(server, id, { georeference: [G0], expectedVersion: 0 })],
        ['a frame in the place of a record', await putGeoreference(server, id, { georeference: FRAME, expectedVersion: 0 })],
        ['a bearing out of range', await putGeoreference(server, id, { georeference: { ...G0, bearingDeg: 360 }, expectedVersion: 0 })],
        ['a latitude at the pole', await putGeoreference(server, id, { georeference: withOrigin({ lat: 90 }), expectedVersion: 0 })],
        ['latitude 0 and longitude 0', await putGeoreference(server, id, { georeference: withOrigin({ lat: 0, lng: 0 }), expectedVersion: 0 })],
        ['an accuracy under what a click can claim', await putGeoreference(server, id, { georeference: withOrigin({ accuracyM: 1 }), expectedVersion: 0 })],
        ['a bearing accuracy under what a compass can claim', await putGeoreference(server, id, { georeference: record(30, G0.registeredAt, { source: 'gps-compass', bearingAccuracyDeg: 5, origin: { ...G0.origin, accuracyM: 25 } }), expectedVersion: 0 })],
        ['a phone altitude with no datum', await putGeoreference(server, id, { georeference: withOrigin({ altitudeM: 30 }), expectedVersion: 0 })],
        ['the sign rule that mirrored east and west', await putGeoreference(server, id, { georeference: { ...G0, convention: 1 }, expectedVersion: 0 })],
        ['a field a georeference does not have', await putGeoreference(server, id, { georeference: { ...G0, hdop: 2 }, expectedVersion: 0 })],
        ['a confirmation in the future', await putGeoreference(server, id, { georeference: { ...G0, confirmedAt: '2099-01-01T00:00:00.000Z' }, expectedVersion: 0 })],
        ['a frame id that is not safe in a path', await putGeoreference(server, id, { georeference: { ...G0, anchorRef: '../x' }, expectedVersion: 0 })],
        ['a __proto__ key', await server.send('PUT', `/projects/${id}/georeference`, undefined, {}, `{"expectedVersion":0,"georeference":${JSON.stringify(G0).slice(0, -1)},"__proto__":{"polluted":true}}}`)],
        ['a constructor key inside the seed', await server.send('PUT', `/projects/${id}/georeference`, undefined, {}, `{"expectedVersion":0,"georeference":${JSON.stringify({ ...G0, source: 'gps-compass', bearingAccuracyDeg: 15, origin: { ...G0.origin, accuracyM: 25 }, seed: JSON.parse('{"constructor":{"x":1}}') })}}`)],
      ]
      for (const [what, reply] of refusals) assertEquals(reply.status, 400, `${what}: ${reply.text}`)

      // What is wrong is said, and told apart: not JSON at all, JSON that is not a write, a record that is not one.
      assertEquals(said(refusals[1]![1]), 'Invalid JSON')
      assertEquals(said(refusals[2]![1]), 'Invalid JSON')
      assertEquals(said(refusals[3]![1]), 'Body must be a JSON object')
      assertEquals(said(refusals[4]![1]), 'expectedVersion must be a whole number, 0 or more')
      assertEquals(said(refusals[9]![1]), 'georeference must be an object')
      // Every reason of a record, as a list.
      const many = await putGeoreference(server, id, { georeference: { ...G0, bearingDeg: 400, convention: 1, origin: { lat: 99, lng: 0, altitudeM: null, accuracyM: 1 } }, expectedVersion: 0 })
      assertEquals(many.status, 400)
      const reasons = (many.json as { errors: string[] }).errors
      assert(reasons.length >= 4, reasons.join(' | '))
      assertEquals((many.json as { error: string }).error, reasons[0])
      assert(reasons.some((r) => r.includes('bearingDeg')) && reasons.some((r) => r.includes('convention')) && reasons.some((r) => r.includes('origin.lat')))

      assertEquals((await getPlace(server, id)).georeference, undefined, 'nothing was stored')
      assertEquals((await server.registry()).find((candidate) => candidate.projectId === id)?.georeference, undefined, 'nor written')

      const missing = await putGeoreference(server, 'proj-0000000000', { georeference: G0, expectedVersion: 0 })
      assertEquals(missing.status, 404, missing.text)
      assertEquals(said(missing), 'Not found')

      // The same cap as the whole-record PUT: a Place body over 1,000,000 bytes is refused before it is read.
      const huge = await putGeoreference(server, id, { georeference: G0, expectedVersion: 0, padding: 'p'.repeat(1_100_000) })
      assertEquals(huge.status, 413, huge.text)
      assertEquals((await getPlace(server, id)).georeference, undefined)
    } finally {
      await server.stop()
    }
  },
})

Deno.test({
  name: 'two writers naming the same version: exactly one is accepted and the other is told what it lost to (0 lost in N)',
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const server = await startServer({})
    let races = 0
    let lost = 0
    try {
      for (const writers of [2, 3, 8]) {
        for (let round = 0; round < 4; round++) {
          races += 1
          const place = await createPlace(server)
          const id = place.projectId
          // A first registration, then `writers` editors that all read version 1 and save at once.
          const base = await putGeoreference(server, id, { georeference: record(10, '2026-11-17T09:00:00.000Z'), expectedVersion: 0 })
          assertEquals(base.status, 200, base.text)
          const replies = await Promise.all(Array.from({ length: writers }, (_, i) =>
            putGeoreference(server, id, { georeference: record(20 + i, `2026-11-17T10:0${i}:00.000Z`), expectedVersion: 1 })))
          const accepted = replies.filter((reply) => reply.status === 200)
          const told = replies.filter((reply) => reply.status === 409)
          if (accepted.length !== 1 || told.length !== writers - 1) lost += 1
          assertEquals(accepted.length, 1, `${writers} writers, round ${round}: one winner`)
          assertEquals(told.length, writers - 1, `${writers} writers, round ${round}: the others are told`)
          const winner = (accepted[0]!.json as { georeference: ProjectGeoreference }).georeference
          for (const reply of told) {
            assertEquals((reply.json as { current: { georeference: unknown; georefVersion: number } }).current, { georeference: winner, georefVersion: 2 })
          }
          assertEquals((await getPlace(server, id)).georeference, winner, 'and the Place holds the winner whole')
        }
      }
      console.log(`  georeference writes lost: ${lost} of ${races} races`)
      assertEquals(lost, 0)
    } finally {
      await server.stop()
    }
  },
})

Deno.test({
  name: 'the record and its version are on disk after a burst of writes, the registry is whole, and a restart still holds them',
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const server = await startServer({})
    const root = server.root
    let projectId = ''
    try {
      const place = await createPlace(server)
      projectId = place.projectId
      let version = 0
      for (let i = 0; i < 15; i++) {
        const reply = await putGeoreference(server, projectId, { georeference: record(i * 7, `2026-11-17T09:${String(i).padStart(2, '0')}:00.000Z`), expectedVersion: version })
        assertEquals(reply.status, 200, `write ${i}: ${reply.text}`)
        version = (reply.json as { georefVersion: number }).georefVersion
      }
      assertEquals(version, 15)
      const names = [...Deno.readDirSync(root)].map((entry) => entry.name)
      assert(!names.some((name) => name.endsWith('.tmp')), `no temp file is left behind: ${names.join(', ')}`)
      assert(names.includes('projects.json.bak'), 'the save before the last one is kept as the .bak')
      const onDisk = (await server.registry()).find((candidate) => candidate.projectId === projectId)
      assertEquals(onDisk?.georefVersion, 15)
      assertEquals(onDisk?.georeference?.bearingDeg, 14 * 7)
      const held = onDisk?.georeference

      await server.stop(true)
      const restarted = await startServer({}, { root })
      try {
        const again = await getPlace(restarted, projectId)
        assertEquals(again.georeference, held, 'a restart reads what was written')
        assertEquals(again.georefVersion, 15)
      } finally {
        await restarted.stop()
      }
    } finally {
      await server.stop()
    }
  },
})

// ── The record is server-owned ───────────────────────────────────────────────

Deno.test({
  name: 'a whole-record PUT neither writes nor erases the georeference, from a stale tab or a replayed body, and a Place from before it reads as version 0',
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const server = await startServer({}, { seed: [olderPlace('proj-bare'), olderPlace('proj-held', { georeference: G0, georefVersion: 3 })] })
    try {
      // A Place saved before the record existed has neither key, and reads as version 0.
      const bare = await getPlace(server, 'proj-bare')
      assertEquals([bare.georeference, bare.georefVersion], [undefined, undefined])

      // 1. The whole record carrying a georeference does not write one: the route is the only way.
      const claim = await putPlace(server, 'proj-bare', { ...bare, georeference: G1, georefVersion: 9 })
      assertEquals(claim.status, 200)
      assertEquals((claim.json as Project).georeference, undefined)
      assertEquals((claim.json as Project).georefVersion, undefined)

      // 2. A stale copy (read before another editor registered the Place) is sent back whole: the record stays, and the rest is replaced.
      const stale = await getPlace(server, 'proj-held')
      const registered = await putGeoreference(server, 'proj-held', { georeference: G1, expectedVersion: 3 })
      assertEquals(registered.status, 200, registered.text)
      const rename = await putPlace(server, 'proj-held', { ...stale, name: 'Renamed from a stale copy' })
      assertEquals((rename.json as Project).name, 'Renamed from a stale copy', 'the rest of the record is still replaced')
      assertEquals((rename.json as Project).georeference, G1, 'the record is not')
      assertEquals((rename.json as Project).georefVersion, 4)

      // 3. A copy with no record at all (a build that never knew it) does not erase it, and a copy with the older record does not regress it.
      const noRecord = { ...stale } as Record<string, unknown>
      delete noRecord['georeference']
      delete noRecord['georefVersion']
      assertEquals(((await putPlace(server, 'proj-held', noRecord)).json as Project).georeference, G1)
      assertEquals(((await putPlace(server, 'proj-held', { ...stale, georeference: G0, georefVersion: 3 })).json as Project).georeference, G1)
      assertEquals(((await putPlace(server, 'proj-held', { ...stale, georeference: null })).json as Project).georefVersion, 4)

      // 4. The frame's own route and counter are another thing: writing a frame does not touch the registration.
      const frame = await server.send('PUT', '/projects/proj-held/spatial-frame', { frame: FRAME, expectedRevision: 0 })
      assertEquals(frame.status, 200, frame.text)
      const after = await getPlace(server, 'proj-held')
      assertEquals([after.georeference, after.georefVersion, after.spatialFrameRevision], [G1, 4, 1])
    } finally {
      await server.stop()
    }
  },
})

Deno.test({
  name: 'a location made for another alignment of the Place is refused, and one with no frame in it, or for the frame the Place holds, is taken',
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const server = await startServer({}, {
      seed: [olderPlace('proj-framed', { spatialFrame: FRAME, spatialFrameRevision: 1 }), olderPlace('proj-unframed'), olderPlace('proj-legacy-frame', { spatialFrame: { ...FRAME, frameId: undefined }, spatialFrameRevision: 1 })],
    })
    try {
      // The Place holds frame-a: a record made for frame-b is for a reference nothing places by.
      const other = await putGeoreference(server, 'proj-framed', { georeference: record(30, G0.registeredAt, { anchorRef: 'frame-b' }), expectedVersion: 0 })
      assertEquals(other.status, 400, other.text)
      assertEquals(said(other), 'This location was made for another alignment of this Place')
      assertEquals((await getPlace(server, 'proj-framed')).georeference, undefined)
      // For the frame it holds: taken. With no frame named: taken, and says nothing about which.
      assertEquals((await putGeoreference(server, 'proj-framed', { georeference: record(30, G0.registeredAt, { anchorRef: 'frame-a' }), expectedVersion: 0 })).status, 200)
      assertEquals((await putGeoreference(server, 'proj-framed', { georeference: record(31, '2026-11-17T10:30:00.000Z', { anchorRef: null }), expectedVersion: 1 })).status, 200)
      // A Place with no frame, or a frame with no id (written before ids existed): nothing to differ from.
      assertEquals((await putGeoreference(server, 'proj-unframed', { georeference: record(30, G0.registeredAt, { anchorRef: 'frame-z' }), expectedVersion: 0 })).status, 200)
      assertEquals((await putGeoreference(server, 'proj-legacy-frame', { georeference: record(30, G0.registeredAt, { anchorRef: 'frame-z' }), expectedVersion: 0 })).status, 200)
    } finally {
      await server.stop()
    }
  },
})

// ── The guard ────────────────────────────────────────────────────────────────

interface GuardMode {
  name: string
  env: Record<string, string>
  /** The status a credential gets from a route behind the Companion session guard. */
  status: (who: string) => number
  sessions: boolean
}

const GUARD_MODES: GuardMode[] = [
  { name: 'sign-in on', env: SIGN_IN_ON, sessions: true, status: (who) => (who === 'an allowlisted session' ? 200 : 401) },
  { name: 'SCAN_REQUIRE_AUTH=1, sign-in off', env: { SCAN_REQUIRE_AUTH: '1' }, sessions: false, status: () => 401 },
  { name: 'an install open by design', env: {}, sessions: false, status: () => 200 },
]

for (const mode of GUARD_MODES) {
  Deno.test({
    name: `the georeference routes are behind the guard the whole-record PUT is behind, ${mode.name}`,
    sanitizeResources: false,
    sanitizeOps: false,
    fn: async () => {
      const server = await startServer(mode.env, { seed: [olderPlace('proj-guarded', { georeference: G0, georefVersion: 1 })] })
      try {
        // The world tokens are the roles of the share links: a viewer and an editor of the Place's world. Reading a world is open on every
        // install and makes the server write the world file, so the tokens come from there.
        const read = await server.send('GET', '/worlds/default')
        assertEquals(read.status, 200, `GET /worlds/default should create the world: ${read.text}`)
        const world = await server.worldFile('default')
        const tokens = Object.fromEntries(world.members.map((member) => [member.role, member.token]))
        const expiry = Math.floor(Date.now() / 1000) + 3600

        const credentials: Array<[string, Credential]> = [
          ['anonymous', {}],
          ['a viewer token', { token: tokens['viewer'] }],
          ['an editor token', { token: tokens['editor'] }],
          ['an owner token in a header', { bearer: tokens['owner'] }],
          ['a token that is not any world\'s', { token: 'not-a-token-of-any-world' }],
        ]
        if (mode.sessions) {
          credentials.push(
            ['a session for an account off the allowlist', { bearer: await signSession({ sub: 'user-2', email: 'someone-else@example.com', exp: expiry }, SESSION_SECRET) }],
            ['an allowlisted session', { bearer: await signSession({ sub: 'user-1', email: OWNER_EMAIL, exp: expiry }, SESSION_SECRET) }],
          )
        }
        // Refusals first, so every one of them is measured against the same stored record; the credentials that are let in come last.
        credentials.sort(([a], [b]) => Number(mode.status(a) === 200) - Number(mode.status(b) === 200))

        const why = (what: string) => `${mode.name}: ${what}. Server log:\n${server.log()}`
        const place = async () => (await server.registry()).find((candidate) => candidate.projectId === 'proj-guarded')!
        let attempt = 0
        for (const [who, credential] of credentials) {
          attempt += 1
          const before = await place()
          const sibling = await putPlace(server, 'proj-guarded', { ...before, name: `Guard probe ${attempt}` }, credential)
          const route = await putGeoreference(server, 'proj-guarded', {
            georeference: record(40 + attempt, `2026-11-17T13:${String(attempt).padStart(2, '0')}:00.000Z`),
            expectedVersion: (await place()).georefVersion,
          }, credential)
          const seed = await server.send('GET', '/projects/proj-guarded/georeference-seed', undefined, credential)

          const expected = mode.status(who)
          assertEquals(sibling.status, expected, why(`${who}: the whole-record PUT`))
          assertEquals(route.status, sibling.status, why(`${who}: the georeference route answers as the whole-record PUT does`))
          assertEquals(seed.status, sibling.status, why(`${who}: and so does the seed route`))
          if (expected === 401) {
            const after = await place()
            assertEquals(after.georeference, G0, why(`${who}: the refused call changed the record`))
            assertEquals(after.georefVersion, 1, why(`${who}: or its version`))
            assertEquals(after.name, before.name, why(`${who}: or the Place`))
          } else {
            assertEquals((route.json as { georefVersion: number }).georefVersion, (await place()).georefVersion, why(`${who}: the write is the one on disk`))
          }
        }
      } finally {
        await server.stop()
      }
    },
  })
}

Deno.test({
  name: 'a stranger cannot reach the route through a path that merely looks like it',
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const server = await startServer(SIGN_IN_ON, { seed: [olderPlace('proj-guarded', { georeference: G0, georefVersion: 1 })] })
    try {
      const body = { georeference: G1, expectedVersion: 1 }
      const anonymous = [
        await server.send('PUT', '/projects/proj-guarded/georeference/', body),
        await server.send('PUT', '/projects/proj-guarded/georeference?token=x', body),
        await server.send('PUT', '/projects//georeference', body),
        await server.send('PUT', '/projects/proj-guarded%2Fgeoreference', body),
        await server.send('GET', '/projects/proj-guarded/georeference-seed/'),
        await server.send('GET', '/projects/proj-guarded/georeference-seed?token=x'),
      ]
      for (const reply of anonymous) assertNotEquals(reply.status, 200, reply.text)
      assertEquals((await server.registry())[0]?.georeference, G0)
    } finally {
      await server.stop()
    }
  },
})
